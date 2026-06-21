// reminders.js — Lady Liya Personal Reminders
//
// Reminders are stored in a single Redis sorted set "reminders:due",
// scored by their due timestamp (ms), so a periodic checker can cheaply
// fetch "everything due <= now" with ZRANGEBYSCORE instead of scanning
// every key. The reminder payload itself lives in "reminder:<id>" as JSON:
//   { id, phoneNumber, chatJid, jid, text, dueAt, createdAt }
//
// phoneNumber identifies WHICH paired session should deliver it (since
// this is multi-tenant — the bot may have many independent WhatsApp
// connections, and only the owning session's socket can send the DM).

const crypto = require('crypto');

function makeId() {
    return crypto.randomBytes(8).toString('hex');
}

// ── Create a reminder due in `delayMs` milliseconds ──
async function createReminder(redisClient, { phoneNumber, chatJid, jid, text, delayMs, retryCount = 0 }) {
    const id = makeId();
    const dueAt = Date.now() + delayMs;
    const reminder = { id, phoneNumber, chatJid, jid, text, dueAt, createdAt: Date.now(), retryCount };

    await redisClient.set(`reminder:${id}`, JSON.stringify(reminder));
    await redisClient.zAdd('reminders:due', [{ score: dueAt, value: id }]);

    return reminder;
}

// ── Fetch all reminders due at or before now, WITHOUT removing them
//    (caller is responsible for calling deleteReminder after sending) ──
async function getDueReminders(redisClient, now = Date.now()) {
    const ids = await redisClient.zRangeByScore('reminders:due', 0, now);
    if (!ids || ids.length === 0) return [];

    const reminders = [];
    for (const id of ids) {
        const raw = await redisClient.get(`reminder:${id}`);
        if (raw) reminders.push(JSON.parse(raw));
    }
    return reminders;
}

async function deleteReminder(redisClient, id) {
    await redisClient.del(`reminder:${id}`);
    await redisClient.zRem('reminders:due', id);
}

// ── List a user's upcoming reminders (for .reminders / .myreminders) ──
async function listUserReminders(redisClient, jid, limit = 20) {
    // Pull a reasonably large due-window and filter client-side by jid,
    // since reminders:due isn't indexed per-user. Fine for personal-scale use.
    const allIds = await redisClient.zRangeByScore('reminders:due', 0, '+inf');
    const matches = [];
    for (const id of allIds) {
        const raw = await redisClient.get(`reminder:${id}`);
        if (!raw) continue;
        const reminder = JSON.parse(raw);
        if (reminder.jid === jid) matches.push(reminder);
        if (matches.length >= limit) break;
    }
    return matches.sort((a, b) => a.dueAt - b.dueAt);
}

async function cancelReminder(redisClient, jid, id) {
    const raw = await redisClient.get(`reminder:${id}`);
    if (!raw) return { error: 'not_found' };
    const reminder = JSON.parse(raw);
    if (reminder.jid !== jid) return { error: 'not_yours' };

    await deleteReminder(redisClient, id);
    return { success: true, reminder };
}

// ── Parse simple duration strings like "10m", "2h", "1d" into milliseconds.
//    Returns null if unparseable. ──
function parseDuration(str) {
    const match = /^(\d+)(s|m|h|d)$/i.exec(str.trim());
    if (!match) return null;

    const amount = parseInt(match[1]);
    const unit = match[2].toLowerCase();
    const multipliers = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
    return amount * multipliers[unit];
}

module.exports = {
    createReminder,
    getDueReminders,
    deleteReminder,
    listUserReminders,
    cancelReminder,
    parseDuration
};
