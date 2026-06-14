const fs = require("fs");

const BOT_NAME = "Lady Liya";
const DEFAULT_PREFIX = ".";

// ── In-memory store for anti-delete / anti-edit (resets on restart) ──
const messageStore = new Map();
const MAX_STORE_SIZE = 2000;

function storeMessage(m) {
    if (!m.id) return;
    messageStore.set(m.id, {
        from: m.from,
        sender: m.sender,
        body: m.body,
        isGroup: m.isGroup,
        timestamp: Date.now()
    });

    if (messageStore.size > MAX_STORE_SIZE) {
        const firstKey = messageStore.keys().next().value;
        messageStore.delete(firstKey);
    }
}

// ════════════════════════════════════════════════════════
// PER-SESSION SETTINGS (Redis-backed, keyed by phoneNumber)
// Stored under config:<phoneNumber> as a hash:
//   prefix   -> string
//   sudo     -> JSON array of JIDs
// ════════════════════════════════════════════════════════
async function getConfig(redisClient, phoneNumber) {
    try {
        const data = await redisClient.hGetAll(`config:${phoneNumber}`);
        return {
            prefix: data.prefix || DEFAULT_PREFIX,
            sudo: data.sudo ? JSON.parse(data.sudo) : []
        };
    } catch {
        return { prefix: DEFAULT_PREFIX, sudo: [] };
    }
}

async function setPrefix(redisClient, phoneNumber, newPrefix) {
    await redisClient.hSet(`config:${phoneNumber}`, 'prefix', newPrefix);
}

async function addSudo(redisClient, phoneNumber, jid) {
    const config = await getConfig(redisClient, phoneNumber);
    if (!config.sudo.includes(jid)) {
        config.sudo.push(jid);
        await redisClient.hSet(`config:${phoneNumber}`, 'sudo', JSON.stringify(config.sudo));
    }
    return config.sudo;
}

async function removeSudo(redisClient, phoneNumber, jid) {
    const config = await getConfig(redisClient, phoneNumber);
    config.sudo = config.sudo.filter(j => j !== jid);
    await redisClient.hSet(`config:${phoneNumber}`, 'sudo', JSON.stringify(config.sudo));
    return config.sudo;
}

// ── Helper: normalize a JID down to its bare phone number ──
// Handles formats like:
//   2347041560392@s.whatsapp.net
//   2347041560392:43@s.whatsapp.net  (device-suffixed, common for own number)
//   2347041560392@lid                (linked-device ID format)
function normalizeJid(jid) {
    if (!jid) return '';
    let num = jid.split('@')[0];
    num = num.split(':')[0]; // strip device suffix
    return num;
}

// ── Helper: check if sender is the bot owner (the person who paired this session) ──
function isSessionOwner(m, conn, phoneNumber) {
    if (!phoneNumber) return false;

    const senderNum = normalizeJid(m.sender);
    if (senderNum === phoneNumber) return true;

    // Also check against the bot's own JID (covers cases where the
    // paired number messages itself, e.g. via linked devices / LID)
    const botNum = normalizeJid(conn?.user?.id);
    if (senderNum === botNum) return true;

    return false;
}

// ── Helper: check if sender is a sudo user ──
function isSudo(m, sudoList) {
    const senderNum = normalizeJid(m.sender);
    return sudoList.some(jid => normalizeJid(jid) === senderNum);
}

// ── Helper: check if sender is group admin ──
async function isGroupAdmin(conn, groupId, userJid) {
    try {
        const meta = await conn.groupMetadata(groupId);
        const userNum = normalizeJid(userJid);
        const participant = meta.participants.find(p => normalizeJid(p.id) === userNum);
        return participant?.admin === 'admin' || participant?.admin === 'superadmin';
    } catch {
        return false;
    }
}

// ── Helper: check if bot is group admin ──
async function isBotAdmin(conn, groupId) {
    try {
        const meta = await conn.groupMetadata(groupId);
        const botNum = normalizeJid(conn.user.id);
        const participant = meta.participants.find(p => normalizeJid(p.id) === botNum);
        return participant?.admin === 'admin' || participant?.admin === 'superadmin';
    } catch {
        return false;
    }
}

module.exports = async (conn, m, chatUpdate, ctx = {}) => {
    try {
        const { phoneNumber, redisClient } = ctx;
        const body = m.body || "";

        // ── Always store messages for anti-delete / anti-edit ──
        if (m.body) storeMessage(m);

        // ── AUTO READ ──
        if (process.env.AUTO_READ === 'true') {
            try { await conn.readMessages([m.key]); } catch {}
        }

        // ── AUTO TYPING ──
        if (process.env.AUTO_TYPING === 'true') {
            try {
                await conn.sendPresenceUpdate('composing', m.from);
                setTimeout(() => {
                    conn.sendPresenceUpdate('paused', m.from).catch(() => {});
                }, 1500);
            } catch {}
        }

        // ── Load per-session config (prefix + sudo list) ──
        const config = redisClient && phoneNumber
            ? await getConfig(redisClient, phoneNumber)
            : { prefix: DEFAULT_PREFIX, sudo: [] };

        const prefix = config.prefix || DEFAULT_PREFIX;

        if (!body.startsWith(prefix)) return;

        const args = body.slice(prefix.length).trim().split(/ +/);
        const command = args.shift().toLowerCase();
        const text = args.join(" ");

        console.log("Command:", command);

        const isGroup = m.isGroup;

        // ── Access checks ──
        const senderIsOwner = phoneNumber ? isSessionOwner(m, conn, phoneNumber) : false;
        const senderIsSudo = isSudo(m, config.sudo);
        const senderHasAccess = senderIsOwner || senderIsSudo;

        switch (command) {

            // ════════════════════════════════════════════
            // GENERAL COMMANDS
            // ════════════════════════════════════════════
            case "ping": {
                const start = Date.now();
                const sent = await conn.sendMessage(m.from, { text: "🏓 Pinging..." }, { quoted: m });
                const latency = Date.now() - start;
                await conn.sendMessage(m.from, {
                    text: `🏓 Pong! Response time: ${latency}ms`,
                    edit: sent.key
                });
                break;
            }

            case "runtime":
            case "uptime": {
                const uptimeSec = Math.floor(process.uptime());
                const days = Math.floor(uptimeSec / 86400);
                const hours = Math.floor((uptimeSec % 86400) / 3600);
                const mins = Math.floor((uptimeSec % 3600) / 60);
                const secs = uptimeSec % 60;

                let runtimeStr = '';
                if (days > 0) runtimeStr += `${days}d `;
                if (hours > 0) runtimeStr += `${hours}h `;
                if (mins > 0) runtimeStr += `${mins}m `;
                runtimeStr += `${secs}s`;

                await conn.sendMessage(m.from, {
                    text: `⏱️ *Runtime*\n\nBot has been running for: ${runtimeStr.trim()}`
                }, { quoted: m });
                break;
            }

            case "status":
            case "sysinfo": {
                const uptimeSec = Math.floor(process.uptime());
                const days = Math.floor(uptimeSec / 86400);
                const hours = Math.floor((uptimeSec % 86400) / 3600);
                const mins = Math.floor((uptimeSec % 3600) / 60);
                const secs = uptimeSec % 60;

                let runtimeStr = '';
                if (days > 0) runtimeStr += `${days}d `;
                if (hours > 0) runtimeStr += `${hours}h `;
                if (mins > 0) runtimeStr += `${mins}m `;
                runtimeStr += `${secs}s`;

                const mem = process.memoryUsage();
                const usedMB = (mem.rss / 1024 / 1024).toFixed(1);
                const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(1);

                const statusText = `
📊 *${BOT_NAME} — Status*

⏱️ Runtime: ${runtimeStr.trim()}
💾 Memory used: ${usedMB} MB
🧠 Heap used: ${heapMB} MB
🟢 Connection: Online
🔧 Prefix: ${prefix}
👑 Owner: wa.me/${phoneNumber}
👥 Sudo users: ${config.sudo.length}
🛡️ Anti-delete: ${global.antiDeleteEnabled ? 'ON' : 'OFF'}
🛡️ Anti-edit: ${global.antiEditEnabled ? 'ON' : 'OFF'}
🟢 Node.js: ${process.version}
                `.trim();

                await conn.sendMessage(m.from, { text: statusText }, { quoted: m });
                break;
            }

            case "hi":
            case "hello":
                await conn.sendMessage(m.from, {
                    text: `Hello @${m.sender.split('@')[0]} 👋`,
                    mentions: [m.sender]
                }, { quoted: m });
                break;

            case "owner":
                await conn.sendMessage(m.from, {
                    text: `👑 *Bot Owner*\n\nThis bot is linked to: wa.me/${phoneNumber}\n\nDev contact:\nTelegram: t.me/KallmeTrust\nChannel: https://t.me/TrustBitOfficial`
                }, { quoted: m });
                break;

            case "echo":
                await conn.sendMessage(m.from, {
                    text: text || "Nothing to echo."
                }, { quoted: m });
                break;

            case "menu":
            case "help": {
                const menuText = `
╭───────────────────╮
│   *${BOT_NAME.toUpperCase()} MENU*
╰───────────────────╯
Prefix: *${prefix}*

*GENERAL*
• ${prefix}ping
• ${prefix}runtime
• ${prefix}status
• ${prefix}menu
• ${prefix}owner
• ${prefix}echo <text>

*GROUP COMMANDS*
• ${prefix}tagall <text>
• ${prefix}kick @user (reply)
• ${prefix}add 234xxxxxxxxxx
• ${prefix}promote @user
• ${prefix}demote @user
• ${prefix}mute
• ${prefix}unmute
• ${prefix}groupinfo
• ${prefix}link

*OWNER / SUDO COMMANDS*
• ${prefix}block @user
• ${prefix}unblock @user
• ${prefix}setpp (reply to image)
• ${prefix}restart
• ${prefix}setprefix <new prefix>

*SUDO MANAGEMENT (Owner only)*
• ${prefix}addsudo @user
• ${prefix}delsudo @user
• ${prefix}listsudo

*PROTECTION*
• ${prefix}antidelete on/off
• ${prefix}antiedit on/off
                `.trim();

                await conn.sendMessage(m.from, { text: menuText }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // GROUP COMMANDS
            // ════════════════════════════════════════════
            case "tagall": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ This command only works in groups." }, { quoted: m });
                    break;
                }

                const meta = await conn.groupMetadata(m.from);
                const participants = meta.participants.map(p => p.id);

                let tagText = text ? `${text}\n\n` : '';
                tagText += participants.map(p => `@${p.split('@')[0]}`).join(' ');

                await conn.sendMessage(m.from, {
                    text: tagText,
                    mentions: participants
                }, { quoted: m });
                break;
            }

            case "kick": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ This command only works in groups." }, { quoted: m });
                    break;
                }

                const senderAdmin = await isGroupAdmin(conn, m.from, m.sender);
                if (!senderAdmin && !senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Only admins can use this command." }, { quoted: m });
                    break;
                }

                const botAdmin = await isBotAdmin(conn, m.from);
                if (!botAdmin) {
                    await conn.sendMessage(m.from, { text: "❌ I need to be an admin to do that." }, { quoted: m });
                    break;
                }

                const target = m.quoted?.sender || m.mentionedJid?.[0];
                if (!target) {
                    await conn.sendMessage(m.from, { text: "❌ Reply to or mention the user you want to kick." }, { quoted: m });
                    break;
                }

                await conn.groupParticipantsUpdate(m.from, [target], 'remove');
                await conn.sendMessage(m.from, {
                    text: `✅ Removed @${target.split('@')[0]}`,
                    mentions: [target]
                }, { quoted: m });
                break;
            }

            case "add": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ This command only works in groups." }, { quoted: m });
                    break;
                }

                const senderAdmin = await isGroupAdmin(conn, m.from, m.sender);
                if (!senderAdmin && !senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Only admins can use this command." }, { quoted: m });
                    break;
                }

                const botAdmin = await isBotAdmin(conn, m.from);
                if (!botAdmin) {
                    await conn.sendMessage(m.from, { text: "❌ I need to be an admin to do that." }, { quoted: m });
                    break;
                }

                const number = text.replace(/[^0-9]/g, '');
                if (!number) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}add 2348012345678` }, { quoted: m });
                    break;
                }

                const jid = `${number}@s.whatsapp.net`;
                await conn.groupParticipantsUpdate(m.from, [jid], 'add');
                await conn.sendMessage(m.from, { text: `✅ Added ${number}` }, { quoted: m });
                break;
            }

            case "promote": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ This command only works in groups." }, { quoted: m });
                    break;
                }

                const senderAdmin = await isGroupAdmin(conn, m.from, m.sender);
                if (!senderAdmin && !senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Only admins can use this command." }, { quoted: m });
                    break;
                }

                const botAdmin = await isBotAdmin(conn, m.from);
                if (!botAdmin) {
                    await conn.sendMessage(m.from, { text: "❌ I need to be an admin to do that." }, { quoted: m });
                    break;
                }

                const target = m.quoted?.sender || m.mentionedJid?.[0];
                if (!target) {
                    await conn.sendMessage(m.from, { text: "❌ Reply to or mention the user to promote." }, { quoted: m });
                    break;
                }

                await conn.groupParticipantsUpdate(m.from, [target], 'promote');
                await conn.sendMessage(m.from, {
                    text: `✅ Promoted @${target.split('@')[0]} to admin`,
                    mentions: [target]
                }, { quoted: m });
                break;
            }

            case "demote": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ This command only works in groups." }, { quoted: m });
                    break;
                }

                const senderAdmin = await isGroupAdmin(conn, m.from, m.sender);
                if (!senderAdmin && !senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Only admins can use this command." }, { quoted: m });
                    break;
                }

                const botAdmin = await isBotAdmin(conn, m.from);
                if (!botAdmin) {
                    await conn.sendMessage(m.from, { text: "❌ I need to be an admin to do that." }, { quoted: m });
                    break;
                }

                const target = m.quoted?.sender || m.mentionedJid?.[0];
                if (!target) {
                    await conn.sendMessage(m.from, { text: "❌ Reply to or mention the user to demote." }, { quoted: m });
                    break;
                }

                await conn.groupParticipantsUpdate(m.from, [target], 'demote');
                await conn.sendMessage(m.from, {
                    text: `✅ Demoted @${target.split('@')[0]}`,
                    mentions: [target]
                }, { quoted: m });
                break;
            }

            case "mute": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ This command only works in groups." }, { quoted: m });
                    break;
                }

                const senderAdmin = await isGroupAdmin(conn, m.from, m.sender);
                if (!senderAdmin && !senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Only admins can use this command." }, { quoted: m });
                    break;
                }

                const botAdmin = await isBotAdmin(conn, m.from);
                if (!botAdmin) {
                    await conn.sendMessage(m.from, { text: "❌ I need to be an admin to do that." }, { quoted: m });
                    break;
                }

                await conn.groupSettingUpdate(m.from, 'announcement');
                await conn.sendMessage(m.from, { text: "🔇 Group muted — only admins can send messages." }, { quoted: m });
                break;
            }

            case "unmute": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ This command only works in groups." }, { quoted: m });
                    break;
                }

                const senderAdmin = await isGroupAdmin(conn, m.from, m.sender);
                if (!senderAdmin && !senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Only admins can use this command." }, { quoted: m });
                    break;
                }

                const botAdmin = await isBotAdmin(conn, m.from);
                if (!botAdmin) {
                    await conn.sendMessage(m.from, { text: "❌ I need to be an admin to do that." }, { quoted: m });
                    break;
                }

                await conn.groupSettingUpdate(m.from, 'not_announcement');
                await conn.sendMessage(m.from, { text: "🔊 Group unmuted — everyone can send messages." }, { quoted: m });
                break;
            }

            case "groupinfo": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ This command only works in groups." }, { quoted: m });
                    break;
                }

                const meta = await conn.groupMetadata(m.from);
                const admins = meta.participants.filter(p => p.admin).length;

                await conn.sendMessage(m.from, {
                    text: `*${meta.subject}*\n\n👥 Members: ${meta.participants.length}\n👑 Admins: ${admins}\n📝 Description: ${meta.desc || 'None'}\n🆔 ID: ${meta.id}`
                }, { quoted: m });
                break;
            }

            case "link": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ This command only works in groups." }, { quoted: m });
                    break;
                }

                try {
                    const code = await conn.groupInviteCode(m.from);
                    await conn.sendMessage(m.from, {
                        text: `🔗 Group invite link:\nhttps://chat.whatsapp.com/${code}`
                    }, { quoted: m });
                } catch {
                    await conn.sendMessage(m.from, { text: "❌ I need to be an admin to get the invite link." }, { quoted: m });
                }
                break;
            }

            // ════════════════════════════════════════════
            // OWNER / SUDO COMMANDS
            // (The "owner" here = whoever paired this bot session)
            // ════════════════════════════════════════════
            case "block": {
                if (!senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Owner/Sudo only command." }, { quoted: m });
                    break;
                }

                const target = m.quoted?.sender || m.mentionedJid?.[0];
                if (!target) {
                    await conn.sendMessage(m.from, { text: "❌ Reply to or mention the user to block." }, { quoted: m });
                    break;
                }

                await conn.updateBlockStatus(target, 'block');
                await conn.sendMessage(m.from, { text: `✅ Blocked @${target.split('@')[0]}`, mentions: [target] }, { quoted: m });
                break;
            }

            case "unblock": {
                if (!senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Owner/Sudo only command." }, { quoted: m });
                    break;
                }

                const target = m.quoted?.sender || m.mentionedJid?.[0];
                if (!target) {
                    await conn.sendMessage(m.from, { text: "❌ Reply to or mention the user to unblock." }, { quoted: m });
                    break;
                }

                await conn.updateBlockStatus(target, 'unblock');
                await conn.sendMessage(m.from, { text: `✅ Unblocked @${target.split('@')[0]}`, mentions: [target] }, { quoted: m });
                break;
            }

            case "setpp": {
                if (!senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Owner/Sudo only command." }, { quoted: m });
                    break;
                }

                if (!m.quoted || m.quoted.mtype !== 'imageMessage') {
                    await conn.sendMessage(m.from, { text: `❌ Reply to an image with ${prefix}setpp` }, { quoted: m });
                    break;
                }

                try {
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const buffer = await downloadMediaMessage(
                        { message: { imageMessage: m.quoted } },
                        'buffer',
                        {}
                    );
                    await conn.updateProfilePicture(conn.user.id, buffer);
                    await conn.sendMessage(m.from, { text: "✅ Profile picture updated." }, { quoted: m });
                } catch (err) {
                    console.error(err);
                    await conn.sendMessage(m.from, { text: "❌ Failed to update profile picture." }, { quoted: m });
                }
                break;
            }

            case "restart": {
                if (!senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Owner/Sudo only command." }, { quoted: m });
                    break;
                }

                await conn.sendMessage(m.from, { text: "♻️ Restarting connection..." }, { quoted: m });
                setTimeout(() => {
                    try { conn.end(); } catch {}
                }, 1000);
                break;
            }

            // ════════════════════════════════════════════
            // PREFIX MANAGEMENT (Owner only)
            // ════════════════════════════════════════════
            case "setprefix": {
                if (!senderIsOwner) {
                    await conn.sendMessage(m.from, { text: "❌ Owner only command." }, { quoted: m });
                    break;
                }

                if (!text || text.length > 5) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}setprefix <new prefix>\n(Max 5 characters)` }, { quoted: m });
                    break;
                }

                if (!redisClient || !phoneNumber) {
                    await conn.sendMessage(m.from, { text: "❌ Could not save prefix — storage unavailable." }, { quoted: m });
                    break;
                }

                await setPrefix(redisClient, phoneNumber, text);
                await conn.sendMessage(m.from, { text: `✅ Prefix changed to: ${text}` }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // SUDO MANAGEMENT (Owner only)
            // ════════════════════════════════════════════
            case "addsudo": {
                if (!senderIsOwner) {
                    await conn.sendMessage(m.from, { text: "❌ Owner only command." }, { quoted: m });
                    break;
                }

                const target = m.quoted?.sender || m.mentionedJid?.[0];
                if (!target) {
                    await conn.sendMessage(m.from, { text: `❌ Reply to or mention the user to add as sudo.\nUsage: ${prefix}addsudo @user` }, { quoted: m });
                    break;
                }

                if (!redisClient || !phoneNumber) {
                    await conn.sendMessage(m.from, { text: "❌ Could not save sudo list — storage unavailable." }, { quoted: m });
                    break;
                }

                const list = await addSudo(redisClient, phoneNumber, target);
                await conn.sendMessage(m.from, {
                    text: `✅ @${target.split('@')[0]} added as sudo.\n\nTotal sudo users: ${list.length}`,
                    mentions: [target]
                }, { quoted: m });
                break;
            }

            case "delsudo": {
                if (!senderIsOwner) {
                    await conn.sendMessage(m.from, { text: "❌ Owner only command." }, { quoted: m });
                    break;
                }

                const target = m.quoted?.sender || m.mentionedJid?.[0];
                if (!target) {
                    await conn.sendMessage(m.from, { text: `❌ Reply to or mention the user to remove from sudo.\nUsage: ${prefix}delsudo @user` }, { quoted: m });
                    break;
                }

                if (!redisClient || !phoneNumber) {
                    await conn.sendMessage(m.from, { text: "❌ Could not update sudo list — storage unavailable." }, { quoted: m });
                    break;
                }

                const list = await removeSudo(redisClient, phoneNumber, target);
                await conn.sendMessage(m.from, {
                    text: `✅ @${target.split('@')[0]} removed from sudo.\n\nTotal sudo users: ${list.length}`,
                    mentions: [target]
                }, { quoted: m });
                break;
            }

            case "listsudo": {
                if (!senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Owner/Sudo only command." }, { quoted: m });
                    break;
                }

                if (!config.sudo.length) {
                    await conn.sendMessage(m.from, { text: "📋 No sudo users yet." }, { quoted: m });
                    break;
                }

                const listText = config.sudo.map((jid, i) => `${i + 1}. @${jid.split('@')[0]}`).join('\n');
                await conn.sendMessage(m.from, {
                    text: `📋 *Sudo Users*\n\n${listText}`,
                    mentions: config.sudo
                }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // PROTECTION COMMANDS (in-memory)
            // ════════════════════════════════════════════
            case "antidelete": {
                if (!senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Owner/Sudo only command." }, { quoted: m });
                    break;
                }

                const state = args[0]?.toLowerCase();
                if (state !== 'on' && state !== 'off') {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}antidelete on/off` }, { quoted: m });
                    break;
                }

                global.antiDeleteEnabled = (state === 'on');
                await conn.sendMessage(m.from, {
                    text: `🛡️ Anti-delete ${state === 'on' ? 'enabled ✅' : 'disabled ❌'}`
                }, { quoted: m });
                break;
            }

            case "antiedit": {
                if (!senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Owner/Sudo only command." }, { quoted: m });
                    break;
                }

                const state = args[0]?.toLowerCase();
                if (state !== 'on' && state !== 'off') {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}antiedit on/off` }, { quoted: m });
                    break;
                }

                global.antiEditEnabled = (state === 'on');
                await conn.sendMessage(m.from, {
                    text: `🛡️ Anti-edit ${state === 'on' ? 'enabled ✅' : 'disabled ❌'}`
                }, { quoted: m });
                break;
            }

            default:
                // Ignore unknown commands
                break;
        }
    } catch (err) {
        console.log("case.js error:", err);
    }
};

// ── Export helpers ──
module.exports.messageStore = messageStore;
module.exports.storeMessage = storeMessage;
module.exports.getConfig = getConfig;
module.exports.setPrefix = setPrefix;
module.exports.addSudo = addSudo;
module.exports.removeSudo = removeSudo;
                                           
