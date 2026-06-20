// wordgames.js — Lady Liya Mini-Games: TicTacToe, Connect4, Hangman, Wordle, Typing Race
//
// TicTacToe & Connect4 are 2-player, bet-based (winner takes both stakes).
// Hangman/Wordle/Typing are solo, free-to-play word games.
// All sessions stored in Redis with a TTL so abandoned games expire.

const SESSION_TTL = 5 * 60; // seconds

// ════════════════════════════════════════════
// PENDING CHALLENGES (shared pattern for TTT & Connect4)
// A challenge must be accepted before the actual game session starts.
// ════════════════════════════════════════════

const CHALLENGE_TTL = 60; // seconds to accept

function challengeKey(game, groupId) {
    return `challenge:${game}:${groupId}`;
}

async function createChallenge(redisClient, game, groupId, challengerJid, opponentJid, bet) {
    const challenge = { challengerJid, opponentJid, bet, createdAt: Date.now() };
    await redisClient.set(challengeKey(game, groupId), JSON.stringify(challenge), { EX: CHALLENGE_TTL });
    return challenge;
}

async function getChallenge(redisClient, game, groupId) {
    const raw = await redisClient.get(challengeKey(game, groupId));
    return raw ? JSON.parse(raw) : null;
}

async function deleteChallenge(redisClient, game, groupId) {
    await redisClient.del(challengeKey(game, groupId));
}

// ════════════════════════════════════════════
// TIC-TAC-TOE
// ════════════════════════════════════════════

function tttKey(groupId) {
    return `ttt:${groupId}`;
}

async function startTTT(redisClient, groupId, playerX, playerO, bet) {
    const session = {
        board: Array(9).fill(null), // index 0-8, null|'X'|'O'
        playerX,
        playerO,
        turn: 'X',
        bet,
        startedAt: Date.now()
    };
    await redisClient.set(tttKey(groupId), JSON.stringify(session), { EX: SESSION_TTL });
    return session;
}

async function getTTT(redisClient, groupId) {
    const raw = await redisClient.get(tttKey(groupId));
    return raw ? JSON.parse(raw) : null;
}

async function endTTT(redisClient, groupId) {
    await redisClient.del(tttKey(groupId));
}

const TTT_WIN_LINES = [
    [0,1,2],[3,4,5],[6,7,8], // rows
    [0,3,6],[1,4,7],[2,5,8], // cols
    [0,4,8],[2,4,6]          // diagonals
];

function checkTTTWinner(board) {
    for (const [a,b,c] of TTT_WIN_LINES) {
        if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
    }
    if (board.every(cell => cell !== null)) return 'draw';
    return null;
}

// ── Place a mark. Returns { result: 'placed'|'win'|'draw'|'invalid'|'not_your_turn', session, winner? } ──
async function playTTT(redisClient, groupId, jid, position) {
    const session = await getTTT(redisClient, groupId);
    if (!session) return null;

    const isX = jid === session.playerX;
    const isO = jid === session.playerO;
    if (!isX && !isO) return { result: 'not_a_player', session };

    const mySymbol = isX ? 'X' : 'O';
    if (session.turn !== mySymbol) return { result: 'not_your_turn', session };

    if (position < 0 || position > 8 || session.board[position] !== null) {
        return { result: 'invalid', session };
    }

    session.board[position] = mySymbol;
    const winner = checkTTTWinner(session.board);

    if (winner === 'draw') {
        await endTTT(redisClient, groupId);
        return { result: 'draw', session };
    }
    if (winner) {
        await endTTT(redisClient, groupId);
        return { result: 'win', session, winnerSymbol: winner, winnerJid: winner === 'X' ? session.playerX : session.playerO };
    }

    session.turn = session.turn === 'X' ? 'O' : 'X';
    await redisClient.set(tttKey(groupId), JSON.stringify(session), { EX: SESSION_TTL });
    return { result: 'placed', session };
}

function renderTTT(session) {
    const symbols = session.board.map((cell, i) => cell || `${i + 1}`);
    return `${symbols[0]} | ${symbols[1]} | ${symbols[2]}\n${symbols[3]} | ${symbols[4]} | ${symbols[5]}\n${symbols[6]} | ${symbols[7]} | ${symbols[8]}`;
}

// ════════════════════════════════════════════
// CONNECT 4
// ════════════════════════════════════════════

const C4_COLS = 7;
const C4_ROWS = 6;

function c4Key(groupId) {
    return `connect4:${groupId}`;
}

async function startC4(redisClient, groupId, playerR, playerY, bet) {
    const session = {
        // grid[row][col], row 0 = top
        grid: Array.from({ length: C4_ROWS }, () => Array(C4_COLS).fill(null)),
        playerR, // red
        playerY, // yellow
        turn: 'R',
        bet,
        startedAt: Date.now()
    };
    await redisClient.set(c4Key(groupId), JSON.stringify(session), { EX: SESSION_TTL });
    return session;
}

async function getC4(redisClient, groupId) {
    const raw = await redisClient.get(c4Key(groupId));
    return raw ? JSON.parse(raw) : null;
}

async function endC4(redisClient, groupId) {
    await redisClient.del(c4Key(groupId));
}

function checkC4Winner(grid) {
    const dirs = [[0,1],[1,0],[1,1],[1,-1]];
    for (let r = 0; r < C4_ROWS; r++) {
        for (let c = 0; c < C4_COLS; c++) {
            const cell = grid[r][c];
            if (!cell) continue;
            for (const [dr, dc] of dirs) {
                let count = 1;
                for (let i = 1; i < 4; i++) {
                    const nr = r + dr * i, nc = c + dc * i;
                    if (nr < 0 || nr >= C4_ROWS || nc < 0 || nc >= C4_COLS || grid[nr][nc] !== cell) break;
                    count++;
                }
                if (count >= 4) return cell;
            }
        }
    }
    const full = grid.every(row => row.every(cell => cell !== null));
    if (full) return 'draw';
    return null;
}

// ── Drop a piece in a column. Returns { result, session, winner? } ──
async function playC4(redisClient, groupId, jid, col) {
    const session = await getC4(redisClient, groupId);
    if (!session) return null;

    const isR = jid === session.playerR;
    const isY = jid === session.playerY;
    if (!isR && !isY) return { result: 'not_a_player', session };

    const mySymbol = isR ? 'R' : 'Y';
    if (session.turn !== mySymbol) return { result: 'not_your_turn', session };

    if (col < 0 || col >= C4_COLS) return { result: 'invalid', session };

    // Find the lowest empty row in that column
    let targetRow = -1;
    for (let r = C4_ROWS - 1; r >= 0; r--) {
        if (session.grid[r][col] === null) { targetRow = r; break; }
    }
    if (targetRow === -1) return { result: 'column_full', session };

    session.grid[targetRow][col] = mySymbol;
    const winner = checkC4Winner(session.grid);

    if (winner === 'draw') {
        await endC4(redisClient, groupId);
        return { result: 'draw', session };
    }
    if (winner) {
        await endC4(redisClient, groupId);
        return { result: 'win', session, winnerSymbol: winner, winnerJid: winner === 'R' ? session.playerR : session.playerY };
    }

    session.turn = session.turn === 'R' ? 'Y' : 'R';
    await redisClient.set(c4Key(groupId), JSON.stringify(session), { EX: SESSION_TTL });
    return { result: 'placed', session };
}

function renderC4(session) {
    const symbolFor = (cell) => cell === 'R' ? '🔴' : cell === 'Y' ? '🟡' : '⚪';
    const rows = session.grid.map(row => row.map(symbolFor).join(''));
    const colNumbers = Array.from({ length: C4_COLS }, (_, i) => i + 1).join(' ');
    return rows.join('\n') + '\n' + Array.from({ length: C4_COLS }, (_, i) => i + 1).map(n => n).join('️⃣');
}

module.exports = {
    SESSION_TTL,
    CHALLENGE_TTL,
    createChallenge, getChallenge, deleteChallenge,
    // TicTacToe
    startTTT, getTTT, endTTT, playTTT, renderTTT, checkTTTWinner,
    // Connect4
    C4_COLS, C4_ROWS,
    startC4, getC4, endC4, playC4, renderC4, checkC4Winner
};

// NOTE: Hangman is intentionally NOT implemented here — case.js already has
// a complete, working .hangman / .guessletter implementation with betting
// support. Building a second one here would create a naming collision and
// duplicate logic. See case.js's HANGMAN section if you want to extend it.

// ════════════════════════════════════════════
// WORDLE
// 5-letter word, 6 guesses, classic feedback (🟩🟨⬛)
// ════════════════════════════════════════════

const WORDLE_WORDS = [
    'about', 'above', 'after', 'again', 'alarm', 'apple', 'baker', 'beach',
    'birth', 'black', 'board', 'brain', 'bread', 'break', 'brown', 'build',
    'chair', 'chase', 'check', 'chest', 'child', 'claim', 'clean', 'clear',
    'click', 'climb', 'clock', 'cloud', 'coast', 'could', 'crash', 'cream',
    'dance', 'dirty', 'dream', 'drink', 'drive', 'earth', 'eight', 'enjoy',
    'fault', 'fence', 'fight', 'final', 'fresh', 'front', 'fruit', 'glass',
    'grand', 'grass', 'great', 'green', 'guess', 'happy', 'heart', 'heavy',
    'horse', 'house', 'human', 'image', 'judge', 'knife', 'laugh', 'learn',
    'light', 'magic', 'major', 'media', 'mixed', 'money', 'mouth', 'music',
    'night', 'noise', 'north', 'novel', 'ocean', 'offer', 'often', 'order',
    'paint', 'panel', 'paper', 'party', 'peace', 'phase', 'phone', 'piece',
    'pilot', 'pitch', 'place', 'plant', 'plate', 'point', 'pound', 'power',
    'press', 'price', 'pride', 'prime', 'print', 'prize', 'proof', 'queen',
    'quick', 'quiet', 'radio', 'reply', 'right', 'river', 'round', 'route',
    'scale', 'scene', 'sense', 'shape', 'share', 'sharp', 'sheet', 'shirt',
    'shock', 'short', 'sight', 'simple', 'since', 'sixth', 'sleep', 'small',
    'smile', 'solid', 'sound', 'south', 'space', 'speak', 'speed', 'spend',
    'sport', 'staff', 'stage', 'stand', 'start', 'state', 'steam', 'steel',
    'stick', 'still', 'stone', 'store', 'storm', 'story', 'study', 'stuff',
    'style', 'sugar', 'table', 'taste', 'teach', 'thank', 'theme', 'thick',
    'thing', 'think', 'three', 'throw', 'tiger', 'tight', 'title', 'today',
    'topic', 'total', 'touch', 'tough', 'tower', 'track', 'trade', 'train',
    'treat', 'trend', 'trial', 'trick', 'truck', 'trust', 'truth', 'twice',
    'uncle', 'under', 'union', 'until', 'urban', 'usual', 'value', 'video',
    'visit', 'voice', 'waste', 'watch', 'water', 'wheel', 'where', 'which',
    'while', 'white', 'whole', 'woman', 'world', 'worry', 'worth', 'would',
    'write', 'wrong', 'young'
].filter(w => w.length === 5); // safety filter in case of typos above

const WORDLE_MAX_GUESSES = 6;
const WORDLE_REWARD_COINS = [0, 300, 250, 200, 150, 100, 75]; // indexed by guesses used (1-6)
const WORDLE_REWARD_XP = 20;

function wordleKey(groupId, jid) {
    return `wordle:${groupId}:${jid}`;
}

async function startWordle(redisClient, groupId, jid) {
    const word = WORDLE_WORDS[Math.floor(Math.random() * WORDLE_WORDS.length)];
    const session = {
        word,
        guesses: [], // array of { guess, feedback: ['hit'|'present'|'miss', ...] }
        startedAt: Date.now()
    };
    await redisClient.set(wordleKey(groupId, jid), JSON.stringify(session), { EX: SESSION_TTL });
    return session;
}

async function getWordle(redisClient, groupId, jid) {
    const raw = await redisClient.get(wordleKey(groupId, jid));
    return raw ? JSON.parse(raw) : null;
}

async function endWordle(redisClient, groupId, jid) {
    await redisClient.del(wordleKey(groupId, jid));
}

// ── Compute Wordle-style feedback for a guess against the target word ──
function computeWordleFeedback(guess, target) {
    const feedback = Array(5).fill('miss');
    const targetLetters = target.split('');
    const guessLetters = guess.split('');
    const used = Array(5).fill(false);

    // First pass: exact matches
    for (let i = 0; i < 5; i++) {
        if (guessLetters[i] === targetLetters[i]) {
            feedback[i] = 'hit';
            used[i] = true;
        }
    }

    // Second pass: present-but-wrong-position (respecting letter counts)
    for (let i = 0; i < 5; i++) {
        if (feedback[i] === 'hit') continue;
        const idx = targetLetters.findIndex((ch, j) => ch === guessLetters[i] && !used[j]);
        if (idx !== -1) {
            feedback[i] = 'present';
            used[idx] = true;
        }
    }

    return feedback;
}

// ── Submit a guess. Returns { result: 'win'|'lose'|'continue'|'invalid', session, feedback? } ──
async function guessWordle(redisClient, groupId, jid, guess) {
    const session = await getWordle(redisClient, groupId, jid);
    if (!session) return null;

    guess = guess.toLowerCase();
    if (guess.length !== 5 || !/^[a-z]+$/.test(guess)) {
        return { result: 'invalid', session };
    }

    const feedback = computeWordleFeedback(guess, session.word);
    session.guesses.push({ guess, feedback });

    if (guess === session.word) {
        await endWordle(redisClient, groupId, jid);
        return { result: 'win', session, feedback, guessNumber: session.guesses.length };
    }

    if (session.guesses.length >= WORDLE_MAX_GUESSES) {
        await endWordle(redisClient, groupId, jid);
        return { result: 'lose', session, feedback };
    }

    await redisClient.set(wordleKey(groupId, jid), JSON.stringify(session), { EX: SESSION_TTL });
    return { result: 'continue', session, feedback };
}

function renderWordleFeedback(feedback) {
    return feedback.map(f => f === 'hit' ? '🟩' : f === 'present' ? '🟨' : '⬛').join('');
}

function renderWordleBoard(session) {
    return session.guesses.map(g => `${renderWordleFeedback(g.feedback)}  ${g.guess.toUpperCase()}`).join('\n');
}

// ════════════════════════════════════════════
// TYPING RACE
// Solo speed-typing challenge. Reward scales with WPM.
// ════════════════════════════════════════════

const TYPING_SENTENCES = [
    'The quick brown fox jumps over the lazy dog',
    'Practice makes perfect every single day',
    'WhatsApp bots are fun to build and use',
    'Coding late at night fixing one more bug',
    'Speed and accuracy both matter when typing fast',
    'Lady Liya brings games and rewards to every chat',
    'Never give up on your dreams no matter what',
    'A journey of a thousand miles begins with one step',
];

const TYPING_TTL = 60; // seconds — race must be completed within a minute

function typingKey(groupId, jid) {
    return `typing:${groupId}:${jid}`;
}

async function startTyping(redisClient, groupId, jid) {
    const sentence = TYPING_SENTENCES[Math.floor(Math.random() * TYPING_SENTENCES.length)];
    const session = { sentence, startedAt: Date.now() };
    await redisClient.set(typingKey(groupId, jid), JSON.stringify(session), { EX: TYPING_TTL });
    return session;
}

async function getTyping(redisClient, groupId, jid) {
    const raw = await redisClient.get(typingKey(groupId, jid));
    return raw ? JSON.parse(raw) : null;
}

async function endTyping(redisClient, groupId, jid) {
    await redisClient.del(typingKey(groupId, jid));
}

// ── Submit a typed attempt. Returns { correct, wpm, accuracy, elapsedSec } ──
async function submitTyping(redisClient, groupId, jid, typedText) {
    const session = await getTyping(redisClient, groupId, jid);
    if (!session) return null;

    await endTyping(redisClient, groupId, jid);

    const elapsedMs = Date.now() - session.startedAt;
    // Floor elapsed time relative to sentence length — roughly 0.3s per word
    // is already faster than any real human can read+type, so anything
    // below that is treated as a bot/instant-submit exploit and clamped,
    // which keeps the resulting WPM realistic instead of capping after
    // the fact (capping alone still let instant submits hit max reward tier).
    const wordCount = session.sentence.split(' ').length;
    const minElapsedSec = wordCount * 0.3;
    const elapsedSec = Math.max(elapsedMs / 1000, minElapsedSec);
    const correct = typedText.trim() === session.sentence;

    let wpm = Math.round((wordCount / elapsedSec) * 60);
    wpm = Math.min(wpm, 150); // hard ceiling as a second safety net

    // Simple character-level accuracy even on imperfect attempts
    const target = session.sentence;
    let matches = 0;
    for (let i = 0; i < Math.min(target.length, typedText.length); i++) {
        if (target[i] === typedText[i]) matches++;
    }
    const accuracy = Math.round((matches / target.length) * 100);

    return { correct, wpm: correct ? wpm : 0, accuracy, elapsedSec, session };
}

module.exports.WORDLE_MAX_GUESSES = WORDLE_MAX_GUESSES;
module.exports.WORDLE_REWARD_COINS = WORDLE_REWARD_COINS;
module.exports.WORDLE_REWARD_XP = WORDLE_REWARD_XP;
module.exports.startWordle = startWordle;
module.exports.getWordle = getWordle;
module.exports.endWordle = endWordle;
module.exports.guessWordle = guessWordle;
module.exports.computeWordleFeedback = computeWordleFeedback;
module.exports.renderWordleFeedback = renderWordleFeedback;
module.exports.renderWordleBoard = renderWordleBoard;

module.exports.startTyping = startTyping;
module.exports.getTyping = getTyping;
module.exports.endTyping = endTyping;
module.exports.submitTyping = submitTyping;
