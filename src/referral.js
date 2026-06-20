// referral.js — Lady Liya Referral System
//
// Every user gets a stable referral code derived from their JID (stored
// in economy:<jid> → field "refCode"). New users redeem someone else's
// code ONCE with .useref <code>; both referrer and the new user get a
// coin/XP reward. Anti-abuse: no self-referral, one redemption per
// account ever, and a code can only belong to one user (reverse lookup
// stored under refcode:<CODE> -> jid).

const REFERRAL_REWARD_COINS = 300;
const REFERRAL_REWARD_XP = 30;
const NEW_USER_BONUS_COINS = 150;
const NEW_USER_BONUS_XP = 15;

// ── Generate a short, readable code from a JID (deterministic) ──
function generateCode(jid) {
    const num = jid.split('@')[0].split(':')[0];
    // Take last 6 digits of the phone number + a short hash-ish suffix
    // so codes aren't trivially guessable from sequential numbers alone.
    const tail = num.slice(-6);
    let hash = 0;
    for (const ch of num) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const suffix = (hash % 1296).toString(36).toUpperCase().padStart(2, '0'); // base36, 2 chars
    return `LIYA${tail}${suffix}`;
}

// ── Get (or lazily create) a user's referral code ──
async function getOrCreateCode(redisClient, jid) {
    const existing = await redisClient.hGet(`economy:${jid}`, 'refCode');
    if (existing) return existing;

    const code = generateCode(jid);
    await redisClient.hSet(`economy:${jid}`, 'refCode', code);
    await redisClient.set(`refcode:${code}`, jid);
    return code;
}

// ── Resolve a code back to the owning JID ──
async function resolveCode(redisClient, code) {
    return await redisClient.get(`refcode:${code.toUpperCase()}`);
}

// ── Has this jid already redeemed a referral code? ──
async function hasRedeemed(redisClient, jid) {
    const used = await redisClient.hGet(`economy:${jid}`, 'referredBy');
    return !!used;
}

// ── Redeem a referral code. Returns { error } or { success, referrerJid } ──
async function redeemCode(redisClient, code, newUserJid, newUserProfile) {
    const referrerJid = await resolveCode(redisClient, code);
    if (!referrerJid) {
        return { error: 'Invalid referral code.' };
    }

    if (referrerJid === newUserJid) {
        return { error: "You can't refer yourself." };
    }

    const alreadyUsed = await hasRedeemed(redisClient, newUserJid);
    if (alreadyUsed) {
        return { error: 'You have already redeemed a referral code.' };
    }

    // Guard against farming: only allow redemption for accounts that
    // haven't progressed yet (still at starting coins/level/xp).
    if (newUserProfile && (newUserProfile.level > 1 || newUserProfile.xp > 0)) {
        return { error: 'Referral codes can only be redeemed by new accounts.' };
    }

    await redisClient.hSet(`economy:${newUserJid}`, 'referredBy', referrerJid);
    await redisClient.sAdd(`referrals:${referrerJid}`, newUserJid);

    return { success: true, referrerJid };
}

// ── Get the list of jids someone has referred ──
async function getReferrals(redisClient, jid) {
    const members = await redisClient.sMembers(`referrals:${jid}`);
    return members || [];
}

async function getReferralCount(redisClient, jid) {
    return await redisClient.sCard(`referrals:${jid}`);
}

module.exports = {
    REFERRAL_REWARD_COINS,
    REFERRAL_REWARD_XP,
    NEW_USER_BONUS_COINS,
    NEW_USER_BONUS_XP,
    generateCode,
    getOrCreateCode,
    resolveCode,
    hasRedeemed,
    redeemCode,
    getReferrals,
    getReferralCount
};
