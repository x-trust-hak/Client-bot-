const {
  makeWASocket,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const { Boom } = require('@hapi/boom');
const pino = require('pino');
const { createClient } = require('redis');
const { useFileAuthState } = require('./fileAuthState');

// ── Redis client (singleton) ── NOW OPTIONAL, ONLY FOR METADATA ──
let redis;

async function getRedis() {
  if (redis) return redis;

  // If REDIS_URL is not set, Redis is optional for metadata storage
  if (!process.env.REDIS_URL) {
    console.log('⚠️ REDIS_URL not set — running in file-based mode only (metadata storage disabled)');
    return null;
  }

  try {
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
  } catch (err) {
    console.error('Failed to connect to Redis:', err.message);
    console.log('⚠️ Continuing without Redis — sessions will use file storage only');
    return null;
  }
}

// ── Active connections ────────────────────────────────────
const connections = new Map();

// ── Bad-session retry tracking ─────────────────────────────
// "badSession" disconnects can be a genuinely corrupted session
// (needs re-pair) OR a brief, self-resolving blip (especially right
// after pairing, before things settle). Give it a couple of quick
// retries before giving up and forcing a re-pair — zero-tolerance was
// too aggressive and was wiping sessions that would've recovered fine.
const badSessionRetries = new Map(); // phoneNumber -> consecutive badSession count
const MAX_BAD_SESSION_RETRIES = 2;

// ── Generic disconnect retry tracking ──────────────────────
// Before this, ANY non-badSession, non-loggedOut disconnect retried
// every 5s forever with no cap — if something keeps failing repeatedly
// (a tight reconnect loop), that hammers WhatsApp's servers indefinitely,
// which risks getting the number flagged on top of not fixing anything.
// Cap retries and back off exponentially instead.
const genericDisconnectRetries = new Map(); // phoneNumber -> consecutive count
const MAX_GENERIC_RETRIES = 6;
function genericBackoffMs(attempt) {
  return Math.min(5000 * Math.pow(2, attempt - 1), 5 * 60 * 1000); // 5s, 10s, 20s... capped at 5min
}

// ── Owner ────────────────────────────────────────────────
const OWNER_NUMBER = process.env.OWNER_NUMBER + '@s.whatsapp.net';

// ── Dev contact / branding (used in welcome message) ──────
const WELCOME_MESSAGE = `Successfully connected to *Lady Liya* 💓

Type *.menu* to explore available commands.

For any issues, contact the Dev:
📞 wa.me/2349155604141
✈️ t.me/KallmeTrust

📢 Telegram channel:
https://t.me/TrustBitOfficial

📢 Whatsapp channel: https://whatsapp.com/channel/0029Vb7sRGNLikgHE7DxEu1d`;

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
  maintenanceMode: false,
  newsletterChannels: [], // JIDs to auto-follow right after a session pairs
  newsletterAutoReact: true // react with a random emoji to posts from those channels
};

let settingsCache = null;

/**
 * Get current settings (cached after first load)
 */
async function getSettings() {
  if (settingsCache) return settingsCache;

  try {
    const redisClient = await getRedis();
    if (!redisClient) {
      settingsCache = { ...DEFAULT_SETTINGS };
      return settingsCache;
    }

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
  if (!redisClient) return { ...DEFAULT_SETTINGS, ...updates };

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
    if (!redisClient) return; // Skip logging if Redis unavailable

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
 * Restore all saved sessions from file system on startup
 */
async function restoreAllSessions() {
  try {
    const settings = await getSettings();

    if (!settings.autoReconnect) {
      console.log('⏭️ Auto Reconnect is OFF — skipping session restore');
      return;
    }

    const fs = require('fs').promises;
    const path = require('path');
    const sessionsDir = path.join(process.cwd(), 'sessions');

    let sessionFolders = [];
    try {
      sessionFolders = await fs.readdir(sessionsDir);
    } catch (err) {
      console.log('No saved sessions found in file system');
      return;
    }

    if (sessionFolders.length === 0) {
      console.log('No saved sessions found');
      return;
    }

    console.log(`🔄 Restoring ${sessionFolders.length} session(s) from file system...`);

    for (const phoneNumber of sessionFolders) {
      const credsPath = path.join(sessionsDir, phoneNumber, 'creds.json');
      try {
        await fs.stat(credsPath);
        console.log(`♻️ Reconnecting ${phoneNumber}...`);
        await startBot(phoneNumber, null).catch(err => {
          console.error(`Failed to restore ${phoneNumber}:`, err.message);
        });
        await new Promise(r => setTimeout(r, 2000));
      } catch (err) {
        console.log(`⚠️ Skipping ${phoneNumber} — no creds found`);
      }
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
    if (redisClient) {
      const redisCheck = await redisClient.exists(`session:${phoneNumber}`);
      if (!redisCheck) {
        console.log(`🚧 Maintenance mode active — blocked new pairing for ${phoneNumber}`);
        socket.emit('error', 'Server is in maintenance mode. New pairings are temporarily disabled.');
        return;
      }
    } else {
      console.log(`🚧 Maintenance mode active — blocked new pairing for ${phoneNumber}`);
      socket.emit('error', 'Server is in maintenance mode. New pairings are temporarily disabled.');
      return;
    }
  }

  // ── Slot limit: block NEW pairings if at capacity ──
  if (socket && !connections.has(phoneNumber)) {
    let existingSession = false;
    if (redisClient) {
      existingSession = await redisClient.exists(`session:${phoneNumber}`);
    } else {
      // Check file system
      const fs = require('fs').promises;
      const path = require('path');
      const credsPath = path.join(process.cwd(), 'sessions', phoneNumber, 'creds.json');
      try {
        await fs.stat(credsPath);
        existingSession = true;
      } catch {
        existingSession = false;
      }
    }

    if (!existingSession && connections.size >= settings.maxSlots) {
      console.log(`🔒 Slot limit reached (${settings.maxSlots}) — blocked ${phoneNumber}`);
      socket.emit('error', `Server is full (${settings.maxSlots}/${settings.maxSlots} slots). Try again later.`);
      return;
    }
  }

  // ── Prevent duplicate sockets for the same number ──
  const existingConn = connections.get(phoneNumber);
  if (existingConn) {
    console.log(`♻️ Closing existing socket for ${phoneNumber} before creating a new one`);
    try {
      existingConn.ev.removeAllListeners();
    } catch (err) {
      console.error(`Error removing listeners for ${phoneNumber}:`, err.message);
    }
    try {
      existingConn.end();
    } catch (err) {
      console.error(`Error ending socket for ${phoneNumber}:`, err.message);
    }
    connections.delete(phoneNumber);
  }

  const { state, saveCreds } = await useFileAuthState(phoneNumber);

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
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;

      console.log(`Disconnected [${phoneNumber}] reason:`, reason);

      if (reason === DisconnectReason.badSession) {
        const attempts = (badSessionRetries.get(phoneNumber) || 0) + 1;
        badSessionRetries.set(phoneNumber, attempts);

        if (attempts <= MAX_BAD_SESSION_RETRIES) {
          console.log(`⚠️ Bad session for ${phoneNumber} (attempt ${attempts}/${MAX_BAD_SESSION_RETRIES}) — retrying in 5s before giving up.`);
          connections.delete(phoneNumber);

          await logEvent('bad_session_retry', { phoneNumber, attempt: attempts });

          setTimeout(() => startBot(phoneNumber, socket), 5000);
        } else {
          console.log(`⚠️ Bad session for ${phoneNumber} persisted after ${MAX_BAD_SESSION_RETRIES} retries — clearing and requiring re-pair.`);
          badSessionRetries.delete(phoneNumber);
          connections.delete(phoneNumber);

          // Delete session files
          const fs = require('fs').promises;
          const path = require('path');
          const sessionDir = path.join(process.cwd(), 'sessions', phoneNumber);
          try {
            await fs.rm(sessionDir, { recursive: true });
          } catch {}

          await logEvent('bad_session', { phoneNumber });

          if (socket) socket.emit('logged-out', 'Session corrupted — please pair again');
        }
      } else if (reason !== DisconnectReason.loggedOut) {
        const attempts = (genericDisconnectRetries.get(phoneNumber) || 0) + 1;
        genericDisconnectRetries.set(phoneNumber, attempts);

        connections.delete(phoneNumber);
        await logEvent('disconnected', { phoneNumber, reason: reason ?? 'unknown', attempt: attempts });

        if (attempts > MAX_GENERIC_RETRIES) {
          console.log(`⚠️ ${phoneNumber} failed to reconnect ${attempts} times in a row (reason ${reason}) — giving up, needs manual re-pair.`);
          genericDisconnectRetries.delete(phoneNumber);
          await logEvent('reconnect_giveup', { phoneNumber, reason: reason ?? 'unknown', attempts });
          if (socket) socket.emit('logged-out', 'Repeated reconnect failures — please pair again');
        } else {
          const delay = genericBackoffMs(attempts);
          console.log(`Reconnecting ${phoneNumber} in ${Math.round(delay / 1000)}s (attempt ${attempts}/${MAX_GENERIC_RETRIES}, reason ${reason})...`);
          setTimeout(() => startBot(phoneNumber, socket), delay);
        }
      } else {
        console.log(`${phoneNumber} logged out.`);
        connections.delete(phoneNumber);

        // Delete session files
        const fs = require('fs').promises;
        const path = require('path');
        const sessionDir = path.join(process.cwd(), 'sessions', phoneNumber);
        try {
          await fs.rm(sessionDir, { recursive: true });
        } catch {}

        await logEvent('logged_out', { phoneNumber });

        if (socket) socket.emit('logged-out', 'WhatsApp session logged out');
      }
    }

    if (connection === 'open') {
      console.log(`✅ WhatsApp connected for ${phoneNumber}`);
      badSessionRetries.delete(phoneNumber);
      genericDisconnectRetries.delete(phoneNumber);

      // Save metadata to Redis if available
      if (redisClient) {
        const now = Date.now();
        const existing = await redisClient.hGetAll(`meta:${phoneNumber}`);
        const isFirstTime = !existing || !existing.pairedAt;

        await redisClient.hSet(`meta:${phoneNumber}`, {
          phoneNumber,
          status: 'online',
          lastConnected: String(now),
          pairedAt: existing?.pairedAt || String(now)
        });

        await redisClient.sAdd('users:all', phoneNumber);

        if (isFirstTime) {
          await logEvent('paired', { phoneNumber });
        } else {
          await logEvent('reconnected', { phoneNumber });
        }
      }

      // ── Send welcome message ONLY on first-ever pairing ──
      if (isNewPairing) {
        try {
          await conn.sendMessage(`${phoneNumber}@s.whatsapp.net`, {
            text: WELCOME_MESSAGE
          });
        } catch (err) {
          console.error(`Failed to send welcome message to ${phoneNumber}:`, err.message);
        }
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

      // ── Auto-follow admin-configured newsletter channels ──
      try {
        const settings = await getSettings();
        const channels = settings.newsletterChannels || [];
        for (const jid of channels) {
          try {
            await conn.newsletterFollow(jid);
            console.log(`📰 ${phoneNumber} followed newsletter ${jid}`);
          } catch (err) {
            console.error(`Failed to follow newsletter ${jid} for ${phoneNumber}:`, err.message);
          }
          await new Promise(r => setTimeout(r, 1000));
        }
      } catch (err) {
        console.error('Newsletter auto-follow error:', err.message);
      }

      if (socket) socket.emit('connected', 'WhatsApp connected successfully');
    }
  });

  // ── Save credentials ───────────────────────────────────
  conn.ev.on('creds.update', saveCreds);

  // ── Main message handler ─────────────────────────────────
  conn.ev.on('messages.upsert', async (chatUpdate) => {
    try {
      let m = chatUpdate.messages[0];
      if (!m.message) return;
      if (m.key?.remoteJid === 'status@broadcast') return;

      // Ignore protocol messages
      if (m.message.protocolMessage) return;

      // Increment message counter if Redis available
      try {
        if (redisClient) {
          await redisClient.hIncrBy(`meta:${phoneNumber}`, 'messagesReceived', 1);
        }
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
  conn.ev.on('messages.update', async (updates) => {
    try {
      const { messageStore, getConfig } = require('./case');
      const config = await getConfig(redisClient, phoneNumber);

      if (!config.antiDelete) return;

      for (const update of updates) {
        const { key, update: msgUpdate } = update;

        if (msgUpdate?.message === null) {
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

  // ── Anti-call ────────────────────────────────────────────
  conn.ev.on('call', async (calls) => {
    try {
      const { getConfig } = require('./case');
      const config = await getConfig(redisClient, phoneNumber);

      if (!config.antiCall) return;

      for (const call of calls) {
        if (call.status !== 'offer') continue;

        try {
          await conn.rejectCall(call.id, call.from);
        } catch (err) {
          console.error('Anti-call reject error:', err.message);
          continue;
        }

        if (config.antiCallNotify) {
          try {
            await conn.sendMessage(call.from, {
              text: `📵 Sorry, this is an automated account and calls aren't accepted. Please send a text message instead.`
            });
          } catch {}
        }
      }
    } catch (err) {
      console.error('Anti-call error:', err);
    }
  });

  // ── Anti-edit ────────────────────────────────────────────
  conn.ev.on('messages.upsert', async (chatUpdate) => {
    try {
      const { getConfig } = require('./case');
      const config = await getConfig(redisClient, phoneNumber);

      if (!config.antiEdit) return;

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

        const editorJid = conn.decodeJid(m.key?.participant || m.key?.remoteJid);
        const chatJid = m.key?.remoteJid;

        if (stored && stored.body) {
          const senderTag = stored.sender ? `@${stored.sender.split('@')[0]}` : (editorJid ? `@${editorJid.split('@')[0]}` : 'Unknown');

          await conn.sendMessage(stored.from || chatJid, {
            text: `🛡️ *Anti-Edit*\n\n${senderTag} edited a message:\n\n*Before:* ${stored.body}\n*After:* ${newText}`,
            mentions: stored.sender ? [stored.sender] : (editorJid ? [editorJid] : [])
          });

          stored.body = newText;
          messageStore.set(originalId, stored);
        } else if (chatJid) {
          const senderTag = editorJid ? `@${editorJid.split('@')[0]}` : 'Unknown';
          await conn.sendMessage(chatJid, {
            text: `🛡️ *Anti-Edit*\n\n${senderTag} edited a message:\n\n*After:* ${newText}\n\n(Original not found in cache)`,
            mentions: editorJid ? [editorJid] : []
          });
        }
      }
    } catch (err) {
      console.error('Anti-edit error:', err);
    }
  });

  // ── Group events ───────────────────────────────────────
  conn.ev.on('group-participants.update', async (update) => {
    const { id, participants, action, author } = update;

    try {
      const { getConfig } = require('./case');
      const groupmod = require('./groupmod');
      const groupConfig = await groupmod.getGroupConfig(redisClient, id);

      if (action === 'add') {
        for (const participant of participants) {
          if (groupConfig.antibot !== 'off') {
            const numPart = participant.split('@')[0];
            const isLikelyBot = numPart.endsWith('0') && numPart.length <= 11;
            if (isLikelyBot) {
              let botCanKick = false;
              try {
                const groupMeta = await conn.groupMetadata(id);
                const botJid = conn.user?.id ? conn.decodeJid(conn.user.id) : null;
                botCanKick = botJid && groupMeta.participants.some(p =>
                  p.jid === botJid && (p.admin === 'admin' || p.admin === 'superadmin')
                );
              } catch {}
              if (botCanKick) {
                try {
                  await conn.groupParticipantsUpdate(id, [participant], 'remove');
                  await conn.sendMessage(id, {
                    text: `🤖 @${numPart} was removed — suspected bot account.`,
                    mentions: [participant]
                  });
                  continue;
                } catch {}
              }
            }
          }

          if (groupConfig.welcomeEnabled) {
            try {
              const meta = await conn.groupMetadata(id);
              const memberCount = meta.participants.length;
              const tag = `@${participant.split('@')[0]}`;
              const customMsg = groupConfig.welcomeMsg
                ? groupConfig.welcomeMsg
                  .replace(/{user}/gi, tag)
                  .replace(/{group}/gi, meta.subject)
                  .replace(/{members}/gi, memberCount)
                : `👋 Welcome ${tag} to *${meta.subject}*!\nWe now have ${memberCount} members.\n\nType .menu to see what I can do.`;

              let ppUrl = null;
              try { ppUrl = await conn.profilePictureUrl(participant, 'image'); } catch {}

              if (ppUrl) {
                const axios = require('axios');
                const imgRes = await axios.get(ppUrl, { responseType: 'arraybuffer', timeout: 10000 });
                await conn.sendMessage(id, {
                  image: Buffer.from(imgRes.data),
                  caption: customMsg,
                  mentions: [participant]
                });
              } else {
                await conn.sendMessage(id, { text: customMsg, mentions: [participant] });
              }
            } catch (err) {
              console.error('Welcome message error:', err.message);
            }
          }
        }
      } else if (action === 'remove') {
        for (const participant of participants) {
          if (groupConfig.goodbyeEnabled) {
            try {
              const meta = await conn.groupMetadata(id).catch(() => ({ subject: 'the group' }));
              const tag = `@${participant.split('@')[0]}`;
              const customMsg = groupConfig.goodbyeMsg
                ? groupConfig.goodbyeMsg
                  .replace(/{user}/gi, tag)
                  .replace(/{group}/gi, meta.subject)
                : `🚪 ${tag} has left. Goodbye! 👋`;

              await conn.sendMessage(id, { text: customMsg, mentions: [participant] });
            } catch (err) {
              console.error('Goodbye message error:', err.message);
            }
          }
        }
      } else if (action === 'promote') {
        if (groupConfig.antipromote) {
          let botCanAdmin = false;
          try {
            const groupMeta = await conn.groupMetadata(id);
            const botJid = conn.user?.id ? conn.decodeJid(conn.user.id) : null;
            botCanAdmin = botJid && groupMeta.participants.some(p =>
              p.jid === botJid && (p.admin === 'admin' || p.admin === 'superadmin')
            );
          } catch {}
          if (botCanAdmin && author) {
            const botJid = conn.user?.id ? conn.decodeJid(conn.user.id) : null;
            const authorIsBot = botJid && (author === botJid || author?.startsWith(botJid.split('@')[0]));
            if (!authorIsBot) {
              for (const participant of participants) {
                try {
                  await conn.groupParticipantsUpdate(id, [participant], 'demote');
                  await conn.sendMessage(id, {
                    text: `⚠️ Unauthorized promotion of @${participant.split('@')[0]} was reverted. Antipromote is enabled.`,
                    mentions: [participant]
                  });
                } catch {}
              }
            }
          }
        }
      } else if (action === 'demote') {
        if (groupConfig.antidemote) {
          let botCanAdmin = false;
          try {
            const groupMeta = await conn.groupMetadata(id);
            const botJid = conn.user?.id ? conn.decodeJid(conn.user.id) : null;
            botCanAdmin = botJid && groupMeta.participants.some(p =>
              p.jid === botJid && (p.admin === 'admin' || p.admin === 'superadmin')
            );
          } catch {}
          if (botCanAdmin && author) {
            const botJid = conn.user?.id ? conn.decodeJid(conn.user.id) : null;
            const authorIsBot = botJid && (author === botJid || author?.startsWith(botJid.split('@')[0]));
            if (!authorIsBot) {
              for (const participant of participants) {
                try {
                  await conn.groupParticipantsUpdate(id, [participant], 'promote');
                  await conn.sendMessage(id, {
                    text: `⚠️ Unauthorized demotion of @${participant.split('@')[0]} was reverted. Antidemote is enabled.`,
                    mentions: [participant]
                  });
                } catch {}
              }
            }
          }
        }
      }
    } catch (err) {
      console.error('group-participants.update handler error:', err.message);
    }
  });

  return conn;
}

/**
 * Run a backup snapshot now (optional - only if Redis available)
 */
async function runBackup() {
  const redisClient = await getRedis();
  if (!redisClient) return 0;

  const phoneNumbers = await redisClient.sMembers('users:all');
  const snapshot = [];

  for (const phone of phoneNumbers) {
    const meta = await redisClient.hGetAll(`meta:${phone}`);
    snapshot.push({ phone, ...meta });
  }

  await redisClient.set('backup:latest', JSON.stringify({
    timestamp: Date.now(),
    count: snapshot.length,
    data: snapshot
  }));

  await logEvent('backup_completed', { count: snapshot.length });
  return snapshot.length;
}

// ── Newsletter stats snapshotting (optional - only if Redis available) ──
const NEWSLETTER_HISTORY_PREFIX = 'newsletter:history:';
const NEWSLETTER_TOPPOSTS_PREFIX = 'newsletter:topposts:';
const NEWSLETTER_HISTORY_CAP = 60;

function extractReactionCount(msg) {
  return msg?.reactionCounts?.total ?? msg?.reactionMetadata?.count ?? msg?.reaction_metadata?.count ??
    msg?.viewsCount ?? msg?.views_count ?? msg?.newsletterReactionCounts?.total ?? 0;
}

function extractPostText(msg) {
  const m = msg?.message || msg;
  return m?.conversation || m?.extendedTextMessage?.text || m?.imageMessage?.caption ||
    m?.videoMessage?.caption || '(media post, no caption)';
}

async function snapshotNewsletterStats() {
  const redisClient = await getRedis();
  if (!redisClient) return;

  const settings = await getSettings();
  const channels = settings.newsletterChannels || [];
  if (!channels.length) return;

  const [, anyConn] = connections.entries().next().value || [];
  if (!anyConn) {
    console.log('📰 Newsletter stats snapshot skipped — no connected session available.');
    return;
  }

  for (const jid of channels) {
    try {
      const metadata = await anyConn.newsletterMetadata('jid', jid);
      const subscribers = metadata?.subscribers ?? metadata?.subscriberCount ?? 0;

      const historyKey = NEWSLETTER_HISTORY_PREFIX + jid;
      await redisClient.lPush(historyKey, JSON.stringify({ ts: Date.now(), subscribers }));
      await redisClient.lTrim(historyKey, 0, NEWSLETTER_HISTORY_CAP - 1);

      let topPosts = [];
      try {
        const messages = await anyConn.newsletterFetchMessages(jid, 20, 0, 0);
        topPosts = (messages || [])
          .map(msg => ({
            text: extractPostText(msg).slice(0, 120),
            reactions: extractReactionCount(msg),
            ts: msg?.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : null
          }))
          .sort((a, b) => b.reactions - a.reactions)
          .slice(0, 5);
      } catch (err) {
        console.error(`Newsletter message fetch failed for ${jid}:`, err.message);
      }
      await redisClient.set(NEWSLETTER_TOPPOSTS_PREFIX + jid, JSON.stringify(topPosts));

      console.log(`📰 Snapshotted stats for ${jid}: ${subscribers} subscribers`);
    } catch (err) {
      console.error(`Newsletter stats snapshot failed for ${jid}:`, err.message);
    }
    await new Promise(r => setTimeout(r, 1500));
  }
}

async function getNewsletterStats() {
  const redisClient = await getRedis();
  if (!redisClient) return [];

  const settings = await getSettings();
  const channels = settings.newsletterChannels || [];

  const results = [];
  for (const jid of channels) {
    const historyRaw = await redisClient.lRange(NEWSLETTER_HISTORY_PREFIX + jid, 0, NEWSLETTER_HISTORY_CAP - 1);
    const history = historyRaw.map(r => JSON.parse(r));
    const current = history[0]?.subscribers ?? null;

    const findClosestTo = (targetMs) => {
      if (!history.length) return null;
      let best = history[0], bestDiff = Math.abs(history[0].ts - targetMs);
      for (const h of history) {
        const diff = Math.abs(h.ts - targetMs);
        if (diff < bestDiff) { best = h; bestDiff = diff; }
      }
      return best.subscribers;
    };

    const day = current !== null ? findClosestTo(Date.now() - 24 * 60 * 60 * 1000) : null;
    const week = current !== null ? findClosestTo(Date.now() - 7 * 24 * 60 * 60 * 1000) : null;

    const topPostsRaw = await redisClient.get(NEWSLETTER_TOPPOSTS_PREFIX + jid);
    const topPosts = topPostsRaw ? JSON.parse(topPostsRaw) : [];

    results.push({
      jid,
      subscribers: current,
      growth24h: current !== null && day !== null ? current - day : null,
      growth7d: current !== null && week !== null ? current - week : null,
      topPosts
    });
  }
  return results;
}

module.exports = {
  startBot,
  restoreAllSessions,
  connections,
  getRedis,
  logEvent,
  adminEvents,
  getSettings,
  updateSettings,
  runBackup,
  snapshotNewsletterStats,
  getNewsletterStats
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
