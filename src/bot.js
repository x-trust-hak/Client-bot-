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

/**
 * Restore all saved sessions from Redis on startup
 * Called once when server starts
 */
async function restoreAllSessions() {
  try {
    const redisClient = await getRedis();

    // Find all session keys in Redis
    const keys = await redisClient.keys('session:*');

    if (keys.length === 0) {
      console.log('No saved sessions found in Redis');
      return;
    }

    console.log(`🔄 Restoring ${keys.length} session(s) from Redis...`);

    for (const key of keys) {
      // Extract phone number from key e.g. "session:2347064578908" -> "2347064578908"
      const phoneNumber = key.replace('session:', '');

      // Check it has creds saved (not an empty/broken session)
      const creds = await redisClient.hGet(key, 'creds');
      if (!creds) {
        console.log(`⚠️ Skipping ${phoneNumber} — no creds found`);
        continue;
      }

      console.log(`♻️ Reconnecting ${phoneNumber}...`);

      // Reconnect with a null socket (background reconnect, no frontend needed)
      await startBot(phoneNumber, null).catch(err => {
        console.error(`Failed to restore ${phoneNumber}:`, err.message);
      });

      // Small delay between each to avoid hammering WhatsApp
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

  // Get (or create) Redis connection
  const redisClient = await getRedis();

  // Load auth state from Redis
  const { state, saveCreds } =
    await useRedisAuthState(redisClient, phoneNumber);

  // Fetch latest WhatsApp Web version
  const { version } = await fetchLatestBaileysVersion();

  // Create WhatsApp socket
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

  // ── Generate pairing code (only for new sessions with a live socket) ──
  if (!conn.authState.creds.registered && phoneNumber && socket) {
    setTimeout(async () => {
      try {
        let code = await conn.requestPairingCode(phoneNumber);
        code = code?.match(/.{1,4}/g)?.join('-') || code;
        socket.emit('pairing-code', code);
        console.log(`Pairing code for ${phoneNumber}:`, code);
      } catch (err) {
        console.error('Failed to generate pairing code:', err);
        socket.emit('error', 'Failed to generate pairing code');
      }
    }, 3000);
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
        setTimeout(() => startBot(phoneNumber, socket), 5000);
      } else {
        console.log(`${phoneNumber} logged out.`);
        connections.delete(phoneNumber);

        // Delete session from Redis on logout
        await redisClient.del(`session:${phoneNumber}`);

        if (socket) socket.emit('logged-out', 'WhatsApp session logged out');
      }
    }

    if (connection === 'open') {
      console.log(`✅ WhatsApp connected for ${phoneNumber}`);
      if (socket) socket.emit('connected', 'WhatsApp connected successfully');
    }
  });

  // ── Save credentials ───────────────────────────────────
  conn.ev.on('creds.update', saveCreds);

  // ── Messages ───────────────────────────────────────────
  conn.ev.on('messages.upsert', async (chatUpdate) => {
    try {
      let m = chatUpdate.messages[0];
      if (!m.message) return;
      m = smsg(conn, m);
      await require('./case')(conn, m, chatUpdate);
    } catch (err) {
      console.error('Message error:', err);
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
}

module.exports = { startBot, restoreAllSessions, connections };

// ── smsg helper ───────────────────────────────────────────
const { proto, getContentType } = require('@whiskeysockets/baileys');

function smsg(conn, m) {
  if (!m) return m;

  if (m.key) {
    m.id = m.key.id;
    m.isGroup = m.key.remoteJid.endsWith('@g.us');
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
