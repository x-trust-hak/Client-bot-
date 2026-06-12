const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const { Boom } = require('@hapi/boom');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

// Folder where WhatsApp sessions are stored
const AUTH_FOLDER = path.join(__dirname, '../../auth_info');

// Store active connections
const connections = new Map();

// Store warnings for group moderation
const warnings = new Map();

// Track bot uptime
const startTime = Date.now();

// Owner JID
const OWNER_NUMBER = process.env.OWNER_NUMBER + '@s.whatsapp.net';

/**
 * Start a WhatsApp session for a user
 * @param {string} phoneNumber
 * @param {object} socket
 */
async function startBot(phoneNumber, socket) {

  // Create unique session folder for each phone number
  const userAuthFolder = path.join(
    process.cwd(),
    'auth_info',
    phoneNumber
  );

  if (!fs.existsSync(userAuthFolder)) {
    fs.mkdirSync(userAuthFolder, { recursive: true });
  }

  // Load or create authentication state
  const { state, saveCreds } =
    await useMultiFileAuthState(userAuthFolder);

  // Fetch latest supported WhatsApp Web version
  const { version } =
    await fetchLatestBaileysVersion();

  // Create WhatsApp socket connection
/*  const conn = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000
  });*/

  // Create WhatsApp socket connection
const conn = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000
});

console.log("✅ Socket created");
  
  const { jidDecode } = require("@whiskeysockets/baileys");

conn.decodeJid = (jid) => {
    if (!jid) return jid;

    if (/:\d+@/gi.test(jid)) {
        let decode = jidDecode(jid) || {};
        return (
            decode.user &&
            decode.server &&
            `${decode.user}@${decode.server}`
        ) || jid;
    }

    return jid;
};

  // Save active connection
  connections.set(phoneNumber, conn);

  /**
   * Generate pairing code
   * Only runs if account isn't already linked
   */
  if (!conn.authState.creds.registered && phoneNumber) {
    setTimeout(async () => {
      try {
        let code =
          await conn.requestPairingCode(phoneNumber);

        // Format code: XXXX-XXXX
        code =
          code?.match(/.{1,4}/g)?.join('-') || code;

        // Send pairing code to frontend
        socket.emit('pairing-code', code);

        console.log('Pairing code:', code);

      } catch (err) {
        console.error(
          'Failed to generate pairing code:',
          err
        );
      }
    }, 3000);
  }

  /**
   * Connection status updates
   */
 /* conn.ev.on("connection.update", (update) => {
    console.log("CONNECTION UPDATE:", JSON.stringify(update, null, 2));
});*/
  conn.ev.on('connection.update', async (update) => {
    const {
      connection,
      lastDisconnect
    } = update;

    // Handle disconnects
    if (connection === 'close') {

      const reason =
        new Boom(lastDisconnect?.error)
          ?.output?.statusCode;

      console.log(
        'Disconnected reason:',
        reason
      );

      // Reconnect unless logged out
      if (reason !== DisconnectReason.loggedOut) {

        console.log(
          'Attempting reconnection in 5 seconds...'
        );

        setTimeout(() => {
          startBot(phoneNumber, socket);
        }, 5000);

      } else {

        console.log(
          'User logged out. Stopping reconnect.'
        );

        connections.delete(phoneNumber);

        socket.emit(
          'logged-out',
          'WhatsApp session logged out'
        );
      }
    }

    // Connection successful
    if (connection === 'open') {

      console.log(
        `WhatsApp connected for ${phoneNumber}`
      );

      socket.emit(
        'connected',
        'WhatsApp connected successfully'
      );
    }
  });

  /**
   * Save updated credentials automatically
   */
  conn.ev.on('creds.update', saveCreds);
  
  conn.ev.on("messages.upsert", async (chatUpdate) => {
    try {
        console.log("📩 Message received");

        let m = chatUpdate.messages[0];
        if (!m.message) return;

        m = smsg(conn, m);

        await require("./case")(conn, m, chatUpdate);
    } catch (err) {
        console.log(err);
    }
});

/* conn.ev.on('messages.upsert', async (chatUpdate) => {
   console.log("📩 Message received");
   try {
        let m = chatUpdate.messages[0];
        if (!m.message) return;

        m = smsg(conn, m);

        // Ignore status broadcasts
        if (m.from === 'status@broadcast') return;

        // Load commands
        require('./case')(conn, m, chatUpdate);

    } catch (err) {
        console.log(err);
    }
});*/

console.log("✅ messages.upsert listener registered");

    conn.ev.on('group-participants.update', async (update) => {
        const { id, participants, action } = update;

        if (action === 'add') {
            for (const participant of participants) {
                await conn.sendMessage(id, {
                    text: `👋 Welcome to the group @${participant.split('@')[0]}! CYPHER XD is watching over this place. 😎\n\nType .help to see what I can do.`,
                    mentions: [participant]
                });
            }
        } else if (action === 'remove') {
            for (const participant of participants) {
                await conn.sendMessage(id, {
                    text: `🚪 @${participant.split('@')[0]} has left the group. Goodbye! 👋`,
                    mentions: [participant]
                });
            }
        }
    });
    



}

module.exports = { startBot };

const {
    proto,
    getContentType
} = require("@whiskeysockets/baileys");

function smsg(conn, m) {
    if (!m) return m;

    if (m.key) {
        m.id = m.key.id;
        m.isGroup = m.key.remoteJid.endsWith("@g.us");
        m.from = m.key.remoteJid;
        m.sender = conn.decodeJid(
            m.key.participant || m.key.remoteJid
        );
    }

    if (m.message) {
        m.mtype = getContentType(m.message);

        m.msg =
            m.mtype === "viewOnceMessage"
                ? m.message[m.mtype].message[
                      getContentType(m.message[m.mtype].message)
                  ]
                : m.message[m.mtype];

        m.body =
            m.mtype === "conversation"
                ? m.message.conversation
                : m.mtype === "imageMessage"
                ? m.message.imageMessage.caption
                : m.mtype === "videoMessage"
                ? m.message.videoMessage.caption
                : m.mtype === "extendedTextMessage"
                ? m.message.extendedTextMessage.text
                : "";

        m.mentionedJid =
            m.msg?.contextInfo?.mentionedJid || [];

        let quoted =
            (m.quoted = m.msg?.contextInfo?.quotedMessage
                ? m.msg.contextInfo
                : null);

        if (quoted) {
            let type = Object.keys(
                quoted.quotedMessage
            )[0];

            m.quoted = quoted.quotedMessage[type];

            if (typeof m.quoted === "string") {
                m.quoted = { text: m.quoted };
            }

            m.quoted.mtype = type;
            m.quoted.id = m.msg.contextInfo.stanzaId;
            m.quoted.sender = conn.decodeJid(
                m.msg.contextInfo.participant
            );
            m.quoted.fromMe =
                m.quoted.sender ===
                conn.decodeJid(conn.user.id);

            m.quoted.text =
                m.quoted.text ||
                m.quoted.caption ||
                m.quoted.conversation ||
                "";

            m.quoted.mentionedJid =
                m.msg.contextInfo.mentionedJid || [];
        }
    }

    m.reply = (text, chatId = m.from, options = {}) =>
        conn.sendMessage(
            chatId,
            {
                text,
                ...options,
            },
            {
                quoted: m,
            }
        );

    return m;
}

/*const file = require.resolve("./case.js");

fs.watchFile(file, () => {
    fs.unwatchFile(file);

    console.log("Reloaded case.js");

    delete require.cache[file];

    require("./case");

    fs.watchFile(file, () => {});
});*/
