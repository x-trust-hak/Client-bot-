// casino.js — Lady Liya Casino & Black-Market Economy Expansion
//
// Adds: roulette, crash, tower, lottery, market/invest, loan/repay/interest,
// heist, tax treasury, auction.
//
// Follows the same pattern as minigames.js: this module holds pure game
// logic + Redis session state. case.js is still responsible for actually
// moving coins via economy.addCoins/updateProfile, EXCEPT where a function
// is explicitly marked as doing its own Redis writes for shared state
// (market prices, treasury, heist/auction sessions) that don't live on a
// single user's economy hash.

// ════════════════════════════════════════════════════════
// ROULETTE
// ════════════════════════════════════════════════════════
const ROULETTE_RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

function rouletteColor(n) {
    if (n === 0) return 'green';
    return ROULETTE_RED.has(n) ? 'red' : 'black';
}

// choice: 'red' | 'black' | 'green' | 'even' | 'odd' | 'low' (1-18) | 'high' (19-36) | a number 0-36
function resolveRoulette(bet, rawChoice) {
    const number = Math.floor(Math.random() * 37); // 0-36
    const color = rouletteColor(number);
    const choice = String(rawChoice).toLowerCase();

    let win = false;
    let multiplier = 0;

    if (/^\d+$/.test(choice)) {
        const n = parseInt(choice);
        if (n === number) { win = true; multiplier = 35; }
    } else if (choice === 'red' || choice === 'black') {
        if (choice === color) { win = true; multiplier = 2; }
    } else if (choice === 'green') {
        if (color === 'green') { win = true; multiplier = 14; }
    } else if (choice === 'even') {
        if (number !== 0 && number % 2 === 0) { win = true; multiplier = 2; }
    } else if (choice === 'odd') {
        if (number % 2 === 1) { win = true; multiplier = 2; }
    } else if (choice === 'low') {
        if (number >= 1 && number <= 18) { win = true; multiplier = 2; }
    } else if (choice === 'high') {
        if (number >= 19 && number <= 36) { win = true; multiplier = 2; }
    }

    const payout = win ? Math.floor(bet * multiplier) : 0;
    return { number, color, win, payout };
}

// ════════════════════════════════════════════════════════
// CRASH
// ════════════════════════════════════════════════════════
const CRASH_HOUSE_EDGE = 0.97;

// Standard crash-point distribution: heavily weighted toward low multipliers
// with a long tail. Floored to 2 decimals, minimum 1.00x.
function generateCrashPoint() {
    const r = Math.random();
    const raw = CRASH_HOUSE_EDGE / (1 - r);
    return Math.max(1, Math.floor(raw * 100) / 100);
}

// User picks a target cashout multiplier upfront; if the crash point is
// >= their target, they win bet * target.
function resolveCrash(bet, targetMultiplier) {
    const crashPoint = generateCrashPoint();
    const win = crashPoint >= targetMultiplier;
    const payout = win ? Math.floor(bet * targetMultiplier) : 0;
    return { crashPoint, win, payout };
}

// ════════════════════════════════════════════════════════
// TOWER
// 8 rows, 3 tiles per row, 1 bomb per row. Climbing raises the
// multiplier; picking the bomb tile ends the run.
// ════════════════════════════════════════════════════════
const TOWER_ROWS = 8;
const TOWER_LANES = 3;
const TOWER_HOUSE_EDGE = 0.97;

function towerSessionKey(groupId, jid) {
    return `tower:${groupId}:${jid}`;
}

function multiplierForRow(row) {
    // fair odds of surviving `row` picks of 1-in-3 bomb chance each time
    return Math.pow(TOWER_LANES / (TOWER_LANES - 1), row) * TOWER_HOUSE_EDGE;
}

async function startTower(redisClient, groupId, jid, bet) {
    const bombs = [];
    for (let i = 0; i < TOWER_ROWS; i++) bombs.push(Math.floor(Math.random() * TOWER_LANES));

    const session = { bet, row: 0, bombs, startedAt: Date.now() };
    await redisClient.set(towerSessionKey(groupId, jid), JSON.stringify(session), { EX: 5 * 60 });
    return session;
}

async function getTowerSession(redisClient, groupId, jid) {
    const raw = await redisClient.get(towerSessionKey(groupId, jid));
    return raw ? JSON.parse(raw) : null;
}

async function endTower(redisClient, groupId, jid) {
    await redisClient.del(towerSessionKey(groupId, jid));
}

// Returns { result: 'dead'|'safe'|'topped_out', session, payout? }
async function climbTower(redisClient, groupId, jid, lane) {
    const session = await getTowerSession(redisClient, groupId, jid);
    if (!session) return null;

    if (session.bombs[session.row] === lane) {
        await endTower(redisClient, groupId, jid);
        return { result: 'dead', session };
    }

    session.row++;
    if (session.row >= TOWER_ROWS) {
        const payout = Math.floor(session.bet * multiplierForRow(session.row));
        await endTower(redisClient, groupId, jid);
        return { result: 'topped_out', session, payout };
    }

    await redisClient.set(towerSessionKey(groupId, jid), JSON.stringify(session), { EX: 5 * 60 });
    return { result: 'safe', session };
}

async function cashoutTower(redisClient, groupId, jid) {
    const session = await getTowerSession(redisClient, groupId, jid);
    if (!session) return null;
    if (session.row === 0) return { error: 'no_climbs', session };

    const payout = Math.floor(session.bet * multiplierForRow(session.row));
    await endTower(redisClient, groupId, jid);
    return { payout, session };
}

function renderTower(session) {
    const rows = [];
    for (let r = TOWER_ROWS - 1; r >= 0; r--) {
        if (r < session.row) rows.push('🟩 🟩 🟩  ✅ cleared');
        else if (r === session.row) rows.push('🟨 🟨 🟨  ⬅️ pick a lane (1-3)');
        else rows.push('⬜ ⬜ ⬜');
    }
    return rows.join('\n');
}

// ════════════════════════════════════════════════════════
// LOTTERY — shared jackpot pot, stored at redis key "lottery:pot"
// ════════════════════════════════════════════════════════
const LOTTERY_TICKET_PRICE = 200;
const LOTTERY_WIN_CHANCE = 0.02; // 2% per ticket
const LOTTERY_SEED = 1000;
const LOTTERY_CONTRIBUTION_RATE = 0.8; // 80% of each ticket feeds the pot

async function getLotteryPot(redisClient) {
    const raw = await redisClient.get('lottery:pot');
    return raw ? parseInt(raw) : LOTTERY_SEED;
}

// Returns { won, amount, newPot }
async function buyLotteryTicket(redisClient) {
    const pot = await getLotteryPot(redisClient);
    const won = Math.random() < LOTTERY_WIN_CHANCE;

    if (won) {
        await redisClient.set('lottery:pot', String(LOTTERY_SEED));
        return { won: true, amount: pot, newPot: LOTTERY_SEED };
    }

    const newPot = pot + Math.floor(LOTTERY_TICKET_PRICE * LOTTERY_CONTRIBUTION_RATE);
    await redisClient.set('lottery:pot', String(newPot));
    return { won: false, amount: 0, newPot };
}

// ════════════════════════════════════════════════════════
// MARKET / INVEST — a handful of fictional stocks with prices that
// random-walk over time, shared across all users.
// ════════════════════════════════════════════════════════
const STOCKS = [
    { symbol: 'LDY', name: 'Liya Corp', basePrice: 100 },
    { symbol: 'CAT', name: 'CatTech Industries', basePrice: 50 },
    { symbol: 'GLD', name: 'Golden Reserve Fund', basePrice: 200 },
    { symbol: 'MOO', name: 'MoonShot Ventures', basePrice: 10 }
];

const MARKET_UPDATE_INTERVAL_MS = 5 * 60 * 1000; // prices move at most once per 5 min

// Ensures market prices exist and are fresh, then returns { SYMBOL: price }
async function getMarketPrices(redisClient) {
    const lastUpdateRaw = await redisClient.get('market:lastUpdate');
    const lastUpdate = lastUpdateRaw ? parseInt(lastUpdateRaw) : 0;
    const pricesRaw = await redisClient.hGetAll('market:prices');

    let prices = {};
    if (!pricesRaw || Object.keys(pricesRaw).length === 0) {
        for (const s of STOCKS) prices[s.symbol] = s.basePrice;
    } else {
        for (const s of STOCKS) prices[s.symbol] = parseFloat(pricesRaw[s.symbol] || s.basePrice);
    }

    if (Date.now() - lastUpdate >= MARKET_UPDATE_INTERVAL_MS) {
        const prevPrices = { ...prices };
        for (const s of STOCKS) {
            const changePct = (Math.random() * 0.24) - 0.12; // -12% to +12%
            prices[s.symbol] = Math.max(1, Math.round(prices[s.symbol] * (1 + changePct) * 100) / 100);
        }
        const payload = {};
        for (const s of STOCKS) payload[s.symbol] = String(prices[s.symbol]);
        await redisClient.hSet('market:prices', payload);
        await redisClient.hSet('market:prevPrices', Object.fromEntries(STOCKS.map(s => [s.symbol, String(prevPrices[s.symbol])])));
        await redisClient.set('market:lastUpdate', String(Date.now()));
    }

    return prices;
}

async function getMarketPrevPrices(redisClient) {
    const raw = await redisClient.hGetAll('market:prevPrices');
    const prev = {};
    for (const s of STOCKS) prev[s.symbol] = raw && raw[s.symbol] ? parseFloat(raw[s.symbol]) : s.basePrice;
    return prev;
}

function findStock(symbol) {
    return STOCKS.find(s => s.symbol === symbol.toUpperCase()) || null;
}

function parseHoldings(stocksJson) {
    try { return JSON.parse(stocksJson || '{}'); } catch { return {}; }
}

function stringifyHoldings(holdings) {
    return JSON.stringify(holdings);
}

// ════════════════════════════════════════════════════════
// LOANS / INTEREST
// ════════════════════════════════════════════════════════
const LOAN_INTEREST_RATE = 0.1; // 10% flat, added at time of borrowing
const LOAN_TERM_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const LOAN_PER_LEVEL_CAP = 1000;
const LOAN_LATE_PENALTY_RATE = 0.05; // extra 5% per check if overdue

function maxLoanForLevel(level) {
    return level * LOAN_PER_LEVEL_CAP;
}

const BANK_INTEREST_RATE = 0.02; // 2% of bank balance
const INTEREST_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h
const INTEREST_MIN_PAYOUT = 10;

// ════════════════════════════════════════════════════════
// HEIST — group event, stored at redis key heist:<groupId>
// ════════════════════════════════════════════════════════
const HEIST_JOIN_WINDOW_MS = 45 * 1000;
const HEIST_BASE_SUCCESS = 0.35;
const HEIST_SUCCESS_PER_PLAYER = 0.06;
const HEIST_MAX_SUCCESS = 0.85;
const HEIST_PAYOUT_MULTIPLIER = 2.1;

function heistKey(groupId) {
    return `heist:${groupId}`;
}

async function getHeist(redisClient, groupId) {
    const raw = await redisClient.get(heistKey(groupId));
    return raw ? JSON.parse(raw) : null;
}

async function startHeist(redisClient, groupId, starterJid, bet) {
    const session = {
        starterJid,
        bet,
        participants: [starterJid],
        startedAt: Date.now(),
        endsAt: Date.now() + HEIST_JOIN_WINDOW_MS
    };
    await redisClient.set(heistKey(groupId), JSON.stringify(session), { EX: 5 * 60 });
    return session;
}

// Returns null if no heist / already joined / can't afford, else updated session
async function joinHeist(redisClient, groupId, jid) {
    const session = await getHeist(redisClient, groupId);
    if (!session) return null;
    if (session.participants.includes(jid)) return { error: 'already_joined', session };
    if (Date.now() >= session.endsAt) return { error: 'too_late', session };

    session.participants.push(jid);
    await redisClient.set(heistKey(groupId), JSON.stringify(session), { EX: 5 * 60 });
    return { session };
}

async function endHeist(redisClient, groupId) {
    await redisClient.del(heistKey(groupId));
}

// Pure resolution logic — caller (case.js) handles moving coins per participant
function resolveHeist(session) {
    const n = session.participants.length;
    const chance = Math.min(HEIST_MAX_SUCCESS, HEIST_BASE_SUCCESS + n * HEIST_SUCCESS_PER_PLAYER);
    const success = Math.random() < chance;

    if (!success) {
        return { success, chance, totalLost: session.bet * n, perPlayerPayout: 0 };
    }

    const totalPot = Math.floor(session.bet * n * HEIST_PAYOUT_MULTIPLIER);
    const perPlayerPayout = Math.floor(totalPot / n);
    return { success, chance, totalPot, perPlayerPayout };
}

// ════════════════════════════════════════════════════════
// TAX TREASURY — redis key "treasury:coins"
// ════════════════════════════════════════════════════════
async function getTreasury(redisClient) {
    const raw = await redisClient.get('treasury:coins');
    return raw ? parseInt(raw) : 0;
}

async function addToTreasury(redisClient, amount) {
    const current = await getTreasury(redisClient);
    const updated = Math.max(0, current + amount);
    await redisClient.set('treasury:coins', String(updated));
    return updated;
}

// ════════════════════════════════════════════════════════
// AUCTION — Revive Token auctions, stored at redis key auction:<groupId>
// ════════════════════════════════════════════════════════
const AUCTION_DURATION_MS = 3 * 60 * 1000; // 3 minutes
const AUCTION_HOUSE_CUT = 0.05; // 5% to the house on a successful sale

function auctionKey(groupId) {
    return `auction:${groupId}`;
}

async function getAuction(redisClient, groupId) {
    const raw = await redisClient.get(auctionKey(groupId));
    return raw ? JSON.parse(raw) : null;
}

async function startAuction(redisClient, groupId, sellerJid, tokenCount, startingBid) {
    const session = {
        sellerJid,
        tokenCount,
        startingBid,
        highBid: startingBid,
        highBidder: null,
        startedAt: Date.now(),
        endsAt: Date.now() + AUCTION_DURATION_MS
    };
    await redisClient.set(auctionKey(groupId), JSON.stringify(session), { EX: 10 * 60 });
    return session;
}

// Returns { error } or { session }
async function placeBid(redisClient, groupId, jid, amount) {
    const session = await getAuction(redisClient, groupId);
    if (!session) return { error: 'no_auction' };
    if (Date.now() >= session.endsAt) return { error: 'ended', session };
    if (jid === session.sellerJid) return { error: 'own_auction', session };
    if (amount <= session.highBid) return { error: 'too_low', session };

    session.highBid = amount;
    session.highBidder = jid;
    await redisClient.set(auctionKey(groupId), JSON.stringify(session), { EX: 10 * 60 });
    return { session };
}

async function endAuction(redisClient, groupId) {
    await redisClient.del(auctionKey(groupId));
}

module.exports = {
    // roulette
    resolveRoulette,
    rouletteColor,
    // crash
    resolveCrash,
    generateCrashPoint,
    // tower
    TOWER_ROWS,
    TOWER_LANES,
    startTower,
    getTowerSession,
    endTower,
    climbTower,
    cashoutTower,
    renderTower,
    multiplierForRow,
    // lottery
    LOTTERY_TICKET_PRICE,
    getLotteryPot,
    buyLotteryTicket,
    // market / invest
    STOCKS,
    getMarketPrices,
    getMarketPrevPrices,
    findStock,
    parseHoldings,
    stringifyHoldings,
    // loans / interest
    LOAN_INTEREST_RATE,
    LOAN_TERM_MS,
    LOAN_LATE_PENALTY_RATE,
    maxLoanForLevel,
    BANK_INTEREST_RATE,
    INTEREST_COOLDOWN_MS,
    INTEREST_MIN_PAYOUT,
    // heist
    HEIST_JOIN_WINDOW_MS,
    getHeist,
    startHeist,
    joinHeist,
    endHeist,
    resolveHeist,
    // treasury / tax
    getTreasury,
    addToTreasury,
    // auction
    AUCTION_DURATION_MS,
    AUCTION_HOUSE_CUT,
    getAuction,
    startAuction,
    placeBid,
    endAuction
};
