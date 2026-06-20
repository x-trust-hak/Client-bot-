// badges.js — Lady Liya Badge System
//
// Badges are stored in Redis under: economy:<jid> → field "badges"
// as a JSON array of badge IDs, e.g. ["early_bird","level_10","married"]
//
// Badges are awarded automatically (checkAutoBadges) after key economy
// events: leveling up, marrying, creating a guild, etc. Each badge has
// a `check(profile, context)` function that returns true if the user
// qualifies. context carries event-specific extras (e.g. guild data)
// that aren't on the economy profile itself.

const BADGE_TABLE = [
    {
        id: 'level_5',
        name: 'Rising Star',
        emoji: '🌟',
        description: 'Reach Level 5',
        check: (profile) => profile.level >= 5
    },
    {
        id: 'level_10',
        name: 'Veteran',
        emoji: '🎖️',
        description: 'Reach Level 10',
        check: (profile) => profile.level >= 10
    },
    {
        id: 'level_25',
        name: 'Elite',
        emoji: '🏅',
        description: 'Reach Level 25',
        check: (profile) => profile.level >= 25
    },
    {
        id: 'level_50',
        name: 'Legend',
        emoji: '👑',
        description: 'Reach Level 50',
        check: (profile) => profile.level >= 50
    },
    {
        id: 'married',
        name: 'Soulmate',
        emoji: '💍',
        description: 'Get married',
        check: (profile) => !!profile.married
    },
    {
        id: 'guild_founder',
        name: 'Guild Founder',
        emoji: '🏰',
        description: 'Create a guild',
        check: (profile, ctx) => !!ctx?.createdGuild
    },
    {
        id: 'guild_leader',
        name: 'Guild Leader',
        emoji: '🛡️',
        description: 'Lead a guild with 5+ members',
        check: (profile, ctx) => !!ctx?.guild && Array.isArray(ctx.guild.members) && ctx.guild.members.length >= 5
    },
    {
        id: 'rich',
        name: 'High Roller',
        emoji: '💰',
        description: 'Hold 100,000+ coins',
        check: (profile) => (profile.coins + profile.bank) >= 100000
    },
    {
        id: 'duelist',
        name: 'Duelist',
        emoji: '⚔️',
        description: 'Win 10 PvP duels',
        check: (profile) => profile.wins >= 10
    },
    {
        id: 'recruiter',
        name: 'Recruiter',
        emoji: '📣',
        description: 'Refer 5 friends',
        check: (profile, ctx) => (ctx?.referralCount ?? 0) >= 5
    },
    {
        id: 'super_recruiter',
        name: 'Super Recruiter',
        emoji: '📢',
        description: 'Refer 20 friends',
        check: (profile, ctx) => (ctx?.referralCount ?? 0) >= 20
    }
];

// ── Get a user's current badge list ──
async function getBadges(redisClient, jid) {
    try {
        const raw = await redisClient.hGet(`economy:${jid}`, 'badges');
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

// ── Save a user's badge list ──
async function saveBadges(redisClient, jid, badgeIds) {
    await redisClient.hSet(`economy:${jid}`, 'badges', JSON.stringify(badgeIds));
}

// ── Award a single badge if not already owned. Returns true if newly awarded ──
async function awardBadge(redisClient, jid, badgeId) {
    const owned = await getBadges(redisClient, jid);
    if (owned.includes(badgeId)) return false;
    owned.push(badgeId);
    await saveBadges(redisClient, jid, owned);
    return true;
}

// ── Check all badge conditions against a profile + optional context,
//    award any newly-qualified badges, and return the list of badges
//    that were just unlocked (for notifying the user in chat). ──
async function checkAutoBadges(redisClient, jid, profile, ctx = {}) {
    const owned = await getBadges(redisClient, jid);
    const newlyUnlocked = [];

    for (const badge of BADGE_TABLE) {
        if (owned.includes(badge.id)) continue;
        try {
            if (badge.check(profile, ctx)) {
                owned.push(badge.id);
                newlyUnlocked.push(badge);
            }
        } catch (err) {
            console.error(`checkAutoBadges error on badge "${badge.id}":`, err.message);
        }
    }

    if (newlyUnlocked.length > 0) {
        await saveBadges(redisClient, jid, owned);
    }

    return newlyUnlocked;
}

// ── Build a chat-ready announcement string for newly unlocked badges ──
function formatBadgeUnlocks(jid, badges) {
    if (!badges.length) return null;
    const lines = badges.map(b => `${b.emoji} *${b.name}* — ${b.description}`);
    return `🏆 @${jid.split('@')[0]} unlocked a new badge!\n\n${lines.join('\n')}`;
}

// ── Lookup helper for displaying a badge by id ──
function getBadgeDef(badgeId) {
    return BADGE_TABLE.find(b => b.id === badgeId) || null;
}

module.exports = {
    BADGE_TABLE,
    getBadges,
    saveBadges,
    awardBadge,
    checkAutoBadges,
    formatBadgeUnlocks,
    getBadgeDef
};
