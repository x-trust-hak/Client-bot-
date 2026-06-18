// pvp.js — Lady Liya PvP, Guilds, Vehicles, Property, Boss Raids

const { getProfile, updateProfile, addCoins, addXp, formatCoins, cooldownRemaining, formatDuration } = require('./economy');

// ══════════════════════════════════════════════════════════
// PvP / DUEL SYSTEM
// Duel requests stored in Redis under duel:<groupId>:<challengerJid>
// expires in 60s if not accepted
// ══════════════════════════════════════════════════════════
const DUEL_EXPIRE = 60; // seconds

async function createDuel(redisClient, groupId, challengerJid, targetJid, bet) {
    const key = `duel:${groupId}:${challengerJid}`;
    await redisClient.set(key, JSON.stringify({ challengerJid, targetJid, bet, timestamp: Date.now() }), { EX: DUEL_EXPIRE });
}

async function getDuel(redisClient, groupId, challengerJid) {
    const raw = await redisClient.get(`duel:${groupId}:${challengerJid}`);
    return raw ? JSON.parse(raw) : null;
}

async function deleteDuel(redisClient, groupId, challengerJid) {
    await redisClient.del(`duel:${groupId}:${challengerJid}`);
}

// Find any pending duel targeting this JID in a group
async function findDuelFor(redisClient, groupId, targetJid) {
    const keys = await redisClient.keys(`duel:${groupId}:*`);
    for (const key of keys) {
        const raw = await redisClient.get(key);
        if (!raw) continue;
        const duel = JSON.parse(raw);
        if (duel.targetJid === targetJid) return { ...duel, key };
    }
    return null;
}

// ══════════════════════════════════════════════════════════
// GUILDS / CLANS
// Stored under guild:<guildName> (hash) and user guild in economy:<jid> → guild field
// ══════════════════════════════════════════════════════════
async function getGuild(redisClient, guildName) {
    const raw = await redisClient.hGetAll(`guild:${guildName.toLowerCase()}`);
    if (!raw || !raw.name) return null;
    return {
        name: raw.name,
        leader: raw.leader,
        members: raw.members ? JSON.parse(raw.members) : [],
        level: parseInt(raw.level || '1'),
        xp: parseInt(raw.xp || '0'),
        bank: parseInt(raw.bank || '0'),
        description: raw.description || 'No description set.',
        createdAt: parseInt(raw.createdAt || '0')
    };
}

async function saveGuild(redisClient, guildName, data) {
    await redisClient.hSet(`guild:${guildName.toLowerCase()}`, {
        name: data.name,
        leader: data.leader,
        members: JSON.stringify(data.members),
        level: String(data.level),
        xp: String(data.xp),
        bank: String(data.bank),
        description: data.description || '',
        createdAt: String(data.createdAt || Date.now())
    });
}

// ══════════════════════════════════════════════════════════
// VEHICLES
// ══════════════════════════════════════════════════════════
const VEHICLES = [
    { id: 'bicycle',  name: 'Bicycle',    emoji: '🚲', price: 500,   speedBonus: 0.05, desc: 'A basic bicycle. Gets you around.' },
    { id: 'bike',     name: 'Motorbike',  emoji: '🏍️', price: 2000,  speedBonus: 0.15, desc: 'Faster and cooler.' },
    { id: 'car',      name: 'Car',        emoji: '🚗', price: 8000,  speedBonus: 0.30, desc: 'A solid everyday car.' },
    { id: 'sports',   name: 'Sports Car', emoji: '🏎️', price: 30000, speedBonus: 0.60, desc: 'Built for speed.' },
    { id: 'yacht',    name: 'Yacht',      emoji: '🛥️', price: 80000, speedBonus: 0.80, desc: 'For the elite.' },
    { id: 'jet',      name: 'Private Jet',emoji: '✈️', price: 250000,speedBonus: 1.50, desc: 'Sky\'s the limit.' },
];

// ══════════════════════════════════════════════════════════
// PROPERTY
// ══════════════════════════════════════════════════════════
const PROPERTIES = [
    { id: 'tent',      name: 'Tent',       emoji: '⛺', price: 200,    income: 20,   desc: 'A basic shelter.' },
    { id: 'apartment', name: 'Apartment',  emoji: '🏠', price: 3000,   income: 150,  desc: 'Your own place.' },
    { id: 'house',     name: 'House',      emoji: '🏡', price: 15000,  income: 600,  desc: 'Suburban living.' },
    { id: 'villa',     name: 'Villa',      emoji: '🏰', price: 60000,  income: 2000, desc: 'Luxury resort vibes.' },
    { id: 'mansion',   name: 'Mansion',    emoji: '🏯', price: 200000, income: 6000, desc: 'The dream home.' },
    { id: 'skyscraper',name: 'Skyscraper', emoji: '🏙️', price: 800000, income: 20000,desc: 'A city landmark.' },
];

// ══════════════════════════════════════════════════════════
// BOSS RAIDS
// ══════════════════════════════════════════════════════════
const BOSSES = [
    { name: 'Goblin King',   emoji: '👺', hp: 500,  reward: 2000,  xp: 50,  minLevel: 1 },
    { name: 'Dark Wizard',   emoji: '🧙', hp: 1200, reward: 5000,  xp: 120, minLevel: 5 },
    { name: 'Stone Golem',   emoji: '🗿', hp: 3000, reward: 12000, xp: 250, minLevel: 10 },
    { name: 'Shadow Dragon', emoji: '🐲', hp: 8000, reward: 35000, xp: 600, minLevel: 20 },
    { name: 'Chaos Titan',   emoji: '👹', hp: 20000,reward: 100000,xp: 1500,minLevel: 40 },
];

// Active raids stored under raid:<groupId>
async function getRaid(redisClient, groupId) {
    const raw = await redisClient.get(`raid:${groupId}`);
    return raw ? JSON.parse(raw) : null;
}

async function saveRaid(redisClient, groupId, raid) {
    await redisClient.set(`raid:${groupId}`, JSON.stringify(raid), { EX: 60 * 60 }); // expires 1h
}

async function deleteRaid(redisClient, groupId) {
    await redisClient.del(`raid:${groupId}`);
}

// ══════════════════════════════════════════════════════════
// XP BOOSTS
// ══════════════════════════════════════════════════════════
const XP_BOOSTS = [
    { id: 'boost_1h',  name: '1h XP Boost (2x)',   duration: 60 * 60 * 1000,        multiplier: 2,   price: 300  },
    { id: 'boost_6h',  name: '6h XP Boost (2x)',   duration: 6 * 60 * 60 * 1000,   multiplier: 2,   price: 1200 },
    { id: 'boost_24h', name: '24h XP Boost (3x)',  duration: 24 * 60 * 60 * 1000,  multiplier: 3,   price: 4000 },
    { id: 'boost_vip', name: 'VIP Boost (5x/48h)', duration: 48 * 60 * 60 * 1000,  multiplier: 5,   price: 15000 },
];

async function getXpMultiplier(redisClient, jid) {
    const raw = await redisClient.hGet(`economy:${jid}`, 'xpBoost');
    if (!raw) return 1;
    const boost = JSON.parse(raw);
    if (Date.now() > boost.expiresAt) {
        await redisClient.hDel(`economy:${jid}`, 'xpBoost');
        return 1;
    }
    return boost.multiplier;
}

module.exports = {
    DUEL_EXPIRE, createDuel, getDuel, deleteDuel, findDuelFor,
    getGuild, saveGuild,
    VEHICLES, PROPERTIES, BOSSES,
    getRaid, saveRaid, deleteRaid,
    XP_BOOSTS, getXpMultiplier
};
