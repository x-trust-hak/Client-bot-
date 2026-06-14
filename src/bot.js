const {
  makeWASocket,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const { Boom } = require('@hapi/boom');
const pino = require('pino');
const { createClient } = require('redis');
const { useRedisAuthState } = require('./redisAuthState');

// ── Redis client (singleton) ──────────────────────────────
let redis;

async function getRedis() {
  if (redis) return redis;

  redis = createClient({
    url: process.env.REDIS_URL,
    socket: {
      reconnectStrategy: (attempts) => Math.min(attempts * 100, 3000)
    }
  });

  redis.on('error', (err) => console.error('Redis error:', err));
  redis.on('connect', () => console.log('✅ Redis connected'));
  redis.on('reconnecting', () => console.log('🔄 Redis reconnecting...'));

  await redis.connect();
  return redis;
}

// ── Active connections ────────────────────────────────────
const connections = new Map();

// ── Owner ────────────────────────────────────────────────
const OWNER_NUMBER = process.env.OWNER_NUMBER + '@s.whatsapp.net';

// ── Dev contact / branding (used in welcome message) ──────
const WELCOME_MESSAGE = `Successfully connected to *Lady Liya* 💓

Type *.menu* to explore available commands.

For any issues, contact the Dev:
📞 wa.me/2349155604141
✈️ t.me/KallmeTrust

📢 Telegram channel:
https://t.me/TrustBitOfficial`;

// ── Admin event emitter (so server.js can broadcast live events) ──
const { EventEmitter } = require('events');
const adminEvents = new EventEmitter();

// ════════════════════════════════════════════════════════
// SETTINGS — stored as ONE Redis key, not per-user
// ════════════════════════════════════════════════════════
const SETTINGS_KEY = 'settings:config';

const DEFAULT_SETTINGS = {
  maxSlots: 100,
  autoReconnect: true,
  autoBackup: false,
  pairTimeoutSeconds: 60,
  maintenanceMode: false
};

let settingsCache = null;

/**
 * Get current settings (cached after first load)
 */
async function getSettings() {
  if (settingsCache) return settingsCache;

  try {
    const redisClient = await getRedis();
    const raw = await redisClient.get(SETTINGS_KEY);

    if (!raw) {
      settingsCache = { ...DEFAULT_SETTINGS };
      await redisClient.set(SETTINGS_KEY, JSON.stringify(settingsCache));
    } else {
      settingsCache = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    }
  } catch (err) {
    console.error('getSettings error:', err);
    settingsCache = { ...DEFAULT_SETTINGS };
  }

  return settingsCache;
}

/**
 * Update settings (partial update, merges with existing)
 */
async function updateSettings(updates) {
  const redisClient = await getRedis();
  const current = await getSettings();
  const merged = { ...current, ...updates };

  await redisClient.set(SETTINGS_KEY, JSON.stringify(merged));
  settingsCache = merged;

  return merged;
}

/**
 * Log a global event to Redis for admin dashboard (pairings, disconnects, etc)
 */
async function logEvent(type, data = {}) {
  try {
    const redisClient = await getRedis();
    const event = {
      type,
      ...data,
      timestamp: Date.now()
    };

    // Push to a capped list of recent events (for live monitor + logs)
    await redisClient.lPush('events:log', JSON.stringify(event));
    await redisClient.lTrim('events:log', 0, 499); // keep last 500

    // Emit for real-time admin dashboard updates
    adminEvents.emit('event', event);

    // Track pairing counters for analytics
    if (type === 'paired') {
      const dateKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      await redisClient.incr(`stats:pairings:${dateKey}`);
      await redisClient.incr('stats:pairings:total');
    }
  } catch (err) {
    console.error('logEvent error:', err);
  }
}

/**
 * Restore all saved sessions from Redis on startup
 */
async function restoreAllSessions() {
  try {
    const settings = await getSettings();

    if (!settings.autoReconnect) {
      console.log('⏭️ Auto Reconnect is OFF — skipping session restore');
      return;
    }

    const redisClient = await getRedis();
    const keys = await redisClient.keys('session:*');

    if (keys.length === 0) {
      console.log('No saved sessions found in Redis');
      return;
    }

    console.log(`🔄 Restoring ${keys.length} session(s) from Redis...`);

    for (const key of keys) {
      const phoneNumber = key.replace('session:', '');
      const creds = await redisClient.hGet(key, 'creds');
      if (!creds) {
        console.log(`⚠️ Skipping ${phoneNumber} — no creds found`);
        continue;
      }

      console.log(`♻️ Reconnecting ${phoneNumber}...`);
      await startBot(phoneNumber, null).catch(err => {
        console.error(`Failed to restore ${phoneNumber}:`, err.message);
      });

      await new Promise(r => setTimeout(r, 2000));
    }

    console.log('✅ Session restore complete');
  } catch (err) {
    console.error('Error restoring sessions:', err);
  }
}

/**
 * Start a WhatsApp session for a user
 * @param {string} phoneNumber
 * @param {object|null} socket - Socket.IO socket (null for background restore)
 */
async function startBot(phoneNumber, socket) {

  const redisClient = await getRedis();
  const settings = await getSettings();

  // ── Maintenance mode: block NEW pairings (socket present = user-initiated) ──
  if (settings.maintenanceMode && socket && !connections.has(phoneNumber)) {
    const redisCheck = await redisClient.exists(`session:${phoneNumber}`);
    if (!redisCheck) {
      console.log(`🚧 Maintenance mode active — blocked new pairing for ${phoneNumber}`);
      socket.emit('error', 'Server is in maintenance mode. New pairings are temporarily disabled.');
      return;
    }
  }

  // ── Slot limit: block NEW pairings if at capacity ──
  if (socket && !connections.has(phoneNumber)) {
    const redisCheck = await redisClient.exists(`session:${phoneNumber}`);
    if (!redisCheck && connections.size >= settings.maxSlots) {
      console.log(`🔒 Slot limit reached (${settings.maxSlots}) — blocked ${phoneNumber}`);
      socket.emit('error', `Server is full (${settings.maxSlots}/${settings.maxSlots} slots). Try again later.`);
      return;
    }
  }

  const { state, saveCreds } =
    await useRedisAuthState(redisClient, phoneNumber);

  const { version } = await fetchLatestBaileysVersion();

  const conn = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000
  });

  console.log(`✅ Socket created for ${phoneNumber}`);

  // Decode JID helper
  const { jidDecode } = require('@whiskeysockets/baileys');
  conn.decodeJid = (jid) => {
    if (!jid) return jid;
    if (/:\d+@/gi.test(jid)) {
      const decode = jidDecode(jid) || {};
      return (decode.user && decode.server &&
        `${decode.user}@${decode.server}`) || jid;
    }
    return jid;
  };

  // Save active connection
  connections.set(phoneNumber, conn);
  console.log('Active sessions:', [...connections.keys()]);

  // Track whether this is a NEW pairing (not registered yet) for the welcome msg
  const isNewPairing = !conn.authState.creds.registered;

  // ── Generate pairing code (only for new sessions with a live socket) ──
  if (isNewPairing && phoneNumber && socket) {
    const pairTimeoutMs = (settings.pairTimeoutSeconds || 60) * 1000;
    const pairDelayMs = Math.min(3000, pairTimeoutMs); // small delay before requesting code

    const codeTimeout = setTimeout(async () => {
      try {
        let code = await conn.requestPairingCode(phoneNumber);
        code = code?.match(/.{1,4}/g)?.join('-') || code;
        socket.emit('pairing-code', code);
        console.log(`Pairing code for ${phoneNumber}:`, code);
      } catch (err) {
        console.error('Failed to generate pairing code:', err);
        socket.emit('error', 'Failed to generate pairing code');
      }
    }, pairDelayMs);

    // If the user doesn't complete pairing within the configured timeout, clean up
    setTimeout(() => {
      if (!conn.authState.creds.registered && connections.get(phoneNumber) === conn) {
        console.log(`⏱️ Pair timeout for ${phoneNumber} — closing unused socket`);
        connections.delete(phoneNumber);
        try { conn.end(); } catch {}
        if (socket) socket.emit('error', 'Pairing code expired. Please try again.');
      }
    }, pairTimeoutMs);
  }

  // ── Connection status ──────────────────────────────────
  conn.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const reason =
        new Boom(lastDisconnect?.error)?.output?.statusCode;

      console.log(`Disconnected [${phoneNumber}] reason:`, reason);

      if (reason !== DisconnectReason.loggedOut) {
        console.log(`Reconnecting ${phoneNumber} in 5s...`);
        connections.delete(phoneNumber);

        await logEvent('disconnected', { phoneNumber });
        await redisClient.hSet(`meta:${phoneNumber}`, 'status', 'offline');

        setTimeout(() => startBot(phoneNumber, socket), 5000);
      } else {
        console.log(`${phoneNumber} logged out.`);
        connections.delete(phoneNumber);

        await redisClient.del(`session:${phoneNumber}`);
        await redisClient.del(`meta:${phoneNumber}`);

        await logEvent('logged_out', { phoneNumber });

        if (socket) socket.emit('logged-out', 'WhatsApp session logged out');
      }
    }

    if (connection === 'open') {
      console.log(`✅ WhatsApp connected for ${phoneNumber}`);

      // Save/update metadata for admin dashboard
      const now = Date.now();
      const existing = await redisClient.hGetAll(`meta:${phoneNumber}`);
      const isFirstTime = !existing || !existing.pairedAt;

      await redisClient.hSet(`meta:${phoneNumber}`, {
        phoneNumber,
        status: 'online',
        lastConnected: String(now),
        pairedAt: existing?.pairedAt || String(now)
      });

      // Add to global set of all users ever paired
      await redisClient.sAdd('users:all', phoneNumber);

      if (isFirstTime) {
        await logEvent('paired', { phoneNumber });

        // ── Send welcome message ONLY on first-ever pairing ──
        try {
          await conn.sendMessage(`${phoneNumber}@s.whatsapp.net`, {
            text: WELCOME_MESSAGE
          });
        } catch (err) {
          console.error(`Failed to send welcome message to ${phoneNumber}:`, err.message);
        }
      } else {
        await logEvent('reconnected', { phoneNumber });
      }

      // ── Apply Auto Online setting ──
      try {
        const { getConfig } = require('./case');
        const config = await getConfig(redisClient, phoneNumber);
        if (config.autoOnline) {
          await conn.sendPresenceUpdate('available');
        }
      } catch (err) {
        console.error('Auto online apply error:', err.message);
      }

      if (socket) socket.emit('connected', 'WhatsApp connected successfully');
    }
  });

  // ── Save credentials ───────────────────────────────────
  conn.ev.on('creds.update', saveCreds);

  // ── Messages ───────────────────────────────────────────
  // ── Status updates (auto-view / auto-react / notify) ────
  conn.ev.on('messages.upsert', async (chatUpdate) => {
    try {
      const m = chatUpdate.messages[0];
      if (!m.message) return;
      if (m.key?.remoteJid !== 'status@broadcast') return;
      if (m.key?.fromMe) return; // don't react to our own status

      const { getConfig } = require('./case');
      const config = await getConfig(redisClient, phoneNumber);

      // ── Auto View Status ──
      if (config.autoViewStatus) {
        try {
          await conn.readMessages([m.key]);

          if (config.notifyStatus) {
            const senderTag = m.key.participant
              ? `@${m.key.participant.split('@')[0]}`
              : (m.pushName || 'Someone');

            await conn.sendMessage(`${phoneNumber}@s.whatsapp.net`, {
              text: `👁️ Viewed status from ${senderTag}`,
              mentions: m.key.participant ? [m.key.participant] : []
            });
          }
        } catch (err) {
          console.error('Auto view status error:', err.message);
        }
      }

      // ── Auto React to Status ──
      if (config.autoReactStatus) {
        try {
          await conn.sendMessage('status@broadcast', {
            react: { text: config.autoReactEmoji, key: m.key }
          }, { statusJidList: [m.key.participant, conn.user.id].filter(Boolean) });
        } catch (err) {
          console.error('Auto react status error:', err.message);
        }
      }
    } catch (err) {
      console.error('Status handler error:', err);
    }
  });

  // ── Main message handler ─────────────────────────────────
  conn.ev.on('messages.upsert', async (chatUpdate) => {
    try {
      let m = chatUpdate.messages[0];
      if (!m.message) return;
      if (m.key?.remoteJid === 'status@broadcast') return; // statuses handled above

      // Increment message counter for this user (for admin dashboard)
      try {
        await redisClient.hIncrBy(`meta:${phoneNumber}`, 'messagesReceived', 1);
      } catch {}

      m = smsg(conn, m);
      await require('./case')(conn, m, chatUpdate, {
        phoneNumber,
        redisClient,
        startBot,
        connections
      });
    } catch (err) {
      console.error('Message error:', err);
    }
  });

  // ── Anti-delete / Anti-edit ─────────────────────────────
  // WhatsApp sends a protocol message when someone deletes or edits a message
  conn.ev.on('messages.update', async (updates) => {
    try {
      const { messageStore } = require('./case');

      for (const update of updates) {
        const { key, update: msgUpdate } = update;

        // ── Message deleted ──
        if (msgUpdate?.message === null && global.antiDeleteEnabled) {
          const stored = messageStore.get(key.id);
          if (stored && stored.body) {
            const senderTag = stored.sender ? `@${stored.sender.split('@')[0]}` : 'Unknown';
            await conn.sendMessage(stored.from, {
              text: `🛡️ *Anti-Delete*\n\n${senderTag} deleted a message:\n\n"${stored.body}"`,
              mentions: stored.sender ? [stored.sender] : []
            });
          }
        }
      }
    } catch (err) {
      console.error('Anti-delete error:', err);
    }
  });

  // ── Anti-edit ────────────────────────────────────────────
  // Edited messages can arrive as:
  //  1) messages.upsert with protocolMessage.type === MESSAGE_EDIT
  //  2) messages.update with message.editedMessage present
  conn.ev.on('messages.upsert', async (chatUpdate) => {
    try {
      if (!global.antiEditEnabled) return;

      const { proto } = require('@whiskeysockets/baileys');
      const m = chatUpdate.messages[0];
      const editedMsg = m?.message?.protocolMessage;

      const EDIT_TYPE = proto.Message.ProtocolMessage.Type.MESSAGE_EDIT;

      if (editedMsg && editedMsg.type === EDIT_TYPE) {
        const { messageStore } = require('./case');
        const originalId = editedMsg.key?.id;
        const stored = messageStore.get(originalId);

        const newText = editedMsg.editedMessage?.conversation
          || editedMsg.editedMessage?.extendedTextMessage?.text
          || '(non-text content)';

        if (stored && stored.body) {
          const senderTag = stored.sender ? `@${stored.sender.split('@')[0]}` : 'Unknown';

          await conn.sendMessage(stored.from, {
            text: `🛡️ *Anti-Edit*\n\n${senderTag} edited a message:\n\n*Before:* ${stored.body}\n*After:* ${newText}`,
            mentions: stored.sender ? [stored.sender] : []
          });

          stored.body = newText;
          messageStore.set(originalId, stored);
        } else {
          // We don't have the original cached — still notify with what we know
          const senderTag = m.sender ? `@${m.sender.split('@')[0]}` : 'Unknown';
          await conn.sendMessage(m.from, {
            text: `🛡️ *Anti-Edit*\n\n${senderTag} edited a message:\n\n*After:* ${newText}\n\n(Original not found in cache)`,
            mentions: m.sender ? [m.sender] : []
          });
        }
      }
    } catch (err) {
      console.error('Anti-edit error:', err);
    }
  });

  // ── Group events ───────────────────────────────────────
  conn.ev.on('group-participants.update', async (update) => {
    const { id, participants, action } = update;

    if (action === 'add') {
      for (const participant of participants) {
        await conn.sendMessage(id, {
          text: `👋 Welcome @${participant.split('@')[0]}! Lady Liya is watching. 😎\n\nType .help to see what I can do.`,
          mentions: [participant]
        });
      }
    } else if (action === 'remove') {
      for (const participant of participants) {
        await conn.sendMessage(id, {
          text: `🚪 @${participant.split('@')[0]} has left. Goodbye! 👋`,
          mentions: [participant]
        });
      }
    }
  });

  return conn;
}

module.exports = {
  startBot,
  restoreAllSessions,
  connections,
  getRedis,
  logEvent,
  adminEvents,
  getSettings,
  updateSettings
};

// ── smsg helper ───────────────────────────────────────────
const { proto, getContentType } = require('@whiskeysockets/baileys');

function smsg(conn, m) {
  if (!m) return m;

  if (m.key) {
    m.id = m.key.id;
    m.isGroup = m.key.remoteJid.endsWith("@g.us");
    m.from = m.key.remoteJid;
    m.sender = conn.decodeJid(m.key.participant || m.key.remoteJid);
  }

  if (m.message) {
    m.mtype = getContentType(m.message);
    m.msg =
      m.mtype === 'viewOnceMessage'
        ? m.message[m.mtype].message[getContentType(m.message[m.mtype].message)]
        : m.message[m.mtype];

    m.body =
      m.mtype === 'conversation' ? m.message.conversation
      : m.mtype === 'imageMessage' ? m.message.imageMessage.caption
      : m.mtype === 'videoMessage' ? m.message.videoMessage.caption
      : m.mtype === 'extendedTextMessage' ? m.message.extendedTextMessage.text
      : '';

    m.mentionedJid = m.msg?.contextInfo?.mentionedJid || [];

    let quoted = (m.quoted = m.msg?.contextInfo?.quotedMessage
      ? m.msg.contextInfo : null);

    if (quoted) {
      const type = Object.keys(quoted.quotedMessage)[0];
      m.quoted = quoted.quotedMessage[type];
      if (typeof m.quoted === 'string') m.quoted = { text: m.quoted };

      m.quoted.mtype = type;
      m.quoted.id = m.msg.contextInfo.stanzaId;
      m.quoted.sender = conn.decodeJid(m.msg.contextInfo.participant);
      m.quoted.fromMe = m.quoted.sender === conn.decodeJid(conn.user.id);
      m.quoted.text = m.quoted.text || m.quoted.caption || m.quoted.conversation || '';
      m.quoted.mentionedJid = m.msg.contextInfo.mentionedJid || [];
    }
  }

  m.reply = (text, chatId = m.from, options = {}) =>
    conn.sendMessage(chatId, { text, ...options }, { quoted: m });

  return m;
}
