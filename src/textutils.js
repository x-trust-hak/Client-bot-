// textutils.js — Lady Liya Text & Calculator Utilities
//
// Everything here is pure JavaScript / Node built-ins only — no npm
// dependencies, so it works identically in any environment with zero
// install risk.

const crypto = require('crypto');

// ── rot13 ──
function rot13(str) {
    return str.replace(/[a-zA-Z]/g, c => {
        const base = c <= 'Z' ? 65 : 97;
        return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
    });
}

// ── json format/validate ──
function formatJson(input) {
    const parsed = JSON.parse(input); // throws on invalid JSON — caller catches
    return JSON.stringify(parsed, null, 2);
}

// ── word/char count ──
function wordCount(text) {
    const trimmed = text.trim();
    const words = trimmed.length ? trimmed.split(/\s+/).length : 0;
    const chars = text.length;
    const charsNoSpaces = text.replace(/\s/g, '').length;
    const sentences = (trimmed.match(/[.!?]+/g) || []).length;
    return { words, chars, charsNoSpaces, sentences };
}

// ── password generator ──
function generatePassword(length = 16, opts = {}) {
    const { lower = true, upper = true, digits = true, symbols = true } = opts;
    let pool = '';
    if (lower) pool += 'abcdefghijklmnopqrstuvwxyz';
    if (upper) pool += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    if (digits) pool += '0123456789';
    if (symbols) pool += '!@#$%^&*()-_=+[]{}';
    if (!pool) pool = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

    const bytes = crypto.randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i++) out += pool[bytes[i] % pool.length];
    return out;
}

// ── BMI calculator ──
// heightCm, weightKg -> { bmi, category }
function calcBmi(heightCm, weightKg) {
    const heightM = heightCm / 100;
    const bmi = weightKg / (heightM * heightM);
    let category;
    if (bmi < 18.5) category = 'Underweight';
    else if (bmi < 25) category = 'Normal weight';
    else if (bmi < 30) category = 'Overweight';
    else category = 'Obese';
    return { bmi: Math.round(bmi * 10) / 10, category };
}

// ── tip calculator ──
function calcTip(bill, tipPercent = 15, splitCount = 1) {
    const tip = bill * (tipPercent / 100);
    const total = bill + tip;
    return {
        tip: Math.round(tip * 100) / 100,
        total: Math.round(total * 100) / 100,
        perPerson: Math.round((total / splitCount) * 100) / 100
    };
}

// ── age calculator ──
function calcAge(birthDate) {
    const now = new Date();
    let years = now.getFullYear() - birthDate.getFullYear();
    let months = now.getMonth() - birthDate.getMonth();
    let days = now.getDate() - birthDate.getDate();
    if (days < 0) {
        months--;
        const lastMonth = new Date(now.getFullYear(), now.getMonth(), 0);
        days += lastMonth.getDate();
    }
    if (months < 0) { years--; months += 12; }

    const totalDays = Math.floor((now - birthDate) / (1000 * 60 * 60 * 24));
    return { years, months, days, totalDays };
}

// ── countdown ──
function calcCountdown(targetDate) {
    const diffMs = targetDate.getTime() - Date.now();
    const past = diffMs < 0;
    const abs = Math.abs(diffMs);
    const days = Math.floor(abs / (1000 * 60 * 60 * 24));
    const hours = Math.floor((abs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((abs % (1000 * 60 * 60)) / (1000 * 60));
    return { past, days, hours, minutes };
}

// ── expense split ──
function splitExpense(amount, peopleCount) {
    const perPerson = Math.round((amount / peopleCount) * 100) / 100;
    const remainder = Math.round((amount - perPerson * peopleCount) * 100) / 100;
    return { perPerson, remainder };
}

// ── zodiac (western) ──
const ZODIAC_SIGNS = [
    { sign: 'Capricorn', emoji: '♑', from: [12, 22], to: [1, 19] },
    { sign: 'Aquarius', emoji: '♒', from: [1, 20], to: [2, 18] },
    { sign: 'Pisces', emoji: '♓', from: [2, 19], to: [3, 20] },
    { sign: 'Aries', emoji: '♈', from: [3, 21], to: [4, 19] },
    { sign: 'Taurus', emoji: '♉', from: [4, 20], to: [5, 20] },
    { sign: 'Gemini', emoji: '♊', from: [5, 21], to: [6, 20] },
    { sign: 'Cancer', emoji: '♋', from: [6, 21], to: [7, 22] },
    { sign: 'Leo', emoji: '♌', from: [7, 23], to: [8, 22] },
    { sign: 'Virgo', emoji: '♍', from: [8, 23], to: [9, 22] },
    { sign: 'Libra', emoji: '♎', from: [9, 23], to: [10, 22] },
    { sign: 'Scorpio', emoji: '♏', from: [10, 23], to: [11, 21] },
    { sign: 'Sagittarius', emoji: '♐', from: [11, 22], to: [12, 21] }
];

function getZodiacSign(month, day) {
    for (const z of ZODIAC_SIGNS) {
        const [fromM, fromD] = z.from, [toM, toD] = z.to;
        if (fromM === toM) { if (month === fromM && day >= fromD && day <= toD) return z; continue; }
        if (fromM > toM) { // wraps around year end (Capricorn)
            if ((month === fromM && day >= fromD) || (month === toM && day <= toD)) return z;
        } else {
            if ((month === fromM && day >= fromD) || (month === toM && day <= toD) || (month > fromM && month < toM)) return z;
        }
    }
    return null;
}

// ── zodiac (chinese) ──
const CHINESE_ZODIAC = ['Monkey', 'Rooster', 'Dog', 'Pig', 'Rat', 'Ox', 'Tiger', 'Rabbit', 'Dragon', 'Snake', 'Horse', 'Goat'];
function getChineseZodiac(year) {
    return CHINESE_ZODIAC[year % 12];
}

// ── numerology (life path number) ──
function getLifePathNumber(year, month, day) {
    const digits = `${year}${month}${day}`.split('').map(Number);
    let sum = digits.reduce((a, b) => a + b, 0);
    const isMaster = n => n === 11 || n === 22 || n === 33;
    while (sum > 9 && !isMaster(sum)) {
        sum = String(sum).split('').map(Number).reduce((a, b) => a + b, 0);
    }
    return sum;
}

const LIFE_PATH_MEANINGS = {
    1: "A natural-born leader — independent, driven, and a bit of a trailblazer.",
    2: "A peacemaker — diplomatic, sensitive, and great at bringing people together.",
    3: "Expressive and creative — the life of the party with a gift for words.",
    4: "Grounded and disciplined — the reliable one everyone counts on.",
    5: "Adventurous and freedom-loving — change is your comfort zone.",
    6: "Nurturing and responsible — a natural caretaker of people and causes.",
    7: "Analytical and introspective — a seeker of truth and deeper meaning.",
    8: "Ambitious and business-minded — power and achievement come naturally.",
    9: "Compassionate and idealistic — driven to make the world better.",
    11: "A master intuitive — highly perceptive with strong spiritual insight.",
    22: "A master builder — turns big dreams into real, lasting things.",
    33: "A master healer — selfless devotion to uplifting others."
};

// ── tarot ──
const TAROT_DECK = [
    ["The Fool", "New beginnings, spontaneity, a leap of faith."],
    ["The Magician", "Resourcefulness, willpower, manifestation."],
    ["The High Priestess", "Intuition, mystery, hidden knowledge."],
    ["The Empress", "Abundance, nurturing, creativity."],
    ["The Emperor", "Structure, authority, stability."],
    ["The Hierophant", "Tradition, guidance, shared beliefs."],
    ["The Lovers", "Connection, choices, alignment of values."],
    ["The Chariot", "Willpower, determination, victory through focus."],
    ["Strength", "Courage, patience, quiet inner power."],
    ["The Hermit", "Reflection, solitude, inner searching."],
    ["Wheel of Fortune", "Change, cycles, unexpected turns."],
    ["Justice", "Fairness, truth, cause and effect."],
    ["The Hanged Man", "Pause, new perspective, letting go."],
    ["Death", "Endings, transformation, release."],
    ["Temperance", "Balance, patience, moderation."],
    ["The Devil", "Attachment, temptation, old patterns."],
    ["The Tower", "Sudden change, upheaval, revelation."],
    ["The Star", "Hope, renewal, inspiration."],
    ["The Moon", "Uncertainty, intuition, the subconscious."],
    ["The Sun", "Joy, success, clarity."],
    ["Judgement", "Reflection, reckoning, a turning point."],
    ["The World", "Completion, fulfillment, wholeness."]
];

function drawTarotCard() {
    const [name, meaning] = TAROT_DECK[Math.floor(Math.random() * TAROT_DECK.length)];
    const reversed = Math.random() < 0.25;
    return { name, meaning, reversed };
}

// ── IQ test (joke, not a real assessment) ──
function fakeIqScore() {
    const roll = Math.random();
    let score;
    if (roll < 0.05) score = Math.floor(Math.random() * 40) + 60;
    else if (roll < 0.9) score = Math.floor(Math.random() * 40) + 90;
    else score = Math.floor(Math.random() * 40) + 130;

    let comment;
    if (score < 85) comment = "Well, you tried. 💀";
    else if (score < 100) comment = "Solidly average — reassuring, honestly.";
    else if (score < 115) comment = "Sharper than most. Not bad!";
    else if (score < 140) comment = "Big brain energy. 🧠";
    else comment = "Certified genius. Nobody believes this result, including you.";
    return { score, comment };
}

// ── anagram checker ──
function normalizeForAnagram(str) {
    return str.toLowerCase().replace(/[^a-z0-9]/g, '').split('').sort().join('');
}
function areAnagrams(a, b) {
    return normalizeForAnagram(a) === normalizeForAnagram(b) && normalizeForAnagram(a).length > 0;
}

// ── emoji rebus quiz ──
const EMOJI_QUIZ = [
    ["🦁👑", "The Lion King"],
    ["🕷️👨", "Spider-Man"],
    ["❄️👸", "Frozen"],
    ["🌊🔍", "Finding Nemo"],
    ["🍫🏭", "Charlie and the Chocolate Factory"],
    ["🦈", "Jaws"],
    ["🚢🧊💔", "Titanic"],
    ["👻🚫", "Ghostbusters"],
    ["🦖🏞️", "Jurassic Park"],
    ["🐝🎬", "Bee Movie"],
    ["🧙‍♂️💍", "The Lord of the Rings"],
    ["👦⚡📚", "Harry Potter"],
    ["🤖❤️🌍", "WALL-E"],
    ["🐟🐠👨‍👦", "Finding Nemo"],
    ["🦇👨", "Batman"],
    ["🍎🏢", "Apple"],
    ["📱📞", "Phone Booth"],
    ["🌙🚶", "Moonwalker"]
];
function randomEmojiQuiz() {
    const [emoji, answer] = EMOJI_QUIZ[Math.floor(Math.random() * EMOJI_QUIZ.length)];
    return { emoji, answer };
}

// ── pickup lines ──
const PICKUP_LINES = [
    "Are you a parking ticket? Because you've got FINE written all over you.",
    "Do you have a map? I keep getting lost in your eyes.",
    "Are you WiFi? Because I'm really feeling a connection.",
    "Is your name Google? Because you're everything I've been searching for.",
    "Are you a camera? Every time I look at you, I smile.",
    "Do you believe in love at first sight, or should I walk by again?",
    "Are you a magician? Because whenever I look at you, everyone else disappears.",
    "If you were a vegetable, you'd be a cute-cumber.",
    "Are you a loan? Because you've got my interest.",
    "Is it hot in here, or is it just you?",
    "Are you made of copper and tellurium? Because you're Cu-Te.",
    "Do you have a sunburn, or are you always this hot?",
    "Are you a time traveler? Because I can already see you in my future.",
    "I must be a snowflake, because I've fallen for you."
];

// ── business name generator ──
const BIZ_ADJECTIVES = ['Bright', 'Bold', 'Swift', 'Golden', 'Urban', 'Prime', 'Silver', 'Nova', 'Peak', 'Vivid', 'Northstar', 'Blue', 'Rustic', 'Modern'];
const BIZ_NOUNS = ['Forge', 'Hive', 'Collective', 'Studio', 'Works', 'Labs', 'Co', 'House', 'Group', 'Path', 'Craft', 'Nest', 'Yard', 'Loop'];
function generateBusinessNames(topic, count = 5) {
    const names = new Set();
    const cleanTopic = (topic || '').trim();
    let guard = 0;
    while (names.size < count && guard < 50) {
        guard++;
        const adj = BIZ_ADJECTIVES[Math.floor(Math.random() * BIZ_ADJECTIVES.length)];
        const noun = BIZ_NOUNS[Math.floor(Math.random() * BIZ_NOUNS.length)];
        const pattern = Math.floor(Math.random() * 3);
        let name;
        if (cleanTopic) {
            if (pattern === 0) name = `${adj} ${cleanTopic} ${noun}`;
            else if (pattern === 1) name = `${cleanTopic}${noun}`;
            else name = `The ${cleanTopic} ${noun}`;
        } else {
            name = `${adj} ${noun}`;
        }
        names.add(name);
    }
    return [...names];
}

// ── hashtag generator (heuristic, not real trend data) ──
function generateHashtags(topic) {
    const words = topic.trim().split(/\s+/).filter(Boolean);
    const tags = new Set();
    tags.add('#' + words.join(''));
    for (const w of words) tags.add('#' + w.replace(/[^a-zA-Z0-9]/g, ''));
    tags.add('#' + words.join('') + 'Life');
    tags.add('#' + words.join('') + 'Vibes');
    const generic = ['#trending', '#viral', '#mood', '#daily', '#instagood'];
    for (const g of generic) tags.add(g);
    return [...tags].filter(t => t.length > 1).slice(0, 10);
}

// ── fake name generator ──
const FAKE_FIRST_NAMES = ['Jordan', 'Avery', 'Riley', 'Casey', 'Morgan', 'Skyler', 'Rowan', 'Dakota', 'Emerson', 'Reese', 'Quinn', 'Sage', 'Blake', 'Elliot'];
const FAKE_LAST_NAMES = ['Sinclair', 'Whitfield', 'Ashworth', 'Blackwood', 'Fairweather', 'Hartley', 'Kingsley', 'Merriweather', 'Sterling', 'Thorne', 'Vance', 'Winslow'];
function generateFakeName() {
    const first = FAKE_FIRST_NAMES[Math.floor(Math.random() * FAKE_FIRST_NAMES.length)];
    const last = FAKE_LAST_NAMES[Math.floor(Math.random() * FAKE_LAST_NAMES.length)];
    return `${first} ${last}`;
}

module.exports = {
    rot13,
    formatJson,
    wordCount,
    generatePassword,
    calcBmi,
    calcTip,
    calcAge,
    calcCountdown,
    splitExpense,
    getZodiacSign,
    getChineseZodiac,
    getLifePathNumber,
    LIFE_PATH_MEANINGS,
    drawTarotCard,
    fakeIqScore,
    areAnagrams,
    randomEmojiQuiz,
    PICKUP_LINES,
    generateBusinessNames,
    generateHashtags,
    generateFakeName
};
