// rpg.js — Lady Liya RPG Extension
// Fishing, Mining, Farming, Hunting, Pets
// All data stored in Redis under economy:<jid> hash as JSON fields

const { getProfile, updateProfile, addCoins, addXp, formatCoins, cooldownRemaining, formatDuration } = require('./economy');

// ══════════════════════════════════════════════════════════
// FISHING
// ══════════════════════════════════════════════════════════
const FISH = [
    { name: 'Old Boot', emoji: '👢', rarity: 'junk',      value: 0,    weight: 15 },
    { name: 'Sardine',  emoji: '🐟', rarity: 'common',    value: 50,   weight: 30 },
    { name: 'Catfish',  emoji: '🐠', rarity: 'common',    value: 80,   weight: 25 },
    { name: 'Salmon',   emoji: '🐡', rarity: 'uncommon',  value: 150,  weight: 15 },
    { name: 'Tuna',     emoji: '🦈', rarity: 'rare',      value: 350,  weight: 8  },
    { name: 'Swordfish',emoji: '⚔️', rarity: 'rare',      value: 500,  weight: 4  },
    { name: 'Manta Ray',emoji: '🌊', rarity: 'epic',      value: 1200, weight: 2  },
    { name: 'Kraken',   emoji: '🦑', rarity: 'legendary', value: 5000, weight: 1  },
];

const RODS = {
    basic:    { name: 'Basic Rod',    bonus: 0,   price: 0 },
    iron:     { name: 'Iron Rod',     bonus: 0.2, price: 500 },
    golden:   { name: 'Golden Rod',   bonus: 0.5, price: 2000 },
    legendary:{ name: 'Legendary Rod',bonus: 1.0, price: 8000 },
};

function pickFish(rodBonus = 0) {
    // Higher bonus = higher weight shift toward rare fish
    const adjusted = FISH.map((f, i) => ({
        ...f,
        w: Math.max(1, f.weight - (i >= 4 ? 0 : Math.floor(rodBonus * 5)))
    }));
    const total = adjusted.reduce((s, f) => s + f.w, 0);
    let r = Math.random() * total;
    for (const f of adjusted) { r -= f.w; if (r <= 0) return f; }
    return FISH[1];
}

// ══════════════════════════════════════════════════════════
// MINING
// ══════════════════════════════════════════════════════════
const ORES = [
    { name: 'Stone',    emoji: '🪨', rarity: 'common',    value: 10,   weight: 35 },
    { name: 'Coal',     emoji: '⬛', rarity: 'common',    value: 30,   weight: 25 },
    { name: 'Iron',     emoji: '🔩', rarity: 'uncommon',  value: 80,   weight: 20 },
    { name: 'Gold',     emoji: '🥇', rarity: 'rare',      value: 200,  weight: 10 },
    { name: 'Diamond',  emoji: '💎', rarity: 'rare',      value: 500,  weight: 6  },
    { name: 'Emerald',  emoji: '💚', rarity: 'epic',      value: 1000, weight: 3  },
    { name: 'Mythic',   emoji: '🌟', rarity: 'legendary', value: 4000, weight: 1  },
];

const PICKS = {
    wooden: { name: 'Wooden Pickaxe',  bonus: 0,   price: 0 },
    stone:  { name: 'Stone Pickaxe',   bonus: 0.2, price: 300 },
    iron:   { name: 'Iron Pickaxe',    bonus: 0.5, price: 1200 },
    diamond:{ name: 'Diamond Pickaxe', bonus: 1.0, price: 5000 },
};

function pickOre(pickBonus = 0) {
    const adjusted = ORES.map((o, i) => ({
        ...o,
        w: Math.max(1, o.weight - (i >= 3 ? 0 : Math.floor(pickBonus * 4)))
    }));
    const total = adjusted.reduce((s, o) => s + o.w, 0);
    let r = Math.random() * total;
    for (const o of adjusted) { r -= o.w; if (r <= 0) return o; }
    return ORES[0];
}

// ══════════════════════════════════════════════════════════
// FARMING
// ══════════════════════════════════════════════════════════
const CROPS = [
    { name: 'Wheat',     emoji: '🌾', growMs: 10 * 60 * 1000,  cost: 50,   value: 120  },
    { name: 'Corn',      emoji: '🌽', growMs: 30 * 60 * 1000,  cost: 100,  value: 300  },
    { name: 'Carrot',    emoji: '🥕', growMs: 60 * 60 * 1000,  cost: 200,  value: 600  },
    { name: 'Watermelon',emoji: '🍉', growMs: 3 * 60 * 60 * 1000, cost: 500, value: 1800 },
    { name: 'Golden Apple',emoji: '🍎', growMs: 8 * 60 * 60 * 1000, cost: 1500, value: 6000 },
];

// ══════════════════════════════════════════════════════════
// PETS
// ══════════════════════════════════════════════════════════
const PETS = [
    { id: 'cat',     name: 'Cat',     emoji: '🐱', price: 500,  xpBonus: 0.1 },
    { id: 'dog',     name: 'Dog',     emoji: '🐶', price: 600,  xpBonus: 0.1 },
    { id: 'rabbit',  name: 'Rabbit',  emoji: '🐰', price: 800,  xpBonus: 0.15 },
    { id: 'fox',     name: 'Fox',     emoji: '🦊', price: 1500, xpBonus: 0.2 },
    { id: 'dragon',  name: 'Dragon',  emoji: '🐉', price: 10000, xpBonus: 0.5 },
];

// ══════════════════════════════════════════════════════════
// HUNTING
// ══════════════════════════════════════════════════════════
const ANIMALS = [
    { name: 'Rabbit',   emoji: '🐰', value: 100,  weight: 30 },
    { name: 'Fox',      emoji: '🦊', value: 250,  weight: 25 },
    { name: 'Deer',     emoji: '🦌', value: 500,  weight: 20 },
    { name: 'Boar',     emoji: '🐗', value: 800,  weight: 15 },
    { name: 'Bear',     emoji: '🐻', value: 2000, weight: 7  },
    { name: 'Dragon',   emoji: '🐉', value: 8000, weight: 2  },
    { name: 'Nothing',  emoji: '🌿', value: 0,    weight: 20 },
];

function pickAnimal() {
    const total = ANIMALS.reduce((s, a) => s + a.weight, 0);
    let r = Math.random() * total;
    for (const a of ANIMALS) { r -= a.weight; if (r <= 0) return a; }
    return ANIMALS[ANIMALS.length - 1];
}

// ══════════════════════════════════════════════════════════
// INVENTORY HELPERS
// ══════════════════════════════════════════════════════════
async function getInventory(redisClient, jid) {
    try {
        const raw = await redisClient.hGet(`economy:${jid}`, 'inventory');
        return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
}

async function setInventory(redisClient, jid, inv) {
    await redisClient.hSet(`economy:${jid}`, 'inventory', JSON.stringify(inv));
}

async function addToInventory(redisClient, jid, key, amount = 1) {
    const inv = await getInventory(redisClient, jid);
    inv[key] = (inv[key] || 0) + amount;
    await setInventory(redisClient, jid, inv);
    return inv;
}

async function removeFromInventory(redisClient, jid, key, amount = 1) {
    const inv = await getInventory(redisClient, jid);
    if (!inv[key] || inv[key] < amount) return false;
    inv[key] -= amount;
    if (inv[key] <= 0) delete inv[key];
    await setInventory(redisClient, jid, inv);
    return true;
}

module.exports = {
    FISH, RODS, ORES, PICKS, CROPS, PETS, ANIMALS,
    pickFish, pickOre, pickAnimal,
    getInventory, setInventory, addToInventory, removeFromInventory
};
