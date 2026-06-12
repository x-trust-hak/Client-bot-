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
  /*const conn = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000
  });*/

  const conn = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,

    syncFullHistory: false,
    markOnlineOnConnect: true,
    generateHighQualityLinkPreview: true,

    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000
});

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
  
  conn.ev.on('messages.upsert', ({ messages, type }) => {
    console.log('UPSERT EVENT:', type);
    console.log(JSON.stringify(messages[0], null, 2));
});
/* COMMANDS */
  
conn.ev.on('messages.upsert', async ({ messages }) => {
    try {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;

        const body =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            msg.message?.videoMessage?.caption ||
            '';

        const prefix = '.';

        if (!body.startsWith(prefix)) return;

        const args = body.slice(prefix.length).trim().split(/ +/);
        const command = args.shift().toLowerCase();

        switch (command) {

            case "ping":
                await conn.sendMessage(from, {
                    text: "🏓 Pong! Bot is alive."
                });
                break;

            case "time":
                await conn.sendMessage(from, {
                    text: `🕐 ${new Date().toLocaleString()}`
                });
                break;

            case "reverse":
                await conn.sendMessage(from, {
                    text: args.join(" ").split("").reverse().join("")
                });
                break;

            case "quote":
                const quotes = [
                    "Success is not final.",
                    "Failure is not fatal.",
                    "Keep moving forward.",
                    "Code. Learn. Improve."
                ];

                await conn.sendMessage(from, {
                    text: quotes[Math.floor(Math.random() * quotes.length)]
                });
                break;

            case "runtime":
                const uptime = process.uptime();

                const hours = Math.floor(uptime / 3600);
                const mins = Math.floor((uptime % 3600) / 60);
                const secs = Math.floor(uptime % 60);

                await conn.sendMessage(from, {
                    text: `⏱️ Runtime: ${hours}h ${mins}m ${secs}s`
                });
                break;

            case "owner":
                await conn.sendMessage(from, {
                    text: `👑 Owner: wa.me/${process.env.OWNER_NUMBER}`
                });
                break;

            case "help":
                await conn.sendMessage(from, {
                    text: `
📋 COMMANDS

.ping
.time
.reverse text
.quote
.runtime
.owner
.help
                    `
                });
                break;
        }

    } catch (err) {
        console.log(err);
    }
});

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
