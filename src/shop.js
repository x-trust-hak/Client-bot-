// shop.js — Lady Liya Coin Sink Shop
//
// Four categories of purchasable items, all stored under economy:<jid>:
//   - xpBoost / luckBoost: JSON { multiplier, expiresAt } (single active one at a time)
//   - titles: JSON array of owned title IDs, "equippedTitle" holds the active one
//   - themes: JSON array of owned theme IDs, "equippedTheme" holds the active one
//   - revives: integer count of Mines/Snake revive tokens held
//
// Cosmetics (titles/themes) are pure coin sinks — no gameplay effect —
// which is the healthiest kind of sink for inflation control.

const XP_BOOSTERS = [
    { id: 'xp_boost_1h',  name: '1h XP Booster',  emoji: '⚡', price: 200,  multiplier: 1.5, durationMs: 1 * 60 * 60 * 1000 },
    { id: 'xp_boost_6h',  name: '6h XP Booster',  emoji: '⚡', price: 800,  multiplier: 1.5, durationMs: 6 * 60 * 60 * 1000 },
    { id: 'xp_boost_24h', name: '24h XP Booster', emoji: '⚡', price: 2500, multiplier: 2,   durationMs: 24 * 60 * 60 * 1000 },
];

const LUCK_BOOSTERS = [
    { id: 'luck_boost_1h', name: '1h Luck Booster', emoji: '🍀', price: 300,  multiplier: 1.2, durationMs: 1 * 60 * 60 * 1000 },
    { id: 'luck_boost_6h', name: '6h Luck Booster', emoji: '🍀', price: 1200, multiplier: 1.2, durationMs: 6 * 60 * 60 * 1000 },
];

const REVIVE_TOKEN = { id: 'revive_token', name: 'Revive Token', emoji: '💊', price: 500, description: 'Continue a Mines or Snake game after dying — used automatically on death.' };

const TITLES = [
    { id: 'title_rookie',     name: 'Rookie',        price: 100 },
    { id: 'title_grinder',    name: 'Grinder',       price: 500 },
    { id: 'title_highroller', name: 'High Roller',   price: 1500 },
    { id: 'title_legendary',  name: 'Legendary',     price: 5000 },
    { id: 'title_immortal',   name: 'Immortal',      price: 15000 },
];

const THEMES = [
    { id: 'theme_default',  name: 'Default',  emoji: '⬜', price: 0 },
    { id: 'theme_neon',     name: 'Neon',      emoji: '💜', price: 800 },
    { id: 'theme_gold',     name: 'Gold',      emoji: '🟨', price: 2000 },
    { id: 'theme_crimson',  name: 'Crimson',   emoji: '🟥', price: 1500 },
    { id: 'theme_ocean',    name: 'Ocean',     emoji: '🟦', price: 1500 },
];

// ── Generic owned-list helpers (titles / themes) ──
async function getOwnedList(redisClient, jid, field) {
    const raw = await redisClient.hGet(`economy:${jid}`, field);
    return raw ? JSON.parse(raw) : [];
}

async function addToOwnedList(redisClient, jid, field, itemId) {
    const owned = await getOwnedList(redisClient, jid, field);
    if (!owned.includes(itemId)) {
        owned.push(itemId);
        await redisClient.hSet(`economy:${jid}`, field, JSON.stringify(owned));
    }
}

// ── Boosters (xpBoost / luckBoost) ──
async function setBoost(redisClient, jid, field, multiplier, durationMs) {
    const boost = { multiplier, expiresAt: Date.now() + durationMs };
    await redisClient.hSet(`economy:${jid}`, field, JSON.stringify(boost));
    return boost;
}

async function getActiveBoost(redisClient, jid, field) {
    const raw = await redisClient.hGet(`economy:${jid}`, field);
    if (!raw) return null;
    const boost = JSON.parse(raw);
    if (Date.now() > boost.expiresAt) {
        await redisClient.hDel(`economy:${jid}`, field);
        return null;
    }
    return boost;
}

// ── Revive tokens ──
async function getReviveTokens(redisClient, jid) {
    const raw = await redisClient.hGet(`economy:${jid}`, 'revives');
    return raw ? parseInt(raw) : 0;
}

async function addReviveTokens(redisClient, jid, count) {
    const current = await getReviveTokens(redisClient, jid);
    const updated = current + count;
    await redisClient.hSet(`economy:${jid}`, 'revives', String(updated));
    return updated;
}

async function useReviveToken(redisClient, jid) {
    const current = await getReviveTokens(redisClient, jid);
    if (current <= 0) return false;
    await redisClient.hSet(`economy:${jid}`, 'revives', String(current - 1));
    return true;
}

// ── Equip helpers ──
async function equipItem(redisClient, jid, field, itemId) {
    await redisClient.hSet(`economy:${jid}`, field, itemId);
}

async function getEquipped(redisClient, jid, field) {
    return await redisClient.hGet(`economy:${jid}`, field);
}

// ── Lookup helpers ──
function findItem(catalog, id) {
    return catalog.find(i => i.id === id) || null;
}

module.exports = {
    XP_BOOSTERS,
    LUCK_BOOSTERS,
    REVIVE_TOKEN,
    TITLES,
    THEMES,
    getOwnedList,
    addToOwnedList,
    setBoost,
    getActiveBoost,
    getReviveTokens,
    addReviveTokens,
    useReviveToken,
    equipItem,
    getEquipped,
    findItem
};
