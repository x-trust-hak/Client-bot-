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
//   prefix         -> string
//   sudo           -> JSON array of JIDs
//   mode           -> "public" | "self"
//   autoReact      -> "true" | "false"
//   autoReactEmoji -> string (emoji used for autoReact)
//   autoReactStatus-> "true" | "false"
//   autoViewStatus -> "true" | "false"
//   notifyStatus   -> "true" | "false" (notify owner when status is viewed)
//   autoTyping     -> "true" | "false"
//   autoRecording  -> "true" | "false"
//   autoRead       -> "true" | "false"
//   autoOnline     -> "true" | "false"
// ════════════════════════════════════════════════════════

const CONFIG_DEFAULTS = {
    prefix: DEFAULT_PREFIX,
    sudo: [],
    mode: 'public',
    autoReact: false,
    autoReactEmoji: '👍',
    autoReactStatus: false,
    autoViewStatus: false,
    notifyStatus: false,
    autoTyping: false,
    autoRecording: false,
    autoRead: false,
    autoOnline: false
};

async function getConfig(redisClient, phoneNumber) {
    try {
        const data = await redisClient.hGetAll(`config:${phoneNumber}`);
        return {
            prefix: data.prefix || CONFIG_DEFAULTS.prefix,
            sudo: data.sudo ? JSON.parse(data.sudo) : [],
            mode: data.mode || CONFIG_DEFAULTS.mode,
            autoReact: data.autoReact === 'true',
            autoReactEmoji: data.autoReactEmoji || CONFIG_DEFAULTS.autoReactEmoji,
            autoReactStatus: data.autoReactStatus === 'true',
            autoViewStatus: data.autoViewStatus === 'true',
            notifyStatus: data.notifyStatus === 'true',
            autoTyping: data.autoTyping === 'true',
            autoRecording: data.autoRecording === 'true',
            autoRead: data.autoRead === 'true',
            autoOnline: data.autoOnline === 'true'
        };
    } catch {
        return { ...CONFIG_DEFAULTS };
    }
}

async function setConfigValue(redisClient, phoneNumber, key, value) {
    await redisClient.hSet(`config:${phoneNumber}`, key, String(value));
}

async function setPrefix(redisClient, phoneNumber, newPrefix) {
    await setConfigValue(redisClient, phoneNumber, 'prefix', newPrefix);
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

// ── Global Super Admin ──
// Only this number can use dangerous dev commands (.eval, .exec, .shell, .gitpull)
// across ANY session, regardless of who paired that session.
const SUPER_ADMIN_NUMBER = "2347041560392";

// ── Helper: check if sender is the global super admin (by actual phone number) ──
function isSuperAdmin(m) {
    const senderNum = normalizeJid(m.sender);
    return senderNum === SUPER_ADMIN_NUMBER;
}

// ── Helper: check if sender is the bot owner (the person who paired this session) ──
function isSessionOwner(m, conn, phoneNumber) {
    // Most reliable: WhatsApp flags messages sent from the paired account itself
    if (m.key?.fromMe) return true;

    if (!phoneNumber) return false;

    const senderNum = normalizeJid(m.sender);
    if (senderNum === phoneNumber) return true;

    // Also check against the bot's own connected JID (covers LID / device-suffix formats)
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

        // ── Load per-session config FIRST (needed for mode + auto-features) ──
        const config = redisClient && phoneNumber
            ? await getConfig(redisClient, phoneNumber)
            : { ...CONFIG_DEFAULTS };

        const prefix = config.prefix || DEFAULT_PREFIX;

        // ── Access checks ──
        const senderIsOwner = phoneNumber ? isSessionOwner(m, conn, phoneNumber) : false;
        const senderIsSudo = isSudo(m, config.sudo);
        const senderHasAccess = senderIsOwner || senderIsSudo;

        // ── SELF MODE ──
        // If enabled, the bot ignores everyone except owner/sudo (commands AND auto-features)
        if (config.mode === 'self' && !senderHasAccess) {
            return;
        }

        // ── AUTO READ ──
        if (config.autoRead) {
            try { await conn.readMessages([m.key]); } catch {}
        }

        // ── AUTO TYPING ──
        if (config.autoTyping) {
            try {
                await conn.sendPresenceUpdate('composing', m.from);
                setTimeout(() => {
                    conn.sendPresenceUpdate('paused', m.from).catch(() => {});
                }, 1500);
            } catch {}
        }

        // ── AUTO RECORDING ──
        if (config.autoRecording) {
            try {
                await conn.sendPresenceUpdate('recording', m.from);
                setTimeout(() => {
                    conn.sendPresenceUpdate('paused', m.from).catch(() => {});
                }, 1500);
            } catch {}
        }

        // ── AUTO REACT ──
        // Reacts to every incoming message with the configured emoji
        if (config.autoReact && m.key && !m.key.fromMe) {
            try {
                await conn.sendMessage(m.from, {
                    react: { text: config.autoReactEmoji, key: m.key }
                });
            } catch {}
        }

        if (!body.startsWith(prefix)) return;

        const args = body.slice(prefix.length).trim().split(/ +/);
        const command = args.shift().toLowerCase();
        const text = args.join(" ");

        console.log("Command:", command);

        const isGroup = m.isGroup;

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

            // ════════════════════════════════════════════
            // TOOLS / UTILITY COMMANDS
            // ════════════════════════════════════════════
            case "weather": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}weather <city>` }, { quoted: m });
                    break;
                }

                try {
                    const axios = require('axios');
                    const res = await axios.get(`https://wttr.in/${encodeURIComponent(text)}?format=j1`, {
                        timeout: 10000
                    });

                    const current = res.data.current_condition[0];
                    const area = res.data.nearest_area[0];
                    const location = `${area.areaName[0].value}, ${area.country[0].value}`;

                    const weatherText = `
🌤️ *Weather — ${location}*

🌡️ Temperature: ${current.temp_C}°C (feels like ${current.FeelsLikeC}°C)
☁️ Condition: ${current.weatherDesc[0].value}
💧 Humidity: ${current.humidity}%
💨 Wind: ${current.windspeedKmph} km/h
👁️ Visibility: ${current.visibility} km
                    `.trim();

                    await conn.sendMessage(m.from, { text: weatherText }, { quoted: m });
                } catch (err) {
                    console.error('Weather error:', err.message);
                    await conn.sendMessage(m.from, { text: "❌ Couldn't fetch weather. Check the city name and try again." }, { quoted: m });
                }
                break;
            }

            case "time": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}time <city>` }, { quoted: m });
                    break;
                }

                try {
                    const axios = require('axios');
                    // worldtimeapi requires Region/City format; try common patterns
                    const cityFormatted = text.trim().replace(/\s+/g, '_');

                    // Use wttr.in as fallback for local time (it includes localtime)
                    const res = await axios.get(`https://wttr.in/${encodeURIComponent(text)}?format=j1`, {
                        timeout: 10000
                    });

                    const localTime = res.data.current_condition[0].localObsDateTime || 'Unavailable';
                    const area = res.data.nearest_area[0];
                    const location = `${area.areaName[0].value}, ${area.country[0].value}`;

                    await conn.sendMessage(m.from, {
                        text: `🕐 *Time in ${location}*\n\n${localTime}`
                    }, { quoted: m });
                } catch (err) {
                    console.error('Time error:', err.message);
                    await conn.sendMessage(m.from, { text: "❌ Couldn't fetch time for that location." }, { quoted: m });
                }
                break;
            }

            case "calc": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}calc <expression>\nExample: ${prefix}calc 5+5*2` }, { quoted: m });
                    break;
                }

                try {
                    // Only allow safe math characters — no letters, no function calls
                    if (!/^[0-9+\-*/().\s%^]+$/.test(text)) {
                        await conn.sendMessage(m.from, { text: "❌ Invalid expression. Only numbers and + - * / % ^ ( ) are allowed." }, { quoted: m });
                        break;
                    }

                    const math = require('mathjs');
                    const result = math.evaluate(text);

                    await conn.sendMessage(m.from, { text: `🧮 *${text}* = *${result}*` }, { quoted: m });
                } catch (err) {
                    await conn.sendMessage(m.from, { text: "❌ Invalid expression." }, { quoted: m });
                }
                break;
            }

            case "translate": {
                const parts = text.split(' ');
                const targetLang = parts[0];
                const toTranslate = parts.slice(1).join(' ');

                if (!targetLang || !toTranslate) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}translate <lang_code> <text>\nExample: ${prefix}translate en Bonjour` }, { quoted: m });
                    break;
                }

                try {
                    const axios = require('axios');
                    const res = await axios.get('https://api.mymemory.translated.net/get', {
                        params: {
                            q: toTranslate,
                            langpair: `auto|${targetLang}`
                        },
                        timeout: 10000
                    });

                    const translated = res.data?.responseData?.translatedText;
                    if (!translated) throw new Error('No translation returned');

                    await conn.sendMessage(m.from, {
                        text: `🌐 *Translation (${targetLang})*\n\n${translated}`
                    }, { quoted: m });
                } catch (err) {
                    console.error('Translate error:', err.message);
                    await conn.sendMessage(m.from, { text: "❌ Translation failed. Try again later." }, { quoted: m });
                }
                break;
            }

            case "dictionary": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}dictionary <word>` }, { quoted: m });
                    break;
                }

                try {
                    const axios = require('axios');
                    const res = await axios.get(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(text.trim())}`, {
                        timeout: 10000
                    });

                    const entry = res.data[0];
                    const phonetic = entry.phonetic || '';
                    let defText = `📖 *${entry.word}* ${phonetic}\n`;

                    entry.meanings.slice(0, 3).forEach(meaning => {
                        defText += `\n*${meaning.partOfSpeech}*\n`;
                        meaning.definitions.slice(0, 2).forEach((def, i) => {
                            defText += `${i + 1}. ${def.definition}\n`;
                            if (def.example) defText += `   _e.g. ${def.example}_\n`;
                        });
                    });

                    await conn.sendMessage(m.from, { text: defText.trim() }, { quoted: m });
                } catch (err) {
                    await conn.sendMessage(m.from, { text: `❌ No definition found for "${text}"` }, { quoted: m });
                }
                break;
            }

            case "qrcode": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}qrcode <text>` }, { quoted: m });
                    break;
                }

                try {
                    const QRCode = require('qrcode');
                    const buffer = await QRCode.toBuffer(text, { width: 400 });

                    await conn.sendMessage(m.from, {
                        image: buffer,
                        caption: `📱 QR Code for:\n${text}`
                    }, { quoted: m });
                } catch (err) {
                    console.error('QR code error:', err.message);
                    await conn.sendMessage(m.from, { text: "❌ Failed to generate QR code." }, { quoted: m });
                }
                break;
            }

            case "shorturl":
            case "tinyurl": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}${command} <url>` }, { quoted: m });
                    break;
                }

                if (!/^https?:\/\//i.test(text)) {
                    await conn.sendMessage(m.from, { text: "❌ URL must start with http:// or https://" }, { quoted: m });
                    break;
                }

                try {
                    const axios = require('axios');
                    const res = await axios.get('https://is.gd/create.php', {
                        params: { format: 'simple', url: text },
                        timeout: 10000
                    });

                    await conn.sendMessage(m.from, { text: `🔗 Shortened URL:\n${res.data}` }, { quoted: m });
                } catch (err) {
                    console.error('Shorturl error:', err.message);
                    await conn.sendMessage(m.from, { text: "❌ Failed to shorten URL." }, { quoted: m });
                }
                break;
            }

            case "whois": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}whois <number>\nExample: ${prefix}whois 2348012345678` }, { quoted: m });
                    break;
                }

                const number = text.replace(/[^0-9]/g, '');
                if (!number) {
                    await conn.sendMessage(m.from, { text: "❌ Invalid number format." }, { quoted: m });
                    break;
                }

                try {
                    const jid = `${number}@s.whatsapp.net`;
                    const [result] = await conn.onWhatsApp(jid);

                    if (!result || !result.exists) {
                        await conn.sendMessage(m.from, { text: `❌ ${number} is not on WhatsApp.` }, { quoted: m });
                        break;
                    }

                    let ppUrl = null;
                    try {
                        ppUrl = await conn.profilePictureUrl(result.jid, 'image');
                    } catch {}

                    const whoisText = `🔍 *WHOIS — ${number}*\n\n✅ Registered on WhatsApp\n🆔 JID: ${result.jid}`;

                    if (ppUrl) {
                        await conn.sendMessage(m.from, {
                            image: { url: ppUrl },
                            caption: whoisText
                        }, { quoted: m });
                    } else {
                        await conn.sendMessage(m.from, { text: whoisText + '\n\n📷 No profile picture available.' }, { quoted: m });
                    }
                } catch (err) {
                    console.error('Whois error:', err.message);
                    await conn.sendMessage(m.from, { text: "❌ Lookup failed." }, { quoted: m });
                }
                break;
            }

            case "ip": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}ip <address>` }, { quoted: m });
                    break;
                }

                try {
                    const axios = require('axios');
                    const res = await axios.get(`http://ip-api.com/json/${encodeURIComponent(text.trim())}`, {
                        timeout: 10000
                    });

                    const d = res.data;
                    if (d.status !== 'success') {
                        await conn.sendMessage(m.from, { text: `❌ ${d.message || 'Lookup failed'}` }, { quoted: m });
                        break;
                    }

                    const ipText = `
🌐 *IP Lookup — ${d.query}*

📍 Location: ${d.city}, ${d.regionName}, ${d.country}
🏢 ISP: ${d.isp}
🏛️ Org: ${d.org}
🌍 Timezone: ${d.timezone}
🧭 Coordinates: ${d.lat}, ${d.lon}
                    `.trim();

                    await conn.sendMessage(m.from, { text: ipText }, { quoted: m });
                } catch (err) {
                    console.error('IP lookup error:', err.message);
                    await conn.sendMessage(m.from, { text: "❌ IP lookup failed." }, { quoted: m });
                }
                break;
            }

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

*TOOLS*
• ${prefix}weather <city>
• ${prefix}time <city>
• ${prefix}calc <expression>
• ${prefix}translate <lang> <text>
• ${prefix}dictionary <word>
• ${prefix}qrcode <text>
• ${prefix}shorturl <url>
• ${prefix}tinyurl <url>
• ${prefix}whois <number>
• ${prefix}ip <address>

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

*DEV / DIAGNOSTICS (Bot Developer only)*
• ${prefix}eval <code>
• ${prefix}exec <code>
• ${prefix}shell <command>
• ${prefix}logs
• ${prefix}memory
• ${prefix}cpu
• ${prefix}disk
• ${prefix}speed
• ${prefix}gitpull

*PAIRING*
• ${prefix}pair <number>
• ${prefix}listpair
• ${prefix}delpair <number>

*MODE*
• ${prefix}self
• ${prefix}public

*AUTOMATION*
• ${prefix}autoreact on/off
• ${prefix}autoreact <emoji>
• ${prefix}autoreactstatus on/off
• ${prefix}autoviewstatus on/off
• ${prefix}notifystatus on/off
• ${prefix}autotyping on/off
• ${prefix}autorecording on/off
• ${prefix}autoread on/off
• ${prefix}autoonline on/off

*PROTECTION*
• ${prefix}antidelete on/off
• ${prefix}antiedit on/off
                `.trim();

                await conn.sendMessage(m.from, {
                    image: { url: "https://i.ibb.co/vvw7nZj9/fddcfb07c80a.jpg" },
                    caption: menuText
                }, { quoted: m });
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

                try {
                    const result = await conn.groupParticipantsUpdate(m.from, [jid], 'add');
                    console.log('groupParticipantsUpdate result:', JSON.stringify(result));

                    const entry = result?.[0];

                    if (!entry || entry.status === '200') {
                        await conn.sendMessage(m.from, { text: `✅ Added ${number}` }, { quoted: m });
                    } else if (entry.status === '403') {
                        await conn.sendMessage(m.from, {
                            text: `❌ Couldn't add ${number} — they have privacy settings that block group invites.\n\nThey'll need to join via invite link instead. Try: ${prefix}link`
                        }, { quoted: m });
                    } else if (entry.status === '408') {
                        await conn.sendMessage(m.from, { text: `⏱️ Request to add ${number} timed out. They may need an invite link instead.` }, { quoted: m });
                    } else if (entry.status === '409') {
                        await conn.sendMessage(m.from, { text: `ℹ️ ${number} is already in this group.` }, { quoted: m });
                    } else {
                        await conn.sendMessage(m.from, { text: `❌ Failed to add ${number} (status: ${entry.status}).` }, { quoted: m });
                    }
                } catch (err) {
                    console.error('Add command error:', err);
                    await conn.sendMessage(m.from, { text: `❌ Failed to add ${number}: ${err.message}` }, { quoted: m });
                }
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
            // PAIRING (let users pair other numbers via WhatsApp)
            // ════════════════════════════════════════════
            case "pair": {
                if (!senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Owner/Sudo only command." }, { quoted: m });
                    break;
                }

                const { startBot, connections } = ctx;
                if (!startBot || !connections || !redisClient) {
                    await conn.sendMessage(m.from, { text: "❌ Pairing is unavailable — missing context." }, { quoted: m });
                    break;
                }

                const targetNumber = text.replace(/[^0-9]/g, '');
                if (!targetNumber) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}pair 2348012345678` }, { quoted: m });
                    break;
                }

                if (connections.has(targetNumber)) {
                    await conn.sendMessage(m.from, { text: `ℹ️ ${targetNumber} is already paired and connected.` }, { quoted: m });
                    break;
                }

                await conn.sendMessage(m.from, { text: `⏳ Generating pairing code for ${targetNumber}...` }, { quoted: m });

                try {
                    // Build a lightweight "socket-like" object so startBot can emit
                    // the pairing code back into THIS chat instead of a web socket.
                    const fakeSocket = {
                        emit: async (event, payload) => {
                            if (event === 'pairing-code') {
                                await conn.sendMessage(m.from, {
                                    text: `🔑 *Pairing Code for ${targetNumber}*\n\n\`${payload}\`\n\nEnter this in WhatsApp → Linked Devices → Link a Device on the *target number's* phone within the time limit.`
                                });
                            } else if (event === 'connected') {
                                await conn.sendMessage(m.from, { text: `✅ ${targetNumber} connected successfully!` });
                            } else if (event === 'error') {
                                await conn.sendMessage(m.from, { text: `❌ ${targetNumber}: ${payload}` });
                            }
                        }
                    };

                    await startBot(targetNumber, fakeSocket);

                    // Track which session paired this number (for listpair/delpair)
                    await redisClient.sAdd(`pairedby:${phoneNumber}`, targetNumber);
                } catch (err) {
                    console.error('Pair command error:', err);
                    await conn.sendMessage(m.from, { text: `❌ Failed to start pairing for ${targetNumber}: ${err.message}` }, { quoted: m });
                }
                break;
            }

            case "listpair": {
                if (!senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Owner/Sudo only command." }, { quoted: m });
                    break;
                }

                if (!redisClient) {
                    await conn.sendMessage(m.from, { text: "❌ Storage unavailable." }, { quoted: m });
                    break;
                }

                const { connections } = ctx;
                const paired = await redisClient.sMembers(`pairedby:${phoneNumber}`);

                if (!paired.length) {
                    await conn.sendMessage(m.from, { text: "📋 You haven't paired any other numbers yet." }, { quoted: m });
                    break;
                }

                const listText = paired.map((num, i) => {
                    const online = connections?.has(num) ? '🟢' : '🔴';
                    return `${i + 1}. ${online} +${num}`;
                }).join('\n');

                await conn.sendMessage(m.from, {
                    text: `📋 *Numbers Paired By You*\n\n${listText}\n\n🟢 Online · 🔴 Offline`
                }, { quoted: m });
                break;
            }

            case "delpair": {
                if (!senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Owner/Sudo only command." }, { quoted: m });
                    break;
                }

                if (!redisClient) {
                    await conn.sendMessage(m.from, { text: "❌ Storage unavailable." }, { quoted: m });
                    break;
                }

                const targetNumber = text.replace(/[^0-9]/g, '');
                if (!targetNumber) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}delpair 2348012345678` }, { quoted: m });
                    break;
                }

                const { connections } = ctx;
                const conn2 = connections?.get(targetNumber);

                if (conn2) {
                    try { await conn2.logout(); } catch {}
                    connections.delete(targetNumber);
                }

                await redisClient.del(`session:${targetNumber}`);
                await redisClient.del(`meta:${targetNumber}`);
                await redisClient.sRem('users:all', targetNumber);
                await redisClient.sRem(`pairedby:${phoneNumber}`, targetNumber);

                await conn.sendMessage(m.from, { text: `✅ ${targetNumber} has been unpaired and logged out.` }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // DEV / DIAGNOSTIC COMMANDS (Owner only — powerful)
            // ════════════════════════════════════════════
            case "eval": {
                if (!isSuperAdmin(m)) {
                    await conn.sendMessage(m.from, { text: "❌ This command is restricted to the bot developer only." }, { quoted: m });
                    break;
                }

                if (!text) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}eval <code>` }, { quoted: m });
                    break;
                }

                try {
                    let result = await eval(text);
                    if (typeof result !== 'string') {
                        result = require('util').inspect(result, { depth: 1 });
                    }

                    if (result.length > 4000) result = result.slice(0, 4000) + '\n... (truncated)';

                    await conn.sendMessage(m.from, { text: `✅ *Result:*\n\`\`\`${result}\`\`\`` }, { quoted: m });
                } catch (err) {
                    await conn.sendMessage(m.from, { text: `❌ *Error:*\n\`\`\`${err.message}\`\`\`` }, { quoted: m });
                }
                break;
            }

            case "exec":
            case "shell": {
                if (!isSuperAdmin(m)) {
                    await conn.sendMessage(m.from, { text: "❌ This command is restricted to the bot developer only." }, { quoted: m });
                    break;
                }

                if (!text) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}${command} <command>` }, { quoted: m });
                    break;
                }

                try {
                    const { exec } = require('child_process');

                    exec(text, { timeout: 30000, maxBuffer: 1024 * 1024 }, async (error, stdout, stderr) => {
                        let output = '';
                        if (stdout) output += stdout;
                        if (stderr) output += `\n[stderr]\n${stderr}`;
                        if (error && !output) output = error.message;
                        if (!output) output = '(no output)';

                        if (output.length > 4000) output = output.slice(0, 4000) + '\n... (truncated)';

                        await conn.sendMessage(m.from, { text: `\`\`\`${output}\`\`\`` }, { quoted: m });
                    });
                } catch (err) {
                    await conn.sendMessage(m.from, { text: `❌ *Error:*\n\`\`\`${err.message}\`\`\`` }, { quoted: m });
                }
                break;
            }

            case "logs": {
                if (!isSuperAdmin(m)) {
                    await conn.sendMessage(m.from, { text: "❌ This command is restricted to the bot developer only." }, { quoted: m });
                    break;
                }

                try {
                    const lines = parseInt(args[0]) || 50;
                    const { exec } = require('child_process');

                    // Try to read recent stdout/stderr from process (no log file by default)
                    // This works if logs are being written to a file; otherwise informs the user.
                    const logPath = process.env.LOG_FILE_PATH || '/tmp/bot.log';

                    if (!fs.existsSync(logPath)) {
                        await conn.sendMessage(m.from, {
                            text: `⚠️ No log file found at ${logPath}.\n\nSet LOG_FILE_PATH env var and redirect output to a file to enable this command.\n\nOn Render, view logs via the dashboard instead.`
                        }, { quoted: m });
                        break;
                    }

                    exec(`tail -n ${lines} ${logPath}`, { timeout: 10000 }, async (error, stdout) => {
                        let output = stdout || error?.message || '(empty)';
                        if (output.length > 4000) output = output.slice(-4000);
                        await conn.sendMessage(m.from, { text: `📜 *Last ${lines} log lines:*\n\`\`\`${output}\`\`\`` }, { quoted: m });
                    });
                } catch (err) {
                    await conn.sendMessage(m.from, { text: `❌ ${err.message}` }, { quoted: m });
                }
                break;
            }

            case "memory": {
                if (!isSuperAdmin(m)) {
                    await conn.sendMessage(m.from, { text: "❌ This command is restricted to the bot developer only." }, { quoted: m });
                    break;
                }

                const mem = process.memoryUsage();
                const toMB = (b) => (b / 1024 / 1024).toFixed(2);

                const memText = `
💾 *Memory Usage*

RSS: ${toMB(mem.rss)} MB
Heap Total: ${toMB(mem.heapTotal)} MB
Heap Used: ${toMB(mem.heapUsed)} MB
External: ${toMB(mem.external)} MB
Array Buffers: ${toMB(mem.arrayBuffers)} MB
                `.trim();

                await conn.sendMessage(m.from, { text: memText }, { quoted: m });
                break;
            }

            case "cpu": {
                if (!isSuperAdmin(m)) {
                    await conn.sendMessage(m.from, { text: "❌ This command is restricted to the bot developer only." }, { quoted: m });
                    break;
                }

                const os = require('os');
                const cpus = os.cpus();
                const loadAvg = os.loadavg();

                const cpuText = `
🧠 *CPU Info*

Model: ${cpus[0]?.model || 'Unknown'}
Cores: ${cpus.length}
Load Avg (1m/5m/15m): ${loadAvg.map(l => l.toFixed(2)).join(' / ')}
Platform: ${os.platform()} (${os.arch()})
                `.trim();

                await conn.sendMessage(m.from, { text: cpuText }, { quoted: m });
                break;
            }

            case "disk": {
                if (!isSuperAdmin(m)) {
                    await conn.sendMessage(m.from, { text: "❌ This command is restricted to the bot developer only." }, { quoted: m });
                    break;
                }

                try {
                    const { exec } = require('child_process');
                    exec('df -h /', { timeout: 10000 }, async (error, stdout) => {
                        const output = stdout || error?.message || '(unavailable)';
                        await conn.sendMessage(m.from, { text: `💽 *Disk Usage*\n\`\`\`${output}\`\`\`` }, { quoted: m });
                    });
                } catch (err) {
                    await conn.sendMessage(m.from, { text: `❌ ${err.message}` }, { quoted: m });
                }
                break;
            }

            case "speed": {
                if (!isSuperAdmin(m)) {
                    await conn.sendMessage(m.from, { text: "❌ This command is restricted to the bot developer only." }, { quoted: m });
                    break;
                }

                try {
                    const axios = require('axios');
                    const testUrl = 'https://speed.cloudflare.com/__down?bytes=1000000'; // 1MB

                    const start = Date.now();
                    const res = await axios.get(testUrl, { responseType: 'arraybuffer', timeout: 20000 });
                    const durationSec = (Date.now() - start) / 1000;

                    const bytes = res.data.length;
                    const mbps = ((bytes * 8) / 1024 / 1024 / durationSec).toFixed(2);

                    await conn.sendMessage(m.from, {
                        text: `🚀 *Speed Test*\n\nDownloaded: ${(bytes / 1024 / 1024).toFixed(2)} MB\nTime: ${durationSec.toFixed(2)}s\nSpeed: ~${mbps} Mbps`
                    }, { quoted: m });
                } catch (err) {
                    console.error('Speed test error:', err.message);
                    await conn.sendMessage(m.from, { text: "❌ Speed test failed." }, { quoted: m });
                }
                break;
            }

            case "gitpull": {
                if (!isSuperAdmin(m)) {
                    await conn.sendMessage(m.from, { text: "❌ This command is restricted to the bot developer only." }, { quoted: m });
                    break;
                }

                try {
                    const { exec } = require('child_process');
                    exec('git pull', { timeout: 30000, cwd: process.cwd() }, async (error, stdout, stderr) => {
                        let output = stdout || '';
                        if (stderr) output += `\n${stderr}`;
                        if (error && !output) output = error.message;
                        if (!output) output = '(no output)';

                        await conn.sendMessage(m.from, { text: `📥 *Git Pull*\n\`\`\`${output}\`\`\`\n\n⚠️ Restart the bot to apply changes.` }, { quoted: m });
                    });
                } catch (err) {
                    await conn.sendMessage(m.from, { text: `❌ ${err.message}` }, { quoted: m });
                }
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

            // ════════════════════════════════════════════
            // MODE & AUTO-FEATURE TOGGLES (Owner/Sudo)
            // ════════════════════════════════════════════
            case "self":
            case "public": {
                if (!senderIsOwner) {
                    await conn.sendMessage(m.from, { text: "❌ Owner only command." }, { quoted: m });
                    break;
                }

                if (!redisClient || !phoneNumber) {
                    await conn.sendMessage(m.from, { text: "❌ Storage unavailable." }, { quoted: m });
                    break;
                }

                await setConfigValue(redisClient, phoneNumber, 'mode', command);
                await conn.sendMessage(m.from, {
                    text: command === 'self'
                        ? `🔒 *Self mode enabled*\n\nThe bot will now only respond to you and sudo users.`
                        : `🌐 *Public mode enabled*\n\nThe bot will now respond to everyone.`
                }, { quoted: m });
                break;
            }

            case "autoreact": {
                if (!senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Owner/Sudo only command." }, { quoted: m });
                    break;
                }

                const state = args[0]?.toLowerCase();

                if (state === 'on' || state === 'off') {
                    await setConfigValue(redisClient, phoneNumber, 'autoReact', state === 'on');
                    await conn.sendMessage(m.from, {
                        text: `${state === 'on' ? '✅' : '❌'} Auto react ${state === 'on' ? 'enabled' : 'disabled'}.`
                    }, { quoted: m });
                } else if (args[0]) {
                    // Treat the argument as an emoji to set
                    await setConfigValue(redisClient, phoneNumber, 'autoReactEmoji', args[0]);
                    await conn.sendMessage(m.from, { text: `✅ Auto react emoji set to: ${args[0]}` }, { quoted: m });
                } else {
                    await conn.sendMessage(m.from, {
                        text: `❌ Usage:\n${prefix}autoreact on/off\n${prefix}autoreact <emoji>  (sets the reaction emoji)`
                    }, { quoted: m });
                }
                break;
            }

            case "autoreactstatus": {
                if (!senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Owner/Sudo only command." }, { quoted: m });
                    break;
                }

                const state = args[0]?.toLowerCase();
                if (state !== 'on' && state !== 'off') {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}autoreactstatus on/off` }, { quoted: m });
                    break;
                }

                await setConfigValue(redisClient, phoneNumber, 'autoReactStatus', state === 'on');
                await conn.sendMessage(m.from, {
                    text: `${state === 'on' ? '✅' : '❌'} Auto react to statuses ${state === 'on' ? 'enabled' : 'disabled'}.`
                }, { quoted: m });
                break;
            }

            case "autoviewstatus": {
                if (!senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Owner/Sudo only command." }, { quoted: m });
                    break;
                }

                const state = args[0]?.toLowerCase();
                if (state !== 'on' && state !== 'off') {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}autoviewstatus on/off` }, { quoted: m });
                    break;
                }

                await setConfigValue(redisClient, phoneNumber, 'autoViewStatus', state === 'on');
                await conn.sendMessage(m.from, {
                    text: `${state === 'on' ? '✅' : '❌'} Auto view status ${state === 'on' ? 'enabled' : 'disabled'}.`
                }, { quoted: m });
                break;
            }

            case "notifystatus": {
                if (!senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Owner/Sudo only command." }, { quoted: m });
                    break;
                }

                const state = args[0]?.toLowerCase();
                if (state !== 'on' && state !== 'off') {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}notifystatus on/off\n\nWhen ON, you'll get a DM whenever the bot auto-views someone's status.` }, { quoted: m });
                    break;
                }

                await setConfigValue(redisClient, phoneNumber, 'notifyStatus', state === 'on');
                await conn.sendMessage(m.from, {
                    text: `${state === 'on' ? '✅' : '❌'} Status view notifications ${state === 'on' ? 'enabled' : 'disabled'}.`
                }, { quoted: m });
                break;
            }

            case "autotyping": {
                if (!senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Owner/Sudo only command." }, { quoted: m });
                    break;
                }

                const state = args[0]?.toLowerCase();
                if (state !== 'on' && state !== 'off') {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}autotyping on/off` }, { quoted: m });
                    break;
                }

                await setConfigValue(redisClient, phoneNumber, 'autoTyping', state === 'on');
                await conn.sendMessage(m.from, {
                    text: `${state === 'on' ? '✅' : '❌'} Auto typing ${state === 'on' ? 'enabled' : 'disabled'}.`
                }, { quoted: m });
                break;
            }

            case "autorecording": {
                if (!senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Owner/Sudo only command." }, { quoted: m });
                    break;
                }

                const state = args[0]?.toLowerCase();
                if (state !== 'on' && state !== 'off') {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}autorecording on/off` }, { quoted: m });
                    break;
                }

                await setConfigValue(redisClient, phoneNumber, 'autoRecording', state === 'on');
                await conn.sendMessage(m.from, {
                    text: `${state === 'on' ? '✅' : '❌'} Auto recording ${state === 'on' ? 'enabled' : 'disabled'}.`
                }, { quoted: m });
                break;
            }

            case "autoread": {
                if (!senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Owner/Sudo only command." }, { quoted: m });
                    break;
                }

                const state = args[0]?.toLowerCase();
                if (state !== 'on' && state !== 'off') {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}autoread on/off` }, { quoted: m });
                    break;
                }

                await setConfigValue(redisClient, phoneNumber, 'autoRead', state === 'on');
                await conn.sendMessage(m.from, {
                    text: `${state === 'on' ? '✅' : '❌'} Auto read ${state === 'on' ? 'enabled' : 'disabled'}.`
                }, { quoted: m });
                break;
            }

            case "autoonline": {
                if (!senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Owner/Sudo only command." }, { quoted: m });
                    break;
                }

                const state = args[0]?.toLowerCase();
                if (state !== 'on' && state !== 'off') {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}autoonline on/off\n\nWhen ON, the bot stays marked "online" continuously.` }, { quoted: m });
                    break;
                }

                await setConfigValue(redisClient, phoneNumber, 'autoOnline', state === 'on');

                if (state === 'on') {
                    try { await conn.sendPresenceUpdate('available'); } catch {}
                } else {
                    try { await conn.sendPresenceUpdate('unavailable'); } catch {}
                }

                await conn.sendMessage(m.from, {
                    text: `${state === 'on' ? '✅' : '❌'} Auto online ${state === 'on' ? 'enabled' : 'disabled'}.`
                }, { quoted: m });
                break;
            }


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
module.exports.setConfigValue = setConfigValue;
module.exports.setPrefix = setPrefix;
module.exports.addSudo = addSudo;
module.exports.removeSudo = removeSudo;
module.exports.CONFIG_DEFAULTS = CONFIG_DEFAULTS;
module.exports.isSuperAdmin = isSuperAdmin;
