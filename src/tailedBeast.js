// src/tailedBeast.js
// Tailed Beast / Jinchuriki System
//
// CANON ACCURACY:
// — Only Jinchuriki characters can transform (Naruto, Gaara, Killer Bee)
// — Transformation triggers automatically when HP drops below 20%
//   (canon: beast takes over when host is near death)
// — Manual Chakra Mode: costs high chakra, massive stat surge for 2 turns
//   then chakra CRASH (lose 50% current chakra) — exactly like the show
// — Each beast has unique effects tied to canon abilities
// — After Chakra Mode ends, character is WEAKENED for 1 turn (canon exhaustion)
// — Transformation state is tracked IN the fight object, never persisted to DB

// ─── BIJUU DATA ──────────────────────────────────────────────────────────────
const BIJUU = {
    // Naruto — Kurama (Nine-Tails)
    naruto: {
        id: 'kurama',
        name: 'Kurama',
        title: 'Nine-Tails Fox',
        emoji: '🦊',
        tails: 9,
        // V1 cloak: auto-triggers at <20% HP
        v1: {
            label: '🦊 NINE-TAILS CLOAK (V1)',
            hpRestore: 0.3,         // restore 30% max HP on trigger
            attackMult: 1.5,
            defenseMult: 1.3,
            speedMult: 1.2,
            passiveHealPerTurn: 80,  // dark chakra regeneration
            desc: 'Kurama\'s dark chakra floods Naruto\'s body — raw destructive power!',
        },
        // Chakra Mode: !beast or !bijuu command
        chakraMode: {
            label: '☀️ KURAMA CHAKRA MODE',
            cost: 200,               // chakra cost to activate
            turns: 3,                // lasts 3 turns
            attackBonus: 120,        // flat stat bonus (stacks on top of effective stats)
            defenseBonus: 80,
            speedBonus: 60,
            crashPct: 0.5,           // lose 50% current chakra after mode ends
            weakenTurns: 1,          // exhaustion turns after mode
            specialMove: {
                name: 'Tailed Beast Bomb',
                damage: 600,
                nature: null,
                desc: 'Pure bijuu chakra compressed into a sphere — devastating',
                cost: 0,             // free during Chakra Mode
            },
            desc: 'Naruto harmonizes with Kurama — transcendent power for 3 turns!',
        },
        transformMsg: [
            '🦊 *"You called?"* — Kurama\'s chakra surges through Naruto!',
            '🦊 _Kurama: "Don\'t die on me, idiot."_',
            '🦊 _The Nine-Tails cloak manifests — raw power beyond human limits!_',
        ],
    },

    // Gaara — Shukaku (One-Tail)
    gaara: {
        id: 'shukaku',
        name: 'Shukaku',
        title: 'One-Tail Tanuki',
        emoji: '🏜️',
        tails: 1,
        v1: {
            label: '🏜️ SHUKAKU SAND ARMOR',
            hpRestore: 0.25,
            attackMult: 1.3,
            defenseMult: 2.0,        // Shukaku is a tank — defense skyrockets
            speedMult: 0.9,
            passiveHealPerTurn: 0,
            passiveSandShield: true,  // negates next attack completely (unique to Gaara)
            desc: 'Shukaku\'s sand manifests as impenetrable armor — ultimate defense!',
        },
        chakraMode: {
            label: '🌪️ SHUKAKU PARTIAL TRANSFORMATION',
            cost: 180,
            turns: 2,
            attackBonus: 80,
            defenseBonus: 150,       // extreme defense
            speedBonus: 20,
            crashPct: 0.4,
            weakenTurns: 1,
            specialMove: {
                name: 'Sand Tsunami',
                damage: 500,
                nature: 'earth',
                desc: 'A wall of sand crushes everything in its path',
                cost: 0,
            },
            desc: 'Gaara partially transforms — Shukaku\'s form emerges!',
        },
        transformMsg: [
            '🏜️ _Shukaku howls — the sand rises without command!_',
            '🏜️ *"The sand will bury you."* — Gaara\'s eyes go cold.',
            '🏜️ _Absolute defense. Absolute will. Shukaku and Gaara as one._',
        ],
    },

    // Killer Bee — Gyuki (Eight-Tails)
    killer_bee: {
        id: 'gyuki',
        name: 'Gyuki',
        title: 'Eight-Tails Ox-Octopus',
        emoji: '🐂',
        tails: 8,
        v1: {
            label: '🐂 GYUKI SURGE MODE',
            hpRestore: 0.35,
            attackMult: 1.6,
            defenseMult: 1.4,
            speedMult: 1.3,
            passiveHealPerTurn: 60,
            inkBarrage: true,         // unique: each turn has 30% to shoot ink (stun)
            desc: 'Gyuki\'s power flows — eight-tails ink and raw strength!',
        },
        chakraMode: {
            label: '⚡ EIGHT-TAILS FULL TRANSFORMATION',
            cost: 190,
            turns: 3,
            attackBonus: 130,
            defenseBonus: 90,
            speedBonus: 70,
            crashPct: 0.45,
            weakenTurns: 1,
            specialMove: {
                name: 'Bijuudama — Gyuki',
                damage: 580,
                nature: 'lightning',
                desc: 'Eight-Tails fires a colossal Tailed Beast Bomb',
                cost: 0,
            },
            desc: 'Bee and Gyuki synchronize — the perfect Jinchuriki form!',
        },
        transformMsg: [
            '🐂 _Gyuki: "Yo, Bee! Let\'s show \'em what we got!"_',
            '🐂 *"YEAH! Eight-Tails transformation — let\'s GO!"* 🎤',
            '🐂 _Tentacles erupt from Bee\'s back — Gyuki has arrived!_',
        ],
    },
};

// ─── JINCHURIKI CHECK ────────────────────────────────────────────────────────
const JINCHURIKI_CHARS = Object.keys(BIJUU);

function isJinchuriki(characterId) {
    return JINCHURIKI_CHARS.includes(characterId);
}

function getBijuu(characterId) {
    return BIJUU[characterId] || null;
}

// ─── TRANSFORMATION STATE ────────────────────────────────────────────────────
// Stored inside fight.bijuuState:
// {
//   active: bool,          — V1 cloak active
//   chakraMode: bool,      — Chakra Mode active
//   chakraModeTurns: N,    — turns remaining in Chakra Mode
//   sandShieldActive: bool,— Gaara's one-time negate
//   weakened: bool,        — post-Chakra-Mode exhaustion
//   weakenTurns: N,        — exhaustion turns remaining
//   specialUsed: bool,     — beast bomb used this mode
// }

function initBijuuState() {
    return {
        active: false,
        chakraMode: false,
        chakraModeTurns: 0,
        sandShieldActive: false,
        weakened: false,
        weakenTurns: 0,
        specialUsed: false,
    };
}

// ─── AUTO-TRANSFORM CHECK ────────────────────────────────────────────────────
// Call this after enemy deals damage. Returns { triggered, msg } if V1 fires.
function checkAutoTransform(user, fight) {
    const bijuu = getBijuu(user.character);
    if (!bijuu) return { triggered: false };
    if (fight.bijuuState.active || fight.bijuuState.chakraMode) return { triggered: false };

    const hpPct = user.hp.current / user.hp.max;
    if (hpPct > 0.20) return { triggered: false };

    // Trigger V1 cloak
    fight.bijuuState.active = true;
    const v1 = bijuu.v1;

    // Restore HP
    const hpGain = Math.round(user.hp.max * v1.hpRestore);
    user.hp.current = Math.min(user.hp.max, user.hp.current + hpGain);

    // Gaara sand shield
    if (v1.passiveSandShield) fight.bijuuState.sandShieldActive = true;

    const flavorMsg = bijuu.transformMsg[Math.floor(Math.random() * bijuu.transformMsg.length)];
    const msg =
        `\n🌀 ━━━━━━━━━━━━━━━━━━━━\n` +
        `${bijuu.emoji} *${v1.label}!*\n` +
        `${flavorMsg}\n` +
        `💚 +${hpGain} HP restored by bijuu chakra!\n` +
        `_(${bijuu.name} grants: ATK ×${v1.attackMult} | DEF ×${v1.defenseMult} | SPD ×${v1.speedMult})_\n` +
        (v1.passiveSandShield ? `🛡️ Sand Shield active — next attack NEGATED!\n` : '') +
        `🌀 ━━━━━━━━━━━━━━━━━━━━\n`;

    return { triggered: true, msg };
}

// ─── APPLY BIJUU STAT BOOSTS ─────────────────────────────────────────────────
// Called in the battle loop to modify effective stats when beast is active.
// Mutates a copy of ps — doesn't touch the original getEffectiveStats result.
function applyBijuuStats(ps, bijuu, bijuuState) {
    if (!bijuuState.active && !bijuuState.chakraMode) return ps;

    const boosted = { ...ps };

    if (bijuuState.active) {
        const v1 = bijuu.v1;
        boosted.attack  = Math.round(ps.attack  * v1.attackMult);
        boosted.defense = Math.round(ps.defense * v1.defenseMult);
        boosted.speed   = Math.round(ps.speed   * v1.speedMult);
    }

    if (bijuuState.chakraMode) {
        const cm = bijuu.chakraMode;
        boosted.attack  += cm.attackBonus;
        boosted.defense += cm.defenseBonus;
        boosted.speed   += cm.speedBonus;
    }

    // Exhaustion debuff after Chakra Mode
    if (bijuuState.weakened) {
        boosted.attack  = Math.round(boosted.attack  * 0.6);
        boosted.defense = Math.round(boosted.defense * 0.6);
    }

    return boosted;
}

// ─── PASSIVE PER-TURN EFFECTS ────────────────────────────────────────────────
// Called each round for V1 cloak effects. Returns a log string.
function tickBijuuPassive(user, fight, bijuu) {
    if (!fight.bijuuState.active) return '';
    const v1 = bijuu.v1;
    let log = '';

    // Passive heal
    if (v1.passiveHealPerTurn > 0) {
        const healed = Math.min(v1.passiveHealPerTurn, user.hp.max - user.hp.current);
        if (healed > 0) {
            user.hp.current += healed;
            log += `${bijuu.emoji} ${bijuu.name}'s chakra: 💚 +${healed} HP regenerated\n`;
        }
    }

    // Gyuki ink barrage — 30% stun chance
    if (v1.inkBarrage && Math.random() < 0.30) {
        fight.effects.enemy = fight.effects.enemy || {};
        fight.effects.enemy.stunTurns = (fight.effects.enemy.stunTurns || 0) + 1;
        log += `🐂 Gyuki fires ink barrage — enemy is stunned!\n`;
    }

    return log;
}

// ─── CHAKRA MODE ACTIVATION ──────────────────────────────────────────────────
// Returns { success, msg } — call this when player types !beast or !bijuu
function activateChakraMode(user, fight, bijuu) {
    const cm = bijuu.chakraMode;

    if (fight.bijuuState.chakraMode) {
        return { success: false, msg: `⚡ ${cm.label} is already active! (${fight.bijuuState.chakraModeTurns} turns left)` };
    }
    if (user.chakra.current < cm.cost) {
        return { success: false, msg: `❌ Need ${cm.cost} Chakra for ${cm.label}. (Have ${user.chakra.current})` };
    }

    user.chakra.current -= cm.cost;
    fight.bijuuState.chakraMode = true;
    fight.bijuuState.chakraModeTurns = cm.turns;
    fight.bijuuState.specialUsed = false;
    // V1 also activates if not already
    fight.bijuuState.active = true;

    const msg =
        `\n⚡ ━━━━━━━━━━━━━━━━━━━━\n` +
        `${bijuu.emoji} *${cm.label}!*\n` +
        `_${cm.desc}_\n` +
        `💧 -${cm.cost} Chakra\n` +
        `📈 ATK +${cm.attackBonus} | DEF +${cm.defenseBonus} | SPD +${cm.speedBonus}\n` +
        `⏱️ Lasts ${cm.turns} turns — then chakra crash!\n` +
        `⚡ ━━━━━━━━━━━━━━━━━━━━\n`;

    return { success: true, msg };
}

// ─── CHAKRA MODE TICK ─────────────────────────────────────────────────────────
// Call at end of each round when chakraMode is active.
// Returns { ended, crashMsg } if mode expires this round.
function tickChakraMode(user, fight, bijuu) {
    if (!fight.bijuuState.chakraMode) return { ended: false };

    fight.bijuuState.chakraModeTurns--;

    if (fight.bijuuState.chakraModeTurns <= 0) {
        fight.bijuuState.chakraMode = false;

        // Chakra crash
        const cm = bijuu.chakraMode;
        const crashed = Math.round(user.chakra.current * cm.crashPct);
        user.chakra.current = Math.max(0, user.chakra.current - crashed);

        // Enter exhaustion
        fight.bijuuState.weakened = true;
        fight.bijuuState.weakenTurns = cm.weakenTurns;

        const crashMsg =
            `\n💥 *${bijuu.chakraMode?.label || 'CHAKRA MODE'} EXPIRED!*\n` +
            `⚡ Chakra Crash — -${crashed} Chakra!\n` +
            `😰 ${user.username} is exhausted — stats reduced for ${cm.weakenTurns} turn!\n`;

        return { ended: true, crashMsg };
    }

    return {
        ended: false,
        remainMsg: `${bijuu.emoji} ${bijuu.chakraMode?.label || 'Chakra Mode'}: ${fight.bijuuState.chakraModeTurns} turn${fight.bijuuState.chakraModeTurns !== 1 ? 's' : ''} remaining\n`,
    };
}

// ─── TICK EXHAUSTION ─────────────────────────────────────────────────────────
function tickExhaustion(fight) {
    if (!fight.bijuuState.weakened) return;
    fight.bijuuState.weakenTurns--;
    if (fight.bijuuState.weakenTurns <= 0) {
        fight.bijuuState.weakened = false;
    }
}

// ─── BEAST BOMB (SPECIAL MOVE) ───────────────────────────────────────────────
// Available only during Chakra Mode, once per activation.
function useBeastBomb(bijuu, fight) {
    if (!fight.bijuuState.chakraMode) {
        return { success: false, msg: `❌ Beast Bomb requires Chakra Mode to be active! (!beast to activate)` };
    }
    if (fight.bijuuState.specialUsed) {
        return { success: false, msg: `❌ Tailed Beast Bomb already used this Chakra Mode.` };
    }
    fight.bijuuState.specialUsed = true;
    return { success: true, move: bijuu.chakraMode.specialMove };
}

// ─── SAND SHIELD (GAARA) ─────────────────────────────────────────────────────
// Called before enemy damage is applied. Returns true if damage is negated.
function checkSandShield(fight) {
    if (!fight.bijuuState?.sandShieldActive) return false;
    fight.bijuuState.sandShieldActive = false;
    return true;
}

// ─── STATUS TEXT FOR PROFILE / BATTLE SCREEN ─────────────────────────────────
function bijuuStatusLine(characterId, bijuuState) {
    if (!bijuuState?.active && !bijuuState?.chakraMode) return '';
    const bijuu = getBijuu(characterId);
    if (!bijuu) return '';
    if (bijuuState.chakraMode) return `${bijuu.emoji} ${bijuu.chakraMode.label} (${bijuuState.chakraModeTurns} turns)`;
    if (bijuuState.active) return `${bijuu.emoji} ${bijuu.v1.label}`;
    return '';
}

module.exports = {
    BIJUU,
    JINCHURIKI_CHARS,
    isJinchuriki,
    getBijuu,
    initBijuuState,
    checkAutoTransform,
    applyBijuuStats,
    tickBijuuPassive,
    activateChakraMode,
    tickChakraMode,
    tickExhaustion,
    useBeastBomb,
    checkSandShield,
    bijuuStatusLine,
};
