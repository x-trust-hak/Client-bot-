const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
//const path = require('path');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const AUTH_FOLDER = path.join(__dirname, '../../auth_info');
const connections = new Map();
const warnings = new Map();
const startTime = Date.now();
const OWNER_NUMBER = process.env.OWNER_NUMBER + '@s.whatsapp.net';

//const path = require('path');
//const fs = require('fs');
//const pino = require('pino');
//const { Boom } = require('@hapi/boom');
async function startBot(phoneNumber, socket) {
  const userAuthFolder = path.join(process.cwd(), 'auth_info', phoneNumber);

  if (!fs.existsSync(userAuthFolder)) {
    fs.mkdirSync(userAuthFolder, { recursive: true });
  }

  const { state, saveCreds } =
    await useMultiFileAuthState(userAuthFolder);

  const { version } =
    await fetchLatestBaileysVersion();

  const conn = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000
  });

  connections.set(phoneNumber, conn);

  // Request pairing code BEFORE open
  if (!conn.authState.creds.registered && phoneNumber) {
    setTimeout(async () => {
      try {
        let code = await conn.requestPairingCode(phoneNumber);

        code =
          code?.match(/.{1,4}/g)?.join('-') || code;

        socket.emit('pairing-code', code);

        console.log('Pairing code:', code);
      } catch (err) {
        console.error(err);
      }
    }, 3000);
  }

  conn.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const reason =
        new Boom(lastDisconnect?.error)?.output
          ?.statusCode;

      console.log(
        'Disconnected reason:',
        reason
      );

      if (reason !== DisconnectReason.loggedOut) {
        setTimeout(() => {
          startBot(phoneNumber, socket);
        }, 5000);
      }
    }

    if (connection === 'open') {
      console.log('WhatsApp connected');
      socket.emit(
        'connected',
        'WhatsApp connected successfully'
      );
    }
  });

  conn.ev.on('creds.update', saveCreds);

    conn.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        const isGroup = from.endsWith('@g.us');

        const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        const prefix = '.';
        if (!body.startsWith(prefix)) return;

        const args = body.slice(prefix.length).trim().split(' ');
        const command = args.shift().toLowerCase();
        const sender = isGroup ? msg.key.participant : from;

        if (isGroup) {
            const groupMetadata = await conn.groupMetadata(from);
            const groupAdmins = groupMetadata.participants
                .filter(p => p.admin)
                .map(p => p.id);
            const isAdmin = groupAdmins.includes(sender);

            if (command === 'kick') {
                if (!isAdmin) return conn.sendMessage(from, { text: '❌ Only admins can use this command.' });
                const target = args[0]?.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                await conn.groupParticipantsUpdate(from, [target], 'remove');
                await conn.sendMessage(from, { text: `👢 CYPHER XD has kicked @${args[0]?.replace(/[^0-9]/g, '')} out of the group!`, mentions: [target] });

            } else if (command === 'warn') {
                if (!isAdmin) return conn.sendMessage(from, { text: '❌ Only admins can use this command.' });
                const target = args[0]?.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                warnings.set(target, (warnings.get(target) || 0) + 1);
                const count = warnings.get(target);
                await conn.sendMessage(from, { text: `⚔️ CYPHER XD has warned @${args[0]?.replace(/[^0-9]/g, '')}! (${count}/3) — Watch yourself.`, mentions: [target] });
                if (count >= 3) {
                    await conn.groupParticipantsUpdate(from, [target], 'remove');
                    await conn.sendMessage(from, { text: `🔨 CYPHER XD has auto-kicked @${args[0]?.replace(/[^0-9]/g, '')} after 3 warnings. Goodbye! 👋`, mentions: [target] });
                    warnings.delete(target);
                }

            } else if (command === 'unwarn') {
                if (!isAdmin) return conn.sendMessage(from, { text: '❌ Only admins can use this command.' });
                const target = args[0]?.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                if (warnings.has(target)) {
                    warnings.set(target, warnings.get(target) - 1);
                    if (warnings.get(target) <= 0) warnings.delete(target);
                }
                await conn.sendMessage(from, { text: `🛡️ CYPHER XD has removed a warning from @${args[0]?.replace(/[^0-9]/g, '')}. Consider yourself lucky!`, mentions: [target] });

            } else if (command === 'ban') {
                if (!isAdmin) return conn.sendMessage(from, { text: '❌ Only admins can use this command.' });
                const target = args[0]?.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                await conn.groupParticipantsUpdate(from, [target], 'remove');
                await conn.sendMessage(from, { text: `🔨 CYPHER XD has banned @${args[0]?.replace(/[^0-9]/g, '')} from the group. You are not welcome here!`, mentions: [target] });

            } else if (command === 'delete') {
                if (!isAdmin) return conn.sendMessage(from, { text: '❌ Only admins can use this command.' });
                if (msg.message?.extendedTextMessage?.contextInfo?.stanzaId) {
                    await conn.sendMessage(from, { delete: { remoteJid: from, id: msg.message.extendedTextMessage.contextInfo.stanzaId, participant: msg.message.extendedTextMessage.contextInfo.participant } });
                    await conn.sendMessage(from, { text: `🗑️ CYPHER XD has deleted that message. It never existed!` });
                }

            } else if (command === 'mute') {
                if (!isAdmin) return conn.sendMessage(from, { text: '❌ Only admins can use this command.' });
                await conn.groupSettingUpdate(from, 'announcement');
                await conn.sendMessage(from, { text: '🔇 CYPHER XD has muted the group. Silence is golden! 🤫' });

            } else if (command === 'unmute') {
                if (!isAdmin) return conn.sendMessage(from, { text: '❌ Only admins can use this command.' });
                await conn.groupSettingUpdate(from, 'not_announcement');
                await conn.sendMessage(from, { text: '🔊 CYPHER XD has unmuted the group. You may speak! 🎉' });

            } else if (command === 'getpp') {
                const target = args[0]?.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                try {
                    const ppUrl = await conn.profilePictureUrl(target, 'image');
                    await conn.sendMessage(from, { image: { url: ppUrl }, caption: `🖼️ CYPHER XD fetched @${args[0]?.replace(/[^0-9]/g, '')}'s profile picture!`, mentions: [target] });
                } catch {
                    await conn.sendMessage(from, { text: `❌ CYPHER XD couldn't fetch @${args[0]?.replace(/[^0-9]/g, '')}'s profile picture. They might have it hidden! 🙈`, mentions: [target] });
                }

            } else if (command === 'help') {
                await conn.sendMessage(from, { text: `*📋 CYPHER XD Command Menu*\n\n👢 .kick @user — Kick a member\n⚔️ .warn @user — Warn a member (auto-kick at 3)\n🛡️ .unwarn @user — Remove a warning\n🔨 .ban @user — Ban a member\n🗑️ .delete — Reply to a message to delete it\n🔇 .mute — Mute the group\n🔊 .unmute — Unmute the group\n🖼️ .getpp @user — Fetch a member's profile picture\n📋 .help — Show this menu` });
            }

        } else {

            if (command === 'ping') {
                await conn.sendMessage(from, { text: '🏓 Pong! CYPHER XD is alive and active!' });

            } else if (command === 'time') {
                const now = new Date();
                await conn.sendMessage(from, { text: `🕐 Current time: *${now.toLocaleString()}*` });

            } else if (command === 'reverse') {
                const text = args.join(' ');
                await conn.sendMessage(from, { text: `🔄 ${text.split('').reverse().join('')}` });

            } else if (command === 'quote') {
                const quotes = [
                    "The only way to do great work is to love what you do. — Steve Jobs",
                    "In the middle of every difficulty lies opportunity. — Albert Einstein",
                    "It does not matter how slowly you go as long as you do not stop. — Confucius",
                    "Success is not final, failure is not fatal. — Winston Churchill",
                    "Believe you can and you're halfway there. — Theodore Roosevelt",
                    "Code is like humor. When you have to explain it, it's bad. — Cory House",
                    "SEE IT, TOUCH IT, OBTAIN IT. — CYPHER XD 👑"
                ];
                const random = quotes[Math.floor(Math.random() * quotes.length)];
                await conn.sendMessage(from, { text: `💬 *Quote of the moment:*\n\n_${random}_` });

            } else if (command === 'bio') {
                try {
                    const status = await conn.fetchStatus(from);
                    await conn.sendMessage(from, { text: `📝 *Your bio:*\n\n_${status?.status || 'No bio set'}_` });
                } catch {
                    await conn.sendMessage(from, { text: '❌ Could not fetch your bio.' });
                }

            } else if (command === 'getpp') {
                try {
                    const ppUrl = await conn.profilePictureUrl(from, 'image');
                    await conn.sendMessage(from, { image: { url: ppUrl }, caption: '🖼️ Here is your profile picture!' });
                } catch {
                    await conn.sendMessage(from, { text: '❌ Could not fetch your profile picture. It might be hidden!' });
                }

            } else if (command === 'sticker') {
                const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                const imageMsg = quoted?.imageMessage || msg.message?.imageMessage;
                if (!imageMsg) return conn.sendMessage(from, { text: '❌ Please send or reply to an image with .sticker' });
                try {
                    const stream = await conn.downloadMediaMessage({ message: { imageMessage: imageMsg }, key: msg.key });
                    const buffer = await sharp(stream).webp().toBuffer();
                    await conn.sendMessage(from, { sticker: buffer });
                } catch {
                    await conn.sendMessage(from, { text: '❌ Failed to convert image to sticker.' });
                }

            } else if (command === 'toimage') {
                const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                const stickerMsg = quoted?.stickerMessage || msg.message?.stickerMessage;
                if (!stickerMsg) return conn.sendMessage(from, { text: '❌ Please reply to a sticker with .toimage' });
                try {
                    const stream = await conn.downloadMediaMessage({ message: { stickerMessage: stickerMsg }, key: msg.key });
                    const buffer = await sharp(stream).png().toBuffer();
                    await conn.sendMessage(from, { image: buffer, caption: '🖼️ Here is your image!' });
                } catch {
                    await conn.sendMessage(from, { text: '❌ Failed to convert sticker to image.' });
                }

            } else if (command === 'owner') {
                await conn.sendMessage(from, { text: `👑 *Bot Owner*\n\nName: CYPHER XD\nContact: wa.me/${process.env.OWNER_NUMBER}` });

            } else if (command === 'runtime') {
                const uptime = Date.now() - startTime;
                const seconds = Math.floor((uptime / 1000) % 60);
                const minutes = Math.floor((uptime / (1000 * 60)) % 60);
                const hours = Math.floor((uptime / (1000 * 60 * 60)) % 24);
                await conn.sendMessage(from, { text: `⏱️ *CYPHER XD has been running for:*\n\n${hours}h ${minutes}m ${seconds}s` });

            } else if (command === 'help') {
                await conn.sendMessage(from, { text: `*📋 CYPHER XD DM Commands*\n\n🏓 .ping — Check if bot is alive\n🕐 .time — Get current time\n🔄 .reverse [text] — Reverse your text\n💬 .quote — Get a random quote\n📝 .bio — See your WhatsApp bio\n🖼️ .getpp — See your profile picture\n🎭 .sticker — Convert image to sticker\n🖼️ .toimage — Convert sticker to image\n👑 .owner — Bot owner info\n⏱️ .runtime — How long bot has been running` });
            }
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
