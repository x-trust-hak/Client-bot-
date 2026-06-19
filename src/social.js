// social.js — Lady Liya Social Features
// Friends, Teams, Promo Codes

const { getProfile, updateProfile, addCoins, formatCoins } = require('./economy');

// ══════════════════════════════════════════════════════════
// FRIENDS SYSTEM
// Stored under friends:<jid> as a Set of friend JIDs
// Pending requests under friendreq:<targetJid> as a Set
// ══════════════════════════════════════════════════════════
async function getFriends(redisClient, jid) {
    const members = await redisClient.sMembers(`friends:${jid}`);
    return members || [];
}

async function getFriendRequests(redisClient, jid) {
    const members = await redisClient.sMembers(`friendreq:${jid}`);
    return members || [];
}

async function sendFriendRequest(redisClient, fromJid, toJid) {
    await redisClient.sAdd(`friendreq:${toJid}`, fromJid);
    await redisClient.expire(`friendreq:${toJid}`, 60 * 60 * 24); // 24h expiry
}

async function acceptFriend(redisClient, jid1, jid2) {
    await redisClient.sAdd(`friends:${jid1}`, jid2);
    await redisClient.sAdd(`friends:${jid2}`, jid1);
    await redisClient.sRem(`friendreq:${jid1}`, jid2);
}

async function removeFriend(redisClient, jid1, jid2) {
    await redisClient.sRem(`friends:${jid1}`, jid2);
    await redisClient.sRem(`friends:${jid2}`, jid1);
}

async function areFriends(redisClient, jid1, jid2) {
    return await redisClient.sIsMember(`friends:${jid1}`, jid2);
}

// ══════════════════════════════════════════════════════════
// TEAMS SYSTEM
// Stored under team:<teamName> (hash)
// User team stored in economy:<jid> → team field
// ══════════════════════════════════════════════════════════
async function getTeam(redisClient, teamName) {
    const raw = await redisClient.hGetAll(`team:${teamName.toLowerCase()}`);
    if (!raw || !raw.name) return null;
    return {
        name: raw.name,
        leader: raw.leader,
        members: raw.members ? JSON.parse(raw.members) : [],
        wins: parseInt(raw.wins || '0'),
        losses: parseInt(raw.losses || '0'),
        bank: parseInt(raw.bank || '0'),
        createdAt: parseInt(raw.createdAt || '0')
    };
}

async function saveTeam(redisClient, teamName, data) {
    await redisClient.hSet(`team:${teamName.toLowerCase()}`, {
        name: data.name,
        leader: data.leader,
        members: JSON.stringify(data.members),
        wins: String(data.wins || 0),
        losses: String(data.losses || 0),
        bank: String(data.bank || 0),
        createdAt: String(data.createdAt || Date.now())
    });
}

// ══════════════════════════════════════════════════════════
// PROMO CODES
// Stored under promo:<code> (hash)
// Used promo tracking under promoused:<code> (Set of JIDs)
// ══════════════════════════════════════════════════════════
async function getPromo(redisClient, code) {
    const raw = await redisClient.hGetAll(`promo:${code.toUpperCase()}`);
    if (!raw || !raw.code) return null;
    return {
        code: raw.code,
        coins: parseInt(raw.coins || '0'),
        xp: parseInt(raw.xp || '0'),
        maxUses: parseInt(raw.maxUses || '1'),
        uses: parseInt(raw.uses || '0'),
        expiresAt: parseInt(raw.expiresAt || '0'),
        createdBy: raw.createdBy || ''
    };
}

async function createPromo(redisClient, code, coins, xp, maxUses, expiryHours, createdBy) {
    await redisClient.hSet(`promo:${code.toUpperCase()}`, {
        code: code.toUpperCase(),
        coins: String(coins),
        xp: String(xp),
        maxUses: String(maxUses),
        uses: '0',
        expiresAt: String(Date.now() + expiryHours * 60 * 60 * 1000),
        createdBy
    });
}

async function redeemPromo(redisClient, code, jid) {
    const promo = await getPromo(redisClient, code);
    if (!promo) return { error: 'Invalid promo code.' };
    if (promo.expiresAt && Date.now() > promo.expiresAt) return { error: 'This promo code has expired.' };
    if (promo.uses >= promo.maxUses) return { error: 'This promo code has reached its usage limit.' };

    const alreadyUsed = await redisClient.sIsMember(`promoused:${code.toUpperCase()}`, jid);
    if (alreadyUsed) return { error: 'You have already used this promo code.' };

    await redisClient.sAdd(`promoused:${code.toUpperCase()}`, jid);
    await redisClient.hIncrBy(`promo:${code.toUpperCase()}`, 'uses', 1);

    return { success: true, coins: promo.coins, xp: promo.xp };
}

module.exports = {
    getFriends, getFriendRequests, sendFriendRequest,
    acceptFriend, removeFriend, areFriends,
    getTeam, saveTeam,
    getPromo, createPromo, redeemPromo
};
