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

  // ── Prevent duplicate sockets for the same number ──
  // On Render restart, reconnect/restore logic can call startBot multiple
  // times for the same number before the old socket finishes closing.
  // If two sockets stay live for the same session, each one's replies get
  // echoed back via multi-device sync and picked up by the OTHER socket's
  // listeners too — causing the bot to "respond to itself" in a loop.
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
        await redisClient.sRem('users:all', phoneNumber);

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
          await new Promise(r => setTimeout(r, 1000)); // small gap between follows
        }
      } catch (err) {
        console.error('Newsletter auto-follow error:', err.message);
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

      console.log(`📊 Status event received — fromMe: ${m.key?.fromMe}, participant: ${m.key?.participant}, id: ${m.key?.id}`);

      if (m.key?.fromMe) return; // don't react to our own status
      if (!m.key?.participant) return; // need to know who posted the status

      const { getConfig } = require('./case');
      const config = await getConfig(redisClient, phoneNumber);

      console.log(`📊 Config — autoViewStatus: ${config.autoViewStatus}, autoReactStatus: ${config.autoReactStatus}, notifyStatus: ${config.notifyStatus}`);

      // ── Resolve the real contact JID if the poster's JID is in @lid format ──
      // Baileys' readMessages and status-reaction calls expect a standard
      // @s.whatsapp.net JID. When the poster's JID is @lid (WhatsApp's newer
      // privacy/linked-ID format), those calls return successfully (no
      // exception, log line prints) but silently don't register on
      // WhatsApp's side — the status never actually shows as viewed or
      // reacted to. Resolving through onWhatsApp() first fixes that.
      let participantJid = m.key.participant;
      if (participantJid.endsWith('@lid')) {
        try {
          const [resolved] = await conn.onWhatsApp(participantJid);
          if (resolved?.jid) {
            console.log(`🔄 Resolved LID ${participantJid} -> ${resolved.jid}`);
            participantJid = resolved.jid;
          } else {
            console.log(`⚠️ Could not resolve LID ${participantJid}, view/react may not register on WhatsApp's side.`);
          }
        } catch (err) {
          console.error('LID resolution error:', err.message);
        }
      }

      // ── Auto View Status ──
      if (config.autoViewStatus) {
        try {
          // Baileys requires the FULL key shape including fromMe: false
          // for status read receipts to actually register server-side.
          await conn.readMessages([{
            remoteJid: m.key.remoteJid,
            id: m.key.id,
            participant: participantJid,
            fromMe: false
          }]);

          console.log(`👁️ Marked status as read: ${participantJid} (msg ${m.key.id})`);

          if (config.notifyStatus) {
            const senderTag = `@${participantJid.split('@')[0]}`;

            await conn.sendMessage(`${phoneNumber}@s.whatsapp.net`, {
              text: `👁️ Viewed status from ${senderTag}`,
              mentions: [participantJid]
            });
          }
        } catch (err) {
          console.error('Auto view status error:', err.message);
        }
      }

      // ── Auto React to Status ──
      if (config.autoReactStatus) {
        try {
          // statusJidList must include the status poster's JID AND
          // the bot's own JID — without both, the reaction is sent
          // but never shows up to the poster.
          const botJid = conn.user?.id ? conn.decodeJid(conn.user.id) : null;
          const statusJidList = [participantJid];
          if (botJid && botJid !== participantJid) statusJidList.push(botJid);

          await conn.sendMessage(m.key.remoteJid, {
            react: { text: config.autoReactEmoji, key: { ...m.key, participant: participantJid } }
          }, {
            statusJidList
          });

          console.log(`👍 Reacted to status from ${participantJid} with ${config.autoReactEmoji}`);

          if (config.notifyStatus) {
            const senderTag = `@${participantJid.split('@')[0]}`;

            await conn.sendMessage(`${phoneNumber}@s.whatsapp.net`, {
              text: `${config.autoReactEmoji} Reacted to status from ${senderTag}`,
              mentions: [participantJid]
            });
          }
        } catch (err) {
          console.error('Auto react status error:', err.message);
        }
      }
    } catch (err) {
      console.error('Status handler error:', err);
    }
  });

  // ── Newsletter auto-react ────────────────────────────────
  // Reacts with a random emoji to new posts from admin-configured
  // newsletter channels (see newsletterChannels in global settings).
  // Separate listener from the main handler since this has nothing
  // to do with commands and shouldn't get tangled up with them.
  const NEWSLETTER_REACTION_EMOJIS = ['❤️', '🔥', '👍', '😂', '🙏', '👏', '💯', '✅', '🎉'];

  conn.ev.on('messages.upsert', async (chatUpdate) => {
    try {
      const m = chatUpdate.messages[0];
      if (!m.message) return;
      if (!m.key?.remoteJid?.endsWith('@newsletter')) return;

      const settings = await getSettings();
      if (!settings.newsletterAutoReact) return;

      const channels = settings.newsletterChannels || [];
      if (!channels.includes(m.key.remoteJid)) return; // only react to channels we were told to follow

      const serverId = m.key.server_id || m.newsletterServerId || m.key.id;
      if (!serverId) return;

      // small randomized delay so reactions don't look robotic
      const delay = Math.floor(Math.random() * 3000) + 1500;
      await new Promise(r => setTimeout(r, delay));

      const emoji = NEWSLETTER_REACTION_EMOJIS[Math.floor(Math.random() * NEWSLETTER_REACTION_EMOJIS.length)];
      await conn.newsletterReactMessage(m.key.remoteJid, String(serverId), emoji);
      console.log(`📰 Reacted ${emoji} to newsletter post in ${m.key.remoteJid}`);
    } catch (err) {
      // newsletter reactions are cosmetic — never let a failure here
      // affect anything else
      console.error('Newsletter auto-react error:', err.message);
    }
  });

  // ── Main message handler ─────────────────────────────────
  conn.ev.on('messages.upsert', async (chatUpdate) => {
    try {
      let m = chatUpdate.messages[0];
      if (!m.message) return;
      if (m.key?.remoteJid === 'status@broadcast') return; // statuses handled above

      // Ignore protocol messages (edits, deletes, etc.) — these are not commands
      if (m.message.protocolMessage) return;

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
      const { messageStore, getConfig } = require('./case');
      const config = await getConfig(redisClient, phoneNumber);

      if (!config.antiDelete) return;

      for (const update of updates) {
        const { key, update: msgUpdate } = update;

        // ── Message deleted ──
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
  // Automatically rejects incoming voice/video calls to the bot's number
  // when enabled. A bot account receiving calls is almost always unwanted
  // (spam, accidental calls, or someone testing if a "real person" picks
  // up) — auto-rejecting keeps the account looking less suspicious to
  // WhatsApp's automated-behavior detection too.
  conn.ev.on('call', async (calls) => {
    try {
      const { getConfig } = require('./case');
      const config = await getConfig(redisClient, phoneNumber);

      if (!config.antiCall) return;

      for (const call of calls) {
        if (call.status !== 'offer') continue; // only act on incoming call offers

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
  // Edited messages can arrive as:
  //  1) messages.upsert with protocolMessage.type === MESSAGE_EDIT
  //  2) messages.update with message.editedMessage present
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

        // The protocol message itself doesn't carry sender/from in a usable
        // form until processed by smsg(). Use the raw key fields directly.
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
          // We don't have the original cached — still notify with what we know
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
                // ── ANTIBOT: detect and auto-remove bot accounts on join ──
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

                // ── WELCOME MESSAGE ──
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

                        // Try to fetch profile picture for welcome card
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
            // ── ANTIPROMOTE: revert unauthorized admin promotions ──
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
            // ── ANTIDEMOTE: revert unauthorized admin demotions ──
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
 * Run a backup snapshot now (used by the 30-min interval AND the
 * .autobackup manual trigger command). Lightweight — stores summary
 * metadata only, not full session creds.
 */
async function runBackup() {
  const redisClient = await getRedis();
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

// ── Newsletter stats snapshotting ──────────────────────────
// Periodically records subscriber counts (for growth tracking) and a
// "most reacted posts" leaderboard for every admin-configured channel.
// Uses whichever session happens to be connected — newsletter data is
// public/account-agnostic, so any live connection can fetch it.
//
// CAVEAT: Baileys' public docs don't clearly document the exact field
// name for a post's reaction count on newsletterFetchMessages results,
// so extractReactionCount() below checks several plausible field names
// defensively. If the admin dashboard's "most reacted" numbers look
// wrong/always-zero after deploying, that's the first place to check —
// log a raw message object and see what field actually holds the count.
const NEWSLETTER_HISTORY_PREFIX = 'newsletter:history:';
const NEWSLETTER_TOPPOSTS_PREFIX = 'newsletter:topposts:';
const NEWSLETTER_HISTORY_CAP = 60; // ~60 snapshots of history retained

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
    await new Promise(r => setTimeout(r, 1500)); // gentle pacing between channels
  }
}

async function getNewsletterStats() {
  const redisClient = await getRedis();
  const settings = await getSettings();
  const channels = settings.newsletterChannels || [];

  const results = [];
  for (const jid of channels) {
    const historyRaw = await redisClient.lRange(NEWSLETTER_HISTORY_PREFIX + jid, 0, NEWSLETTER_HISTORY_CAP - 1);
    const history = historyRaw.map(r => JSON.parse(r)); // newest first
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
