// minigames.js — Lady Liya Mini-Games (Mines, Snake, ...)
//
// MINES: classic grid game. User starts a round with a bet + bomb count,
// then digs tiles one at a time. Each safe tile raises a cashout multiplier.
// Hitting a bomb loses the bet instantly. Cashing out locks in winnings
// at the current multiplier. Session stored under mines:<groupId>:<jid>
// with a short TTL so abandoned games don't linger forever.

const MINES_SESSION_TTL = 5 * 60; // seconds — abandoned games auto-expire
const GRID_SIZE = 25; // 5x5 grid

// ── House-edge-aware multiplier curve ──
// More bombs = higher risk = faster-climbing multiplier per safe dig.
// Uses fair hypergeometric odds (chance of avoiding all bombs so far),
// then applies a single flat house edge at the end — NOT compounded per
// dig, since compounding it would make low-bomb games go below 1x.
const HOUSE_EDGE = 0.97; // applied once, not per-dig

function multiplierForDig(safeDigs, bombCount, gridSize = GRID_SIZE) {
    let fairMult = 1;
    let remaining = gridSize;
    let bombsLeft = bombCount;
    for (let i = 0; i < safeDigs; i++) {
        const safeLeft = remaining - bombsLeft;
        fairMult *= (remaining / safeLeft);
        remaining--;
    }
    return fairMult * HOUSE_EDGE;
}

function sessionKey(groupId, jid) {
    return `mines:${groupId}:${jid}`;
}

// ── Start a new Mines session. Bombs are placed randomly on a 25-tile grid ──
async function startMines(redisClient, groupId, jid, bet, bombCount) {
    const bombs = new Set();
    while (bombs.size < bombCount) {
        bombs.add(Math.floor(Math.random() * GRID_SIZE));
    }

    const session = {
        bet,
        bombCount,
        bombs: [...bombs],
        dug: [],          // tile indices already revealed safe
        multiplier: 1,
        startedAt: Date.now()
    };

    await redisClient.set(sessionKey(groupId, jid), JSON.stringify(session), { EX: MINES_SESSION_TTL });
    return session;
}

async function getMinesSession(redisClient, groupId, jid) {
    const raw = await redisClient.get(sessionKey(groupId, jid));
    return raw ? JSON.parse(raw) : null;
}

async function saveMinesSession(redisClient, groupId, jid, session) {
    await redisClient.set(sessionKey(groupId, jid), JSON.stringify(session), { EX: MINES_SESSION_TTL });
}

async function endMines(redisClient, groupId, jid) {
    await redisClient.del(sessionKey(groupId, jid));
}

// ── Dig a tile. Returns { hit: 'bomb'|'safe', session, payout? } ──
async function digMines(redisClient, groupId, jid, tile) {
    const session = await getMinesSession(redisClient, groupId, jid);
    if (!session) return null;

    if (session.dug.includes(tile)) {
        return { hit: 'already_dug', session };
    }

    if (session.bombs.includes(tile)) {
        await endMines(redisClient, groupId, jid);
        return { hit: 'bomb', session };
    }

    session.dug.push(tile);
    session.multiplier = multiplierForDig(session.dug.length, session.bombCount);

    const safeTilesTotal = GRID_SIZE - session.bombCount;
    const clearedBoard = session.dug.length >= safeTilesTotal;

    if (clearedBoard) {
        const payout = Math.floor(session.bet * session.multiplier);
        await endMines(redisClient, groupId, jid);
        return { hit: 'cleared', session, payout };
    }

    await saveMinesSession(redisClient, groupId, jid, session);
    return { hit: 'safe', session };
}

// ── Cash out at current multiplier ──
async function cashoutMines(redisClient, groupId, jid) {
    const session = await getMinesSession(redisClient, groupId, jid);
    if (!session) return null;
    if (session.dug.length === 0) return { error: 'no_digs', session };

    const payout = Math.floor(session.bet * session.multiplier);
    await endMines(redisClient, groupId, jid);
    return { payout, session };
}

// ── Render the grid as emoji (revealed safe tiles shown, rest hidden) ──
function renderGrid(session, revealBombs = false) {
    const rows = [];
    for (let r = 0; r < 5; r++) {
        let row = '';
        for (let c = 0; c < 5; c++) {
            const idx = r * 5 + c;
            if (session.dug.includes(idx)) {
                row += '💎';
            } else if (revealBombs && session.bombs.includes(idx)) {
                row += '💣';
            } else {
                row += '⬜';
            }
        }
        rows.push(row);
    }
    return rows.join('\n');
}

module.exports = {
    GRID_SIZE,
    MINES_SESSION_TTL,
    multiplierForDig,
    startMines,
    getMinesSession,
    saveMinesSession,
    endMines,
    digMines,
    cashoutMines,
    renderGrid
};

// ════════════════════════════════════════════════════════════
// SNAKE
// Move-by-message game: each .up/.down/.left/.right advances the
// snake one step on a small grid. Eating food grows the snake and
// scores points; hitting a wall or your own body ends the game.
// Session stored under snake:<groupId>:<jid> with a TTL so an
// abandoned game doesn't linger forever.
// ════════════════════════════════════════════════════════════

const SNAKE_WIDTH = 8;
const SNAKE_HEIGHT = 8;
const SNAKE_SESSION_TTL = 5 * 60; // seconds
const SNAKE_COINS_PER_FOOD = 15;
const SNAKE_XP_PER_FOOD = 5;

function snakeSessionKey(groupId, jid) {
    return `snake:${groupId}:${jid}`;
}

function randomEmptyCell(snakeBody, width = SNAKE_WIDTH, height = SNAKE_HEIGHT) {
    const occupied = new Set(snakeBody.map(([x, y]) => `${x},${y}`));
    let x, y;
    do {
        x = Math.floor(Math.random() * width);
        y = Math.floor(Math.random() * height);
    } while (occupied.has(`${x},${y}`));
    return [x, y];
}

// ── Start a new Snake session. Snake begins as a single segment in the center ──
async function startSnake(redisClient, groupId, jid) {
    const startPos = [Math.floor(SNAKE_WIDTH / 2), Math.floor(SNAKE_HEIGHT / 2)];
    const body = [startPos];
    const food = randomEmptyCell(body);

    const session = {
        body,            // array of [x,y], body[0] is the head
        direction: null, // 'up'|'down'|'left'|'right' — null until first move
        food,
        score: 0,
        startedAt: Date.now()
    };

    await redisClient.set(snakeSessionKey(groupId, jid), JSON.stringify(session), { EX: SNAKE_SESSION_TTL });
    return session;
}

async function getSnakeSession(redisClient, groupId, jid) {
    const raw = await redisClient.get(snakeSessionKey(groupId, jid));
    return raw ? JSON.parse(raw) : null;
}

async function saveSnakeSession(redisClient, groupId, jid, session) {
    await redisClient.set(snakeSessionKey(groupId, jid), JSON.stringify(session), { EX: SNAKE_SESSION_TTL });
}

async function endSnake(redisClient, groupId, jid) {
    await redisClient.del(snakeSessionKey(groupId, jid));
}

const DIRECTION_VECTORS = {
    up:    [0, -1],
    down:  [0, 1],
    left:  [-1, 0],
    right: [1, 0]
};

const OPPOSITE_DIRECTION = { up: 'down', down: 'up', left: 'right', right: 'left' };

// ── Advance the snake one step in the given direction.
//    Returns { result: 'moved'|'ate'|'dead'|'invalid_reverse', session } ──
async function moveSnake(redisClient, groupId, jid, direction) {
    const session = await getSnakeSession(redisClient, groupId, jid);
    if (!session) return null;

    // Can't reverse directly into yourself (only matters once the snake has moved)
    if (session.direction && direction === OPPOSITE_DIRECTION[session.direction] && session.body.length > 1) {
        return { result: 'invalid_reverse', session };
    }

    const [dx, dy] = DIRECTION_VECTORS[direction];
    const [headX, headY] = session.body[0];
    const newHead = [headX + dx, headY + dy];

    // Wall collision
    if (newHead[0] < 0 || newHead[0] >= SNAKE_WIDTH || newHead[1] < 0 || newHead[1] >= SNAKE_HEIGHT) {
        await endSnake(redisClient, groupId, jid);
        return { result: 'dead', session, cause: 'wall' };
    }

    // Self collision (check against body, excluding the tail since it will move away
    // unless we're about to eat, in which case the tail stays — handled below)
    const ateFood = newHead[0] === session.food[0] && newHead[1] === session.food[1];
    const bodyToCheck = ateFood ? session.body : session.body.slice(0, -1);
    const hitSelf = bodyToCheck.some(([x, y]) => x === newHead[0] && y === newHead[1]);

    if (hitSelf) {
        await endSnake(redisClient, groupId, jid);
        return { result: 'dead', session, cause: 'self' };
    }

    session.direction = direction;
    session.body.unshift(newHead);

    if (ateFood) {
        session.score += 1;
        session.food = randomEmptyCell(session.body);
        await saveSnakeSession(redisClient, groupId, jid, session);
        return { result: 'ate', session };
    }

    session.body.pop(); // move forward without growing
    await saveSnakeSession(redisClient, groupId, jid, session);
    return { result: 'moved', session };
}

// ── Render the snake grid as emoji ──
function renderSnakeGrid(session) {
    const grid = Array.from({ length: SNAKE_HEIGHT }, () => Array(SNAKE_WIDTH).fill('⬛'));

    grid[session.food[1]][session.food[0]] = '🍎';

    session.body.forEach(([x, y], i) => {
        grid[y][x] = i === 0 ? '🟢' : '🟩';
    });

    return grid.map(row => row.join('')).join('\n');
}

// ── Leaderboard: Redis sorted set storing best score per jid ──
async function recordSnakeScore(redisClient, jid, score) {
    const current = await redisClient.zScore('snake:leaderboard', jid);
    if (!current || score > Number(current)) {
        await redisClient.zAdd('snake:leaderboard', [{ score, value: jid }]);
        return true; // new personal best
    }
    return false;
}

async function getSnakeLeaderboard(redisClient, limit = 10) {
    const results = await redisClient.zRangeWithScores('snake:leaderboard', 0, limit - 1, { REV: true });
    return results.map(r => ({ jid: r.value, score: r.score }));
}

module.exports.SNAKE_WIDTH = SNAKE_WIDTH;
module.exports.SNAKE_HEIGHT = SNAKE_HEIGHT;
module.exports.SNAKE_COINS_PER_FOOD = SNAKE_COINS_PER_FOOD;
module.exports.SNAKE_XP_PER_FOOD = SNAKE_XP_PER_FOOD;
module.exports.startSnake = startSnake;
module.exports.getSnakeSession = getSnakeSession;
module.exports.saveSnakeSession = saveSnakeSession;
module.exports.endSnake = endSnake;
module.exports.moveSnake = moveSnake;
module.exports.renderSnakeGrid = renderSnakeGrid;
module.exports.recordSnakeScore = recordSnakeScore;
module.exports.getSnakeLeaderboard = getSnakeLeaderboard;
