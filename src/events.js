// events.js — Lady Liya Seasonal Events
//
// A single GLOBAL active event (not per-session) stored under the Redis
// key "activeEvent" as a JSON blob: { name, emoji, multiplier, startedAt,
// endsAt, startedBy }. Only the super admin can start/end events.
//
// economy.addCoins / economy.addXp consult getActiveMultiplier() so the
// boost applies automatically to EVERY coin/XP source in the bot —
// games, daily/weekly/work, referrals, badges, mines, snake, etc —
// with no per-command wiring required.

const ACTIVE_EVENT_KEY = 'activeEvent';

// ── Preset event templates (admin picks one by id, or goes custom) ──
const EVENT_PRESETS = [
    { id: 'double_xp',    name: 'Double XP Weekend',     emoji: '⭐', multiplier: 2,   xpOnly: true  },
    { id: 'double_coins', name: 'Double Coins Bonanza',  emoji: '💰', multiplier: 2,   coinsOnly: true },
    { id: 'triple_all',   name: 'Triple Everything',     emoji: '🔥', multiplier: 3,   xpOnly: false, coinsOnly: false },
    { id: 'holiday',      name: 'Holiday Bonus',         emoji: '🎄', multiplier: 1.5, xpOnly: false, coinsOnly: false },
    { id: 'anniversary',  name: 'Bot Anniversary',       emoji: '🎂', multiplier: 2.5, xpOnly: false, coinsOnly: false },
];

function getPreset(id) {
    return EVENT_PRESETS.find(p => p.id === id) || null;
}

// ── Start a global event. durationHours = null means it runs until manually ended ──
async function startEvent(redisClient, { name, emoji, multiplier, xpOnly = false, coinsOnly = false, durationHours = null, startedBy }) {
    const now = Date.now();
    const event = {
        name,
        emoji,
        multiplier,
        xpOnly,
        coinsOnly,
        startedAt: now,
        endsAt: durationHours ? now + durationHours * 60 * 60 * 1000 : null,
        startedBy
    };

    if (durationHours) {
        await redisClient.set(ACTIVE_EVENT_KEY, JSON.stringify(event), { EX: Math.ceil(durationHours * 60 * 60) });
    } else {
        await redisClient.set(ACTIVE_EVENT_KEY, JSON.stringify(event));
    }

    return event;
}

async function endEvent(redisClient) {
    const existing = await redisClient.get(ACTIVE_EVENT_KEY);
    await redisClient.del(ACTIVE_EVENT_KEY);
    return existing ? JSON.parse(existing) : null;
}

// ── Get the current event, or null if none active / expired ──
async function getActiveEvent(redisClient) {
    try {
        const raw = await redisClient.get(ACTIVE_EVENT_KEY);
        if (!raw) return null;
        const event = JSON.parse(raw);

        if (event.endsAt && Date.now() > event.endsAt) {
            await redisClient.del(ACTIVE_EVENT_KEY);
            return null;
        }
        return event;
    } catch {
        return null;
    }
}

// ── Get the multiplier that should apply to a coin or XP gain right now.
//    type is 'coins' or 'xp'. Returns 1 if no event or event doesn't cover that type. ──
async function getActiveMultiplier(redisClient, type) {
    const event = await getActiveEvent(redisClient);
    if (!event) return 1;

    if (type === 'xp' && event.coinsOnly) return 1;
    if (type === 'coins' && event.xpOnly) return 1;

    return event.multiplier;
}

// ── Human-readable remaining time, or "until ended manually" ──
function formatTimeRemaining(event) {
    if (!event.endsAt) return 'until manually ended';
    const ms = event.endsAt - Date.now();
    if (ms <= 0) return 'ending now';

    const totalMin = Math.ceil(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h > 0) return `${h}h ${m}m remaining`;
    return `${m}m remaining`;
}

module.exports = {
    ACTIVE_EVENT_KEY,
    EVENT_PRESETS,
    getPreset,
    startEvent,
    endEvent,
    getActiveEvent,
    getActiveMultiplier,
    formatTimeRemaining
};
