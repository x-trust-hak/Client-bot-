// premium.js — Lady Liya Premium System
//
// Storage layout in Redis:
//   premium:<jid>          → hash { expiry, grantedBy, grantedAt, tier, durationDays }
//   premium:list           → set of all JIDs that have/had premium
//
// Tiers: 'basic' | 'vip'  (you can add more later)
// expiry = Unix ms timestamp; 0 = never expires (lifetime)

const PREMIUM_TIERS = {
    basic: {
        name: 'Basic Premium',
        badge: '⭐',
        color: '🟡',
        dailyBonus: 2500,       // vs 1000 for free
        weeklyBonus: 20000,     // vs 7000
        workCooldownMs: 30 * 60 * 1000,  // 30min vs 1h
        xpMultiplier: 1.5,
        coinMultiplier: 1.5
    },
    vip: {
        name: 'VIP Premium',
        badge: '💎',
        color: '🔵',
        dailyBonus: 5000,
        weeklyBonus: 40000,
        workCooldownMs: 15 * 60 * 1000,  // 15min
        xpMultiplier: 2,
        coinMultiplier: 2
    }
};

const DEFAULT_TIER = 'basic';

// ── Check if a user has active premium ──
// Returns the premium data object if active, null if not.
async function getPremium(redisClient, jid) {
    try {
        const data = await redisClient.hGetAll(`premium:${jid}`);
        if (!data || !data.expiry) return null;

        const expiry = parseInt(data.expiry);
        // 0 = lifetime, never expires
        if (expiry !== 0 && Date.now() > expiry) {
            // Expired — clean up silently
            await redisClient.del(`premium:${jid}`);
            return null;
        }

        const tier = PREMIUM_TIERS[data.tier] ? data.tier : DEFAULT_TIER;
        return {
            tier,
            tierData: PREMIUM_TIERS[tier],
            expiry,
            grantedBy: data.grantedBy || 'system',
            grantedAt: parseInt(data.grantedAt || 0),
            durationDays: parseInt(data.durationDays || 0),
            isLifetime: expiry === 0
        };
    } catch (err) {
        console.error('getPremium error:', err.message);
        return null;
    }
}

// ── Check if premium is active (boolean shorthand) ──
async function isPremium(redisClient, jid) {
    return (await getPremium(redisClient, jid)) !== null;
}

// ── Get the tier config for a user (or null if not premium) ──
async function getPremiumTier(redisClient, jid) {
    const p = await getPremium(redisClient, jid);
    return p ? p.tierData : null;
}

// ── Grant premium to a user ──
async function grantPremium(redisClient, jid, durationDays, grantedBy, tier = DEFAULT_TIER) {
    const now = Date.now();
    const expiry = durationDays === 0 ? 0 : now + durationDays * 24 * 60 * 60 * 1000;

    // If they already have premium, EXTEND it rather than reset from today
    const existing = await getPremium(redisClient, jid);
    let finalExpiry = expiry;
    if (existing && existing.expiry !== 0 && expiry !== 0) {
        finalExpiry = Math.max(existing.expiry, now) + durationDays * 24 * 60 * 60 * 1000;
    }

    await redisClient.hSet(`premium:${jid}`, {
        expiry: String(finalExpiry),
        grantedBy,
        grantedAt: String(now),
        tier: PREMIUM_TIERS[tier] ? tier : DEFAULT_TIER,
        durationDays: String(durationDays)
    });
    await redisClient.sAdd('premium:list', jid);
    return finalExpiry;
}

// ── Revoke premium ──
async function revokePremium(redisClient, jid) {
    const existed = await redisClient.exists(`premium:${jid}`);
    await redisClient.del(`premium:${jid}`);
    return existed > 0;
}

// ── List all currently active premium users ──
async function listPremium(redisClient) {
    try {
        const allJids = await redisClient.sMembers('premium:list');
        const active = [];
        for (const jid of allJids) {
            const p = await getPremium(redisClient, jid);
            if (p) active.push({ jid, ...p });
        }
        return active;
    } catch (err) {
        console.error('listPremium error:', err.message);
        return [];
    }
}

// ── Format expiry as a human-readable string ──
function formatExpiry(expiry) {
    if (expiry === 0) return 'Never (Lifetime)';
    const remaining = expiry - Date.now();
    if (remaining <= 0) return 'Expired';
    const days = Math.floor(remaining / (1000 * 60 * 60 * 24));
    const hours = Math.floor((remaining % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    if (days > 0) return `${days}d ${hours}h remaining`;
    return `${hours}h remaining`;
}

module.exports = {
    PREMIUM_TIERS,
    DEFAULT_TIER,
    getPremium,
    isPremium,
    getPremiumTier,
    grantPremium,
    revokePremium,
    listPremium,
    formatExpiry
};
