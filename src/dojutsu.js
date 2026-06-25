// src/dojutsu.js
// Dojutsu Eye Technique System — Sharingan, Byakugan, Rinnegan
//
// CANON ACCURACY:
// — Each eye activates passively at the START of battle (always open)
// — Effects trigger mid-battle based on specific conditions per canon:
//     Sharingan: copies the LAST jutsu the enemy used and can cast it back
//     Byakugan:  reveals EXACT enemy HP always + can seal a chakra point (chakra drain)
//     Rinnegan:  absorbs one jutsu per battle (negates damage, restores chakra)
// — Active abilities cost chakra and must be explicitly used with !dojutsu
// — State tracked inside fight.dojutsuState — never persisted to DB

// ─── DOJUTSU REGISTRY ────────────────────────────────────────────────────────
// keyed by character ID
const DOJUTSU = {

    // ── SHARINGAN ─────────────────────────────────────────────────────────────
    // Characters: sasuke, itachi, kakashi, obito, shisui (gacha)
    sasuke: {
        eye: 'sharingan',
        name: 'Sharingan',
        tier: 'Mangekyou',           // Sasuke has Mangekyou
        emoji: '🔴',
        // Passive — always active in battle
        passive: {
            dodgeBonus: 20,           // +20% flat dodge on top of speed-based dodge
            critBonus: 10,            // +10% crit chance
            desc: '🔴 Sharingan active — 20% bonus dodge, 10% bonus crit',
        },
        // Copy jutsu — triggered when Sharingan records an enemy move
        copyAbility: {
            name: 'Sharingan Copy',
            desc: 'Copy the last enemy jutsu and use it back',
            costMult: 0.8,            // costs 80% of copied jutsu's chakra
            damageMult: 1.1,          // deals 110% of original damage
            maxCopiesPerBattle: 2,
        },
        // Mangekyou — Susano'o / Amaterasu / Tsukuyomi accessed via !dojutsu
        mangekyou: [
            {
                id: 'ms_amaterasu',
                name: 'Amaterasu',
                cost: 90,
                damage: 280,
                nature: 'fire',
                pp: 2,
                desc: 'Black flames that cannot be extinguished — burn forever',
                dot: { damage: 40, turns: 2, label: '🔥 Amaterasu DoT' },
            },
            {
                id: 'ms_tsukuyomi',
                name: 'Tsukuyomi',
                cost: 80,
                damage: 0,
                nature: null,
                pp: 2,
                buff: { stun: 3 },
                desc: 'Trap the enemy in 72 hours of mental torture — 3-turn stun',
            },
            {
                id: 'ms_susanoo',
                name: "Perfect Susano'o",
                cost: 130,
                damage: 350,
                nature: null,
                pp: 1,
                desc: 'Full armored Susano'o — the pinnacle of Uchiha power',
                selfBuff: { defense: 120, turns: 2 },
            },
        ],
    },

    itachi: {
        eye: 'sharingan',
        name: 'Sharingan',
        tier: 'Mangekyou',
        emoji: '🌑',
        passive: {
            dodgeBonus: 25,           // Itachi is faster at reading attacks
            critBonus: 8,
            genjutsuPassive: true,    // 25% per hit to auto-apply Genjutsu stun
            desc: '🌑 Mangekyou active — 25% dodge bonus, Genjutsu triggers on hit',
        },
        copyAbility: {
            name: 'Sharingan Copy',
            desc: 'Copy the last enemy jutsu',
            costMult: 0.7,
            damageMult: 1.15,
            maxCopiesPerBattle: 3,    // Itachi has more refined Sharingan
        },
        mangekyou: [
            {
                id: 'itachi_ama',
                name: 'Amaterasu',
                cost: 80,
                damage: 250,
                nature: 'fire',
                pp: 3,
                desc: 'Black eternal flames — burn through any defense',
                dot: { damage: 50, turns: 3, label: '🔥 Amaterasu DoT' },
            },
            {
                id: 'itachi_tsuki',
                name: 'Tsukuyomi',
                cost: 70,
                damage: 0,
                nature: null,
                pp: 3,
                buff: { stun: 2 },
                desc: '72 hours of torment — 2-turn stun',
            },
            {
                id: 'totsuka',
                name: "Totsuka Blade — Susano'o",
                cost: 120,
                damage: 320,
                nature: null,
                pp: 1,
                desc: 'Ethereal blade that seals anything it pierces',
                sealEffect: true,     // seals enemy — prevents all jutsus for 2 turns
            },
        ],
    },

    kakashi: {
        eye: 'sharingan',
        name: 'Sharingan',
        tier: 'Mangekyou',
        emoji: '👁️',
        passive: {
            dodgeBonus: 15,
            critBonus: 12,
            copyOnFirstHit: true,     // Kakashi auto-copies the very first jutsu used on him
            desc: '👁️ Sharingan active — auto-copies first enemy jutsu, 15% dodge bonus',
        },
        copyAbility: {
            name: 'Sharingan Copy',
            desc: 'Copy the last enemy jutsu (Kakashi mastered 1000 jutsu this way)',
            costMult: 0.75,
            damageMult: 1.2,
            maxCopiesPerBattle: 3,
        },
        mangekyou: [
            {
                id: 'kamui_lightning',
                name: 'Kamui — Lightning Blade',
                cost: 85,
                damage: 300,
                nature: 'lightning',
                pp: 2,
                desc: 'Warp the Chidori through dimensions — undodgeable',
                undodgeable: true,
            },
            {
                id: 'kamui_warp',
                name: 'Kamui Warp',
                cost: 70,
                damage: 0,
                nature: null,
                pp: 3,
                buff: { evasion: 60 },
                desc: 'Phase into another dimension — near-perfect evasion for 1 turn',
            },
        ],
    },

    obito: {
        eye: 'sharingan',
        name: 'Sharingan',
        tier: 'Mangekyou',
        emoji: '🌀',
        passive: {
            dodgeBonus: 20,
            critBonus: 8,
            intangible: true,         // 20% to phase through any attack (Obito's Kamui)
            desc: '🌀 Kamui active — 20% intangibility, can phase through attacks',
        },
        copyAbility: {
            name: 'Sharingan Copy',
            desc: 'Copy the last enemy jutsu',
            costMult: 0.8,
            damageMult: 1.05,
            maxCopiesPerBattle: 2,
        },
        mangekyou: [
            {
                id: 'obito_kamui',
                name: 'Kamui Dimension Warp',
                cost: 80,
                damage: 260,
                nature: null,
                pp: 3,
                desc: 'Suck enemy into another dimension',
            },
            {
                id: 'rinne_sharingan_obito',
                name: 'Rinne Sharingan Genjutsu',
                cost: 120,
                damage: 0,
                nature: null,
                pp: 2,
                buff: { stun: 3 },
                desc: 'Infinite Tsukuyomi partial — 3-turn stun',
            },
        ],
    },

    // Gacha-exclusive shisui also gets Sharingan
    shisui: {
        eye: 'sharingan',
        name: 'Sharingan',
        tier: 'Mangekyou',
        emoji: '💫',
        passive: {
            dodgeBonus: 30,           // Shisui is the fastest Uchiha
            critBonus: 15,
            firstTurnCrit: true,      // first attack of battle always crits
            desc: '💫 Shunshin Sharingan — 30% dodge, guaranteed first-turn crit',
        },
        copyAbility: {
            name: 'Sharingan Copy',
            desc: 'Shisui\'s refined Sharingan copies with perfect recall',
            costMult: 0.65,
            damageMult: 1.25,
            maxCopiesPerBattle: 3,
        },
        mangekyou: [
            {
                id: 'kotoamatsukami_ms',
                name: 'Kotoamatsukami',
                cost: 100,
                damage: 0,
                nature: null,
                pp: 1,
                buff: { stun: 3 },
                desc: 'Rewrite the enemy\'s mind without them knowing — 3-turn stun',
                overpowerStun: true,  // cannot be resisted or cancelled
            },
        ],
    },

    // ── BYAKUGAN ──────────────────────────────────────────────────────────────
    // Characters: neji
    neji: {
        eye: 'byakugan',
        name: 'Byakugan',
        tier: 'Byakugan',
        emoji: '⭕',
        passive: {
            exactHpReveal: true,      // see enemy's EXACT HP every round (shown in battle log)
            chakraPointSeal: {
                chance: 0.20,         // 20% per hit to seal a chakra point
                drainAmount: 50,      // drain 50 chakra when triggered
            },
            nearFieldBonus: 15,       // +15% damage on Gentle Fist moves specifically
            desc: '⭕ Byakugan active — see exact enemy HP, 20% chakra seal on hit',
        },
        // Byakugan active: Eight Trigrams seal (costs chakra, drains enemy chakra)
        active: [
            {
                id: 'eight_trigrams_seal',
                name: 'Eight Trigrams: Chakra Point Seal',
                cost: 60,
                damage: 100,
                nature: null,
                pp: 3,
                desc: 'Strike 64 chakra points — deals damage AND drains 100 enemy chakra',
                chakraDrain: 100,
            },
            {
                id: 'byakugan_vision',
                name: 'All-Seeing Eye',
                cost: 40,
                damage: 0,
                nature: null,
                pp: 3,
                buff: { dodge: 25, crit: 15 },
                desc: 'Byakugan\'s 360° vision — huge dodge and crit for 2 turns',
                selfBuff: { dodge: 25, crit: 15, turns: 2 },
            },
        ],
    },

    // ── RINNEGAN ──────────────────────────────────────────────────────────────
    // Characters: pain, nagato_rinnegan (gacha)
    pain: {
        eye: 'rinnegan',
        name: 'Rinnegan',
        tier: 'Rinnegan',
        emoji: '🔵',
        passive: {
            absorb: {
                chance: 0.20,         // 20% per incoming attack to absorb it
                chakraRestore: 60,    // restore 60 chakra when absorb triggers
            },
            allNatureAccess: true,    // no nature damage penalty ever
            gravityField: true,       // 10% per turn enemy loses 30 chakra (gravitational pull)
            desc: '🔵 Rinnegan active — 20% jutsu absorption, chakra drain field',
        },
        sixPaths: [
            {
                id: 'deva_push',
                name: 'Almighty Push',
                cost: 60,
                damage: 200,
                nature: null,
                pp: 4,
                desc: 'Repel everything — pushes all attacks and enemies away',
                knockback: true,      // resets enemy's last used jutsu (can't copy it)
            },
            {
                id: 'deva_pull',
                name: 'Universal Pull',
                cost: 60,
                damage: 160,
                nature: null,
                pp: 4,
                desc: 'Pull everything inward — inescapable gravitational force',
            },
            {
                id: 'asura_path',
                name: 'Asura Path: Missile Barrage',
                cost: 70,
                damage: 220,
                nature: null,
                pp: 3,
                desc: 'Mechanical body fires explosive missiles',
            },
            {
                id: 'human_path',
                name: 'Human Path: Soul Rip',
                cost: 80,
                damage: 150,
                nature: null,
                pp: 3,
                desc: 'Rip the soul — deals damage AND absorbs 80 enemy chakra',
                chakraDrain: 80,
                soulDrain: true,
            },
            {
                id: 'outer_path',
                name: 'Rinne Tensei — Partial',
                cost: 130,
                damage: -350,        // negative = heal
                nature: null,
                pp: 1,
                desc: 'Sacrifice chakra to restore 350 HP — at great cost',
            },
        ],
    },

    nagato_rinnegan: {
        eye: 'rinnegan',
        name: 'Rinnegan',
        tier: 'Rinnegan',
        emoji: '🔵',
        passive: {
            absorb: { chance: 0.25, chakraRestore: 80 },
            allNatureAccess: true,
            gravityField: true,
            desc: '🔵 True Rinnegan — 25% absorption, stronger chakra field',
        },
        sixPaths: [
            {
                id: 'bancho_tensei',
                name: "Banshō Ten'in",
                cost: 60, damage: 200, nature: null, pp: 4,
                desc: 'Massive gravitational pull attack',
            },
            {
                id: 'chibaku_tensei',
                name: 'Chibaku Tensei',
                cost: 100, damage: 300, nature: null, pp: 3,
                desc: 'Create a gravitational star — crushing imprisonment',
                stun: 1,
            },
            {
                id: 'rinne_rebirth',
                name: 'Rinne Rebirth',
                cost: 140, damage: -9999, nature: null, pp: 1,
                desc: 'Sacrifice chakra to FULLY restore HP — costs almost everything',
                fullHeal: true,
            },
        ],
    },
};

// ─── DOJUTSU STATE INIT ──────────────────────────────────────────────────────
// Stored inside fight.dojutsuState
function initDojutsuState(characterId) {
    const d = DOJUTSU[characterId];
    if (!d) return null;
    return {
        eye: d.eye,
        tier: d.tier,
        active: true,              // eye is always open in battle
        copiedMove: null,          // last enemy move captured by Sharingan
        copiesUsed: 0,             // how many times copy has been used this battle
        copyOnFirstHitDone: false, // Kakashi auto-copy flag
        firstTurnCritDone: false,  // Shisui first-turn crit flag
        absorbtionUsed: false,     // Rinnegan absorb (once per battle)
        dotEffects: [],            // [ { damage, turnsLeft, label } ]
        selfBuffs: [],             // [ { stat, amount, turnsLeft } ]
        sealedTurns: 0,            // Totsuka seal — enemy can't use jutsus
    };
}

// ─── PASSIVE DODGE BONUS ─────────────────────────────────────────────────────
// Called from applyDojutsuStats to add passive dodge/crit to ps
function applyDojutsuStats(ps, characterId, dojutsuState) {
    if (!dojutsuState?.active) return ps;
    const d = DOJUTSU[characterId];
    if (!d?.passive) return ps;
    const boosted = { ...ps };
    if (d.passive.dodgeBonus)  boosted.dodge  = (boosted.dodge  || 0) + d.passive.dodgeBonus;
    if (d.passive.critBonus)   boosted.crit   = (boosted.crit   || 0) + d.passive.critBonus;
    return boosted;
}

// ─── ON-HIT PASSIVES ─────────────────────────────────────────────────────────
// Call AFTER a successful player hit lands on the enemy.
// Returns { log } with any triggered effects.
function onHitPassives(characterId, dojutsuState, user, fight, damageDealt) {
    const d = DOJUTSU[characterId];
    if (!d || !dojutsuState?.active) return { log: '' };
    let log = '';

    // Itachi Genjutsu: 25% per hit to stun
    if (d.passive?.genjutsuPassive && Math.random() < 0.25) {
        fight.effects = fight.effects || {};
        fight.effects.enemy = fight.effects.enemy || {};
        fight.effects.enemy.stunTurns = (fight.effects.enemy.stunTurns || 0) + 1;
        log += `🌑 *Genjutsu Trigger!* Enemy caught in illusion — stunned next turn!\n`;
    }

    // Byakugan chakra point seal
    if (d.eye === 'byakugan' && d.passive?.chakraPointSeal) {
        const seal = d.passive.chakraPointSeal;
        if (Math.random() < seal.chance) {
            fight.enemyChakraDrained = (fight.enemyChakraDrained || 0) + seal.drainAmount;
            log += `⭕ *Chakra Point Sealed!* Enemy loses ${seal.drainAmount} chakra!\n`;
        }
    }

    // Kakashi copy-on-first-hit
    if (d.passive?.copyOnFirstHit && !dojutsuState.copyOnFirstHitDone && fight.lastEnemyMove) {
        dojutsuState.copyOnFirstHitDone = true;
        dojutsuState.copiedMove = { ...fight.lastEnemyMove };
        log += `👁️ *Sharingan Copied!* Kakashi recorded _${fight.lastEnemyMove.name}_ — !dojutsu copy to use it\n`;
    }

    return { log };
}

// ─── ON-RECEIVE-HIT PASSIVES ─────────────────────────────────────────────────
// Call BEFORE enemy damage is applied to player.
// Returns { absorbed, log } — if absorbed, skip damage entirely.
function onReceiveHit(characterId, dojutsuState, user, fight, incomingMove) {
    const d = DOJUTSU[characterId];
    if (!d || !dojutsuState?.active) return { absorbed: false, log: '' };
    let log = '';

    // Obito intangibility — 20% phase through
    if (d.passive?.intangible && Math.random() < 0.20) {
        log += `🌀 *Kamui!* ${user.username} phases through the attack!\n`;
        return { absorbed: true, log };
    }

    // Rinnegan absorption — 20-25% per incoming jutsu
    if (d.eye === 'rinnegan' && d.passive?.absorb && !dojutsuState.absorbtionUsed) {
        const absorb = d.passive.absorb;
        if (Math.random() < absorb.chance) {
            dojutsuState.absorbtionUsed = true;
            user.chakra.current = Math.min(user.chakra.max, user.chakra.current + absorb.chakraRestore);
            log += `🔵 *Rinnegan Absorption!* ${user.username} nullifies the attack and restores ${absorb.chakraRestore} chakra!\n`;
            return { absorbed: true, log };
        }
    }

    // Sharingan — record the incoming move for possible copy
    if (d.eye === 'sharingan' && incomingMove && incomingMove.damage > 0) {
        dojutsuState.copiedMove = { ...incomingMove };
        // Only show first copy notification per battle
        if (!dojutsuState._copyNotified) {
            dojutsuState._copyNotified = true;
            log += `🔴 *Sharingan recorded _${incomingMove.name}_!* Type !dojutsu copy to use it\n`;
        }
    }

    return { absorbed: false, log };
}

// ─── PER-TURN PASSIVES ───────────────────────────────────────────────────────
// Call at end of each round. Returns log string.
function tickDojutsuPassives(characterId, dojutsuState, user, fight) {
    const d = DOJUTSU[characterId];
    if (!d || !dojutsuState?.active) return '';
    let log = '';

    // Byakugan exact HP reveal
    if (d.passive?.exactHpReveal) {
        log += `⭕ Byakugan: Enemy has exactly *${Math.max(0, fight.enemyHp)}/${fight.enemyMaxHp} HP* remaining\n`;
    }

    // Rinnegan gravity field — drains enemy chakra passively
    if (d.passive?.gravityField) {
        const drain = 30;
        fight.enemyChakraDrained = (fight.enemyChakraDrained || 0) + drain;
        log += `🔵 Rinnegan gravity field pulls ${drain} chakra from the enemy\n`;
    }

    // DoT effects (Amaterasu burns etc.)
    for (const dot of (dojutsuState.dotEffects || [])) {
        if (dot.turnsLeft > 0) {
            fight.enemyHp = Math.max(0, fight.enemyHp - dot.damage);
            log += `${dot.label}: ${dot.damage} dmg! (${dot.turnsLeft - 1} turns left)\n`;
            dot.turnsLeft--;
        }
    }
    dojutsuState.dotEffects = (dojutsuState.dotEffects || []).filter(d => d.turnsLeft > 0);

    // Totsuka seal countdown
    if (dojutsuState.sealedTurns > 0) {
        dojutsuState.sealedTurns--;
        if (dojutsuState.sealedTurns === 0) log += `🗡️ Totsuka seal expires — enemy can use jutsus again\n`;
    }

    return log;
}

// ─── ACTIVE DOJUTSU COMMAND (!dojutsu) ───────────────────────────────────────
// Returns { success, move, log, specialEffect } or { success: false, msg }
function useDojutsu(subCmd, characterId, dojutsuState, user, fight) {
    const d = DOJUTSU[characterId];
    if (!d) return { success: false, msg: `❌ ${user.username} doesn't have a Dojutsu!` };
    if (!dojutsuState?.active) return { success: false, msg: `❌ Dojutsu not active in this battle.` };

    // --- COPY (Sharingan only) ---
    if (subCmd === 'copy' || subCmd === 'c') {
        if (d.eye !== 'sharingan') return { success: false, msg: `❌ Only Sharingan users can copy jutsus!` };
        if (!dojutsuState.copiedMove) return { success: false, msg: `❌ No jutsu copied yet! The Sharingan records enemy moves as they're used.` };
        const ab = d.copyAbility;
        if (dojutsuState.copiesUsed >= ab.maxCopiesPerBattle) {
            return { success: false, msg: `❌ Used max copies (${ab.maxCopiesPerBattle}) this battle.` };
        }
        const copied = dojutsuState.copiedMove;
        const chakraCost = Math.round((copied.cost || 50) * ab.costMult);
        if (user.chakra.current < chakraCost) {
            return { success: false, msg: `❌ Need ${chakraCost} chakra to copy *${copied.name}* (have ${user.chakra.current})` };
        }
        user.chakra.current -= chakraCost;
        dojutsuState.copiesUsed++;
        const damage = Math.round((copied.damage || 80) * ab.damageMult);
        return {
            success: true,
            move: { name: `${d.emoji} Copy: ${copied.name}`, damage, nature: copied.nature || null },
            log: `${d.emoji} *Sharingan Copy — ${copied.name}!*\n_The Sharingan perfectly mirrors the technique!_\n`,
        };
    }

    // --- MANGEKYOU moves by index: !dojutsu 1 / 2 / 3 ---
    const moves = d.mangekyou || d.active || d.sixPaths || [];
    const idx = parseInt(subCmd) - 1;
    if (isNaN(idx) || idx < 0 || idx >= moves.length) {
        // Show available moves
        let list = `${d.emoji} *${d.name} — ${d.tier}*\n\n`;
        if (d.eye === 'sharingan') {
            list += `_!dojutsu copy_ — Use copied enemy jutsu\n\n`;
        }
        moves.forEach((m, i) => {
            list += `*${i + 1}.* ${m.name} (💧${m.cost}) — ⟳${m.pp}\n   _${m.desc}_\n\n`;
        });
        list += `_!dojutsu [number] to activate_`;
        return { success: false, msg: list };
    }

    const move = moves[idx];
    if (user.chakra.current < move.cost) {
        return { success: false, msg: `❌ Need ${move.cost} chakra for *${move.name}* (have ${user.chakra.current})` };
    }

    // Track PP — store in dojutsuState.movePp
    if (!dojutsuState.movePp) dojutsuState.movePp = {};
    if (dojutsuState.movePp[move.id] === undefined) dojutsuState.movePp[move.id] = move.pp;
    if (dojutsuState.movePp[move.id] <= 0) {
        return { success: false, msg: `❌ *${move.name}* is out of PP for this battle!` };
    }

    user.chakra.current -= move.cost;
    dojutsuState.movePp[move.id]--;

    const specialEffect = {};

    // Dot effect (Amaterasu)
    if (move.dot) {
        dojutsuState.dotEffects = dojutsuState.dotEffects || [];
        dojutsuState.dotEffects.push({ damage: move.dot.damage, turnsLeft: move.dot.turns, label: move.dot.label });
        specialEffect.dot = move.dot;
    }

    // Self-buff (Susano'o defense etc.)
    if (move.selfBuff) specialEffect.selfBuff = move.selfBuff;

    // Seal (Totsuka)
    if (move.sealEffect) {
        dojutsuState.sealedTurns = 2;
        specialEffect.sealed = true;
    }

    // Chakra drain (Human Path, Byakugan)
    if (move.chakraDrain) specialEffect.chakraDrain = move.chakraDrain;

    // Full heal (Rinne Rebirth)
    if (move.fullHeal) {
        const healed = user.hp.max - user.hp.current;
        user.hp.current = user.hp.max;
        user.chakra.current = Math.max(0, user.chakra.current - 100);
        return {
            success: true,
            move: { name: move.name, damage: 0, nature: null },
            log: `${d.emoji} *${move.name}!*\n_${move.desc}_\n💚 Fully restored ${healed} HP! 💧 -100 Chakra sacrifice\n`,
            specialEffect: { fullHeal: true },
        };
    }

    // Stun (Tsukuyomi etc.)
    if (move.buff?.stun) specialEffect.stun = move.buff.stun;

    // Undodgeable
    if (move.undodgeable) specialEffect.undodgeable = true;

    // Kotoamatsukami overpowerStun
    if (move.overpowerStun) specialEffect.overpowerStun = true;

    const logLine = `${d.emoji} *${d.name} — ${move.name}!*\n_${move.desc}_\n`;

    return {
        success: true,
        move: { name: move.name, damage: move.damage, nature: move.nature || null, buff: move.buff || null },
        log: logLine,
        specialEffect,
    };
}

// ─── DOJUTSU INFO TEXT ───────────────────────────────────────────────────────
function dojutsuInfoText(characterId) {
    const d = DOJUTSU[characterId];
    if (!d) return null;
    const moves = d.mangekyou || d.active || d.sixPaths || [];

    let txt = `${d.emoji} *${d.name} — ${d.tier}*\n\n`;
    txt += `📋 *Passive (always active in battle):*\n${d.passive.desc}\n\n`;

    if (d.eye === 'sharingan') {
        const ab = d.copyAbility;
        txt += `👁️ *Copy Ability:* !dojutsu copy\n`;
        txt += `   Copies last enemy jutsu — ${Math.round(ab.costMult * 100)}% cost, ${Math.round(ab.damageMult * 100)}% damage\n`;
        txt += `   Max ${ab.maxCopiesPerBattle} copies per battle\n\n`;
    }

    if (moves.length) {
        const label = d.eye === 'sharingan' ? 'Mangekyou Techniques' : d.eye === 'byakugan' ? 'Active Techniques' : 'Six Paths Techniques';
        txt += `⚡ *${label}:* (!dojutsu [number])\n`;
        moves.forEach((m, i) => {
            txt += `  *${i + 1}.* ${m.name} (💧${m.cost} | ⟳${m.pp})\n     _${m.desc}_\n`;
        });
    }

    txt += `\n_Dojutsu activates automatically when you enter battle._\n_Type !dojutsu during a fight to use active techniques._`;
    return txt;
}

// ─── WHICH CHARACTERS HAVE DOJUTSU ──────────────────────────────────────────
const DOJUTSU_CHARS = Object.keys(DOJUTSU);

function hasDojutsu(characterId) {
    return DOJUTSU_CHARS.includes(characterId);
}

module.exports = {
    DOJUTSU,
    DOJUTSU_CHARS,
    hasDojutsu,
    initDojutsuState,
    applyDojutsuStats,
    onHitPassives,
    onReceiveHit,
    tickDojutsuPassives,
    useDojutsu,
    dojutsuInfoText,
};
