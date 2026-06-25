// src/case.js
// src/case.js
const User = require('../models/User');
const Clan = require('../models/Clan');
const PromoCode = require('../models/PromoCode');
const { prepareImagePayload, prepareImagePayloadFromBuffer, getCharacterImage, getBattleImage, VILLAGE_IMAGES } = require('./mediaEngine');
const { renderBattleCard, renderProfileCard } = require('./battleRender');
const { CHARACTERS, FREE_CHARACTERS, xpForLevel, getCharacter } = require('./characters');
const { buttonMessage, listMessage, charShopCard, battleButtons } = require('./uiHelpers');
const { CANON_CLANS, findCanonClan, rollCustomClanBuff, describeBuffs } = require('./clans');
const { getMonster, RANK_LABELS, RANK_MIN_LEVEL } = require('./monsters');
const { ITEMS, getItem, findItem, priceLabel } = require('./items');
const { getActiveEvent, xpMultiplier, ryoMultiplier } = require('./events');
const { getClanBuffs, getEffectiveStats, hpBar, chakraBar, resolveHit, enemyChooseMove, pickPvpBotMove } = require('./battle');
const { natureTag } = require('./natures');
const { initFightEffects, applyBuff, isStunned, consumeStun, tickStatBuffs, mergeStatBonuses } = require('./statusEffects');
const { getCurrentBoss, getActiveRaid, startRaid, joinRaid, currentTurnJid, advanceTurn, calcRaidHit, bossFight, computeRewards, raidHpBar } = require('./raid');
const { performPulls, formatPullResult, bannerText } = require('./gacha');
const { getTodaysMissions, canRunDailyMission, recordDailyMission, missionBoardText } = require('./dailyMissions');
const { isJinchuriki, getBijuu, initBijuuState, checkAutoTransform, applyBijuuStats, tickBijuuPassive, activateChakraMode, tickChakraMode, tickExhaustion, useBeastBomb, checkSandShield, bijuuStatusLine } = require('./tailedBeast');
const { hasDojutsu, initDojutsuState, applyDojutsuStats, onHitPassives, onReceiveHit, tickDojutsuPassives, useDojutsu, dojutsuInfoText } = require('./dojutsu');

const ADMIN_NUMBER = '2349155604141@s.whatsapp.net';
const ADMIN_PLAIN  = '2349155604141';
const ADMIN_LID     = '108933272367319'; // confirmed via !whoami — your @lid inside groups

const BRAND = {
    billingSupportNumber: "2347041560392",
    moniepointDetails: "🏦 Moniepoint MFB\n🔢 Acc No: 7074435901\n👤 Name: Praise Philip Jacob"
};

const VILLAGE_GROUPS = {
    Leaf:  'https://chat.whatsapp.com/ExampleLeafGroupLink',
    Sand:  'https://chat.whatsapp.com/ExampleSandGroupLink',
    Mist:  'https://chat.whatsapp.com/ExampleMistGroupLink',
    Cloud: 'https://chat.whatsapp.com/ExampleCloudGroupLink',
    Stone: 'https://chat.whatsapp.com/ExampleStoneGroupLink',
    Rain:  'https://chat.whatsapp.com/ExampleRainGroupLink',
};

const VILLAGES = ['Leaf', 'Sand', 'Mist', 'Cloud', 'Stone'];

function isAdmin(senderJid) {
    const stripped = senderJid.replace('@s.whatsapp.net','').replace('@lid','');
    return senderJid === ADMIN_NUMBER ||
           stripped === ADMIN_PLAIN ||
           stripped === ADMIN_LID;
}

// Find a player by in-game username (preferred — works regardless of @lid/number)
// or by raw phone number (fallback, for back-compat with old commands).
// Usage in admin commands: pass whatever the admin typed (e.g. "Naruto99" or "2348012345678").
async function findTargetUser(identifier) {
    if (!identifier) return null;
    const cleanedNum = identifier.replace('+', '').trim();

    // Numeric-looking input — try matching as a phone number first
    if (/^\d{7,15}$/.test(cleanedNum)) {
        const byNumber = await User.findOne({ phoneId: `${cleanedNum}@s.whatsapp.net` });
        if (byNumber) return byNumber;
    }

    // Otherwise (or as fallback) match by in-game username, case-insensitive, exact.
    // Escape regex metacharacters so a username like "a.b" or "(test)" can't
    // alter the match pattern.
    const escaped = identifier.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const byName = await User.findOne({ username: new RegExp(`^${escaped}$`, 'i') });
    return byName || null;
}

// XP needed to reach next level
function xpNeeded(level) { return level * 500; }

// Add XP and handle level ups — returns { leveledUp, newLevel, rewards }
// Applies the active server event's XP multiplier automatically.
async function addXP(user, amount) {
    amount = Math.round(amount * xpMultiplier());
    user.xp += amount;
    user.totalXp = (user.totalXp || 0) + amount;
    let leveledUp = false;
    let rewards = [];

    while (user.xp >= xpNeeded(user.level)) {
        user.xp -= xpNeeded(user.level);
        user.level += 1;
        leveledUp = true;

        // Level up rewards
        const ryoReward = user.level * 200;
        let gemReward   = 0;
        let bonus       = '';

        user.ryo += ryoReward;

        // Milestone rewards
        if (user.level === 10) { gemReward = 3; bonus = '🎉 Milestone: Level 10 reached!'; }
        else if (user.level === 25) { gemReward = 5; bonus = '🏆 Milestone: Level 25 — Chunin power!'; }
        else if (user.level === 50) { gemReward = 10; bonus = '⚡ Milestone: Level 50 — Jonin strength!'; }
        else if (user.level === 75) { gemReward = 15; bonus = '🔥 Milestone: Level 75 — Kage candidate!'; }
        else if (user.level >= 100 && !user.isKage) { gemReward = 20; bonus = '👑 KAGE CANDIDATE! You are now eligible for Kage election!'; }

        if (gemReward > 0) user.gems += gemReward;

        // Stat boost on level up
        user.hp.max     += 20;
        user.chakra.max += 15;
        user.hp.current     = user.hp.max;
        user.chakra.current = user.chakra.max;

        rewards.push({ level: user.level, ryo: ryoReward, gems: gemReward, bonus });
    }

    // Update rank based on level
    if (user.level >= 75) user.rank = 'Jonin Elite';
    else if (user.level >= 50) user.rank = 'Jonin';
    else if (user.level >= 25) user.rank = 'Chunin';
    else if (user.level >= 10) user.rank = 'Genin';
    else user.rank = 'Academy Student';

    await user.save();
    return { leveledUp, rewards };
}

// Resolve a PvE victory: roll rewards, apply lucky charm, save, and announce.
async function finishPveWin(conn, from, user, fight, log) {
    const r = fight.reward;
    let ryo = Math.floor((Math.random() * (r.maxRyo - r.minRyo + 1)) + r.minRyo) * ryoMultiplier();
    ryo = Math.round(ryo);

    // Lucky Charm doubles ryo from the next win
    let lucky = false;
    const charmIdx = user.inventory.findIndex(it => it.itemId === 'lucky_charm');
    if (charmIdx > -1) {
        ryo *= 2;
        lucky = true;
        user.inventory[charmIdx].qty -= 1;
        if (user.inventory[charmIdx].qty <= 0) user.inventory.splice(charmIdx, 1);
    }

    const gems = Math.random() < (r.gemChance || 0) ? 1 : 0;
    user.ryo += ryo;
    if (gems) user.gems += gems;
    user.wins = (user.wins || 0) + 1;
    user.winStreak = (user.winStreak || 0) + 1;
    user.lastBattle = new Date();

    const { leveledUp, rewards } = await addXP(user, r.xp);

    let reply = `${log}\n🏆 *VICTORY!*\n\nDefeated ${fight.enemyEmoji} *${fight.enemyName}*!\n` +
        `💰 +${ryo.toLocaleString()} Ryo${lucky ? ' 🍀(Lucky x2!)' : ''} | 📈 +${r.xp} XP`;
    if (gems) reply += ` | 💎 +${gems}`;
    if (user.winStreak > 1) reply += `\n🔥 Win streak: ${user.winStreak}`;

    if (leveledUp) {
        rewards.forEach(rw => {
            reply += `\n\n🎉 *LEVEL UP! Now Level ${rw.level}!*\n💰 +${rw.ryo} Ryo`;
            if (rw.gems > 0) reply += ` | +${rw.gems} 💎`;
            if (rw.bonus) reply += `\n${rw.bonus}`;
        });
    }

    return await conn.sendMessage(from, prepareImagePayload(getBattleImage(user.character), reply));
}

// Recompute a user's max HP/Chakra from character base + level, then apply clan
// HP/Chakra % buffs (with a +10% leadership bonus for clan leaders).
// Pass buffs={} to strip clan bonuses (used on leave).
function applyClanStatBuffs(user, buffs = {}, isLeader = false) {
    const char = getCharacter(user.character);
    const baseHp     = char.baseStats.hp     + (user.level - 1) * 20;
    const baseChakra = char.baseStats.chakra + (user.level - 1) * 15;

    let hpBuff     = buffs.hp     || 0;
    let chakraBuff = buffs.chakra || 0;
    if (isLeader) { hpBuff = Math.round(hpBuff * 1.1); chakraBuff = Math.round(chakraBuff * 1.1); }

    user.hp.max     = Math.round(baseHp     * (1 + hpBuff / 100));
    user.chakra.max = Math.round(baseChakra * (1 + chakraBuff / 100));
    user.hp.current     = Math.min(user.hp.current,     user.hp.max);
    user.chakra.current = Math.min(user.chakra.current, user.chakra.max);
}

// Active game state maps
const activeExams      = new Map();
const activeFights     = new Map();
const activeVotes      = new Map(); // Kage votes: village -> { candidates: {jid: votes}, endTime }
const activeChallenges = new Map(); // targetJid -> { fromJid, fromName, toName, timer }

module.exports = async (conn, from, senderJid, cleanText, phoneNumber, pushName = 'Ninja') => {
    try {
        // Check ban
        const user = await User.findOne({ phoneId: senderJid });
        if (user?.isBanned) return;

        const lowerText = cleanText.toLowerCase();
        const args = lowerText.startsWith('!')
            ? lowerText.slice(1).trim().split(/ +/)
            : [];
        const command = args.shift() || '';
        // Get original case args for things like names
        const rawArgs = cleanText.startsWith('!')
            ? cleanText.slice(1).trim().split(/ +/)
            : [];
        rawArgs.shift();
        const rawText = rawArgs.join(' ');

        console.log(`[CASE] cmd=${command} from=${from} sender=${senderJid}`);

        // ── TRIVIA ANSWER ─────────────────────────────────────────────────────
        if (activeExams.has(senderJid)) {
            const examData = activeExams.get(senderJid);
            activeExams.delete(senderJid);
            if (!user) return;

            if (lowerText.trim() === examData.correctAnswer) {
                user.rank = examData.nextRank;
                user.ryo += examData.rewardRyo;
                user.chakra.max    += 30;
                user.hp.max        += 100;
                user.chakra.current = user.chakra.max;
                user.hp.current     = user.hp.max;
                await user.save();
                return await conn.sendMessage(from, {
                    text: `🎉 *PROMOTION EXAM PASSED!*\n\n🎖️ *New Rank:* ${user.rank}\n💰 *Bonus:* +${examData.rewardRyo} Ryo\n💪 +30 Max Chakra | +100 Max HP`
                });
            } else {
                return await conn.sendMessage(from, {
                    text: `❌ *EXAM FAILURE*\n\nCorrect answer: *${examData.correctAnswer.toUpperCase()}*\n\nTrain harder and try again!`
                });
            }
        }

        // ── KAGE VOTE ─────────────────────────────────────────────────────────
        if (user && lowerText.startsWith('!vote ') && user.registrationStep === 'COMPLETED') {
            const voteData = activeVotes.get(user.village);
            if (voteData && Date.now() < voteData.endTime) {
                const candidateNum = lowerText.split(' ')[1]?.replace('+','');
                const candidateJid = `${candidateNum}@s.whatsapp.net`;
                const candidate    = await User.findOne({ phoneId: candidateJid });

                if (!candidate || candidate.village !== user.village) {
                    return await conn.sendMessage(from, { text: '❌ Invalid candidate or not from your village.' });
                }
                if (voteData.voted?.has(senderJid)) {
                    return await conn.sendMessage(from, { text: '❌ You already voted this week!' });
                }

                voteData.candidates[candidateJid] = (voteData.candidates[candidateJid] || 0) + 1;
                voteData.voted = voteData.voted || new Set();
                voteData.voted.add(senderJid);

                return await conn.sendMessage(from, {
                    text: `✅ Vote cast for *${candidate.username}* as ${user.village} Kage!\n\n🗳️ They now have ${voteData.candidates[candidateJid]} votes.`
                });
            }
        }

        if (!command) return;

        switch (command) {

            // ════════════════════════════════════════════════════════════════
            // REGISTRATION
            // ════════════════════════════════════════════════════════════════
            case 'start': {
                if (user && user.registrationStep === 'COMPLETED') {
                    return await conn.sendMessage(from, {
                        text: `❌ Already registered as *${user.username}*!\n\nType !profile to view your stats.`
                    });
                }

                const randomVillage   = VILLAGES[Math.floor(Math.random() * VILLAGES.length)];
                const charId          = FREE_CHARACTERS[Math.floor(Math.random() * FREE_CHARACTERS.length)];
                const char            = getCharacter(charId);
                const ninjaName       = (pushName || 'Ninja').slice(0, 16);

                const newUser = new User({
                    phoneId:          senderJid,
                    username:         ninjaName,
                    village:          randomVillage,
                    clan:             'None',          // clanless — choose via !joinclan or !createclan
                    clanRole:         'None',
                    bloodlineRarity:  'None',
                    character:        charId,
                    ownedCharacters:  [charId],
                    unlockedJutsus:   [char.jutsus[0].id],
                    equippedJutsus:   [char.jutsus[0].id],
                    hp:     { current: char.baseStats.hp,     max: char.baseStats.hp },
                    chakra: { current: char.baseStats.chakra, max: char.baseStats.chakra },
                    registrationStep: 'COMPLETED'
                });
                await newUser.save();

                const groupInvite = VILLAGE_GROUPS[randomVillage] || 'Contact Admin';
                const welcomeMsg  =
                    `🍥 *WELCOME TO NARUTO RPG* 🍥\n\n` +
                    `✅ *Ninja Name:* ${ninjaName}\n\n` +
                    `🏡 *Village:* Hidden ${randomVillage} Village\n` +
                    `🩸 *Clan:* None yet — _type !clans to pick one or !createclan to found your own!_\n\n` +
                    `${char.emoji} *Character:* ${char.name}\n` +
                    `📖 *${char.description}*\n\n` +
                    `❤️ HP: ${char.baseStats.hp} | ⚡ Chakra: ${char.baseStats.chakra}\n` +
                    `⚔️ ATK: ${char.baseStats.attack} | 🛡️ DEF: ${char.baseStats.defense} | 💨 SPD: ${char.baseStats.speed}\n\n` +
                    `🥋 *Starter Jutsu:* ${char.jutsus[0].name}\n\n` +
                    `🎖️ *Rank:* Academy Student | Lv.1\n` +
                    `💰 Ryo: 1,000 | 💎 Gems: 5\n\n` +
                    `🏯 *Village Group:* ${groupInvite}\n\n` +
                    `_Don't like your character? Use !shop to buy another!_\n` +
                    `_Type !menu to see all commands_`;

                return await conn.sendMessage(from,
                    prepareImagePayload(getCharacterImage(charId), welcomeMsg)
                );
            }

            // ════════════════════════════════════════════════════════════════
            // WALLET — quick balance check, no need to open full profile
            // ════════════════════════════════════════════════════════════════
            case 'wallet':
            case 'bal':
            case 'balance': {
                if (!user || user.registrationStep !== 'COMPLETED') {
                    return await conn.sendMessage(from, { text: '❌ Register first! Type !start.' });
                }
                const char = getCharacter(user.character);
                const buffsW = await getClanBuffs(user);
                const psW = getEffectiveStats(user, buffsW);

                const walletMsg =
                    `🎒 *NINJA POUCH* — ${user.username}\n\n` +
                    `💰 *Ryo:* ${(user.ryo || 0).toLocaleString()}\n` +
                    `💎 *Gems:* ${user.gems}\n\n` +
                    `❤️ HP: ${user.hp.current}/${user.hp.max}\n` +
                    `⚡ Chakra: ${user.chakra.current}/${user.chakra.max}\n\n` +
                    `_!shop to spend | !profile for full stats | !bag for items_`;

                const walletCard = await renderProfileCard({
                    username: user.username, level: user.level, rank: user.rank,
                    nature: char.nature ? natureTag(char.nature) : null,
                    hp: user.hp.current, maxHp: user.hp.max,
                    chakra: user.chakra.current, maxChakra: user.chakra.max,
                    ryo: user.ryo || 0, gems: user.gems,
                    wins: user.wins || 0, losses: user.losses || 0,
                    rankPoints: user.rankPoints || 0,
                    attack: psW.attack, defense: psW.defense, speed: psW.speed, crit: psW.crit,
                    imageName: getCharacterImage(user.character), emoji: psW.emoji,
                    clanName: user.clan !== 'None' ? user.clan : null,
                    xp: user.xp, xpNeeded: xpNeeded(user.level), totalXp: user.totalXp || 0,
                }).catch(() => null);

                await conn.sendMessage(from, walletCard
                    ? prepareImagePayloadFromBuffer(walletCard, walletMsg)
                    : { text: walletMsg }
                );
                return await conn.sendMessage(from, buttonMessage(
                    'Quick actions:',
                    [{ label: '🛒 Shop', id: '!shop' }, { label: '🎒 My Bag', id: '!bag' }, { label: '⚔️ Battle', id: '!battle d' }]
                ));
            }

            // ════════════════════════════════════════════════════════════════
            // RECORD — dedicated battle stats (PvE + PvP combined, plus PvP rating)
            // ════════════════════════════════════════════════════════════════
            case 'record':
            case 'stats':
            case 'battlestats': {
                if (!user || user.registrationStep !== 'COMPLETED') {
                    return await conn.sendMessage(from, { text: '❌ Register first! Type !start.' });
                }
                const wins   = user.wins   || 0;
                const losses = user.losses || 0;
                const total  = wins + losses;
                const winRate = total > 0 ? ((wins / total) * 100).toFixed(1) : '0.0';

                const recordMsg =
                    `⚔️ *BATTLE RECORD* — ${user.username}\n\n` +
                    `🏆 *Wins:* ${wins}\n` +
                    `💀 *Losses:* ${losses}\n` +
                    `📊 *Total Battles:* ${total}\n` +
                    `📈 *Win Rate:* ${winRate}%\n` +
                    `🔥 *Current Streak:* ${user.winStreak || 0}\n\n` +
                    `🎖️ *PvP Rank Points:* ${user.rankPoints || 0}\n` +
                    `_(Earned/lost only from !duel — PvE battles don't affect rank points)_\n\n` +
                    `_!battle to fight monsters | !duel to challenge a player_`;

                return await conn.sendMessage(from, { text: recordMsg });
            }

            // ════════════════════════════════════════════════════════════════
            // PROFILE
            // ════════════════════════════════════════════════════════════════
            case 'profile': {
                if (!user || user.registrationStep !== 'COMPLETED') {
                    return await conn.sendMessage(from, { text: '❌ Register first! Type !start.' });
                }
                const char = getCharacter(user.character);
                const buffs = await getClanBuffs(user);
                const ps = getEffectiveStats(user, buffs);
                const xpBar = Math.floor((user.xp / xpNeeded(user.level)) * 10);
                const xpBarStr = '█'.repeat(xpBar) + '░'.repeat(10 - xpBar);

                const profileMsg =
                    `📜 *SHINOBI PROFILE* 📜\n\n` +
                    `${user.isKage ? `👑 *${user.village} KAGE*\n` : ''}` +
                    `👤 *Name:* ${user.username}\n` +
                    `${char.emoji} *Character:* ${char.name}${char.nature ? ` (${natureTag(char.nature)})` : ''}\n` +
                    `🎖️ *Rank:* ${user.rank} (Lv.${user.level})\n` +
                    `🏡 *Village:* Hidden ${user.village}\n` +
                    `🩸 *Clan:* ${user.clan === 'None' ? '_None — type !clans_' : `${user.clan}${user.clanRole === 'Leader' ? ' 👑Leader' : ''}`}\n` +
                    `⚔️ *Record:* ${user.wins || 0}W / ${user.losses || 0}L${user.winStreak > 1 ? ` (🔥${user.winStreak} streak)` : ''} | 🏅 ${user.rankPoints || 0} pts\n` +
                    `${isJinchuriki(user.character) ? `${getBijuu(user.character).emoji} *Jinchuriki:* ${getBijuu(user.character).name} — _!beastinfo for details_\n` : ''}` +
                    `${hasDojutsu(user.character) ? `👁️ *Dojutsu:* ${require('./dojutsu').DOJUTSU[user.character]?.name} (${require('./dojutsu').DOJUTSU[user.character]?.tier}) — _!dojutsu for details_\n` : ''}` +
                    `${user.raidKills ? `💀 *Raid Kills:* ${user.raidKills}\n` : ''}\n` +
                    `📈 *XP:* [${xpBarStr}] ${user.xp}/${xpNeeded(user.level)}\n` +
                    `💰 *Ryo:* ${(user.ryo || 0).toLocaleString()} | 💎 *Gems:* ${user.gems}\n\n` +
                    `_!jutsus — view your moves | !bag — your items | !shop — characters_`;

                // Send character image + text profile (clean, no garbled SVG canvas card)
                await conn.sendMessage(from, prepareImagePayload(getCharacterImage(user.character), profileMsg));
                return await conn.sendMessage(from, buttonMessage(
                    'What next?',
                    [{ label: '⚔️ Start Battle', id: '!battle d' }, { label: '🎒 My Bag', id: '!bag' }, { label: '🛒 Shop', id: '!shop' }]
                ));
            }

            // ════════════════════════════════════════════════════════════════
            // JUTSUS
            // ══════════════════════════════════��═════════════════════════════
            case 'jutsus':
            case 'jutsu': {
                if (!user || user.registrationStep !== 'COMPLETED') {
                    return await conn.sendMessage(from, { text: '❌ Register first! Type !start.' });
                }
                const char = getCharacter(user.character);
                let jutsuList = `🥋 *${char.name} JUTSU LIST* 🥋\n`;
                jutsuList += char.nature ? `${natureTag(char.nature)} affinity\n\n` : `No elemental affinity\n\n`;

                char.jutsus.forEach(j => {
                    const owned    = user.unlockedJutsus.includes(j.id);
                    const equipped = user.equippedJutsus.includes(j.id);
                    jutsuList += `${owned ? '✅' : '🔒'} *${j.name}*${j.nature ? ` (${natureTag(j.nature)})` : ''}\n`;
                    jutsuList += `   💧 Cost: ${j.cost} Chakra\n`;
                    jutsuList += `   📖 ${j.desc}\n`;
                    if (!owned) jutsuList += `   💰 Unlock: 2,000 Ryo\n`;
                    if (equipped) jutsuList += `   ⚡ _EQUIPPED_\n`;
                    jutsuList += '\n';
                });

                jutsuList += `_!buyjutsu [name] — unlock a jutsu_\n_!equip [name] — equip a jutsu_`;
                return await conn.sendMessage(from, { text: jutsuList });
            }

            // ════════════════════════════════════════════════════════════════
            // BUY JUTSU
            // ════════════════════════════════════════════════════════════════
            case 'buyjutsu': {
                if (!user || user.registrationStep !== 'COMPLETED') {
                    return await conn.sendMessage(from, { text: '❌ Register first! Type !start.' });
                }
                if (!rawText) return await conn.sendMessage(from, { text: '❌ Usage: !buyjutsu jutsu name' });

                const char = getCharacter(user.character);
                const jutsu = char.jutsus.find(j =>
                    j.name.toLowerCase().includes(rawText.toLowerCase()) ||
                    j.id.toLowerCase().includes(rawText.toLowerCase())
                );

                if (!jutsu) return await conn.sendMessage(from, { text: `❌ Jutsu not found. Type !jutsus to see available moves.` });
                if (user.unlockedJutsus.includes(jutsu.id)) return await conn.sendMessage(from, { text: `❌ You already own *${jutsu.name}*!` });

                const JUTSU_COST = 2000;
                if (user.ryo < JUTSU_COST) return await conn.sendMessage(from, { text: `❌ Need ${JUTSU_COST} Ryo (have ${user.ryo})` });

                user.ryo -= JUTSU_COST;
                user.unlockedJutsus.push(jutsu.id);
                await user.save();

                return await conn.sendMessage(from, {
                    text: `✅ *Jutsu Unlocked!*\n\n🥋 *${jutsu.name}*\n💧 Chakra Cost: ${jutsu.cost}\n📖 ${jutsu.desc}\n\n💰 -${JUTSU_COST} Ryo\n\n_Type !equip ${jutsu.name} to equip it_`
                });
            }

            // ════════════════════════════════════════════════════════════════
            // EQUIP JUTSU  (max 4 equipped)
            // ════════════════════════════════════════════════════════════════
            case 'equip': {
                if (!user || user.registrationStep !== 'COMPLETED') {
                    return await conn.sendMessage(from, { text: '❌ Register first! Type !start.' });
                }
                if (!rawText) {
                    return await conn.sendMessage(from, {
                        text: `❌ Usage: !equip [jutsu name]\n_Use !equip remove [name] to unequip._\n\nView your moves with !jutsus`
                    });
                }

                const char = getCharacter(user.character);
                const MAX_EQUIPPED = 4;

                // Support: !equip remove <name>
                const removing = args[0] === 'remove' || args[0] === 'unequip';
                const query = removing ? rawText.replace(/^(remove|unequip)\s*/i, '') : rawText;

                const jutsu = char.jutsus.find(j =>
                    j.name.toLowerCase().includes(query.toLowerCase()) ||
                    j.id.toLowerCase().includes(query.toLowerCase())
                );

                if (!jutsu) return await conn.sendMessage(from, { text: `❌ Jutsu not found on *${char.name}*. Type !jutsus.` });

                if (removing) {
                    if (!user.equippedJutsus.includes(jutsu.id)) {
                        return await conn.sendMessage(from, { text: `❌ *${jutsu.name}* is not equipped.` });
                    }
                    if (user.equippedJutsus.length <= 1) {
                        return await conn.sendMessage(from, { text: `❌ You must keep at least one jutsu equipped.` });
                    }
                    user.equippedJutsus = user.equippedJutsus.filter(id => id !== jutsu.id);
                    await user.save();
                    return await conn.sendMessage(from, { text: `✅ Unequipped *${jutsu.name}*.\n\n🥋 Equipped: ${user.equippedJutsus.map(id => char.jutsus.find(j => j.id === id)?.name || id).join(', ')}` });
                }

                if (!user.unlockedJutsus.includes(jutsu.id)) {
                    return await conn.sendMessage(from, { text: `🔒 You haven't unlocked *${jutsu.name}* yet.\n\n💰 Buy it with: !buyjutsu ${jutsu.name}` });
                }
                if (user.equippedJutsus.includes(jutsu.id)) {
                    return await conn.sendMessage(from, { text: `✅ *${jutsu.name}* is already equipped.` });
                }
                if (user.equippedJutsus.length >= MAX_EQUIPPED) {
                    return await conn.sendMessage(from, { text: `❌ You can only equip ${MAX_EQUIPPED} jutsus. Unequip one first:\n!equip remove [name]` });
                }

                user.equippedJutsus.push(jutsu.id);
                await user.save();
                return await conn.sendMessage(from, {
                    text: `✅ *Jutsu Equipped!*\n\n🥋 *${jutsu.name}* (💧${jutsu.cost} chakra)\n📖 ${jutsu.desc}\n\n⚡ Equipped (${user.equippedJutsus.length}/${MAX_EQUIPPED}): ${user.equippedJutsus.map(id => char.jutsus.find(j => j.id === id)?.name || id).join(', ')}`
                });
            }

            // ════════════════════════════════════════════════════════════════
            // DAILY REWARD  (streak-based)
            // ════════════════════════════════════════════════════════════════
            case 'daily': {
                if (!user || user.registrationStep !== 'COMPLETED') {
                    return await conn.sendMessage(from, { text: '❌ Register first! Type !start.' });
                }

                const now = Date.now();
                const DAY = 24 * 60 * 60 * 1000;
                const last = user.lastDaily ? user.lastDaily.getTime() : 0;
                const since = now - last;

                if (last && since < DAY) {
                    const wait = DAY - since;
                    const h = Math.floor(wait / (60 * 60 * 1000));
                    const m = Math.floor((wait % (60 * 60 * 1000)) / (60 * 1000));
                    return await conn.sendMessage(from, { text: `⏳ *Daily already claimed!*\n\nCome back in ${h}h ${m}m.\n🔥 Current streak: ${user.dailyStreak} days` });
                }

                // Continue streak if claimed within 48h, else reset
                if (last && since < 2 * DAY) user.dailyStreak = (user.dailyStreak || 0) + 1;
                else user.dailyStreak = 1;

                const streak = user.dailyStreak;
                const ryoReward = 500 + streak * 150;
                const gemReward = streak % 7 === 0 ? 5 : (streak % 3 === 0 ? 1 : 0);
                const xpReward = 50 + streak * 10;

                user.ryo += ryoReward;
                if (gemReward) user.gems += gemReward;
                user.lastDaily = new Date();

                const { leveledUp, rewards } = await addXP(user, xpReward);

                let reply = `🎁 *DAILY REWARD CLAIMED!*\n\n🔥 *Streak:* ${streak} day${streak > 1 ? 's' : ''}\n💰 +${ryoReward.toLocaleString()} Ryo\n📈 +${xpReward} XP`;
                if (gemReward) reply += `\n💎 +${gemReward} Gems${streak % 7 === 0 ? ' (Weekly bonus!)' : ''}`;
                reply += `\n\n_Come back tomorrow to keep your streak alive!_`;

                if (leveledUp) {
                    rewards.forEach(r => {
                        reply += `\n\n🎉 *LEVEL UP! Now Level ${r.level}!*\n💰 +${r.ryo} Ryo`;
                        if (r.gems > 0) reply += ` | +${r.gems} 💎`;
                        if (r.bonus) reply += `\n${r.bonus}`;
                    });
                }

                return await conn.sendMessage(from, { text: reply });
            }

            // ════════════════════════════════════════════════════════════════
            // TRAIN
            // ════════════════════════════════════════════════════════════════
            case 'train': {
                if (!user || user.registrationStep !== 'COMPLETED') {
                    return await conn.sendMessage(from, { text: '❌ Register first! Type !start.' });
                }
                const CHAKRA_COST = 30, XP_GAIN = 25;

                if (user.chakra.current < CHAKRA_COST) {
                    return await conn.sendMessage(from, {
                        text: `❌ *CHAKRA DEPLETED*\n\n⚡ ${user.chakra.current}/${user.chakra.max} (need ${CHAKRA_COST})\n⏳ Regen +10/min`
                    });
                }

                user.chakra.current -= CHAKRA_COST;
                const { leveledUp, rewards } = await addXP(user, XP_GAIN);

                let reply = `🏋️ *TRAINING COMPLETE*\n\n📉 -${CHAKRA_COST} Chakra\n📈 +${XP_GAIN} XP\n\n⚡ Chakra: ${user.chakra.current}/${user.chakra.max}\n📊 XP: ${user.xp}/${xpNeeded(user.level)}`;

                if (leveledUp) {
                    rewards.forEach(r => {
                        reply += `\n\n🎉 *LEVEL UP! Now Level ${r.level}!*\n💰 +${r.ryo} Ryo`;
                        if (r.gems > 0) reply += ` | +${r.gems} 💎`;
                        if (r.bonus) reply += `\n${r.bonus}`;
                    });
                }

                return await conn.sendMessage(from, { text: reply });
            }

            // ════════════════════════════════════════════════════════════════
            // BUY XP
            // ════════════════════════════════════════════════════════════════
            case 'buyxp': {
                if (!user || user.registrationStep !== 'COMPLETED') {
                    return await conn.sendMessage(from, { text: '❌ Register first! Type !start.' });
                }

                const XP_PACKAGES = [
                    { id: '1', xp: 500,   ryo: 2000,  gems: 0 },
                    { id: '2', xp: 1500,  ryo: 5000,  gems: 0 },
                    { id: '3', xp: 5000,  ryo: 15000, gems: 0 },
                    { id: '4', xp: 500,   ryo: 0,     gems: 1 },
                    { id: '5', xp: 1500,  ryo: 0,     gems: 2 },
                    { id: '6', xp: 5000,  ryo: 0,     gems: 5 },
                    { id: '7', xp: 15000, ryo: 0,     gems: 10 },
                ];

                const pkg = args[0];
                if (!pkg || !XP_PACKAGES.find(p => p.id === pkg)) {
                    let menu = `📈 *BUY XP PACKAGES*\n\n`;
                    XP_PACKAGES.forEach(p => {
                        menu += `*[${p.id}]* +${p.xp.toLocaleString()} XP — `;
                        menu += p.ryo > 0 ? `💰 ${p.ryo.toLocaleString()} Ryo` : `💎 ${p.gems} Gems`;
                        menu += '\n';
                    });
                    menu += `\n_Usage: !buyxp [package number]_`;
                    return await conn.sendMessage(from, { text: menu });
                }

                const selected = XP_PACKAGES.find(p => p.id === pkg);

                if (selected.ryo > 0 && user.ryo < selected.ryo) {
                    return await conn.sendMessage(from, { text: `❌ Need ${selected.ryo.toLocaleString()} Ryo (have ${user.ryo.toLocaleString()})` });
                }
                if (selected.gems > 0 && user.gems < selected.gems) {
                    return await conn.sendMessage(from, { text: `❌ Need ${selected.gems} Gems (have ${user.gems})` });
                }

                if (selected.ryo > 0) user.ryo -= selected.ryo;
                if (selected.gems > 0) user.gems -= selected.gems;

                const { leveledUp, rewards } = await addXP(user, selected.xp);

                let reply = `✅ *XP PURCHASED!*\n\n📈 +${selected.xp.toLocaleString()} XP\n`;
                reply += selected.ryo > 0 ? `💰 -${selected.ryo.toLocaleString()} Ryo\n` : `💎 -${selected.gems} Gems\n`;

                if (leveledUp) {
                    rewards.forEach(r => {
                        reply += `\n🎉 *LEVEL UP! Now Level ${r.level}!*\n💰 +${r.ryo} Ryo`;
                        if (r.gems > 0) reply += ` | +${r.gems} 💎`;
                        if (r.bonus) reply += `\n${r.bonus}`;
                    });
                }

                return await conn.sendMessage(from, { text: reply });
            }

            // ════════════════════════════════════════════════════════════════
            // BATTLE  (interactive PvE vs rank-based monsters)
            // ════════════════════════════════════════════════════════════════
            case 'battle':
            case 'fight': {
                if (!user || user.registrationStep !== 'COMPLETED') {
                    return await conn.sendMessage(from, { text: '❌ Register first! Type !start.' });
                }
                if (activeFights.has(senderJid)) {
                    return await conn.sendMessage(from, { text: `⚔️ You're already in a battle! Use *!use [number]* to attack or *!flee* to escape.` });
                }

                const tier = (args[0] || '').toLowerCase();
                if (!['d', 'c', 'b', 'a', 's'].includes(tier)) {
                    return await conn.sendMessage(from, {
                        text: `⚔️ *BATTLE ARENA*\n\nFight rank-based enemies for Ryo & XP:\n\n` +
                              `🟢 !battle d — D-Rank foes (Lv.1+)\n` +
                              `🔵 !battle c — C-Rank foes (Lv.5+)\n` +
                              `🟠 !battle b — B-Rank foes (Lv.15+)\n` +
                              `🔴 !battle a — A-Rank foes (Lv.30+)\n` +
                              `💀 !battle s — S-Rank bosses (Lv.50+)\n\n` +
                              `🤺 *PvP:* !duel [name] — challenge another ninja (they !accept/!decline)\n` +
                              `_In battle: !use [n] = jutsu, !item [name], !flee_`
                    });
                }

                if (user.hp.current <= 1) {
                    return await conn.sendMessage(from, { text: `🏥 Too injured to fight! (${user.hp.current} HP)\n⏳ HP regens +25/min, or use a healing item.` });
                }

                // Battle cooldown — 60s
                const now = Date.now();
                if (user.lastBattle && now - user.lastBattle.getTime() < 60 * 1000) {
                    const wait = Math.ceil((60 * 1000 - (now - user.lastBattle.getTime())) / 1000);
                    return await conn.sendMessage(from, { text: `⏳ Battle cooldown: ${wait}s remaining` });
                }

                const enemy = getMonster(tier, user.level);
                if (!enemy) return await conn.sendMessage(from, { text: '❌ No enemies available for that rank.' });

                const buffs = await getClanBuffs(user);
                const ps = getEffectiveStats(user, buffs);
                const char = getCharacter(user.character);

                // Fresh PP pools for this battle only — never persisted to the user record
                const jutsuPp = {};
                user.equippedJutsus.forEach(id => {
                    const j = char.jutsus.find(x => x.id === id);
                    if (j) jutsuPp[id] = j.pp ?? 99;
                });
                const enemyPp = {};
                enemy.moves.forEach(m => { enemyPp[m.name] = m.pp ?? 99; });

                activeFights.set(senderJid, {
                    type: 'pve',
                    tier,
                    enemyName: enemy.name,
                    enemyEmoji: enemy.emoji,
                    enemyImage: enemy.image,
                    enemyStats: enemy.stats,
                    enemyNature: enemy.nature || null,
                    enemyMoves: enemy.moves,
                    enemyPp,
                    enemyHp: enemy.hp.max,
                    enemyMaxHp: enemy.hp.max,
                    reward: enemy.reward,
                    jutsuPp,
                    effects: initFightEffects(),
                    round: 1,
                    bijuuState: initBijuuState(),
                    dojutsuState: initDojutsuState(user.character),
                    lastEnemyMove: null,
                    enemyChakraDrained: 0,
                    from,
                });

                let moveList = '';
                user.equippedJutsus.forEach((id, i) => {
                    const j = char.jutsus.find(x => x.id === id);
                    if (j) moveList += `  *${i + 1}.* ${j.name}${j.buff ? ' 💫' : ''}${j.nature ? ` ${natureTag(j.nature)}` : ''} (💧${j.cost}) — ⟳${jutsuPp[id]}/${j.pp ?? '∞'}\n`;
                });

                const screen =
                    `⚔️ *${RANK_LABELS[tier]} BATTLE!* ⚔️\n\n` +
                    `${enemy.emoji} *${enemy.name}*${enemy.nature ? ` ${natureTag(enemy.nature)}` : ''}\n${hpBar(enemy.hp.max, enemy.hp.max)}\n\n` +
                    `🆚\n\n` +
                    `${ps.emoji} *${user.username}*${char.nature ? ` ${natureTag(char.nature)}` : ''}\n${hpBar(user.hp.current, user.hp.max)}\n${chakraBar(user.chakra.current, user.chakra.max)}\n\n` +
                    `🥋 *Your jutsus:*\n${moveList}` +
                    `  *0.* Basic Strike (taijutsu, unlimited)\n\n` +
                    `_Reply *!use [number]* to strike, *!item [name]* to use an item (!bag to check what you've got), or *!flee* to retreat._`;

                const cardBuf = await renderBattleCard({
                    p1: { name: user.username, hp: user.hp.current, maxHp: user.hp.max, chakra: user.chakra.current, maxChakra: user.chakra.max, imageName: getCharacterImage(user.character), emoji: ps.emoji },
                    p2: { name: enemy.name, hp: enemy.hp.max, maxHp: enemy.hp.max, imageName: enemy.image, emoji: enemy.emoji },
                    round: 1,
                    title: `${RANK_LABELS[tier]} BATTLE`,
                }).catch(() => null);

                await conn.sendMessage(from, prepareImagePayloadFromBuffer(cardBuf, screen));

                // Quick-action buttons for first move — show top 2 equipped jutsus + flee
                const quickBtns = battleButtons(
                    user.equippedJutsus.map((id, i) => {
                        const j = char.jutsus.find(x => x.id === id);
                        return j ? { name: j.name, cost: j.cost, pp: jutsuPp[id] } : null;
                    }).filter(Boolean),
                    1
                );
                return await conn.sendMessage(from, buttonMessage(
                    '⚔️ Choose your first move:',
                    [...quickBtns.slice(0, 2), { label: '💨 Flee', id: '!flee' }]
                ));
            }

            // ════════════════════════════════════════════════════════════════
            // USE JUTSU IN BATTLE
            // ════════════════════════════════════════════════════════════════
            case 'use':
            case 'atk':
            case 'attack': {
                if (!user || !activeFights.has(senderJid)) {
                    return await conn.sendMessage(from, { text: `❌ You're not in a battle. Start one with !battle d` });
                }
                const fight = activeFights.get(senderJid);

                // ─────────────────────────────────────────────────────────
                // PvP DUEL — simultaneous resolution. Whoever submits second
                // triggers the round; both moves are computed off the SAME
                // pre-round stat snapshot, so neither player can react to or
                // benefit from seeing the other's move first.
                // ─────────────────────────────────────────────────────────
                if (fight.type === 'pvp') {
                    const mySlot  = fight.p1.jid === senderJid ? 'p1' : 'p2';
                    const oppSlot = mySlot === 'p1' ? 'p2' : 'p1';
                    const me  = fight[mySlot];
                    const myChar = getCharacter(user.character);

                    if (!args[0]) {
                        let statusList = `🥋 *Move status — Round ${fight.round}*\n\n`;
                        user.equippedJutsus.forEach((id, i) => {
                            const j = myChar.jutsus.find(x => x.id === id);
                            if (!j) return;
                            const left = me.jutsuPp[id] ?? 0;
                            statusList += `  *${i + 1}.* ${j.name}${j.buff ? ' 💫' : ''}${j.nature ? ` ${natureTag(j.nature)}` : ''} (💧${j.cost}) — ⟳${left}/${j.pp ?? '∞'}${left <= 0 ? ' ❌ EMPTY' : ''}\n`;
                        });
                        statusList += `  *0.* Basic Strike (taijutsu, unlimited)\n\n_!use [number] to lock in your move_`;
                        return await conn.sendMessage(from, { text: statusList });
                    }

                    if (fight.pending[mySlot]) {
                        return await conn.sendMessage(from, { text: `⏳ You already locked in your move this round. Waiting on ${fight[oppSlot].username}...` });
                    }

                    const isBasic = args[0] === '0' || args[0].toLowerCase() === 'basic';
                    const idx = parseInt(args[0]) - 1;
                    const jutsuId = !isBasic ? user.equippedJutsus[idx] : null;
                    const jutsu = jutsuId ? myChar.jutsus.find(j => j.id === jutsuId) : null;

                    if (!isBasic && !jutsu) {
                        return await conn.sendMessage(from, { text: `❌ Invalid move. Use !use 1, or !use 0 for Basic Strike.` });
                    }
                    if (!isBasic && (me.jutsuPp[jutsu.id] ?? 0) <= 0) {
                        return await conn.sendMessage(from, { text: `❌ *${jutsu.name}* is out of PP! Pick another move, or !use 0.` });
                    }
                    if (!isBasic && user.chakra.current < jutsu.cost) {
                        return await conn.sendMessage(from, { text: `❌ Not enough chakra for *${jutsu.name}* (need ${jutsu.cost}, have ${user.chakra.current}).` });
                    }

                    if (!isBasic) {
                        user.chakra.current -= jutsu.cost;
                        me.jutsuPp[jutsu.id] -= 1;
                    }
                    await user.save();

                    fight.pending[mySlot] = {
                        moveName: isBasic ? 'Basic Strike' : jutsu.name,
                        moveDamage: isBasic ? 50 : jutsu.damage,
                        moveNature: isBasic ? null : jutsu.nature,
                        moveBuff: isBasic ? null : jutsu.buff,
                    };

                    // Inline fallback in case of partial deploy where pickPvpBotMove isn't exported yet
                    const _botPicker = typeof pickPvpBotMove === 'function'
                        ? pickPvpBotMove
                        : (jutsus, pp, chakra) => {
                            const usable = jutsus.filter(j => (pp[j.id] ?? 0) > 0 && j.cost <= chakra);
                            return usable.length ? usable[Math.floor(Math.random() * usable.length)] : null;
                        };

                    if (fight.isBot && !fight.pending[oppSlot]) {
                        const botChar = getCharacter(fight.p2.character);
                        const botJutsus = botChar.jutsus.filter(j => fight.p2.jutsuPp[j.id] !== undefined);
                        const botJutsu = _botPicker(botJutsus, fight.p2.jutsuPp, fight.botChakra);
                        if (botJutsu) {
                            fight.botChakra -= botJutsu.cost;
                            fight.p2.jutsuPp[botJutsu.id] -= 1;
                        }
                        fight.pending[oppSlot] = {
                            moveName: botJutsu ? botJutsu.name : 'Basic Strike',
                            moveDamage: botJutsu ? botJutsu.damage : 50,
                            moveNature: botJutsu ? botJutsu.nature : null,
                            moveBuff: botJutsu ? botJutsu.buff : null,
                        };
                    }

                    if (!fight.pending[oppSlot]) {
                        return await conn.sendMessage(from, { text: `✅ *${me.username}* locked in their move! Waiting for *${fight[oppSlot].username}*...` });
                    }

                    // Both moves are in — resolve the round
                    const p1User = await User.findOne({ phoneId: fight.p1.jid });
                    const p2User = fight.isBot
                        ? { username: fight.p2.username, hp: { current: fight.botHp, max: fight.botMaxHp }, chakra: { current: fight.botChakra, max: fight.botMaxChakra }, character: fight.p2.character, level: user.level, clanRole: null }
                        : await User.findOne({ phoneId: fight.p2.jid });
                    const base1 = getEffectiveStats(p1User, fight.p1.buffs);
                    const base2 = getEffectiveStats(p2User, fight.p2.buffs);
                    // Pre-round snapshot — buffs cast THIS round get registered below but
                    // never feed into ps1/ps2 below, satisfying the non-retroactive rule.
                    const ps1 = mergeStatBonuses({ ...base1 }, fight.effects, 'p1');
                    const ps2 = mergeStatBonuses({ ...base2 }, fight.effects, 'p2');

                    const m1 = fight.pending.p1;
                    const m2 = fight.pending.p2;
                    let log = `⚔️ *Round ${fight.round} Results*\n\n`;

                    const resolveSide = (mover, moverPs, moverUser, moverSlot, moverOtherSlot, target, targetPs, targetUser, move) => {
                        if (isStunned(fight.effects, moverSlot)) {
                            log += `😵 ${mover.username} is stunned and can't act!\n`;
                            consumeStun(fight.effects, moverSlot);
                            return;
                        }
                        if (move.moveBuff) {
                            if (move.moveBuff.hp) {
                                const before = moverUser.hp.current;
                                moverUser.hp.current = Math.min(moverUser.hp.max, moverUser.hp.current + move.moveBuff.hp);
                                log += `${mover.username} uses *${move.moveName}* — 💚 healed ${moverUser.hp.current - before} HP!\n`;
                            } else {
                                log += `${mover.username} uses *${move.moveName}*!\n`;
                            }
                            log += applyBuff(fight.effects, moverSlot, moverOtherSlot, move.moveBuff, mover.username);
                            return;
                        }
                        const hit = resolveHit(moverPs, targetPs, move.moveDamage, move.moveNature);
                        if (move.moveDamage < 0) {
                            moverUser.hp.current = Math.min(moverUser.hp.max, moverUser.hp.current + hit.healed);
                            log += `${mover.username} uses *${move.moveName}* — 💚 healed ${hit.healed} HP!\n`;
                        } else if (hit.dodged) {
                            log += `${mover.username} uses *${move.moveName}* — 👻 ${target.username} dodged!\n`;
                        } else {
                            targetUser.hp.current -= hit.dealt;
                            log += `${mover.username} uses *${move.moveName}* — ${hit.crit ? '💥CRIT ' : ''}${hit.dealt} dmg${hit.natureLabel ? ` ${hit.natureLabel}` : ''}!\n`;

                            const reflectPct = fight.effects[moverOtherSlot].reflect;
                            if (reflectPct > 0) {
                                const reflected = Math.floor(hit.dealt * (reflectPct / 100));
                                if (reflected > 0) {
                                    moverUser.hp.current -= reflected;
                                    log += `🪞 ${target.username}'s reflect bounces ${reflected} dmg back at ${mover.username}!\n`;
                                }
                            }
                        }
                    };

                    resolveSide(fight.p1, ps1, p1User, 'p1', 'p2', fight.p2, ps2, p2User, m1);
                    resolveSide(fight.p2, ps2, p2User, 'p2', 'p1', fight.p1, ps1, p1User, m2);

                    tickStatBuffs(fight.effects, 'p1');
                    tickStatBuffs(fight.effects, 'p2');
                    fight.pending.p1 = null;
                    fight.pending.p2 = null;
                    fight.round += 1;

                    const p1Dead = p1User.hp.current <= 0;
                    const p2Dead = p2User.hp.current <= 0;

                    // ── Bot fight: practice mode, no rank/Ryo stakes, no fake DB writes ──
                    if (fight.isBot) {
                        if (p1Dead || p2Dead) {
                            activeFights.delete(fight.p1.jid);
                            if (p1Dead && p2Dead) {
                                p1User.hp.current = 1;
                                await p1User.save();
                                return await conn.sendMessage(fight.from, { text: `${log}\n🤝 *DOUBLE KO!* Even trade with your Shadow Clone.\n_(Practice match — no rank/Ryo change.)_` });
                            }
                            if (p1Dead) {
                                p1User.hp.current = 1;
                                await p1User.save();
                                return await conn.sendMessage(fight.from, { text: `${log}\n💀 *Your Shadow Clone got the better of you.*\n_(Practice match — no rank/Ryo penalty. Try again with !duel bot.)_` });
                            }
                            const { rewards } = await addXP(p1User, 40);
                            await p1User.save();
                            log += `\n🏆 *You defeated your Shadow Clone!*\n📈 +40 XP\n_(Practice match — no Ryo/rank change.)_`;
                            if (rewards.length) log += `\n🎉 Leveled up to ${p1User.level}!`;
                            return await conn.sendMessage(fight.from, { text: log });
                        }

                        fight.botHp = p2User.hp.current;
                        fight.botChakra = p2User.chakra.current;
                        await p1User.save();
                        log += `\n${fight.p1.username}: ${hpBar(p1User.hp.current, p1User.hp.max)}\n${fight.p2.username}: ${hpBar(fight.botHp, fight.botMaxHp)}\n\n_Round ${fight.round} — !use again_`;

                        const botRoundCard = await renderBattleCard({
                            p1: { name: fight.p1.username, hp: p1User.hp.current, maxHp: p1User.hp.max, chakra: p1User.chakra.current, maxChakra: p1User.chakra.max, imageName: getCharacterImage(p1User.character), emoji: '🥋', stunned: isStunned(fight.effects, 'p1') },
                            p2: { name: fight.p2.username, hp: fight.botHp, maxHp: fight.botMaxHp, imageName: getCharacterImage(fight.p2.character), emoji: '🥷', stunned: isStunned(fight.effects, 'p2') },
                            round: fight.round,
                        }).catch(() => null);

                        return await conn.sendMessage(fight.from, prepareImagePayloadFromBuffer(botRoundCard, log));
                    }

                    if (p1Dead || p2Dead) {
                        activeFights.delete(fight.p1.jid);
                        activeFights.delete(fight.p2.jid);

                        if (p1Dead && p2Dead) {
                            p1User.hp.current = 1; p2User.hp.current = 1;
                            p1User.losses = (p1User.losses || 0) + 1; p2User.losses = (p2User.losses || 0) + 1;
                            p1User.winStreak = 0; p2User.winStreak = 0;
                            await Promise.all([p1User.save(), p2User.save()]);
                            return await conn.sendMessage(fight.from, { text: `${log}\n🤝 *DOUBLE KNOCKOUT!* Both fighters go down — it's a draw. No rank points change.` });
                        }

                        const winner = p1Dead ? p2User : p1User;
                        const loser  = p1Dead ? p1User : p2User;
                        loser.hp.current = 1;
                        winner.wins = (winner.wins || 0) + 1;
                        winner.winStreak = (winner.winStreak || 0) + 1;
                        winner.rankPoints = (winner.rankPoints || 0) + 25;
                        winner.ryo += 800;
                        loser.losses = (loser.losses || 0) + 1;
                        loser.winStreak = 0;
                        loser.rankPoints = Math.max(0, (loser.rankPoints || 0) - 15);
                        const { rewards } = await addXP(winner, 120);
                        await addXP(loser, 30);
                        await Promise.all([winner.save(), loser.save()]);

                        log += `\n🏆 *${winner.username} WINS!*\n💰 +800 Ryo | 📈 +120 XP | 🏅 +25 Arena Points for ${winner.username}\n📈 +30 XP (consolation) | 🏅 -15 Arena Points for ${loser.username}`;
                        if (rewards.length) log += `\n🎉 ${winner.username} leveled up to ${winner.level}!`;
                        return await conn.sendMessage(fight.from, { text: log });
                    }

                    await Promise.all([p1User.save(), p2User.save()]);
                    log += `\n${fight.p1.username}: ${hpBar(p1User.hp.current, p1User.hp.max)}\n${fight.p2.username}: ${hpBar(p2User.hp.current, p2User.hp.max)}\n\n_Round ${fight.round} — both fighters !use again_`;

                    const pvpRoundCard = await renderBattleCard({
                        p1: { name: fight.p1.username, hp: p1User.hp.current, maxHp: p1User.hp.max, chakra: p1User.chakra.current, maxChakra: p1User.chakra.max, imageName: getCharacterImage(p1User.character), emoji: '🥋', stunned: isStunned(fight.effects, 'p1') },
                        p2: { name: fight.p2.username, hp: p2User.hp.current, maxHp: p2User.hp.max, chakra: p2User.chakra.current, maxChakra: p2User.chakra.max, imageName: getCharacterImage(p2User.character), emoji: '🥷', stunned: isStunned(fight.effects, 'p2') },
                        round: fight.round,
                        title: 'PvP DUEL',
                    }).catch(() => null);

                    return await conn.sendMessage(fight.from, prepareImagePayloadFromBuffer(pvpRoundCard, log));
                }

                if (!user || !activeFights.has(senderJid)) {
                    return await conn.sendMessage(from, { text: `❌ You're not in a battle. Start one with !battle d` });
                }
                const char = getCharacter(user.character);

                // !use with no argument -> show live PP/chakra status instead of erroring
                if (!args[0]) {
                    let statusList = `🥋 *Move status — Round ${fight.round}*\n\n`;
                    user.equippedJutsus.forEach((id, i) => {
                        const j = char.jutsus.find(x => x.id === id);
                        if (!j) return;
                        const left = fight.jutsuPp[id] ?? 0;
                        statusList += `  *${i + 1}.* ${j.name}${j.buff ? ' 💫' : ''}${j.nature ? ` ${natureTag(j.nature)}` : ''} (💧${j.cost}) — ⟳${left}/${j.pp ?? '∞'}${left <= 0 ? ' ❌ EMPTY' : ''}\n`;
                    });
                    statusList += `  *0.* Basic Strike (taijutsu, unlimited)\n\n_!use [number] to act_`;
                    return await conn.sendMessage(from, { text: statusList });
                }

                const isBasic = args[0] === '0' || args[0].toLowerCase() === 'basic';
                const idx = parseInt(args[0]) - 1;
                const jutsuId = !isBasic ? user.equippedJutsus[idx] : null;
                const jutsu = jutsuId ? char.jutsus.find(j => j.id === jutsuId) : null;

                if (!isBasic && !jutsu) {
                    return await conn.sendMessage(from, { text: `❌ Invalid move. You have ${user.equippedJutsus.length} jutsu(s). Use !use 1, or !use 0 for Basic Strike.` });
                }
                if (!isBasic && (fight.jutsuPp[jutsu.id] ?? 0) <= 0) {
                    return await conn.sendMessage(from, { text: `❌ *${jutsu.name}* is out of PP for this battle! Pick another move, or !use 0 for Basic Strike.` });
                }
                if (!isBasic && user.chakra.current < jutsu.cost) {
                    return await conn.sendMessage(from, { text: `❌ Not enough chakra for *${jutsu.name}* (need ${jutsu.cost}, have ${user.chakra.current}).\nTry a cheaper jutsu, !use 0 for Basic Strike, or !item soldier pill.` });
                }

                const buffs = await getClanBuffs(user);
                const baseSelf = getEffectiveStats(user, buffs);
                const baseEnemy = {
                    attack: fight.enemyStats.attack, defense: fight.enemyStats.defense,
                    crit: fight.enemyStats.crit, dodge: 0, lifesteal: 0, nature: fight.enemyNature,
                };
                // Stat bonuses from buffs cast in PREVIOUS rounds.
                const psBase = mergeStatBonuses({ ...baseSelf }, fight.effects, 'self');
                const enemyCombatant = mergeStatBonuses({ ...baseEnemy }, fight.effects, 'enemy');
                // Tailed Beast stat boosts (Jinchuriki only)
                const bijuu = getBijuu(user.character);
                const psAfterBijuu = bijuu ? applyBijuuStats(psBase, bijuu, fight.bijuuState) : psBase;
                // Dojutsu passive stat boosts on top (dodge/crit bonuses)
                const ps = fight.dojutsuState
                    ? applyDojutsuStats(psAfterBijuu, user.character, fight.dojutsuState)
                    : psAfterBijuu;

                const moveName = isBasic ? 'Basic Strike' : jutsu.name;
                const moveDamage = isBasic ? 50 : jutsu.damage;
                const moveNature = isBasic ? null : jutsu.nature;
                const moveBuff = isBasic ? null : jutsu.buff;

                if (!isBasic) {
                    user.chakra.current -= jutsu.cost;
                    fight.jutsuPp[jutsu.id] -= 1;
                }
                let log = '';

                if (moveBuff) {
                    // Pure status move (these all deal 0 damage) — instant heal applies
                    // now, stun gates the enemy starting THIS round, stat buffs/reflect
                    // register for next round.
                    if (moveBuff.hp) {
                        const before = user.hp.current;
                        user.hp.current = Math.min(user.hp.max, user.hp.current + moveBuff.hp);
                        log += `${ps.emoji} You use *${moveName}* — 💚 healed ${user.hp.current - before} HP!\n`;
                    } else {
                        log += `${ps.emoji} You use *${moveName}*!\n`;
                    }
                    log += applyBuff(fight.effects, 'self', 'enemy', moveBuff, user.username);
                } else {
                    // Player's action
                    const pHit = resolveHit(ps, enemyCombatant, moveDamage, moveNature);
                    if (moveDamage < 0) {
                        user.hp.current = Math.min(user.hp.max, user.hp.current + pHit.healed);
                        log += `${ps.emoji} You use *${moveName}* — 💚 healed ${pHit.healed} HP!\n`;
                    } else if (pHit.dodged) {
                        log += `${ps.emoji} You use *${moveName}* — 👻 ${fight.enemyName} dodged!\n`;
                    } else {
                        fight.enemyHp -= pHit.dealt;
                        if (pHit.healed) user.hp.current = Math.min(user.hp.max, user.hp.current + pHit.healed);
                        log += `${ps.emoji} You use *${moveName}* — ${pHit.crit ? '💥CRIT ' : ''}${pHit.dealt} dmg${pHit.natureLabel ? ` ${pHit.natureLabel}` : ''}${pHit.healed ? ` (🩸+${pHit.healed})` : ''}!\n`;
                    }
                }
                if (!isBasic && fight.jutsuPp[jutsu.id] === 0) log += `_(${jutsu.name} is now out of PP!)_\n`;

                // Dojutsu on-hit passives (Itachi genjutsu, Byakugan chakra seal, Kakashi auto-copy)
                if (fight.dojutsuState && !moveBuff && moveDamage > 0) {
                    const { log: dhLog } = onHitPassives(user.character, fight.dojutsuState, user, fight, 0);
                    log += dhLog;
                }

                // Win check #1 — after the player's own action
                if (fight.enemyHp <= 0) {
                    activeFights.delete(senderJid);
                    return await finishPveWin(conn, from, user, fight, log);
                }

                // Enemy's action — skipped entirely if stunned
                if (isStunned(fight.effects, 'enemy')) {
                    log += `😵 ${fight.enemyName} is stunned and can't move!\n`;
                    consumeStun(fight.effects, 'enemy');
                } else {
                    const eMove = enemyChooseMove(fight, fight.enemyHp, fight.enemyMaxHp, fight.enemyPp);
                    if (fight.enemyPp[eMove.name] > 0) fight.enemyPp[eMove.name] -= 1;
                    // Record enemy move for Sharingan copy
                    if (fight.dojutsuState) {
                        fight.lastEnemyMove = { name: eMove.name, damage: eMove.damage, cost: 50, nature: eMove.nature };
                    }
                    const eHit = resolveHit(enemyCombatant, ps, eMove.damage, eMove.nature);
                    if (eMove.damage < 0) {
                        fight.enemyHp = Math.min(fight.enemyMaxHp, fight.enemyHp + eHit.healed);
                        log += `${fight.enemyEmoji} ${fight.enemyName} uses _${eMove.name}_ — 💚 healed ${eHit.healed} HP!\n`;
                    } else if (eHit.dodged) {
                        log += `${fight.enemyEmoji} ${fight.enemyName} uses _${eMove.name}_ — 👻 you dodged!\n`;
                    } else {
                        // Dojutsu on-receive: Rinnegan absorb / Obito phase-through
                        let dojutsuBlocked = false;
                        if (fight.dojutsuState) {
                            const { absorbed, log: drLog } = onReceiveHit(user.character, fight.dojutsuState, user, fight, eMove);
                            log += drLog;
                            if (absorbed) dojutsuBlocked = true;
                        }
                        // Gaara Sand Shield — negate one hit completely
                        if (!dojutsuBlocked && checkSandShield(fight)) {
                            log += `🏜️ *Sand Shield!* Shukaku's sand negates ${fight.enemyName}'s ${eMove.name} completely!\n`;
                            dojutsuBlocked = true;
                        }
                        if (!dojutsuBlocked) {
                            user.hp.current -= eHit.dealt;
                            log += `${fight.enemyEmoji} ${fight.enemyName} uses _${eMove.name}_ — ${eHit.crit ? '💥CRIT ' : ''}${eHit.dealt} dmg${eHit.natureLabel ? ` ${eHit.natureLabel}` : ''}!\n`;

                            // Reflect
                            if (fight.effects.self.reflect > 0) {
                                const reflected = Math.floor(eHit.dealt * (fight.effects.self.reflect / 100));
                                if (reflected > 0) {
                                    fight.enemyHp -= reflected;
                                    log += `🪞 Reflected ${reflected} dmg back at ${fight.enemyName}!\n`;
                                }
                            }

                            // Auto-transform check — triggers if HP falls below 20%
                            if (bijuu) {
                                const { triggered, msg: beastMsg } = checkAutoTransform(user, fight);
                                if (triggered) log += beastMsg;
                            }
                        }
                    }
                }

                // Win check #2 — re-verified, since reflect damage from the enemy's
                // own attack can kill it after win check #1 already passed
                if (fight.enemyHp <= 0) {
                    activeFights.delete(senderJid);
                    return await finishPveWin(conn, from, user, fight, log);
                }

                // Count down active stat buffs/reflect for both sides
                tickStatBuffs(fight.effects, 'self');
                tickStatBuffs(fight.effects, 'enemy');

                // Tailed Beast passives — per-turn effects (heal, ink stun, etc.)
                if (bijuu && fight.bijuuState.active) {
                    log += tickBijuuPassive(user, fight, bijuu);
                }

                // Dojutsu per-turn passives (DoT burns, Byakugan reveal, Rinnegan drain)
                if (fight.dojutsuState) {
                    log += tickDojutsuPassives(user.character, fight.dojutsuState, user, fight);
                }

                // Chakra Mode countdown — crash + exhaustion when it expires
                if (bijuu && fight.bijuuState.chakraMode) {
                    const { ended, crashMsg, remainMsg } = tickChakraMode(user, fight, bijuu);
                    if (ended) log += crashMsg;
                    else if (remainMsg) log += remainMsg;
                }
                tickExhaustion(fight);

                fight.round += 1;

                // Lose check
                if (user.hp.current <= 0) {
                    user.hp.current = 1;
                    user.losses = (user.losses || 0) + 1;
                    user.winStreak = 0;
                    user.lastBattle = new Date();
                    await user.save();
                    activeFights.delete(senderJid);
                    return await conn.sendMessage(from, prepareImagePayload(getBattleImage(user.character),
                        `${log}\n💀 *DEFEAT!*\n\nYou were beaten by ${fight.enemyEmoji} ${fight.enemyName}.\n❤️ Clinging to life at 1 HP. Heal up and try again!`
                    ));
                }

                await user.save();
                activeFights.set(senderJid, fight);

                const screen =
                    `${log}\n` +
                    `${fight.enemyEmoji} *${fight.enemyName}*\n${hpBar(fight.enemyHp, fight.enemyMaxHp)}\n\n` +
                    `${ps.emoji} *${user.username}*\n${hpBar(user.hp.current, user.hp.max)}\n${chakraBar(user.chakra.current, user.chakra.max)}\n\n` +
                    `_Round ${fight.round} — !use [n], !use for PP status, !item [name], or !flee_`;

                const cardBuf = await renderBattleCard({
                    p1: { name: user.username, hp: user.hp.current, maxHp: user.hp.max, chakra: user.chakra.current, maxChakra: user.chakra.max, imageName: getCharacterImage(user.character), emoji: ps.emoji, stunned: isStunned(fight.effects, 'self') },
                    p2: { name: fight.enemyName, hp: fight.enemyHp, maxHp: fight.enemyMaxHp, imageName: fight.enemyImage, emoji: fight.enemyEmoji, stunned: isStunned(fight.effects, 'enemy') },
                    round: fight.round,
                }).catch(() => null);

                await conn.sendMessage(from, prepareImagePayloadFromBuffer(cardBuf, screen));

                // Quick-action buttons for next move
                const roundChar = getCharacter(user.character);
                const usableJutsus = user.equippedJutsus
                    .map((id, i) => {
                        const j = roundChar.jutsus.find(x => x.id === id);
                        const ppLeft = fight.jutsuPp?.[id] ?? 0;
                        return j && ppLeft > 0 ? { name: `${j.name} ⟳${ppLeft}`, cost: j.cost, pp: ppLeft, idx: i + 1 } : null;
                    })
                    .filter(Boolean);
                const roundBtns = usableJutsus.slice(0, 2).map(j => ({ label: j.name, id: `!use ${j.idx}` }));
                roundBtns.push({ label: '💨 Flee', id: '!flee' });
                return await conn.sendMessage(from, buttonMessage('⚔️ Next move:', roundBtns));
            }

            // ════════════════════════════════════════════════════════════════
            // FLEE
            // ════════════════════════════════════════════════════════════════
            case 'flee':
            case 'run': {
                if (!activeFights.has(senderJid)) {
                    return await conn.sendMessage(from, { text: `❌ You're not in a battle.` });
                }
                const fleeFight = activeFights.get(senderJid);

                if (fleeFight.type === 'pvp') {
                    const mySlot  = fleeFight.p1.jid === senderJid ? 'p1' : 'p2';
                    const oppSlot = mySlot === 'p1' ? 'p2' : 'p1';
                    activeFights.delete(fleeFight.p1.jid);
                    activeFights.delete(fleeFight.p2.jid);

                    if (fleeFight.isBot) {
                        if (user) { user.lastBattle = new Date(); await user.save(); }
                        return await conn.sendMessage(fleeFight.from, {
                            text: `💨 *You retreated from your Shadow Clone.*\n_(Practice match — no rank/Ryo penalty. Try again with !duel bot.)_`
                        });
                    }

                    const fleeUser = await User.findOne({ phoneId: fleeFight[mySlot].jid });
                    const oppUser  = await User.findOne({ phoneId: fleeFight[oppSlot].jid });
                    if (fleeUser) { fleeUser.losses = (fleeUser.losses || 0) + 1; fleeUser.winStreak = 0; fleeUser.rankPoints = Math.max(0, (fleeUser.rankPoints || 0) - 15); await fleeUser.save(); }
                    if (oppUser)  { oppUser.wins = (oppUser.wins || 0) + 1; oppUser.winStreak = (oppUser.winStreak || 0) + 1; oppUser.rankPoints = (oppUser.rankPoints || 0) + 25; oppUser.ryo += 800; await oppUser.save(); }

                    return await conn.sendMessage(fleeFight.from, {
                        text: `💨 *${fleeFight[mySlot].username} fled the duel!*\n\n🏆 ${fleeFight[oppSlot].username} wins by default — 💰 +800 Ryo | 🏅 +25 Arena Points`
                    });
                }

                activeFights.delete(senderJid);
                if (user) { user.lastBattle = new Date(); await user.save(); }
                return await conn.sendMessage(from, { text: `💨 *You fled the battle!*\n\nNo rewards earned, but you live to fight another day.` });
            }

            // ════════════════════════════════════════════════════════════════
            // USE ITEM IN BATTLE  (costs your turn — enemy retaliates)
            // ════════════════════════════════════════════════════════════════
            case 'item': {
                if (!user || !activeFights.has(senderJid)) {
                    return await conn.sendMessage(from, { text: `❌ You're not in a battle. Use items with !useitem outside combat.` });
                }
                const fight = activeFights.get(senderJid);
                if (fight.type === 'pvp') {
                    return await conn.sendMessage(from, { text: `❌ Items aren't usable mid-duel yet — only jutsu (!use). Coming soon!` });
                }
                if (!rawText) return await conn.sendMessage(from, { text: `❌ Usage: !item [name]` });

                const item = findItem(rawText);
                if (!item || !item.usableInBattle) {
                    return await conn.sendMessage(from, { text: `❌ You can only use battle items in battle.` });
                }
                const slotIdx = user.inventory.findIndex(it => it.itemId === item.id);
                if (slotIdx === -1) return await conn.sendMessage(from, { text: `❌ You don't own a ${item.name}.` });

                let log = '';
                if (item.effect.fullHeal) {
                    user.hp.current = user.hp.max; user.chakra.current = user.chakra.max;
                    log += `${item.emoji} You use *${item.name}* — ✨ fully restored!\n`;
                } else {
                    if (item.effect.hp)      { const b = user.hp.current; user.hp.current = Math.min(user.hp.max, user.hp.current + item.effect.hp); log += `${item.emoji} You use *${item.name}* — 💚 +${user.hp.current - b} HP\n`; }
                    if (item.effect.chakra) { const b = user.chakra.current; user.chakra.current = Math.min(user.chakra.max, user.chakra.current + item.effect.chakra); log += `${item.emoji} +${user.chakra.current - b} Chakra\n`; }
                }
                user.inventory[slotIdx].qty -= 1;
                if (user.inventory[slotIdx].qty <= 0) user.inventory.splice(slotIdx, 1);

                // Enemy still gets its turn — respects active stun/buffs/reflect, same as !use
                const buffs = await getClanBuffs(user);
                const baseSelf = getEffectiveStats(user, buffs);
                const baseEnemy = { attack: fight.enemyStats.attack, defense: fight.enemyStats.defense, crit: fight.enemyStats.crit, dodge: 0, lifesteal: 0, nature: fight.enemyNature };
                const ps = mergeStatBonuses({ ...baseSelf }, fight.effects, 'self');
                const enemyCombatant = mergeStatBonuses({ ...baseEnemy }, fight.effects, 'enemy');

                if (isStunned(fight.effects, 'enemy')) {
                    log += `😵 ${fight.enemyName} is stunned and can't move!\n`;
                    consumeStun(fight.effects, 'enemy');
                } else {
                    const eMove = enemyChooseMove(fight, fight.enemyHp, fight.enemyMaxHp, fight.enemyPp);
                    if (fight.enemyPp[eMove.name] > 0) fight.enemyPp[eMove.name] -= 1;
                    const eHit = resolveHit(enemyCombatant, ps, eMove.damage, eMove.nature);
                    if (eMove.damage < 0) {
                        fight.enemyHp = Math.min(fight.enemyMaxHp, fight.enemyHp + eHit.healed);
                        log += `${fight.enemyEmoji} ${fight.enemyName} uses _${eMove.name}_ — 💚 healed ${eHit.healed}!\n`;
                    } else if (eHit.dodged) {
                        log += `${fight.enemyEmoji} ${fight.enemyName} uses _${eMove.name}_ — 👻 you dodged!\n`;
                    } else {
                        user.hp.current -= eHit.dealt;
                        log += `${fight.enemyEmoji} ${fight.enemyName} uses _${eMove.name}_ — ${eHit.crit ? '💥CRIT ' : ''}${eHit.dealt} dmg${eHit.natureLabel ? ` ${eHit.natureLabel}` : ''}!\n`;

                        if (fight.effects.self.reflect > 0) {
                            const reflected = Math.floor(eHit.dealt * (fight.effects.self.reflect / 100));
                            if (reflected > 0) {
                                fight.enemyHp -= reflected;
                                log += `🪞 Reflected ${reflected} dmg back at ${fight.enemyName}!\n`;
                            }
                        }
                    }
                }

                // Win check — reflect from the enemy's own attack can kill it here
                if (fight.enemyHp <= 0) {
                    activeFights.delete(senderJid);
                    return await finishPveWin(conn, from, user, fight, log);
                }

                tickStatBuffs(fight.effects, 'self');
                tickStatBuffs(fight.effects, 'enemy');
                fight.round += 1;

                if (user.hp.current <= 0) {
                    user.hp.current = 1; user.losses = (user.losses || 0) + 1; user.winStreak = 0;
                    user.lastBattle = new Date(); await user.save();
                    activeFights.delete(senderJid);
                    return await conn.sendMessage(from, { text: `${log}\n💀 *DEFEAT!* You fell at 1 HP.` });
                }
                await user.save();
                activeFights.set(senderJid, fight);

                const itemScreen = `${log}\n${fight.enemyEmoji} *${fight.enemyName}*\n${hpBar(fight.enemyHp, fight.enemyMaxHp)}\n\n` +
                          `${ps.emoji} *${user.username}*\n${hpBar(user.hp.current, user.hp.max)}\n${chakraBar(user.chakra.current, user.chakra.max)}\n\n` +
                          `_Round ${fight.round} — !use [n], !item [name], or !flee_`;

                const itemCardBuf = await renderBattleCard({
                    p1: { name: user.username, hp: user.hp.current, maxHp: user.hp.max, chakra: user.chakra.current, maxChakra: user.chakra.max, imageName: getCharacterImage(user.character), emoji: ps.emoji, stunned: isStunned(fight.effects, 'self') },
                    p2: { name: fight.enemyName, hp: fight.enemyHp, maxHp: fight.enemyMaxHp, imageName: fight.enemyImage, emoji: fight.enemyEmoji, stunned: isStunned(fight.effects, 'enemy') },
                    round: fight.round,
                }).catch(() => null);

                return await conn.sendMessage(from, prepareImagePayloadFromBuffer(itemCardBuf, itemScreen));
            }

            // ════════════════════════════════════════════════════════════════
            // DUEL  (PvP — simulated full battle vs another player)
            // ════════════════════════════════════════════════════════════════
            case 'duel':
            case 'pvp': {
                if (!user || user.registrationStep !== 'COMPLETED') {
                    return await conn.sendMessage(from, { text: '❌ Register first! Type !start.' });
                }
                if (!args[0]) {
                    return await conn.sendMessage(from, { text: `🤺 *PvP DUEL*\n\nUsage: !duel [player name]\nExample: !duel Naruto99\n\n_They'll need to !accept before the fight starts. Win to climb arena rankings!_\n\n_Want to practice solo first? !duel bot_` });
                }
                if (activeFights.has(senderJid)) {
                    return await conn.sendMessage(from, { text: `❌ You're already mid-battle. Finish that first.` });
                }
                if (user.hp.current <= 1) {
                    return await conn.sendMessage(from, { text: `🏥 Too injured to duel! Heal up first.` });
                }

                // ── Practice mode: instant match against a Shadow Clone of yourself ──
                if (args[0].toLowerCase() === 'bot') {
                    const char = getCharacter(user.character);
                    const p1Pp = {};
                    user.equippedJutsus.forEach(id => { p1Pp[id] = char.jutsus.find(j => j.id === id)?.pp ?? 99; });
                    const p2Pp = {};
                    user.equippedJutsus.forEach(id => { p2Pp[id] = char.jutsus.find(j => j.id === id)?.pp ?? 99; });
                    const buffs = await getClanBuffs(user);
                    const freshEffects = initFightEffects(); // {self, enemy} -> remap to {p1, p2}

                    activeFights.set(senderJid, {
                        type: 'pvp',
                        isBot: true,
                        from,
                        round: 1,
                        p1: { jid: senderJid, username: user.username, buffs, jutsuPp: p1Pp },
                        p2: { jid: `BOT::${senderJid}`, username: `${user.username}'s Shadow Clone`, character: user.character, buffs: {}, jutsuPp: p2Pp },
                        botHp: user.hp.max, botMaxHp: user.hp.max,
                        botChakra: user.chakra.max, botMaxChakra: user.chakra.max,
                        pending: { p1: null, p2: null },
                        effects: { p1: freshEffects.self, p2: freshEffects.enemy },
                        bijuuState: initBijuuState(),
                    });

                    const botCardBuf = await renderBattleCard({
                        p1: { name: user.username, hp: user.hp.max, maxHp: user.hp.max, chakra: user.chakra.max, maxChakra: user.chakra.max, imageName: getCharacterImage(user.character), emoji: '🥋' },
                        p2: { name: `${user.username}'s Shadow Clone`, hp: user.hp.max, maxHp: user.hp.max, imageName: getCharacterImage(user.character), emoji: '🥷' },
                        round: 1,
                        title: 'SPARRING MATCH — PRACTICE',
                    }).catch(() => null);

                    return await conn.sendMessage(from, prepareImagePayloadFromBuffer(botCardBuf,
                        `⚔️ *SPARRING MATCH!*\n\n${user.emoji || '🥋'} ${user.username} vs 🥷 ${user.username}'s Shadow Clone\n\n_Practice match — no Ryo or rank points at stake, just XP if you win._\n\nType *!use* to see your jutsu list, then *!use [number]* to act.`
                    ));
                }

                const targetName = rawArgs[0];
                const opponent = await findTargetUser(targetName);
                if (!opponent) return await conn.sendMessage(from, { text: `❌ No player called "${targetName}" found.` });
                if (opponent.phoneId === senderJid) {
                    return await conn.sendMessage(from, { text: `❌ You can't duel yourself!` });
                }
                if (opponent.isBanned) {
                    return await conn.sendMessage(from, { text: `❌ That player is banned.` });
                }
                if (activeFights.has(opponent.phoneId)) {
                    return await conn.sendMessage(from, { text: `❌ ${opponent.username} is already mid-battle.` });
                }
                if (activeChallenges.has(opponent.phoneId)) {
                    return await conn.sendMessage(from, { text: `❌ ${opponent.username} already has a pending challenge.` });
                }
                if (opponent.hp.current <= 1) {
                    return await conn.sendMessage(from, { text: `❌ ${opponent.username} is too injured to duel right now.` });
                }

                const timer = setTimeout(async () => {
                    if (activeChallenges.get(opponent.phoneId)?.fromJid === senderJid) {
                        activeChallenges.delete(opponent.phoneId);
                        try {
                            await conn.sendMessage(from, { text: `⌛ ${user.username}'s duel challenge to ${opponent.username} expired (no response in 5 minutes).` });
                        } catch {}
                    }
                }, 5 * 60 * 1000);

                activeChallenges.set(opponent.phoneId, {
                    fromJid: senderJid, fromName: user.username, toName: opponent.username, from, timer,
                });

                return await conn.sendMessage(from, {
                    text: `⚔️ *DUEL CHALLENGE!*\n\n${user.username} has challenged *${opponent.username}* to a duel!\n\n@${opponent.phoneId.split('@')[0]} type *!accept* or *!decline*\n_(expires in 5 minutes)_`,
                    mentions: [opponent.phoneId],
                });
            }

            case 'accept': {
                if (!user || user.registrationStep !== 'COMPLETED') {
                    return await conn.sendMessage(from, { text: '❌ Register first! Type !start.' });
                }
                const challenge = activeChallenges.get(senderJid);
                if (!challenge) return await conn.sendMessage(from, { text: `❌ You don't have a pending duel challenge.` });

                clearTimeout(challenge.timer);
                activeChallenges.delete(senderJid);

                const challenger = await User.findOne({ phoneId: challenge.fromJid });
                if (!challenger) return await conn.sendMessage(from, { text: `❌ That player no longer exists.` });
                if (activeFights.has(challenger.phoneId) || activeFights.has(senderJid)) {
                    return await conn.sendMessage(from, { text: `❌ One of you is already mid-battle — challenge expired.` });
                }

                const buffsA = await getClanBuffs(challenger);
                const buffsB = await getClanBuffs(user);
                const p1Pp = {}; (challenger.equippedJutsus || []).forEach(id => { p1Pp[id] = CHARACTERS[challenger.character]?.jutsus.find(j => j.id === id)?.pp ?? 99; });
                const p2Pp = {}; (user.equippedJutsus || []).forEach(id => { p2Pp[id] = CHARACTERS[user.character]?.jutsus.find(j => j.id === id)?.pp ?? 99; });

                const freshEffects = initFightEffects(); // {self, enemy} - both are independent fresh objects, reuse as p1/p2
                const fight = {
                    type: 'pvp',
                    from,
                    round: 1,
                    p1: { jid: challenger.phoneId, username: challenger.username, buffs: buffsA, jutsuPp: p1Pp },
                    p2: { jid: senderJid, username: user.username, buffs: buffsB, jutsuPp: p2Pp },
                    pending: { p1: null, p2: null },
                    effects: { p1: freshEffects.self, p2: freshEffects.enemy },
                };

                activeFights.set(challenger.phoneId, fight);
                activeFights.set(senderJid, fight);

                const challengerStats = getEffectiveStats(challenger, buffsA);
                const accepterStats = getEffectiveStats(user, buffsB);
                const acceptCardBuf = await renderBattleCard({
                    p1: { name: challenger.username, hp: challenger.hp.current, maxHp: challenger.hp.max, chakra: challenger.chakra.current, maxChakra: challenger.chakra.max, imageName: getCharacterImage(challenger.character), emoji: challengerStats.emoji },
                    p2: { name: user.username, hp: user.hp.current, maxHp: user.hp.max, chakra: user.chakra.current, maxChakra: user.chakra.max, imageName: getCharacterImage(user.character), emoji: accepterStats.emoji },
                    round: 1,
                    title: 'PvP DUEL',
                }).catch(() => null);

                return await conn.sendMessage(from, prepareImagePayloadFromBuffer(acceptCardBuf,
                    `⚔️ *DUEL ACCEPTED!*\n\n${challenger.username} vs ${user.username}\n\nBoth fighters: type *!use* to see your jutsu list, then *!use [number]* to lock in your move.\n_The round resolves once BOTH of you have chosen — nobody gets to react to the other's move._`
                ));
            }

            case 'decline': {
                const challenge = activeChallenges.get(senderJid);
                if (!challenge) return await conn.sendMessage(from, { text: `❌ You don't have a pending duel challenge.` });
                clearTimeout(challenge.timer);
                activeChallenges.delete(senderJid);
                return await conn.sendMessage(from, { text: `🚫 ${user?.username || 'Player'} declined the duel from ${challenge.fromName}.` });
            }

            // ════════════════════════════════════════════════════════════════
            // MISSIONS
            // ════════════════════════════════════════════════════════════════
            case 'missions': {
                if (!user || user.registrationStep !== 'COMPLETED') {
                    return await conn.sendMessage(from, { text: '❌ Register first! Type !start.' });
                }
                return await conn.sendMessage(from, {
                    text: `📜 *MISSION BOARD*\n\n` +
                          `🟢 !mission d — D-Rank (20 Chakra | 150-300 Ryo | 20 XP)\n` +
                          `🔵 !mission c — C-Rank (40 Chakra | 500-900 Ryo | 50 XP)\n` +
                          `🔴 !mission b — B-Rank (60 Chakra | 1,200-2,500 Ryo | 120 XP)\n` +
                          `🔥 !mission a — A-Rank (80 Chakra | 3,000-5,000 Ryo | 200 XP)\n` +
                          `💀 !mission s — S-Rank (90 Chakra | 4,000-7,500 Ryo | 350 XP + Gems)`
                });
            }

            case 'mission': {
                if (!user || user.registrationStep !== 'COMPLETED') {
                    return await conn.sendMessage(from, { text: '❌ Register first! Type !start.' });
                }

                // Cooldown check — 5 minutes between missions
                const now = Date.now();
                if (user.lastMission && now - user.lastMission.getTime() < 5 * 60 * 1000) {
                    const wait = Math.ceil((5 * 60 * 1000 - (now - user.lastMission.getTime())) / 1000);
                    return await conn.sendMessage(from, { text: `⏳ Mission cooldown: ${wait}s remaining` });
                }

                const tier = args[0];
                const configs = {
                    d: { name: 'D-Rank: Catch Tora the Cat',      chakra: 20, minRyo: 150,  maxRyo: 300,  xp: 20,  baseSuccess: 100, failDmg: 0 },
                    c: { name: 'C-Rank: Escort Merchant Fleet',    chakra: 40, minRyo: 500,  maxRyo: 900,  xp: 50,  baseSuccess: 75,  failDmg: 80 },
                    b: { name: 'B-Rank: Neutralize Rogue Bandits', chakra: 60, minRyo: 1200, maxRyo: 2500, xp: 120, baseSuccess: 55,  failDmg: 180 },
                    a: { name: 'A-Rank: Infiltrate Enemy Base',    chakra: 80, minRyo: 3000, maxRyo: 5000, xp: 200, baseSuccess: 40,  failDmg: 250 },
                    s: { name: 'S-Rank: Engage Akatsuki',          chakra: 90, minRyo: 4000, maxRyo: 7500, xp: 350, baseSuccess: 30,  failDmg: 350 }
                };

                const cfg = configs[tier];
                if (!cfg) return await conn.sendMessage(from, { text: '❌ Unknown tier. Use: d, c, b, a, or s.' });
                if (user.hp.current <= 1) return await conn.sendMessage(from, { text: `🏥 Too injured! (${user.hp.current} HP)` });
                if (user.chakra.current < cfg.chakra) return await conn.sendMessage(from, { text: `❌ Need ${cfg.chakra} Chakra (have ${user.chakra.current})` });

                user.chakra.current -= cfg.chakra;
                user.lastMission = new Date();
                const successChance = Math.min(95, cfg.baseSuccess + (user.level - 1) * 2);

                if (Math.random() * 100 > successChance) {
                    const dmg = Math.min(user.hp.current - 1, cfg.failDmg);
                    user.hp.current -= dmg;
                    await user.save();
                    return await conn.sendMessage(from, {
                        text: `🚨 *MISSION FAILED — AMBUSHED!*\n\n🦅 ${cfg.name}\n📉 -${cfg.chakra} Chakra\n💔 -${dmg} HP`
                    });
                }

                const ryo  = Math.floor(Math.random() * (cfg.maxRyo - cfg.minRyo + 1)) + cfg.minRyo;
                const gems = (tier === 's' && Math.random() > 0.5) ? 1 : 0;
                user.ryo += ryo;
                if (gems) user.gems += gems;

                const { leveledUp, rewards } = await addXP(user, cfg.xp);

                let reply = `✅ *MISSION SUCCESS!*\n\n🦅 ${cfg.name}\n💰 +${ryo.toLocaleString()} Ryo | +${cfg.xp} XP`;
                if (gems) reply += ` | +${gems} 💎`;

                if (leveledUp) {
                    rewards.forEach(r => {
                        reply += `\n\n🎉 *LEVEL UP! Now Level ${r.level}!*\n💰 +${r.ryo} Ryo`;
                        if (r.gems > 0) reply += ` | +${r.gems} 💎`;
                        if (r.bonus) reply += `\n${r.bonus}`;
                    });
                }

                return await conn.sendMessage(from, { text: reply });
            }

            // ════════════════════════════════════════════════════════════════
            // SHOP
            // ════════════════════════════════════════════════════════════════
            case 'shop': {
                if (!user || user.registrationStep !== 'COMPLETED') {
                    return await conn.sendMessage(from, { text: '❌ Register first! Type !start.' });
                }

                const shopArg = args[0];

                if (!shopArg || shopArg === 'chars') {
                    // Build owned list display
                    const ownedNames = user.ownedCharacters
                        .map(id => CHARACTERS[id]?.name || id)
                        .join(', ');

                    // Build full character list as text
                    let shopList = `🛒 *NINJA CHARACTER SHOP* 🛒\n\n`;
                    shopList += `_You own: ${ownedNames || 'none'}_\n\n`;

                    for (const char of Object.values(CHARACTERS)) {
                        const owned = user.ownedCharacters.includes(char.id);
                        const nature = char.nature ? ` (${natureTag(char.nature)})` : '';
                        const price = owned ? '✅ Owned' : `💰 ${char.price.toLocaleString()} Ryo`;
                        shopList +=
                            `${char.emoji} *${char.name}*${nature}\n` +
                            `   Village: ${char.village} | Rarity: ${char.rarity}\n` +
                            `   ${price}\n\n`;
                    }

                    shopList +=
                        `_!buy [character name] to purchase a character_\n` +
                        `_!shop jutsus — buy jutsus for your character_\n` +
                        `_!shop xp — buy XP packages_`;

                    // Send welcome image + shop list as caption (single message, no spam)
                    await conn.sendMessage(from, prepareImagePayload('welcome', shopList));
                    return;
                }

                if (shopArg === 'items') {
                    return await conn.sendMessage(from, { text: `Use *!items* to browse the item shop 🎒` });
                }
                if (shopArg === 'xp') {
                    return await conn.sendMessage(from, { text: `Use *!buyxp* to see XP packages 📈` });
                }

                break;
            }

            // ════════════════════════════════════════════════════════════════
            // BUY CHARACTER
            // ════════════════════════════════════════════════════════════════
            case 'buy': {
                if (!user || user.registrationStep !== 'COMPLETED') {
                    return await conn.sendMessage(from, { text: '❌ Register first! Type !start.' });
                }
                if (!rawText) return await conn.sendMessage(from, { text: '❌ Usage: !buy [character name]' });

                const foundChar = Object.values(CHARACTERS).find(c =>
                    c.name.toLowerCase().includes(rawText.toLowerCase()) ||
                    c.id.toLowerCase().includes(rawText.toLowerCase())
                );

                if (!foundChar) return await conn.sendMessage(from, { text: `❌ Character not found. Type !shop to browse.` });
                if (user.ownedCharacters.includes(foundChar.id)) return await conn.sendMessage(from, { text: `❌ You already own *${foundChar.name}*!` });
                if (user.ryo < foundChar.price) return await conn.sendMessage(from, { text: `❌ Need ${foundChar.price.toLocaleString()} Ryo (have ${user.ryo.toLocaleString()})` });

                user.ryo -= foundChar.price;
                user.ownedCharacters.push(foundChar.id);
                await user.save();

                return await conn.sendMessage(from,
                    prepareImagePayload(getCharacterImage(foundChar.id),
                        `✅ *CHARACTER UNLOCKED!*\n\n${foundChar.emoji} *${foundChar.name}*${foundChar.nature ? ` ${natureTag(foundChar.nature)}` : ''}\n${foundChar.description}\n\n💰 -${foundChar.price.toLocaleString()} Ryo\n\n_Type !switch ${foundChar.name} to equip this character!_`
                    )
                );
            }

            // ════════════════════════════════════════════════════════════════
            // SWITCH CHARACTER
            // ════════════════════════════════════════════════════════════════
            case 'switch': {
                if (!user || user.registrationStep !== 'COMPLETED') {
                    return await conn.sendMessage(from, { text: '❌ Register first! Type !start.' });
                }
                if (!rawText) return await conn.sendMessage(from, { text: '❌ Usage: !switch [character name]' });

                const foundChar = Object.values(CHARACTERS).find(c =>
                    c.name.toLowerCase().includes(rawText.toLowerCase()) ||
                    c.id.toLowerCase().includes(rawText.toLowerCase())
                );

                if (!foundChar) return await conn.sendMessage(from, { text: `❌ Character not found.` });
                if (!user.ownedCharacters.includes(foundChar.id)) {
                    return await conn.sendMessage(from, { text: `❌ You don't own *${foundChar.name}*. Type !buy ${foundChar.name} to purchase.` });
                }

                user.character      = foundChar.id;
                user.hp.max         = foundChar.baseStats.hp + (user.level - 1) * 20;
                user.chakra.max     = foundChar.baseStats.chakra + (user.level - 1) * 15;
                user.hp.current     = user.hp.max;
                user.chakra.current = user.chakra.max;
                user.unlockedJutsus = [foundChar.jutsus[0].id];
                user.equippedJutsus = [foundChar.jutsus[0].id];
                await user.save();

                return await conn.sendMessage(from,
                    prepareImagePayload(getCharacterImage(foundChar.id),
                        `✅ *CHARACTER SWITCHED!*\n\n${foundChar.emoji} Now playing as *${foundChar.name}*${foundChar.nature ? ` ${natureTag(foundChar.nature)}` : ''}\n${foundChar.description}\n\n❤️ HP: ${user.hp.max}\n⚡ Chakra: ${user.chakra.max}\n\n_Your jutsus have been reset to starter. Use !jutsus to unlock more!_`
                    )
                );
            }

            // ════════════════════════════════════════════════════════════════
            // ITEM SHOP
            // ════════════════════════════════════════════════════════════════
            case 'items':
            case 'itemshop': {
                await conn.sendMessage(from, {
                    text: `🛒 *ITEM SHOP*\n\n💰 ${(user?.ryo || 0).toLocaleString()} Ryo | 💎 ${user?.gems || 0} Gems\n\n_Tap a card to buy. Stock up BEFORE battle — you can't shop mid-fight!_`
                });
                const cats = { consumable: '🧪 Consumables', boost: '⚡ Boosts', special: '🏯 Special' };
                for (const [cat, catLabel] of Object.entries(cats)) {
                    const catItems = Object.values(ITEMS).filter(it => it.category === cat);
                    if (!catItems.length) continue;
                    for (const it of catItems) {
                        // Try to load item image (e.g. images/item_soldier_pill.jpg)
                        const imgPath = require('path').join(__dirname, '../images', `item_${it.id}.jpg`);
                        let imgBuf = null;
                        try { imgBuf = require('fs').readFileSync(imgPath); } catch (_) {}

                        const caption =
                            `${it.emoji} *${it.name}*\n` +
                            `${catLabel} | ${priceLabel(it)}\n\n` +
                            `_${it.desc}_\n\n` +
                            `${it.usableInBattle ? '⚔️ Usable in battle' : '🧘 Use outside battle'}`;

                        if (imgBuf) {
                            await conn.sendMessage(from, { image: imgBuf, caption, mimetype: 'image/jpeg' });
                        } else {
                            await conn.sendMessage(from, { text: caption });
                        }
                        await conn.sendMessage(from, buttonMessage(
                            `Buy ${it.name}?`,
                            [{ label: `${it.emoji} Buy ${it.name} — ${priceLabel(it)}`, id: `!buyitem ${it.name}` }]
                        ));
                    }
                }
                return;
            }

            // ════════════════════════════════════════════════════════════════
            // BUY ITEM
            // ════════════════════════════════════════════════════════════════
            case 'buyitem': {
                if (!user || user.registrationStep !== 'COMPLETED') {
                    return await conn.sendMessage(from, { text: '❌ Register first! Type !start.' });
                }
                if (activeFights.has(senderJid)) {
                    return await conn.sendMessage(from, { text: `❌ Can't shop mid-battle! Stock your 🎒 bag before you fight — check it with !bag.` });
                }
                if (!rawText) return await conn.sendMessage(from, { text: `❌ Usage: !buyitem [name]\nType !items to browse.` });

                const item = findItem(rawText);
                if (!item) return await conn.sendMessage(from, { text: `❌ No item called *${rawText}*. Type !items.` });

                const currency = item.price.gems ? 'gems' : 'ryo';
                const cost = item.price.gems ?? item.price.ryo;
                if (currency === 'gems') {
                    if (user.gems < cost) return await conn.sendMessage(from, { text: `❌ Need 💎 ${cost} gems (you have ${user.gems}).` });
                    user.gems -= cost;
                } else {
                    if (user.ryo < cost) return await conn.sendMessage(from, { text: `❌ Need 💰 ${cost.toLocaleString()} Ryo (you have ${user.ryo.toLocaleString()}).` });
                    user.ryo -= cost;
                }

                const slot = user.inventory.find(it => it.itemId === item.id);
                if (slot) slot.qty += 1;
                else user.inventory.push({ itemId: item.id, qty: 1 });
                await user.save();

                await conn.sendMessage(from, {
                    text: `✅ *Purchased ${item.emoji} ${item.name}!*\n${item.desc}\n\n💸 -${priceLabel(item)}\n_Use it with: !useitem ${item.name}_`
                });
                return await conn.sendMessage(from, buttonMessage(
                    'Item added to your bag!',
                    [{ label: '🎒 View Bag', id: '!bag' }, { label: '🛒 Buy More', id: '!items' }, { label: '⚔️ Battle', id: '!battle d' }]
                ));
            }

            // ════════════════════════════════════════════════════════════════
            // INVENTORY
            // ════════════════════════════════════════════════════════════════
            case 'inventory':
            case 'inv':
            case 'bag': {
                if (!user || user.registrationStep !== 'COMPLETED') {
                    return await conn.sendMessage(from, { text: '❌ Register first! Type !start.' });
                }
                if (!user.inventory.length) {
                    return await conn.sendMessage(from, { text: `🎒 *Your bag is empty.*\n\nBuy items with !buyitem [name] (browse with !items) — you can't shop mid-battle, so stock up first!` });
                }
                const inBattle = activeFights.has(senderJid);
                let list = '';
                user.inventory.forEach((slot, i) => {
                    const it = getItem(slot.itemId);
                    if (!it) return;
                    const tag = it.usableInBattle ? '⚔️ battle' : '🧘 out-of-battle';
                    list += `*${i + 1}.* ${it.emoji} *${it.name}* x${slot.qty} _(${tag})_\n   ${it.desc}\n`;
                });
                const howTo = inBattle
                    ? `_In battle: !item [name] for ⚔️ items. !flee to retreat._`
                    : `_Outside battle: !useitem [name] for 🧘 items. ⚔️ items only work via !item mid-fight._`;
                await conn.sendMessage(from, {
                    text: `🎒 *YOUR BAG*\n\n${list}\n💰 ${user.ryo.toLocaleString()} Ryo | 💎 ${user.gems} Gems\n\n${howTo}`
                });
                if (!inBattle) {
                    return await conn.sendMessage(from, buttonMessage(
                        'Need more supplies?',
                        [{ label: '🛒 Browse Items', id: '!items' }, { label: '⚔️ Start Battle', id: '!battle d' }, { label: '📜 Profile', id: '!profile' }]
                    ));
                }
                return;
            }

            // ════════════════════════════════════════════════════════════════
            // USE ITEM  (consumables — heal / restore chakra outside battle)
            // ════════════════════════════════════════════════════════════════
            case 'useitem': {
                if (!user || user.registrationStep !== 'COMPLETED') {
                    return await conn.sendMessage(from, { text: '❌ Register first! Type !start.' });
                }
                if (!rawText) return await conn.sendMessage(from, { text: `❌ Usage: !useitem [name]\nType !inventory.` });

                const item = findItem(rawText);
                if (!item) return await conn.sendMessage(from, { text: `❌ No item called *${rawText}*.` });

                const slotIdx = user.inventory.findIndex(it => it.itemId === item.id);
                if (slotIdx === -1) return await conn.sendMessage(from, { text: `❌ You don't own a ${item.name}.` });

                const directUseKeys = ['hp', 'chakra', 'fullHeal', 'xp'];
                if (!directUseKeys.some(k => item.effect[k])) {
                    return await conn.sendMessage(from, { text: `❌ *${item.name}* can't be used directly. (Battle items are used with !item during a fight; banners found clans; charms trigger on battle wins.)` });
                }

                let msg = '';
                if (item.effect.hp) {
                    const before = user.hp.current;
                    user.hp.current = Math.min(user.hp.max, user.hp.current + item.effect.hp);
                    msg += `💚 Healed ${user.hp.current - before} HP (${user.hp.current}/${user.hp.max})\n`;
                }
                if (item.effect.chakra) {
                    const before = user.chakra.current;
                    user.chakra.current = Math.min(user.chakra.max, user.chakra.current + item.effect.chakra);
                    msg += `⚡ Restored ${user.chakra.current - before} Chakra (${user.chakra.current}/${user.chakra.max})\n`;
                }
                if (item.effect.fullHeal) {
                    user.hp.current = user.hp.max;
                    user.chakra.current = user.chakra.max;
                    msg += `✨ Fully restored! HP & Chakra maxed.\n`;
                }
                if (item.effect.xp) {
                    const { rewards } = await addXP(user, item.effect.xp);
                    msg += `📈 Gained ${item.effect.xp.toLocaleString()} XP!\n`;
                    rewards.forEach(r => {
                        msg += `🎉 Level up to ${r.level}! 💰 +${r.ryo.toLocaleString()} Ryo${r.gems ? ` | 💎 +${r.gems}` : ''}\n${r.bonus ? `${r.bonus}\n` : ''}`;
                    });
                }

                user.inventory[slotIdx].qty -= 1;
                if (user.inventory[slotIdx].qty <= 0) user.inventory.splice(slotIdx, 1);
                await user.save();

                return await conn.sendMessage(from, { text: `${item.emoji} *Used ${item.name}!*\n\n${msg}` });
            }

            // ════════════════════════════════════════════════════════════════
            // EVENT — show the active server event
            // ════════════════════════════════════════════════════════════════
            case 'event':
            case 'events': {
                const ev = getActiveEvent();
                if (!ev) {
                    return await conn.sendMessage(from, { text: `📅 *No active event right now.*\n\nEvents rotate daily — check back soon for XP & Ryo boosts!` });
                }
                return await conn.sendMessage(from, {
                    text: `🎉 *ACTIVE EVENT* 🎉\n\n${ev.emoji} *${ev.name}*\n📖 ${ev.desc}\n\n` +
                          `${ev.xpMult > 1 ? `📈 XP x${ev.xpMult}\n` : ''}` +
                          `${ev.ryoMult > 1 ? `💰 Ryo x${ev.ryoMult}\n` : ''}` +
                          `\n_Make the most of it — grind battles and missions now!_`
                });
            }

            // ════════════════════════════════════════════════════════════════
            // CLANS — browse canon clans + active player clans
            // ════════════════════════════════════════════════════════════════
            case 'clans': {
                const canonNames = Object.values(CANON_CLANS)
                    .map(c => `${c.emoji} ${c.name} _(${c.rarity})_`)
                    .join('\n');

                const playerClans = await Clan.find().sort({ level: -1, clanXp: -1 }).limit(10);
                let activeList = '';
                playerClans.forEach((c, i) => {
                    activeList += `${i + 1}. ${c.emoji} *${c.name}* — Lv.${c.level} | 👥 ${c.members.length} | 👑 ${c.leaderName}\n`;
                });

                return await conn.sendMessage(from, {
                    text: `🏯 *CLAN SYSTEM* 🏯\n\n` +
                          `📜 *Canon Clans* (create one with the exact name to inherit its power):\n${canonNames}\n\n` +
                          `🔥 *Top Active Clans:*\n${activeList || '_No clans founded yet — be the first!_'}\n\n` +
                          `*Commands:*\n` +
                          `!createclan [name] — found a clan (needs a 🏯 Clan Banner)\n` +
                          `!joinclan [name] — join an existing clan\n` +
                          `!clan [name] — view clan details\n` +
                          `!leaveclan — leave your clan`
                });
            }

            // ════════════════════════════════════════════════════════════════
            // CREATE CLAN
            // ════════════════════════════════════════════════════════════════
            case 'createclan': {
                if (!user || user.registrationStep !== 'COMPLETED') {
                    return await conn.sendMessage(from, { text: '❌ Register first! Type !start.' });
                }
                if (user.clan && user.clan !== 'None') {
                    return await conn.sendMessage(from, { text: `❌ You're already in *${user.clan}*. Use !leaveclan first.` });
                }
                if (!rawText || rawText.length < 3 || rawText.length > 20) {
                    return await conn.sendMessage(from, { text: `❌ Clan name must be 3-20 characters.\nUsage: !createclan Uchiha` });
                }
                if (!/^[a-zA-Z0-9 ]+$/.test(rawText)) {
                    return await conn.sendMessage(from, { text: `❌ Clan names can only contain letters, numbers and spaces.` });
                }

                // Must own a Clan Banner
                const bannerIdx = user.inventory.findIndex(it => it.itemId === 'clan_banner');
                if (bannerIdx === -1) {
                    return await conn.sendMessage(from, { text: `🏯 You need a *Clan Banner* to found a clan.\n\nBuy one with: !buyitem clan banner (💰 5,000 Ryo)` });
                }

                // Unique name (case-insensitive)
                const existing = await Clan.findOne({ nameLower: rawText.toLowerCase() });
                if (existing) {
                    return await conn.sendMessage(from, { text: `❌ The *${existing.name}* clan already exists and the name is taken. Pick another.` });
                }

                // Canon match -> fixed buffs; else custom -> random buffs
                const canon = findCanonClan(rawText);
                let clanData;
                if (canon) {
                    clanData = {
                        name: canon.name, emoji: canon.emoji, rarity: canon.rarity,
                        description: canon.description, buffs: canon.buffs, type: 'canon',
                    };
                } else {
                    const rolled = rollCustomClanBuff();
                    clanData = {
                        name: rawText, emoji: '🩸', rarity: rolled.rarity,
                        description: `A custom shinobi clan forged by ${user.username}.`,
                        buffs: rolled.buffs, type: 'custom',
                    };
                }

                // Consume banner
                user.inventory[bannerIdx].qty -= 1;
                if (user.inventory[bannerIdx].qty <= 0) user.inventory.splice(bannerIdx, 1);

                const clan = new Clan({
                    name: clanData.name,
                    nameLower: clanData.name.toLowerCase(),
                    leaderId: senderJid,
                    leaderName: user.username,
                    type: clanData.type,
                    rarity: clanData.rarity,
                    emoji: clanData.emoji,
                    description: clanData.description,
                    buffs: clanData.buffs,
                    members: [senderJid],
                });
                await clan.save();

                user.clan = clanData.name;
                user.clanRole = 'Leader';
                user.bloodlineRarity = clanData.rarity;
                applyClanStatBuffs(user, clanData.buffs, true);
                await user.save();

                return await conn.sendMessage(from, {
                    text: `🏯 *CLAN FOUNDED!* 🏯\n\n${clanData.emoji} *${clanData.name}* _(${clanData.rarity})_\n` +
                          `${clanData.type === 'canon' ? '📜 Canon clan — inherited its legendary power!' : '✨ Custom clan — granted unique buffs!'}\n\n` +
                          `📖 ${clanData.description}\n\n` +
                          `🎁 *Clan Buffs:* ${describeBuffs(clanData.buffs)}\n` +
                          `👑 You are the *Leader* (+10% to all clan buffs)\n\n` +
                          `_Recruit members! They join with: !joinclan ${clanData.name}_`
                });
            }

            // ════════════════════════════════════════════════════════════════
            // JOIN CLAN
            // ════════════════════════════════════════════════════════════════
            case 'joinclan': {
                if (!user || user.registrationStep !== 'COMPLETED') {
                    return await conn.sendMessage(from, { text: '❌ Register first! Type !start.' });
                }
                if (user.clan && user.clan !== 'None') {
                    return await conn.sendMessage(from, { text: `❌ You're already in *${user.clan}*. Use !leaveclan first.` });
                }
                if (!rawText) return await conn.sendMessage(from, { text: `❌ Usage: !joinclan [clan name]\nType !clans to browse.` });

                const clan = await Clan.findOne({ nameLower: rawText.toLowerCase() });
                if (!clan) {
                    return await conn.sendMessage(from, { text: `❌ No clan named *${rawText}* exists.\nFound it yourself with !createclan ${rawText}` });
                }
                if (clan.members.length >= 30) {
                    return await conn.sendMessage(from, { text: `❌ *${clan.name}* is full (30 members max).` });
                }

                clan.members.push(senderJid);
                await clan.save();

                user.clan = clan.name;
                user.clanRole = 'Member';
                user.bloodlineRarity = clan.rarity;
                applyClanStatBuffs(user, clan.buffs, false);
                await user.save();

                // Notify leader
                try {
                    await conn.sendMessage(clan.leaderId, { text: `🏯 *${user.username}* just joined your clan *${clan.name}*! 👥 ${clan.members.length} members.` });
                } catch {}

                return await conn.sendMessage(from, {
                    text: `🏯 *JOINED ${clan.name.toUpperCase()}!* 🏯\n\n${clan.emoji} ${clan.name} _(${clan.rarity})_\n📖 ${clan.description}\n\n` +
                          `🎁 *Clan Buffs:* ${describeBuffs(clan.buffs)}\n👥 Members: ${clan.members.length}\n👑 Leader: ${clan.leaderName}`
                });
            }

            // ════════════════════════════════════════════════════════════════
            // LEAVE CLAN
            // ════════════════════════════════════════════════════════════════
            case 'leaveclan': {
                if (!user || user.registrationStep !== 'COMPLETED') {
                    return await conn.sendMessage(from, { text: '❌ Register first! Type !start.' });
                }
                if (!user.clan || user.clan === 'None') {
                    return await conn.sendMessage(from, { text: `❌ You're not in a clan.` });
                }

                const clan = await Clan.findOne({ nameLower: user.clan.toLowerCase() });
                const clanName = user.clan;

                if (clan) {
                    clan.members = clan.members.filter(m => m !== senderJid);

                    if (clan.leaderId === senderJid) {
                        if (clan.members.length > 0) {
                            // Transfer leadership to the next member
                            const newLeaderJid = clan.members[0];
                            const newLeader = await User.findOne({ phoneId: newLeaderJid });
                            clan.leaderId = newLeaderJid;
                            clan.leaderName = newLeader?.username || 'Unknown';
                            if (newLeader) {
                                newLeader.clanRole = 'Leader';
                                applyClanStatBuffs(newLeader, clan.buffs, true);
                                await newLeader.save();
                                try { await conn.sendMessage(newLeaderJid, { text: `👑 You are now the *Leader* of ${clan.name}!` }); } catch {}
                            }
                            await clan.save();
                        } else {
                            // Last member -> disband
                            await Clan.deleteOne({ _id: clan._id });
                        }
                    } else {
                        await clan.save();
                    }
                }

                user.clan = 'None';
                user.clanRole = 'None';
                user.bloodlineRarity = 'None';
                applyClanStatBuffs(user, {}, false);
                await user.save();

                return await conn.sendMessage(from, { text: `🚪 You left the *${clanName}* clan. Clan buffs removed.` });
            }

            // ════════════════════════════════════════════════════════════════
            // CLAN INFO
            // ════════════════════════════════════════════════════════════════
            case 'clan': {
                const targetName = rawText || (user && user.clan !== 'None' ? user.clan : null);
                if (!targetName) {
                    return await conn.sendMessage(from, { text: `❌ You're not in a clan. Type !clans to browse, or !clan [name] to inspect one.` });
                }

                const clan = await Clan.findOne({ nameLower: targetName.toLowerCase() });
                if (!clan) return await conn.sendMessage(from, { text: `❌ No clan named *${targetName}*.` });

                // List up to 10 members by name
                const memberDocs = await User.find({ phoneId: { $in: clan.members } }).select('username phoneId').limit(10);
                const memberNames = memberDocs.map(m => (m.phoneId === clan.leaderId ? `👑 ${m.username}` : `• ${m.username}`)).join('\n');

                return await conn.sendMessage(from, {
                    text: `🏯 *${clan.name.toUpperCase()} CLAN* 🏯\n\n` +
                          `${clan.emoji} Rarity: ${clan.rarity} | Type: ${clan.type}\n` +
                          `📖 ${clan.description}\n\n` +
                          `🎁 *Buffs:* ${describeBuffs(clan.buffs)}\n` +
                          `📊 Clan Level: ${clan.level} | 👥 Members: ${clan.members.length}\n` +
                          `🏦 Treasury: ${clan.treasury.toLocaleString()} Ryo\n\n` +
                          `*Roster:*\n${memberNames}`
                });
            }

            // ════════════════════════════════════════════════════════════════
            // LEADERBOARD
            // ════════════════════════════════════════════════════════════════
            case 'top':
            case 'leaderboard': {
                const topPlayers = await User.find({ registrationStep: 'COMPLETED' })
                    .sort({ totalXp: -1 })
                    .limit(10);

                let board = `🏆 *GLOBAL LEADERBOARD* 🏆\n\n`;
                topPlayers.forEach((p, i) => {
                    const char = getCharacter(p.character);
                    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
                    board += `${medal} *${p.username}* ${p.isKage ? '👑' : ''}\n`;
                    board += `   ${char.emoji} ${char.name} | Lv.${p.level} | ${(p.totalXp || 0).toLocaleString()} XP\n`;
                    board += `   🏡 ${p.village} | 🩸 ${p.clan}\n\n`;
                });

                return await conn.sendMessage(from, { text: board });
            }

            // ════════════════════════════��═══════════════════════════════════
            // KAGE INFO
            // ════════════════════════════════════════════════════════════════
            case 'kage': {
                const village = args[0] ? args[0].charAt(0).toUpperCase() + args[0].slice(1) : user?.village;
                const kage = await User.findOne({ village, isKage: true });

                if (!kage) {
                    return await conn.sendMessage(from, {
                        text: `👑 *${village} KAGE*\n\nNo Kage elected yet!\n\n_Reach Level 100+ and win the weekly vote to become Kage!_`
                    });
                }

                const kageChar = getCharacter(kage.character);
                return await conn.sendMessage(from,
                    prepareImagePayload(getCharacterImage(kage.character),
                        `👑 *${village} KAGE* 👑\n\n` +
                        `👤 *${kage.username}*\n` +
                        `${kageChar.emoji} ${kageChar.name}\n` +
                        `🎖️ Level ${kage.level} | ${(kage.totalXp || 0).toLocaleString()} Total XP\n` +
                        `🗳️ Votes: ${kage.kageVotes}\n\n` +
                        `_Dethrone them by surpassing their XP and winning the vote!_`
                    )
                );
            }

            // ════════════════════════════════════════════════════════════════
            // SETNAME
            // ════════════════════════════════════════════════════════════════
            case 'setname': {
                if (!user || user.registrationStep !== 'COMPLETED') {
                    return await conn.sendMessage(from, { text: '❌ Register first! Type !start.' });
                }
                if (!rawText || rawText.length < 3 || rawText.length > 16) {
                    return await conn.sendMessage(from, { text: '❌ Name must be 3-16 chars. Usage: !setname YourName' });
                }
                const oldName  = user.username;
                user.username  = rawText;
                await user.save();
                return await conn.sendMessage(from, {
                    text: `✅ Name changed: *${oldName}* → *${rawText}*`
                });
            }

            // ════════════════════════════════════════════════════════════════
            // DONATE
            // ════════════════════════════════════════════════════════════════
            case 'donate': {
                return await conn.sendMessage(from, {
                    text: `💎 *DEVTRUST PREMIUM GEMS*\n\n${BRAND.moniepointDetails}\n\nSend proof to wa.me/${BRAND.billingSupportNumber}`
                });
            }

            // ════════════════════════════════════════════════════════════════
            // MENU
            // ════════════════════════════════════════════════════════════════
            // ════════════════════════════════════════════════════════════════
            // WHOAMI — diagnostic, shows the exact JID WhatsApp is sending
            // ════════════════════════════════════════════════════════════════
            case 'whoami': {
                return await conn.sendMessage(from, {
                    text: `🆔 *YOUR ID*\n\n${senderJid}\n\n_isAdmin: ${isAdmin(senderJid) ? '✅ yes' : '❌ no'}_`
                });
            }

            case 'menu':
            case 'help': {
                return await conn.sendMessage(from, listMessage({
                    title: '🍥 NARUTO RPG — ALL COMMANDS',
                    body: 'Tap any command to run it, or type it directly.',
                    buttonText: '📋 Open Menu',
                    sections: [
                        {
                            title: '👤 Profile & Account',
                            rows: [
                                { id: '!profile',  title: '!profile',  description: 'Your full stats card with image' },
                                { id: '!wallet',   title: '!wallet',   description: 'Quick Ryo / Gems / HP / Chakra' },
                                { id: '!record',   title: '!record',   description: 'Battle wins, losses & arena rank' },
                                { id: '!setname',  title: '!setname',  description: 'Change your ninja username' },
                            ]
                        },
                        {
                            title: '⚔️ Combat',
                            rows: [
                                { id: '!battle d', title: '!battle d/c/b/a/s', description: 'Start a PvE fight (D→S rank)' },
                                { id: '!duel bot', title: '!duel bot',          description: 'Practice vs your Shadow Clone' },
                                { id: '!duel',     title: '!duel [player]',     description: 'Challenge a player to PvP' },
                                { id: '!use',      title: '!use [1-3]',         description: 'Use a jutsu in battle (or tap PP status)' },
                                { id: '!flee',     title: '!flee',              description: 'Escape from a battle' },
                            ]
                        },
                        {
                            title: '🎒 Items & Bag',
                            rows: [
                                { id: '!bag',      title: '!bag',           description: 'View your battle bag' },
                                { id: '!items',    title: '!items',         description: 'Browse the item shop' },
                                { id: '!buyitem',  title: '!buyitem [name]',description: 'Buy an item (before battle!)' },
                                { id: '!useitem',  title: '!useitem [name]',description: 'Use an out-of-battle item' },
                            ]
                        },
                        {
                            title: '🥋 Characters & Jutsus',
                            rows: [
                                { id: '!shop',     title: '!shop',          description: 'Character shop with images' },
                                { id: '!jutsus',   title: '!jutsus',        description: 'Your jutsu list with nature & PP' },
                                { id: '!buyjutsu', title: '!buyjutsu',      description: 'Unlock a new jutsu' },
                                { id: '!equip',    title: '!equip [name]',  description: 'Equip / unequip a jutsu' },
                                { id: '!switch',   title: '!switch [name]', description: 'Switch active character' },
                            ]
                        },
                        {
                            title: '📈 Progression & Missions',
                            rows: [
                                { id: '!missions', title: '!missions',      description: 'See available mission tiers' },
                                { id: '!mission s',title: '!mission d/c/b/a/s', description: 'Run a mission for Ryo & XP' },
                                { id: '!train',    title: '!train',         description: 'Train for XP' },
                                { id: '!buyxp',    title: '!buyxp',         description: 'Buy XP packages with Ryo' },
                                { id: '!top',      title: '!top',           description: 'Global leaderboard' },
                            ]
                        },
                        {
                            title: '🏯 Clans',
                            rows: [
                                { id: '!clans',        title: '!clans',           description: 'Browse all clans' },
                                { id: '!createclan',   title: '!createclan',      description: 'Found a new clan (needs Clan Banner item)' },
                                { id: '!joinclan',     title: '!joinclan [name]', description: 'Request to join a clan' },
                                { id: '!claninfo',     title: '!claninfo',        description: 'Your clan details & members' },
                            ]
                        },
                        {
                            title: '🎁 Extras',
                            rows: [
                                { id: '!redeem',   title: '!redeem [CODE]', description: 'Redeem a promo code' },
                                { id: '!daily',    title: '!daily',         description: 'Daily login bonus' },
                                { id: '!donate',   title: '!donate',        description: 'Support the bot & get Gems' },
                            ]
                        },
                        {
                            title: '💀 Boss Raid (Group)',
                            rows: [
                                { id: '!raid info',   title: '!raid info',   description: 'See today\'s boss & active raid status' },
                                { id: '!raid start',  title: '!raid start',  description: 'Start the weekly boss raid (group only)' },
                                { id: '!raid join',   title: '!raid join',   description: 'Join an active raid' },
                                { id: '!raid attack', title: '!raid attack', description: 'Strike the boss on your turn' },
                            ]
                        },
                        {
                            title: '🔮 Summoning Scroll',
                            rows: [
                                { id: '!summon',        title: '!summon',        description: 'View summoning banner & rates' },
                                { id: '!summon single', title: '!summon single', description: '1 pull — 5 Gems' },
                                { id: '!summon multi',  title: '!summon multi',  description: '10 pulls — 40 Gems (save 10!)' },
                                { id: '!summon ryo',    title: '!summon ryo',    description: '1 pull — 25,000 Ryo' },
                            ]
                        },
                        {
                            title: '👁️ Dojutsu (Eye Techniques)',
                            rows: [
                                { id: '!dojutsu',   title: '!dojutsu',          description: 'View your eye technique info & active moves' },
                                { id: '!dojutsu 1', title: '!dojutsu [number]', description: 'Use Mangekyou / Six Paths move in battle' },
                                { id: '!dojutsu copy', title: '!dojutsu copy',  description: 'Sharingan: copy & use last enemy jutsu' },
                            ]
                        },
                        {
                            title: '🦊 Tailed Beast',
                            rows: [
                                { id: '!beastinfo', title: '!beastinfo',  description: 'Your Bijuu info — Kurama, Shukaku, Gyuki' },
                                { id: '!beast',     title: '!beast',      description: 'Activate Chakra Mode in battle (Jinchuriki only)' },
                                { id: '!beastbomb', title: '!beastbomb',  description: 'Fire Tailed Beast Bomb during Chakra Mode' },
                            ]
                        },
                        {
                            title: '📜 Daily Story Missions',
                            rows: [
                                { id: '!smissions',   title: '!smissions',       description: 'Today\'s 5 story missions (resets midnight)' },
                                { id: '!smission d',  title: '!smission d/c/b/a/s', description: 'Run a story mission (3 per day)' },
                            ]
                        },
                    ]
                }));
            }

            // ════════════════════════════════════════════════════════════════
            // REDEEM PROMO CODE
            // ════════════════════════════════════════════════════════════════
            case 'redeem': {
                if (!user || user.registrationStep !== 'COMPLETED') {
                    return await conn.sendMessage(from, { text: '❌ Register first! Type !start.' });
                }

                const codeInput = args[1]?.toUpperCase();
                if (!codeInput) {
                    return await conn.sendMessage(from, { text: '❌ Usage: !redeem [CODE]' });
                }

                const promo = await PromoCode.findOne({ code: codeInput });
                if (!promo) {
                    return await conn.sendMessage(from, { text: '❌ That code does not exist.' });
                }

                if (promo.expiresAt && promo.expiresAt.getTime() < Date.now()) {
                    return await conn.sendMessage(from, { text: '⛔ This code has expired.' });
                }

                if (promo.usedBy.length >= promo.maxUses) {
                    return await conn.sendMessage(from, { text: '🚫 This code has reached its maximum number of uses.' });
                }

                if (promo.usedBy.includes(senderJid)) {
                    return await conn.sendMessage(from, { text: '❌ You already redeemed this code.' });
                }

                // Apply the reward
                let rewardLine = '';
                if (promo.rewardType === 'ryo') {
                    user.ryo += promo.amount;
                    rewardLine = `${promo.amount.toLocaleString()} Ryo`;
                } else if (promo.rewardType === 'gems') {
                    user.gems += promo.amount;
                    rewardLine = `${promo.amount.toLocaleString()} 💎 Gems`;
                } else if (promo.rewardType === 'xp') {
                    await addXP(user, promo.amount);
                    rewardLine = `${promo.amount.toLocaleString()} XP`;
                }

                promo.usedBy.push(senderJid);
                await Promise.all([user.save(), promo.save()]);

                return await conn.sendMessage(from, {
                    text: `✅ You have successfully redeemed *${rewardLine}*!\n\n🎟️ Code: ${promo.code}`
                });
            }

            case 'admin': {
                if (!isAdmin(senderJid)) {
                    return await conn.sendMessage(from, { text: '❌ Admin only.' });
                }

                const subCmd = args[0];

                if (!subCmd || subCmd === 'help') {
                    return await conn.sendMessage(from, {
                        text: `👑 *ADMIN PANEL*\n\n` +
                              `_Targets accept a player's in-game name (preferred) or phone number_\n\n` +
                              `!admin stats — Server overview\n` +
                              `!admin players [page] — List all players & names\n` +
                              `!admin give [name] ryo [amount]\n` +
                              `!admin give [name] gems [amount]\n` +
                              `!admin give [name] xp [amount]\n` +
                              `!admin ban [name]\n` +
                              `!admin unban [name]\n` +
                              `!admin setkage [village] [name]\n` +
                              `!admin reset [name] — Reset player data\n` +
                              `!admin broadcast [message]\n` +
                              `!admin startvote [village] — Start Kage election\n\n` +
                              `🎁 *PROMO CODES*\n` +
                              `!admin createpromo [CODE] [ryo|gems|xp] [amount] [maxUses] [hours]\n` +
                              `!admin promos — List active codes\n` +
                              `!admin delpromo [CODE]`
                    });
                }

                if (subCmd === 'players') {
                    const PAGE_SIZE = 25;
                    const page = Math.max(1, parseInt(args[1]) || 1);

                    const total = await User.countDocuments({ registrationStep: 'COMPLETED' });
                    if (total === 0) return await conn.sendMessage(from, { text: 'No registered players yet.' });

                    const totalPages = Math.ceil(total / PAGE_SIZE);
                    const players = await User.find({ registrationStep: 'COMPLETED' })
                        .sort({ createdAt: 1 })
                        .skip((page - 1) * PAGE_SIZE)
                        .limit(PAGE_SIZE);

                    let list = `👥 *PLAYER LIST* (Page ${page}/${totalPages} — ${total} total)\n\n`;
                    players.forEach((p, i) => {
                        const num = (page - 1) * PAGE_SIZE + i + 1;
                        const flags = [
                            p.isBanned ? '🚫' : '',
                            p.isKage ? '👑' : '',
                            p.isAdmin ? '⭐' : ''
                        ].join('');
                        list += `${num}. *${p.username}* ${flags} — Lv.${p.level} | ${p.village}\n`;
                    });
                    list += `\n_Use !admin players [page] to see more_`;

                    return await conn.sendMessage(from, { text: list });
                }

                if (subCmd === 'stats') {
                    const total   = await User.countDocuments({ registrationStep: 'COMPLETED' });
                    const banned  = await User.countDocuments({ isBanned: true });
                    const kages   = await User.countDocuments({ isKage: true });
                    const topUser = await User.findOne({ registrationStep: 'COMPLETED' }).sort({ totalXp: -1 });

                    return await conn.sendMessage(from, {
                        text: `📊 *SERVER STATS*\n\n` +
                              `👥 Total Players: ${total}\n` +
                              `🚫 Banned: ${banned}\n` +
                              `👑 Active Kages: ${kages}\n` +
                              `🏆 Top Player: ${topUser?.username || 'None'} (Lv.${topUser?.level || 0})\n\n` +
                              `_Updated: ${new Date().toLocaleTimeString()}_`
                    });
                }

                if (subCmd === 'give') {
                    const targetId    = rawArgs[1]; // preserve original case for name matching
                    const giveType    = args[2];
                    const giveAmount  = parseInt(args[3]);

                    if (!targetId || !giveType || isNaN(giveAmount)) {
                        return await conn.sendMessage(from, { text: '❌ Usage: !admin give [name] ryo/gems/xp [amount]' });
                    }

                    const target = await findTargetUser(targetId);
                    if (!target) return await conn.sendMessage(from, { text: `❌ Player "${targetId}" not found.` });

                    if (giveType === 'ryo') {
                        target.ryo += giveAmount;
                        await target.save();
                    } else if (giveType === 'gems') {
                        target.gems += giveAmount;
                        await target.save();
                    } else if (giveType === 'xp') {
                        await addXP(target, giveAmount);
                        await target.save();
                    } else {
                        return await conn.sendMessage(from, { text: '❌ Type must be ryo, gems, or xp' });
                    }

                    await conn.sendMessage(from, { text: `✅ Gave ${giveAmount} ${giveType} to ${target.username}` });

                    // Notify the player
                    try {
                        await conn.sendMessage(target.phoneId, {
                            text: `🎁 *ADMIN GIFT!*\n\nYou received *${giveAmount} ${giveType}* from the admin!\n\nType !profile to see your updated stats.`
                        });
                    } catch {}
                    return;
                }

                if (subCmd === 'ban') {
                    const targetId = rawArgs[1];
                    const target   = await findTargetUser(targetId);
                    if (!target) return await conn.sendMessage(from, { text: `❌ Player "${targetId}" not found.` });
                    target.isBanned = true;
                    await target.save();
                    return await conn.sendMessage(from, { text: `✅ Banned ${target.username}` });
                }

                if (subCmd === 'unban') {
                    const targetId = rawArgs[1];
                    const target   = await findTargetUser(targetId);
                    if (!target) return await conn.sendMessage(from, { text: `❌ Player "${targetId}" not found.` });
                    target.isBanned = false;
                    await target.save();
                    return await conn.sendMessage(from, { text: `✅ Unbanned ${target.username}` });
                }

                if (subCmd === 'setkage') {
                    const village  = args[1] ? args[1].charAt(0).toUpperCase() + args[1].slice(1) : null;
                    const targetId = rawArgs[2];

                    if (!village || !targetId) {
                        return await conn.sendMessage(from, { text: '❌ Usage: !admin setkage [village] [name]' });
                    }

                    const target = await findTargetUser(targetId);
                    if (!target) return await conn.sendMessage(from, { text: `❌ Player "${targetId}" not found.` });

                    // Remove old kage
                    await User.updateMany({ village, isKage: true }, { isKage: false, kageVotes: 0 });

                    target.isKage    = true;
                    target.kageVotes = 0;
                    await target.save();

                    return await conn.sendMessage(from, { text: `✅ ${target.username} is now ${village} Kage!` });
                }

                if (subCmd === 'reset') {
                    const targetId = rawArgs[1];
                    const target   = await findTargetUser(targetId);
                    if (!target) return await conn.sendMessage(from, { text: `❌ Player "${targetId}" not found.` });
                    await User.deleteOne({ phoneId: target.phoneId });
                    return await conn.sendMessage(from, { text: `✅ ${target.username}'s data was reset.` });
                }

                if (subCmd === 'createpromo') {
                    // !admin createpromo CODE ryo|gems|xp amount maxUses hours
                    const code     = args[1]?.toUpperCase();
                    const rewType  = args[2];
                    const amount   = parseInt(args[3]);
                    const maxUses  = parseInt(args[4]);
                    const hours    = parseFloat(args[5]);

                    if (!code || !['ryo','gems','xp'].includes(rewType) || isNaN(amount) || isNaN(maxUses)) {
                        return await conn.sendMessage(from, {
                            text: '❌ Usage: !admin createpromo [CODE] [ryo|gems|xp] [amount] [maxUses] [hours]\n\n' +
                                  '_Leave hours blank or 0 for a code that never expires._\n' +
                                  'Example: !admin createpromo WELCOME50 ryo 5000 100 24'
                        });
                    }

                    const existing = await PromoCode.findOne({ code });
                    if (existing) return await conn.sendMessage(from, { text: `❌ Code "${code}" already exists.` });

                    const expiresAt = (hours && hours > 0) ? new Date(Date.now() + hours * 60 * 60 * 1000) : null;

                    await PromoCode.create({
                        code, rewardType: rewType, amount, maxUses,
                        expiresAt, createdBy: senderJid
                    });

                    return await conn.sendMessage(from, {
                        text: `✅ *PROMO CODE CREATED*\n\n` +
                              `🎟️ Code: *${code}*\n` +
                              `🎁 Reward: ${amount.toLocaleString()} ${rewType}\n` +
                              `👥 Max uses: ${maxUses}\n` +
                              `⏰ Expires: ${expiresAt ? expiresAt.toLocaleString() : 'Never'}\n\n` +
                              `Players redeem with: !redeem ${code}`
                    });
                }

                if (subCmd === 'promos') {
                    const codes = await PromoCode.find({}).sort({ createdAt: -1 }).limit(20);
                    if (codes.length === 0) return await conn.sendMessage(from, { text: 'No promo codes yet.' });

                    let list = `🎟️ *ACTIVE/RECENT PROMO CODES*\n\n`;
                    const now = Date.now();
                    codes.forEach(c => {
                        const expired = c.expiresAt && c.expiresAt.getTime() < now;
                        const usedUp  = c.usedBy.length >= c.maxUses;
                        const status  = expired ? '⛔ expired' : usedUp ? '🚫 fully used' : '✅ active';
                        list += `*${c.code}* — ${c.amount.toLocaleString()} ${c.rewardType} | ${c.usedBy.length}/${c.maxUses} used | ${status}\n`;
                    });
                    return await conn.sendMessage(from, { text: list });
                }

                if (subCmd === 'delpromo') {
                    const code = args[1]?.toUpperCase();
                    if (!code) return await conn.sendMessage(from, { text: '❌ Usage: !admin delpromo [CODE]' });
                    const deleted = await PromoCode.deleteOne({ code });
                    return await conn.sendMessage(from, {
                        text: deleted.deletedCount > 0 ? `✅ Deleted code "${code}".` : `❌ Code not found.`
                    });
                }

                if (subCmd === 'broadcast') {
                    const message = rawText.replace(/^broadcast\s*/i, '');
                    if (!message) return await conn.sendMessage(from, { text: '❌ Usage: !admin broadcast Your message here' });

                    const allPlayers = await User.find({ registrationStep: 'COMPLETED' });
                    let sent = 0;
                    for (const p of allPlayers) {
                        try {
                            await conn.sendMessage(p.phoneId, {
                                text: `📢 *ADMIN BROADCAST*\n\n${message}`
                            });
                            sent++;
                            await new Promise(r => setTimeout(r, 500));
                        } catch {}
                    }
                    return await conn.sendMessage(from, { text: `✅ Broadcast sent to ${sent} players.` });
                }

                if (subCmd === 'startvote') {
                    const village = args[1] ? args[1].charAt(0).toUpperCase() + args[1].slice(1) : null;
                    if (!village) return await conn.sendMessage(from, { text: '❌ Usage: !admin startvote [village]' });

                    const endTime = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
                    activeVotes.set(village, { candidates: {}, endTime, voted: new Set() });

                    // Get eligible candidates (level 100+)
                    const candidates = await User.find({ village, level: { $gte: 100 }, registrationStep: 'COMPLETED' })
                        .sort({ totalXp: -1 }).limit(5);

                    let voteMsg = `🗳️ *${village.toUpperCase()} KAGE ELECTION STARTED!*\n\n`;
                    voteMsg += `_Vote ends in 24 hours_\n\n*Candidates:*\n`;

                    candidates.forEach(c => {
                        voteMsg += `• ${c.username} (Lv.${c.level}) — !vote ${c.phoneId.replace('@s.whatsapp.net', '')}\n`;
                    });

                    if (candidates.length === 0) {
                        voteMsg += `_No eligible candidates (need Level 100+)_`;
                    }

                    return await conn.sendMessage(from, { text: voteMsg });
                }

                break;
            }


            // ════════════════════════════════════════════════════════════════
            // BOSS RAID
            // ════════════════════════════════════════════════════════════════
            case 'raid': {
                if (!user || user.registrationStep !== 'COMPLETED') {
                    return await conn.sendMessage(from, { text: '❌ Register first! Type !start.' });
                }
                if (!from.endsWith('@g.us')) {
                    return await conn.sendMessage(from, { text: '⚠️ Boss raids can only be started in a group chat!' });
                }

                const subCmd = (args[0] || '').toLowerCase();

                // ── !raid info ─────────────────────────────────────────────
                if (!subCmd || subCmd === 'info') {
                    const boss = getCurrentBoss();
                    const existingRaid = getActiveRaid(from);
                    if (!boss) {
                        return await conn.sendMessage(from, {
                            text: `☀️ *NO BOSS TODAY*\n\n_Raid bosses spawn on Sunday (Madara), Wednesday (Kaguya), and Friday (Ten-Tails)._\n\nCheck !raid info on those days to join!`
                        });
                    }
                    if (existingRaid) {
                        const parts = [...existingRaid.participants.values()];
                        const hpPct = Math.round((existingRaid.hp / existingRaid.maxHp) * 100);
                        const turnJid = currentTurnJid(existingRaid);
                        const turnName = existingRaid.participants.get(turnJid)?.username || '?';
                        let status = `⚔️ *RAID IN PROGRESS* ⚔️\n\n`;
                        status += `${boss.emoji} *${boss.name}*\n`;
                        status += `${existingRaid.phase2 ? boss.phase2Label + '\n' : ''}`;
                        status += `❤️ ${raidHpBar(existingRaid.hp, existingRaid.maxHp)} (${hpPct}%)\n\n`;
                        status += `👥 *Raiders (${parts.length}):*\n`;
                        for (const p of parts) {
                            status += `  • ${p.username} — ${p.totalDmg.toLocaleString()} dmg dealt\n`;
                        }
                        status += `\n⏩ *Current turn:* ${turnName}\n`;
                        status += `_!raid join to join | !raid attack to strike_`;
                        return await conn.sendMessage(from, prepareImagePayload('akatsuki', status));
                    }
                    // No active raid — show today's boss info
                    const d = new Date();
                    const hoursLeft = 24 - d.getHours();
                    let preview = `💀 *TODAY'S RAID BOSS* 💀\n\n`;
                    preview += `${boss.emoji} *${boss.name}*\n`;
                    preview += `_${boss.title}_\n\n`;
                    preview += `❤️ HP Pool: ${boss.hp.toLocaleString()}\n`;
                    preview += `🔥 Rage at: ${Math.round(boss.phase2Threshold * 100)}% HP remaining\n\n`;
                    preview += `🏆 *Rewards:*\n`;
                    preview += `  💀 Kill Blow: 💰${boss.rewards.jackpotRyo.toLocaleString()} Ryo | 💎${boss.rewards.jackpotGems} Gems | 📈${boss.rewards.jackpotXp} XP\n`;
                    preview += `  🗡️ Per 100 dmg: 💰${boss.rewards.perDmgRyo} Ryo | 📈${boss.rewards.perDmgXp} XP\n`;
                    preview += `  👥 All participants: +${boss.rewards.participantGems} 💎\n\n`;
                    preview += `_!raid start — start the raid (need 2+ players)_\n`;
                    preview += `_!raid join — join after it starts_\n`;
                    preview += `⏰ Boss despawns in ~${hoursLeft}h`;
                    return await conn.sendMessage(from, prepareImagePayload('akatsuki', preview));
                }

                // ── !raid start ────────────────────────────────────────────
                if (subCmd === 'start') {
                    if (getActiveRaid(from)) {
                        return await conn.sendMessage(from, { text: '⚔️ A raid is already active! Type !raid info to see status.' });
                    }
                    const boss = getCurrentBoss();
                    if (!boss) {
                        return await conn.sendMessage(from, { text: '☀️ No boss spawns today. Check !raid info for the schedule.' });
                    }
                    if (user.hp.current < user.hp.max * 0.3) {
                        return await conn.sendMessage(from, { text: `🏥 You need at least 30% HP to start a raid! (${user.hp.current}/${user.hp.max})` });
                    }
                    const raid = startRaid(from, boss);
                    joinRaid(raid, senderJid, user.username);
                    return await conn.sendMessage(from, prepareImagePayload('akatsuki',
                        `🚨 *BOSS RAID STARTED!* 🚨\n\n` +
                        `${boss.emoji} *${boss.name}* has appeared!\n` +
                        `_${boss.title}_\n\n` +
                        `❤️ ${raidHpBar(boss.hp, boss.hp)}\n\n` +
                        `✅ ${user.username} has joined the raid!\n\n` +
                        `👥 _Tag your friends and type !raid join to fight together!_\n` +
                        `⚔️ _${user.username}, type !raid attack to go first!_\n\n` +
                        `⏰ Raid expires in 6 hours`
                    ));
                }

                // ── !raid join ─────────────────────────────────────────────
                if (subCmd === 'join') {
                    const raid = getActiveRaid(from);
                    if (!raid) {
                        return await conn.sendMessage(from, { text: '❌ No active raid. Type !raid start to begin one!' });
                    }
                    if (raid.participants.has(senderJid)) {
                        return await conn.sendMessage(from, { text: `✅ You're already in the raid, ${user.username}!` });
                    }
                    if (user.hp.current < user.hp.max * 0.3) {
                        return await conn.sendMessage(from, { text: `🏥 You need at least 30% HP to join a raid! (${user.hp.current}/${user.hp.max})` });
                    }
                    joinRaid(raid, senderJid, user.username);
                    return await conn.sendMessage(from, {
                        text: `⚔️ *${user.username} has joined the raid!*\n\n` +
                              `👥 Raiders: ${[...raid.participants.values()].map(p => p.username).join(', ')}\n\n` +
                              `❤️ Boss HP: ${raidHpBar(raid.hp, raid.maxHp)}\n\n` +
                              `_It's your turn when !raid says so. Type !raid attack to strike!_`
                    });
                }

                // ── !raid attack ───────────────────────────────────────────
                if (subCmd === 'attack' || subCmd === 'hit' || subCmd === 'strike') {
                    const raid = getActiveRaid(from);
                    if (!raid) {
                        return await conn.sendMessage(from, { text: '❌ No active raid right now. Type !raid start or !raid info.' });
                    }
                    if (!raid.participants.has(senderJid)) {
                        return await conn.sendMessage(from, { text: '❌ You haven\'t joined this raid! Type !raid join first.' });
                    }

                    const myTurnJid = currentTurnJid(raid);
                    if (myTurnJid !== senderJid) {
                        const turnName = raid.participants.get(myTurnJid)?.username || '?';
                        return await conn.sendMessage(from, { text: `⏳ It's *${turnName}*'s turn right now! Wait for your turn.` });
                    }

                    const raiderData = raid.participants.get(senderJid);
                    if (raiderData.stunned) {
                        raiderData.stunned = false;
                        advanceTurn(raid);
                        return await conn.sendMessage(from, { text: `😵 *${user.username} is stunned!* Lost your turn. Recovered now — wait for next turn.` });
                    }

                    // Player hits the boss
                    const buffs = await getClanBuffs(user);
                    const ps = getEffectiveStats(user, buffs);
                    const { damage: playerDmg, crit } = calcRaidHit(ps, raid.boss);

                    raid.hp = Math.max(0, raid.hp - playerDmg);
                    raiderData.totalDmg += playerDmg;
                    user.raidDamage = (user.raidDamage || 0) + playerDmg;

                    // Check phase 2 trigger
                    const enteredPhase2 = !raid.phase2 && raid.hp <= raid.maxHp * raid.boss.phase2Threshold;
                    if (enteredPhase2) raid.phase2 = true;

                    // Boss is dead
                    if (raid.hp <= 0) {
                        raid.ended = true;
                        user.raidKills = (user.raidKills || 0) + 1;
                        const allRewards = computeRewards(raid, senderJid);
                        let deathMsg = `💀 *${raid.boss.name} HAS BEEN DEFEATED!* 💀\n\n`;
                        deathMsg += `${raid.boss.emoji} HP: ${raidHpBar(0, raid.maxHp)}\n\n`;
                        deathMsg += `⚔️ *KILLING BLOW:* ${user.username}${crit ? ' 💥 CRITICAL!' : ''}\n\n`;
                        deathMsg += `🏆 *RAID REWARDS:*\n`;
                        for (const r of allRewards) {
                            deathMsg += `  ${r.isKiller ? '👑' : '🗡️'} *${r.username}* — ${r.totalDmg.toLocaleString()} dmg (${Math.round(r.dmgShare * 100)}%)\n`;
                            deathMsg += `     💰 +${r.ryo.toLocaleString()} Ryo | 💎 +${r.gems} Gems | 📈 +${r.xp} XP\n`;
                        }
                        // Apply all rewards
                        for (const r of allRewards) {
                            try {
                                const User = require('../models/User');
                                const rUser = await User.findOne({ phoneId: r.jid });
                                if (rUser) {
                                    rUser.ryo = (rUser.ryo || 0) + r.ryo;
                                    rUser.gems = (rUser.gems || 0) + r.gems;
                                    await addXP(rUser, r.xp);
                                    await rUser.save();
                                }
                            } catch (_) {}
                        }
                        await user.save();
                        return await conn.sendMessage(from, prepareImagePayload('akatsuki', deathMsg));
                    }

                    // Boss counter-attack
                    const { move: bossMove, damage: bossDmg, targets, stunTarget } = bossFight(raid, senderJid);

                    // Apply boss damage to targets
                    const dmgLines = [];
                    for (const tJid of targets) {
                        try {
                            const User = require('../models/User');
                            const tUser = await User.findOne({ phoneId: tJid });
                            if (tUser) {
                                const actualDmg = Math.min(tUser.hp.current - 1, bossDmg);
                                tUser.hp.current = Math.max(1, tUser.hp.current - actualDmg);
                                await tUser.save();
                                const tName = raid.participants.get(tJid)?.username || '?';
                                dmgLines.push(`  💔 ${tName} took ${actualDmg} dmg (${tUser.hp.current}/${tUser.hp.max} HP)`);
                            }
                        } catch (_) {}
                    }

                    // Apply stun
                    if (stunTarget && raid.participants.has(stunTarget)) {
                        raid.participants.get(stunTarget).stunned = true;
                        const stunName = raid.participants.get(stunTarget)?.username || '?';
                        dmgLines.push(`  😵 ${stunName} is stunned — loses next turn!`);
                    }

                    advanceTurn(raid);
                    const nextJid = currentTurnJid(raid);
                    const nextName = raid.participants.get(nextJid)?.username || '?';
                    const hpPct = Math.round((raid.hp / raid.maxHp) * 100);

                    let roundMsg = `⚔️ *RAID TURN — Round ${raid.currentTurn + 1}*\n\n`;
                    roundMsg += `🗡️ *${user.username}* attacks!\n`;
                    roundMsg += `  💥 ${playerDmg.toLocaleString()} damage${crit ? ' 💫 CRITICAL HIT!' : ''}\n\n`;
                    if (enteredPhase2) roundMsg += `🔥 *${raid.boss.phase2Label}!*\n\n`;
                    roundMsg += `${raid.boss.emoji} *${raid.boss.name}* counter-attacks with *${bossMove.name}*!\n`;
                    roundMsg += dmgLines.join('\n') + '\n\n';
                    roundMsg += `❤️ Boss: ${raidHpBar(raid.hp, raid.maxHp)} (${hpPct}%)\n\n`;
                    roundMsg += `⏩ *Next turn:* ${nextName} — type *!raid attack*`;

                    await user.save();
                    return await conn.sendMessage(from, { text: roundMsg });
                }

                return await conn.sendMessage(from, {
                    text: `⚔️ *BOSS RAID*\n\n!raid info — see today's boss\n!raid start — begin the raid\n!raid join — join an active raid\n!raid attack — strike the boss on your turn`
                });
            }

            // ════════════════════════════════════════════════════════════════
            // GACHA — SUMMONING SCROLL
            // ════════════════════════════════════════════════════════════════
            case 'summon':
            case 'gacha':
            case 'scroll': {
                if (!user || user.registrationStep !== 'COMPLETED') {
                    return await conn.sendMessage(from, { text: '❌ Register first! Type !start.' });
                }

                const pullType = (args[0] || '').toLowerCase();

                // ── Show banner ────────────────────────────────────────────
                if (!pullType || pullType === 'banner' || pullType === 'rates') {
                    const txt = bannerText(user.gachaPity || 0, user.gems || 0, user.ryo || 0);
                    return await conn.sendMessage(from, prepareImagePayload('welcome', txt));
                }

                // ── Single pull (5 gems) ───────────────────────────────────
                if (pullType === 'single') {
                    if ((user.gems || 0) < 5) {
                        return await conn.sendMessage(from, { text: `❌ Need 5 💎 Gems for a single pull. You have ${user.gems || 0}.` });
                    }
                    user.gems -= 5;
                    user.totalPulls = (user.totalPulls || 0) + 1;
                    const { results, newPityCount } = performPulls(1, user.gachaPity || 0, user.ownedGachaChars || []);
                    user.gachaPity = newPityCount;
                    const char = results[0];
                    if (!char.isDupe) {
                        user.ownedGachaChars = [...(user.ownedGachaChars || []), char.id];
                        user.ownedCharacters = [...(user.ownedCharacters || []), char.id];
                    } else {
                        user.gems += char.dupeGems;
                    }
                    await user.save();
                    const pullsLeft = 10 - user.gachaPity;
                    return await conn.sendMessage(from, prepareImagePayload('welcome',
                        formatPullResult(results, false) +
                        `🎯 Pity: ${user.gachaPity}/10 (Guaranteed Legendary in ${pullsLeft} pull${pullsLeft !== 1 ? 's' : ''})\n` +
                        `💎 Remaining: ${user.gems} Gems`
                    ));
                }

                // ── 10-pull (40 gems) ─────────────────────────────────────
                if (pullType === 'multi' || pullType === '10') {
                    if ((user.gems || 0) < 40) {
                        return await conn.sendMessage(from, { text: `❌ Need 40 💎 Gems for a 10-pull. You have ${user.gems || 0}.\n\n_Single pull costs 5 gems — try !summon single_` });
                    }
                    user.gems -= 40;
                    user.totalPulls = (user.totalPulls || 0) + 10;
                    const { results, newPityCount, hadGuaranteed } = performPulls(10, user.gachaPity || 0, user.ownedGachaChars || []);
                    user.gachaPity = newPityCount;
                    let dupeGemsTotal = 0;
                    for (const char of results) {
                        if (!char.isDupe) {
                            user.ownedGachaChars = [...(user.ownedGachaChars || []), char.id];
                            user.ownedCharacters = [...(user.ownedCharacters || []), char.id];
                        } else {
                            dupeGemsTotal += char.dupeGems;
                        }
                    }
                    user.gems += dupeGemsTotal;
                    await user.save();
                    return await conn.sendMessage(from, prepareImagePayload('welcome',
                        formatPullResult(results, hadGuaranteed) +
                        (dupeGemsTotal > 0 ? `♻️ Total dupe gems: +${dupeGemsTotal} 💎\n` : '') +
                        `🎯 Pity reset: ${user.gachaPity}/10\n` +
                        `💎 Remaining: ${user.gems} Gems`
                    ));
                }

                // ── Ryo pull (25,000 ryo) ─────────────────────────────────
                if (pullType === 'ryo') {
                    if ((user.ryo || 0) < 25000) {
                        return await conn.sendMessage(from, { text: `❌ Need 💰 25,000 Ryo for a Ryo pull. You have ${(user.ryo || 0).toLocaleString()}.` });
                    }
                    user.ryo -= 25000;
                    user.totalPulls = (user.totalPulls || 0) + 1;
                    const { results, newPityCount } = performPulls(1, user.gachaPity || 0, user.ownedGachaChars || []);
                    user.gachaPity = newPityCount;
                    const char = results[0];
                    if (!char.isDupe) {
                        user.ownedGachaChars = [...(user.ownedGachaChars || []), char.id];
                        user.ownedCharacters = [...(user.ownedCharacters || []), char.id];
                    } else {
                        user.gems += char.dupeGems;
                    }
                    await user.save();
                    const pullsLeft2 = 10 - user.gachaPity;
                    return await conn.sendMessage(from, prepareImagePayload('welcome',
                        formatPullResult(results, false) +
                        `🎯 Pity: ${user.gachaPity}/10 (Guaranteed in ${pullsLeft2} pull${pullsLeft2 !== 1 ? 's' : ''})\n` +
                        `💰 Remaining: ${(user.ryo || 0).toLocaleString()} Ryo`
                    ));
                }

                // ── Gacha character list ───────────────────────────────────
                if (pullType === 'chars' || pullType === 'list') {
                    const { GACHA_POOL: pool } = require('./gacha');
                    let list = `🔮 *SUMMONABLE CHARACTERS* 🔮\n\n_These characters are EXCLUSIVE to the Summoning Scroll!_\n\n`;
                    const byRarity = { Mythic: [], Legendary: [], Epic: [], Rare: [] };
                    for (const c of pool) byRarity[c.rarity]?.push(c);
                    for (const [rar, chars] of Object.entries(byRarity)) {
                        if (!chars.length) continue;
                        list += `*── ${rar} ──*\n`;
                        for (const c of chars) {
                            const owned = (user.ownedGachaChars || []).includes(c.id);
                            list += `${c.emoji} ${c.name} ${owned ? '✅' : ''}\n`;
                        }
                        list += '\n';
                    }
                    list += `_!summon single/multi/ryo to pull_`;
                    return await conn.sendMessage(from, { text: list });
                }

                return await conn.sendMessage(from, {
                    text: `🔮 *SUMMONING SCROLL*\n\n!summon — show banner & rates\n!summon single — 5 💎\n!summon multi — 40 💎 (10 pulls)\n!summon ryo — 25,000 💰\n!summon chars — see all summonable characters`
                });
            }

            // ════════════════════════════════════════════════════════════════
            // DAILY STORY MISSIONS
            // ════════════════════════════════════════════════════════════════
            case 'storymissions':
            case 'smissions': {
                if (!user || user.registrationStep !== 'COMPLETED') {
                    return await conn.sendMessage(from, { text: '❌ Register first! Type !start.' });
                }
                const missions = getTodaysMissions();
                return await conn.sendMessage(from, prepareImagePayload('welcome', missionBoardText(missions, user)));
            }

            case 'storymission':
            case 'smission': {
                if (!user || user.registrationStep !== 'COMPLETED') {
                    return await conn.sendMessage(from, { text: '❌ Register first! Type !start.' });
                }

                const { can, remaining } = canRunDailyMission(user);
                if (!can) {
                    return await conn.sendMessage(from, { text: `⏰ *Daily mission limit reached!*\n\nYou've completed 3 story missions today.\n_Missions reset at midnight — check !smissions for tomorrow's board._` });
                }

                const tier = (args[0] || '').toUpperCase();
                const todayMissions = getTodaysMissions();
                const mission = todayMissions.find(m => m.rank === tier);

                if (!mission) {
                    return await conn.sendMessage(from, { text: `❌ Unknown rank. Use: !smission d/c/b/a/s\n_See today's board: !smissions_` });
                }
                if (user.hp.current <= 1) {
                    return await conn.sendMessage(from, { text: `🏥 Too injured for a mission! (${user.hp.current} HP)` });
                }
                if (user.chakra.current < mission.chakraCost) {
                    return await conn.sendMessage(from, { text: `❌ Need ${mission.chakraCost} Chakra (have ${user.chakra.current})` });
                }

                user.chakra.current -= mission.chakraCost;
                const successChance = Math.min(97, mission.successChance + (user.level - 1) * 1.5);

                // Failure
                if (Math.random() * 100 > successChance) {
                    const dmg = Math.min(user.hp.current - 1, mission.failDmg);
                    user.hp.current -= dmg;
                    recordDailyMission(user);
                    await user.save();
                    return await conn.sendMessage(from, {
                        text: `🚨 *MISSION FAILED!*\n\n${mission.rankEmoji} *${mission.title}*\n📖 _${mission.story}_\n\n` +
                              `📉 -${mission.chakraCost} Chakra | 💔 -${dmg} HP\n\n_${remaining - 1} daily runs remaining._`
                    });
                }

                // Success
                const ryo = Math.floor(Math.random() * (mission.maxRyo - mission.minRyo + 1)) + mission.minRyo;
                let gems = 0;
                if (mission.gemChance && Math.random() < mission.gemChance) gems = 1;

                user.ryo += ryo;
                user.gems += gems;
                const { leveledUp, rewards } = await addXP(user, mission.xp);
                recordDailyMission(user);
                await user.save();

                let reply = `✅ *MISSION SUCCESS!*\n\n`;
                reply += `${mission.rankEmoji} *${mission.title}*\n`;
                reply += `📖 _${mission.story}_\n\n`;
                reply += `💰 +${ryo.toLocaleString()} Ryo | 📈 +${mission.xp} XP`;
                if (gems) reply += ` | +${gems} 💎`;
                reply += `\n`;
                if (leveledUp) {
                    rewards.forEach(r => {
                        reply += `\n🎉 *LEVEL UP! Now Level ${r.level}!*\n💰 +${r.ryo} Ryo`;
                        if (r.gems > 0) reply += ` | +${r.gems} 💎`;
                        if (r.bonus) reply += `\n${r.bonus}`;
                    });
                }
                reply += `\n\n_${remaining - 1} daily mission run${remaining - 1 !== 1 ? 's' : ''} remaining today._`;
                return await conn.sendMessage(from, { text: reply });
            }


            // ════════════════════════════════════════════════════════════════
            // TAILED BEAST — CHAKRA MODE ACTIVATION
            // ════════════════════════════════════════════════════════════════
            case 'beast':
            case 'bijuu':
            case 'chakramode': {
                if (!user || user.registrationStep !== 'COMPLETED') {
                    return await conn.sendMessage(from, { text: '❌ Register first! Type !start.' });
                }
                if (!activeFights.has(senderJid)) {
                    return await conn.sendMessage(from, { text: '❌ You\'re not in a battle! Start one with !battle d' });
                }
                const fight = activeFights.get(senderJid);
                if (fight.type === 'pvp') {
                    return await conn.sendMessage(from, { text: '❌ Chakra Mode can only be activated in PvE battles for now.' });
                }

                const bijuu = getBijuu(user.character);
                if (!bijuu) {
                    const jinchList = ['Naruto Uzumaki (!naruto)', 'Gaara (!gaara)', 'Killer Bee (!killer_bee)'];
                    return await conn.sendMessage(from, {
                        text: `❌ *${user.username} is not a Jinchuriki!*\n\n` +
                              `Only Tailed Beast hosts can use Chakra Mode:\n` +
                              jinchList.map(c => `  • ${c}`).join('\n') + '\n\n' +
                              `_Switch characters with !switch [name]_`
                    });
                }

                const { success, msg } = activateChakraMode(user, fight, bijuu);
                if (!success) return await conn.sendMessage(from, { text: msg });

                await user.save();
                activeFights.set(senderJid, fight);

                const cm = bijuu.chakraMode;
                return await conn.sendMessage(from, prepareImagePayload(
                    user.character === 'naruto' ? 'naruto' : user.character === 'gaara' ? 'gaara' : 'killer_bee',
                    msg +
                    `\n⚡ *Special move unlocked:*\n` +
                    `  💣 *${cm.specialMove.name}* — ${cm.specialMove.desc}\n` +
                    `  _Type !beastbomb to use it (once per Chakra Mode)_\n\n` +
                    `_Your stats are now massively boosted — strike hard!_`
                ));
            }

            // ════════════════════════════════════════════════════════════════
            // TAILED BEAST BOMB — SPECIAL MOVE DURING CHAKRA MODE
            // ════════════════════════════════════════════════════════════════
            case 'beastbomb':
            case 'bijuudama': {
                if (!user || user.registrationStep !== 'COMPLETED') {
                    return await conn.sendMessage(from, { text: '❌ Register first! Type !start.' });
                }
                if (!activeFights.has(senderJid)) {
                    return await conn.sendMessage(from, { text: '❌ You\'re not in a battle!' });
                }
                const fight = activeFights.get(senderJid);
                const bijuu = getBijuu(user.character);
                if (!bijuu) {
                    return await conn.sendMessage(from, { text: '❌ You are not a Jinchuriki!' });
                }

                const { success, msg, move } = useBeastBomb(bijuu, fight);
                if (!success) return await conn.sendMessage(from, { text: msg });

                // Resolve the beast bomb as a powerful attack
                const buffs = await getClanBuffs(user);
                const baseSelf = getEffectiveStats(user, buffs);
                const psBase = mergeStatBonuses({ ...baseSelf }, fight.effects, 'self');
                const boostedPs = applyBijuuStats(psBase, bijuu, fight.bijuuState);
                const baseEnemy = {
                    attack: fight.enemyStats.attack, defense: fight.enemyStats.defense,
                    crit: fight.enemyStats.crit, dodge: 0, lifesteal: 0, nature: fight.enemyNature,
                };
                const enemyCombatant = mergeStatBonuses({ ...baseEnemy }, fight.effects, 'enemy');

                const hit = resolveHit(boostedPs, enemyCombatant, move.damage, move.nature);
                fight.enemyHp = Math.max(0, fight.enemyHp - hit.dealt);

                let bombLog = `💣 *${bijuu.emoji} ${move.name}!*\n`;
                bombLog += `_${move.desc}_\n`;
                bombLog += `${hit.crit ? '💥 CRITICAL HIT! ' : ''}${hit.dealt.toLocaleString()} DAMAGE!\n\n`;

                if (fight.enemyHp <= 0) {
                    activeFights.delete(senderJid);
                    await user.save();
                    return await finishPveWin(conn, from, user, fight, bombLog);
                }

                // Enemy counter
                const eMove = enemyChooseMove(fight, fight.enemyHp, fight.enemyMaxHp, fight.enemyPp);
                if (fight.enemyPp[eMove.name] > 0) fight.enemyPp[eMove.name] -= 1;
                const eHit = resolveHit(enemyCombatant, boostedPs, eMove.damage, eMove.nature);
                if (!eHit.dodged && eMove.damage > 0) {
                    if (checkSandShield(fight)) {
                        bombLog += `🏜️ Sand Shield blocks ${fight.enemyName}'s counter!\n`;
                    } else {
                        user.hp.current = Math.max(1, user.hp.current - eHit.dealt);
                        bombLog += `${fight.enemyEmoji} ${fight.enemyName} counters with _${eMove.name}_ — ${eHit.dealt} dmg!\n`;
                    }
                }

                fight.round += 1;
                await user.save();
                activeFights.set(senderJid, fight);

                bombLog +=
                    `\n${fight.enemyEmoji} *${fight.enemyName}*\n${hpBar(fight.enemyHp, fight.enemyMaxHp)}\n\n` +
                    `${bijuu.emoji} *${user.username}* (Chakra Mode — ${fight.bijuuState.chakraModeTurns} turns left)\n` +
                    `${hpBar(user.hp.current, user.hp.max)}\n${chakraBar(user.chakra.current, user.chakra.max)}\n\n` +
                    `_Round ${fight.round} — !use to continue_`;

                return await conn.sendMessage(from, { text: bombLog });
            }

            // ════════════════════════════════════════════════════════════════
            // BIJUU STATUS CHECK
            // ════════════════════════════════════════════════════════════════
            case 'bijuuinfo':
            case 'beastinfo': {
                if (!user || user.registrationStep !== 'COMPLETED') {
                    return await conn.sendMessage(from, { text: '❌ Register first!' });
                }
                const bijuu = getBijuu(user.character);
                if (!bijuu) {
                    return await conn.sendMessage(from, {
                        text: `👁️ *${user.username} is not a Jinchuriki*\n\n` +
                              `To become one, switch to:\n` +
                              `  🦊 Naruto — hosts Kurama (Nine-Tails)\n` +
                              `  🏜️ Gaara — hosts Shukaku (One-Tail)\n` +
                              `  🐂 Killer Bee — hosts Gyuki (Eight-Tails)\n\n` +
                              `_!switch [name] to change character_`
                    });
                }
                const cm = bijuu.chakraMode;
                const v1 = bijuu.v1;
                const info =
                    `${bijuu.emoji} *${bijuu.name} (${bijuu.title})* — ${bijuu.tails} Tail${bijuu.tails > 1 ? 's' : ''}\n\n` +
                    `🔴 *Auto-Transform (V1 Cloak)*\n` +
                    `_Triggers automatically when HP drops below 20%_\n` +
                    `  💚 Restores ${Math.round(v1.hpRestore * 100)}% max HP on trigger\n` +
                    `  ⚔️ ATK ×${v1.attackMult} | 🛡️ DEF ×${v1.defenseMult} | ⚡ SPD ×${v1.speedMult}\n` +
                    (v1.passiveHealPerTurn > 0 ? `  💚 +${v1.passiveHealPerTurn} HP per turn (bijuu regen)\n` : '') +
                    (v1.passiveSandShield ? `  🏜️ Sand Shield: negates next attack completely\n` : '') +
                    (v1.inkBarrage ? `  🐂 30% per turn: ink stun on enemy\n` : '') +
                    `\n⚡ *Chakra Mode*  (!beast to activate)\n` +
                    `_${cm.desc}_\n` +
                    `  💧 Cost: ${cm.cost} Chakra\n` +
                    `  ⏱️ Duration: ${cm.turns} turns\n` +
                    `  📈 ATK +${cm.attackBonus} | DEF +${cm.defenseBonus} | SPD +${cm.speedBonus}\n` +
                    `  💣 Special: *${cm.specialMove.name}* (${cm.specialMove.damage} dmg — once per mode)\n` +
                    `  ⚠️ Chakra Crash after: -${Math.round(cm.crashPct * 100)}% current chakra\n\n` +
                    `_Use !beast during a fight to activate Chakra Mode!_`;
                return await conn.sendMessage(from, prepareImagePayload(user.character, info));
            }


            // ════════════════════════════════════════════════════════════════
            // DOJUTSU — EYE TECHNIQUES
            // ════════════════════════════════════════════════════════════════
            case 'dojutsu':
            case 'eye': {
                if (!user || user.registrationStep !== 'COMPLETED') {
                    return await conn.sendMessage(from, { text: '❌ Register first! Type !start.' });
                }

                // Outside battle — show info
                if (!activeFights.has(senderJid)) {
                    if (!hasDojutsu(user.character)) {
                        return await conn.sendMessage(from, {
                            text: `👁️ *${user.username} has no Dojutsu*\n\n` +
                                  `Characters with eye techniques:\n` +
                                  `  🔴 *Sharingan* — Sasuke, Itachi, Kakashi, Obito\n` +
                                  `  ⭕ *Byakugan* — Neji Hyuga\n` +
                                  `  🔵 *Rinnegan* — Pain (Nagato)\n` +
                                  `  💫 *Mangekyou* — Shisui (Summoning Scroll)\n\n` +
                                  `_Switch with !switch [character name]_`
                        });
                    }
                    const info = dojutsuInfoText(user.character);
                    return await conn.sendMessage(from, prepareImagePayload(user.character, info));
                }

                // Inside battle — use active technique
                const fight = activeFights.get(senderJid);
                if (fight.type === 'pvp') {
                    return await conn.sendMessage(from, { text: '❌ Dojutsu active moves only work in PvE battles for now.' });
                }
                if (!fight.dojutsuState) {
                    return await conn.sendMessage(from, { text: `❌ ${user.character} doesn't have a Dojutsu.` });
                }

                const subCmd = (args[0] || '').toLowerCase();
                if (!subCmd) {
                    // Show available moves mid-battle
                    const info = dojutsuInfoText(user.character);
                    return await conn.sendMessage(from, { text: info });
                }

                const { success, move, log: dLog, specialEffect, msg } = useDojutsu(
                    subCmd, user.character, fight.dojutsuState, user, fight
                );
                if (!success) return await conn.sendMessage(from, { text: msg });

                let log = dLog;

                // Resolve damage / buff
                if (move.damage > 0) {
                    const buffs = await getClanBuffs(user);
                    const baseSelf = getEffectiveStats(user, buffs);
                    const psBase = mergeStatBonuses({ ...baseSelf }, fight.effects, 'self');
                    const psD = applyDojutsuStats(psBase, user.character, fight.dojutsuState);
                    const enemyPs = {
                        attack: fight.enemyStats.attack, defense: fight.enemyStats.defense,
                        crit: fight.enemyStats.crit, dodge: 0, lifesteal: 0,
                    };
                    const enemyCombatant2 = mergeStatBonuses({ ...enemyPs }, fight.effects, 'enemy');

                    const hit = resolveHit(
                        psD, enemyCombatant2, move.damage, move.nature,
                        specialEffect?.undodgeable ? { forceLand: true } : {}
                    );
                    fight.enemyHp = Math.max(0, fight.enemyHp - hit.dealt);
                    log += `${hit.crit ? '💥 CRIT! ' : ''}${hit.dealt} damage!\n`;

                    // Chakra drain (Human Path etc.)
                    if (specialEffect?.chakraDrain) {
                        fight.enemyChakraDrained = (fight.enemyChakraDrained || 0) + specialEffect.chakraDrain;
                        log += `💧 Drained ${specialEffect.chakraDrain} enemy chakra!\n`;
                    }
                } else if (move.buff?.stun) {
                    // Stun moves
                    fight.effects.enemy = fight.effects.enemy || {};
                    fight.effects.enemy.stunTurns = (fight.effects.enemy.stunTurns || 0) + move.buff.stun;
                    log += `😵 Enemy stunned for ${move.buff.stun} turn${move.buff.stun > 1 ? 's' : ''}!\n`;
                } else if (move.damage < 0 || specialEffect?.fullHeal) {
                    // Already handled in useDojutsu for fullHeal
                }

                // Seal effect (Totsuka blade)
                if (specialEffect?.sealed) {
                    log += `🗡️ *Totsuka Blade seals the enemy* — jutsus blocked for 2 turns!\n`;
                }

                // Self-buff (Susano'o)
                if (specialEffect?.selfBuff) {
                    const sb = specialEffect.selfBuff;
                    if (sb.defense) fight.effects.self.defense = (fight.effects.self.defense || 0) + sb.defense;
                    log += `🛡️ ${sb.defense ? `+${sb.defense} defense` : ''} for ${sb.turns} turns!\n`;
                }

                // Win check after dojutsu
                if (fight.enemyHp <= 0) {
                    activeFights.delete(senderJid);
                    await user.save();
                    return await finishPveWin(conn, from, user, fight, log);
                }

                // Enemy counter
                const eMove2 = enemyChooseMove(fight, fight.enemyHp, fight.enemyMaxHp, fight.enemyPp);
                if (fight.enemyPp[eMove2.name] > 0) fight.enemyPp[eMove2.name] -= 1;
                const buffs2 = await getClanBuffs(user);
                const baseSelf2 = getEffectiveStats(user, buffs2);
                const psE = mergeStatBonuses({ ...baseSelf2 }, fight.effects, 'self');
                const enemyPs2 = { attack: fight.enemyStats.attack, defense: fight.enemyStats.defense, crit: fight.enemyStats.crit, dodge: 0 };
                const ePs2 = mergeStatBonuses({ ...enemyPs2 }, fight.effects, 'enemy');
                const eHit2 = resolveHit(ePs2, psE, eMove2.damage, eMove2.nature);

                if (fight.dojutsuState) {
                    fight.lastEnemyMove = { name: eMove2.name, damage: eMove2.damage, cost: 50, nature: eMove2.nature };
                    const { absorbed, log: drLog2 } = onReceiveHit(user.character, fight.dojutsuState, user, fight, eMove2);
                    log += drLog2;
                    if (!absorbed && eMove2.damage > 0 && !eHit2.dodged) {
                        if (!checkSandShield(fight)) {
                            user.hp.current = Math.max(1, user.hp.current - eHit2.dealt);
                            log += `${fight.enemyEmoji} ${fight.enemyName} counters with _${eMove2.name}_ — ${eHit2.dealt} dmg!\n`;
                        }
                    } else if (!absorbed) {
                        log += `${fight.enemyEmoji} ${fight.enemyName} uses _${eMove2.name}_ — 👻 dodged!\n`;
                    }
                } else if (!eHit2.dodged && eMove2.damage > 0) {
                    user.hp.current = Math.max(1, user.hp.current - eHit2.dealt);
                    log += `${fight.enemyEmoji} ${fight.enemyName} counters — ${eHit2.dealt} dmg!\n`;
                }

                // Per-turn dojutsu tick
                if (fight.dojutsuState) {
                    log += tickDojutsuPassives(user.character, fight.dojutsuState, user, fight);
                }

                fight.round += 1;
                await user.save();
                activeFights.set(senderJid, fight);

                const { eye, emoji: dEmoji } = fight.dojutsuState;
                log +=
                    `\n${fight.enemyEmoji} *${fight.enemyName}*\n${hpBar(fight.enemyHp, fight.enemyMaxHp)}\n\n` +
                    `${dEmoji || '👁️'} *${user.username}* [${fight.dojutsuState.eye}]\n` +
                    `${hpBar(user.hp.current, user.hp.max)}\n${chakraBar(user.chakra.current, user.chakra.max)}\n\n` +
                    `_Round ${fight.round} — !use or !dojutsu [number]_`;

                return await conn.sendMessage(from, { text: log });
            }

            default: {
                // Only reply if it actually looked like a command attempt (started with !)
                // — avoids the bot butting into normal group chat messages.
                if (cleanText.startsWith('!') && command) {
                    return await conn.sendMessage(from, {
                        text: `❓ Unknown command: *!${command}*\n\nType !menu to see all available commands.`
                    });
                }
                break;
            }
        }
    } catch (err) {
        console.error('❌ [CASE] Error:', err);
    }
};

module.exports.activeExams  = activeExams;
module.exports.activeFights = activeFights; 
