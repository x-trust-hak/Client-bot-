// economy.js — Lady Liya Economy & Game System Core
//
// User economy data is stored in Redis under: economy:<jid>
// as a hash with fields: coins, bank, level, xp, lastDaily, lastWeekly,
// lastWork, lastBeg, married, wins, losses
//
// This is the FOUNDATION. Fishing/mining/farming/pets/vehicles/property/PvP
// all follow this same pattern (Redis hash per user + cooldown timestamps +
// item arrays in JSON) — add them incrementally using this as a template.

const DEFAULT_ECONOMY = {
    coins: 500,      // starting balance
    bank: 0,
    level: 1,
    xp: 0,
    lastDaily: 0,
    lastWeekly: 0,
    lastWork: 0,
    lastBeg: 0,
    married: null,   // JID of spouse, or null
    wins: 0,
    losses: 0
};

// ── XP required to reach the next level (simple curve) ──
function xpForLevel(level) {
    return level * 100;
}

// ── Get a user's economy profile, creating one if it doesn't exist ──
async function getProfile(redisClient, jid) {
    try {
        const data = await redisClient.hGetAll(`economy:${jid}`);

        if (!data || Object.keys(data).length === 0) {
            await redisClient.hSet(`economy:${jid}`, {
                coins: String(DEFAULT_ECONOMY.coins),
                bank: String(DEFAULT_ECONOMY.bank),
                level: String(DEFAULT_ECONOMY.level),
                xp: String(DEFAULT_ECONOMY.xp),
                lastDaily: '0',
                lastWeekly: '0',
                lastWork: '0',
                lastBeg: '0',
                married: '',
                wins: '0',
                losses: '0'
            });
            return { ...DEFAULT_ECONOMY };
        }

        return {
            coins: parseInt(data.coins || '0'),
            bank: parseInt(data.bank || '0'),
            level: parseInt(data.level || '1'),
            xp: parseInt(data.xp || '0'),
            lastDaily: parseInt(data.lastDaily || '0'),
            lastWeekly: parseInt(data.lastWeekly || '0'),
            lastWork: parseInt(data.lastWork || '0'),
            lastBeg: parseInt(data.lastBeg || '0'),
            married: data.married || null,
            wins: parseInt(data.wins || '0'),
            losses: parseInt(data.losses || '0')
        };
    } catch (err) {
        console.error('getProfile error:', err);
        return { ...DEFAULT_ECONOMY };
    }
}

// ── Update specific fields of a user's profile ──
async function updateProfile(redisClient, jid, updates) {
    const payload = {};
    for (const [key, value] of Object.entries(updates)) {
        payload[key] = String(value ?? '');
    }
    await redisClient.hSet(`economy:${jid}`, payload);
}

// ── Add coins to wallet (use negative to subtract) ──
async function addCoins(redisClient, jid, amount) {
    const profile = await getProfile(redisClient, jid);
    const newBalance = Math.max(0, profile.coins + amount);
    await updateProfile(redisClient, jid, { coins: newBalance });
    return newBalance;
}

// ── Add XP and handle level-ups. Returns { leveledUp, newLevel } ──
async function addXp(redisClient, jid, amount) {
    const profile = await getProfile(redisClient, jid);
    let xp = profile.xp + amount;
    let level = profile.level;
    let leveledUp = false;

    while (xp >= xpForLevel(level)) {
        xp -= xpForLevel(level);
        level++;
        leveledUp = true;
    }

    await updateProfile(redisClient, jid, { xp, level });
    return { leveledUp, newLevel: level, xp };
}

// ── Format coins with commas ──
function formatCoins(amount) {
    return amount.toLocaleString('en-US');
}

// ── Cooldown helper: returns ms remaining, or 0 if ready ──
function cooldownRemaining(lastTimestamp, cooldownMs) {
    const elapsed = Date.now() - lastTimestamp;
    return Math.max(0, cooldownMs - elapsed);
}

// ── Format milliseconds as human-readable duration ──
function formatDuration(ms) {
    const totalSec = Math.ceil(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;

    const parts = [];
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    if (s > 0 || parts.length === 0) parts.push(`${s}s`);
    return parts.join(' ');
}

module.exports = {
    DEFAULT_ECONOMY,
    xpForLevel,
    getProfile,
    updateProfile,
    addCoins,
    addXp,
    formatCoins,
    cooldownRemaining,
    formatDuration
};

// ═══════════════════════════════════════════════════════
// FISHING DATA
// ═══════════════════════════════════════════════════════
const FISH_TABLE = [
    { name: 'Sardine', emoji: '🐟', rarity: 'common', value: [20, 60], weight: 45 },
    { name: 'Catfish', emoji: '🐠', rarity: 'common', value: [40, 100], weight: 30 },
    { name: 'Bass', emoji: '🎣', rarity: 'uncommon', value: [100, 250], weight: 15 },
    { name: 'Salmon', emoji: '🐡', rarity: 'rare', value: [250, 600], weight: 7 },
    { name: 'Swordfish', emoji: '⚔️', rarity: 'epic', value: [600, 1500], weight: 2.5 },
    { name: 'Golden Fish', emoji: '✨', rarity: 'legendary', value: [2000, 5000], weight: 0.5 }
];

// ═══════════════════════════════════════════════════════
// MINING DATA
// ═══════════════════════════════════════════════════════
const ORE_TABLE = [
    { name: 'Stone', emoji: '🪨', rarity: 'common', value: [5, 20], weight: 40 },
    { name: 'Coal', emoji: '⬛', rarity: 'common', value: [15, 40], weight: 25 },
    { name: 'Iron', emoji: '⚙️', rarity: 'uncommon', value: [40, 100], weight: 18 },
    { name: 'Gold', emoji: '🟡', rarity: 'rare', value: [100, 300], weight: 10 },
    { name: 'Diamond', emoji: '💎', rarity: 'epic', value: [400, 1000], weight: 5 },
    { name: 'Emerald', emoji: '💚', rarity: 'epic', value: [600, 1500], weight: 1.5 },
    { name: 'Mythic Ore', emoji: '🌟', rarity: 'mythic', value: [2000, 8000], weight: 0.5 }
];

// ═══════════════════════════════════════════════════════
// FARMING DATA
// ═══════════════════════════════════════════════════════
const CROPS = [
    { name: 'Wheat', emoji: '🌾', cost: 50, growTime: 30, value: [80, 150], weight: 40 },
    { name: 'Corn', emoji: '🌽', cost: 80, growTime: 60, value: [150, 280], weight: 25 },
    { name: 'Carrot', emoji: '🥕', cost: 100, growTime: 90, value: [200, 400], weight: 20 },
    { name: 'Tomato', emoji: '🍅', cost: 150, growTime: 120, value: [300, 600], weight: 10 },
    { name: 'Strawberry', emoji: '🍓', cost: 300, growTime: 180, value: [700, 1500], weight: 4 },
    { name: 'Golden Apple', emoji: '🍎', cost: 1000, growTime: 360, value: [3000, 8000], weight: 1 }
];

// ═══════════════════════════════════════════════════════
// PET DATA
// ═══════════════════════════════════════════════════════
const PETS = [
    { id: 'cat', name: 'Cat', emoji: '🐱', cost: 500, baseDmg: 5, baseHp: 50 },
    { id: 'dog', name: 'Dog', emoji: '🐶', cost: 600, baseDmg: 6, baseHp: 60 },
    { id: 'dragon', name: 'Dragon', emoji: '🐲', cost: 5000, baseDmg: 25, baseHp: 200 },
    { id: 'phoenix', name: 'Phoenix', emoji: '🦅', cost: 10000, baseDmg: 35, baseHp: 250 },
    { id: 'wolf', name: 'Wolf', emoji: '🐺', cost: 1500, baseDmg: 15, baseHp: 100 },
    { id: 'fox', name: 'Fox', emoji: '🦊', cost: 1200, baseDmg: 12, baseHp: 90 }
];

// ─── Weighted random pick ────────────────────────────
function weightedPick(table) {
    const total = table.reduce((s, i) => s + i.weight, 0);
    let r = Math.random() * total;
    for (const item of table) {
        r -= item.weight;
        if (r <= 0) return item;
    }
    return table[table.length - 1];
}

// ─── Value in range ──────────────────────────────────
function rollValue(range) {
    return Math.floor(Math.random() * (range[1] - range[0] + 1)) + range[0];
}

module.exports.FISH_TABLE = FISH_TABLE;
module.exports.ORE_TABLE = ORE_TABLE;
module.exports.CROPS = CROPS;
module.exports.PETS = PETS;
module.exports.weightedPick = weightedPick;
module.exports.rollValue = rollValue;
