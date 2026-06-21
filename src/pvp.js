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
// BEST-OF-3 DUEL
// First to 2 wins takes the full pot. Each round is a coin-flip-style
// 50/50 roll (consistent with the existing single-shot duel's odds).
// Stored under bo3:<groupId>:<challengerJid> during challenge phase,
// then bo3match:<groupId> once accepted (one active match per group).
// ══════════════════════════════════════════════════════════
const BO3_CHALLENGE_TTL = 60; // seconds to accept
const BO3_MATCH_TTL = 5 * 60; // seconds — abandoned match auto-expires

function bo3ChallengeKey(groupId, challengerJid) {
    return `bo3:${groupId}:${challengerJid}`;
}

function bo3MatchKey(groupId) {
    return `bo3match:${groupId}`;
}

async function createBo3Challenge(redisClient, groupId, challengerJid, targetJid, bet) {
    await redisClient.set(bo3ChallengeKey(groupId, challengerJid), JSON.stringify({ challengerJid, targetJid, bet, timestamp: Date.now() }), { EX: BO3_CHALLENGE_TTL });
}

async function findBo3ChallengeFor(redisClient, groupId, targetJid) {
    const keys = await redisClient.keys(`bo3:${groupId}:*`);
    for (const key of keys) {
        const raw = await redisClient.get(key);
        if (!raw) continue;
        const challenge = JSON.parse(raw);
        if (challenge.targetJid === targetJid) return { ...challenge, key };
    }
    return null;
}

async function deleteBo3Challenge(redisClient, key) {
    await redisClient.del(key);
}

async function startBo3Match(redisClient, groupId, playerA, playerB, bet) {
    const match = { playerA, playerB, bet, scoreA: 0, scoreB: 0, round: 1, startedAt: Date.now() };
    await redisClient.set(bo3MatchKey(groupId), JSON.stringify(match), { EX: BO3_MATCH_TTL });
    return match;
}

async function getBo3Match(redisClient, groupId) {
    const raw = await redisClient.get(bo3MatchKey(groupId));
    return raw ? JSON.parse(raw) : null;
}

async function endBo3Match(redisClient, groupId) {
    await redisClient.del(bo3MatchKey(groupId));
}

// ── Play one round: level-weighted random winner (same combat formula as
//    the existing single-shot duel, for consistency). Returns updated
//    match + round result. Match auto-ends when someone reaches 2 wins. ──
async function playBo3Round(redisClient, groupId, levelA, levelB) {
    const match = await getBo3Match(redisClient, groupId);
    if (!match) return null;

    const powerA = levelA * (0.5 + Math.random());
    const powerB = levelB * (0.5 + Math.random());
    const roundWinner = powerA >= powerB ? 'A' : 'B';

    if (roundWinner === 'A') match.scoreA++;
    else match.scoreB++;

    const matchOver = match.scoreA >= 2 || match.scoreB >= 2;
    if (matchOver) {
        await endBo3Match(redisClient, groupId);
        return { match, roundWinner, matchOver: true, winnerJid: match.scoreA >= 2 ? match.playerA : match.playerB };
    }

    match.round++;
    await redisClient.set(bo3MatchKey(groupId), JSON.stringify(match), { EX: BO3_MATCH_TTL });
    return { match, roundWinner, matchOver: false };
}

// ══════════════════════════════════════════════════════════
// RPS DUEL (bet-based, head-to-head rock-paper-scissors)
// Both players submit a move privately (via DM-like flow — actually
// just a command in-group, but moves are hidden from each other in
// the response text until both have moved). Stored under
// rpsduel:<groupId> during challenge + move-submission phase.
// ══════════════════════════════════════════════════════════
const RPS_CHALLENGE_TTL = 60;
const RPS_MATCH_TTL = 5 * 60;

function rpsChallengeKey(groupId, challengerJid) {
    return `rpsduel_challenge:${groupId}:${challengerJid}`;
}

function rpsMatchKey(groupId) {
    return `rpsduel:${groupId}`;
}

async function createRpsChallenge(redisClient, groupId, challengerJid, targetJid, bet) {
    await redisClient.set(rpsChallengeKey(groupId, challengerJid), JSON.stringify({ challengerJid, targetJid, bet, timestamp: Date.now() }), { EX: RPS_CHALLENGE_TTL });
}

async function findRpsChallengeFor(redisClient, groupId, targetJid) {
    const keys = await redisClient.keys(`rpsduel_challenge:${groupId}:*`);
    for (const key of keys) {
        const raw = await redisClient.get(key);
        if (!raw) continue;
        const challenge = JSON.parse(raw);
        if (challenge.targetJid === targetJid) return { ...challenge, key };
    }
    return null;
}

async function deleteRpsChallenge(redisClient, key) {
    await redisClient.del(key);
}

async function startRpsMatch(redisClient, groupId, playerA, playerB, bet) {
    const match = { playerA, playerB, bet, moveA: null, moveB: null, startedAt: Date.now() };
    await redisClient.set(rpsMatchKey(groupId), JSON.stringify(match), { EX: RPS_MATCH_TTL });
    return match;
}

async function getRpsMatch(redisClient, groupId) {
    const raw = await redisClient.get(rpsMatchKey(groupId));
    return raw ? JSON.parse(raw) : null;
}

async function endRpsMatch(redisClient, groupId) {
    await redisClient.del(rpsMatchKey(groupId));
}

const RPS_BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };

// ── Submit a move for one player. Returns { match, bothMoved, result? } ──
async function submitRpsMove(redisClient, groupId, jid, move) {
    const match = await getRpsMatch(redisClient, groupId);
    if (!match) return null;

    const isA = jid === match.playerA;
    const isB = jid === match.playerB;
    if (!isA && !isB) return { match, error: 'not_a_player' };

    if (isA && match.moveA) return { match, error: 'already_moved' };
    if (isB && match.moveB) return { match, error: 'already_moved' };

    if (isA) match.moveA = move;
    else match.moveB = move;

    if (match.moveA && match.moveB) {
        await endRpsMatch(redisClient, groupId);

        let winnerJid = null; // null = draw
        if (match.moveA !== match.moveB) {
            winnerJid = RPS_BEATS[match.moveA] === match.moveB ? match.playerA : match.playerB;
        }

        return { match, bothMoved: true, winnerJid };
    }

    await redisClient.set(rpsMatchKey(groupId), JSON.stringify(match), { EX: RPS_MATCH_TTL });
    return { match, bothMoved: false };
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
    XP_BOOSTS, getXpMultiplier,
    // Best-of-3 duel
    BO3_CHALLENGE_TTL, BO3_MATCH_TTL,
    createBo3Challenge, findBo3ChallengeFor, deleteBo3Challenge,
    startBo3Match, getBo3Match, endBo3Match, playBo3Round,
    // RPS duel
    RPS_CHALLENGE_TTL, RPS_MATCH_TTL, RPS_BEATS,
    createRpsChallenge, findRpsChallengeFor, deleteRpsChallenge,
    startRpsMatch, getRpsMatch, endRpsMatch, submitRpsMove
};
