// funstuff.js — Lady Liya Party Games & Fun Stuff
//
// Content pools + small Redis-backed helpers for the FUN command set.
// All prompt content (truth/dare/wyr/never) is kept deliberately PG —
// no alcohol/drugs, no sexual content, nothing illegal or unsafe —
// since these run in group chats of unknown age composition.

// ── content pools ───────────────────────────────────────────────

const FORTUNES = [
    "A pleasant surprise is waiting for you this week.",
    "The person you're thinking about is thinking about you too.",
    "Your hard work is about to pay off — hang in there.",
    "Good things come to those who double-check their typos.",
    "An unexpected message will brighten your day soon.",
    "You are stronger than your last three excuses.",
    "A small risk today leads to a big win tomorrow.",
    "Someone in this chat secretly admires your sense of humor.",
    "Your next meal will be better than you expect.",
    "The stars say: stop overthinking and just send the text.",
    "A closed door usually means a better one is about to open.",
    "You will laugh so hard today that your stomach hurts.",
    "Patience isn't your strong suit today, but it'll pay off anyway.",
    "Someone owes you a favor and they know it.",
    "This is a good week to start that thing you keep postponing.",
    "Your luck is about to change — for the better.",
    "A friend will surprise you with their generosity soon.",
    "Trust your gut on the decision you're sitting on.",
    "You'll find something you thought you lost.",
    "Today's chaos is tomorrow's funny story.",
    "Someone is going to text you first for once.",
    "Your energy today will attract exactly what you need.",
    "A little spontaneity goes a long way this week.",
    "You're closer to your goal than it feels right now.",
    "Expect a compliment from someone you didn't expect it from."
];

const TRUTHS = [
    "What's the most embarrassing thing you've done in front of a crush?",
    "What's a lie you told that somehow got out of hand?",
    "What's the weirdest thing you've Googled this month?",
    "What's your most irrational fear?",
    "What's a habit of yours that you're pretty sure annoys everyone?",
    "What's the pettiest reason you've ever been mad at someone?",
    "What's the most embarrassing thing in your camera roll right now?",
    "What's a rumor about you that was actually true?",
    "What's the last thing you lied to your parents about?",
    "What's your most used emoji and why?",
    "What's the worst gift you've ever received (and pretended to love)?",
    "What's a food combination you love that everyone judges you for?",
    "What's the longest you've gone without showering and still left the house?",
    "What's something you pretend to understand but actually don't?",
    "Who in this chat would you trust with a secret the most?",
    "What's the most childish thing you still do?",
    "What's your guilty pleasure song?",
    "What's the worst haircut you've ever had?",
    "What's a text you regret sending?",
    "What's the last thing that made you cry (that wasn't a movie)?"
];

const DARES = [
    "Send a voice note singing the chorus of your favorite song.",
    "Text the last person you called and say 'I need your help hiding a body' — then immediately say it's a joke.",
    "Change your profile picture to something embarrassing for the next hour.",
    "Type your next 3 messages using only emojis.",
    "Do your best impression of someone in this chat (in a message).",
    "Send the 5th photo in your camera roll, no matter what it is.",
    "Text 'I love Mondays' to a group chat where that's clearly a lie.",
    "Speak (or type) in rhymes for your next 5 messages.",
    "Send a selfie with the weirdest face you can make.",
    "Tell everyone your most-used autocorrect fail.",
    "Do 10 jumping jacks and send proof (photo or video).",
    "Let the group pick your profile picture for the next 24 hours.",
    "Send a voice note doing your worst pickup line.",
    "Reply to your next message in this chat entirely in song lyrics.",
    "Send the last meme you saved to your phone.",
    "Text someone 'guess what' and post their reply here.",
    "Compliment three random people in this chat, one sentence each.",
    "Type out the alphabet backwards without looking it up.",
    "Send a photo of whatever's directly to your right, right now.",
    "Describe your day using only movie titles."
];

const WYR = [
    ["have the ability to fly", "have the ability to turn invisible"],
    ["never use social media again", "never watch another movie or show again"],
    ["always be 10 minutes late", "always be 20 minutes early"],
    ["be able to talk to animals", "be able to speak every human language fluently"],
    ["have unlimited money but no friends", "have amazing friends but be broke forever"],
    ["live without music", "live without air conditioning/heating"],
    ["always have to say what you're thinking", "never be able to speak again"],
    ["be famous but broke", "be rich but unknown"],
    ["lose your sense of smell", "lose your sense of taste"],
    ["relive the same day forever", "skip 10 years into the future instantly"],
    ["always have slow wifi", "always have a slow phone"],
    ["know how you'll die", "know when you'll die"],
    ["be the funniest person in the room", "be the smartest person in the room"],
    ["never eat your favorite food again", "eat only your favorite food forever"],
    ["have a rewind button for your life", "have a pause button for your life"]
];

const NEVER = [
    "Never have I ever pretended to be sick to get out of something.",
    "Never have I ever stalked someone's social media for hours.",
    "Never have I ever sent a text to the wrong person.",
    "Never have I ever forgotten someone's name mid-introduction.",
    "Never have I ever laughed so hard I cried in public.",
    "Never have I ever pretended to know a song I'd never heard.",
    "Never have I ever eaten food off the floor.",
    "Never have I ever ghosted someone.",
    "Never have I ever cried during a movie and tried to hide it.",
    "Never have I ever pretended my phone died to avoid replying.",
    "Never have I ever accidentally liked an old photo while stalking someone's profile.",
    "Never have I ever talked to myself out loud in public.",
    "Never have I ever lied about finishing something I never started.",
    "Never have I ever fallen asleep during a call/video.",
    "Never have I ever showed up to something on the wrong day.",
    "Never have I ever pretended to be busy to skip plans.",
    "Never have I ever screenshotted a conversation to show someone else.",
    "Never have I ever rehearsed a conversation in my head before having it.",
    "Never have I ever sent a risky text and then panic-checked if it was 'delivered'.",
    "Never have I ever laughed at something I didn't understand just to fit in."
];

const CONFESSION_INTROS = [
    "🤫 *Anonymous confession:*",
    "🕵️ *Someone in this chat wants you to know:*",
    "📮 *A secret from the confession box:*",
    "🎭 *Anonymous says:*"
];

// ── random pickers ──────────────────────────────────────────────

function pickRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function randomFortune() { return pickRandom(FORTUNES); }
function randomTruth() { return pickRandom(TRUTHS); }
function randomDare() { return pickRandom(DARES); }
function randomNever() { return pickRandom(NEVER); }
function randomWYR() {
    const [a, b] = pickRandom(WYR);
    return { a, b };
}
function randomConfessionIntro() { return pickRandom(CONFESSION_INTROS); }

// ── deterministic hash, shared by ship/compatibility so re-rolling
//    the same pair always gives the same number (more shareable,
//    avoids spam-rerolling for a better score) ──
function hashPercent(str) {
    let hash = 0;
    for (const ch of str) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return hash % 101;
}

function pairKey(jidA, jidB, salt = '') {
    return [jidA, jidB].sort().join('|') + salt;
}

// Multi-axis compatibility report — same hashing trick as .ship but
// three independent salted scores instead of one, for more depth.
function computeCompatibility(jidA, jidB) {
    const base = [jidA, jidB].sort().join('|');
    return {
        romance: hashPercent(base + ':romance'),
        friendship: hashPercent(base + ':friendship'),
        communication: hashPercent(base + ':communication')
    };
}

// ── nickname storage (global per-user, not per-chat) ────────────
const NICKNAME_PREFIX = 'nickname:';

async function getNickname(redisClient, jid) {
    return redisClient.get(NICKNAME_PREFIX + jid);
}

async function setNickname(redisClient, jid, nickname) {
    return redisClient.set(NICKNAME_PREFIX + jid, nickname);
}

async function clearNickname(redisClient, jid) {
    return redisClient.del(NICKNAME_PREFIX + jid);
}

// ── activity tracking: lastseen (updated every message) + first
//    message on record (set once, per chat) — both are about
//    bot-observed chat activity, NOT WhatsApp's native presence/
//    last-seen privacy feature, which this deliberately doesn't
//    touch or bypass. ──
const LASTSEEN_PREFIX = 'activity:lastseen:';
const FIRSTMSG_PREFIX = 'activity:firstmsg:';

async function recordActivity(redisClient, chatId, jid, preview) {
    const payload = JSON.stringify({ ts: Date.now(), preview: (preview || '').slice(0, 120) });
    await redisClient.set(LASTSEEN_PREFIX + chatId + ':' + jid, payload);
    // NX = only set if this is the first time we've seen this user in this chat
    await redisClient.set(FIRSTMSG_PREFIX + chatId + ':' + jid, payload, { NX: true });
}

async function getLastSeen(redisClient, chatId, jid) {
    const raw = await redisClient.get(LASTSEEN_PREFIX + chatId + ':' + jid);
    return raw ? JSON.parse(raw) : null;
}

async function getFirstMessage(redisClient, chatId, jid) {
    const raw = await redisClient.get(FIRSTMSG_PREFIX + chatId + ':' + jid);
    return raw ? JSON.parse(raw) : null;
}

module.exports = {
    randomFortune,
    randomTruth,
    randomDare,
    randomNever,
    randomWYR,
    randomConfessionIntro,
    pickRandom,
    hashPercent,
    pairKey,
    computeCompatibility,
    getNickname,
    setNickname,
    clearNickname,
    recordActivity,
    getLastSeen,
    getFirstMessage
};
