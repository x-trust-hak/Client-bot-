// groupmod.js — Lady Liya Group Utility & Moderation
//
// Per-group config stored under: groupconfig:<groupId> (hash)
//   - antilink: "off" | "warn" | "kick" (tier of enforcement)
//   - warnLimit: integer, auto-kick threshold (default 3)
//
// Warnings stored under: warnings:<groupId>:<jid> (integer count)
//
// Polls stored under: poll:<groupId> (hash, single active poll per group)
// Giveaways stored under: giveaway:<groupId> (hash, single active giveaway per group)

const DEFAULT_WARN_LIMIT = 3;

// ════════════════════════════════════════════
// GROUP CONFIG (antilink tier, warn limit)
// ════════════════════════════════════════════

async function getGroupConfig(redisClient, groupId) {
    const data = await redisClient.hGetAll(`groupconfig:${groupId}`);
    return {
        antilink: data.antilink || 'off',
        antisticker: data.antisticker || 'off',
        antitag: data.antitag || 'off',
        antibadword: data.antibadword || 'off',
        antiviewonce: data.antiviewonce === 'true',
        antispam: data.antispam || 'off',           // 'off'|'warn'|'kick', triggers on flood
        antispamLimit: data.antispamLimit ? parseInt(data.antispamLimit) : 5, // messages per window
        antispamWindow: data.antispamWindow ? parseInt(data.antispamWindow) : 5, // seconds
        antiforward: data.antiforward || 'off',     // 'off'|'warn'|'kick'
        antiforwardScore: data.antiforwardScore ? parseInt(data.antiforwardScore) : 5, // min forwardingScore
        antibot: data.antibot || 'off',             // 'off'|'on' (auto-kicks detected bots)
        antidemote: data.antidemote === 'true',     // reverts unauthorized demotions
        antipromote: data.antipromote === 'true',   // reverts unauthorized promotions
        antigroupmention: data.antigroupmention || 'off', // 'off'|'warn'|'kick'
        autotranslate: data.autotranslate || 'off',  // 'off' | target language code (e.g. 'en')
        antimedia: data.antimedia || 'off',     // 'off'|'warn'|'kick' — blanket: image/video/audio/document/sticker
        antilocation: data.antilocation || 'off',
        antidocument: data.antidocument || 'off',
        antiaudio: data.antiaudio || 'off',
        antivideo: data.antivideo || 'off',
        antiimage: data.antiimage || 'off',
        antilongmsg: data.antilongmsg || 'off',
        antilongmsgMax: data.antilongmsgMax ? parseInt(data.antilongmsgMax) : 1000,
        slowmode: data.slowmode ? parseInt(data.slowmode) : 0, // seconds, 0 = off
        // ── Auto features ──
        autosticker: data.autosticker === 'true',
        autodownload: data.autodownload === 'true',
        autotag: data.autotag || 'off',  // 'off' | 'keyword'
        autotagKeywords: data.autotagKeywords ? JSON.parse(data.autotagKeywords) : ['admin', 'help', 'support'],
        // ── Welcome / goodbye ──
        welcomeEnabled: data.welcomeEnabled === 'true',
        welcomeMsg: data.welcomeMsg || '',
        goodbyeEnabled: data.goodbyeEnabled === 'true',
        goodbyeMsg: data.goodbyeMsg || '',
        warnLimit: data.warnLimit ? parseInt(data.warnLimit) : DEFAULT_WARN_LIMIT
    };
}

async function setGroupConfig(redisClient, groupId, key, value) {
    await redisClient.hSet(`groupconfig:${groupId}`, key, String(value));
}

// ── Per-group banned word list (used by antibadword) ──
async function getBadwordList(redisClient, groupId) {
    const raw = await redisClient.hGet(`groupconfig:${groupId}`, 'badwords');
    return raw ? JSON.parse(raw) : [];
}

async function addBadword(redisClient, groupId, word) {
    const list = await getBadwordList(redisClient, groupId);
    const normalized = word.toLowerCase().trim();
    if (!list.includes(normalized)) {
        list.push(normalized);
        await redisClient.hSet(`groupconfig:${groupId}`, 'badwords', JSON.stringify(list));
    }
    return list;
}

async function removeBadword(redisClient, groupId, word) {
    const list = await getBadwordList(redisClient, groupId);
    const normalized = word.toLowerCase().trim();
    const filtered = list.filter(w => w !== normalized);
    await redisClient.hSet(`groupconfig:${groupId}`, 'badwords', JSON.stringify(filtered));
    return filtered;
}

// ════════════════════════════════════════════
// WARNINGS
// ════════════════════════════════════════════

async function getWarnCount(redisClient, groupId, jid) {
    const raw = await redisClient.get(`warnings:${groupId}:${jid}`);
    return raw ? parseInt(raw) : 0;
}

// ── Add a warning. Returns the new count ──
async function addWarning(redisClient, groupId, jid) {
    const current = await getWarnCount(redisClient, groupId, jid);
    const updated = current + 1;
    await redisClient.set(`warnings:${groupId}:${jid}`, String(updated));
    return updated;
}

async function clearWarnings(redisClient, groupId, jid) {
    await redisClient.del(`warnings:${groupId}:${jid}`);
}

// ════════════════════════════════════════════
// POLL
// Single active poll per group. Options stored as an array,
// votes stored as { jid: optionIndex }.
// ════════════════════════════════════════════

const POLL_TTL = 60 * 60; // 1 hour max lifetime

function pollKey(groupId) {
    return `poll:${groupId}`;
}

async function createPoll(redisClient, groupId, question, options, createdBy) {
    const poll = {
        question,
        options, // array of strings
        votes: {}, // jid -> option index
        createdBy,
        createdAt: Date.now()
    };
    await redisClient.set(pollKey(groupId), JSON.stringify(poll), { EX: POLL_TTL });
    return poll;
}

async function getPoll(redisClient, groupId) {
    const raw = await redisClient.get(pollKey(groupId));
    return raw ? JSON.parse(raw) : null;
}

async function votePoll(redisClient, groupId, jid, optionIndex) {
    const poll = await getPoll(redisClient, groupId);
    if (!poll) return null;
    if (optionIndex < 0 || optionIndex >= poll.options.length) return { error: 'invalid_option', poll };

    poll.votes[jid] = optionIndex;
    await redisClient.set(pollKey(groupId), JSON.stringify(poll), { EX: POLL_TTL });
    return { success: true, poll };
}

async function endPoll(redisClient, groupId) {
    const poll = await getPoll(redisClient, groupId);
    await redisClient.del(pollKey(groupId));
    return poll;
}

function tallyPoll(poll) {
    const counts = poll.options.map(() => 0);
    for (const optionIndex of Object.values(poll.votes)) {
        if (counts[optionIndex] !== undefined) counts[optionIndex]++;
    }
    return counts;
}

function renderPollResults(poll) {
    const counts = tallyPoll(poll);
    const totalVotes = counts.reduce((a, b) => a + b, 0);
    return poll.options.map((opt, i) => {
        const pct = totalVotes > 0 ? Math.round((counts[i] / totalVotes) * 100) : 0;
        const barLength = Math.round(pct / 10);
        const bar = '▰'.repeat(barLength) + '▱'.repeat(10 - barLength);
        return `${i + 1}. ${opt}\n${bar} ${counts[i]} votes (${pct}%)`;
    }).join('\n\n');
}

// ════════════════════════════════════════════
// GIVEAWAY
// Single active giveaway per group. Entrants in a Set,
// winner picked randomly when ended (manually or via TTL job).
// ════════════════════════════════════════════

function giveawayKey(groupId) {
    return `giveaway:${groupId}`;
}

function giveawayEntrantsKey(groupId) {
    return `giveaway_entrants:${groupId}`;
}

async function createGiveaway(redisClient, groupId, prize, durationMinutes, createdBy) {
    const giveaway = {
        prize,
        createdBy,
        createdAt: Date.now(),
        endsAt: Date.now() + durationMinutes * 60 * 1000
    };
    const ttlSec = durationMinutes * 60 + 60; // small buffer
    await redisClient.set(giveawayKey(groupId), JSON.stringify(giveaway), { EX: ttlSec });
    await redisClient.del(giveawayEntrantsKey(groupId)); // clear any stale entrants
    return giveaway;
}

async function getGiveaway(redisClient, groupId) {
    const raw = await redisClient.get(giveawayKey(groupId));
    return raw ? JSON.parse(raw) : null;
}

async function enterGiveaway(redisClient, groupId, jid) {
    const giveaway = await getGiveaway(redisClient, groupId);
    if (!giveaway) return null;
    const alreadyEntered = await redisClient.sIsMember(giveawayEntrantsKey(groupId), jid);
    if (alreadyEntered) return { alreadyEntered: true, giveaway };
    await redisClient.sAdd(giveawayEntrantsKey(groupId), jid);
    return { entered: true, giveaway };
}

async function getGiveawayEntrants(redisClient, groupId) {
    const members = await redisClient.sMembers(giveawayEntrantsKey(groupId));
    return members || [];
}

// ── End the giveaway and pick a random winner. Returns { giveaway, winner } or null ──
async function endGiveaway(redisClient, groupId) {
    const giveaway = await getGiveaway(redisClient, groupId);
    if (!giveaway) return null;

    const entrants = await getGiveawayEntrants(redisClient, groupId);
    const winner = entrants.length > 0 ? entrants[Math.floor(Math.random() * entrants.length)] : null;

    await redisClient.del(giveawayKey(groupId));
    await redisClient.del(giveawayEntrantsKey(groupId));

    return { giveaway, winner, entrantCount: entrants.length };
}

// ── Antispam: sliding-window message counter per user per group ──
// Key: spam:<groupId>:<jid> -> message count, TTL = window duration
async function trackSpamMessage(redisClient, groupId, jid, windowSec) {
    const key = `spam:${groupId}:${jid}`;
    const count = await redisClient.incr(key);
    if (count === 1) {
        // First message in this window — set TTL
        await redisClient.expire(key, windowSec);
    }
    return count;
}

async function resetSpamCount(redisClient, groupId, jid) {
    await redisClient.del(`spam:${groupId}:${jid}`);
}

module.exports = {
    DEFAULT_WARN_LIMIT,
    getGroupConfig,
    setGroupConfig,
    getBadwordList,
    addBadword,
    removeBadword,
    trackSpamMessage,
    resetSpamCount,
    getWarnCount,
    addWarning,
    clearWarnings,
    POLL_TTL,
    createPoll,
    getPoll,
    votePoll,
    endPoll,
    tallyPoll,
    renderPollResults,
    createGiveaway,
    getGiveaway,
    enterGiveaway,
    getGiveawayEntrants,
    endGiveaway
};
