const fs = require("fs");
const economy = require("./economy");
const rpg = require("./rpg");
const pvp = require("./pvp");
const social = require("./social");
const badges = require("./badges");
const minigames = require("./minigames");
const referral = require("./referral");
const events = require("./events");
const shop = require("./shop");
const wordgames = require("./wordgames");

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


// ── giveXp: addXp + notify the chat if the user levels up, then check badges ──
async function giveXp(redisClient, conn, jid, chatJid, amount) {
    try {
        const result = await economy.addXp(redisClient, jid, amount);
        if (result.leveledUp) {
            await conn.sendMessage(chatJid, {
                text: `🎉 @${jid.split('@')[0]} leveled up to *Level ${result.newLevel}*! ⭐`,
                mentions: [jid]
            });
        }

        // ── Auto badge check: level-based badges may now qualify ──
        const profile = await economy.getProfile(redisClient, jid);
        const unlocked = await badges.checkAutoBadges(redisClient, jid, profile);
        if (unlocked.length > 0) {
            const announcement = badges.formatBadgeUnlocks(jid, unlocked);
            if (announcement) {
                await conn.sendMessage(chatJid, { text: announcement, mentions: [jid] });
            }
        }

        return result;
    } catch (err) {
        console.error('giveXp error:', err.message);
    }
}

// ── broadcastToOwners: DM every paired session owner (not group members).
//    Used for global announcements like seasonal events. Skips numbers
//    that aren't currently online rather than queuing/erroring on them.
//    Sends are staggered slightly to avoid hammering WhatsApp's rate limits
//    when there are many paired sessions. ──
async function broadcastToOwners(redisClient, connections, messageText) {
    if (!redisClient || !connections) return { sent: 0, skipped: 0 };

    let sent = 0;
    let skipped = 0;

    try {
        const allNumbers = await redisClient.sMembers('users:all');
        for (const number of allNumbers) {
            const conn = connections.get(number);
            if (!conn) {
                skipped++;
                continue;
            }
            try {
                await conn.sendMessage(`${number}@s.whatsapp.net`, { text: messageText });
                sent++;
            } catch (err) {
                skipped++;
            }
            // Small stagger so we don't fire dozens of sends in the same tick
            await new Promise(resolve => setTimeout(resolve, 150));
        }
    } catch (err) {
        console.error('broadcastToOwners error:', err.message);
    }

    return { sent, skipped };
}

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
    autoOnline: false,
    antiDelete: false,
    antiEdit: false
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
            autoOnline: data.autoOnline === 'true',
            antiDelete: data.antiDelete === 'true',
            antiEdit: data.antiEdit === 'true'
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
// Works in two cases:
//   1. You're messaging YOUR OWN bot session (phoneNumber === SUPER_ADMIN_NUMBER)
//      -> m.key.fromMe will be true, sender JID may be a LID alias
//   2. You're messaging SOMEONE ELSE's bot session from your own WhatsApp
//      -> m.sender will be your real phone number JID
function isSuperAdmin(m, phoneNumber) {
    // Case 1: this is your own session, and the message is from you
    if (m.key?.fromMe && phoneNumber === SUPER_ADMIN_NUMBER) {
        return true;
    }

    // Case 2: sender's JID matches your number directly (messaging another session)
    const senderNum = normalizeJid(m.sender);
    if (senderNum === SUPER_ADMIN_NUMBER) {
        return true;
    }

    return false;
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
// The bot's identity can appear in TWO different formats depending on WhatsApp's
// internal routing: conn.user.id (phone-number JID, e.g. 234xxx@s.whatsapp.net)
// and conn.user.lid (LID alias, e.g. xxxxxxxx@lid). Group participant lists may
// show the bot under EITHER format, so we must check both.
async function isBotAdmin(conn, groupId) {
    try {
        const meta = await conn.groupMetadata(groupId);

        const botNum = normalizeJid(conn.user?.id);
        const botLid = normalizeJid(conn.user?.lid);

        const participant = meta.participants.find(p => {
            const norm = normalizeJid(p.id);
            return norm === botNum || (botLid && norm === botLid);
        });

        return participant?.admin === 'admin' || participant?.admin === 'superadmin';
    } catch {
        return false;
    }
}

module.exports = async (conn, m, chatUpdate, ctx = {}) => {
    try {
        const { phoneNumber, redisClient, connections } = ctx;
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
🛡️ Anti-delete: ${config.antiDelete ? 'ON' : 'OFF'}
🛡️ Anti-edit: ${config.antiEdit ? 'ON' : 'OFF'}
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


            // ════════════════════════════════════════════
            // ECONOMY & PROFILE SYSTEM
            // ════════════════════════════════════════════
            case "profile":
            case "p": {
                const target = m.quoted?.sender || m.mentionedJid?.[0] || m.sender;
                const profile = await economy.getProfile(redisClient, target);
                const xpNeeded = economy.xpForLevel(profile.level);

                const marriedText = profile.married
                    ? `💍 Married to @${profile.married.split('@')[0]}`
                    : `💔 Single`;

                // ── Enriched profile data: badges, equipped title/theme, bio ──
                const ownedBadges = await badges.getBadges(redisClient, target);
                const equippedTitle = await shop.getEquipped(redisClient, target, 'equippedTitle');
                const equippedTheme = await shop.getEquipped(redisClient, target, 'equippedTheme');
                const bio = await redisClient.hGet(`economy:${target}`, 'bio');

                const titleDef = equippedTitle ? shop.findItem(shop.TITLES, equippedTitle) : null;
                const themeDef = equippedTheme ? shop.findItem(shop.THEMES, equippedTheme) : null;
                const titleLine = titleDef ? `🏷️ ${titleDef.name}\n` : '';
                const themeEmoji = themeDef ? themeDef.emoji + ' ' : '';
                const bioLine = bio ? `📝 "${bio}"\n` : '';

                const profileText = `
${themeEmoji}👤 *PROFILE — @${target.split('@')[0]}*
${titleLine}━━━━━━━━━━━━━━━━━━━
${bioLine}💰 Wallet: ${economy.formatCoins(profile.coins)} coins
🏦 Bank: ${economy.formatCoins(profile.bank)} coins
⭐ Level: ${profile.level}
✨ XP: ${profile.xp}/${xpNeeded}
🏆 Wins: ${profile.wins} | Losses: ${profile.losses}
🏅 Badges: ${ownedBadges.length}/${badges.BADGE_TABLE.length}
${marriedText}
                `.trim();

                await conn.sendMessage(m.from, {
                    text: profileText,
                    mentions: [target]
                }, { quoted: m });
                break;
            }

            case "bio": {
                const sub = args[0]?.toLowerCase();

                if (sub === 'set') {
                    const newBio = args.slice(1).join(' ');
                    if (!newBio) {
                        await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}bio set <text>` }, { quoted: m });
                        break;
                    }
                    if (newBio.length > 100) {
                        await conn.sendMessage(m.from, { text: `❌ Bio must be 100 characters or fewer.` }, { quoted: m });
                        break;
                    }
                    await redisClient.hSet(`economy:${m.sender}`, 'bio', newBio);
                    await conn.sendMessage(m.from, { text: `✅ Bio updated!\n\n📝 "${newBio}"` }, { quoted: m });
                    break;
                }

                if (sub === 'clear') {
                    await redisClient.hDel(`economy:${m.sender}`, 'bio');
                    await conn.sendMessage(m.from, { text: `✅ Bio cleared.` }, { quoted: m });
                    break;
                }

                const target = m.quoted?.sender || m.mentionedJid?.[0] || m.sender;
                const bio = await redisClient.hGet(`economy:${target}`, 'bio');
                await conn.sendMessage(m.from, {
                    text: bio ? `📝 *Bio — @${target.split('@')[0]}*\n\n"${bio}"` : `📝 @${target.split('@')[0]} hasn't set a bio.\n\nSet yours with ${prefix}bio set <text>`,
                    mentions: [target]
                }, { quoted: m });
                break;
            }

            case "rank": {
                const target = m.quoted?.sender || m.mentionedJid?.[0] || m.sender;
                const profile = await economy.getProfile(redisClient, target);
                const xpNeeded = economy.xpForLevel(profile.level);
                const progressPct = Math.floor((profile.xp / xpNeeded) * 100);
                const filledBars = Math.round(progressPct / 10);
                const bar = '▰'.repeat(filledBars) + '▱'.repeat(10 - filledBars);

                await conn.sendMessage(m.from, {
                    text: `⭐ *RANK — @${target.split('@')[0]}*\n\nLevel ${profile.level}\n${bar} ${progressPct}%\n${profile.xp}/${xpNeeded} XP`,
                    mentions: [target]
                }, { quoted: m });
                break;
            }

            case "title": {
                const itemId = args[0]?.toLowerCase();
                if (!itemId) {
                    const equippedTitle = await shop.getEquipped(redisClient, m.sender, 'equippedTitle');
                    const owned = await shop.getOwnedList(redisClient, m.sender, 'titles');
                    const ownedNames = owned.map(id => shop.findItem(shop.TITLES, id)?.name).filter(Boolean);
                    await conn.sendMessage(m.from, {
                        text: `🏷️ Equipped: ${equippedTitle ? shop.findItem(shop.TITLES, equippedTitle)?.name : 'None'}\nOwned: ${ownedNames.length ? ownedNames.join(', ') : 'None'}\n\nEquip with ${prefix}title <id>, browse with ${prefix}shop titles`
                    }, { quoted: m });
                    break;
                }

                const titleDef = shop.findItem(shop.TITLES, itemId);
                if (!titleDef) {
                    await conn.sendMessage(m.from, { text: `❌ Unknown title. Browse with ${prefix}shop titles` }, { quoted: m });
                    break;
                }
                const owned = await shop.getOwnedList(redisClient, m.sender, 'titles');
                if (!owned.includes(titleDef.id)) {
                    await conn.sendMessage(m.from, { text: `❌ You don't own this title. Buy it with ${prefix}buy ${titleDef.id}` }, { quoted: m });
                    break;
                }
                await shop.equipItem(redisClient, m.sender, 'equippedTitle', titleDef.id);
                await conn.sendMessage(m.from, { text: `✅ Equipped title: *${titleDef.name}*` }, { quoted: m });
                break;
            }

            case "ship": {
                let userA, userB;
                if (m.mentionedJid?.length >= 2) {
                    [userA, userB] = m.mentionedJid;
                } else if (m.mentionedJid?.length === 1) {
                    userA = m.sender;
                    userB = m.mentionedJid[0];
                } else {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}ship @user1 [@user2]\n\nTag one person to ship with yourself, or two people to ship them together.` }, { quoted: m });
                    break;
                }

                // Deterministic "random" percentage based on the pair, so shipping
                // the same two people always gives the same result (more fun/shareable
                // than pure randomness, and avoids reroll-spam to get a higher number).
                const pairKey = [userA, userB].sort().join('|');
                let hash = 0;
                for (const ch of pairKey) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
                const percent = hash % 101;

                const filledHearts = Math.round(percent / 10);
                const heartBar = '❤️'.repeat(filledHearts) + '🖤'.repeat(10 - filledHearts);

                let verdict;
                if (percent >= 90) verdict = "Soulmates! 💍";
                else if (percent >= 70) verdict = "Great match! 💕";
                else if (percent >= 50) verdict = "There's potential 👀";
                else if (percent >= 30) verdict = "Eh, it's complicated 😅";
                else verdict = "Not feeling it 💀";

                await conn.sendMessage(m.from, {
                    text: `💘 *SHIP*\n\n@${userA.split('@')[0]} + @${userB.split('@')[0]}\n\n${heartBar}\n${percent}% compatible\n\n${verdict}`,
                    mentions: [userA, userB]
                }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // FUN / MEME
            // ════════════════════════════════════════════
            case "rate": {
                const thing = text;
                if (!thing) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}rate <anything>` }, { quoted: m });
                    break;
                }

                // Deterministic on the input text, so rating the same thing
                // always gives the same score (more fun/shareable, avoids reroll-spam).
                let hash = 0;
                for (const ch of thing.toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
                const score = hash % 11; // 0-10

                const stars = '⭐'.repeat(score) + '☆'.repeat(10 - score);
                const remark = score >= 9 ? "Absolutely incredible 🔥"
                    : score >= 7 ? "Pretty solid! 👍"
                    : score >= 5 ? "It's decent, I guess 🤷"
                    : score >= 3 ? "Not great honestly 😬"
                    : "Yikes 💀";

                await conn.sendMessage(m.from, {
                    text: `📊 *Rating: "${thing}"*\n\n${stars}\n${score}/10\n\n${remark}`
                }, { quoted: m });
                break;
            }

            case "compliment": {
                const target = m.quoted?.sender || m.mentionedJid?.[0] || m.sender;
                const compliments = [
                    "has main character energy ✨",
                    "is the reason this group doesn't fall apart 💪",
                    "deserves way more credit than they get 🙌",
                    "has impeccable taste 😌",
                    "is quietly carrying this entire chat 🔥",
                    "brings genuinely good vibes wherever they go 🌟",
                    "is smarter than they let on 🧠",
                    "has a smile that could fix anyone's day ☀️",
                    "is criminally underrated 💎",
                    "makes everything better just by being here 💫"
                ];
                const compliment = compliments[Math.floor(Math.random() * compliments.length)];
                await conn.sendMessage(m.from, {
                    text: `💖 @${target.split('@')[0]} ${compliment}`,
                    mentions: [target]
                }, { quoted: m });
                break;
            }

            case "8ball": {
                const question = text;
                if (!question) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}8ball <question>` }, { quoted: m });
                    break;
                }

                const answers = [
                    "Yes, definitely.", "It is certain.", "Without a doubt.", "Most likely.",
                    "Signs point to yes.", "Ask again later.", "Cannot predict now.",
                    "Better not tell you now.", "Don't count on it.", "My reply is no.",
                    "Very doubtful.", "Outlook not so good."
                ];
                const answer = answers[Math.floor(Math.random() * answers.length)];

                await conn.sendMessage(m.from, {
                    text: `🎱 *${question}*\n\n${answer}`
                }, { quoted: m });
                break;
            }

            case "fact": {
                const facts = [
                    "Honey never spoils — archaeologists have found 3,000-year-old honey in Egyptian tombs that's still edible.",
                    "Octopuses have three hearts and blue blood.",
                    "A day on Venus is longer than a year on Venus.",
                    "Bananas are berries, but strawberries aren't.",
                    "The Eiffel Tower can grow taller in summer due to heat expansion.",
                    "Sharks existed before trees.",
                    "Wombat poop is cube-shaped.",
                    "There are more possible chess games than atoms in the observable universe.",
                    "A bolt of lightning is roughly five times hotter than the surface of the sun.",
                    "Sea otters hold hands while sleeping so they don't drift apart.",
                    "The shortest war in history lasted 38 minutes.",
                    "Some turtles can breathe through their butts.",
                    "Cleopatra lived closer in time to the Moon landing than to the building of the Great Pyramid.",
                    "An octopus can taste through its arms.",
                    "Hot water can freeze faster than cold water under certain conditions — it's called the Mpemba effect."
                ];
                const fact = facts[Math.floor(Math.random() * facts.length)];
                await conn.sendMessage(m.from, { text: `🧠 *Random Fact*\n\n${fact}` }, { quoted: m });
                break;
            }

            case "meme": {
                const memeLines = [
                    "Me: I'll just check WhatsApp for 5 minutes\n*3 hours later*",
                    "Nobody:\nAbsolutely nobody:\nMe at 3am: let me start a new project",
                    "When the wifi goes out for 2 seconds:\n💀💀💀",
                    "Me explaining to my bank why I bet my coins on Mines:\n'It was a calculated risk'",
                    "POV: you typed the wrong command prefix for the 100th time",
                    "When someone says they don't like memes:\n🚩🚩🚩",
                    "Me: I'll go to bed early today\nAlso me at 2am: just one more game of Snake",
                    "When you finally beat your Mines high score:\n🏆 main character moment"
                ];
                const meme = memeLines[Math.floor(Math.random() * memeLines.length)];
                await conn.sendMessage(m.from, { text: `😂 *Random Meme*\n\n${meme}` }, { quoted: m });
                break;
            }

            case "balance":
            case "bal": {
                const target = m.quoted?.sender || m.mentionedJid?.[0] || m.sender;
                const profile = await economy.getProfile(redisClient, target);

                await conn.sendMessage(m.from, {
                    text: `💰 *Balance — @${target.split('@')[0]}*\n\nWallet: ${economy.formatCoins(profile.coins)} coins\nBank: ${economy.formatCoins(profile.bank)} coins\nTotal: ${economy.formatCoins(profile.coins + profile.bank)} coins`,
                    mentions: [target]
                }, { quoted: m });
                break;
            }

            case "wallet": {
                const profile = await economy.getProfile(redisClient, m.sender);
                await conn.sendMessage(m.from, { text: `👛 Wallet: ${economy.formatCoins(profile.coins)} coins` }, { quoted: m });
                break;
            }

            case "bank": {
                const profile = await economy.getProfile(redisClient, m.sender);
                await conn.sendMessage(m.from, { text: `🏦 Bank: ${economy.formatCoins(profile.bank)} coins` }, { quoted: m });
                break;
            }

            case "deposit": {
                const amount = parseInt(args[0]);
                if (!amount || amount <= 0) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}deposit <amount>` }, { quoted: m });
                    break;
                }

                const profile = await economy.getProfile(redisClient, m.sender);
                if (profile.coins < amount) {
                    await conn.sendMessage(m.from, { text: `❌ You don't have ${economy.formatCoins(amount)} coins in your wallet.` }, { quoted: m });
                    break;
                }

                await economy.updateProfile(redisClient, m.sender, {
                    coins: profile.coins - amount,
                    bank: profile.bank + amount
                });

                await conn.sendMessage(m.from, { text: `🏦 Deposited ${economy.formatCoins(amount)} coins to your bank.` }, { quoted: m });
                break;
            }

            case "withdraw": {
                const amount = parseInt(args[0]);
                if (!amount || amount <= 0) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}withdraw <amount>` }, { quoted: m });
                    break;
                }

                const profile = await economy.getProfile(redisClient, m.sender);
                if (profile.bank < amount) {
                    await conn.sendMessage(m.from, { text: `❌ You don't have ${economy.formatCoins(amount)} coins in your bank.` }, { quoted: m });
                    break;
                }

                await economy.updateProfile(redisClient, m.sender, {
                    coins: profile.coins + amount,
                    bank: profile.bank - amount
                });

                await conn.sendMessage(m.from, { text: `👛 Withdrew ${economy.formatCoins(amount)} coins to your wallet.` }, { quoted: m });
                break;
            }

            case "give":
            case "pay": {
                const target = m.quoted?.sender || m.mentionedJid?.[0];
                const amount = parseInt(args[args.length - 1]);

                if (!target || !amount || amount <= 0) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}give @user <amount>` }, { quoted: m });
                    break;
                }

                if (target === m.sender) {
                    await conn.sendMessage(m.from, { text: "❌ You can't send coins to yourself." }, { quoted: m });
                    break;
                }

                const senderProfile = await economy.getProfile(redisClient, m.sender);
                if (senderProfile.coins < amount) {
                    await conn.sendMessage(m.from, { text: `❌ You don't have ${economy.formatCoins(amount)} coins.` }, { quoted: m });
                    break;
                }

                await economy.addCoins(redisClient, m.sender, -amount);
                await economy.addCoins(redisClient, target, amount);

                await conn.sendMessage(m.from, {
                    text: `💸 @${m.sender.split('@')[0]} sent ${economy.formatCoins(amount)} coins to @${target.split('@')[0]}`,
                    mentions: [m.sender, target]
                }, { quoted: m });
                break;
            }

            // ── Daily / Weekly / Work / Beg (cooldown-based earning) ──
            case "daily": {
                const profile = await economy.getProfile(redisClient, m.sender);
                const cooldown = 24 * 60 * 60 * 1000; // 24h
                const remaining = economy.cooldownRemaining(profile.lastDaily, cooldown);

                if (remaining > 0) {
                    await conn.sendMessage(m.from, { text: `⏳ You already claimed your daily reward.\n\nCome back in ${economy.formatDuration(remaining)}.` }, { quoted: m });
                    break;
                }

                const reward = 1000;
                await economy.addCoins(redisClient, m.sender, reward);
                await economy.updateProfile(redisClient, m.sender, { lastDaily: Date.now() });
                await giveXp(redisClient, conn, m.sender, m.from, 20);

                await conn.sendMessage(m.from, { text: `🎁 *Daily Reward Claimed!*\n\n+${economy.formatCoins(reward)} coins\n+20 XP\n\nCome back in 24h!` }, { quoted: m });
                break;
            }

            case "weekly": {
                const profile = await economy.getProfile(redisClient, m.sender);
                const cooldown = 7 * 24 * 60 * 60 * 1000; // 7 days
                const remaining = economy.cooldownRemaining(profile.lastWeekly, cooldown);

                if (remaining > 0) {
                    await conn.sendMessage(m.from, { text: `⏳ You already claimed your weekly reward.\n\nCome back in ${economy.formatDuration(remaining)}.` }, { quoted: m });
                    break;
                }

                const reward = 7000;
                await economy.addCoins(redisClient, m.sender, reward);
                await economy.updateProfile(redisClient, m.sender, { lastWeekly: Date.now() });
                await giveXp(redisClient, conn, m.sender, m.from, 100);

                await conn.sendMessage(m.from, { text: `🎉 *Weekly Reward Claimed!*\n\n+${economy.formatCoins(reward)} coins\n+100 XP\n\nCome back in 7 days!` }, { quoted: m });
                break;
            }

            case "work": {
                const profile = await economy.getProfile(redisClient, m.sender);
                const cooldown = 60 * 60 * 1000; // 1h
                const remaining = economy.cooldownRemaining(profile.lastWork, cooldown);

                if (remaining > 0) {
                    await conn.sendMessage(m.from, { text: `⏳ You're tired from work.\n\nRest for ${economy.formatDuration(remaining)} before working again.` }, { quoted: m });
                    break;
                }

                const jobs = [
                    { name: 'Uber driver', pay: [200, 600] },
                    { name: 'Software developer', pay: [500, 1200] },
                    { name: 'Chef', pay: [300, 700] },
                    { name: 'Street vendor', pay: [100, 400] },
                    { name: 'Tutor', pay: [250, 650] },
                    { name: 'Delivery rider', pay: [150, 500] }
                ];

                const job = jobs[Math.floor(Math.random() * jobs.length)];
                const earned = Math.floor(Math.random() * (job.pay[1] - job.pay[0] + 1)) + job.pay[0];

                await economy.addCoins(redisClient, m.sender, earned);
                await economy.updateProfile(redisClient, m.sender, { lastWork: Date.now() });
                await giveXp(redisClient, conn, m.sender, m.from, 10);

                await conn.sendMessage(m.from, { text: `💼 You worked as a *${job.name}* and earned ${economy.formatCoins(earned)} coins!\n+10 XP\n\nWork again in 1h.` }, { quoted: m });
                break;
            }

            case "beg": {
                const profile = await economy.getProfile(redisClient, m.sender);
                const cooldown = 30 * 60 * 1000; // 30 min
                const remaining = economy.cooldownRemaining(profile.lastBeg, cooldown);

                if (remaining > 0) {
                    await conn.sendMessage(m.from, { text: `⏳ Wait ${economy.formatDuration(remaining)} before begging again.` }, { quoted: m });
                    break;
                }

                const success = Math.random() < 0.7; // 70% chance
                await economy.updateProfile(redisClient, m.sender, { lastBeg: Date.now() });

                if (success) {
                    const earned = Math.floor(Math.random() * 150) + 20;
                    await economy.addCoins(redisClient, m.sender, earned);
                    await conn.sendMessage(m.from, { text: `🙏 A stranger gave you ${economy.formatCoins(earned)} coins.` }, { quoted: m });
                } else {
                    await conn.sendMessage(m.from, { text: `🙅 Nobody gave you anything this time. Try again later.` }, { quoted: m });
                }
                break;
            }

            // ── Leaderboard ──
            case "leaderboard":
            case "lb":
            case "topcoins": {
                if (!redisClient) {
                    await conn.sendMessage(m.from, { text: "❌ Storage unavailable." }, { quoted: m });
                    break;
                }

                try {
                    const keys = await redisClient.keys('economy:*');
                    const entries = [];

                    for (const key of keys) {
                        const jid = key.replace('economy:', '');
                        const data = await redisClient.hGetAll(key);
                        const total = parseInt(data.coins || '0') + parseInt(data.bank || '0');
                        entries.push({ jid, total, level: parseInt(data.level || '1') });
                    }

                    entries.sort((a, b) => b.total - a.total);
                    const top = entries.slice(0, 10);

                    if (!top.length) {
                        await conn.sendMessage(m.from, { text: "📊 No economy data yet." }, { quoted: m });
                        break;
                    }

                    const medals = ['🥇', '🥈', '🥉'];
                    const lines = top.map((e, i) => {
                        const medal = medals[i] || `${i + 1}.`;
                        return `${medal} @${e.jid.split('@')[0]} — ${economy.formatCoins(e.total)} coins (Lv.${e.level})`;
                    });

                    await conn.sendMessage(m.from, {
                        text: `🏆 *TOP 10 RICHEST*\n━━━━━━━━━━━━━━━━━━━\n${lines.join('\n')}`,
                        mentions: top.map(e => e.jid)
                    }, { quoted: m });
                } catch (err) {
                    console.error('Leaderboard error:', err.message);
                    await conn.sendMessage(m.from, { text: "❌ Failed to load leaderboard." }, { quoted: m });
                }
                break;
            }

            // ── Marriage ──
            case "marry": {
                const target = m.quoted?.sender || m.mentionedJid?.[0];
                if (!target) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}marry @user (reply or mention)` }, { quoted: m });
                    break;
                }

                if (target === m.sender) {
                    await conn.sendMessage(m.from, { text: "❌ You can't marry yourself." }, { quoted: m });
                    break;
                }

                const senderProfile = await economy.getProfile(redisClient, m.sender);
                const targetProfile = await economy.getProfile(redisClient, target);

                if (senderProfile.married) {
                    await conn.sendMessage(m.from, { text: `❌ You're already married to @${senderProfile.married.split('@')[0]}.`, mentions: [senderProfile.married] }, { quoted: m });
                    break;
                }

                if (targetProfile.married) {
                    await conn.sendMessage(m.from, { text: `❌ @${target.split('@')[0]} is already married.`, mentions: [target] }, { quoted: m });
                    break;
                }

                await economy.updateProfile(redisClient, m.sender, { married: target });
                await economy.updateProfile(redisClient, target, { married: m.sender });

                await conn.sendMessage(m.from, {
                    text: `💍 *Wedding Bells!* 💍\n\n@${m.sender.split('@')[0]} and @${target.split('@')[0]} are now married! 🎉👰🤵`,
                    mentions: [m.sender, target]
                }, { quoted: m });

                // ── Auto badge check: married badge for both spouses ──
                for (const spouseJid of [m.sender, target]) {
                    const spouseProfile = await economy.getProfile(redisClient, spouseJid);
                    const unlocked = await badges.checkAutoBadges(redisClient, spouseJid, spouseProfile);
                    if (unlocked.length > 0) {
                        const announcement = badges.formatBadgeUnlocks(spouseJid, unlocked);
                        if (announcement) {
                            await conn.sendMessage(m.from, { text: announcement, mentions: [spouseJid] });
                        }
                    }
                }
                break;
            }

            case "divorce": {
                const profile = await economy.getProfile(redisClient, m.sender);
                if (!profile.married) {
                    await conn.sendMessage(m.from, { text: "❌ You're not married." }, { quoted: m });
                    break;
                }

                const spouse = profile.married;
                await economy.updateProfile(redisClient, m.sender, { married: '' });
                await economy.updateProfile(redisClient, spouse, { married: '' });

                await conn.sendMessage(m.from, {
                    text: `💔 @${m.sender.split('@')[0]} and @${spouse.split('@')[0]} have divorced.`,
                    mentions: [m.sender, spouse]
                }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // GAMES (betting-based, plug into wallet)
            // ════════════════════════════════════════════
            case "coinflip":
            case "cf": {
                const bet = parseInt(args[0]);
                const choice = args[1]?.toLowerCase();

                if (!bet || bet <= 0 || (choice !== 'heads' && choice !== 'tails')) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}coinflip <amount> <heads/tails>` }, { quoted: m });
                    break;
                }

                const profile = await economy.getProfile(redisClient, m.sender);
                if (profile.coins < bet) {
                    await conn.sendMessage(m.from, { text: `❌ You don't have ${economy.formatCoins(bet)} coins.` }, { quoted: m });
                    break;
                }

                const result = Math.random() < 0.5 ? 'heads' : 'tails';
                const won = result === choice;

                if (won) {
                    await economy.addCoins(redisClient, m.sender, bet);
                    await economy.updateProfile(redisClient, m.sender, { wins: profile.wins + 1 });
                    await conn.sendMessage(m.from, { text: `🪙 The coin landed on *${result}*!\n\n✅ You won ${economy.formatCoins(bet)} coins!` }, { quoted: m });
                } else {
                    await economy.addCoins(redisClient, m.sender, -bet);
                    await economy.updateProfile(redisClient, m.sender, { losses: profile.losses + 1 });
                    await conn.sendMessage(m.from, { text: `🪙 The coin landed on *${result}*!\n\n❌ You lost ${economy.formatCoins(bet)} coins.` }, { quoted: m });
                }
                break;
            }

            case "dice":
            case "diceroll": {
                const bet = parseInt(args[0]);
                const guess = parseInt(args[1]);

                if (!bet || bet <= 0 || !guess || guess < 1 || guess > 6) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}dice <amount> <1-6>` }, { quoted: m });
                    break;
                }

                const profile = await economy.getProfile(redisClient, m.sender);
                if (profile.coins < bet) {
                    await conn.sendMessage(m.from, { text: `❌ You don't have ${economy.formatCoins(bet)} coins.` }, { quoted: m });
                    break;
                }

                const roll = Math.floor(Math.random() * 6) + 1;
                const diceEmojis = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

                if (roll === guess) {
                    const winnings = bet * 5; // 5x payout for exact guess
                    await economy.addCoins(redisClient, m.sender, winnings);
                    await economy.updateProfile(redisClient, m.sender, { wins: profile.wins + 1 });
                    await conn.sendMessage(m.from, { text: `${diceEmojis[roll-1]} Rolled a *${roll}*!\n\n🎯 EXACT MATCH! You won ${economy.formatCoins(winnings)} coins! (5x)` }, { quoted: m });
                } else {
                    await economy.addCoins(redisClient, m.sender, -bet);
                    await economy.updateProfile(redisClient, m.sender, { losses: profile.losses + 1 });
                    await conn.sendMessage(m.from, { text: `${diceEmojis[roll-1]} Rolled a *${roll}*!\n\n❌ Not a match. You lost ${economy.formatCoins(bet)} coins.` }, { quoted: m });
                }
                break;
            }

            // ════════════════════════════════════════════
            // MINES (grid game)
            // ════════════════════════════════════════════
            case "mines": {
                const existing = await minigames.getMinesSession(redisClient, m.from, m.sender);
                if (existing) {
                    await conn.sendMessage(m.from, {
                        text: `⚠️ You already have a Mines game running!\n\n${minigames.renderGrid(existing)}\n\nMultiplier: *${existing.multiplier.toFixed(2)}x*\nUse ${prefix}dig <1-25> to keep digging or ${prefix}minescashout to cash out.`
                    }, { quoted: m });
                    break;
                }

                const bet = parseInt(args[0]);
                const bombCount = args[1] ? parseInt(args[1]) : 3;

                if (!bet || bet <= 0) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}mines <amount> [bombs 1-10]\n\nDefault bombs: 3. More bombs = higher risk, faster-climbing payout.` }, { quoted: m });
                    break;
                }

                if (bombCount < 1 || bombCount > 10) {
                    await conn.sendMessage(m.from, { text: `❌ Bomb count must be between 1 and 10.` }, { quoted: m });
                    break;
                }

                const profile = await economy.getProfile(redisClient, m.sender);
                if (profile.coins < bet) {
                    await conn.sendMessage(m.from, { text: `❌ You don't have ${economy.formatCoins(bet)} coins.` }, { quoted: m });
                    break;
                }

                await economy.addCoins(redisClient, m.sender, -bet);
                const session = await minigames.startMines(redisClient, m.from, m.sender, bet, bombCount);

                await conn.sendMessage(m.from, {
                    text: `💣 *MINES* — ${bombCount} bombs hidden in a 5x5 grid!\n\n${minigames.renderGrid(session)}\n\nBet: ${economy.formatCoins(bet)} coins\nMultiplier: *1.00x*\n\nUse ${prefix}dig <1-25> to reveal a tile, or ${prefix}minescashout to bank your winnings.`
                }, { quoted: m });
                break;
            }

            case "dig": {
                const tileInput = parseInt(args[0]);
                if (!tileInput || tileInput < 1 || tileInput > 25) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}dig <1-25>` }, { quoted: m });
                    break;
                }
                const tile = tileInput - 1; // convert to 0-indexed

                const result = await minigames.digMines(redisClient, m.from, m.sender, tile);
                if (!result) {
                    await conn.sendMessage(m.from, { text: `❌ You don't have an active Mines game. Start one with ${prefix}mines <amount>.` }, { quoted: m });
                    break;
                }

                if (result.hit === 'already_dug') {
                    await conn.sendMessage(m.from, { text: `❌ Tile ${tileInput} is already revealed. Pick another.` }, { quoted: m });
                    break;
                }

                if (result.hit === 'bomb') {
                    // ── Check for a revive token before finalizing the loss ──
                    const reviveTokens = await shop.getReviveTokens(redisClient, m.sender);
                    if (reviveTokens > 0) {
                        const used = await shop.useReviveToken(redisClient, m.sender);
                        if (used) {
                            // Restore a session identical to the one that died, but the bomb
                            // tile that was just hit is removed from the danger list (defused)
                            // and added to dug so it can't be re-triggered or re-counted.
                            const revivedSession = {
                                bet: result.session.bet,
                                bombCount: result.session.bombCount,
                                bombs: result.session.bombs.filter(b => b !== tile),
                                dug: [...result.session.dug, tile],
                                multiplier: result.session.multiplier,
                                startedAt: result.session.startedAt
                            };
                            await minigames.saveMinesSession(redisClient, m.from, m.sender, revivedSession);
                            const remaining = await shop.getReviveTokens(redisClient, m.sender);
                            await conn.sendMessage(m.from, {
                                text: `💊 *Revive Token used!* The bomb on tile ${tileInput} was defused.\n\n${minigames.renderGrid(revivedSession)}\n\nMultiplier: *${revivedSession.multiplier.toFixed(2)}x*\nTokens remaining: ${remaining}\n\nUse ${prefix}dig <1-25> to keep going.`
                            }, { quoted: m });
                            break;
                        }
                    }

                    await economy.updateProfile(redisClient, m.sender, {
                        losses: (await economy.getProfile(redisClient, m.sender)).losses + 1
                    });
                    await conn.sendMessage(m.from, {
                        text: `💥 *BOOM!* Tile ${tileInput} was a bomb.\n\n${minigames.renderGrid(result.session, true)}\n\n❌ You lost ${economy.formatCoins(result.session.bet)} coins.${reviveTokens === 0 ? `\n\n💊 Tip: buy a Revive Token with ${prefix}buy revive_token to survive bombs!` : ''}`
                    }, { quoted: m });
                    break;
                }

                if (result.hit === 'cleared') {
                    await economy.addCoins(redisClient, m.sender, result.payout);
                    const profile = await economy.getProfile(redisClient, m.sender);
                    await economy.updateProfile(redisClient, m.sender, { wins: profile.wins + 1 });
                    await conn.sendMessage(m.from, {
                        text: `🎉 *BOARD CLEARED!* Every safe tile dug!\n\n${minigames.renderGrid(result.session, true)}\n\n💰 Payout: ${economy.formatCoins(result.payout)} coins (${result.session.multiplier.toFixed(2)}x)`
                    }, { quoted: m });
                    break;
                }

                // safe dig
                await conn.sendMessage(m.from, {
                    text: `✅ Safe! Tile ${tileInput} was clear.\n\n${minigames.renderGrid(result.session)}\n\nMultiplier: *${result.session.multiplier.toFixed(2)}x*\nPotential payout: ${economy.formatCoins(Math.floor(result.session.bet * result.session.multiplier))} coins\n\n${prefix}dig <1-25> to continue or ${prefix}minescashout to bank it.`
                }, { quoted: m });
                break;
            }

            case "minescashout":
            case "minescash": {
                const result = await minigames.cashoutMines(redisClient, m.from, m.sender);
                if (!result) {
                    await conn.sendMessage(m.from, { text: `❌ You don't have an active Mines game.` }, { quoted: m });
                    break;
                }
                if (result.error === 'no_digs') {
                    await conn.sendMessage(m.from, { text: `❌ Dig at least one tile before cashing out. Use ${prefix}dig <1-25>.` }, { quoted: m });
                    break;
                }

                await economy.addCoins(redisClient, m.sender, result.payout);
                const profile = await economy.getProfile(redisClient, m.sender);
                await economy.updateProfile(redisClient, m.sender, { wins: profile.wins + 1 });

                await conn.sendMessage(m.from, {
                    text: `💰 *Cashed out!*\n\n${minigames.renderGrid(result.session, true)}\n\nMultiplier: *${result.session.multiplier.toFixed(2)}x*\nPayout: ${economy.formatCoins(result.payout)} coins`
                }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // SNAKE
            // ════════════════════════════════════════════
            case "snake": {
                const existing = await minigames.getSnakeSession(redisClient, m.from, m.sender);
                if (existing) {
                    await conn.sendMessage(m.from, {
                        text: `⚠️ You already have a Snake game running!\n\n${minigames.renderSnakeGrid(existing)}\n\nScore: *${existing.score}*\nUse ${prefix}up/${prefix}down/${prefix}left/${prefix}right to move, or ${prefix}endsnake to quit.`
                    }, { quoted: m });
                    break;
                }

                const session = await minigames.startSnake(redisClient, m.from, m.sender);
                await conn.sendMessage(m.from, {
                    text: `🐍 *SNAKE* — eat the 🍎 to grow!\n\n${minigames.renderSnakeGrid(session)}\n\nScore: *0*\n\nUse ${prefix}up / ${prefix}down / ${prefix}left / ${prefix}right to move.\nEach 🍎 = +${minigames.SNAKE_COINS_PER_FOOD} coins, +${minigames.SNAKE_XP_PER_FOOD} XP.`
                }, { quoted: m });
                break;
            }

            case "up":
            case "down":
            case "left":
            case "right": {
                const session = await minigames.getSnakeSession(redisClient, m.from, m.sender);
                if (!session) {
                    // Not every chat will have a snake game running, so stay quiet/cheap here
                    // rather than erroring on every accidental "up"/"down" message.
                    break;
                }

                const result = await minigames.moveSnake(redisClient, m.from, m.sender, command);

                if (result.result === 'invalid_reverse') {
                    await conn.sendMessage(m.from, { text: `❌ Can't reverse directly into yourself.` }, { quoted: m });
                    break;
                }

                if (result.result === 'dead') {
                    const causeText = result.cause === 'wall' ? 'hit a wall' : 'ran into itself';
                    const isNewBest = await minigames.recordSnakeScore(redisClient, m.sender, result.session.score);

                    if (result.session.score > 0) {
                        const coinsEarned = result.session.score * minigames.SNAKE_COINS_PER_FOOD;
                        await economy.addCoins(redisClient, m.sender, coinsEarned);
                        await giveXp(redisClient, conn, m.sender, m.from, result.session.score * minigames.SNAKE_XP_PER_FOOD);
                    }

                    await conn.sendMessage(m.from, {
                        text: `💀 *Game Over!* Your snake ${causeText}.\n\nFinal Score: *${result.session.score}*${isNewBest ? ' 🏆 New personal best!' : ''}\nEarned: ${economy.formatCoins(result.session.score * minigames.SNAKE_COINS_PER_FOOD)} coins\n\nPlay again with ${prefix}snake.`
                    }, { quoted: m });
                    break;
                }

                if (result.result === 'ate') {
                    await conn.sendMessage(m.from, {
                        text: `🍎 *Yum!*\n\n${minigames.renderSnakeGrid(result.session)}\n\nScore: *${result.session.score}*`
                    }, { quoted: m });
                    break;
                }

                // moved
                await conn.sendMessage(m.from, {
                    text: `${minigames.renderSnakeGrid(result.session)}\n\nScore: *${result.session.score}*`
                }, { quoted: m });
                break;
            }

            case "endsnake":
            case "quitsnake": {
                const session = await minigames.getSnakeSession(redisClient, m.from, m.sender);
                if (!session) {
                    await conn.sendMessage(m.from, { text: `❌ You don't have an active Snake game.` }, { quoted: m });
                    break;
                }

                await minigames.endSnake(redisClient, m.from, m.sender);
                if (session.score > 0) {
                    await minigames.recordSnakeScore(redisClient, m.sender, session.score);
                    const coinsEarned = session.score * minigames.SNAKE_COINS_PER_FOOD;
                    await economy.addCoins(redisClient, m.sender, coinsEarned);
                    await giveXp(redisClient, conn, m.sender, m.from, session.score * minigames.SNAKE_XP_PER_FOOD);
                    await conn.sendMessage(m.from, {
                        text: `🐍 Game ended. Final Score: *${session.score}*\nEarned: ${economy.formatCoins(coinsEarned)} coins`
                    }, { quoted: m });
                } else {
                    await conn.sendMessage(m.from, { text: `🐍 Game ended. No score to bank.` }, { quoted: m });
                }
                break;
            }

            case "snakeboard":
            case "snaketop": {
                const top = await minigames.getSnakeLeaderboard(redisClient, 10);
                if (top.length === 0) {
                    await conn.sendMessage(m.from, { text: `🐍 No Snake scores recorded yet. Be the first with ${prefix}snake!` }, { quoted: m });
                    break;
                }

                const medals = ['🥇', '🥈', '🥉'];
                const lines = top.map((entry, i) =>
                    `${medals[i] || `${i + 1}.`} @${entry.jid.split('@')[0]} — ${entry.score} pts`
                );

                await conn.sendMessage(m.from, {
                    text: `🐍 *Snake Leaderboard*\n\n${lines.join('\n')}`,
                    mentions: top.map(e => e.jid)
                }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // TIC-TAC-TOE (2-player, bet-based)
            // ════════════════════════════════════════════
            case "tictactoe":
            case "ttt": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ Tic-Tac-Toe only works in groups." }, { quoted: m });
                    break;
                }

                const existingGame = await wordgames.getTTT(redisClient, m.from);
                if (existingGame) {
                    await conn.sendMessage(m.from, {
                        text: `⚠️ A Tic-Tac-Toe game is already in progress in this group.\n\n${wordgames.renderTTT(existingGame)}`
                    }, { quoted: m });
                    break;
                }

                const opponent = m.quoted?.sender || m.mentionedJid?.[0];
                const bet = parseInt(args[args.length - 1]);

                if (!opponent || !bet || bet <= 0) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}tictactoe @user <bet>` }, { quoted: m });
                    break;
                }
                if (opponent === m.sender) {
                    await conn.sendMessage(m.from, { text: "❌ You can't play against yourself." }, { quoted: m });
                    break;
                }

                const profile = await economy.getProfile(redisClient, m.sender);
                if (profile.coins < bet) {
                    await conn.sendMessage(m.from, { text: `❌ You don't have ${economy.formatCoins(bet)} coins.` }, { quoted: m });
                    break;
                }
                const opponentProfile = await economy.getProfile(redisClient, opponent);
                if (opponentProfile.coins < bet) {
                    await conn.sendMessage(m.from, { text: `❌ @${opponent.split('@')[0]} doesn't have enough coins.`, mentions: [opponent] }, { quoted: m });
                    break;
                }

                await wordgames.createChallenge(redisClient, 'ttt', m.from, m.sender, opponent, bet);
                await conn.sendMessage(m.from, {
                    text: `⭕ @${m.sender.split('@')[0]} challenges @${opponent.split('@')[0]} to Tic-Tac-Toe!\n\n💰 Bet: ${economy.formatCoins(bet)} coins each\n⏳ Expires in 60s\n\n@${opponent.split('@')[0]}, type ${prefix}tttaccept to play!`,
                    mentions: [m.sender, opponent]
                }, { quoted: m });
                break;
            }

            case "tttaccept": {
                if (!isGroup) break;

                const challenge = await wordgames.getChallenge(redisClient, 'ttt', m.from);
                if (!challenge || challenge.opponentJid !== m.sender) {
                    await conn.sendMessage(m.from, { text: "❌ No pending Tic-Tac-Toe challenge for you." }, { quoted: m });
                    break;
                }

                const challengerProfile = await economy.getProfile(redisClient, challenge.challengerJid);
                const opponentProfile = await economy.getProfile(redisClient, m.sender);
                if (challengerProfile.coins < challenge.bet || opponentProfile.coins < challenge.bet) {
                    await conn.sendMessage(m.from, { text: "❌ One of you no longer has enough coins." }, { quoted: m });
                    await wordgames.deleteChallenge(redisClient, 'ttt', m.from);
                    break;
                }

                await economy.addCoins(redisClient, challenge.challengerJid, -challenge.bet);
                await economy.addCoins(redisClient, m.sender, -challenge.bet);
                await wordgames.deleteChallenge(redisClient, 'ttt', m.from);

                const session = await wordgames.startTTT(redisClient, m.from, challenge.challengerJid, m.sender, challenge.bet);
                await conn.sendMessage(m.from, {
                    text: `⭕ *Tic-Tac-Toe started!*\n\n❌ @${challenge.challengerJid.split('@')[0]} vs ⭕ @${m.sender.split('@')[0]}\n\n${wordgames.renderTTT(session)}\n\n❌'s turn. Use ${prefix}tttmove <1-9> to place.`,
                    mentions: [challenge.challengerJid, m.sender]
                }, { quoted: m });
                break;
            }

            case "tttmove": {
                if (!isGroup) break;
                const pos = parseInt(args[0]);
                if (!pos || pos < 1 || pos > 9) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}tttmove <1-9>` }, { quoted: m });
                    break;
                }

                const result = await wordgames.playTTT(redisClient, m.from, m.sender, pos - 1);
                if (!result) {
                    await conn.sendMessage(m.from, { text: "❌ No active Tic-Tac-Toe game. Start one with " + prefix + "tictactoe @user <bet>" }, { quoted: m });
                    break;
                }
                if (result.result === 'not_a_player') {
                    await conn.sendMessage(m.from, { text: "❌ You're not part of this game." }, { quoted: m });
                    break;
                }
                if (result.result === 'not_your_turn') {
                    await conn.sendMessage(m.from, { text: "❌ It's not your turn." }, { quoted: m });
                    break;
                }
                if (result.result === 'invalid') {
                    await conn.sendMessage(m.from, { text: "❌ That spot is taken or invalid." }, { quoted: m });
                    break;
                }

                if (result.result === 'draw') {
                    await economy.addCoins(redisClient, result.session.playerX, result.session.bet);
                    await economy.addCoins(redisClient, result.session.playerO, result.session.bet);
                    await conn.sendMessage(m.from, {
                        text: `🤝 *Draw!* Bets refunded.\n\n${wordgames.renderTTT(result.session)}`
                    }, { quoted: m });
                    break;
                }

                if (result.result === 'win') {
                    const loserJid = result.winnerJid === result.session.playerX ? result.session.playerO : result.session.playerX;
                    const payout = result.session.bet * 2;
                    await economy.addCoins(redisClient, result.winnerJid, payout);
                    await giveXp(redisClient, conn, result.winnerJid, m.from, 20);
                    const winnerProfile = await economy.getProfile(redisClient, result.winnerJid);
                    await economy.updateProfile(redisClient, result.winnerJid, { wins: winnerProfile.wins + 1 });
                    const loserProfile = await economy.getProfile(redisClient, loserJid);
                    await economy.updateProfile(redisClient, loserJid, { losses: loserProfile.losses + 1 });

                    await conn.sendMessage(m.from, {
                        text: `🏆 *@${result.winnerJid.split('@')[0]} wins!*\n\n${wordgames.renderTTT(result.session)}\n\n💰 Won ${economy.formatCoins(payout)} coins`,
                        mentions: [result.winnerJid, loserJid]
                    }, { quoted: m });
                    break;
                }

                // placed
                const nextSymbol = result.session.turn;
                const nextJid = nextSymbol === 'X' ? result.session.playerX : result.session.playerO;
                await conn.sendMessage(m.from, {
                    text: `${wordgames.renderTTT(result.session)}\n\n${nextSymbol}'s turn (@${nextJid.split('@')[0]})`,
                    mentions: [nextJid]
                }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // CONNECT 4 (2-player, bet-based)
            // ════════════════════════════════════════════
            case "connect4":
            case "c4": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ Connect 4 only works in groups." }, { quoted: m });
                    break;
                }

                const existingGame = await wordgames.getC4(redisClient, m.from);
                if (existingGame) {
                    await conn.sendMessage(m.from, {
                        text: `⚠️ A Connect 4 game is already in progress in this group.\n\n${wordgames.renderC4(existingGame)}`
                    }, { quoted: m });
                    break;
                }

                const opponent = m.quoted?.sender || m.mentionedJid?.[0];
                const bet = parseInt(args[args.length - 1]);

                if (!opponent || !bet || bet <= 0) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}connect4 @user <bet>` }, { quoted: m });
                    break;
                }
                if (opponent === m.sender) {
                    await conn.sendMessage(m.from, { text: "❌ You can't play against yourself." }, { quoted: m });
                    break;
                }

                const profile = await economy.getProfile(redisClient, m.sender);
                if (profile.coins < bet) {
                    await conn.sendMessage(m.from, { text: `❌ You don't have ${economy.formatCoins(bet)} coins.` }, { quoted: m });
                    break;
                }
                const opponentProfile = await economy.getProfile(redisClient, opponent);
                if (opponentProfile.coins < bet) {
                    await conn.sendMessage(m.from, { text: `❌ @${opponent.split('@')[0]} doesn't have enough coins.`, mentions: [opponent] }, { quoted: m });
                    break;
                }

                await wordgames.createChallenge(redisClient, 'c4', m.from, m.sender, opponent, bet);
                await conn.sendMessage(m.from, {
                    text: `🔴 @${m.sender.split('@')[0]} challenges @${opponent.split('@')[0]} to Connect 4!\n\n💰 Bet: ${economy.formatCoins(bet)} coins each\n⏳ Expires in 60s\n\n@${opponent.split('@')[0]}, type ${prefix}c4accept to play!`,
                    mentions: [m.sender, opponent]
                }, { quoted: m });
                break;
            }

            case "c4accept": {
                if (!isGroup) break;

                const challenge = await wordgames.getChallenge(redisClient, 'c4', m.from);
                if (!challenge || challenge.opponentJid !== m.sender) {
                    await conn.sendMessage(m.from, { text: "❌ No pending Connect 4 challenge for you." }, { quoted: m });
                    break;
                }

                const challengerProfile = await economy.getProfile(redisClient, challenge.challengerJid);
                const opponentProfile = await economy.getProfile(redisClient, m.sender);
                if (challengerProfile.coins < challenge.bet || opponentProfile.coins < challenge.bet) {
                    await conn.sendMessage(m.from, { text: "❌ One of you no longer has enough coins." }, { quoted: m });
                    await wordgames.deleteChallenge(redisClient, 'c4', m.from);
                    break;
                }

                await economy.addCoins(redisClient, challenge.challengerJid, -challenge.bet);
                await economy.addCoins(redisClient, m.sender, -challenge.bet);
                await wordgames.deleteChallenge(redisClient, 'c4', m.from);

                const session = await wordgames.startC4(redisClient, m.from, challenge.challengerJid, m.sender, challenge.bet);
                await conn.sendMessage(m.from, {
                    text: `🔴 *Connect 4 started!*\n\n🔴 @${challenge.challengerJid.split('@')[0]} vs 🟡 @${m.sender.split('@')[0]}\n\n${wordgames.renderC4(session)}\n\n🔴's turn. Use ${prefix}c4move <1-7> to drop.`,
                    mentions: [challenge.challengerJid, m.sender]
                }, { quoted: m });
                break;
            }

            case "c4move": {
                if (!isGroup) break;
                const col = parseInt(args[0]);
                if (!col || col < 1 || col > 7) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}c4move <1-7>` }, { quoted: m });
                    break;
                }

                const result = await wordgames.playC4(redisClient, m.from, m.sender, col - 1);
                if (!result) {
                    await conn.sendMessage(m.from, { text: "❌ No active Connect 4 game. Start one with " + prefix + "connect4 @user <bet>" }, { quoted: m });
                    break;
                }
                if (result.result === 'not_a_player') {
                    await conn.sendMessage(m.from, { text: "❌ You're not part of this game." }, { quoted: m });
                    break;
                }
                if (result.result === 'not_your_turn') {
                    await conn.sendMessage(m.from, { text: "❌ It's not your turn." }, { quoted: m });
                    break;
                }
                if (result.result === 'column_full') {
                    await conn.sendMessage(m.from, { text: "❌ That column is full. Pick another." }, { quoted: m });
                    break;
                }
                if (result.result === 'invalid') {
                    await conn.sendMessage(m.from, { text: "❌ Invalid column." }, { quoted: m });
                    break;
                }

                if (result.result === 'draw') {
                    await economy.addCoins(redisClient, result.session.playerR, result.session.bet);
                    await economy.addCoins(redisClient, result.session.playerY, result.session.bet);
                    await conn.sendMessage(m.from, {
                        text: `🤝 *Draw!* Bets refunded.\n\n${wordgames.renderC4(result.session)}`
                    }, { quoted: m });
                    break;
                }

                if (result.result === 'win') {
                    const loserJid = result.winnerJid === result.session.playerR ? result.session.playerY : result.session.playerR;
                    const payout = result.session.bet * 2;
                    await economy.addCoins(redisClient, result.winnerJid, payout);
                    await giveXp(redisClient, conn, result.winnerJid, m.from, 20);
                    const winnerProfile = await economy.getProfile(redisClient, result.winnerJid);
                    await economy.updateProfile(redisClient, result.winnerJid, { wins: winnerProfile.wins + 1 });
                    const loserProfile = await economy.getProfile(redisClient, loserJid);
                    await economy.updateProfile(redisClient, loserJid, { losses: loserProfile.losses + 1 });

                    await conn.sendMessage(m.from, {
                        text: `🏆 *@${result.winnerJid.split('@')[0]} wins!*\n\n${wordgames.renderC4(result.session)}\n\n💰 Won ${economy.formatCoins(payout)} coins`,
                        mentions: [result.winnerJid, loserJid]
                    }, { quoted: m });
                    break;
                }

                // placed
                const nextSymbol = result.session.turn;
                const nextJid = nextSymbol === 'R' ? result.session.playerR : result.session.playerY;
                await conn.sendMessage(m.from, {
                    text: `${wordgames.renderC4(result.session)}\n\n${nextSymbol === 'R' ? '🔴' : '🟡'}'s turn (@${nextJid.split('@')[0]})`,
                    mentions: [nextJid]
                }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // WORDLE
            // ════════════════════════════════════════════
            case "wordle": {
                const existing = await wordgames.getWordle(redisClient, m.from, m.sender);
                if (existing) {
                    await conn.sendMessage(m.from, {
                        text: `⚠️ You already have a Wordle in progress!\n\n${wordgames.renderWordleBoard(existing)}\n\nGuess ${existing.guesses.length + 1}/${wordgames.WORDLE_MAX_GUESSES}. Use ${prefix}wordleguess <word>`
                    }, { quoted: m });
                    break;
                }

                await wordgames.startWordle(redisClient, m.from, m.sender);
                await conn.sendMessage(m.from, {
                    text: `🟩 *WORDLE*\n\nGuess the 5-letter word in ${wordgames.WORDLE_MAX_GUESSES} tries!\n🟩 = right letter, right spot\n🟨 = right letter, wrong spot\n⬛ = not in the word\n\nUse ${prefix}wordleguess <word> to guess.`
                }, { quoted: m });
                break;
            }

            case "wordleguess": {
                const guess = args[0]?.toLowerCase();
                if (!guess) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}wordleguess <5-letter word>` }, { quoted: m });
                    break;
                }

                const result = await wordgames.guessWordle(redisClient, m.from, m.sender, guess);
                if (!result) {
                    await conn.sendMessage(m.from, { text: `❌ No active Wordle game. Start one with ${prefix}wordle` }, { quoted: m });
                    break;
                }
                if (result.result === 'invalid') {
                    await conn.sendMessage(m.from, { text: `❌ Must be a 5-letter word (letters only).` }, { quoted: m });
                    break;
                }

                if (result.result === 'win') {
                    const reward = wordgames.WORDLE_REWARD_COINS[result.guessNumber] || 50;
                    await economy.addCoins(redisClient, m.sender, reward);
                    await giveXp(redisClient, conn, m.sender, m.from, wordgames.WORDLE_REWARD_XP);
                    await conn.sendMessage(m.from, {
                        text: `🎉 *Solved in ${result.guessNumber}/${wordgames.WORDLE_MAX_GUESSES}!*\n\n${wordgames.renderWordleBoard(result.session)}\n\n💰 +${economy.formatCoins(reward)} coins\n⭐ +${wordgames.WORDLE_REWARD_XP} XP`
                    }, { quoted: m });
                    break;
                }

                if (result.result === 'lose') {
                    await conn.sendMessage(m.from, {
                        text: `💀 *Out of guesses!*\n\nThe word was: *${result.session.word.toUpperCase()}*\n\n${wordgames.renderWordleBoard(result.session)}`
                    }, { quoted: m });
                    break;
                }

                // continue
                await conn.sendMessage(m.from, {
                    text: `${wordgames.renderWordleBoard(result.session)}\n\nGuess ${result.session.guesses.length + 1}/${wordgames.WORDLE_MAX_GUESSES}`
                }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // TYPING RACE
            // ════════════════════════════════════════════
            case "typingrace":
            case "typerace": {
                const existing = await wordgames.getTyping(redisClient, m.from, m.sender);
                if (existing) {
                    await conn.sendMessage(m.from, {
                        text: `⚠️ You already have a typing race running!\n\n📝 "${existing.sentence}"\n\nUse ${prefix}type <text> to submit.`
                    }, { quoted: m });
                    break;
                }

                const session = await wordgames.startTyping(redisClient, m.from, m.sender);
                await conn.sendMessage(m.from, {
                    text: `⌨️ *TYPING RACE*\n\nType this EXACTLY, as fast as you can:\n\n📝 "${session.sentence}"\n\nUse ${prefix}type <your text> to submit. You have 60 seconds!`
                }, { quoted: m });
                break;
            }

            case "type": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}type <text>` }, { quoted: m });
                    break;
                }

                const result = await wordgames.submitTyping(redisClient, m.from, m.sender, text);
                if (!result) {
                    await conn.sendMessage(m.from, { text: `❌ No active typing race. Start one with ${prefix}typingrace` }, { quoted: m });
                    break;
                }

                if (!result.correct) {
                    await conn.sendMessage(m.from, {
                        text: `❌ *Not quite!*\n\nExpected: "${result.session.sentence}"\nYou typed: "${text}"\nAccuracy: ${result.accuracy}%\n\nTry ${prefix}typingrace again!`
                    }, { quoted: m });
                    break;
                }

                let tier, reward;
                if (result.wpm >= 60) { tier = '🏆 Incredible'; reward = 400; }
                else if (result.wpm >= 40) { tier = '🥇 Great'; reward = 250; }
                else if (result.wpm >= 25) { tier = '🥈 Good'; reward = 150; }
                else { tier = '🥉 Decent'; reward = 75; }

                await economy.addCoins(redisClient, m.sender, reward);
                await giveXp(redisClient, conn, m.sender, m.from, 10);

                await conn.sendMessage(m.from, {
                    text: `✅ *Correct!* ${tier}\n\n⏱️ Time: ${result.elapsedSec.toFixed(1)}s\n⌨️ Speed: ${result.wpm} WPM\n\n💰 +${economy.formatCoins(reward)} coins\n⭐ +10 XP`
                }, { quoted: m });
                break;
            }

            case "guess":
            case "guessnumber": {
                const bet = parseInt(args[0]);
                const guess = parseInt(args[1]);

                if (!bet || bet <= 0 || !guess || guess < 1 || guess > 10) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}guess <amount> <1-10>\n\nGuess the number correctly to win 8x your bet!` }, { quoted: m });
                    break;
                }

                const profile = await economy.getProfile(redisClient, m.sender);
                if (profile.coins < bet) {
                    await conn.sendMessage(m.from, { text: `❌ You don't have ${economy.formatCoins(bet)} coins.` }, { quoted: m });
                    break;
                }

                const answer = Math.floor(Math.random() * 10) + 1;

                if (guess === answer) {
                    const winnings = bet * 8;
                    await economy.addCoins(redisClient, m.sender, winnings);
                    await economy.updateProfile(redisClient, m.sender, { wins: profile.wins + 1 });
                    await conn.sendMessage(m.from, { text: `🎯 The number was *${answer}*!\n\n🎉 CORRECT! You won ${economy.formatCoins(winnings)} coins! (8x)` }, { quoted: m });
                } else {
                    await economy.addCoins(redisClient, m.sender, -bet);
                    await economy.updateProfile(redisClient, m.sender, { losses: profile.losses + 1 });
                    await conn.sendMessage(m.from, { text: `🎯 The number was *${answer}*. You guessed *${guess}*.\n\n❌ You lost ${economy.formatCoins(bet)} coins.` }, { quoted: m });
                }
                break;
            }


            case "slots": {
                const bet = parseInt(args[0]);
                if (!bet || bet <= 0) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}slots <amount>` }, { quoted: m });
                    break;
                }

                const profile = await economy.getProfile(redisClient, m.sender);
                if (profile.coins < bet) {
                    await conn.sendMessage(m.from, { text: `❌ You don't have ${economy.formatCoins(bet)} coins.` }, { quoted: m });
                    break;
                }

                const symbols = ['🍒', '🍋', '🍊', '🍇', '⭐', '💎', '7️⃣'];
                const weights = [30, 25, 20, 15, 6, 3, 1]; // weighted rarity
                const totalWeight = weights.reduce((a, b) => a + b, 0);

                function spinSlot() {
                    let r = Math.random() * totalWeight;
                    for (let i = 0; i < symbols.length; i++) {
                        r -= weights[i];
                        if (r <= 0) return symbols[i];
                    }
                    return symbols[0];
                }

                const s1 = spinSlot(), s2 = spinSlot(), s3 = spinSlot();
                const result = `${s1} ${s2} ${s3}`;

                let multiplier = 0;
                let message = '';

                if (s1 === s2 && s2 === s3) {
                    if (s1 === '7️⃣') { multiplier = 50; message = '🎰 JACKPOT! 7️⃣7️⃣7️⃣'; }
                    else if (s1 === '💎') { multiplier = 20; message = '💎 DIAMOND HIT!'; }
                    else if (s1 === '⭐') { multiplier = 10; message = '⭐ STAR MATCH!'; }
                    else { multiplier = 5; message = '✅ THREE OF A KIND!'; }
                } else if (s1 === s2 || s2 === s3 || s1 === s3) {
                    multiplier = 2;
                    message = '👌 Two of a kind!';
                } else {
                    multiplier = 0;
                    message = '❌ No match.';
                }

                if (multiplier > 0) {
                    const winnings = bet * multiplier;
                    await economy.addCoins(redisClient, m.sender, winnings - bet);
                    await economy.updateProfile(redisClient, m.sender, { wins: profile.wins + 1 });
                    await conn.sendMessage(m.from, { text: `🎰 *SLOTS*\n\n[ ${result} ]\n\n${message}\nYou won ${economy.formatCoins(winnings)} coins! (${multiplier}x)` }, { quoted: m });
                } else {
                    await economy.addCoins(redisClient, m.sender, -bet);
                    await economy.updateProfile(redisClient, m.sender, { losses: profile.losses + 1 });
                    await conn.sendMessage(m.from, { text: `🎰 *SLOTS*\n\n[ ${result} ]\n\n${message}\nYou lost ${economy.formatCoins(bet)} coins.` }, { quoted: m });
                }
                break;
            }

            case "blackjack":
            case "bj": {
                const bet = parseInt(args[0]);
                if (!bet || bet <= 0) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}blackjack <amount>` }, { quoted: m });
                    break;
                }

                const profile = await economy.getProfile(redisClient, m.sender);
                if (profile.coins < bet) {
                    await conn.sendMessage(m.from, { text: `❌ You don't have ${economy.formatCoins(bet)} coins.` }, { quoted: m });
                    break;
                }

                const deck = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
                const vals = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':10,'Q':10,'K':10,'A':11 };

                function draw() { return deck[Math.floor(Math.random() * deck.length)]; }
                function handValue(hand) {
                    let total = hand.reduce((s, c) => s + vals[c], 0);
                    let aces = hand.filter(c => c === 'A').length;
                    while (total > 21 && aces > 0) { total -= 10; aces--; }
                    return total;
                }

                const playerHand = [draw(), draw()];
                const dealerHand = [draw(), draw()];

                let playerVal = handValue(playerHand);
                let dealerVal = handValue(dealerHand);

                // Auto-draw for dealer until 17+
                while (dealerVal < 17) { dealerHand.push(draw()); dealerVal = handValue(dealerHand); }

                const playerStr = playerHand.join(' ');
                const dealerStr = dealerHand.join(' ');

                let outcome = '';
                let won = false;
                let push = false;

                if (playerVal > 21) { outcome = `💥 You busted (${playerVal})! Dealer wins.`; }
                else if (dealerVal > 21) { outcome = `✅ Dealer busted (${dealerVal})! You win!`; won = true; }
                else if (playerVal > dealerVal) { outcome = `✅ You win! ${playerVal} vs ${dealerVal}`; won = true; }
                else if (playerVal < dealerVal) { outcome = `❌ Dealer wins! ${dealerVal} vs ${playerVal}`; }
                else { outcome = `🤝 Push! ${playerVal} vs ${dealerVal}`; push = true; }

                if (won) {
                    await economy.addCoins(redisClient, m.sender, bet);
                    await economy.updateProfile(redisClient, m.sender, { wins: profile.wins + 1 });
                } else if (!push) {
                    await economy.addCoins(redisClient, m.sender, -bet);
                    await economy.updateProfile(redisClient, m.sender, { losses: profile.losses + 1 });
                }

                await conn.sendMessage(m.from, {
                    text: `🃏 *BLACKJACK*\n\nYour hand: ${playerStr} (${playerVal})\nDealer: ${dealerStr} (${dealerVal})\n\n${outcome}`
                }, { quoted: m });
                break;
            }

            case "rps": {
                const bet = parseInt(args[0]);
                const choice = args[1]?.toLowerCase();
                const valid = ['rock', 'paper', 'scissors'];

                if (!bet || bet <= 0 || !valid.includes(choice)) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}rps <amount> <rock/paper/scissors>` }, { quoted: m });
                    break;
                }

                const profile = await economy.getProfile(redisClient, m.sender);
                if (profile.coins < bet) {
                    await conn.sendMessage(m.from, { text: `❌ You don't have ${economy.formatCoins(bet)} coins.` }, { quoted: m });
                    break;
                }

                const botChoice = valid[Math.floor(Math.random() * 3)];
                const emojis = { rock: '🪨', paper: '📄', scissors: '✂️' };

                let result = '';
                let won = false;
                let tie = false;

                if (choice === botChoice) { result = '🤝 It\'s a tie!'; tie = true; }
                else if (
                    (choice === 'rock' && botChoice === 'scissors') ||
                    (choice === 'paper' && botChoice === 'rock') ||
                    (choice === 'scissors' && botChoice === 'paper')
                ) { result = `✅ You win! ${emojis[choice]} beats ${emojis[botChoice]}`; won = true; }
                else { result = `❌ Bot wins! ${emojis[botChoice]} beats ${emojis[choice]}`; }

                if (won) {
                    await economy.addCoins(redisClient, m.sender, bet);
                    await economy.updateProfile(redisClient, m.sender, { wins: profile.wins + 1 });
                } else if (!tie) {
                    await economy.addCoins(redisClient, m.sender, -bet);
                    await economy.updateProfile(redisClient, m.sender, { losses: profile.losses + 1 });
                }

                await conn.sendMessage(m.from, {
                    text: `✂️ *ROCK PAPER SCISSORS*\n\nYou: ${emojis[choice]} ${choice}\nBot: ${emojis[botChoice]} ${botChoice}\n\n${result}`
                }, { quoted: m });
                break;
            }

            case "trivia": {
                const questions = [
                    { q: "What is the capital of Nigeria?", a: "abuja", opts: "Abuja / Lagos / Kano / Ibadan" },
                    { q: "What is 15 × 15?", a: "225", opts: "225 / 250 / 215 / 205" },
                    { q: "Who created WhatsApp?", a: "jan koum", opts: "Jan Koum / Mark Zuckerberg / Jack Dorsey / Bill Gates" },
                    { q: "What year was Bitcoin created?", a: "2009", opts: "2009 / 2010 / 2008 / 2012" },
                    { q: "How many continents are there?", a: "7", opts: "7 / 6 / 5 / 8" },
                    { q: "What is the largest planet?", a: "jupiter", opts: "Jupiter / Saturn / Mars / Neptune" },
                    { q: "Who wrote Romeo and Juliet?", a: "shakespeare", opts: "Shakespeare / Dickens / Hemingway / Austen" },
                    { q: "What is H2O?", a: "water", opts: "Water / Oxygen / Hydrogen / Salt" },
                    { q: "How many sides does a hexagon have?", a: "6", opts: "5 / 6 / 7 / 8" },
                    { q: "What colour is the sun?", a: "white", opts: "Yellow / Orange / White / Red" }
                ];

                const q = questions[Math.floor(Math.random() * questions.length)];
                const bet = parseInt(args[0]) || 0;

                if (bet > 0) {
                    const profile = await economy.getProfile(redisClient, m.sender);
                    if (profile.coins < bet) {
                        await conn.sendMessage(m.from, { text: `❌ You don't have ${economy.formatCoins(bet)} coins.` }, { quoted: m });
                        break;
                    }
                }

                // Store active trivia in Redis (expires in 60s)
                const triviaKey = `trivia:${m.from}:${m.sender}`;
                await redisClient.set(triviaKey, JSON.stringify({ answer: q.a, bet, timestamp: Date.now() }), { EX: 60 });

                await conn.sendMessage(m.from, {
                    text: `❓ *TRIVIA*${bet > 0 ? ` — Bet: ${economy.formatCoins(bet)} coins` : ''}\n\n${q.q}\n\nOptions: ${q.opts}\n\nType ${prefix}answer <your answer> within 60 seconds!`
                }, { quoted: m });
                break;
            }

            case "answer": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}answer <your answer>` }, { quoted: m });
                    break;
                }

                const triviaKey = `trivia:${m.from}:${m.sender}`;
                const raw = await redisClient.get(triviaKey);

                if (!raw) {
                    await conn.sendMessage(m.from, { text: "❌ No active trivia found. Start one with .trivia" }, { quoted: m });
                    break;
                }

                const { answer, bet } = JSON.parse(raw);
                await redisClient.del(triviaKey);

                const correct = text.toLowerCase().trim().includes(answer.toLowerCase());
                const profile = await economy.getProfile(redisClient, m.sender);

                if (correct) {
                    const reward = bet > 0 ? bet * 2 : 200;
                    await economy.addCoins(redisClient, m.sender, reward);
                    await giveXp(redisClient, conn, m.sender, m.from, 15);
                    await economy.updateProfile(redisClient, m.sender, { wins: profile.wins + 1 });
                    await conn.sendMessage(m.from, { text: `✅ *CORRECT!*\n\n+${economy.formatCoins(reward)} coins\n+15 XP` }, { quoted: m });
                } else {
                    if (bet > 0) {
                        await economy.addCoins(redisClient, m.sender, -bet);
                        await economy.updateProfile(redisClient, m.sender, { losses: profile.losses + 1 });
                    }
                    await conn.sendMessage(m.from, { text: `❌ Wrong! The answer was: *${answer}*${bet > 0 ? `\n-${economy.formatCoins(bet)} coins` : ''}` }, { quoted: m });
                }
                break;
            }

            case "luckywheeel":
            case "wheel":
            case "spin": {
                const bet = parseInt(args[0]);
                if (!bet || bet <= 0) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}spin <amount>` }, { quoted: m });
                    break;
                }

                const profile = await economy.getProfile(redisClient, m.sender);
                if (profile.coins < bet) {
                    await conn.sendMessage(m.from, { text: `❌ You don't have ${economy.formatCoins(bet)} coins.` }, { quoted: m });
                    break;
                }

                const segments = [
                    { label: '💀 BANKRUPT', mult: 0 },
                    { label: '0.5x', mult: 0.5 },
                    { label: '1.5x', mult: 1.5 },
                    { label: '2x', mult: 2 },
                    { label: '0.5x', mult: 0.5 },
                    { label: '3x 🔥', mult: 3 },
                    { label: '1x', mult: 1 },
                    { label: '5x ⭐', mult: 5 },
                ];

                const weights = [5, 20, 20, 20, 20, 10, 15, 5];
                const total = weights.reduce((a, b) => a + b, 0);
                let r = Math.random() * total;
                let segment = segments[0];

                for (let i = 0; i < segments.length; i++) {
                    r -= weights[i];
                    if (r <= 0) { segment = segments[i]; break; }
                }

                const winnings = Math.floor(bet * segment.mult);
                const diff = winnings - bet;

                await economy.addCoins(redisClient, m.sender, diff);
                if (diff > 0) await economy.updateProfile(redisClient, m.sender, { wins: profile.wins + 1 });
                else if (diff < 0) await economy.updateProfile(redisClient, m.sender, { losses: profile.losses + 1 });

                const resultLine = winnings === 0
                    ? `💀 BANKRUPT! You lost all ${economy.formatCoins(bet)} coins!`
                    : diff > 0
                        ? `✅ Won ${economy.formatCoins(winnings)} coins! (+${economy.formatCoins(diff)})`
                        : `❌ Got back ${economy.formatCoins(winnings)} coins. (-${economy.formatCoins(Math.abs(diff))})`;

                await conn.sendMessage(m.from, {
                    text: `🎡 *LUCKY WHEEL*\n\nSpinning...\n🎰 You landed on: *${segment.label}*\n\n${resultLine}`
                }, { quoted: m });
                break;
            }

            // ── Admin economy commands (owner/sudo only) ──
            case "addcoins": {
                if (!senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Owner/Sudo only command." }, { quoted: m });
                    break;
                }

                const target = m.quoted?.sender || m.mentionedJid?.[0];
                const amount = parseInt(args[args.length - 1]);

                if (!target || !amount) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}addcoins @user <amount>` }, { quoted: m });
                    break;
                }

                const newBal = await economy.addCoins(redisClient, target, amount);
                await conn.sendMessage(m.from, {
                    text: `✅ Added ${economy.formatCoins(amount)} coins to @${target.split('@')[0]}\nNew balance: ${economy.formatCoins(newBal)}`,
                    mentions: [target]
                }, { quoted: m });
                break;
            }

            case "removecoins": {
                if (!senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Owner/Sudo only command." }, { quoted: m });
                    break;
                }

                const target = m.quoted?.sender || m.mentionedJid?.[0];
                const amount = parseInt(args[args.length - 1]);

                if (!target || !amount) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}removecoins @user <amount>` }, { quoted: m });
                    break;
                }

                const newBal = await economy.addCoins(redisClient, target, -amount);
                await conn.sendMessage(m.from, {
                    text: `✅ Removed ${economy.formatCoins(amount)} coins from @${target.split('@')[0]}\nNew balance: ${economy.formatCoins(newBal)}`,
                    mentions: [target]
                }, { quoted: m });
                break;
            }

            case "reseteconomy": {
                if (!senderIsOwner) {
                    await conn.sendMessage(m.from, { text: "❌ Owner only command." }, { quoted: m });
                    break;
                }

                const target = m.quoted?.sender || m.mentionedJid?.[0] || m.sender;
                await redisClient.del(`economy:${target}`);
                await conn.sendMessage(m.from, {
                    text: `✅ Economy reset for @${target.split('@')[0]}`,
                    mentions: [target]
                }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // FISHING
            // ════════════════════════════════════════════
            case "fish": {
                const profile = await economy.getProfile(redisClient, m.sender);
                const cooldown = 5 * 60 * 1000; // 5 min
                const lastFish = parseInt(await redisClient.hGet(`economy:${m.sender}`, 'lastFish') || '0');
                const remaining = economy.cooldownRemaining(lastFish, cooldown);

                if (remaining > 0) {
                    await conn.sendMessage(m.from, { text: `🎣 Wait ${economy.formatDuration(remaining)} before fishing again.` }, { quoted: m });
                    break;
                }

                const rod = await redisClient.hGet(`economy:${m.sender}`, 'equippedRod') || 'basic';
                const rodData = rpg.RODS[rod] || rpg.RODS.basic;
                const caught = rpg.pickFish(rodData.bonus);

                await redisClient.hSet(`economy:${m.sender}`, 'lastFish', String(Date.now()));

                if (caught.rarity === 'junk') {
                    await conn.sendMessage(m.from, { text: `🎣 You cast your line...\n\n${caught.emoji} You caught an *${caught.name}*! Worthless. 😒\n\nRod: ${rodData.name}` }, { quoted: m });
                    break;
                }

                await economy.addCoins(redisClient, m.sender, caught.value);
                await giveXp(redisClient, conn, m.sender, m.from, 5);
                await rpg.addToInventory(redisClient, m.sender, `fish_${caught.name.toLowerCase().replace(/ /g,'_')}`, 1);

                await conn.sendMessage(m.from, {
                    text: `🎣 You cast your line...\n\n${caught.emoji} You caught a *${caught.name}*! (${caught.rarity.toUpperCase()})\n💰 +${economy.formatCoins(caught.value)} coins\n⭐ +5 XP\n\nRod: ${rodData.name}`
                }, { quoted: m });
                break;
            }

            case "buyrod": {
                const rodKey = args[0]?.toLowerCase();
                const rodData = rpg.RODS[rodKey];

                if (!rodKey || !rodData) {
                    const list = Object.entries(rpg.RODS).map(([k, r]) =>
                        `• ${r.name} (${k}) — ${r.price === 0 ? 'Free (starter)' : economy.formatCoins(r.price) + ' coins'}`
                    ).join('\n');
                    await conn.sendMessage(m.from, { text: `🎣 *Fishing Rods*\n\n${list}\n\nUsage: ${prefix}buyrod <name>` }, { quoted: m });
                    break;
                }

                if (rodData.price === 0) {
                    await conn.sendMessage(m.from, { text: `❌ You already have the ${rodData.name} (it's free).` }, { quoted: m });
                    break;
                }

                const profile = await economy.getProfile(redisClient, m.sender);
                if (profile.coins < rodData.price) {
                    await conn.sendMessage(m.from, { text: `❌ You need ${economy.formatCoins(rodData.price)} coins. You have ${economy.formatCoins(profile.coins)}.` }, { quoted: m });
                    break;
                }

                await economy.addCoins(redisClient, m.sender, -rodData.price);
                await redisClient.hSet(`economy:${m.sender}`, 'equippedRod', rodKey);
                await conn.sendMessage(m.from, { text: `✅ Bought and equipped *${rodData.name}*!\n-${economy.formatCoins(rodData.price)} coins` }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // MINING
            // ════════════════════════════════════════════
            case "mine": {
                const lastMine = parseInt(await redisClient.hGet(`economy:${m.sender}`, 'lastMine') || '0');
                const cooldown = 5 * 60 * 1000;
                const remaining = economy.cooldownRemaining(lastMine, cooldown);

                if (remaining > 0) {
                    await conn.sendMessage(m.from, { text: `⛏️ Wait ${economy.formatDuration(remaining)} before mining again.` }, { quoted: m });
                    break;
                }

                const pick = await redisClient.hGet(`economy:${m.sender}`, 'equippedPick') || 'wooden';
                const pickData = rpg.PICKS[pick] || rpg.PICKS.wooden;
                const ore = rpg.pickOre(pickData.bonus);

                await redisClient.hSet(`economy:${m.sender}`, 'lastMine', String(Date.now()));
                await economy.addCoins(redisClient, m.sender, ore.value);
                await giveXp(redisClient, conn, m.sender, m.from, 6);
                await rpg.addToInventory(redisClient, m.sender, `ore_${ore.name.toLowerCase()}`, 1);

                await conn.sendMessage(m.from, {
                    text: `⛏️ You swing your pickaxe...\n\n${ore.emoji} Found *${ore.name}*! (${ore.rarity.toUpperCase()})\n💰 +${economy.formatCoins(ore.value)} coins\n⭐ +6 XP\n\nPickaxe: ${pickData.name}`
                }, { quoted: m });
                break;
            }

            case "buypick": {
                const pickKey = args[0]?.toLowerCase();
                const pickData = rpg.PICKS[pickKey];

                if (!pickKey || !pickData) {
                    const list = Object.entries(rpg.PICKS).map(([k, p]) =>
                        `• ${p.name} (${k}) — ${p.price === 0 ? 'Free (starter)' : economy.formatCoins(p.price) + ' coins'}`
                    ).join('\n');
                    await conn.sendMessage(m.from, { text: `⛏️ *Pickaxes*\n\n${list}\n\nUsage: ${prefix}buypick <name>` }, { quoted: m });
                    break;
                }

                if (pickData.price === 0) {
                    await conn.sendMessage(m.from, { text: `❌ You already have the ${pickData.name}.` }, { quoted: m });
                    break;
                }

                const profile = await economy.getProfile(redisClient, m.sender);
                if (profile.coins < pickData.price) {
                    await conn.sendMessage(m.from, { text: `❌ You need ${economy.formatCoins(pickData.price)} coins.` }, { quoted: m });
                    break;
                }

                await economy.addCoins(redisClient, m.sender, -pickData.price);
                await redisClient.hSet(`economy:${m.sender}`, 'equippedPick', pickKey);
                await conn.sendMessage(m.from, { text: `✅ Bought and equipped *${pickData.name}*!\n-${economy.formatCoins(pickData.price)} coins` }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // FARMING
            // ════════════════════════════════════════════
            case "plant": {
                const cropKey = args[0]?.toLowerCase();
                const crop = rpg.CROPS.find(c => c.name.toLowerCase() === cropKey);

                if (!cropKey || !crop) {
                    const list = rpg.CROPS.map(c =>
                        `• ${c.emoji} ${c.name} — ${economy.formatCoins(c.cost)} coins | grows in ${economy.formatDuration(c.growMs)} | sells for ${economy.formatCoins(c.value)}`
                    ).join('\n');
                    await conn.sendMessage(m.from, { text: `🌾 *Available Crops*\n\n${list}\n\nUsage: ${prefix}plant <crop>` }, { quoted: m });
                    break;
                }

                const farmKey = `farm:${m.sender}`;
                const existing = await redisClient.hGet(farmKey, 'planted');
                if (existing) {
                    const farm = JSON.parse(existing);
                    if (Date.now() < farm.harvestAt) {
                        await conn.sendMessage(m.from, { text: `❌ You already have ${farm.crop.emoji} *${farm.crop.name}* growing!\n\nHarvest in ${economy.formatDuration(farm.harvestAt - Date.now())}` }, { quoted: m });
                        break;
                    }
                }

                const profile = await economy.getProfile(redisClient, m.sender);
                if (profile.coins < crop.cost) {
                    await conn.sendMessage(m.from, { text: `❌ You need ${economy.formatCoins(crop.cost)} coins to plant ${crop.name}.` }, { quoted: m });
                    break;
                }

                await economy.addCoins(redisClient, m.sender, -crop.cost);
                await redisClient.hSet(farmKey, 'planted', JSON.stringify({
                    crop,
                    plantedAt: Date.now(),
                    harvestAt: Date.now() + crop.growMs
                }));

                await conn.sendMessage(m.from, {
                    text: `🌱 You planted *${crop.name}* ${crop.emoji}!\n-${economy.formatCoins(crop.cost)} coins\n\nReady to harvest in ${economy.formatDuration(crop.growMs)}`
                }, { quoted: m });
                break;
            }

            case "harvest": {
                const farmKey = `farm:${m.sender}`;
                const existing = await redisClient.hGet(farmKey, 'planted');

                if (!existing) {
                    await conn.sendMessage(m.from, { text: `❌ You don't have anything planted. Use ${prefix}plant <crop>` }, { quoted: m });
                    break;
                }

                const farm = JSON.parse(existing);
                if (Date.now() < farm.harvestAt) {
                    await conn.sendMessage(m.from, { text: `⏳ *${farm.crop.name}* isn't ready yet!\n\nHarvest in ${economy.formatDuration(farm.harvestAt - Date.now())}` }, { quoted: m });
                    break;
                }

                await redisClient.hDel(farmKey, 'planted');
                await economy.addCoins(redisClient, m.sender, farm.crop.value);
                await giveXp(redisClient, conn, m.sender, m.from, 8);

                await conn.sendMessage(m.from, {
                    text: `🌾 You harvested *${farm.crop.name}* ${farm.crop.emoji}!\n\n💰 +${economy.formatCoins(farm.crop.value)} coins\n⭐ +8 XP`
                }, { quoted: m });
                break;
            }

            case "farm": {
                const farmKey = `farm:${m.sender}`;
                const existing = await redisClient.hGet(farmKey, 'planted');

                if (!existing) {
                    await conn.sendMessage(m.from, { text: `🌾 Your farm is empty.\n\nUse ${prefix}plant <crop> to start farming.` }, { quoted: m });
                    break;
                }

                const farm = JSON.parse(existing);
                const ready = Date.now() >= farm.harvestAt;

                await conn.sendMessage(m.from, {
                    text: `🌾 *Your Farm*\n\n${farm.crop.emoji} ${farm.crop.name}\nPlanted: ${new Date(farm.plantedAt).toLocaleTimeString()}\n${ready ? '✅ READY TO HARVEST!' : `⏳ Ready in ${economy.formatDuration(farm.harvestAt - Date.now())}`}`
                }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // HUNTING
            // ════════════════════════════════════════════
            case "hunt": {
                const lastHunt = parseInt(await redisClient.hGet(`economy:${m.sender}`, 'lastHunt') || '0');
                const cooldown = 10 * 60 * 1000; // 10 min
                const remaining = economy.cooldownRemaining(lastHunt, cooldown);

                if (remaining > 0) {
                    await conn.sendMessage(m.from, { text: `🏹 Wait ${economy.formatDuration(remaining)} before hunting again.` }, { quoted: m });
                    break;
                }

                await redisClient.hSet(`economy:${m.sender}`, 'lastHunt', String(Date.now()));
                const animal = rpg.pickAnimal();

                if (animal.value === 0) {
                    await conn.sendMessage(m.from, { text: `🏹 You searched the forest...\n\n🌿 Nothing found this time. Better luck next hunt!` }, { quoted: m });
                    break;
                }

                await economy.addCoins(redisClient, m.sender, animal.value);
                await giveXp(redisClient, conn, m.sender, m.from, 7);

                await conn.sendMessage(m.from, {
                    text: `🏹 You entered the forest...\n\n${animal.emoji} You hunted a *${animal.name}*!\n💰 +${economy.formatCoins(animal.value)} coins\n⭐ +7 XP`
                }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // PETS
            // ════════════════════════════════════════════
            case "buypet": {
                const petId = args[0]?.toLowerCase();
                const pet = rpg.PETS.find(p => p.id === petId);

                if (!petId || !pet) {
                    const list = rpg.PETS.map(p =>
                        `• ${p.emoji} ${p.name} (${p.id}) — ${economy.formatCoins(p.price)} coins | +${(p.xpBonus * 100).toFixed(0)}% XP bonus`
                    ).join('\n');
                    await conn.sendMessage(m.from, { text: `🐾 *Available Pets*\n\n${list}\n\nUsage: ${prefix}buypet <id>` }, { quoted: m });
                    break;
                }

                const profile = await economy.getProfile(redisClient, m.sender);
                if (profile.coins < pet.price) {
                    await conn.sendMessage(m.from, { text: `❌ You need ${economy.formatCoins(pet.price)} coins.` }, { quoted: m });
                    break;
                }

                const existingPet = await redisClient.hGet(`economy:${m.sender}`, 'pet');
                if (existingPet) {
                    const owned = JSON.parse(existingPet);
                    await conn.sendMessage(m.from, { text: `❌ You already have a ${owned.emoji} *${owned.name}*. You can only have one pet at a time.` }, { quoted: m });
                    break;
                }

                await economy.addCoins(redisClient, m.sender, -pet.price);
                await redisClient.hSet(`economy:${m.sender}`, 'pet', JSON.stringify({ ...pet, level: 1, xp: 0, lastFed: Date.now() }));

                await conn.sendMessage(m.from, { text: `🐾 You adopted a ${pet.emoji} *${pet.name}*!\n-${economy.formatCoins(pet.price)} coins\n\nTake good care of it with ${prefix}feedpet!` }, { quoted: m });
                break;
            }

            case "mypet":
            case "pet": {
                const petRaw = await redisClient.hGet(`economy:${m.sender}`, 'pet');

                if (!petRaw) {
                    await conn.sendMessage(m.from, { text: `🐾 You don't have a pet.\n\nBuy one with ${prefix}buypet` }, { quoted: m });
                    break;
                }

                const pet = JSON.parse(petRaw);
                const lastFed = pet.lastFed || 0;
                const hungry = Date.now() - lastFed > 6 * 60 * 60 * 1000; // hungry after 6h

                await conn.sendMessage(m.from, {
                    text: `${pet.emoji} *${pet.name}*\n\nLevel: ${pet.level}\nXP: ${pet.xp}\nXP Bonus: +${(pet.xpBonus * 100).toFixed(0)}%\nStatus: ${hungry ? '😢 Hungry!' : '😊 Happy'}\n\n${hungry ? `Feed with ${prefix}feedpet` : ''}`
                }, { quoted: m });
                break;
            }

            case "feedpet": {
                const petRaw = await redisClient.hGet(`economy:${m.sender}`, 'pet');

                if (!petRaw) {
                    await conn.sendMessage(m.from, { text: `❌ You don't have a pet.` }, { quoted: m });
                    break;
                }

                const pet = JSON.parse(petRaw);
                const cooldown = 3 * 60 * 60 * 1000; // feed every 3h
                const remaining = economy.cooldownRemaining(pet.lastFed || 0, cooldown);

                if (remaining > 0) {
                    await conn.sendMessage(m.from, { text: `🍖 ${pet.emoji} ${pet.name} is still full.\n\nFeed again in ${economy.formatDuration(remaining)}.` }, { quoted: m });
                    break;
                }

                const profile = await economy.getProfile(redisClient, m.sender);
                const feedCost = 50;
                if (profile.coins < feedCost) {
                    await conn.sendMessage(m.from, { text: `❌ Feeding costs ${feedCost} coins. You're broke!` }, { quoted: m });
                    break;
                }

                pet.xp += 10;
                if (pet.xp >= pet.level * 50) {
                    pet.xp -= pet.level * 50;
                    pet.level++;
                    pet.xpBonus = Math.min(pet.xpBonus + 0.05, 2.0); // cap at 200% bonus
                }
                pet.lastFed = Date.now();

                await economy.addCoins(redisClient, m.sender, -feedCost);
                await redisClient.hSet(`economy:${m.sender}`, 'pet', JSON.stringify(pet));

                await conn.sendMessage(m.from, {
                    text: `🍖 You fed ${pet.emoji} *${pet.name}*!\n-${feedCost} coins\n+10 pet XP\n\nPet is now Level ${pet.level}`
                }, { quoted: m });
                break;
            }

            case "sellpet": {
                const petRaw = await redisClient.hGet(`economy:${m.sender}`, 'pet');

                if (!petRaw) {
                    await conn.sendMessage(m.from, { text: `❌ You don't have a pet.` }, { quoted: m });
                    break;
                }

                const pet = JSON.parse(petRaw);
                const sellValue = Math.floor(pet.price * 0.5);

                await redisClient.hDel(`economy:${m.sender}`, 'pet');
                await economy.addCoins(redisClient, m.sender, sellValue);

                await conn.sendMessage(m.from, { text: `💔 You sold ${pet.emoji} *${pet.name}* for ${economy.formatCoins(sellValue)} coins.` }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // INVENTORY
            // ════════════════════════════════════════════
            case "inventory":
            case "inv": {
                const inv = await rpg.getInventory(redisClient, m.sender);
                const keys = Object.keys(inv);

                const itemLines = keys.length
                    ? keys.map(k => {
                        const name = k.replace(/_/g, ' ').replace(/^(fish|ore) /, '').trim();
                        return `• ${name}: x${inv[k]}`;
                    })
                    : ['Empty'];

                // ── Shop cosmetics & boosts, merged into the same inventory view ──
                const titles = await shop.getOwnedList(redisClient, m.sender, 'titles');
                const themes = await shop.getOwnedList(redisClient, m.sender, 'themes');
                const tokens = await shop.getReviveTokens(redisClient, m.sender);
                const equippedTitle = await shop.getEquipped(redisClient, m.sender, 'equippedTitle');
                const equippedTheme = await shop.getEquipped(redisClient, m.sender, 'equippedTheme');
                const xpBoost = await shop.getActiveBoost(redisClient, m.sender, 'xpBoost');
                const luckBoost = await shop.getActiveBoost(redisClient, m.sender, 'luckBoost');

                const titleNames = titles.map(id => shop.findItem(shop.TITLES, id)?.name).filter(Boolean);
                const themeNames = themes.map(id => shop.findItem(shop.THEMES, id)?.name).filter(Boolean);

                let boostText = '';
                if (xpBoost) boostText += `⚡ XP Boost: ${xpBoost.multiplier}x (${events.formatTimeRemaining({ endsAt: xpBoost.expiresAt })})\n`;
                if (luckBoost) boostText += `🍀 Luck Boost: ${luckBoost.multiplier}x (${events.formatTimeRemaining({ endsAt: luckBoost.expiresAt })})\n`;

                await conn.sendMessage(m.from, {
                    text: `🎒 *Inventory*\n\n*Materials*\n${itemLines.join('\n')}\n\n🏷️ Titles: ${titleNames.length ? titleNames.join(', ') : 'None'} (equipped: ${equippedTitle ? shop.findItem(shop.TITLES, equippedTitle)?.name : 'None'})\n🎨 Themes: ${themeNames.length ? themeNames.join(', ') : 'Default'} (equipped: ${equippedTheme ? shop.findItem(shop.THEMES, equippedTheme)?.name : 'Default'})\n💊 Revive Tokens: ${tokens}\n${boostText}`
                }, { quoted: m });
                break;
            }

            case "sell": {
                const itemKey = args[0]?.toLowerCase();
                const amount = parseInt(args[1]) || 1;

                if (!itemKey) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}sell <item> [amount]` }, { quoted: m });
                    break;
                }

                const inv = await rpg.getInventory(redisClient, m.sender);
                const matchKey = Object.keys(inv).find(k => k.toLowerCase().includes(itemKey));

                if (!matchKey || !inv[matchKey]) {
                    await conn.sendMessage(m.from, { text: `❌ You don't have *${itemKey}* in your inventory.` }, { quoted: m });
                    break;
                }

                const sellAmount = Math.min(amount, inv[matchKey]);

                // Find base value from fish/ore tables
                let value = 50; // default
                const allItems = [...rpg.FISH, ...rpg.ORES, ...rpg.CROPS];
                const item = allItems.find(i => matchKey.includes(i.name.toLowerCase().replace(/ /g, '_')));
                if (item) value = item.value;

                const total = value * sellAmount;
                await rpg.removeFromInventory(redisClient, m.sender, matchKey, sellAmount);
                await economy.addCoins(redisClient, m.sender, total);

                await conn.sendMessage(m.from, {
                    text: `💰 Sold ${sellAmount}x *${matchKey.replace(/_/g, ' ')}* for ${economy.formatCoins(total)} coins.`
                }, { quoted: m });
                break;
            }



            // ════════════════════════════════════════════
            // PvP / DUEL
            // ════════════════════════════════════════════
            case "duel": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ Duels only work in groups." }, { quoted: m });
                    break;
                }

                const target = m.quoted?.sender || m.mentionedJid?.[0];
                const bet = parseInt(args[args.length - 1]);

                if (!target || !bet || bet <= 0) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}duel @user <bet>\n\nChallenge someone to a duel!` }, { quoted: m });
                    break;
                }

                if (target === m.sender) {
                    await conn.sendMessage(m.from, { text: "❌ You can't duel yourself." }, { quoted: m });
                    break;
                }

                const profile = await economy.getProfile(redisClient, m.sender);
                if (profile.coins < bet) {
                    await conn.sendMessage(m.from, { text: `❌ You don't have ${economy.formatCoins(bet)} coins.` }, { quoted: m });
                    break;
                }

                const targetProfile = await economy.getProfile(redisClient, target);
                if (targetProfile.coins < bet) {
                    await conn.sendMessage(m.from, {
                        text: `❌ @${target.split('@')[0]} doesn't have ${economy.formatCoins(bet)} coins to duel.`,
                        mentions: [target]
                    }, { quoted: m });
                    break;
                }

                await pvp.createDuel(redisClient, m.from, m.sender, target, bet);

                await conn.sendMessage(m.from, {
                    text: `⚔️ @${m.sender.split('@')[0]} challenges @${target.split('@')[0]} to a duel!\n\n💰 Bet: ${economy.formatCoins(bet)} coins\n⏳ Expires in 60 seconds\n\n@${target.split('@')[0]}, type ${prefix}accept to fight!`,
                    mentions: [m.sender, target]
                }, { quoted: m });
                break;
            }

            case "accept": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ This command only works in groups." }, { quoted: m });
                    break;
                }

                const duel = await pvp.findDuelFor(redisClient, m.from, m.sender);
                if (!duel) {
                    await conn.sendMessage(m.from, { text: "❌ No pending duel found for you." }, { quoted: m });
                    break;
                }

                const challenger = duel.challengerJid;
                const bet = duel.bet;

                const challengerProfile = await economy.getProfile(redisClient, challenger);
                const targetProfile = await economy.getProfile(redisClient, m.sender);

                if (challengerProfile.coins < bet || targetProfile.coins < bet) {
                    await conn.sendMessage(m.from, { text: "❌ One of you doesn't have enough coins anymore." }, { quoted: m });
                    await pvp.deleteDuel(redisClient, m.from, challenger);
                    break;
                }

                // Combat: level-weighted random with some luck
                const challengerPower = challengerProfile.level * (0.5 + Math.random());
                const targetPower = targetProfile.level * (0.5 + Math.random());

                const winner = challengerPower >= targetPower ? challenger : m.sender;
                const loser = winner === challenger ? m.sender : challenger;

                await economy.addCoins(redisClient, winner, bet);
                await economy.addCoins(redisClient, loser, -bet);
                await giveXp(redisClient, conn, winner, m.from, 30);

                const winnerProfile = await economy.getProfile(redisClient, winner);
                await economy.updateProfile(redisClient, winner, { wins: winnerProfile.wins + 1 });
                const loserProfile = await economy.getProfile(redisClient, loser);
                await economy.updateProfile(redisClient, loser, { losses: loserProfile.losses + 1 });

                await pvp.deleteDuel(redisClient, m.from, challenger);

                const moves = ['🗡️ slashed', '🔥 blasted', '💥 crushed', '⚡ struck', '🌪️ overwhelmed'];
                const move = moves[Math.floor(Math.random() * moves.length)];

                await conn.sendMessage(m.from, {
                    text: `⚔️ *DUEL RESULT*\n\n@${winner.split('@')[0]} ${move} @${loser.split('@')[0]}!\n\n🏆 Winner: @${winner.split('@')[0]}\n💰 +${economy.formatCoins(bet)} coins\n⭐ +30 XP`,
                    mentions: [winner, loser]
                }, { quoted: m });
                break;
            }

            case "decline": {
                if (!isGroup) break;
                const duel = await pvp.findDuelFor(redisClient, m.from, m.sender);
                if (!duel) {
                    await conn.sendMessage(m.from, { text: "❌ No pending duel for you." }, { quoted: m });
                    break;
                }
                await pvp.deleteDuel(redisClient, m.from, duel.challengerJid);
                await conn.sendMessage(m.from, {
                    text: `🏳️ @${m.sender.split('@')[0]} declined the duel.`,
                    mentions: [m.sender]
                }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // GUILD / CLAN SYSTEM
            // ════════════════════════════════════════════
            case "createguild":
            case "createclan": {
                const guildName = text.trim();
                if (!guildName || guildName.length < 3 || guildName.length > 20) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}createguild <name>\n(3-20 characters)` }, { quoted: m });
                    break;
                }

                const existing = await pvp.getGuild(redisClient, guildName);
                if (existing) {
                    await conn.sendMessage(m.from, { text: `❌ Guild *${guildName}* already exists.` }, { quoted: m });
                    break;
                }

                const userGuild = await redisClient.hGet(`economy:${m.sender}`, 'guild');
                if (userGuild) {
                    await conn.sendMessage(m.from, { text: `❌ You're already in a guild. Leave with ${prefix}leaveguild first.` }, { quoted: m });
                    break;
                }

                const cost = 2000;
                const profile = await economy.getProfile(redisClient, m.sender);
                if (profile.coins < cost) {
                    await conn.sendMessage(m.from, { text: `❌ Creating a guild costs ${economy.formatCoins(cost)} coins.` }, { quoted: m });
                    break;
                }

                await economy.addCoins(redisClient, m.sender, -cost);
                await pvp.saveGuild(redisClient, guildName, {
                    name: guildName,
                    leader: m.sender,
                    members: [m.sender],
                    level: 1,
                    xp: 0,
                    bank: 0,
                    description: 'A new guild.',
                    createdAt: Date.now()
                });
                await redisClient.hSet(`economy:${m.sender}`, 'guild', guildName.toLowerCase());

                await conn.sendMessage(m.from, {
                    text: `🏰 *Guild Created!*\n\n🏷️ Name: ${guildName}\n👑 Leader: @${m.sender.split('@')[0]}\n-${economy.formatCoins(cost)} coins\n\nInvite others with ${prefix}guildinvite @user`,
                    mentions: [m.sender]
                }, { quoted: m });

                // ── Auto badge check: guild_founder badge ──
                {
                    const founderProfile = await economy.getProfile(redisClient, m.sender);
                    const unlocked = await badges.checkAutoBadges(redisClient, m.sender, founderProfile, { createdGuild: true });
                    if (unlocked.length > 0) {
                        const announcement = badges.formatBadgeUnlocks(m.sender, unlocked);
                        if (announcement) {
                            await conn.sendMessage(m.from, { text: announcement, mentions: [m.sender] });
                        }
                    }
                }
                break;
            }

            case "guildinfo":
            case "claninfo": {
                const guildName = text.trim() || await redisClient.hGet(`economy:${m.sender}`, 'guild');
                if (!guildName) {
                    await conn.sendMessage(m.from, { text: `❌ You're not in a guild. Use ${prefix}createguild or ${prefix}joinguild.` }, { quoted: m });
                    break;
                }

                const guild = await pvp.getGuild(redisClient, guildName);
                if (!guild) {
                    await conn.sendMessage(m.from, { text: `❌ Guild *${guildName}* not found.` }, { quoted: m });
                    break;
                }

                const memberTags = guild.members.map(j => `@${j.split('@')[0]}`).join(', ');

                await conn.sendMessage(m.from, {
                    text: `🏰 *${guild.name}*\n━━━━━━━━━━━━━━━━━━━\n👑 Leader: @${guild.leader.split('@')[0]}\n⭐ Level: ${guild.level}\n✨ XP: ${guild.xp}\n🏦 Bank: ${economy.formatCoins(guild.bank)} coins\n👥 Members (${guild.members.length}): ${memberTags}\n📝 ${guild.description}`,
                    mentions: guild.members
                }, { quoted: m });
                break;
            }

            case "guildinvite": {
                const target = m.quoted?.sender || m.mentionedJid?.[0];
                if (!target) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}guildinvite @user` }, { quoted: m });
                    break;
                }

                const guildName = await redisClient.hGet(`economy:${m.sender}`, 'guild');
                if (!guildName) {
                    await conn.sendMessage(m.from, { text: "❌ You're not in a guild." }, { quoted: m });
                    break;
                }

                const guild = await pvp.getGuild(redisClient, guildName);
                if (!guild || guild.leader !== m.sender) {
                    await conn.sendMessage(m.from, { text: "❌ Only the guild leader can invite members." }, { quoted: m });
                    break;
                }

                const targetGuild = await redisClient.hGet(`economy:${target}`, 'guild');
                if (targetGuild) {
                    await conn.sendMessage(m.from, { text: `❌ @${target.split('@')[0]} is already in a guild.`, mentions: [target] }, { quoted: m });
                    break;
                }

                // Store invite in Redis (60s to accept)
                await redisClient.set(`guildinvite:${target}`, JSON.stringify({ guildName, inviter: m.sender }), { EX: 120 });

                await conn.sendMessage(m.from, {
                    text: `📨 @${target.split('@')[0]}, you've been invited to join *${guild.name}*!\n\nType ${prefix}joinguild to accept.`,
                    mentions: [target]
                }, { quoted: m });
                break;
            }

            case "joinguild": {
                const inviteRaw = await redisClient.get(`guildinvite:${m.sender}`);
                if (!inviteRaw) {
                    await conn.sendMessage(m.from, { text: `❌ No pending guild invite.\nAsk a guild leader to use ${prefix}guildinvite @you` }, { quoted: m });
                    break;
                }

                const invite = JSON.parse(inviteRaw);
                const guild = await pvp.getGuild(redisClient, invite.guildName);

                if (!guild) {
                    await conn.sendMessage(m.from, { text: "❌ Guild no longer exists." }, { quoted: m });
                    await redisClient.del(`guildinvite:${m.sender}`);
                    break;
                }

                guild.members.push(m.sender);
                await pvp.saveGuild(redisClient, invite.guildName, guild);
                await redisClient.hSet(`economy:${m.sender}`, 'guild', invite.guildName.toLowerCase());
                await redisClient.del(`guildinvite:${m.sender}`);

                await conn.sendMessage(m.from, {
                    text: `🏰 @${m.sender.split('@')[0]} joined *${guild.name}*! Welcome! 🎉`,
                    mentions: [m.sender]
                }, { quoted: m });
                break;
            }

            case "leaveguild": {
                const guildName = await redisClient.hGet(`economy:${m.sender}`, 'guild');
                if (!guildName) {
                    await conn.sendMessage(m.from, { text: "❌ You're not in a guild." }, { quoted: m });
                    break;
                }

                const guild = await pvp.getGuild(redisClient, guildName);
                if (guild?.leader === m.sender) {
                    await conn.sendMessage(m.from, { text: `❌ Leaders can't leave their own guild.\nUse ${prefix}transferleader @user first, or ${prefix}deleteguild.` }, { quoted: m });
                    break;
                }

                if (guild) {
                    guild.members = guild.members.filter(j => j !== m.sender);
                    await pvp.saveGuild(redisClient, guildName, guild);
                }
                await redisClient.hDel(`economy:${m.sender}`, 'guild');

                await conn.sendMessage(m.from, { text: `👋 You left *${guildName}*.` }, { quoted: m });
                break;
            }

            case "guilddonate":
            case "gdonatee": {
                const amount = parseInt(args[0]);
                if (!amount || amount <= 0) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}guilddonate <amount>` }, { quoted: m });
                    break;
                }

                const guildName = await redisClient.hGet(`economy:${m.sender}`, 'guild');
                if (!guildName) {
                    await conn.sendMessage(m.from, { text: "❌ You're not in a guild." }, { quoted: m });
                    break;
                }

                const profile = await economy.getProfile(redisClient, m.sender);
                if (profile.coins < amount) {
                    await conn.sendMessage(m.from, { text: `❌ You don't have ${economy.formatCoins(amount)} coins.` }, { quoted: m });
                    break;
                }

                const guild = await pvp.getGuild(redisClient, guildName);
                await economy.addCoins(redisClient, m.sender, -amount);
                guild.bank += amount;
                guild.xp += Math.floor(amount / 10);

                // Level up guild
                while (guild.xp >= guild.level * 1000) {
                    guild.xp -= guild.level * 1000;
                    guild.level++;
                }

                await pvp.saveGuild(redisClient, guildName, guild);
                await conn.sendMessage(m.from, {
                    text: `🏦 Donated ${economy.formatCoins(amount)} coins to *${guildName}*!\nGuild Bank: ${economy.formatCoins(guild.bank)} | Level: ${guild.level}`
                }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // BADGES
            // ════════════════════════════════════════════
            case "badges":
            case "mybadges": {
                const target = m.quoted?.sender || m.mentionedJid?.[0] || m.sender;
                const owned = await badges.getBadges(redisClient, target);

                if (owned.length === 0) {
                    await conn.sendMessage(m.from, {
                        text: target === m.sender
                            ? `🏆 You haven't unlocked any badges yet. Use ${prefix}allbadges to see what's available.`
                            : `🏆 @${target.split('@')[0]} hasn't unlocked any badges yet.`,
                        mentions: [target]
                    }, { quoted: m });
                    break;
                }

                const lines = owned.map(id => {
                    const def = badges.getBadgeDef(id);
                    return def ? `${def.emoji} *${def.name}* — ${def.description}` : null;
                }).filter(Boolean);

                await conn.sendMessage(m.from, {
                    text: `🏆 *Badges — @${target.split('@')[0]}*\n\n${lines.join('\n')}\n\n${lines.length}/${badges.BADGE_TABLE.length} unlocked`,
                    mentions: [target]
                }, { quoted: m });
                break;
            }

            case "allbadges":
            case "badgelist": {
                const lines = badges.BADGE_TABLE.map(b => `${b.emoji} *${b.name}* — ${b.description}`);
                await conn.sendMessage(m.from, {
                    text: `🏆 *All Badges*\n\n${lines.join('\n')}\n\nUse ${prefix}badges to see your collection.`
                }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // VEHICLES
            // ════════════════════════════════════════════
            case "vehicles":
            case "carshop": {
                const list = pvp.VEHICLES.map(v =>
                    `${v.emoji} *${v.name}* (${v.id})\n   Price: ${economy.formatCoins(v.price)} coins | Speed Bonus: +${(v.speedBonus * 100).toFixed(0)}%\n   ${v.desc}`
                ).join('\n\n');

                await conn.sendMessage(m.from, {
                    text: `🚗 *Vehicle Shop*\n\n${list}\n\nBuy with: ${prefix}buyvehicle <id>`
                }, { quoted: m });
                break;
            }

            case "buyvehicle": {
                const vehicleId = args[0]?.toLowerCase();
                const vehicle = pvp.VEHICLES.find(v => v.id === vehicleId);

                if (!vehicleId || !vehicle) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}buyvehicle <id>\nView shop: ${prefix}vehicles` }, { quoted: m });
                    break;
                }

                const profile = await economy.getProfile(redisClient, m.sender);
                if (profile.coins < vehicle.price) {
                    await conn.sendMessage(m.from, { text: `❌ You need ${economy.formatCoins(vehicle.price)} coins. You have ${economy.formatCoins(profile.coins)}.` }, { quoted: m });
                    break;
                }

                await economy.addCoins(redisClient, m.sender, -vehicle.price);
                await redisClient.hSet(`economy:${m.sender}`, 'vehicle', vehicleId);
                await conn.sendMessage(m.from, {
                    text: `${vehicle.emoji} You bought a *${vehicle.name}*!\n-${economy.formatCoins(vehicle.price)} coins\n⚡ Speed Bonus: +${(vehicle.speedBonus * 100).toFixed(0)}%`
                }, { quoted: m });
                break;
            }

            case "myvehicle": {
                const vehicleId = await redisClient.hGet(`economy:${m.sender}`, 'vehicle');
                if (!vehicleId) {
                    await conn.sendMessage(m.from, { text: `🚗 You don't own a vehicle.\n\nBrowse the shop: ${prefix}vehicles` }, { quoted: m });
                    break;
                }

                const vehicle = pvp.VEHICLES.find(v => v.id === vehicleId);
                await conn.sendMessage(m.from, {
                    text: `${vehicle?.emoji || '🚗'} *Your Vehicle*\n\nModel: ${vehicle?.name || vehicleId}\nSpeed Bonus: +${((vehicle?.speedBonus || 0) * 100).toFixed(0)}%\n${vehicle?.desc || ''}`
                }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // PROPERTY
            // ════════════════════════════════════════════
            case "properties":
            case "realestate": {
                const list = pvp.PROPERTIES.map(p =>
                    `${p.emoji} *${p.name}* (${p.id})\n   Price: ${economy.formatCoins(p.price)} | Income: ${economy.formatCoins(p.income)}/collect\n   ${p.desc}`
                ).join('\n\n');

                await conn.sendMessage(m.from, {
                    text: `🏠 *Property Shop*\n\n${list}\n\nBuy with: ${prefix}buyproperty <id>`
                }, { quoted: m });
                break;
            }

            case "buyproperty": {
                const propId = args[0]?.toLowerCase();
                const property = pvp.PROPERTIES.find(p => p.id === propId);

                if (!propId || !property) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}buyproperty <id>\nView: ${prefix}properties` }, { quoted: m });
                    break;
                }

                const profile = await economy.getProfile(redisClient, m.sender);
                if (profile.coins < property.price) {
                    await conn.sendMessage(m.from, { text: `❌ You need ${economy.formatCoins(property.price)} coins.` }, { quoted: m });
                    break;
                }

                // Get current properties owned
                const ownedRaw = await redisClient.hGet(`economy:${m.sender}`, 'properties');
                const owned = ownedRaw ? JSON.parse(ownedRaw) : [];

                if (owned.includes(propId)) {
                    await conn.sendMessage(m.from, { text: `❌ You already own a ${property.name}.` }, { quoted: m });
                    break;
                }

                await economy.addCoins(redisClient, m.sender, -property.price);
                owned.push(propId);
                await redisClient.hSet(`economy:${m.sender}`, 'properties', JSON.stringify(owned));
                await redisClient.hSet(`economy:${m.sender}`, `propCollect_${propId}`, String(Date.now()));

                await conn.sendMessage(m.from, {
                    text: `${property.emoji} You bought *${property.name}*!\n-${economy.formatCoins(property.price)} coins\n💰 Collects ${economy.formatCoins(property.income)} every 6h`
                }, { quoted: m });
                break;
            }

            case "collect":
            case "rent": {
                const ownedRaw = await redisClient.hGet(`economy:${m.sender}`, 'properties');
                if (!ownedRaw) {
                    await conn.sendMessage(m.from, { text: `❌ You don't own any property.\n\nBuy with ${prefix}buyproperty` }, { quoted: m });
                    break;
                }

                const owned = JSON.parse(ownedRaw);
                const collectCooldown = 6 * 60 * 60 * 1000;
                let totalCollected = 0;
                const lines = [];

                for (const propId of owned) {
                    const property = pvp.PROPERTIES.find(p => p.id === propId);
                    if (!property) continue;

                    const lastCollect = parseInt(await redisClient.hGet(`economy:${m.sender}`, `propCollect_${propId}`) || '0');
                    const remaining = economy.cooldownRemaining(lastCollect, collectCooldown);

                    if (remaining > 0) {
                        lines.push(`${property.emoji} ${property.name}: Ready in ${economy.formatDuration(remaining)}`);
                    } else {
                        await redisClient.hSet(`economy:${m.sender}`, `propCollect_${propId}`, String(Date.now()));
                        totalCollected += property.income;
                        lines.push(`${property.emoji} ${property.name}: +${economy.formatCoins(property.income)} coins ✅`);
                    }
                }

                if (totalCollected > 0) await economy.addCoins(redisClient, m.sender, totalCollected);

                await conn.sendMessage(m.from, {
                    text: `🏠 *Property Income*\n\n${lines.join('\n')}\n\n💰 Total collected: ${economy.formatCoins(totalCollected)} coins`
                }, { quoted: m });
                break;
            }

            case "myproperties": {
                const ownedRaw = await redisClient.hGet(`economy:${m.sender}`, 'properties');
                if (!ownedRaw || JSON.parse(ownedRaw).length === 0) {
                    await conn.sendMessage(m.from, { text: `🏠 You don't own any property.\n\nBrowse: ${prefix}properties` }, { quoted: m });
                    break;
                }

                const owned = JSON.parse(ownedRaw);
                const list = owned.map(id => {
                    const p = pvp.PROPERTIES.find(pr => pr.id === id);
                    return p ? `${p.emoji} ${p.name} — ${economy.formatCoins(p.income)}/6h` : id;
                }).join('\n');

                await conn.sendMessage(m.from, { text: `🏠 *Your Properties*\n\n${list}\n\nCollect income: ${prefix}collect` }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // BOSS RAIDS
            // ════════════════════════════════════════════
            case "startraid":
            case "raid": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ Raids only work in groups." }, { quoted: m });
                    break;
                }

                const existingRaid = await pvp.getRaid(redisClient, m.from);
                if (existingRaid) {
                    await conn.sendMessage(m.from, { text: `❌ A raid is already active!\n\nAttack with ${prefix}attack` }, { quoted: m });
                    break;
                }

                const profile = await economy.getProfile(redisClient, m.sender);
                const eligibleBosses = pvp.BOSSES.filter(b => b.minLevel <= profile.level);

                if (!eligibleBosses.length) {
                    await conn.sendMessage(m.from, { text: `❌ You need to be at least Level ${pvp.BOSSES[0].minLevel} to start a raid.` }, { quoted: m });
                    break;
                }

                const boss = eligibleBosses[Math.floor(Math.random() * eligibleBosses.length)];
                const raid = {
                    boss,
                    currentHp: boss.hp,
                    maxHp: boss.hp,
                    participants: {},
                    startedBy: m.sender,
                    startedAt: Date.now()
                };

                await pvp.saveRaid(redisClient, m.from, raid);

                await conn.sendMessage(m.from, {
                    text: `${boss.emoji} *BOSS RAID STARTED!*\n\n👹 Boss: ${boss.name}\n❤️ HP: ${boss.hp.toLocaleString()}\n\n⚔️ Attack with ${prefix}attack!\nReward: ${economy.formatCoins(boss.reward)} coins + ${boss.xp} XP split among participants!\n\n⏳ Raid expires in 1 hour.`
                }, { quoted: m });
                break;
            }

            case "attack": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ This command only works in groups." }, { quoted: m });
                    break;
                }

                const raid = await pvp.getRaid(redisClient, m.from);
                if (!raid) {
                    await conn.sendMessage(m.from, { text: `❌ No active raid.\n\nStart one with ${prefix}raid` }, { quoted: m });
                    break;
                }

                // Cooldown: attack every 30s
                const lastAttackKey = `raidattack:${m.from}:${m.sender}`;
                const lastAttack = parseInt(await redisClient.get(lastAttackKey) || '0');
                const remaining = economy.cooldownRemaining(lastAttack, 30000);

                if (remaining > 0) {
                    await conn.sendMessage(m.from, { text: `⚔️ Wait ${economy.formatDuration(remaining)} before attacking again.` }, { quoted: m });
                    break;
                }

                const profile = await economy.getProfile(redisClient, m.sender);
                const baseDmg = 20 + (profile.level * 5);
                const damage = Math.floor(baseDmg * (0.7 + Math.random() * 0.6));

                raid.currentHp = Math.max(0, raid.currentHp - damage);
                raid.participants[m.sender] = (raid.participants[m.sender] || 0) + damage;

                await redisClient.set(lastAttackKey, String(Date.now()), { EX: 60 });

                if (raid.currentHp <= 0) {
                    // Boss defeated!
                    await pvp.deleteRaid(redisClient, m.from);

                    const participants = Object.entries(raid.participants);
                    const totalDmg = participants.reduce((s, [, d]) => s + d, 0);

                    const rewardLines = [];
                    for (const [jid, dmg] of participants) {
                        const share = Math.floor((dmg / totalDmg) * raid.boss.reward);
                        const xpShare = Math.floor((dmg / totalDmg) * raid.boss.xp);
                        await economy.addCoins(redisClient, jid, share);
                        await giveXp(redisClient, conn, jid, m.from, xpShare);
                        rewardLines.push(`@${jid.split('@')[0]}: ${economy.formatCoins(share)} coins + ${xpShare} XP`);
                    }

                    await conn.sendMessage(m.from, {
                        text: `${raid.boss.emoji} *${raid.boss.name} DEFEATED!*\n\n⚔️ Final blow by @${m.sender.split('@')[0]}!\n\n*Rewards distributed:*\n${rewardLines.join('\n')}`,
                        mentions: participants.map(([j]) => j)
                    }, { quoted: m });
                } else {
                    await pvp.saveRaid(redisClient, m.from, raid);
                    const hpPercent = Math.floor((raid.currentHp / raid.boss.maxHp) * 100);
                    const bar = '▓'.repeat(Math.floor(hpPercent / 10)) + '░'.repeat(10 - Math.floor(hpPercent / 10));

                    await conn.sendMessage(m.from, {
                        text: `⚔️ @${m.sender.split('@')[0]} dealt *${damage}* damage!\n\n${raid.boss.emoji} ${raid.boss.name}\n❤️ [${bar}] ${raid.currentHp.toLocaleString()}/${raid.boss.maxHp.toLocaleString()} HP`,
                        mentions: [m.sender]
                    }, { quoted: m });
                }
                break;
            }

            case "raidstatus": {
                if (!isGroup) break;
                const raid = await pvp.getRaid(redisClient, m.from);
                if (!raid) {
                    await conn.sendMessage(m.from, { text: `❌ No active raid. Start one with ${prefix}raid` }, { quoted: m });
                    break;
                }

                const hpPercent = Math.floor((raid.currentHp / raid.boss.maxHp) * 100);
                const bar = '▓'.repeat(Math.floor(hpPercent / 10)) + '░'.repeat(10 - Math.floor(hpPercent / 10));
                const participantLines = Object.entries(raid.participants)
                    .sort(([,a],[,b]) => b-a)
                    .map(([jid, dmg]) => `@${jid.split('@')[0]}: ${dmg.toLocaleString()} dmg`)
                    .join('\n');

                await conn.sendMessage(m.from, {
                    text: `${raid.boss.emoji} *RAID STATUS*\n\nBoss: ${raid.boss.name}\n❤️ [${bar}] ${raid.currentHp.toLocaleString()}/${raid.boss.maxHp.toLocaleString()} HP\n\n*Top Attackers:*\n${participantLines || 'None yet'}\n\n⚔️ Attack with ${prefix}attack`,
                    mentions: Object.keys(raid.participants)
                }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // XP BOOSTS
            // ════════════════════════════════════════════
            case "boostshop":
            case "xpshop": {
                const list = pvp.XP_BOOSTS.map(b =>
                    `⚡ *${b.name}*\n   Price: ${economy.formatCoins(b.price)} coins | ${b.multiplier}x XP for ${economy.formatDuration(b.duration)}`
                ).join('\n\n');

                await conn.sendMessage(m.from, {
                    text: `⚡ *XP Boost Shop*\n\n${list}\n\nBuy with: ${prefix}buyboost <id>\nIDs: boost_1h, boost_6h, boost_24h, boost_vip`
                }, { quoted: m });
                break;
            }

            case "buyboost": {
                const boostId = args[0]?.toLowerCase();
                const boost = pvp.XP_BOOSTS.find(b => b.id === boostId);

                if (!boostId || !boost) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}buyboost <id>\nView: ${prefix}boostshop` }, { quoted: m });
                    break;
                }

                const profile = await economy.getProfile(redisClient, m.sender);
                if (profile.coins < boost.price) {
                    await conn.sendMessage(m.from, { text: `❌ You need ${economy.formatCoins(boost.price)} coins.` }, { quoted: m });
                    break;
                }

                await economy.addCoins(redisClient, m.sender, -boost.price);
                await redisClient.hSet(`economy:${m.sender}`, 'xpBoost', JSON.stringify({
                    multiplier: boost.multiplier,
                    expiresAt: Date.now() + boost.duration
                }));

                await conn.sendMessage(m.from, {
                    text: `⚡ *${boost.name}* activated!\n-${economy.formatCoins(boost.price)} coins\n${boost.multiplier}x XP for ${economy.formatDuration(boost.duration)}`
                }, { quoted: m });
                break;
            }

            case "myboost":
            case "boost": {
                const boostRaw = await redisClient.hGet(`economy:${m.sender}`, 'xpBoost');
                if (!boostRaw) {
                    await conn.sendMessage(m.from, { text: `⚡ No active XP boost.\n\nBuy one: ${prefix}boostshop` }, { quoted: m });
                    break;
                }

                const boost = JSON.parse(boostRaw);
                if (Date.now() > boost.expiresAt) {
                    await redisClient.hDel(`economy:${m.sender}`, 'xpBoost');
                    await conn.sendMessage(m.from, { text: `⚡ Your XP boost has expired.\n\nBuy a new one: ${prefix}boostshop` }, { quoted: m });
                    break;
                }

                await conn.sendMessage(m.from, {
                    text: `⚡ *Active XP Boost*\n\n${boost.multiplier}x XP\nExpires in: ${economy.formatDuration(boost.expiresAt - Date.now())}`
                }, { quoted: m });
                break;
            }


            // ════════════════════════════════════════════
            // FRIENDS SYSTEM
            // ════════════════════════════════════════════
            case "addfriend": {
                const target = m.quoted?.sender || m.mentionedJid?.[0];
                if (!target) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}addfriend @user` }, { quoted: m });
                    break;
                }

                if (target === m.sender) {
                    await conn.sendMessage(m.from, { text: "❌ You can't friend yourself." }, { quoted: m });
                    break;
                }

                const already = await social.areFriends(redisClient, m.sender, target);
                if (already) {
                    await conn.sendMessage(m.from, { text: `❌ You're already friends with @${target.split('@')[0]}.`, mentions: [target] }, { quoted: m });
                    break;
                }

                await social.sendFriendRequest(redisClient, m.sender, target);
                await conn.sendMessage(m.from, {
                    text: `📨 Friend request sent to @${target.split('@')[0]}!\n\nThey can accept with ${prefix}acceptfriend @${m.sender.split('@')[0]}`,
                    mentions: [target, m.sender]
                }, { quoted: m });
                break;
            }

            case "acceptfriend": {
                const target = m.quoted?.sender || m.mentionedJid?.[0];
                if (!target) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}acceptfriend @user` }, { quoted: m });
                    break;
                }

                const requests = await social.getFriendRequests(redisClient, m.sender);
                if (!requests.includes(target)) {
                    await conn.sendMessage(m.from, { text: `❌ No pending friend request from @${target.split('@')[0]}.`, mentions: [target] }, { quoted: m });
                    break;
                }

                await social.acceptFriend(redisClient, m.sender, target);
                await conn.sendMessage(m.from, {
                    text: `🤝 @${m.sender.split('@')[0]} and @${target.split('@')[0]} are now friends!`,
                    mentions: [m.sender, target]
                }, { quoted: m });
                break;
            }

            case "removefriend":
            case "unfriend": {
                const target = m.quoted?.sender || m.mentionedJid?.[0];
                if (!target) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}removefriend @user` }, { quoted: m });
                    break;
                }

                await social.removeFriend(redisClient, m.sender, target);
                await conn.sendMessage(m.from, { text: `💔 Removed @${target.split('@')[0]} from your friends.`, mentions: [target] }, { quoted: m });
                break;
            }

            case "friends":
            case "friendlist": {
                const target = m.quoted?.sender || m.mentionedJid?.[0] || m.sender;
                const friends = await social.getFriends(redisClient, target);

                if (!friends.length) {
                    await conn.sendMessage(m.from, { text: `👥 @${target.split('@')[0]} has no friends yet.`, mentions: [target] }, { quoted: m });
                    break;
                }

                const list = friends.map((f, i) => `${i + 1}. @${f.split('@')[0]}`).join('\n');
                await conn.sendMessage(m.from, {
                    text: `👥 *Friends of @${target.split('@')[0]}* (${friends.length})\n\n${list}`,
                    mentions: [target, ...friends]
                }, { quoted: m });
                break;
            }

            case "friendrequests":
            case "fr": {
                const requests = await social.getFriendRequests(redisClient, m.sender);
                if (!requests.length) {
                    await conn.sendMessage(m.from, { text: "📭 No pending friend requests." }, { quoted: m });
                    break;
                }

                const list = requests.map((r, i) => `${i + 1}. @${r.split('@')[0]}`).join('\n');
                await conn.sendMessage(m.from, {
                    text: `📨 *Pending Friend Requests*\n\n${list}\n\nAccept with ${prefix}acceptfriend @user`,
                    mentions: requests
                }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // TEAMS SYSTEM
            // ════════════════════════════════════════════
            case "createteam": {
                const teamName = text.trim();
                if (!teamName || teamName.length < 3 || teamName.length > 20) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}createteam <name>\n(3-20 characters)` }, { quoted: m });
                    break;
                }

                const existing = await social.getTeam(redisClient, teamName);
                if (existing) {
                    await conn.sendMessage(m.from, { text: `❌ Team *${teamName}* already exists.` }, { quoted: m });
                    break;
                }

                const userTeam = await redisClient.hGet(`economy:${m.sender}`, 'team');
                if (userTeam) {
                    await conn.sendMessage(m.from, { text: `❌ You're already in a team. Leave first with ${prefix}leaveteam.` }, { quoted: m });
                    break;
                }

                await social.saveTeam(redisClient, teamName, {
                    name: teamName,
                    leader: m.sender,
                    members: [m.sender],
                    wins: 0,
                    losses: 0,
                    bank: 0,
                    createdAt: Date.now()
                });
                await redisClient.hSet(`economy:${m.sender}`, 'team', teamName.toLowerCase());

                await conn.sendMessage(m.from, {
                    text: `👥 *Team Created!*\n\n🏷️ Name: ${teamName}\n👑 Captain: @${m.sender.split('@')[0]}`,
                    mentions: [m.sender]
                }, { quoted: m });
                break;
            }

            case "teaminfo": {
                const teamName = text.trim() || await redisClient.hGet(`economy:${m.sender}`, 'team');
                if (!teamName) {
                    await conn.sendMessage(m.from, { text: `❌ You're not in a team.` }, { quoted: m });
                    break;
                }

                const team = await social.getTeam(redisClient, teamName);
                if (!team) {
                    await conn.sendMessage(m.from, { text: `❌ Team *${teamName}* not found.` }, { quoted: m });
                    break;
                }

                const memberTags = team.members.map(j => `@${j.split('@')[0]}`).join(', ');
                await conn.sendMessage(m.from, {
                    text: `👥 *${team.name}*\n━━━━━━━━━━━━━━━━━━━\n👑 Captain: @${team.leader.split('@')[0]}\n🏆 Wins: ${team.wins} | Losses: ${team.losses}\n👤 Members (${team.members.length}): ${memberTags}`,
                    mentions: team.members
                }, { quoted: m });
                break;
            }

            case "jointeam": {
                const teamName = text.trim();
                if (!teamName) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}jointeam <name>` }, { quoted: m });
                    break;
                }

                const team = await social.getTeam(redisClient, teamName);
                if (!team) {
                    await conn.sendMessage(m.from, { text: `❌ Team *${teamName}* not found.` }, { quoted: m });
                    break;
                }

                const userTeam = await redisClient.hGet(`economy:${m.sender}`, 'team');
                if (userTeam) {
                    await conn.sendMessage(m.from, { text: `❌ You're already in a team.` }, { quoted: m });
                    break;
                }

                team.members.push(m.sender);
                await social.saveTeam(redisClient, teamName, team);
                await redisClient.hSet(`economy:${m.sender}`, 'team', teamName.toLowerCase());

                await conn.sendMessage(m.from, {
                    text: `👥 @${m.sender.split('@')[0]} joined *${team.name}*!`,
                    mentions: [m.sender]
                }, { quoted: m });
                break;
            }

            case "leaveteam": {
                const teamName = await redisClient.hGet(`economy:${m.sender}`, 'team');
                if (!teamName) {
                    await conn.sendMessage(m.from, { text: "❌ You're not in a team." }, { quoted: m });
                    break;
                }

                const team = await social.getTeam(redisClient, teamName);
                if (team?.leader === m.sender) {
                    await conn.sendMessage(m.from, { text: `❌ Captains can't leave. Delete the team or transfer leadership first.` }, { quoted: m });
                    break;
                }

                if (team) {
                    team.members = team.members.filter(j => j !== m.sender);
                    await social.saveTeam(redisClient, teamName, team);
                }
                await redisClient.hDel(`economy:${m.sender}`, 'team');
                await conn.sendMessage(m.from, { text: `👋 You left *${teamName}*.` }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // PROMO CODES
            // ════════════════════════════════════════════
            case "createpromo": {
                if (!senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Owner/Sudo only command." }, { quoted: m });
                    break;
                }

                // Usage: .createpromo CODE coins xp maxUses expiryHours
                const [code, coinsStr, xpStr, maxUsesStr, expiryStr] = args;
                const coins = parseInt(coinsStr) || 0;
                const xp = parseInt(xpStr) || 0;
                const maxUses = parseInt(maxUsesStr) || 1;
                const expiryHours = parseInt(expiryStr) || 24;

                if (!code) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}createpromo <CODE> <coins> <xp> <maxUses> <expiryHours>\n\nExample: ${prefix}createpromo WELCOME100 500 20 100 48` }, { quoted: m });
                    break;
                }

                await social.createPromo(redisClient, code, coins, xp, maxUses, expiryHours, m.sender);
                await conn.sendMessage(m.from, {
                    text: `🎁 *Promo Code Created!*\n\nCode: ${code.toUpperCase()}\nReward: ${economy.formatCoins(coins)} coins + ${xp} XP\nMax uses: ${maxUses}\nExpires in: ${expiryHours}h`
                }, { quoted: m });
                break;
            }

            case "redeem":
            case "promo": {
                const code = args[0];
                if (!code) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}redeem <code>` }, { quoted: m });
                    break;
                }

                const result = await social.redeemPromo(redisClient, code, m.sender);
                if (result.error) {
                    await conn.sendMessage(m.from, { text: `❌ ${result.error}` }, { quoted: m });
                    break;
                }

                if (result.coins > 0) await economy.addCoins(redisClient, m.sender, result.coins);
                if (result.xp > 0) await giveXp(redisClient, conn, m.sender, m.from, result.xp);

                await conn.sendMessage(m.from, {
                    text: `🎉 *Promo Redeemed!*\n\n+${economy.formatCoins(result.coins)} coins\n+${result.xp} XP`
                }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // REFERRAL SYSTEM
            // ════════════════════════════════════════════
            case "refcode":
            case "myref":
            case "invite": {
                const code = await referral.getOrCreateCode(redisClient, m.sender);
                const count = await referral.getReferralCount(redisClient, m.sender);

                await conn.sendMessage(m.from, {
                    text: `🔗 *Your Referral Code*\n\n*${code}*\n\nShare this with friends! When they join and run ${prefix}useref ${code}, you both get rewarded:\n• You: +${economy.formatCoins(referral.REFERRAL_REWARD_COINS)} coins, +${referral.REFERRAL_REWARD_XP} XP\n• Them: +${economy.formatCoins(referral.NEW_USER_BONUS_COINS)} coins, +${referral.NEW_USER_BONUS_XP} XP\n\nTotal referrals: *${count}*`
                }, { quoted: m });
                break;
            }

            case "useref":
            case "redeemref": {
                const code = args[0];
                if (!code) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}useref <code>` }, { quoted: m });
                    break;
                }

                const newUserProfile = await economy.getProfile(redisClient, m.sender);
                const result = await referral.redeemCode(redisClient, code, m.sender, newUserProfile);

                if (result.error) {
                    await conn.sendMessage(m.from, { text: `❌ ${result.error}` }, { quoted: m });
                    break;
                }

                // Reward the new user
                await economy.addCoins(redisClient, m.sender, referral.NEW_USER_BONUS_COINS);
                await giveXp(redisClient, conn, m.sender, m.from, referral.NEW_USER_BONUS_XP);

                // Reward the referrer
                await economy.addCoins(redisClient, result.referrerJid, referral.REFERRAL_REWARD_COINS);
                await giveXp(redisClient, conn, result.referrerJid, m.from, referral.REFERRAL_REWARD_XP);

                await conn.sendMessage(m.from, {
                    text: `🎉 *Referral Redeemed!*\n\n@${m.sender.split('@')[0]} joined via @${result.referrerJid.split('@')[0]}'s invite!\n\n@${m.sender.split('@')[0]}: +${economy.formatCoins(referral.NEW_USER_BONUS_COINS)} coins, +${referral.NEW_USER_BONUS_XP} XP\n@${result.referrerJid.split('@')[0]}: +${economy.formatCoins(referral.REFERRAL_REWARD_COINS)} coins, +${referral.REFERRAL_REWARD_XP} XP`,
                    mentions: [m.sender, result.referrerJid]
                }, { quoted: m });

                // ── Auto badge check: recruiter badges for the referrer ──
                {
                    const referrerProfile = await economy.getProfile(redisClient, result.referrerJid);
                    const referralCount = await referral.getReferralCount(redisClient, result.referrerJid);
                    const unlocked = await badges.checkAutoBadges(redisClient, result.referrerJid, referrerProfile, { referralCount });
                    if (unlocked.length > 0) {
                        const announcement = badges.formatBadgeUnlocks(result.referrerJid, unlocked);
                        if (announcement) {
                            await conn.sendMessage(m.from, { text: announcement, mentions: [result.referrerJid] });
                        }
                    }
                }
                break;
            }

            case "referrals":
            case "myinvites": {
                const target = m.quoted?.sender || m.mentionedJid?.[0] || m.sender;
                const list = await referral.getReferrals(redisClient, target);

                if (list.length === 0) {
                    await conn.sendMessage(m.from, {
                        text: target === m.sender
                            ? `📊 You haven't referred anyone yet. Use ${prefix}refcode to get your code.`
                            : `📊 @${target.split('@')[0]} hasn't referred anyone yet.`,
                        mentions: [target]
                    }, { quoted: m });
                    break;
                }

                const lines = list.map((jid, i) => `${i + 1}. @${jid.split('@')[0]}`);
                await conn.sendMessage(m.from, {
                    text: `📊 *Referrals — @${target.split('@')[0]}*\n\n${lines.join('\n')}\n\nTotal: ${list.length}`,
                    mentions: [target, ...list]
                }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // XP / LEVEL LEADERBOARD
            // ════════════════════════════════════════════
            case "toplevel":
            case "xplb": {
                if (!redisClient) break;

                const keys = await redisClient.keys('economy:*');
                const entries = [];

                for (const key of keys) {
                    const jid = key.replace('economy:', '');
                    const data = await redisClient.hGetAll(key);
                    entries.push({
                        jid,
                        level: parseInt(data.level || '1'),
                        xp: parseInt(data.xp || '0')
                    });
                }

                entries.sort((a, b) => b.level - a.level || b.xp - a.xp);
                const top = entries.slice(0, 10);

                if (!top.length) {
                    await conn.sendMessage(m.from, { text: "📊 No level data yet." }, { quoted: m });
                    break;
                }

                const medals = ['🥇', '🥈', '🥉'];
                const lines = top.map((e, i) => {
                    const medal = medals[i] || `${i + 1}.`;
                    return `${medal} @${e.jid.split('@')[0]} — Level ${e.level} (${e.xp} XP)`;
                });

                await conn.sendMessage(m.from, {
                    text: `⭐ *TOP 10 BY LEVEL*\n━━━━━━━━━━━━━━━━━━━\n${lines.join('\n')}`,
                    mentions: top.map(e => e.jid)
                }, { quoted: m });
                break;
            }

            case "topwins": {
                if (!redisClient) break;

                const keys = await redisClient.keys('economy:*');
                const entries = [];

                for (const key of keys) {
                    const jid = key.replace('economy:', '');
                    const data = await redisClient.hGetAll(key);
                    entries.push({ jid, wins: parseInt(data.wins || '0') });
                }

                entries.sort((a, b) => b.wins - a.wins);
                const top = entries.slice(0, 10).filter(e => e.wins > 0);

                if (!top.length) {
                    await conn.sendMessage(m.from, { text: "📊 No wins recorded yet." }, { quoted: m });
                    break;
                }

                const medals = ['🥇', '🥈', '🥉'];
                const lines = top.map((e, i) => `${medals[i] || `${i + 1}.`} @${e.jid.split('@')[0]} — ${e.wins} wins`);

                await conn.sendMessage(m.from, {
                    text: `🏆 *TOP 10 BY WINS*\n━━━━━━━━━━━━━━━━━━━\n${lines.join('\n')}`,
                    mentions: top.map(e => e.jid)
                }, { quoted: m });
                break;
            }


            // ════════════════════════════════════════════
            // MORE GAMES
            // ════════════════════════════════════════════
            case "hangman": {
                const words = ['javascript', 'whatsapp', 'baileys', 'redis', 'render', 'economy', 'developer', 'pairing', 'session', 'keyboard'];
                const word = words[Math.floor(Math.random() * words.length)];
                const bet = parseInt(args[0]) || 0;

                if (bet > 0) {
                    const profile = await economy.getProfile(redisClient, m.sender);
                    if (profile.coins < bet) {
                        await conn.sendMessage(m.from, { text: `❌ You don't have ${economy.formatCoins(bet)} coins.` }, { quoted: m });
                        break;
                    }
                }

                const hangmanKey = `hangman:${m.from}:${m.sender}`;
                await redisClient.set(hangmanKey, JSON.stringify({
                    word, guessed: [], wrongGuesses: 0, bet
                }), { EX: 300 }); // 5 min

                const display = word.split('').map(() => '_').join(' ');
                await conn.sendMessage(m.from, {
                    text: `🔤 *HANGMAN*${bet > 0 ? ` — Bet: ${economy.formatCoins(bet)}` : ''}\n\n${display}\n\nWord length: ${word.length}\nGuess a letter: ${prefix}guessletter <letter>\nLives: 6 ❤️`
                }, { quoted: m });
                break;
            }

            case "guessletter": {
                const letter = args[0]?.toLowerCase();
                if (!letter || letter.length !== 1) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}guessletter <single letter>` }, { quoted: m });
                    break;
                }

                const hangmanKey = `hangman:${m.from}:${m.sender}`;
                const raw = await redisClient.get(hangmanKey);
                if (!raw) {
                    await conn.sendMessage(m.from, { text: `❌ No active hangman game. Start with ${prefix}hangman` }, { quoted: m });
                    break;
                }

                const game = JSON.parse(raw);

                if (game.guessed.includes(letter)) {
                    await conn.sendMessage(m.from, { text: `❌ You already guessed *${letter}*.` }, { quoted: m });
                    break;
                }

                game.guessed.push(letter);
                if (!game.word.includes(letter)) game.wrongGuesses++;

                const display = game.word.split('').map(c => game.guessed.includes(c) ? c : '_').join(' ');
                const won = !display.includes('_');
                const lost = game.wrongGuesses >= 6;

                if (won) {
                    await redisClient.del(hangmanKey);
                    const reward = game.bet > 0 ? game.bet * 2 : 150;
                    await economy.addCoins(redisClient, m.sender, reward);
                    await giveXp(redisClient, conn, m.sender, m.from, 15);
                    await conn.sendMessage(m.from, { text: `🎉 *YOU WIN!*\n\nWord: *${game.word}*\n+${economy.formatCoins(reward)} coins\n+15 XP` }, { quoted: m });
                } else if (lost) {
                    await redisClient.del(hangmanKey);
                    if (game.bet > 0) await economy.addCoins(redisClient, m.sender, -game.bet);
                    await conn.sendMessage(m.from, { text: `💀 *GAME OVER*\n\nThe word was: *${game.word}*${game.bet > 0 ? `\n-${economy.formatCoins(game.bet)} coins` : ''}` }, { quoted: m });
                } else {
                    await redisClient.set(hangmanKey, JSON.stringify(game), { EX: 300 });
                    const lives = 6 - game.wrongGuesses;
                    await conn.sendMessage(m.from, { text: `🔤 ${display}\n\nWrong: ${game.guessed.filter(l => !game.word.includes(l)).join(', ') || 'none'}\nLives: ${'❤️'.repeat(lives)}${'🖤'.repeat(game.wrongGuesses)}` }, { quoted: m });
                }
                break;
            }

            case "scramble": {
                const words = ['economy', 'whatsapp', 'pairing', 'developer', 'redis', 'baileys', 'keyboard', 'session', 'monitor', 'database'];
                const word = words[Math.floor(Math.random() * words.length)];
                const scrambled = word.split('').sort(() => Math.random() - 0.5).join('');
                const bet = parseInt(args[0]) || 0;

                if (bet > 0) {
                    const profile = await economy.getProfile(redisClient, m.sender);
                    if (profile.coins < bet) {
                        await conn.sendMessage(m.from, { text: `❌ You don't have ${economy.formatCoins(bet)} coins.` }, { quoted: m });
                        break;
                    }
                }

                const scrambleKey = `scramble:${m.from}:${m.sender}`;
                await redisClient.set(scrambleKey, JSON.stringify({ word, bet }), { EX: 60 });

                await conn.sendMessage(m.from, {
                    text: `🔠 *WORD SCRAMBLE*${bet > 0 ? ` — Bet: ${economy.formatCoins(bet)}` : ''}\n\nUnscramble: *${scrambled.toUpperCase()}*\n\nAnswer with: ${prefix}unscramble <word>\n⏳ 60 seconds!`
                }, { quoted: m });
                break;
            }

            case "unscramble": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}unscramble <word>` }, { quoted: m });
                    break;
                }

                const scrambleKey = `scramble:${m.from}:${m.sender}`;
                const raw = await redisClient.get(scrambleKey);
                if (!raw) {
                    await conn.sendMessage(m.from, { text: `❌ No active scramble. Start with ${prefix}scramble` }, { quoted: m });
                    break;
                }

                const { word, bet } = JSON.parse(raw);
                await redisClient.del(scrambleKey);

                if (text.toLowerCase().trim() === word) {
                    const reward = bet > 0 ? bet * 2 : 150;
                    await economy.addCoins(redisClient, m.sender, reward);
                    await giveXp(redisClient, conn, m.sender, m.from, 12);
                    await conn.sendMessage(m.from, { text: `✅ *CORRECT!*\n\n+${economy.formatCoins(reward)} coins\n+12 XP` }, { quoted: m });
                } else {
                    if (bet > 0) await economy.addCoins(redisClient, m.sender, -bet);
                    await conn.sendMessage(m.from, { text: `❌ Wrong! The word was: *${word}*${bet > 0 ? `\n-${economy.formatCoins(bet)} coins` : ''}` }, { quoted: m });
                }
                break;
            }

            case "mathquiz":
            case "math": {
                const ops = ['+', '-', '×'];
                const op = ops[Math.floor(Math.random() * ops.length)];
                let a = Math.floor(Math.random() * 50) + 1;
                let b = Math.floor(Math.random() * 50) + 1;

                let answer;
                if (op === '+') answer = a + b;
                else if (op === '-') { if (b > a) [a, b] = [b, a]; answer = a - b; }
                else { a = Math.floor(Math.random() * 12) + 1; b = Math.floor(Math.random() * 12) + 1; answer = a * b; }

                const bet = parseInt(args[0]) || 0;
                if (bet > 0) {
                    const profile = await economy.getProfile(redisClient, m.sender);
                    if (profile.coins < bet) {
                        await conn.sendMessage(m.from, { text: `❌ You don't have ${economy.formatCoins(bet)} coins.` }, { quoted: m });
                        break;
                    }
                }

                const mathKey = `math:${m.from}:${m.sender}`;
                await redisClient.set(mathKey, JSON.stringify({ answer, bet }), { EX: 30 });

                await conn.sendMessage(m.from, {
                    text: `➕ *MATH QUIZ*${bet > 0 ? ` — Bet: ${economy.formatCoins(bet)}` : ''}\n\n${a} ${op} ${b} = ?\n\nAnswer with: ${prefix}mathanswer <number>\n⏳ 30 seconds!`
                }, { quoted: m });
                break;
            }

            case "mathanswer": {
                const guess = parseInt(args[0]);
                if (isNaN(guess)) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}mathanswer <number>` }, { quoted: m });
                    break;
                }

                const mathKey = `math:${m.from}:${m.sender}`;
                const raw = await redisClient.get(mathKey);
                if (!raw) {
                    await conn.sendMessage(m.from, { text: `❌ No active math quiz. Start with ${prefix}mathquiz` }, { quoted: m });
                    break;
                }

                const { answer, bet } = JSON.parse(raw);
                await redisClient.del(mathKey);

                if (guess === answer) {
                    const reward = bet > 0 ? bet * 2 : 100;
                    await economy.addCoins(redisClient, m.sender, reward);
                    await giveXp(redisClient, conn, m.sender, m.from, 8);
                    await conn.sendMessage(m.from, { text: `✅ *CORRECT!*\n\n+${economy.formatCoins(reward)} coins\n+8 XP` }, { quoted: m });
                } else {
                    if (bet > 0) await economy.addCoins(redisClient, m.sender, -bet);
                    await conn.sendMessage(m.from, { text: `❌ Wrong! The answer was *${answer}*${bet > 0 ? `\n-${economy.formatCoins(bet)} coins` : ''}` }, { quoted: m });
                }
                break;
            }

            case "riddle": {
                const riddles = [
                    { q: "I speak without a mouth and hear without ears. What am I?", a: "echo" },
                    { q: "The more you take, the more you leave behind. What am I?", a: "footsteps" },
                    { q: "What has keys but no locks, space but no room?", a: "keyboard" },
                    { q: "What gets wetter as it dries?", a: "towel" },
                    { q: "What has a head and a tail but no body?", a: "coin" },
                    { q: "What month of the year has 28 days?", a: "all" },
                    { q: "What can travel around the world while staying in a corner?", a: "stamp" },
                    { q: "What has many teeth but cannot bite?", a: "comb" },
                ];

                const riddle = riddles[Math.floor(Math.random() * riddles.length)];
                const bet = parseInt(args[0]) || 0;

                if (bet > 0) {
                    const profile = await economy.getProfile(redisClient, m.sender);
                    if (profile.coins < bet) {
                        await conn.sendMessage(m.from, { text: `❌ You don't have ${economy.formatCoins(bet)} coins.` }, { quoted: m });
                        break;
                    }
                }

                const riddleKey = `riddle:${m.from}:${m.sender}`;
                await redisClient.set(riddleKey, JSON.stringify({ answer: riddle.a, bet }), { EX: 90 });

                await conn.sendMessage(m.from, {
                    text: `🧠 *RIDDLE*${bet > 0 ? ` — Bet: ${economy.formatCoins(bet)}` : ''}\n\n${riddle.q}\n\nAnswer with: ${prefix}riddleanswer <answer>\n⏳ 90 seconds!`
                }, { quoted: m });
                break;
            }

            case "riddleanswer": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}riddleanswer <answer>` }, { quoted: m });
                    break;
                }

                const riddleKey = `riddle:${m.from}:${m.sender}`;
                const raw = await redisClient.get(riddleKey);
                if (!raw) {
                    await conn.sendMessage(m.from, { text: `❌ No active riddle. Start with ${prefix}riddle` }, { quoted: m });
                    break;
                }

                const { answer, bet } = JSON.parse(raw);
                await redisClient.del(riddleKey);

                const correct = text.toLowerCase().trim().includes(answer.toLowerCase());

                if (correct) {
                    const reward = bet > 0 ? bet * 2 : 200;
                    await economy.addCoins(redisClient, m.sender, reward);
                    await giveXp(redisClient, conn, m.sender, m.from, 18);
                    await conn.sendMessage(m.from, { text: `✅ *CORRECT!*\n\n+${economy.formatCoins(reward)} coins\n+18 XP` }, { quoted: m });
                } else {
                    if (bet > 0) await economy.addCoins(redisClient, m.sender, -bet);
                    await conn.sendMessage(m.from, { text: `❌ Wrong! The answer was: *${answer}*${bet > 0 ? `\n-${economy.formatCoins(bet)} coins` : ''}` }, { quoted: m });
                }
                break;
            }

            case "poker": {
                const bet = parseInt(args[0]);
                if (!bet || bet <= 0) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}poker <amount>\n\n5-card draw vs the house!` }, { quoted: m });
                    break;
                }

                const profile = await economy.getProfile(redisClient, m.sender);
                if (profile.coins < bet) {
                    await conn.sendMessage(m.from, { text: `❌ You don't have ${economy.formatCoins(bet)} coins.` }, { quoted: m });
                    break;
                }

                const suits = ['♠️', '♥️', '♦️', '♣️'];
                const values = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
                const rank = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 };

                function drawHand() {
                    const hand = [];
                    for (let i = 0; i < 5; i++) {
                        const v = values[Math.floor(Math.random() * values.length)];
                        const s = suits[Math.floor(Math.random() * suits.length)];
                        hand.push({ v, s });
                    }
                    return hand;
                }

                function handScore(hand) {
                    const vals = hand.map(c => rank[c.v]).sort((a,b) => b-a);
                    const counts = {};
                    vals.forEach(v => counts[v] = (counts[v] || 0) + 1);
                    const countVals = Object.values(counts).sort((a,b) => b-a);
                    const isFlush = hand.every(c => c.s === hand[0].s);
                    const sortedUnique = [...new Set(vals)];
                    const isStraight = sortedUnique.length === 5 && (sortedUnique[0] - sortedUnique[4] === 4);

                    if (isStraight && isFlush) return { score: 8, name: 'Straight Flush' };
                    if (countVals[0] === 4) return { score: 7, name: 'Four of a Kind' };
                    if (countVals[0] === 3 && countVals[1] === 2) return { score: 6, name: 'Full House' };
                    if (isFlush) return { score: 5, name: 'Flush' };
                    if (isStraight) return { score: 4, name: 'Straight' };
                    if (countVals[0] === 3) return { score: 3, name: 'Three of a Kind' };
                    if (countVals[0] === 2 && countVals[1] === 2) return { score: 2, name: 'Two Pair' };
                    if (countVals[0] === 2) return { score: 1, name: 'One Pair' };
                    return { score: 0, name: 'High Card', high: vals[0] };
                }

                const playerHand = drawHand();
                const houseHand = drawHand();
                const playerScore = handScore(playerHand);
                const houseScore = handScore(houseHand);

                const playerStr = playerHand.map(c => `${c.v}${c.s}`).join(' ');
                const houseStr = houseHand.map(c => `${c.v}${c.s}`).join(' ');

                let won = playerScore.score > houseScore.score ||
                    (playerScore.score === houseScore.score && Math.random() < 0.5);

                if (won) {
                    await economy.addCoins(redisClient, m.sender, bet);
                    await economy.updateProfile(redisClient, m.sender, { wins: profile.wins + 1 });
                } else {
                    await economy.addCoins(redisClient, m.sender, -bet);
                    await economy.updateProfile(redisClient, m.sender, { losses: profile.losses + 1 });
                }

                await conn.sendMessage(m.from, {
                    text: `🃏 *POKER — 5 CARD DRAW*\n\nYour hand: ${playerStr}\n→ ${playerScore.name}\n\nHouse hand: ${houseStr}\n→ ${houseScore.name}\n\n${won ? `✅ YOU WIN! +${economy.formatCoins(bet)} coins` : `❌ House wins. -${economy.formatCoins(bet)} coins`}`
                }, { quoted: m });
                break;
            }

            case "highcard": {
                const bet = parseInt(args[0]);
                if (!bet || bet <= 0) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}highcard <amount>` }, { quoted: m });
                    break;
                }

                const profile = await economy.getProfile(redisClient, m.sender);
                if (profile.coins < bet) {
                    await conn.sendMessage(m.from, { text: `❌ You don't have ${economy.formatCoins(bet)} coins.` }, { quoted: m });
                    break;
                }

                const suits = ['♠️', '♥️', '♦️', '♣️'];
                const values = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
                const rank = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 };

                const playerCard = { v: values[Math.floor(Math.random() * values.length)], s: suits[Math.floor(Math.random() * suits.length)] };
                const houseCard = { v: values[Math.floor(Math.random() * values.length)], s: suits[Math.floor(Math.random() * suits.length)] };

                const playerRank = rank[playerCard.v];
                const houseRank = rank[houseCard.v];

                let result;
                if (playerRank > houseRank) {
                    await economy.addCoins(redisClient, m.sender, bet);
                    result = `✅ YOU WIN! +${economy.formatCoins(bet)} coins`;
                } else if (playerRank < houseRank) {
                    await economy.addCoins(redisClient, m.sender, -bet);
                    result = `❌ House wins. -${economy.formatCoins(bet)} coins`;
                } else {
                    result = `🤝 Tie! No coins lost.`;
                }

                await conn.sendMessage(m.from, {
                    text: `🎴 *HIGH CARD*\n\nYour card: ${playerCard.v}${playerCard.s}\nHouse card: ${houseCard.v}${houseCard.s}\n\n${result}`
                }, { quoted: m });
                break;
            }


            case "ecostats": {
                if (!senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Owner/Sudo only command." }, { quoted: m });
                    break;
                }

                if (!redisClient) break;

                try {
                    const keys = await redisClient.keys('economy:*');
                    let totalCoins = 0, totalBank = 0, totalUsers = keys.length;
                    let highestLevel = 0, totalWins = 0, totalLosses = 0;

                    for (const key of keys) {
                        const data = await redisClient.hGetAll(key);
                        totalCoins += parseInt(data.coins || '0');
                        totalBank += parseInt(data.bank || '0');
                        totalWins += parseInt(data.wins || '0');
                        totalLosses += parseInt(data.losses || '0');
                        const lvl = parseInt(data.level || '1');
                        if (lvl > highestLevel) highestLevel = lvl;
                    }

                    const guildKeys = await redisClient.keys('guild:*');
                    const teamKeys = await redisClient.keys('team:*');
                    const promoKeys = await redisClient.keys('promo:*');

                    const statsText = `
📊 *ECONOMY STATISTICS*
━━━━━━━━━━━━━━━━━━━
👥 Total Users: ${totalUsers}
💰 Total Coins (wallets): ${economy.formatCoins(totalCoins)}
🏦 Total Coins (banks): ${economy.formatCoins(totalBank)}
💎 Total Economy Value: ${economy.formatCoins(totalCoins + totalBank)}
⭐ Highest Level: ${highestLevel}
🏆 Total Wins: ${totalWins}
☠️ Total Losses: ${totalLosses}
🏰 Active Guilds: ${guildKeys.length}
👥 Active Teams: ${teamKeys.length}
🎁 Promo Codes Created: ${promoKeys.length}
                    `.trim();

                    await conn.sendMessage(m.from, { text: statsText }, { quoted: m });
                } catch (err) {
                    console.error('ecostats error:', err.message);
                    await conn.sendMessage(m.from, { text: "❌ Failed to load economy stats." }, { quoted: m });
                }
                break;
            }


            case "menu":
            case "help": {
                const os = require('os');
                const moment = require('moment-timezone');

                // ── Dynamic command count ──
                // Counts every unique `case "..."` in this file at runtime,
                // so new commands automatically increase the total.
                let totalCases = 0;
                try {
                    const selfSource = fs.readFileSync(__filename, 'utf8');
                    const matches = selfSource.match(/case\s+"[a-zA-Z0-9_]+"\s*:/g) || [];
                    totalCases = new Set(matches).size;
                } catch {
                    totalCases = '50+';
                }

                // ── Greeting based on time of day (Africa/Lagos) ──
                const hour = moment().tz('Africa/Lagos').hour();
                let greeting;
                if (hour >= 5 && hour < 12) greeting = 'Good Morning ☀️';
                else if (hour >= 12 && hour < 17) greeting = 'Good Afternoon 🌤️';
                else if (hour >= 17 && hour < 21) greeting = 'Good Evening 🌆';
                else greeting = 'Good Night 🌙';

                // ── Runtime ──
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

                const pushName = m.pushName || 'User';
                const groupName = isGroup ? (await conn.groupMetadata(m.from).then(g => g.subject).catch(() => 'Group')) : null;

                // Load economy profile for header
                let ecoProfile = null;
                try {
                    ecoProfile = await economy.getProfile(redisClient, m.sender);
                } catch {}

                const marriedLine = ecoProfile?.married
                    ? `💍 Wed: @${ecoProfile.married.split('@')[0]}`
                    : `💔 Status: Single`;

                const walletLine = ecoProfile
                    ? `💰 Wallet: ${economy.formatCoins(ecoProfile.coins)} coins`
                    : '';

                const headerText = `
💋 *L A D Y · L I Y A* 💋
━━━━━━━━━━━━━━━━━━━
✨ SYSTEM ONLINE...
👤 User: ${pushName}
🌅 Greeting: ${greeting}
💎 Available Commands: ${totalCases}
💬 Mode: ${isGroup ? groupName : 'Private Chat'}
📅 Date: ${moment().tz('Africa/Lagos').format('DD/MM/YYYY')}
⏳ Uptime: ${runtimeStr.trim()}
━━━━━━━━━━━━━━━━━━━
${walletLine}
⭐ Level: ${ecoProfile?.level || 1}
${marriedLine}
━━━━━━━━━━━━━━━━━━━
💗 Status: ACTIVE & READY
🔮 Power Level: MAXIMUM
🧠 AI Core: STABLE
🔧 Prefix: ${prefix}
━━━━━━━━━━━━━━━━━━━
💋 sassy, savage, and always one step ahead — that's Lady Liya.

╭─「 💻 VPS SPECS 」
│ • Platform: ${os.platform()}
│ • RAM: ${Math.round(os.totalmem() / 1024 / 1024 / 1024)} GB
│ • Node: ${process.version}
╰────────────

👑 Dev: Devtrust
📩 Contact: t.me/KallmeTrust
                `.trim();

                const commandsText = `
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
• ${prefix}admincheck
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

*ECONOMY*
• ${prefix}profile / ${prefix}p
• ${prefix}rank [@user]
• ${prefix}bio [set/clear] <text>
• ${prefix}title [id]
• ${prefix}ship @user1 [@user2]
• ${prefix}balance / ${prefix}bal
• ${prefix}wallet
• ${prefix}bank
• ${prefix}deposit <amount>
• ${prefix}withdraw <amount>
• ${prefix}give @user <amount>
• ${prefix}daily
• ${prefix}weekly
• ${prefix}work
• ${prefix}beg
• ${prefix}leaderboard
• ${prefix}marry @user
• ${prefix}divorce
• ${prefix}badges [@user]
• ${prefix}allbadges
• ${prefix}refcode
• ${prefix}useref <code>
• ${prefix}referrals [@user]
• ${prefix}eventinfo
• ${prefix}shop [category]
• ${prefix}buy <item>
• ${prefix}equip <item>
• ${prefix}inventory

*FUN*
• ${prefix}rate <anything>
• ${prefix}compliment [@user]
• ${prefix}8ball <question>
• ${prefix}fact
• ${prefix}meme

*GAMES*
• ${prefix}coinflip <amount> <heads/tails>
• ${prefix}dice <amount> <1-6>
• ${prefix}mines <amount> [bombs]
• ${prefix}snake
• ${prefix}up / down / left / right
• ${prefix}snakeboard
• ${prefix}tictactoe @user <bet>
• ${prefix}connect4 @user <bet>
• ${prefix}wordle
• ${prefix}typingrace
• ${prefix}guess <amount> <1-10>
• ${prefix}slots <amount>
• ${prefix}blackjack <amount>
• ${prefix}rps <amount> <rock/paper/scissors>
• ${prefix}trivia [bet]
• ${prefix}answer <answer>
• ${prefix}spin <amount>

*🎣 FISHING*
• ${prefix}fish
• ${prefix}buyrod <basic/iron/golden/legendary>

*⛏️ MINING*
• ${prefix}mine
• ${prefix}buypick <wooden/stone/iron/diamond>

*🌾 FARMING*
• ${prefix}plant <crop>
• ${prefix}farm
• ${prefix}harvest

*🏹 HUNTING*
• ${prefix}hunt

*🐾 PETS*
• ${prefix}buypet <id>
• ${prefix}mypet
• ${prefix}feedpet
• ${prefix}sellpet

*🎒 INVENTORY*
• ${prefix}inventory
• ${prefix}sell <item> [amount]

*⚔️ PvP / DUELS*
• ${prefix}duel @user <bet>
• ${prefix}accept
• ${prefix}decline

*🏰 GUILDS*
• ${prefix}createguild <name>
• ${prefix}guildinfo [name]
• ${prefix}guildinvite @user
• ${prefix}joinguild
• ${prefix}leaveguild
• ${prefix}guilddonate <amount>

*🚗 VEHICLES*
• ${prefix}vehicles
• ${prefix}buyvehicle <id>
• ${prefix}myvehicle

*🏠 PROPERTY*
• ${prefix}properties
• ${prefix}buyproperty <id>
• ${prefix}myproperties
• ${prefix}collect

*👹 BOSS RAIDS*
• ${prefix}raid
• ${prefix}attack
• ${prefix}raidstatus

*⚡ XP BOOSTS*
• ${prefix}boostshop
• ${prefix}buyboost <id>
• ${prefix}myboost

*👫 FRIENDS*
• ${prefix}addfriend @user
• ${prefix}acceptfriend @user
• ${prefix}removefriend @user
• ${prefix}friends [@user]
• ${prefix}friendrequests

*👥 TEAMS*
• ${prefix}createteam <name>
• ${prefix}teaminfo [name]
• ${prefix}jointeam <name>
• ${prefix}leaveteam

*🎁 PROMO CODES*
• ${prefix}redeem <code>
• ${prefix}createpromo <CODE> <coins> <xp> <maxUses> <hrs> (admin)

*📈 LEADERBOARDS*
• ${prefix}leaderboard — top richest
• ${prefix}toplevel — top by level
• ${prefix}topwins — top by wins

*🎮 MORE GAMES*
• ${prefix}hangman [bet]
• ${prefix}guessletter <letter>
• ${prefix}scramble [bet]
• ${prefix}unscramble <word>
• ${prefix}mathquiz [bet]
• ${prefix}mathanswer <number>
• ${prefix}riddle [bet]
• ${prefix}riddleanswer <answer>
• ${prefix}poker <amount>
• ${prefix}highcard <amount>

*📊 ADMIN*
• ${prefix}ecostats
                `.trim();

                await conn.sendMessage(m.from, {
                    image: { url: "https://i.ibb.co/vvw7nZj9/fddcfb07c80a.jpg" },
                    caption: `${headerText}\n\n${commandsText}`
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
                    await conn.sendMessage(m.from, { text: "❌ I (the bot) need to be promoted to admin in this group to do that — being the group creator doesn't give me admin rights automatically." }, { quoted: m });
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
                    await conn.sendMessage(m.from, { text: "❌ I (the bot) need to be promoted to admin in this group to do that — being the group creator doesn't give me admin rights automatically." }, { quoted: m });
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
                    await conn.sendMessage(m.from, { text: "❌ I (the bot) need to be promoted to admin in this group to do that — being the group creator doesn't give me admin rights automatically." }, { quoted: m });
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
                    await conn.sendMessage(m.from, { text: "❌ I (the bot) need to be promoted to admin in this group to do that — being the group creator doesn't give me admin rights automatically." }, { quoted: m });
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
                    await conn.sendMessage(m.from, { text: "❌ I (the bot) need to be promoted to admin in this group to do that — being the group creator doesn't give me admin rights automatically." }, { quoted: m });
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
                    await conn.sendMessage(m.from, { text: "❌ I (the bot) need to be promoted to admin in this group to do that — being the group creator doesn't give me admin rights automatically." }, { quoted: m });
                    break;
                }

                await conn.groupSettingUpdate(m.from, 'not_announcement');
                await conn.sendMessage(m.from, { text: "🔊 Group unmuted — everyone can send messages." }, { quoted: m });
                break;
            }

            case "admincheck": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ This command only works in groups." }, { quoted: m });
                    break;
                }

                try {
                    const meta = await conn.groupMetadata(m.from);
                    const botRawJid = conn.user.id;
                    const botRawLid = conn.user.lid;
                    const botNum = normalizeJid(botRawJid);
                    const botLid = normalizeJid(botRawLid);

                    const lines = meta.participants.map(p => {
                        const norm = normalizeJid(p.id);
                        let match = '';
                        if (norm === botNum) match = ' ⬅️ MATCHES BOT (id)';
                        else if (botLid && norm === botLid) match = ' ⬅️ MATCHES BOT (lid)';
                        return `${p.id} (admin: ${p.admin || 'none'})${match}`;
                    });

                    const debugText = `
🔍 *Admin Check Debug*

Bot raw JID: ${botRawJid}
Bot raw LID: ${botRawLid || '(none)'}
Bot normalized id: ${botNum}
Bot normalized lid: ${botLid || '(none)'}

*Participants:*
${lines.join('\n')}
                    `.trim();

                    if (debugText.length > 4000) {
                        await conn.sendMessage(m.from, { text: debugText.slice(0, 4000) }, { quoted: m });
                        await conn.sendMessage(m.from, { text: debugText.slice(4000) });
                    } else {
                        await conn.sendMessage(m.from, { text: debugText }, { quoted: m });
                    }
                } catch (err) {
                    await conn.sendMessage(m.from, { text: `❌ ${err.message}` }, { quoted: m });
                }
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
            // SEASONAL EVENTS (Super admin only — applies GLOBALLY
            // across every session, not just this one)
            // ════════════════════════════════════════════
            case "startevent": {
                if (!isSuperAdmin(m, phoneNumber)) {
                    await conn.sendMessage(m.from, { text: "❌ This command is restricted to the bot developer only." }, { quoted: m });
                    break;
                }

                const presetId = args[0]?.toLowerCase();
                const hoursArg = args[1] ? parseFloat(args[1]) : null;

                if (!presetId) {
                    const list = events.EVENT_PRESETS.map(p =>
                        `• \`${p.id}\` — ${p.emoji} ${p.name} (${p.multiplier}x${p.xpOnly ? ', XP only' : p.coinsOnly ? ', coins only' : ', all'})`
                    ).join('\n');
                    await conn.sendMessage(m.from, {
                        text: `❌ Usage: ${prefix}startevent <preset> [hours]\n\nPresets:\n${list}\n\nOmit hours to run until ${prefix}endevent is used manually.`
                    }, { quoted: m });
                    break;
                }

                const preset = events.getPreset(presetId);
                if (!preset) {
                    await conn.sendMessage(m.from, { text: `❌ Unknown preset "${presetId}". Use ${prefix}startevent with no args to see the list.` }, { quoted: m });
                    break;
                }

                const event = await events.startEvent(redisClient, {
                    name: preset.name,
                    emoji: preset.emoji,
                    multiplier: preset.multiplier,
                    xpOnly: preset.xpOnly,
                    coinsOnly: preset.coinsOnly,
                    durationHours: hoursArg,
                    startedBy: m.sender
                });

                const scopeText = event.xpOnly ? 'XP only' : event.coinsOnly ? 'Coins only' : 'Coins + XP';
                await conn.sendMessage(m.from, {
                    text: `🎉 *${event.emoji} ${event.name} Started!*\n\nMultiplier: *${event.multiplier}x* (${scopeText})\nDuration: ${events.formatTimeRemaining(event)}\n\nThis applies globally across every session. Use ${prefix}endevent to stop it early.`
                }, { quoted: m });

                // ── Notify every paired session owner so they know free stuff is active ──
                const broadcastText = `🎉 *${event.emoji} ${event.name} is LIVE!*\n\nAll ${scopeText.toLowerCase()} rewards are boosted *${event.multiplier}x* right now!\n⏳ ${events.formatTimeRemaining(event)}\n\nPlay games, claim your daily, grind — everything pays out more while this lasts!`;
                broadcastToOwners(redisClient, connections, broadcastText).catch(() => {});
                break;
            }

            case "endevent": {
                if (!isSuperAdmin(m, phoneNumber)) {
                    await conn.sendMessage(m.from, { text: "❌ This command is restricted to the bot developer only." }, { quoted: m });
                    break;
                }

                const ended = await events.endEvent(redisClient);
                if (!ended) {
                    await conn.sendMessage(m.from, { text: `❌ No event is currently active.` }, { quoted: m });
                    break;
                }

                await conn.sendMessage(m.from, {
                    text: `🛑 *${ended.emoji} ${ended.name}* has been ended.`
                }, { quoted: m });

                // ── Notify every paired session owner that the bonus period is over ──
                const endBroadcastText = `🛑 *${ended.emoji} ${ended.name} has ended.*\n\nRewards are back to normal. Thanks for playing — watch out for the next event! 👀`;
                broadcastToOwners(redisClient, connections, endBroadcastText).catch(() => {});
                break;
            }

            case "eventinfo":
            case "currentevent": {
                const active = await events.getActiveEvent(redisClient);
                if (!active) {
                    await conn.sendMessage(m.from, { text: `📅 No seasonal event is currently active.` }, { quoted: m });
                    break;
                }

                const scopeText = active.xpOnly ? 'XP only' : active.coinsOnly ? 'Coins only' : 'Coins + XP';
                await conn.sendMessage(m.from, {
                    text: `📅 *Active Event*\n\n${active.emoji} *${active.name}*\nMultiplier: *${active.multiplier}x* (${scopeText})\n⏳ ${events.formatTimeRemaining(active)}`
                }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // SHOP (coin sinks: boosters, titles, themes, revives)
            // ════════════════════════════════════════════
            case "shop": {
                const category = args[0]?.toLowerCase();

                if (!category) {
                    await conn.sendMessage(m.from, {
                        text: `🛒 *Lady Liya Shop*\n\nBrowse a category:\n• ${prefix}shop boosters — XP & Luck boosters\n• ${prefix}shop titles — equip-only profile titles\n• ${prefix}shop themes — profile color themes\n• ${prefix}shop revive — Mines/Snake revive tokens\n\nBuy with ${prefix}buy <item id>`
                    }, { quoted: m });
                    break;
                }

                if (category === 'boosters') {
                    const xpLines = shop.XP_BOOSTERS.map(b => `${b.emoji} \`${b.id}\` — ${b.name} (${b.multiplier}x) — ${economy.formatCoins(b.price)} coins`);
                    const luckLines = shop.LUCK_BOOSTERS.map(b => `${b.emoji} \`${b.id}\` — ${b.name} (${b.multiplier}x) — ${economy.formatCoins(b.price)} coins`);
                    await conn.sendMessage(m.from, {
                        text: `⚡ *XP Boosters*\n${xpLines.join('\n')}\n\n🍀 *Luck Boosters*\n${luckLines.join('\n')}\n\nBuy with ${prefix}buy <id>`
                    }, { quoted: m });
                    break;
                }

                if (category === 'titles') {
                    const owned = await shop.getOwnedList(redisClient, m.sender, 'titles');
                    const lines = shop.TITLES.map(t => `${owned.includes(t.id) ? '✅' : '🔒'} \`${t.id}\` — ${t.name} — ${economy.formatCoins(t.price)} coins`);
                    await conn.sendMessage(m.from, {
                        text: `🏷️ *Titles*\n${lines.join('\n')}\n\nBuy with ${prefix}buy <id>, equip with ${prefix}equip <id>`
                    }, { quoted: m });
                    break;
                }

                if (category === 'themes') {
                    const owned = await shop.getOwnedList(redisClient, m.sender, 'themes');
                    const lines = shop.THEMES.map(t => `${owned.includes(t.id) || t.price === 0 ? '✅' : '🔒'} ${t.emoji} \`${t.id}\` — ${t.name} — ${t.price === 0 ? 'Free' : economy.formatCoins(t.price) + ' coins'}`);
                    await conn.sendMessage(m.from, {
                        text: `🎨 *Themes*\n${lines.join('\n')}\n\nBuy with ${prefix}buy <id>, equip with ${prefix}equip <id>`
                    }, { quoted: m });
                    break;
                }

                if (category === 'revive') {
                    const tokens = await shop.getReviveTokens(redisClient, m.sender);
                    await conn.sendMessage(m.from, {
                        text: `💊 *Revive Token*\n\n${shop.REVIVE_TOKEN.description}\n\nPrice: ${economy.formatCoins(shop.REVIVE_TOKEN.price)} coins\nYou own: *${tokens}*\n\nBuy with ${prefix}buy revive_token`
                    }, { quoted: m });
                    break;
                }

                await conn.sendMessage(m.from, { text: `❌ Unknown category. Try: boosters, titles, themes, revive` }, { quoted: m });
                break;
            }

            case "buy": {
                const itemId = args[0]?.toLowerCase();
                if (!itemId) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}buy <item id>\n\nBrowse with ${prefix}shop` }, { quoted: m });
                    break;
                }

                const profile = await economy.getProfile(redisClient, m.sender);

                // Revive token
                if (itemId === shop.REVIVE_TOKEN.id) {
                    if (profile.coins < shop.REVIVE_TOKEN.price) {
                        await conn.sendMessage(m.from, { text: `❌ You need ${economy.formatCoins(shop.REVIVE_TOKEN.price)} coins.` }, { quoted: m });
                        break;
                    }
                    await economy.addCoins(redisClient, m.sender, -shop.REVIVE_TOKEN.price);
                    const total = await shop.addReviveTokens(redisClient, m.sender, 1);
                    await conn.sendMessage(m.from, { text: `💊 Bought a Revive Token! You now have *${total}*.` }, { quoted: m });
                    break;
                }

                // XP / Luck boosters
                const xpBooster = shop.findItem(shop.XP_BOOSTERS, itemId);
                const luckBooster = shop.findItem(shop.LUCK_BOOSTERS, itemId);
                const booster = xpBooster || luckBooster;
                if (booster) {
                    if (profile.coins < booster.price) {
                        await conn.sendMessage(m.from, { text: `❌ You need ${economy.formatCoins(booster.price)} coins.` }, { quoted: m });
                        break;
                    }
                    await economy.addCoins(redisClient, m.sender, -booster.price);
                    const field = xpBooster ? 'xpBoost' : 'luckBoost';
                    await shop.setBoost(redisClient, m.sender, field, booster.multiplier, booster.durationMs);
                    const hours = (booster.durationMs / (60 * 60 * 1000)).toFixed(1);
                    await conn.sendMessage(m.from, { text: `${booster.emoji} *${booster.name}* activated! ${booster.multiplier}x for ${hours}h.` }, { quoted: m });
                    break;
                }

                // Titles
                const title = shop.findItem(shop.TITLES, itemId);
                if (title) {
                    const owned = await shop.getOwnedList(redisClient, m.sender, 'titles');
                    if (owned.includes(title.id)) {
                        await conn.sendMessage(m.from, { text: `❌ You already own this title. Equip it with ${prefix}equip ${title.id}` }, { quoted: m });
                        break;
                    }
                    if (profile.coins < title.price) {
                        await conn.sendMessage(m.from, { text: `❌ You need ${economy.formatCoins(title.price)} coins.` }, { quoted: m });
                        break;
                    }
                    await economy.addCoins(redisClient, m.sender, -title.price);
                    await shop.addToOwnedList(redisClient, m.sender, 'titles', title.id);
                    await conn.sendMessage(m.from, { text: `🏷️ Bought title *${title.name}*! Equip with ${prefix}equip ${title.id}` }, { quoted: m });
                    break;
                }

                // Themes
                const theme = shop.findItem(shop.THEMES, itemId);
                if (theme) {
                    if (theme.price === 0) {
                        await conn.sendMessage(m.from, { text: `❌ This theme is free — just equip it with ${prefix}equip ${theme.id}` }, { quoted: m });
                        break;
                    }
                    const owned = await shop.getOwnedList(redisClient, m.sender, 'themes');
                    if (owned.includes(theme.id)) {
                        await conn.sendMessage(m.from, { text: `❌ You already own this theme. Equip it with ${prefix}equip ${theme.id}` }, { quoted: m });
                        break;
                    }
                    if (profile.coins < theme.price) {
                        await conn.sendMessage(m.from, { text: `❌ You need ${economy.formatCoins(theme.price)} coins.` }, { quoted: m });
                        break;
                    }
                    await economy.addCoins(redisClient, m.sender, -theme.price);
                    await shop.addToOwnedList(redisClient, m.sender, 'themes', theme.id);
                    await conn.sendMessage(m.from, { text: `🎨 Bought theme *${theme.name}*! Equip with ${prefix}equip ${theme.id}` }, { quoted: m });
                    break;
                }

                await conn.sendMessage(m.from, { text: `❌ Unknown item "${itemId}". Browse with ${prefix}shop` }, { quoted: m });
                break;
            }

            case "equip": {
                const itemId = args[0]?.toLowerCase();
                if (!itemId) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}equip <item id>` }, { quoted: m });
                    break;
                }

                const title = shop.findItem(shop.TITLES, itemId);
                if (title) {
                    const owned = await shop.getOwnedList(redisClient, m.sender, 'titles');
                    if (!owned.includes(title.id)) {
                        await conn.sendMessage(m.from, { text: `❌ You don't own this title. Buy it with ${prefix}buy ${title.id}` }, { quoted: m });
                        break;
                    }
                    await shop.equipItem(redisClient, m.sender, 'equippedTitle', title.id);
                    await conn.sendMessage(m.from, { text: `✅ Equipped title: *${title.name}*` }, { quoted: m });
                    break;
                }

                const theme = shop.findItem(shop.THEMES, itemId);
                if (theme) {
                    const owned = await shop.getOwnedList(redisClient, m.sender, 'themes');
                    if (theme.price > 0 && !owned.includes(theme.id)) {
                        await conn.sendMessage(m.from, { text: `❌ You don't own this theme. Buy it with ${prefix}buy ${theme.id}` }, { quoted: m });
                        break;
                    }
                    await shop.equipItem(redisClient, m.sender, 'equippedTheme', theme.id);
                    await conn.sendMessage(m.from, { text: `✅ Equipped theme: ${theme.emoji} *${theme.name}*` }, { quoted: m });
                    break;
                }

                await conn.sendMessage(m.from, { text: `❌ Unknown item "${itemId}".` }, { quoted: m });
                break;
            }

            case "mytitles":
            case "myitems": {
                const titles = await shop.getOwnedList(redisClient, m.sender, 'titles');
                const themes = await shop.getOwnedList(redisClient, m.sender, 'themes');
                const tokens = await shop.getReviveTokens(redisClient, m.sender);
                const equippedTitle = await shop.getEquipped(redisClient, m.sender, 'equippedTitle');
                const equippedTheme = await shop.getEquipped(redisClient, m.sender, 'equippedTheme');
                const xpBoost = await shop.getActiveBoost(redisClient, m.sender, 'xpBoost');
                const luckBoost = await shop.getActiveBoost(redisClient, m.sender, 'luckBoost');

                const titleNames = titles.map(id => shop.findItem(shop.TITLES, id)?.name).filter(Boolean);
                const themeNames = themes.map(id => shop.findItem(shop.THEMES, id)?.name).filter(Boolean);

                let boostText = '';
                if (xpBoost) boostText += `⚡ XP Boost: ${xpBoost.multiplier}x (${events.formatTimeRemaining({ endsAt: xpBoost.expiresAt })})\n`;
                if (luckBoost) boostText += `🍀 Luck Boost: ${luckBoost.multiplier}x (${events.formatTimeRemaining({ endsAt: luckBoost.expiresAt })})\n`;

                await conn.sendMessage(m.from, {
                    text: `🎒 *Shop Items*\n\n🏷️ Titles: ${titleNames.length ? titleNames.join(', ') : 'None'}\n   Equipped: ${equippedTitle ? shop.findItem(shop.TITLES, equippedTitle)?.name : 'None'}\n\n🎨 Themes: ${themeNames.length ? themeNames.join(', ') : 'Default only'}\n   Equipped: ${equippedTheme ? shop.findItem(shop.THEMES, equippedTheme)?.name : 'Default'}\n\n💊 Revive Tokens: ${tokens}\n\n${boostText || 'No active boosts.'}`
                }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // DEV / DIAGNOSTIC COMMANDS (Owner only — powerful)
            // ════════════════════════════════════════════
            case "eval": {
                if (!isSuperAdmin(m, phoneNumber)) {
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
                if (!isSuperAdmin(m, phoneNumber)) {
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
                if (!isSuperAdmin(m, phoneNumber)) {
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
                if (!isSuperAdmin(m, phoneNumber)) {
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
                if (!isSuperAdmin(m, phoneNumber)) {
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
                if (!isSuperAdmin(m, phoneNumber)) {
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
                if (!isSuperAdmin(m, phoneNumber)) {
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
                if (!isSuperAdmin(m, phoneNumber)) {
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

                await setConfigValue(redisClient, phoneNumber, 'antiDelete', state === 'on');
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

                await setConfigValue(redisClient, phoneNumber, 'antiEdit', state === 'on');
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
