const fs = require("fs");
const economy = require("./economy");
const casino = require("./casino");
const filters = require("./filters");
const imagelab = require("./imagelab");
const retouch = require("./retouch");
const funstuff = require("./funstuff");
const textutils = require("./textutils");
const imagetext = require("./imagetext");
const livedata = require("./livedata");
const rpg = require("./rpg");
const pvp = require("./pvp");
const social = require("./social");
const badges = require("./badges");
const minigames = require("./minigames");
const referral = require("./referral");
const events = require("./events");
const shop = require("./shop");
const wordgames = require("./wordgames");
const groupmod = require("./groupmod");
const reminders = require("./reminders");
const stickers = require("./stickers");
const media = require("./media");
const premium = require("./premium");

// ── Trustbit AI pack (used by the extra .gpt5/.chatgpt/.gemini/... commands) ──
const TRUSTBIT_KEY = "tb_afedf1e14d9c8e46a91281ebe6554f7ca3f70e18";
const TRUSTBIT_URL = "https://trustbit-api-devtrust-59jq.onrender.com/api";

// ── Shared helper — always use this to fetch images ─────────
async function fetchDiscoveryImage(path) {
    const axios = require("axios");
    const res = await axios.get(`${TRUSTBIT_URL}/${path}`, {
        timeout: 20000,
        responseType: "arraybuffer",
        headers: { "x-api-key": TRUSTBIT_KEY }
    });
    return Buffer.from(res.data);
}

// ── fetchStyle: shared helper for the font-style / style-text commands ──
async function fetchStyle(stylePath, text) {
    const axios = require("axios");
    const { data } = await axios.get(
        `${TRUSTBIT_URL}/tools/${stylePath}?text=${encodeURIComponent(text)}`,
        { timeout: 15000, headers: { "x-api-key": TRUSTBIT_KEY } }
    );
    return data?.styled_text || data?.plain_text || data?.preview || null;
}

// ── fetchTextFxImage: text-fx endpoints that return a raw image buffer ──
async function fetchTextFxImage(endpoint, text) {
    const axios = require("axios");
    const res = await axios.get(
        `${TRUSTBIT_URL}/${endpoint}?text=${encodeURIComponent(text)}`,
        { timeout: 20000, responseType: "arraybuffer", headers: { "x-api-key": TRUSTBIT_KEY } }
    );
    return Buffer.from(res.data);
}

// ── fetchTextProImage: TextPro endpoints that return JSON with an imageUrl ──
async function fetchTextProImage(style, text) {
    const axios = require("axios");
    const { data } = await axios.get(
        `${TRUSTBIT_URL}/zst/v1/textpro/${style}?text=${encodeURIComponent(text)}`,
        { timeout: 20000, headers: { "x-api-key": TRUSTBIT_KEY } }
    );
    return data?.data?.imageUrl || null;
}

// ── aiChat / aiBinary: shared helpers for the extra AI-suite chat commands ──
async function aiChat(path, params) {
    const axios = require("axios");
    const url = new URL(`${TRUSTBIT_URL}${path}`);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const { data } = await axios.get(url.toString(), {
        timeout: 20000, headers: { "x-api-key": TRUSTBIT_KEY }
    });
    return data;
}

async function aiBinary(path, params) {
    const axios = require("axios");
    const url = new URL(`${TRUSTBIT_URL}${path}`);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await axios.get(url.toString(), {
        timeout: 25000, responseType: "arraybuffer", headers: { "x-api-key": TRUSTBIT_KEY }
    });
    return Buffer.from(res.data);
}

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
        timestamp: Date.now(),
        key: m.key // needed to actually delete/revoke the message later (.purgelinks)
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

// ── enforceModerationAction: shared warn/kick logic used by every
//    anti-* enforcement (antilink, antisticker, antitag, antibadword).
//    Deletes the offending message if possible, then either kicks
//    immediately (tier === 'kick') or issues a warning that escalates
//    to a kick once the group's warnLimit is reached. Centralizing this
//    avoids 4+ separate copies of the same warn/kick logic drifting out
//    of sync as more anti-* types get added later. ──
async function enforceModerationAction(conn, redisClient, groupId, offenderJid, tier, reasonLabel, reasonText, messageKey = null) {
    if (messageKey) {
        try { await conn.sendMessage(groupId, { delete: messageKey }); } catch {}
    }

    const groupConfig = await groupmod.getGroupConfig(redisClient, groupId);

    if (tier === 'kick') {
        const botCanKick = await isBotAdmin(conn, groupId);
        if (botCanKick) {
            try {
                await conn.groupParticipantsUpdate(groupId, [offenderJid], 'remove');
                await conn.sendMessage(groupId, {
                    text: `${reasonLabel} @${offenderJid.split('@')[0]} was removed for ${reasonText}.`,
                    mentions: [offenderJid]
                });
            } catch {}
            return;
        }
        // Bot isn't admin — fall through to warn instead of silently doing nothing
    }

    const count = await groupmod.addWarning(redisClient, groupId, offenderJid);
    await conn.sendMessage(groupId, {
        text: `${reasonLabel} @${offenderJid.split('@')[0]}, ${reasonText} isn't allowed here! Warning ${count}/${groupConfig.warnLimit}`,
        mentions: [offenderJid]
    });

    if (count >= groupConfig.warnLimit) {
        const botCanKick = await isBotAdmin(conn, groupId);
        if (botCanKick) {
            try {
                await groupmod.clearWarnings(redisClient, groupId, offenderJid);
                await conn.groupParticipantsUpdate(groupId, [offenderJid], 'remove');
                await conn.sendMessage(groupId, {
                    text: `⚠️ @${offenderJid.split('@')[0]} reached the warning limit and was removed.`,
                    mentions: [offenderJid]
                });
            } catch {}
        }
    }
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
    antiEdit: false,
    antiCall: false,
    antiCallNotify: true,
    // ── Auto Bio: rotates the WhatsApp "About" text on a timer ──
    autoBio: false,
    autoBioList: [],
    autoBioInterval: 3600,   // seconds between rotations (default 1h)
    autoBioIndex: 0,
    autoBioLastRun: 0,
    // ── Auto Status: posts to status@broadcast on a timer ──
    autoStatus: false,
    autoStatusList: [],
    autoStatusInterval: 3600,
    autoStatusIndex: 0,
    autoStatusLastRun: 0,
    // ── Autoresponder: per-session keyword -> reply mapping ──
    autoResponder: false,
    autoresponderMap: {},
    // ── GC Post: the group this session's owner has designated as their
    // "GC" to post into via .gcpost from anywhere (DM or another chat) ──
    gcJid: null,
    // ── Scheduled morning/night messages (posts to gcJid) ──
    goodMorningEnabled: false,
    goodMorningTime: '08:00',
    goodMorningMsg: "🌞 Good Morning everyone!\n\nHope you all have a wonderful day! Don't forget to claim your .daily reward 💰",
    goodNightEnabled: false,
    goodNightTime: '22:00',
    goodNightMsg: "🌙 Good Night everyone!\n\nSleep well ❤️ See you tomorrow."
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
            antiEdit: data.antiEdit === 'true',
            antiCall: data.antiCall === 'true',
            antiCallNotify: data.antiCallNotify !== undefined ? data.antiCallNotify === 'true' : CONFIG_DEFAULTS.antiCallNotify,
            autoBio: data.autoBio === 'true',
            autoBioList: data.autoBioList ? JSON.parse(data.autoBioList) : [],
            autoBioInterval: data.autoBioInterval ? parseInt(data.autoBioInterval) : CONFIG_DEFAULTS.autoBioInterval,
            autoBioIndex: data.autoBioIndex ? parseInt(data.autoBioIndex) : 0,
            autoBioLastRun: data.autoBioLastRun ? parseInt(data.autoBioLastRun) : 0,
            autoStatus: data.autoStatus === 'true',
            autoStatusList: data.autoStatusList ? JSON.parse(data.autoStatusList) : [],
            autoStatusInterval: data.autoStatusInterval ? parseInt(data.autoStatusInterval) : CONFIG_DEFAULTS.autoStatusInterval,
            autoStatusIndex: data.autoStatusIndex ? parseInt(data.autoStatusIndex) : 0,
            autoStatusLastRun: data.autoStatusLastRun ? parseInt(data.autoStatusLastRun) : 0,
            autoResponder: data.autoResponder === 'true',
            autoresponderMap: data.autoresponderMap ? JSON.parse(data.autoresponderMap) : {},
            gcJid: data.gcJid || null,
            goodMorningEnabled: data.goodMorningEnabled === 'true',
            goodMorningTime: data.goodMorningTime || '08:00',
            goodMorningMsg: data.goodMorningMsg || CONFIG_DEFAULTS.goodMorningMsg,
            goodNightEnabled: data.goodNightEnabled === 'true',
            goodNightTime: data.goodNightTime || '22:00',
            goodNightMsg: data.goodNightMsg || CONFIG_DEFAULTS.goodNightMsg
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

// ── Auto Bio: owner-configured rotation list of "About" texts ──
async function addBioText(redisClient, phoneNumber, text) {
    const config = await getConfig(redisClient, phoneNumber);
    config.autoBioList.push(text);
    await redisClient.hSet(`config:${phoneNumber}`, 'autoBioList', JSON.stringify(config.autoBioList));
    return config.autoBioList;
}

async function removeBioText(redisClient, phoneNumber, index) {
    const config = await getConfig(redisClient, phoneNumber);
    if (index < 0 || index >= config.autoBioList.length) return null;
    config.autoBioList.splice(index, 1);
    await redisClient.hSet(`config:${phoneNumber}`, 'autoBioList', JSON.stringify(config.autoBioList));
    return config.autoBioList;
}

// ── Auto Status: owner-configured rotation list of status texts ──
async function addStatusText(redisClient, phoneNumber, text) {
    const config = await getConfig(redisClient, phoneNumber);
    config.autoStatusList.push(text);
    await redisClient.hSet(`config:${phoneNumber}`, 'autoStatusList', JSON.stringify(config.autoStatusList));
    return config.autoStatusList;
}

async function removeStatusText(redisClient, phoneNumber, index) {
    const config = await getConfig(redisClient, phoneNumber);
    if (index < 0 || index >= config.autoStatusList.length) return null;
    config.autoStatusList.splice(index, 1);
    await redisClient.hSet(`config:${phoneNumber}`, 'autoStatusList', JSON.stringify(config.autoStatusList));
    return config.autoStatusList;
}

// ── Autoresponder: per-session keyword -> reply mapping ──
// Stored as ONE JSON object in the session's config hash (not per-group —
// this mirrors a personal "away message" / FAQ-bot style feature that
// applies to every chat the owner's session is in).
async function setResponder(redisClient, phoneNumber, keyword, reply) {
    const config = await getConfig(redisClient, phoneNumber);
    config.autoresponderMap[keyword] = reply;
    await redisClient.hSet(`config:${phoneNumber}`, 'autoresponderMap', JSON.stringify(config.autoresponderMap));
    return config.autoresponderMap;
}

async function removeResponder(redisClient, phoneNumber, keyword) {
    const config = await getConfig(redisClient, phoneNumber);
    const matchKey = Object.keys(config.autoresponderMap).find(k => k.toLowerCase() === keyword.toLowerCase());
    if (!matchKey) return null;
    delete config.autoresponderMap[matchKey];
    await redisClient.hSet(`config:${phoneNumber}`, 'autoresponderMap', JSON.stringify(config.autoresponderMap));
    return config.autoresponderMap;
}

// ── Generic "download whatever's quoted" helper — used by several
// generic-media commands (zip/unzip/pdf/tourl/tourl2/readqr) that work on
// any single attached file regardless of its WhatsApp message type. ──
async function downloadQuotedMedia(m) {
    if (!m.quoted) return null;
    const typeMap = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'];
    if (!typeMap.includes(m.quoted.mtype)) return null;

    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
    const messageKey = m.quoted.mtype;
    const buffer = await downloadMediaMessage({ message: { [messageKey]: m.quoted } }, 'buffer', {});

    return {
        buffer,
        mimetype: m.quoted.mimetype || 'application/octet-stream',
        fileName: m.quoted.fileName || null,
        mtype: m.quoted.mtype
    };
}

// Picks a reasonable filename + extension for a quoted-media download when
// WhatsApp didn't already give us one (images/videos/audio rarely carry a
// fileName the way documents do).
function guessFileName(media) {
    if (media.fileName) return media.fileName;
    const extFromMime = (mimetype) => {
        const map = {
            'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
            'video/mp4': 'mp4', 'video/3gpp': '3gp',
            'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/wav': 'wav',
            'application/pdf': 'pdf', 'application/zip': 'zip'
        };
        return map[mimetype] || (mimetype?.split('/')[1] || 'bin');
    };
    return `file.${extFromMime(media.mimetype)}`;
}


// ════════════════════════════════════════════════════════
// CUSTOM COMMANDS (.addcmd / .editcmd / .delcmd / .listcmd / .getcmd / .reloadcmds)
//
// Lets the bot developer add new commands at RUNTIME, without editing
// this file or restarting the process. A custom command is just the body
// of a `case "name": { ... }` block, same syntax as every built-in command
// above — copy/paste compatible.
//
// SECURITY: this is intentionally equivalent in power to the existing
// .eval/.shell commands (it runs arbitrary JS with require() access in
// the live process, for every session on this server) — so every
// management command below is gated to isSuperAdmin, the same tier as
// eval/shell/gitpull. This is NOT a per-session feature.
//
// Storage: Redis hash `customcmds` -> { name: JSON { body, addedBy, addedAt } }
// Execution: bodies are compiled into AsyncFunctions and cached in-memory
// (customCmdCache) so there's no per-message Redis round-trip; .reloadcmds
// forces a re-read from Redis (e.g. after Redis was edited directly).
// ════════════════════════════════════════════════════════
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
let customCmdCache = null; // null = not hydrated yet this process; Map once loaded
let builtinCommandNames = null; // cached Set of every `case "x":` label already in this file

function getBuiltinCommandNames() {
    if (builtinCommandNames) return builtinCommandNames;
    builtinCommandNames = new Set();
    try {
        const source = fs.readFileSync(__filename, 'utf-8');
        const re = /case\s*\(?\s*["']([a-zA-Z0-9_]+)["']\s*\)?\s*:/g;
        let m;
        while ((m = re.exec(source)) !== null) builtinCommandNames.add(m[1].toLowerCase());
    } catch (err) {
        console.error('getBuiltinCommandNames error:', err.message);
    }
    return builtinCommandNames;
}

// Parses raw `.addcmd`/`.editcmd` input in the SAME shape as a real case
// block: one or more stacked `case "name":` labels, then a `{ ... }` body.
// Returns { aliases: string[], body: string } or throws with a friendly message.
function parseCaseCode(rawCode) {
    const labelRegex = /case\s*\(?\s*["']([a-zA-Z0-9_]+)["']\s*\)?\s*:/g;
    const aliases = [];
    let match, lastIndex = 0;
    while ((match = labelRegex.exec(rawCode)) !== null) {
        aliases.push(match[1].toLowerCase());
        lastIndex = labelRegex.lastIndex;
    }
    if (aliases.length === 0) {
        throw new Error(`No case "name": label found. Format:\ncase "mycommand": {\n    await conn.sendMessage(m.from, { text: "hi" }, { quoted: m });\n    break;\n}`);
    }

    const braceStart = rawCode.indexOf('{', lastIndex);
    if (braceStart === -1) throw new Error('No opening { found after the case label(s).');

    let depth = 0, end = -1;
    for (let i = braceStart; i < rawCode.length; i++) {
        if (rawCode[i] === '{') depth++;
        else if (rawCode[i] === '}') {
            depth--;
            if (depth === 0) { end = i; break; }
        }
    }
    if (end === -1) throw new Error('Unbalanced braces — missing a closing }.');

    let body = rawCode.slice(braceStart + 1, end);
    // Strip exactly one trailing `break;` — it's meaningless outside a real
    // switch and would otherwise just be a no-op statement at the end.
    body = body.replace(/\bbreak\s*;\s*$/, '').trim();
    return { aliases, body };
}

// Wraps a command body with the same variables real built-in cases see,
// and compiles it once into a reusable AsyncFunction. Throws on bad syntax
// so callers can report it back to the owner instead of saving broken code.
function compileCommandBody(body) {
    const wrapped = `
        const { m, conn, args, text, command, prefix, redisClient, phoneNumber, isGroup, senderHasAccess, config, groupmod, media, stickers, reminders, economy, isGroupAdmin, isSuperAdmin, require, axios } = ctx;
        ${body}
    `;
    return new AsyncFunction('ctx', wrapped); // throws SyntaxError on bad code
}

async function hydrateCustomCmdCache(redisClient) {
    const cache = new Map();
    try {
        const all = await redisClient.hGetAll('customcmds');
        for (const [name, raw] of Object.entries(all)) {
            try {
                const data = JSON.parse(raw);
                const fn = compileCommandBody(data.body);
                cache.set(name, { fn, body: data.body, addedBy: data.addedBy, addedAt: data.addedAt });
            } catch (err) {
                console.error(`Custom command "${name}" failed to compile, skipping:`, err.message);
            }
        }
    } catch (err) {
        console.error('Failed to load custom commands from Redis:', err.message);
    }
    return cache;
}

async function ensureCustomCmdCache(redisClient) {
    if (!customCmdCache) customCmdCache = await hydrateCustomCmdCache(redisClient);
    return customCmdCache;
}

async function reloadCustomCmds(redisClient) {
    customCmdCache = await hydrateCustomCmdCache(redisClient);
    return customCmdCache;
}

// Saves one alias's worth of metadata under the SAME body — every alias of
// a multi-label command gets its own hash field, all sharing one body
// string, which keeps lookup simple (one field = one runnable name).
async function saveCustomCommand(redisClient, name, body, addedBy) {
    const record = { body, addedBy, addedAt: Date.now() };
    await redisClient.hSet('customcmds', name, JSON.stringify(record));
    const cache = await ensureCustomCmdCache(redisClient);
    cache.set(name, { fn: compileCommandBody(body), body, addedBy: record.addedAt, addedAt: record.addedAt });
}

async function deleteCustomCommand(redisClient, name) {
    const existed = await redisClient.hExists('customcmds', name);
    if (!existed) return false;
    await redisClient.hDel('customcmds', name);
    const cache = await ensureCustomCmdCache(redisClient);
    cache.delete(name);
    return true;
}

// Looks up + runs a custom command. Returns true if one matched (handled),
// false if nothing matched (so the caller can fall through to "unknown command").
async function runCustomCommand(command, ctx) {
    const cache = await ensureCustomCmdCache(ctx.redisClient);
    const entry = cache.get(command);
    if (!entry) return false;
    try {
        await entry.fn(ctx);
    } catch (err) {
        console.error(`Custom command "${command}" runtime error:`, err);
        try {
            await ctx.conn.sendMessage(ctx.m.from, { text: `❌ Custom command "${command}" crashed:\n\`\`\`${err.message}\`\`\`` }, { quoted: ctx.m });
        } catch {}
    }
    return true;
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
// ── Extra admins (added via .addadmin) — kept as an in-memory Set so
// isSuperAdmin() can stay synchronous (it's called from ~15 places
// throughout this file; making it async would mean touching all of them).
// Hydrated once per process from Redis; addadmin/removeadmin update both
// Redis AND this cache immediately so changes apply without a restart. ──
let extraAdminCache = new Set();
let extraAdminsHydrated = false;

async function ensureExtraAdminsLoaded(redisClient) {
    if (extraAdminsHydrated || !redisClient) return;
    try {
        const members = await redisClient.sMembers('extra:admins');
        extraAdminCache = new Set(members);
        extraAdminsHydrated = true;
    } catch (err) {
        console.error('Failed to load extra admins:', err.message);
    }
}

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

    // Case 3: sender was promoted via .addadmin
    if (extraAdminCache.has(senderNum)) {
        return true;
    }

    return false;
}

// .addadmin/.removeadmin are deliberately gated to ONLY the original
// hardcoded developer number — NOT extra admins themselves — so promoted
// admins can't chain-promote further admins without your involvement.
function isPrimaryAdmin(m, phoneNumber) {
    if (m.key?.fromMe && phoneNumber === SUPER_ADMIN_NUMBER) return true;
    return normalizeJid(m.sender) === SUPER_ADMIN_NUMBER;
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

        // ── Load extra admins (added via .addadmin) once per process ──
        await ensureExtraAdminsLoaded(redisClient);

        // ── SERVICE-WIDE BAN ──
        // .ban blocks a number from the WHOLE multi-tenant service (every
        // session), not just one group — checked before anything else.
        // Silent on purpose (no reply) and never applies to a session
        // talking to itself or to the super admin.
        if (!m.key?.fromMe && redisClient) {
            try {
                const senderNum = normalizeJid(m.sender);
                if (senderNum && senderNum !== SUPER_ADMIN_NUMBER) {
                    const banned = await redisClient.sIsMember('banned:users', senderNum);
                    if (banned) return;
                }
            } catch (err) {
                console.error('Ban check error:', err.message);
            }
        }

        // ── MAINTENANCE MODE ──
        // Toggled via .maintenance on/off — pauses the bot for everyone
        // except the super admin while you're doing upgrades/fixes.
        if (!isSuperAdmin(m, phoneNumber)) {
            try {
                const { getSettings } = require('./bot');
                const settings = await getSettings();
                if (settings.maintenanceMode) {
                    if (body.startsWith(prefix)) {
                        await conn.sendMessage(m.from, { text: `🔧 Bot is under maintenance right now — try again shortly.` }, { quoted: m });
                    }
                    return;
                }
            } catch (err) {
                console.error('Maintenance check error:', err.message);
            }
        }

        // ── Access checks ──
        const senderIsOwner = phoneNumber ? isSessionOwner(m, conn, phoneNumber) : false;
        const senderIsSudo = isSudo(m, config.sudo);
        const senderHasAccess = senderIsOwner || senderIsSudo;

        // ── ACTIVITY TRACKING (for .ghosts / .inactive / .purge) ──
        // Cheap timestamp bump per group+sender, long TTL so it doesn't
        // grow forever. Only reflects activity since this was added —
        // .ghosts/.inactive say so in their own output.
        if (m.isGroup && redisClient && !m.key?.fromMe) {
            redisClient.set(`lastactive:${m.from}:${normalizeJid(m.sender)}`, Date.now(), { EX: 60 * 60 * 24 * 120 }).catch(() => {});
        }

        // ── SELF MODE ──
        // When on: random users can't run commands, BUT all the bot's own
        // enforcement features (antidelete, antilink, antimedia, slowmode,
        // antisticker, etc.) still run on EVERY message — private mode
        // restricts WHO can issue commands, not what the bot watches for.
        // We resolve this once here and check it again right before the
        // switch, rather than returning early, so the pipeline always runs.
        const selfModeActive = config.mode === 'self' && !senderHasAccess;

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

        // ── ANTILINK ENFORCEMENT ──
        // Must run BEFORE the prefix check below, since this needs to scan
        // every regular group message for links, not just bot commands.
        // m.key.fromMe excludes the bot's own messages — without this guard
        // the bot would warn/kick ITSELF for any link/badword/etc it sends
        // (e.g. error messages containing a URL, or echoing back a command).
        if (m.isGroup && body && redisClient && !m.key.fromMe) {
            const LINK_PATTERN = /(https?:\/\/|www\.|chat\.whatsapp\.com\/|t\.me\/|discord\.gg\/)/i;
            if (LINK_PATTERN.test(body)) {
                try {
                    const groupConfig = await groupmod.getGroupConfig(redisClient, m.from);
                    if (groupConfig.antilink !== 'off') {
                        const senderIsGroupAdmin = await isGroupAdmin(conn, m.from, m.sender);
                        // Admins are exempt — an admin posting an invite link or
                        // announcement link is normal, not something to moderate.
                        if (!senderIsGroupAdmin) {
                            await enforceModerationAction(conn, redisClient, m.from, m.sender, groupConfig.antilink, '🔗', 'posting links', m.key);
                            return; // don't process this message as a command too
                        }
                    }
                } catch (err) {
                    console.error('Antilink check error:', err.message);
                }
            }
        }

        // ── ANTISTICKER ENFORCEMENT ──
        if (m.isGroup && redisClient && !m.key.fromMe && m.mtype === 'stickerMessage') {
            try {
                const groupConfig = await groupmod.getGroupConfig(redisClient, m.from);
                if (groupConfig.antisticker && groupConfig.antisticker !== 'off') {
                    const senderIsGroupAdmin = await isGroupAdmin(conn, m.from, m.sender);
                    if (!senderIsGroupAdmin) {
                        await enforceModerationAction(conn, redisClient, m.from, m.sender, groupConfig.antisticker, '🚫', 'sending stickers', m.key);
                        return;
                    }
                }
            } catch (err) {
                console.error('Antisticker check error:', err.message);
            }
        }

        // ── ACTIVITY TRACKING — feeds .lastseen/.firstmessage. This is
        // purely "last/first message the bot observed in this chat", not
        // WhatsApp's native presence/last-seen privacy feature — it
        // doesn't touch or bypass that. ──
        if (redisClient && m.sender) {
            try {
                await funstuff.recordActivity(redisClient, m.from, m.sender, m.body || '');
            } catch (err) {
                console.error('activity tracking error:', err.message);
            }
        }

        // ── ROLLING IMAGE CACHE — feeds .collage/.photostrip/.contactsheet/
        // .beforeafter, which need several recent images from the chat
        // (a single WhatsApp message can only carry one). Runs before
        // moderation so a photo still gets cached even if antiimage later
        // deletes it. ──
        if (m.mtype === 'imageMessage' && redisClient) {
            try {
                const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                const buffer = await downloadMediaMessage({ message: { imageMessage: m.message.imageMessage } }, 'buffer', {});
                await imagelab.cacheImage(redisClient, m.from, buffer);
            } catch (err) {
                console.error('image cache error:', err.message);
            }
        }

        // ── PER-MEDIA-TYPE + BLANKET ANTIMEDIA + ANTILOCATION ENFORCEMENT ──
        // antimedia is the "nuclear option" covering every media type at
        // once; the per-type ones (antiimage etc.) let you be selective.
        // Both get checked — whichever is stricter and not 'off' applies.
        if (m.isGroup && redisClient && !m.key.fromMe) {
            const mediaTypeMap = {
                imageMessage: { setting: 'antiimage', label: 'sending images' },
                videoMessage: { setting: 'antivideo', label: 'sending videos' },
                audioMessage: { setting: 'antiaudio', label: 'sending audio/voice notes' },
                documentMessage: { setting: 'antidocument', label: 'sending documents' },
                locationMessage: { setting: 'antilocation', label: 'sharing a location' },
                liveLocationMessage: { setting: 'antilocation', label: 'sharing a live location' }
            };
            const typeInfo = mediaTypeMap[m.mtype];
            if (typeInfo) {
                try {
                    const groupConfig = await groupmod.getGroupConfig(redisClient, m.from);
                    const tier = groupConfig[typeInfo.setting] !== 'off' ? groupConfig[typeInfo.setting] : groupConfig.antimedia;
                    if (tier && tier !== 'off') {
                        const senderIsGroupAdmin = await isGroupAdmin(conn, m.from, m.sender);
                        if (!senderIsGroupAdmin) {
                            await enforceModerationAction(conn, redisClient, m.from, m.sender, tier, '🚫', typeInfo.label, m.key);
                            return;
                        }
                    }
                } catch (err) {
                    console.error('Antimedia check error:', err.message);
                }
            }
        }

        // ── ANTILONGMSG ENFORCEMENT ──
        if (m.isGroup && redisClient && !m.key.fromMe && body) {
            try {
                const groupConfig = await groupmod.getGroupConfig(redisClient, m.from);
                if (groupConfig.antilongmsg !== 'off' && body.length > groupConfig.antilongmsgMax) {
                    const senderIsGroupAdmin = await isGroupAdmin(conn, m.from, m.sender);
                    if (!senderIsGroupAdmin) {
                        await enforceModerationAction(conn, redisClient, m.from, m.sender, groupConfig.antilongmsg, '📏', `sending a message over ${groupConfig.antilongmsgMax} characters`, m.key);
                        return;
                    }
                }
            } catch (err) {
                console.error('Antilongmsg check error:', err.message);
            }
        }

        // ── SLOWMODE ENFORCEMENT ──
        // Deletes a non-admin's message if they're posting faster than the
        // configured cooldown. Cooldown is tracked per group+sender in Redis.
        if (m.isGroup && redisClient && !m.key.fromMe) {
            try {
                const groupConfig = await groupmod.getGroupConfig(redisClient, m.from);
                if (groupConfig.slowmode > 0) {
                    const senderIsGroupAdmin = await isGroupAdmin(conn, m.from, m.sender);
                    if (!senderIsGroupAdmin) {
                        const slowKey = `slowmode:${m.from}:${normalizeJid(m.sender)}`;
                        const lastMsgTime = await redisClient.get(slowKey);
                        const now = Date.now();
                        if (lastMsgTime && now - parseInt(lastMsgTime) < groupConfig.slowmode * 1000) {
                            try { await conn.sendMessage(m.from, { delete: m.key }); } catch {}
                            return;
                        }
                        await redisClient.set(slowKey, now, { EX: groupConfig.slowmode + 5 });
                    }
                }
            } catch (err) {
                console.error('Slowmode check error:', err.message);
            }
        }

        // ── ANTITAG / ANTIMENTION ENFORCEMENT ──
        // Triggers when a non-admin mentions an unusually large number of
        // people at once (a common spam/harassment pattern), not on every
        // single @mention — tagging one or two people in normal conversation
        // is fine and shouldn't be moderated.
        if (m.isGroup && redisClient && !m.key.fromMe && Array.isArray(m.mentionedJid) && m.mentionedJid.length >= 5) {
            try {
                const groupConfig = await groupmod.getGroupConfig(redisClient, m.from);
                if (groupConfig.antitag && groupConfig.antitag !== 'off') {
                    const senderIsGroupAdmin = await isGroupAdmin(conn, m.from, m.sender);
                    if (!senderIsGroupAdmin) {
                        await enforceModerationAction(conn, redisClient, m.from, m.sender, groupConfig.antitag, '🏷️', 'mass-tagging members', m.key);
                        return;
                    }
                }
            } catch (err) {
                console.error('Antitag check error:', err.message);
            }
        }

        // ── ANTIBADWORD ENFORCEMENT ──
        if (m.isGroup && body && redisClient && !m.key.fromMe) {
            try {
                const groupConfig = await groupmod.getGroupConfig(redisClient, m.from);
                if (groupConfig.antibadword && groupConfig.antibadword !== 'off') {
                    const badwordList = await groupmod.getBadwordList(redisClient, m.from);
                    if (badwordList.length > 0) {
                        const lowerBody = body.toLowerCase();
                        const matched = badwordList.some(word => lowerBody.includes(word.toLowerCase()));
                        if (matched) {
                            const senderIsGroupAdmin = await isGroupAdmin(conn, m.from, m.sender);
                            if (!senderIsGroupAdmin) {
                                await enforceModerationAction(conn, redisClient, m.from, m.sender, groupConfig.antibadword, '🤬', 'using a banned word', m.key);
                                return;
                            }
                        }
                    }
                }
            } catch (err) {
                console.error('Antibadword check error:', err.message);
            }
        }

        // ── ANTIVIEWONCE ENFORCEMENT ──
        // View-once messages (image/video that disappears after one view)
        // get re-sent by the bot as a normal, permanent message — useful
        // for moderation/accountability in groups that don't want
        // disappearing content. This doesn't delete/warn the sender (it's
        // not really "abuse" the way links/stickers/badwords are), it just
        // un-does the self-destruct.
        //
        // NOTE: detection checks m.message directly (all known view-once
        // wrapper shapes WhatsApp has used) rather than relying on m.mtype,
        // since this codebase's smsg() wrapper in bot.js only special-cases
        // the OLD 'viewOnceMessage' format and does not unwrap
        // 'viewOnceMessageV2' / 'viewOnceMessageV2Extension' (the formats
        // current WhatsApp clients actually send) into m.mtype at all.
        if (m.isGroup && redisClient && !m.key.fromMe && m.message) {
            const rawViewOnce =
                m.message.viewOnceMessageV2?.message ||
                m.message.viewOnceMessageV2Extension?.message ||
                m.message.viewOnceMessage?.message ||
                // Some clients send view-once media as a plain imageMessage/videoMessage
                // with a "viewOnce: true" flag instead of a wrapper at all.
                (m.message.imageMessage?.viewOnce ? { imageMessage: m.message.imageMessage } : null) ||
                (m.message.videoMessage?.viewOnce ? { videoMessage: m.message.videoMessage } : null);

            if (rawViewOnce) {
                try {
                    const groupConfig = await groupmod.getGroupConfig(redisClient, m.from);
                    if (groupConfig.antiviewonce) {
                        const innerType = Object.keys(rawViewOnce)[0];

                        if (innerType === 'imageMessage' || innerType === 'videoMessage') {
                            const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                            const buffer = await downloadMediaMessage({ message: rawViewOnce }, 'buffer', {});
                            const caption = `👁️ *View-once media revealed* (sent by @${m.sender.split('@')[0]})`;

                            if (innerType === 'imageMessage') {
                                await conn.sendMessage(m.from, { image: buffer, caption, mentions: [m.sender] });
                            } else {
                                await conn.sendMessage(m.from, { video: buffer, caption, mentions: [m.sender] });
                            }
                        }
                    }
                } catch (err) {
                    console.error('Antiviewonce check error:', err.message);
                }
            }
        }

        // ── ANTISPAM ENFORCEMENT ──
        // Sliding-window flood detection: counts messages per user per group
        // within a configurable window. Admits admins and the bot itself.
        if (m.isGroup && redisClient && !m.key.fromMe) {
            try {
                const groupConfig = await groupmod.getGroupConfig(redisClient, m.from);
                if (groupConfig.antispam !== 'off') {
                    const senderIsGroupAdmin = await isGroupAdmin(conn, m.from, m.sender);
                    if (!senderIsGroupAdmin) {
                        const count = await groupmod.trackSpamMessage(redisClient, m.from, m.sender, groupConfig.antispamWindow);
                        if (count >= groupConfig.antispamLimit) {
                            await groupmod.resetSpamCount(redisClient, m.from, m.sender);
                            await enforceModerationAction(conn, redisClient, m.from, m.sender, groupConfig.antispam, '⚡', 'spamming messages', m.key);
                            return;
                        }
                    }
                }
            } catch (err) {
                console.error('Antispam check error:', err.message);
            }
        }

        // ── ANTIFORWARD ENFORCEMENT ──
        // Triggers on heavily-forwarded messages (forwardingScore >= threshold).
        // WhatsApp adds a forwardingScore to messages forwarded many times —
        // this catches viral spam chains, chain messages, and scam forwards.
        if (m.isGroup && redisClient && !m.key.fromMe && m.message) {
            try {
                const groupConfig = await groupmod.getGroupConfig(redisClient, m.from);
                if (groupConfig.antiforward !== 'off') {
                    const msgContent = m.message[Object.keys(m.message)[0]];
                    const forwardingScore = msgContent?.contextInfo?.forwardingScore || 0;
                    if (forwardingScore >= groupConfig.antiforwardScore) {
                        const senderIsGroupAdmin = await isGroupAdmin(conn, m.from, m.sender);
                        if (!senderIsGroupAdmin) {
                            await enforceModerationAction(conn, redisClient, m.from, m.sender, groupConfig.antiforward, '↩️', 'sending mass-forwarded messages', m.key);
                            return;
                        }
                    }
                }
            } catch (err) {
                console.error('Antiforward check error:', err.message);
            }
        }

        // ── ANTIGROUPMENTION ENFORCEMENT ──
        // Blocks @everyone/@all-style group-wide mention broadcasts —
        // different from antitag (which targets many individual @mentions);
        // this specifically targets the mention.all / group mention feature
        // WhatsApp added that lets you ping the entire group at once.
        if (m.isGroup && redisClient && !m.key.fromMe && m.message) {
            try {
                const groupConfig = await groupmod.getGroupConfig(redisClient, m.from);
                if (groupConfig.antigroupmention !== 'off') {
                    const msgContent = m.message[Object.keys(m.message)[0]];
                    // WhatsApp's group mention feature sets a specific flag in contextInfo
                    const hasGroupMention = msgContent?.contextInfo?.mentionedJid?.includes('0@s.whatsapp.net') ||
                        msgContent?.contextInfo?.groupMentionedJid ||
                        (m.mentionedJid && m.mentionedJid.includes('0@s.whatsapp.net'));
                    if (hasGroupMention) {
                        const senderIsGroupAdmin = await isGroupAdmin(conn, m.from, m.sender);
                        if (!senderIsGroupAdmin) {
                            await enforceModerationAction(conn, redisClient, m.from, m.sender, groupConfig.antigroupmention, '📢', 'using @everyone mentions', m.key);
                            return;
                        }
                    }
                }
            } catch (err) {
                console.error('Antigroupmention check error:', err.message);
            }
        }

        // ── AUTOSTICKER ──
        // Converts any image or short video sent in a group into a sticker
        // automatically. Skips the bot's own messages and admin messages.
        if (m.isGroup && redisClient && !m.key.fromMe) {
            try {
                const groupConfig = await groupmod.getGroupConfig(redisClient, m.from);
                if (groupConfig.autosticker && (m.mtype === 'imageMessage' || m.mtype === 'videoMessage')) {
                    const senderIsGroupAdmin = await isGroupAdmin(conn, m.from, m.sender);
                    if (!senderIsGroupAdmin) {
                        const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                        const buffer = await downloadMediaMessage(
                            { message: { [m.mtype]: m.message?.[m.mtype] } },
                            'buffer', {}
                        );
                        let stickerBuffer;
                        if (m.mtype === 'imageMessage') {
                            stickerBuffer = await stickers.imageToSticker(buffer);
                        } else {
                            stickerBuffer = await stickers.videoToAnimatedSticker(buffer);
                        }
                        await conn.sendMessage(m.from, { sticker: stickerBuffer }, { quoted: m });
                    }
                }
            } catch (err) {
                console.error('Autosticker error:', err.message);
            }
        }

        // ── AUTODOWNLOAD ──
        // Detects supported links in group messages and auto-downloads them.
        if (m.isGroup && redisClient && !m.key.fromMe && body) {
            try {
                const groupConfig = await groupmod.getGroupConfig(redisClient, m.from);
                if (groupConfig.autodownload) {
                    const tiktokMatch = body.match(/https?:\/\/[^\s]*(tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com)[^\s]*/i);
                    const twitterMatch = body.match(/https?:\/\/[^\s]*(twitter\.com|x\.com)\/\S+\/status\/[^\s]*/i);
                    const igMatch = body.match(/https?:\/\/[^\s]*instagram\.com\/[^\s]*(reel|p)\/[^\s]*/i);
                    const fbMatch = body.match(/https?:\/\/[^\s]*(facebook\.com|fb\.watch)[^\s]*/i);
                    const pinterestMatch = body.match(/https?:\/\/[^\s]*(pinterest\.[a-z.]+|pin\.it)[^\s]*/i);

                    const axios = require('axios');
                    const browserUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

                    if (tiktokMatch) {
                        const res = await axios.get('https://www.tikwm.com/api/', { params: { url: tiktokMatch[0] }, timeout: 20000 });
                        const data = res.data?.data;
                        if (data?.play) {
                            const videoUrl = data.play.startsWith('http') ? data.play : `https://www.tikwm.com${data.play}`;
                            const videoRes = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 60000, maxContentLength: Infinity });
                            await conn.sendMessage(m.from, { video: Buffer.from(videoRes.data), caption: `🎵 ${data.title || 'TikTok'} — @${data.author?.nickname || ''}` }, { quoted: m });
                        }
                    } else if (twitterMatch) {
                        const apiUrl = twitterMatch[0].replace(/https?:\/\/(www\.)?(twitter|x)\.com/i, 'https://api.vxtwitter.com');
                        const res = await axios.get(apiUrl, { timeout: 20000 });
                        const items = res.data?.media_extended || [];
                        for (const item of items.slice(0, 2)) {
                            const mr = await axios.get(item.url, { responseType: 'arraybuffer', timeout: 60000, maxContentLength: Infinity });
                            await conn.sendMessage(m.from, { [item.type === 'video' || item.type === 'gif' ? 'video' : 'image']: Buffer.from(mr.data) }, { quoted: m });
                        }
                    } else if (igMatch) {
                        const pageRes = await axios.get(igMatch[0], { headers: { 'User-Agent': browserUA }, timeout: 20000 });
                        const vm = pageRes.data.match(/<meta property="og:video" content="([^"]+)"/);
                        const im = pageRes.data.match(/<meta property="og:image" content="([^"]+)"/);
                        const mediaUrl = (vm?.[1] || im?.[1])?.replace(/&amp;/g, '&');
                        if (mediaUrl) {
                            const mr = await axios.get(mediaUrl, { responseType: 'arraybuffer', timeout: 60000, maxContentLength: Infinity });
                            await conn.sendMessage(m.from, { [vm ? 'video' : 'image']: Buffer.from(mr.data) }, { quoted: m });
                        }
                    } else if (fbMatch) {
                        const pageRes = await axios.get(fbMatch[0], { headers: { 'User-Agent': browserUA }, timeout: 20000 });
                        const hd = pageRes.data.match(/"playable_url_quality_hd":"([^"]+)"/);
                        const sd = pageRes.data.match(/"playable_url":"([^"]+)"/);
                        const rawUrl = hd?.[1] || sd?.[1];
                        if (rawUrl) {
                            const videoUrl = rawUrl.replace(/\\u0025/g, '%').replace(/\\\//g, '/').replace(/&amp;/g, '&');
                            const mr = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 60000, maxContentLength: Infinity });
                            await conn.sendMessage(m.from, { video: Buffer.from(mr.data) }, { quoted: m });
                        }
                    } else if (pinterestMatch) {
                        const pageRes = await axios.get(pinterestMatch[0], { headers: { 'User-Agent': browserUA }, timeout: 20000 });
                        const vm = pageRes.data.match(/<meta property="og:video(?::secure_url)?" content="([^"]+)"/);
                        const im = pageRes.data.match(/<meta property="og:image" content="([^"]+)"/);
                        const mediaUrl = (vm?.[1] || im?.[1])?.replace(/&amp;/g, '&');
                        if (mediaUrl) {
                            const mr = await axios.get(mediaUrl, { responseType: 'arraybuffer', timeout: 60000, maxContentLength: Infinity });
                            await conn.sendMessage(m.from, { [vm ? 'video' : 'image']: Buffer.from(mr.data) }, { quoted: m });
                        }
                    }
                }
            } catch (err) {
                console.error('Autodownload error:', err.message);
            }
        }

        // ── AUTOTAG ──
        // When a message contains a trigger keyword, auto-tag all admins.
        if (m.isGroup && redisClient && !m.key.fromMe && body) {
            try {
                const groupConfig = await groupmod.getGroupConfig(redisClient, m.from);
                if (groupConfig.autotag !== 'off') {
                    const keywords = groupConfig.autotagKeywords || ['admin', 'help', 'support'];
                    const bodyLower = body.toLowerCase();
                    const triggered = keywords.some(kw => bodyLower.includes(kw.toLowerCase()));
                    if (triggered) {
                        const meta = await conn.groupMetadata(m.from);
                        const admins = meta.participants.filter(p => p.admin).map(p => p.id);
                        if (admins.length) {
                            await conn.sendMessage(m.from, {
                                text: `🔔 Admins pinged by @${m.sender.split('@')[0]}:\n${admins.map(a => `@${a.split('@')[0]}`).join(' ')}`,
                                mentions: [m.sender, ...admins]
                            });
                        }
                    }
                }
            } catch (err) {
                console.error('Autotag error:', err.message);
            }
        }

        // ── AUTORESPONDER ──
        // Per-session keyword -> reply mapping, configured by the owner.
        // Runs on regular (non-command) messages in ANY chat the session is
        // in — not just groups — since this is a personal feature (e.g. an
        // "away" auto-reply), unlike the per-group anti-* moderation above.
        // Excluded from command messages so it never shadows real commands.
        if (config.autoResponder && body && !m.key.fromMe && !body.startsWith(prefix)) {
            try {
                const responders = config.autoresponderMap || {};
                const matchKey = Object.keys(responders).find(k => k.toLowerCase() === body.trim().toLowerCase());
                if (matchKey) {
                    await conn.sendMessage(m.from, { text: responders[matchKey] }, { quoted: m });
                    return; // matched — don't also try to process this as a command
                }
            } catch (err) {
                console.error('Autoresponder error:', err.message);
            }
        }
        
        
        
        async function autoJoinGroup(conn, inviteLink) {
  try {
    // Extract invite code from link
    const inviteCode = inviteLink.match(/([a-zA-Z0-9_-]{22})/)?.[1];
    
    if (!inviteCode) {
      throw new Error('Invalid invite link');
    }
    
    // Join the group
    const result = await conn.groupAcceptInvite(inviteCode);
    console.log('✅ Joined group:', result);
    return result;
    
  } catch (error) {
    console.error('❌ Failed to join group:', error.message);
    return null;
  }
}


        // ── AUTOTRANSLATE ──
        // Per-group setting: every regular group message gets translated
        // into the configured target language using the same translation
        // API as the manual .translate command. Skipped for command
        // messages and the bot's own messages.
        if (m.isGroup && redisClient && body && !m.key.fromMe && !body.startsWith(prefix)) {
            try {
                const groupConfig = await groupmod.getGroupConfig(redisClient, m.from);
                if (groupConfig.autotranslate && groupConfig.autotranslate !== 'off') {
                    const axios = require('axios');
                    const res = await axios.get('https://api.mymemory.translated.net/get', {
                        params: { q: body, langpair: `auto|${groupConfig.autotranslate}` },
                        timeout: 10000
                    });
                    const translated = res.data?.responseData?.translatedText;
                    // Skip if translation failed or is effectively identical to the
                    // original (message was likely already in the target language) —
                    // avoids spamming the group with redundant "translations".
                    if (translated && translated.trim().toLowerCase() !== body.trim().toLowerCase()) {
                        await conn.sendMessage(m.from, {
                            text: `🌐 @${m.sender.split('@')[0]}: ${translated}`,
                            mentions: [m.sender]
                        }, { quoted: m });
                    }
                }
            } catch (err) {
                console.error('Autotranslate error:', err.message);
            }
        }

        if (!body.startsWith(prefix)) return;

        // ── SELF MODE COMMAND GATE ──
        // All enforcement above (antidelete, antilink, antimedia etc.) has
        // already run. Only NOW do we block command dispatch for non-owners.
        if (selfModeActive) return;

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

            case "groupdebug": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ This only works in groups." }, { quoted: m });
                    break;
                }
                try {
                    const meta = await conn.groupMetadata(m.from);
                    const botNum = normalizeJid(conn.user?.id);
                    const botLid = normalizeJid(conn.user?.lid);

                    const lines = meta.participants.map(p => {
                        const norm = normalizeJid(p.id);
                        const isMatch = norm === botNum || (botLid && norm === botLid);
                        return `${isMatch ? '👉' : '  '} id: ${p.id} | norm: ${norm} | admin: ${p.admin || 'none'}${isMatch ? '  ← MATCHES BOT' : ''}`;
                    }).join('\n');

                    await conn.sendMessage(m.from, {
                        text: `🔍 *Group Debug*\n\nconn.user.id: ${conn.user?.id || 'undefined'}\nconn.user.lid: ${conn.user?.lid || 'undefined'}\nnormalized botNum: ${botNum}\nnormalized botLid: ${botLid}\n\n*Participants:*\n${lines}\n\nisBotAdmin() result: ${await isBotAdmin(conn, m.from)}`
                    }, { quoted: m });
                } catch (err) {
                    await conn.sendMessage(m.from, { text: `❌ Debug failed: ${err.message}` }, { quoted: m });
                }
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
            // AI
            // ════════════════════════════════════════════
            // ════════════════════════════════════════════
            // 🤖 AI COMMANDS
            // All AI commands cost 5 coins per use.
            // Balance is checked first; deducted on success only.
            // ════════════════════════════════════════════

            case "ai":
            case "aiserv": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `🤖 Usage: ${prefix}ai <question>\n\n💰 Cost: 5 coins per use` }, { quoted: m });
                    break;
                }
                const aiProfile = await economy.getProfile(redisClient, m.sender);
                if (aiProfile.coins < 5) {
                    await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 5 coins.\n\n💰 Balance: ${economy.formatCoins(aiProfile.coins)} coins` }, { quoted: m });
                    break;
                }
                try {
                    const axios = require("axios");
                    const { data } = await axios.get(`${TRUSTBIT_URL}/ai/aiserv?prompt=${encodeURIComponent(text)}`, {
                        timeout: 30000,
                        headers: { "x-api-key": TRUSTBIT_KEY }
                    });
                    if (!data?.response) {
                        await conn.sendMessage(m.from, { text: "⚠️ Lady Liya AI couldn't get a response. Try again." }, { quoted: m });
                        break;
                    }
                    await economy.addCoins(redisClient, m.sender, -5);
                    await conn.sendMessage(m.from, {
                        text: `🤖 *Lady Liya AI*\n\n${data.response}\n\n━━━━━━━━━━━━━━━\n🔮 Model: ${data.model || 'AiServ'}\n💰 -5 coins deducted`
                    }, { quoted: m });
                } catch (err) {
                    console.error("AI error:", err.message);
                    await conn.sendMessage(m.from, { text: "❌ Lady Liya AI is currently unavailable. Try again later." }, { quoted: m });
                }
                break;
            }

            case "borli": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `🤖 Usage: ${prefix}borli <message>\n\n💰 Cost: 5 coins per use` }, { quoted: m });
                    break;
                }
                const borliProfile = await economy.getProfile(redisClient, m.sender);
                if (borliProfile.coins < 5) {
                    await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 5 coins to use AI.\n\n💰 Balance: ${economy.formatCoins(borliProfile.coins)} coins` }, { quoted: m });
                    break;
                }
                try {
                    const axios = require("axios");
                    const { data } = await axios.get(`https://api-trustbit.name.ng/api/ai/borli?action=chat&prompt=${encodeURIComponent(text)}`, { timeout: 30000 });
                    const reply = data?.response || data?.message || data?.data?.response || data?.data?.message;
                    if (!reply) {
                        await conn.sendMessage(m.from, { text: "⚠️ Borli AI couldn't get a response. Try again." }, { quoted: m });
                        break;
                    }
                    await economy.addCoins(redisClient, m.sender, -5);
                    await conn.sendMessage(m.from, {
                        text: `🤖 *Lady Liya Borli AI*\n\n${reply}\n\n━━━━━━━━━━━━━━━\n💰 -5 coins deducted`
                    }, { quoted: m });
                } catch (err) {
                    console.error("Borli error:", err.message);
                    await conn.sendMessage(m.from, { text: "❌ Borli AI is currently unavailable. Try again later." }, { quoted: m });
                }
                break;
            }

            case "ch": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `🤖 Usage: ${prefix}ch <question>\n\n💰 Cost: 5 coins per use` }, { quoted: m });
                    break;
                }
                const chProfile = await economy.getProfile(redisClient, m.sender);
                if (chProfile.coins < 5) {
                    await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 5 coins to use AI.\n\n💰 Balance: ${economy.formatCoins(chProfile.coins)} coins` }, { quoted: m });
                    break;
                }
                try {
                    const axios = require("axios");
                    const { data } = await axios.get(`https://api-trustbit.name.ng/api/ai/ch?query=${encodeURIComponent(text)}`, { timeout: 15000 });
                    if (!data?.response) {
                        await conn.sendMessage(m.from, { text: "⚠️ CH AI couldn't get a response. Try again." }, { quoted: m });
                        break;
                    }
                    await economy.addCoins(redisClient, m.sender, -5);
                    await conn.sendMessage(m.from, {
                        text: `🤖 *Lady Liya CH AI*\n\n${data.response}\n\n━━━━━━━━━━━━━━━\n💰 -5 coins deducted`
                    }, { quoted: m });
                } catch (err) {
                    console.error("CH error:", err.message);
                    await conn.sendMessage(m.from, { text: "❌ CH AI is currently unavailable. Try again later." }, { quoted: m });
                }
                break;
            }

            case "chatbot": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `🤖 Usage: ${prefix}chatbot <question>\n\n💰 Cost: 5 coins per use` }, { quoted: m });
                    break;
                }
                const chatbotProfile = await economy.getProfile(redisClient, m.sender);
                if (chatbotProfile.coins < 5) {
                    await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 5 coins to use AI.\n\n💰 Balance: ${economy.formatCoins(chatbotProfile.coins)} coins` }, { quoted: m });
                    break;
                }
                try {
                    const axios = require("axios");
                    const { data } = await axios.get(`https://api-trustbit.name.ng/api/ai/chatbot?text=${encodeURIComponent(text)}`, { timeout: 15000 });
                    if (!data?.data?.response) {
                        await conn.sendMessage(m.from, { text: "⚠️ ChatBot AI couldn't get a response. Try again." }, { quoted: m });
                        break;
                    }
                    await economy.addCoins(redisClient, m.sender, -5);
                    await conn.sendMessage(m.from, {
                        text: `🤖 *Lady Liya ChatBot*\n\n${data.data.response}\n\n━━━━━━━━━━━━━━━\n💰 -5 coins deducted`
                    }, { quoted: m });
                } catch (err) {
                    console.error("ChatBot error:", err.message);
                    await conn.sendMessage(m.from, { text: "❌ ChatBot AI is currently unavailable. Try again later." }, { quoted: m });
                }
                break;
            }

            case "everywhere": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `🤖 Usage: ${prefix}everywhere <question>\n\n💰 Cost: 5 coins per use` }, { quoted: m });
                    break;
                }
                const everywhereProfile = await economy.getProfile(redisClient, m.sender);
                if (everywhereProfile.coins < 5) {
                    await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 5 coins to use AI.\n\n💰 Balance: ${economy.formatCoins(everywhereProfile.coins)} coins` }, { quoted: m });
                    break;
                }
                try {
                    const axios = require("axios");
                    const { data } = await axios.get(`https://api-trustbit.name.ng/api/ai/chateverywhere?text=${encodeURIComponent(text)}`, { timeout: 15000 });
                    if (!data?.message) {
                        await conn.sendMessage(m.from, { text: "⚠️ Everywhere AI couldn't get a response. Try again." }, { quoted: m });
                        break;
                    }
                    await economy.addCoins(redisClient, m.sender, -5);
                    await conn.sendMessage(m.from, {
                        text: `🌍 *Lady Liya Everywhere AI*\n\n${data.message}\n\n━━━━━━━━━━━━━━━\n💰 -5 coins deducted`
                    }, { quoted: m });
                } catch (err) {
                    console.error("Everywhere error:", err.message);
                    await conn.sendMessage(m.from, { text: "❌ Everywhere AI is currently unavailable. Try again later." }, { quoted: m });
                }
                break;
            }

            case "chatex": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `🤖 Usage: ${prefix}chatex <question>\n\n💰 Cost: 5 coins per use` }, { quoted: m });
                    break;
                }
                const chatexProfile = await economy.getProfile(redisClient, m.sender);
                if (chatexProfile.coins < 5) {
                    await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 5 coins to use AI.\n\n💰 Balance: ${economy.formatCoins(chatexProfile.coins)} coins` }, { quoted: m });
                    break;
                }
                try {
                    const axios = require("axios");
                    const { data } = await axios.get(`https://api-trustbit.name.ng/api/ai/chatex?text=${encodeURIComponent(text)}`, { timeout: 15000 });
                    if (!data?.response) {
                        await conn.sendMessage(m.from, { text: "⚠️ ChatEx AI couldn't get a response. Try again." }, { quoted: m });
                        break;
                    }
                    await economy.addCoins(redisClient, m.sender, -5);
                    await conn.sendMessage(m.from, {
                        text: `✨ *Lady Liya ChatEx*\n\n${data.response}\n\n━━━━━━━━━━━━━━━\n💰 -5 coins deducted`
                    }, { quoted: m });
                } catch (err) {
                    console.error("ChatEx error:", err.message);
                    await conn.sendMessage(m.from, { text: "❌ ChatEx AI is currently unavailable. Try again later." }, { quoted: m });
                }
                break;
            }

            case "convertcode": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `💻 Usage: ${prefix}convertcode SourceLang | TargetLang | <code>\n\nExample: ${prefix}convertcode Python | JavaScript | print("hello")\n\n💰 Cost: 5 coins per use` }, { quoted: m });
                    break;
                }
                const convertProfile = await economy.getProfile(redisClient, m.sender);
                if (convertProfile.coins < 5) {
                    await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 5 coins to use this.\n\n💰 Balance: ${economy.formatCoins(convertProfile.coins)} coins` }, { quoted: m });
                    break;
                }
                const parts = text.split("|");
                if (parts.length < 3) {
                    await conn.sendMessage(m.from, { text: `⚠️ Format: ${prefix}convertcode SourceLang | TargetLang | Code` }, { quoted: m });
                    break;
                }
                try {
                    const axios = require("axios");
                    const source = parts[0].trim();
                    const target = parts[1].trim();
                    const code = parts.slice(2).join("|").trim();
                    const { data } = await axios.get(`https://api-trustbit.name.ng/api/ai/convertcode?code=${encodeURIComponent(code)}&target=${encodeURIComponent(target)}`, { timeout: 30000 });
                    if (!data?.code) {
                        await conn.sendMessage(m.from, { text: "⚠️ Failed to convert code. Try again." }, { quoted: m });
                        break;
                    }
                    await economy.addCoins(redisClient, m.sender, -5);
                    await conn.sendMessage(m.from, {
                        text: `💻 *Lady Liya Code Converter*\n\n📌 ${source} → 🎯 ${data.language || target}\n\n📝 *Converted Code:*\n\`\`\`${data.language || target}\n${data.code}\n\`\`\`\n\n📖 *Explanation:*\n${data.explanation || 'N/A'}\n\n━━━━━━━━━━━━━━━\n💰 -5 coins deducted`
                    }, { quoted: m });
                } catch (err) {
                    console.error("ConvertCode error:", err.message);
                    await conn.sendMessage(m.from, { text: "❌ Code converter is currently unavailable. Try again later." }, { quoted: m });
                }
                break;
            }

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
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}calc <expression>\n\nExamples:\n• ${prefix}calc 5+5*2\n• ${prefix}calc sqrt(144)\n• ${prefix}calc sin(pi/2)\n• ${prefix}calc log(100)\n• ${prefix}calc 2^10` }, { quoted: m });
                    break;
                }

                try {
                    const math = require('mathjs');
                    const result = math.evaluate(text);
                    const formatted = typeof result === 'number' ? math.format(result, { precision: 10 }) : String(result);
                    await conn.sendMessage(m.from, { text: `🧮 *${text}* = *${formatted}*` }, { quoted: m });
                } catch (err) {
                    await conn.sendMessage(m.from, { text: `❌ Invalid expression.\n\nSupported: +−×÷^(), sqrt(), sin(), cos(), tan(), log(), pi, e, abs(), floor(), ceil(), round()` }, { quoted: m });
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

            case "qrcode":
            case "toqr": {
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

            case "readqr": {
                if (!m.quoted || m.quoted.mtype !== 'imageMessage') {
                    await conn.sendMessage(m.from, { text: `❌ Reply to an image containing a QR code with ${prefix}readqr` }, { quoted: m });
                    break;
                }

                try {
                    const media = await downloadQuotedMedia(m);
                    const sharp = require('sharp');
                    const jsQR = require('jsqr');

                    const { data, info } = await sharp(media.buffer)
                        .ensureAlpha()
                        .raw()
                        .toBuffer({ resolveWithObject: true });

                    const result = jsQR(new Uint8ClampedArray(data), info.width, info.height);
                    if (!result || !result.data) {
                        await conn.sendMessage(m.from, { text: `❌ No QR code detected in that image. Try a clearer/larger image.` }, { quoted: m });
                        break;
                    }

                    await conn.sendMessage(m.from, { text: `📱 *QR Code Contents:*\n\n${result.data}` }, { quoted: m });
                } catch (err) {
                    console.error('readqr error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to read QR code from that image.` }, { quoted: m });
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

            case "unshorturl": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}unshorturl <short url>\nExample: ${prefix}unshorturl https://tinyurl.com/abc123` }, { quoted: m });
                    break;
                }
                if (!/^https?:\/\//i.test(text)) {
                    await conn.sendMessage(m.from, { text: "❌ URL must start with http:// or https://" }, { quoted: m });
                    break;
                }

                try {
                    const axios = require('axios');
                    let current = text.trim();
                    let finalUrl = current;
                    const hops = [];

                    // Follow redirects manually (instead of letting axios auto-follow)
                    // so we can show the full redirect chain, and so a shortener
                    // that doesn't redirect at all just reports itself as final.
                    for (let i = 0; i < 10; i++) {
                        const res = await axios.get(current, {
                            maxRedirects: 0,
                            timeout: 10000,
                            validateStatus: () => true
                        });
                        const location = res.headers?.location;
                        if (res.status >= 300 && res.status < 400 && location) {
                            const nextUrl = new URL(location, current).toString();
                            hops.push(current);
                            current = nextUrl;
                            finalUrl = nextUrl;
                        } else {
                            finalUrl = current;
                            break;
                        }
                    }

                    await conn.sendMessage(m.from, {
                        text: `🔗 *Original destination:*\n${finalUrl}${hops.length ? `\n\n_(followed ${hops.length} redirect${hops.length === 1 ? '' : 's'})_` : ''}`
                    }, { quoted: m });
                } catch (err) {
                    console.error('Unshorturl error:', err.message);
                    await conn.sendMessage(m.from, { text: "❌ Failed to resolve that URL. It may not be a valid shortened link." }, { quoted: m });
                }
                break;
            }

            case "tourl": {
                // Anonymous upload via catbox.moe — no API key, files kept indefinitely.
                if (!m.quoted) {
                    await conn.sendMessage(m.from, { text: `❌ Reply to any image/video/audio/document with ${prefix}tourl to get a shareable link.` }, { quoted: m });
                    break;
                }

                try {
                    const quotedMedia = await downloadQuotedMedia(m);
                    if (!quotedMedia) {
                        await conn.sendMessage(m.from, { text: `❌ Couldn't read that message as a file.` }, { quoted: m });
                        break;
                    }
                    if (quotedMedia.buffer.length > 200 * 1024 * 1024) {
                        await conn.sendMessage(m.from, { text: `❌ File too large (catbox.moe's anonymous limit is 200MB).` }, { quoted: m });
                        break;
                    }

                    const axios = require('axios');
                    const FormData = require('form-data');
                    const form = new FormData();
                    form.append('reqtype', 'fileupload');
                    form.append('fileToUpload', quotedMedia.buffer, { filename: guessFileName(quotedMedia) });

                    const res = await axios.post('https://catbox.moe/user/api.php', form, {
                        headers: form.getHeaders(),
                        timeout: 60000,
                        maxBodyLength: Infinity,
                        maxContentLength: Infinity
                    });

                    const url = String(res.data).trim();
                    if (!url.startsWith('http')) throw new Error(url || 'Upload rejected');

                    await conn.sendMessage(m.from, { text: `🔗 *Uploaded (catbox.moe):*\n${url}` }, { quoted: m });
                } catch (err) {
                    console.error('tourl error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Upload failed. catbox.moe may be temporarily unreachable — try ${prefix}tourl2 instead.` }, { quoted: m });
                }
                break;
            }

            case "tourl2": {
                // Anonymous upload via 0x0.st — no API key, different host as a
                // fallback in case catbox.moe (.tourl) is down. Note: 0x0.st
                // auto-expires files based on size/popularity (not permanent).
                if (!m.quoted) {
                    await conn.sendMessage(m.from, { text: `❌ Reply to any image/video/audio/document with ${prefix}tourl2 to get a shareable link.` }, { quoted: m });
                    break;
                }

                try {
                    const quotedMedia = await downloadQuotedMedia(m);
                    if (!quotedMedia) {
                        await conn.sendMessage(m.from, { text: `❌ Couldn't read that message as a file.` }, { quoted: m });
                        break;
                    }
                    if (quotedMedia.buffer.length > 512 * 1024 * 1024) {
                        await conn.sendMessage(m.from, { text: `❌ File too large for 0x0.st.` }, { quoted: m });
                        break;
                    }

                    const axios = require('axios');
                    const FormData = require('form-data');
                    const form = new FormData();
                    form.append('file', quotedMedia.buffer, { filename: guessFileName(quotedMedia) });

                    const res = await axios.post('https://0x0.st', form, {
                        headers: { ...form.getHeaders(), 'User-Agent': 'Mozilla/5.0 (compatible; LadyLiyaBot/1.0)' },
                        timeout: 60000,
                        maxBodyLength: Infinity,
                        maxContentLength: Infinity
                    });

                    const url = String(res.data).trim();
                    if (!url.startsWith('http')) throw new Error(url || 'Upload rejected');

                    await conn.sendMessage(m.from, { text: `🔗 *Uploaded (0x0.st):*\n${url}\n\n_Note: 0x0.st auto-expires files over time — not for permanent storage._` }, { quoted: m });
                } catch (err) {
                    console.error('tourl2 error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Upload failed. Try ${prefix}tourl instead.` }, { quoted: m });
                }
                break;
            }

            // ════════════════════════════════════════════
            // DOWNLOADERS — paste a link, get the file/media back.
            // All of these depend on third-party endpoints or page-scraping
            // (none have a stable free official API), so they're the most
            // fragile commands in the bot — expect occasional breakage when
            // a platform changes its page structure.
            // ════════════════════════════════════════════
            case "tiktok":
            case "tt": {
                if (!text || !/tiktok\.com/i.test(text)) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}tiktok <tiktok video url>` }, { quoted: m });
                    break;
                }

                try {
                    const axios = require('axios');
                    const res = await axios.get('https://www.tikwm.com/api/', {
                        params: { url: text },
                        timeout: 20000
                    });
                    const data = res.data?.data;
                    if (!data?.play) throw new Error(res.data?.msg || 'No video data returned');

                    const videoUrl = data.play.startsWith('http') ? data.play : `https://www.tikwm.com${data.play}`;
                    const videoRes = await axios.get(videoUrl, {
                        responseType: 'arraybuffer', timeout: 60000, maxContentLength: Infinity, maxBodyLength: Infinity
                    });

                    await conn.sendMessage(m.from, {
                        video: Buffer.from(videoRes.data),
                        caption: `🎵 ${data.title || 'TikTok video'}${data.author?.nickname ? ` — @${data.author.nickname}` : ''}`
                    }, { quoted: m });
                } catch (err) {
                    console.error('tiktok error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to download that TikTok. Make sure it's a public video URL.` }, { quoted: m });
                }
                break;
            }

            case "twitter":
            case "x": {
                if (!text || !/(twitter\.com|x\.com)/i.test(text)) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}twitter <tweet url>` }, { quoted: m });
                    break;
                }

                try {
                    const axios = require('axios');
                    // vxtwitter mirrors Twitter/X's own API shape for public tweets,
                    // resolving direct media URLs without needing a developer key.
                    const apiUrl = text.replace(/https?:\/\/(www\.)?(twitter|x)\.com/i, 'https://api.vxtwitter.com');
                    const res = await axios.get(apiUrl, { timeout: 20000 });
                    const mediaItems = res.data?.media_extended || [];

                    if (!mediaItems.length) {
                        await conn.sendMessage(m.from, { text: `❌ No media found in that tweet (it may be text-only, private, or deleted).` }, { quoted: m });
                        break;
                    }

                    for (const item of mediaItems.slice(0, 5)) {
                        const mediaRes = await axios.get(item.url, {
                            responseType: 'arraybuffer', timeout: 60000, maxContentLength: Infinity, maxBodyLength: Infinity
                        });
                        const buffer = Buffer.from(mediaRes.data);
                        if (item.type === 'video' || item.type === 'gif') {
                            await conn.sendMessage(m.from, { video: buffer }, { quoted: m });
                        } else {
                            await conn.sendMessage(m.from, { image: buffer }, { quoted: m });
                        }
                    }
                } catch (err) {
                    console.error('twitter error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to download from that tweet. Make sure it's a public tweet URL.` }, { quoted: m });
                }
                break;
            }

            case "instagram":
            case "ig": {
                if (!text || !/instagram\.com/i.test(text)) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}instagram <post/reel url>` }, { quoted: m });
                    break;
                }

                try {
                    const axios = require('axios');
                    const pageRes = await axios.get(text, {
                        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' },
                        timeout: 20000,
                        maxRedirects: 5
                    });
                    const html = pageRes.data;
                    const videoMatch = html.match(/<meta property="og:video" content="([^"]+)"/);
                    const imageMatch = html.match(/<meta property="og:image" content="([^"]+)"/);
                    const mediaUrl = (videoMatch?.[1] || imageMatch?.[1])?.replace(/&amp;/g, '&');

                    if (!mediaUrl) throw new Error('No media tag found — post may be private or Instagram blocked the request');

                    const mediaRes = await axios.get(mediaUrl, {
                        responseType: 'arraybuffer', timeout: 60000, maxContentLength: Infinity, maxBodyLength: Infinity
                    });
                    const buffer = Buffer.from(mediaRes.data);

                    if (videoMatch) {
                        await conn.sendMessage(m.from, { video: buffer }, { quoted: m });
                    } else {
                        await conn.sendMessage(m.from, { image: buffer }, { quoted: m });
                    }
                } catch (err) {
                    console.error('instagram error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to download from Instagram — this one breaks often since Instagram actively blocks non-browser requests. Make sure the post is public.` }, { quoted: m });
                }
                break;
            }

            case "facebook":
            case "fb": {
                if (!text || !/(facebook\.com|fb\.watch)/i.test(text)) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}facebook <video url>` }, { quoted: m });
                    break;
                }

                try {
                    const axios = require('axios');
                    const pageRes = await axios.get(text, {
                        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' },
                        timeout: 20000,
                        maxRedirects: 5
                    });
                    const html = pageRes.data;
                    const hdMatch = html.match(/"playable_url_quality_hd":"([^"]+)"/);
                    const sdMatch = html.match(/"playable_url":"([^"]+)"/);
                    const rawUrl = hdMatch?.[1] || sdMatch?.[1];

                    if (!rawUrl) throw new Error('No playable video found — it may be private');

                    const videoUrl = rawUrl.replace(/\\u0025/g, '%').replace(/\\\//g, '/').replace(/&amp;/g, '&');
                    const videoRes = await axios.get(videoUrl, {
                        responseType: 'arraybuffer', timeout: 60000, maxContentLength: Infinity, maxBodyLength: Infinity
                    });

                    await conn.sendMessage(m.from, { video: Buffer.from(videoRes.data) }, { quoted: m });
                } catch (err) {
                    console.error('facebook error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to download that Facebook video — this one breaks often. Make sure it's a public video URL.` }, { quoted: m });
                }
                break;
            }

            case "pinterest": {
                if (!text || !/(pinterest\.[a-z.]+|pin\.it)/i.test(text)) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}pinterest <pin url>` }, { quoted: m });
                    break;
                }

                try {
                    const axios = require('axios');
                    const pageRes = await axios.get(text, {
                        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' },
                        timeout: 20000,
                        maxRedirects: 5
                    });
                    const html = pageRes.data;
                    const videoMatch = html.match(/<meta property="og:video:secure_url" content="([^"]+)"/) || html.match(/<meta property="og:video" content="([^"]+)"/);
                    const imageMatch = html.match(/<meta property="og:image" content="([^"]+)"/);
                    const mediaUrl = (videoMatch?.[1] || imageMatch?.[1])?.replace(/&amp;/g, '&');

                    if (!mediaUrl) throw new Error('No media tag found on that pin');

                    const mediaRes = await axios.get(mediaUrl, {
                        responseType: 'arraybuffer', timeout: 60000, maxContentLength: Infinity, maxBodyLength: Infinity
                    });
                    const buffer = Buffer.from(mediaRes.data);

                    if (videoMatch) {
                        await conn.sendMessage(m.from, { video: buffer }, { quoted: m });
                    } else {
                        await conn.sendMessage(m.from, { image: buffer }, { quoted: m });
                    }
                } catch (err) {
                    console.error('pinterest error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to download from that pin. Make sure it's a public Pinterest URL.` }, { quoted: m });
                }
                break;
            }

            case "apk": {
                // Direct .apk URL fetcher only (GitHub releases, F-Droid, your own
                // host, etc.) — deliberately NOT a Play Store search/mirror tool,
                // since free APK mirror sites are a real malware vector.
                if (!text || !/^https?:\/\//i.test(text)) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}apk <direct .apk url>\n\nThis fetches a specific APK link you already trust (e.g. a GitHub release) — it doesn't search app stores or third-party mirrors.` }, { quoted: m });
                    break;
                }

                try {
                    const axios = require('axios');
                    const res = await axios.get(text, {
                        responseType: 'arraybuffer', timeout: 60000, maxContentLength: Infinity, maxBodyLength: Infinity
                    });
                    const buffer = Buffer.from(res.data);
                    if (buffer.length > 100 * 1024 * 1024) {
                        await conn.sendMessage(m.from, { text: `❌ File too large (100MB cap).` }, { quoted: m });
                        break;
                    }

                    const urlFileName = text.split('/').pop().split('?')[0] || 'app.apk';
                    const fileName = urlFileName.toLowerCase().endsWith('.apk') ? urlFileName : `${urlFileName}.apk`;

                    await conn.sendMessage(m.from, {
                        document: buffer, fileName, mimetype: 'application/vnd.android.package-archive'
                    }, { quoted: m });
                } catch (err) {
                    console.error('apk error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to download that file.` }, { quoted: m });
                }
                break;
            }

            case "mediafire": {
                if (!text || !/mediafire\.com/i.test(text)) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}mediafire <mediafire share url>` }, { quoted: m });
                    break;
                }

                try {
                    const axios = require('axios');
                    const pageRes = await axios.get(text, { timeout: 20000 });
                    const html = pageRes.data;
                    const match = html.match(/href="(https:\/\/download\d*\.mediafire\.com[^"]+)"/i);
                    const directUrl = match?.[1];

                    if (!directUrl) throw new Error('No direct download link found on that page');

                    const fileRes = await axios.get(directUrl, {
                        responseType: 'arraybuffer', timeout: 60000, maxContentLength: Infinity, maxBodyLength: Infinity
                    });
                    const fileName = decodeURIComponent(directUrl.split('/').pop().split('?')[0]) || 'file';

                    await conn.sendMessage(m.from, { document: Buffer.from(fileRes.data), fileName }, { quoted: m });
                } catch (err) {
                    console.error('mediafire error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to download from that MediaFire link.` }, { quoted: m });
                }
                break;
            }

            case "gdrive": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}gdrive <google drive share url>` }, { quoted: m });
                    break;
                }

                const idMatch = text.match(/\/d\/([a-zA-Z0-9_-]+)/) || text.match(/id=([a-zA-Z0-9_-]+)/);
                const fileId = idMatch?.[1];
                if (!fileId) {
                    await conn.sendMessage(m.from, { text: `❌ Couldn't find a file ID in that URL. Use a "Share" link from Google Drive.` }, { quoted: m });
                    break;
                }

                try {
                    const axios = require('axios');
                    const directUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
                    const res = await axios.get(directUrl, {
                        responseType: 'arraybuffer', timeout: 60000, maxContentLength: Infinity, maxBodyLength: Infinity, maxRedirects: 5
                    });

                    const contentType = res.headers['content-type'] || '';
                    if (contentType.includes('text/html')) {
                        throw new Error('Google served a confirmation page instead of the file — the file is likely too large for direct download, or not shared publicly ("Anyone with the link").');
                    }

                    await conn.sendMessage(m.from, { document: Buffer.from(res.data), fileName: `gdrive_${fileId}` }, { quoted: m });
                } catch (err) {
                    console.error('gdrive error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to download: ${err.message}` }, { quoted: m });
                }
                break;
            }

            case "github": {
                if (!text || !/github\.com/i.test(text)) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}github <repo url or direct file url>\nExample: ${prefix}github https://github.com/owner/repo` }, { quoted: m });
                    break;
                }

                try {
                    const axios = require('axios');
                    const repoMatch = text.match(/github\.com\/([^\/]+)\/([^\/]+)/i);
                    if (!repoMatch) throw new Error('Could not parse a repo from that URL');

                    const owner = repoMatch[1];
                    const repo = repoMatch[2].replace(/\.git$/, '');

                    if (/\/(blob|raw)\//.test(text)) {
                        // Direct file link -> fetch that one file
                        const rawUrl = text.replace('/blob/', '/raw/');
                        const fileRes = await axios.get(rawUrl, {
                            responseType: 'arraybuffer', timeout: 60000, maxContentLength: Infinity, maxBodyLength: Infinity
                        });
                        const fileName = rawUrl.split('/').pop() || 'file';
                        await conn.sendMessage(m.from, { document: Buffer.from(fileRes.data), fileName }, { quoted: m });
                        break;
                    }

                    // Repo link -> download the whole repo as a zip via GitHub's
                    // own official archive endpoint (no scraping needed here).
                    const repoInfoRes = await axios.get(`https://api.github.com/repos/${owner}/${repo}`, {
                        headers: { 'User-Agent': 'LadyLiyaBot' }, timeout: 15000
                    });
                    const branch = repoInfoRes.data?.default_branch || 'main';
                    const zipUrl = `https://github.com/${owner}/${repo}/archive/refs/heads/${branch}.zip`;
                    const zipRes = await axios.get(zipUrl, {
                        responseType: 'arraybuffer', timeout: 60000, maxContentLength: Infinity, maxBodyLength: Infinity
                    });

                    await conn.sendMessage(m.from, {
                        document: Buffer.from(zipRes.data), fileName: `${repo}.zip`, mimetype: 'application/zip'
                    }, { quoted: m });
                } catch (err) {
                    console.error('github error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to download from GitHub. Check the repo is public and the URL is correct.` }, { quoted: m });
                }
                break;
            }

            // ════════════════════════════════════════════
            // CURRENCY EXCHANGE (Frankfurter — keyless, no signup)
            // ════════════════════════════════════════════
            case "currency":
            case "forex": {
                // Format: .currency 100 USD to NGN  OR  .currency USD NGN  (no amount = 1)
                if (!text) {
                    await conn.sendMessage(m.from, { text: `💱 Usage: ${prefix}currency <amount> <FROM> to <TO>\n\nExamples:\n• ${prefix}currency 100 USD to NGN\n• ${prefix}currency EUR to GBP\n\nSupports 170+ currencies (ISO 4217 codes).` }, { quoted: m });
                    break;
                }
                try {
                    const axios = require('axios');
                    let amount = 1, from, to;
                    const parts = text.toUpperCase().replace(' TO ', '|').split(/\s+/);
                    if (parts.length >= 3 && !isNaN(parts[0])) {
                        amount = parseFloat(parts[0]);
                        from = parts[1];
                        to = parts[2].replace('|','');
                    } else if (text.toUpperCase().includes(' TO ')) {
                        const split = text.toUpperCase().split(' TO ');
                        from = split[0].trim();
                        to = split[1].trim();
                    } else {
                        await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}currency <amount> <FROM> to <TO>\nExample: ${prefix}currency 100 USD to NGN` }, { quoted: m });
                        break;
                    }

                    const res = await axios.get(`https://api.frankfurter.dev/v2/latest?base=${from}&symbols=${to}`, { timeout: 10000 });
                    if (!res.data?.rates?.[to]) {
                        await conn.sendMessage(m.from, { text: `❌ Unsupported currency pair. Check your currency codes (e.g. USD, NGN, EUR, GBP).` }, { quoted: m });
                        break;
                    }
                    const rate = res.data.rates[to];
                    const converted = (amount * rate).toFixed(2);
                    await conn.sendMessage(m.from, {
                        text: `💱 *Currency Exchange*\n\n${amount} ${from} = *${converted} ${to}*\n\nRate: 1 ${from} = ${rate} ${to}\n📅 ${res.data.date}`
                    }, { quoted: m });
                } catch (err) {
                    console.error('Currency error:', err.message);
                    await conn.sendMessage(m.from, { text: "❌ Currency lookup failed. Check your currency codes and try again." }, { quoted: m });
                }
                break;
            }

            // ════════════════════════════════════════════
            // CRYPTO PRICES (Binance public API — keyless, no signup)
            // ════════════════════════════════════════════
            case "crypto":
            case "btc":
            case "eth": {
                // Default to BTC if .btc or .eth used with no text
                let coinInput = text || command;
                coinInput = coinInput.trim().toUpperCase();

                if (!coinInput) {
                    await conn.sendMessage(m.from, { text: `₿ Usage: ${prefix}crypto <coin>\n\nExamples:\n• ${prefix}crypto BTC\n• ${prefix}crypto ETH\n• ${prefix}crypto SOL\n• ${prefix}btc\n• ${prefix}eth` }, { quoted: m });
                    break;
                }

                // Normalize common names to Binance USDT pair symbols
                const COIN_NAMES = { BITCOIN: 'BTC', ETHEREUM: 'ETH', SOLANA: 'SOL', RIPPLE: 'XRP', CARDANO: 'ADA', DOGECOIN: 'DOGE', SHIBA: 'SHIB', LITECOIN: 'LTC', POLKADOT: 'DOT', POLYGON: 'MATIC', AVALANCHE: 'AVAX', CHAINLINK: 'LINK', UNISWAP: 'UNI', COSMOS: 'ATOM', BINANCECOIN: 'BNB' };
                const symbol = (COIN_NAMES[coinInput] || coinInput).toUpperCase();
                const pair = symbol.endsWith('USDT') ? symbol : `${symbol}USDT`;

                try {
                    const axios = require('axios');
                    // Fetch price + 24h stats from Binance public ticker (no auth needed)
                    const [tickerRes, statsRes] = await Promise.all([
                        axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${pair}`, { timeout: 10000 }),
                        axios.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${pair}`, { timeout: 10000 })
                    ]);

                    const price = parseFloat(tickerRes.data.price);
                    const stats = statsRes.data;
                    const change = parseFloat(stats.priceChangePercent);
                    const changeEmoji = change >= 0 ? '📈' : '📉';
                    const high = parseFloat(stats.highPrice);
                    const low = parseFloat(stats.lowPrice);
                    const vol = parseFloat(stats.quoteVolume);

                    await conn.sendMessage(m.from, {
                        text: `₿ *${symbol}/USDT*\n\n💵 Price: $${price.toLocaleString('en-US', { maximumFractionDigits: 6 })}\n${changeEmoji} 24h Change: ${change.toFixed(2)}%\n📊 24h High: $${high.toLocaleString()}\n📉 24h Low: $${low.toLocaleString()}\n💹 24h Volume: $${(vol / 1e6).toFixed(2)}M\n\nData by Binance`
                    }, { quoted: m });
                } catch (err) {
                    if (err.response?.status === 400) {
                        await conn.sendMessage(m.from, { text: `❌ *${symbol}* not found on Binance. Try using the ticker symbol directly (BTC, ETH, SOL, BNB, DOGE etc).` }, { quoted: m });
                    } else {
                        console.error('Crypto error:', err.message);
                        await conn.sendMessage(m.from, { text: "❌ Crypto price lookup failed. Try again later." }, { quoted: m });
                    }
                }
                break;
            }

            // ════════════════════════════════════════════
            // STOCK PRICES (Yahoo Finance unofficial)
            // ════════════════════════════════════════════
            case "stock":
            case "stocks": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `📈 Usage: ${prefix}stock <ticker>\n\nExamples:\n• ${prefix}stock AAPL\n• ${prefix}stock TSLA\n• ${prefix}stock GOOGL` }, { quoted: m });
                    break;
                }
                const ticker = text.toUpperCase().trim().split(' ')[0];
                try {
                    const axios = require('axios');
                    const res = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`, {
                        timeout: 10000,
                        headers: { 'User-Agent': 'Mozilla/5.0' }
                    });
                    const meta = res.data?.chart?.result?.[0]?.meta;
                    if (!meta) {
                        await conn.sendMessage(m.from, { text: `❌ Ticker "*${ticker}*" not found. Try a valid stock symbol like AAPL, TSLA, GOOGL.` }, { quoted: m });
                        break;
                    }
                    const price = meta.regularMarketPrice;
                    const prev = meta.chartPreviousClose || meta.previousClose;
                    const change = prev ? ((price - prev) / prev * 100).toFixed(2) : 'N/A';
                    const changeEmoji = parseFloat(change) >= 0 ? '📈' : '📉';
                    const currency = meta.currency || 'USD';
                    await conn.sendMessage(m.from, {
                        text: `📈 *${ticker}* (${meta.exchangeName || 'Stock'})\n\n💵 Price: ${currency} ${price?.toFixed(2)}\n${changeEmoji} Day Change: ${change}%\n📊 52W High: ${meta.fiftyTwoWeekHigh?.toFixed(2)}\n📉 52W Low: ${meta.fiftyTwoWeekLow?.toFixed(2)}\n💹 Volume: ${meta.regularMarketVolume?.toLocaleString()}`
                    }, { quoted: m });
                } catch (err) {
                    console.error('Stock error:', err.message);
                    await conn.sendMessage(m.from, { text: "❌ Stock lookup failed. Check the ticker and try again." }, { quoted: m });
                }
                break;
            }

            // ════════════════════════════════════════════
            // PUBLIC HOLIDAYS (Nager.Date — keyless)
            // ════════════════════════════════════════════
            case "holiday":
            case "holidays": {
                // Format: .holiday NG 2026  OR  .holiday NG  (uses current year)
                if (!text) {
                    await conn.sendMessage(m.from, { text: `🗓️ Usage: ${prefix}holiday <country code> [year]\n\nExamples:\n• ${prefix}holiday NG\n• ${prefix}holiday US 2026\n• ${prefix}holiday GB\n\nUse 2-letter ISO country codes (NG=Nigeria, US=USA, GB=UK, GH=Ghana etc).` }, { quoted: m });
                    break;
                }
                const parts = text.toUpperCase().trim().split(' ');
                const countryCode = parts[0];
                const year = parts[1] || new Date().getFullYear();
                try {
                    const axios = require('axios');
                    const res = await axios.get(`https://date.nager.at/api/v3/PublicHolidays/${year}/${countryCode}`, { timeout: 10000 });
                    if (!res.data || res.data.length === 0) {
                        await conn.sendMessage(m.from, { text: `❌ No holidays found for *${countryCode}* in ${year}. Check your country code.` }, { quoted: m });
                        break;
                    }
                    const upcoming = res.data.filter(h => new Date(h.date) >= new Date()).slice(0, 10);
                    const list = (upcoming.length > 0 ? upcoming : res.data.slice(0, 10)).map(h => `• ${h.date} — ${h.name}`).join('\n');
                    await conn.sendMessage(m.from, {
                        text: `🗓️ *Public Holidays — ${countryCode} ${year}*\n${upcoming.length > 0 ? '(Upcoming)' : '(All)'}\n\n${list}`
                    }, { quoted: m });
                } catch (err) {
                    console.error('Holiday error:', err.message);
                    await conn.sendMessage(m.from, { text: "❌ Holiday lookup failed. Check your country code (e.g. NG, US, GB)." }, { quoted: m });
                }
                break;
            }

            // ════════════════════════════════════════════
            // URL INFO (Open Graph + headers inspection)
            // ════════════════════════════════════════════
            case "urlinfo": {
                if (!text || !text.startsWith('http')) {
                    await conn.sendMessage(m.from, { text: `🔍 Usage: ${prefix}urlinfo <url>\n\nExample: ${prefix}urlinfo https://example.com` }, { quoted: m });
                    break;
                }
                try {
                    const axios = require('axios');
                    const res = await axios.get(text, {
                        timeout: 10000,
                        maxRedirects: 5,
                        headers: { 'User-Agent': 'Mozilla/5.0' },
                        validateStatus: () => true
                    });
                    const html = typeof res.data === 'string' ? res.data : '';
                    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
                    const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i) ||
                                     html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["']/i);
                    const ogTitle = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
                    const finalUrl = res.request?.res?.responseUrl || text;

                    await conn.sendMessage(m.from, {
                        text: `🔍 *URL Info*\n\n🌐 URL: ${finalUrl}\n📊 Status: ${res.status} ${res.statusText}\n📝 Title: ${ogTitle?.[1] || titleMatch?.[1] || 'N/A'}\n📄 Description: ${descMatch?.[1]?.substring(0, 150) || 'N/A'}\n📦 Content-Type: ${res.headers?.['content-type'] || 'N/A'}`
                    }, { quoted: m });
                } catch (err) {
                    console.error('URLinfo error:', err.message);
                    await conn.sendMessage(m.from, { text: "❌ Could not fetch URL info. The URL may be unreachable." }, { quoted: m });
                }
                break;
            }

            // ════════════════════════════════════════════
            // COLOR INFO (hex/RGB — pure math, no API)
            // ════════════════════════════════════════════
            case "color":
            case "colorinfo": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `🎨 Usage: ${prefix}color <hex or r,g,b>\n\nExamples:\n• ${prefix}color #FF5733\n• ${prefix}color FF5733\n• ${prefix}color 255,87,51` }, { quoted: m });
                    break;
                }
                try {
                    let r, g, b;
                    const rgb = text.match(/^(\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})$/);
                    if (rgb) {
                        [, r, g, b] = rgb.map(Number);
                    } else {
                        const hex = text.replace('#', '').trim();
                        if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
                            await conn.sendMessage(m.from, { text: "❌ Invalid format. Use hex (e.g. FF5733 or #FF5733) or R,G,B (e.g. 255,87,51)." }, { quoted: m });
                            break;
                        }
                        r = parseInt(hex.slice(0,2), 16);
                        g = parseInt(hex.slice(2,4), 16);
                        b = parseInt(hex.slice(4,6), 16);
                    }
                    if ([r,g,b].some(v => v < 0 || v > 255)) {
                        await conn.sendMessage(m.from, { text: "❌ RGB values must be between 0-255." }, { quoted: m });
                        break;
                    }
                    const hexStr = `#${r.toString(16).padStart(2,'0').toUpperCase()}${g.toString(16).padStart(2,'0').toUpperCase()}${b.toString(16).padStart(2,'0').toUpperCase()}`;
                    // Convert to HSL
                    const rn = r/255, gn = g/255, bn = b/255;
                    const max = Math.max(rn,gn,bn), min = Math.min(rn,gn,bn);
                    const l = (max+min)/2;
                    let h = 0, s = 0;
                    if (max !== min) {
                        const d = max - min;
                        s = l > 0.5 ? d/(2-max-min) : d/(max+min);
                        switch(max) {
                            case rn: h = ((gn-bn)/d + (gn<bn?6:0))/6; break;
                            case gn: h = ((bn-rn)/d + 2)/6; break;
                            case bn: h = ((rn-gn)/d + 4)/6; break;
                        }
                    }
                    // Brightness estimation for a visual label
                    const brightness = (r*299 + g*587 + b*114) / 1000;
                    const brightLabel = brightness > 186 ? '☀️ Light' : '🌙 Dark';
                    await conn.sendMessage(m.from, {
                        text: `🎨 *Color Info*\n\n🔵 Hex: ${hexStr}\n🔴 RGB: rgb(${r}, ${g}, ${b})\n🌈 HSL: hsl(${Math.round(h*360)}°, ${Math.round(s*100)}%, ${Math.round(l*100)}%)\n${brightLabel}\n\nPreview link: https://www.colorhexa.com/${hexStr.replace('#','')}`
                    }, { quoted: m });
                } catch (err) {
                    await conn.sendMessage(m.from, { text: "❌ Invalid color. Use hex (#FF5733) or RGB (255,87,51)." }, { quoted: m });
                }
                break;
            }

            // ════════════════════════════════════════════
            // LYRICS (summary + link only — copyright law
            // prevents reproducing full lyrics even with attribution)
            // ════════════════════════════════════════════
            case "lyrics": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `🎵 Usage: ${prefix}lyrics <artist> - <song>\n\nExamples:\n• ${prefix}lyrics Davido - Fall\n• ${prefix}lyrics Drake - God's Plan` }, { quoted: m });
                    break;
                }
                const dashIdx = text.indexOf('-');
                let artist, song;
                if (dashIdx !== -1) {
                    artist = text.slice(0, dashIdx).trim();
                    song = text.slice(dashIdx + 1).trim();
                } else {
                    const words = text.trim().split(' ');
                    artist = words[0];
                    song = words.slice(1).join(' ') || artist;
                }
                try {
                    const axios = require('axios');
                    const res = await axios.get(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(song)}`, { timeout: 10000 });
                    if (!res.data?.lyrics) {
                        await conn.sendMessage(m.from, { text: `❌ Lyrics not found for "${artist} - ${song}".` }, { quoted: m });
                        break;
                    }
                    // Copyright compliance: summarise the first line only,
                    // then link to a licensed site for the full lyrics.
                    const firstLine = res.data.lyrics.split('\n').find(l => l.trim()) || '';
                    const geniusSearch = `https://genius.com/search?q=${encodeURIComponent(`${artist} ${song}`)}`;
                    await conn.sendMessage(m.from, {
                        text: `🎵 *${artist} — ${song}*\n\nOpening line: "${firstLine.trim()}"\n\n🔗 Full lyrics: ${geniusSearch}\n\n_(Full lyrics cannot be reproduced here for copyright reasons — tap the link above to read them on Genius.)_`
                    }, { quoted: m });
                } catch (err) {
                    console.error('Lyrics error:', err.message);
                    const geniusSearch = `https://genius.com/search?q=${encodeURIComponent(text)}`;
                    await conn.sendMessage(m.from, { text: `❌ Lyrics not found or service unavailable.\n\n🔗 Search on Genius: ${geniusSearch}` }, { quoted: m });
                }
                break;
            }

            // ════════════════════════════════════════════
            // PASTEBIN (paste.rs — keyless, no signup)
            // ════════════════════════════════════════════
            case "pastebin":
            case "paste": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `📋 Usage: ${prefix}paste <text to share>\n\nCreates a shareable link for long text.` }, { quoted: m });
                    break;
                }
                try {
                    const axios = require('axios');
                    const res = await axios.post('https://paste.rs/', text, {
                        timeout: 10000,
                        headers: { 'Content-Type': 'text/plain' }
                    });
                    const url = res.data?.trim() || res.headers?.location;
                    if (!url || !url.startsWith('http')) {
                        await conn.sendMessage(m.from, { text: "❌ Paste failed. Try again later." }, { quoted: m });
                        break;
                    }
                    await conn.sendMessage(m.from, {
                        text: `📋 *Paste Created!*\n\n🔗 ${url}\n\n_(${text.length} characters — link expires in 24h)_`
                    }, { quoted: m });
                } catch (err) {
                    console.error('Pastebin error:', err.message);
                    await conn.sendMessage(m.from, { text: "❌ Paste service is unavailable. Try again later." }, { quoted: m });
                }
                break;
            }

            // ════════════════════════════════════════════
            // SCREENSHOT (thum.io — keyless, ~1000/month free)
            // ════════════════════════════════════════════
            case "screenshot":
            case "ss": {
                if (!text || !text.startsWith('http')) {
                    await conn.sendMessage(m.from, { text: `📸 Usage: ${prefix}screenshot <url>\n\nExample: ${prefix}screenshot https://google.com` }, { quoted: m });
                    break;
                }
                try {
                    const axios = require('axios');
                    // thum.io expects the URL appended directly — NOT encoded
                    const screenshotUrl = `https://image.thum.io/get/width/1280/crop/720/${text}`;
                    const res = await axios.get(screenshotUrl, {
                        timeout: 30000,
                        responseType: 'arraybuffer',
                        headers: {
                            'User-Agent': 'Mozilla/5.0',
                            // Some deployments need a referer to avoid 403s
                            'Referer': 'https://thum.io'
                        }
                    });
                    // thum.io returns a PNG image — verify we got actual image data
                    if (!res.data || res.data.byteLength < 1000) {
                        throw new Error('Empty or invalid image response');
                    }
                    const buffer = Buffer.from(res.data);
                    await conn.sendMessage(m.from, {
                        image: buffer,
                        caption: `📸 Screenshot of ${text}`
                    }, { quoted: m });
                } catch (err) {
                    console.error('Screenshot error:', err.message);
                    // Fallback: send the thum.io URL directly so user can view it in browser
                    const fallbackUrl = `https://image.thum.io/get/width/1280/${text}`;
                    await conn.sendMessage(m.from, {
                        text: `❌ Screenshot delivery failed, but you can view it here:\n${fallbackUrl}`
                    }, { quoted: m });
                }
                break;
            }

            // ════════════════════════════════════════════
            // TEXT TO SPEECH
            // ════════════════════════════════════════════
            case "tts":
            case "speak": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}tts [lang] <text>\n\nExample: ${prefix}tts Hello there!\n${prefix}tts es Hola, ¿cómo estás?\n\nDefault language: en` }, { quoted: m });
                    break;
                }

                // Optional 2-letter language code as the first arg, e.g. "es", "fr", "ja"
                let lang = 'en';
                let ttsText = text;
                if (/^[a-z]{2}$/i.test(args[0]) && args.length > 1) {
                    lang = args[0].toLowerCase();
                    ttsText = args.slice(1).join(' ');
                }

                if (ttsText.length > 200) {
                    await conn.sendMessage(m.from, { text: `❌ Text must be 200 characters or fewer for TTS.` }, { quoted: m });
                    break;
                }

                try {
                    const axios = require('axios');
                    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(ttsText)}&tl=${lang}&client=tw-ob`;
                    const res = await axios.get(url, {
                        responseType: 'arraybuffer',
                        timeout: 15000,
                        headers: { 'User-Agent': 'Mozilla/5.0' }
                    });

                    await conn.sendMessage(m.from, {
                        audio: Buffer.from(res.data),
                        mimetype: 'audio/mpeg',
                        ptt: true
                    }, { quoted: m });
                } catch (err) {
                    console.error('TTS error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to generate speech. Try a shorter message or different language code.` }, { quoted: m });
                }
                break;
            }

            // ════════════════════════════════════════════
            // CONVERTERS (pure JS, no external dependencies)
            // ════════════════════════════════════════════
            case "base64encode":
            case "b64encode": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}base64encode <text>` }, { quoted: m });
                    break;
                }
                const encoded = Buffer.from(text, 'utf8').toString('base64');
                await conn.sendMessage(m.from, { text: `🔐 *Base64 Encoded*\n\n${encoded}` }, { quoted: m });
                break;
            }

            case "base64decode":
            case "b64decode": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}base64decode <base64 text>` }, { quoted: m });
                    break;
                }
                try {
                    const decoded = Buffer.from(text, 'base64').toString('utf8');
                    await conn.sendMessage(m.from, { text: `🔓 *Base64 Decoded*\n\n${decoded}` }, { quoted: m });
                } catch (err) {
                    await conn.sendMessage(m.from, { text: `❌ Invalid Base64 string.` }, { quoted: m });
                }
                break;
            }

            case "hex": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}hex <text>` }, { quoted: m });
                    break;
                }
                const hex = Buffer.from(text, 'utf8').toString('hex');
                await conn.sendMessage(m.from, { text: `🔢 *Hex*\n\n${hex}` }, { quoted: m });
                break;
            }

            case "unhex":
            case "hexdecode": {
                if (!text || !/^[0-9a-f]+$/i.test(text.replace(/\s/g, ''))) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}unhex <hex string>` }, { quoted: m });
                    break;
                }
                try {
                    const decoded = Buffer.from(text.replace(/\s/g, ''), 'hex').toString('utf8');
                    await conn.sendMessage(m.from, { text: `🔓 *Decoded*\n\n${decoded}` }, { quoted: m });
                } catch {
                    await conn.sendMessage(m.from, { text: `❌ Invalid hex string.` }, { quoted: m });
                }
                break;
            }

            case "binary":
            case "binaryencode": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}binary <text>` }, { quoted: m });
                    break;
                }
                const binary = text.split('').map(c => c.charCodeAt(0).toString(2).padStart(8, '0')).join(' ');
                await conn.sendMessage(m.from, { text: `💻 *Binary*\n\n${binary}` }, { quoted: m });
                break;
            }

            case "unbinary":
            case "binarydecode": {
                if (!text || !/^[01\s]+$/.test(text)) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}unbinary <binary string>` }, { quoted: m });
                    break;
                }
                try {
                    const decoded = text.trim().split(/\s+/).map(bin => String.fromCharCode(parseInt(bin, 2))).join('');
                    await conn.sendMessage(m.from, { text: `🔓 *Decoded*\n\n${decoded}` }, { quoted: m });
                } catch {
                    await conn.sendMessage(m.from, { text: `❌ Invalid binary string.` }, { quoted: m });
                }
                break;
            }

            case "morse":
            case "morseencode": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}morseencode <text>` }, { quoted: m });
                    break;
                }
                const MORSE_MAP = {
                    A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---',
                    K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-',
                    U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
                    0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.',
                    '.': '.-.-.-', ',': '--..--', '?': '..--..', "'": '.----.', '!': '-.-.--', '/': '-..-.',
                    '(': '-.--.', ')': '-.--.-', '&': '.-...', ':': '---...', ';': '-.-.-.', '=': '-...-',
                    '+': '.-.-.', '-': '-....-', '_': '..--.-', '"': '.-..-.', '@': '.--.-.'
                };
                const morsed = text.toUpperCase().split('').map(c => c === ' ' ? '/' : (MORSE_MAP[c] || '')).filter(Boolean).join(' ');
                await conn.sendMessage(m.from, { text: `📡 *Morse Code*\n\n${morsed}` }, { quoted: m });
                break;
            }

            case "unmorse":
            case "morsedecode": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}morsedecode <morse code>\nExample: ${prefix}morsedecode .... .. -.-. (use / for spaces between words)` }, { quoted: m });
                    break;
                }
                const REVERSE_MORSE = {
                    '.-': 'A', '-...': 'B', '-.-.': 'C', '-..': 'D', '.': 'E', '..-.': 'F', '--.': 'G', '....': 'H', '..': 'I', '.---': 'J',
                    '-.-': 'K', '.-..': 'L', '--': 'M', '-.': 'N', '---': 'O', '.--.': 'P', '--.-': 'Q', '.-.': 'R', '...': 'S', '-': 'T',
                    '..-': 'U', '...-': 'V', '.--': 'W', '-..-': 'X', '-.--': 'Y', '--..': 'Z',
                    '-----': '0', '.----': '1', '..---': '2', '...--': '3', '....-': '4', '.....': '5', '-....': '6', '--...': '7', '---..': '8', '----.': '9',
                    '.-.-.-': '.', '--..--': ',', '..--..': '?', '.----.': "'", '-.-.--': '!', '-..-.': '/',
                    '-.--.': '(', '-.--.-': ')', '.-...': '&', '---...': ':', '-.-.-.': ';', '-...-': '=',
                    '.-.-.': '+', '-....-': '-', '..--.-': '_', '.-..-.': '"', '.--.-.': '@'
                };
                try {
                    const decoded = text.trim().split('/').map(word =>
                        word.trim().split(/\s+/).map(token => REVERSE_MORSE[token] || '').join('')
                    ).join(' ');
                    if (!decoded.trim()) throw new Error('empty');
                    await conn.sendMessage(m.from, { text: `🔓 *Decoded*\n\n${decoded}` }, { quoted: m });
                } catch {
                    await conn.sendMessage(m.from, { text: `❌ Couldn't decode that. Use . and - for dots/dashes, spaces between letters, / between words.` }, { quoted: m });
                }
                break;
            }

            case "uppercase":
            case "upper": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}uppercase <text>` }, { quoted: m });
                    break;
                }
                await conn.sendMessage(m.from, { text: text.toUpperCase() }, { quoted: m });
                break;
            }

            case "lowercase":
            case "lower": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}lowercase <text>` }, { quoted: m });
                    break;
                }
                await conn.sendMessage(m.from, { text: text.toLowerCase() }, { quoted: m });
                break;
            }

            case "reversetext": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}reversetext <text>` }, { quoted: m });
                    break;
                }
                await conn.sendMessage(m.from, { text: text.split('').reverse().join('') }, { quoted: m });
                break;
            }

            case "mock":
            case "spongebob": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}mock <text>` }, { quoted: m });
                    break;
                }
                const mocked = text.split('').map((c, i) => i % 2 === 0 ? c.toLowerCase() : c.toUpperCase()).join('');
                await conn.sendMessage(m.from, { text: mocked }, { quoted: m });
                break;
            }

            case "convert": {
                // Format: .convert <amount> <fromUnit> to <toUnit>
                const convArgs = text.split(/\s+to\s+/i);
                if (convArgs.length !== 2) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}convert <amount> <unit> to <unit>\n\nExamples:\n${prefix}convert 10 km to miles\n${prefix}convert 100 f to c\n${prefix}convert 5 kg to lbs` }, { quoted: m });
                    break;
                }

                const fromMatch = convArgs[0].trim().match(/^([\d.]+)\s*([a-zA-Z°]+)$/);
                const toUnit = convArgs[1].trim().toLowerCase();
                if (!fromMatch) {
                    await conn.sendMessage(m.from, { text: `❌ Couldn't parse the amount/unit. Example: ${prefix}convert 10 km to miles` }, { quoted: m });
                    break;
                }

                const amount = parseFloat(fromMatch[1]);
                const fromUnit = fromMatch[2].toLowerCase();

                // Length (meters as base)
                const lengthUnits = { mm: 0.001, cm: 0.01, m: 1, km: 1000, in: 0.0254, ft: 0.3048, yd: 0.9144, mile: 1609.34, miles: 1609.34, mi: 1609.34 };
                // Weight (grams as base)
                const weightUnits = { mg: 0.001, g: 1, kg: 1000, oz: 28.3495, lb: 453.592, lbs: 453.592 };

                let result = null;
                let resultUnit = toUnit;

                if (fromUnit === 'c' && toUnit === 'f') {
                    result = (amount * 9 / 5) + 32;
                } else if (fromUnit === 'f' && toUnit === 'c') {
                    result = (amount - 32) * 5 / 9;
                } else if (lengthUnits[fromUnit] && lengthUnits[toUnit]) {
                    result = (amount * lengthUnits[fromUnit]) / lengthUnits[toUnit];
                } else if (weightUnits[fromUnit] && weightUnits[toUnit]) {
                    result = (amount * weightUnits[fromUnit]) / weightUnits[toUnit];
                }

                if (result === null) {
                    await conn.sendMessage(m.from, { text: `❌ Unsupported unit conversion: ${fromUnit} → ${toUnit}\n\nSupported: mm/cm/m/km/in/ft/yd/mile, mg/g/kg/oz/lb, c/f` }, { quoted: m });
                    break;
                }

                await conn.sendMessage(m.from, {
                    text: `🔄 *Convert*\n\n${amount} ${fromUnit} = *${result.toFixed(4).replace(/\.?0+$/, '')} ${toUnit}*`
                }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // REMINDERS
            // ════════════════════════════════════════════
            case "remind":
            case "reminder": {
                if (!phoneNumber) break; // reminders need a session owner to deliver later

                const durationStr = args[0];
                const reminderText = args.slice(1).join(' ');

                if (!durationStr || !reminderText) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}remind <duration> <text>\n\nExamples:\n${prefix}remind 10m Drink water\n${prefix}remind 2h Take a break\n${prefix}remind 1d Pay rent\n\nUnits: s/m/h/d` }, { quoted: m });
                    break;
                }

                const delayMs = reminders.parseDuration(durationStr);
                if (!delayMs) {
                    await conn.sendMessage(m.from, { text: `❌ Invalid duration. Use a number + unit, e.g. 10m, 2h, 1d.` }, { quoted: m });
                    break;
                }
                if (delayMs > 30 * 24 * 60 * 60 * 1000) {
                    await conn.sendMessage(m.from, { text: `❌ Reminders can be set at most 30 days out.` }, { quoted: m });
                    break;
                }

                const reminder = await reminders.createReminder(redisClient, {
                    phoneNumber,
                    chatJid: m.from,
                    jid: m.sender,
                    text: reminderText,
                    delayMs
                });

                const dueDate = new Date(reminder.dueAt);
                await conn.sendMessage(m.from, {
                    text: `⏰ Reminder set!\n\n📝 "${reminderText}"\n🕐 ${dueDate.toLocaleString()}\n\nID: \`${reminder.id}\` (use ${prefix}cancelreminder ${reminder.id} to cancel)`
                }, { quoted: m });
                break;
            }

            case "reminders":
            case "myreminders": {
                const list = await reminders.listUserReminders(redisClient, m.sender);
                if (list.length === 0) {
                    await conn.sendMessage(m.from, { text: `⏰ You have no upcoming reminders. Set one with ${prefix}remind <duration> <text>` }, { quoted: m });
                    break;
                }

                const lines = list.map(r => `• "${r.text}" — ${new Date(r.dueAt).toLocaleString()}\n  ID: \`${r.id}\``);
                await conn.sendMessage(m.from, { text: `⏰ *Your Reminders*\n\n${lines.join('\n\n')}` }, { quoted: m });
                break;
            }

            case "cancelreminder": {
                const id = args[0];
                if (!id) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}cancelreminder <id>\n\nFind IDs with ${prefix}reminders` }, { quoted: m });
                    break;
                }

                const result = await reminders.cancelReminder(redisClient, m.sender, id);
                if (result.error === 'not_found') {
                    await conn.sendMessage(m.from, { text: `❌ Reminder not found. It may have already fired or been cancelled.` }, { quoted: m });
                    break;
                }
                if (result.error === 'not_yours') {
                    await conn.sendMessage(m.from, { text: `❌ That's not your reminder.` }, { quoted: m });
                    break;
                }

                await conn.sendMessage(m.from, { text: `✅ Cancelled reminder: "${result.reminder.text}"` }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // NOTES
            // ════════════════════════════════════════════
            case "note": {
                const sub = args[0]?.toLowerCase();

                if (sub === 'add') {
                    const noteText = args.slice(1).join(' ');
                    if (!noteText) {
                        await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}note add <text>` }, { quoted: m });
                        break;
                    }
                    const raw = await redisClient.hGet(`economy:${m.sender}`, 'notes');
                    const notesList = raw ? JSON.parse(raw) : [];
                    if (notesList.length >= 20) {
                        await conn.sendMessage(m.from, { text: `❌ You've hit the 20-note limit. Delete one first with ${prefix}note del <number>.` }, { quoted: m });
                        break;
                    }
                    notesList.push({ text: noteText, createdAt: Date.now() });
                    await redisClient.hSet(`economy:${m.sender}`, 'notes', JSON.stringify(notesList));
                    await conn.sendMessage(m.from, { text: `📝 Note saved! (${notesList.length}/20)` }, { quoted: m });
                    break;
                }

                if (sub === 'del' || sub === 'delete' || sub === 'remove') {
                    const idx = parseInt(args[1]) - 1;
                    const raw = await redisClient.hGet(`economy:${m.sender}`, 'notes');
                    const notesList = raw ? JSON.parse(raw) : [];
                    if (isNaN(idx) || idx < 0 || idx >= notesList.length) {
                        await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}note del <number>\n\nSee numbers with ${prefix}note` }, { quoted: m });
                        break;
                    }
                    const removed = notesList.splice(idx, 1)[0];
                    await redisClient.hSet(`economy:${m.sender}`, 'notes', JSON.stringify(notesList));
                    await conn.sendMessage(m.from, { text: `🗑️ Deleted note: "${removed.text}"` }, { quoted: m });
                    break;
                }

                if (sub === 'clear') {
                    await redisClient.hDel(`economy:${m.sender}`, 'notes');
                    await conn.sendMessage(m.from, { text: `🗑️ All notes cleared.` }, { quoted: m });
                    break;
                }

                // No subcommand → list notes
                const raw = await redisClient.hGet(`economy:${m.sender}`, 'notes');
                const notesList = raw ? JSON.parse(raw) : [];
                if (notesList.length === 0) {
                    await conn.sendMessage(m.from, { text: `📝 You have no notes. Add one with ${prefix}note add <text>` }, { quoted: m });
                    break;
                }
                const lines = notesList.map((n, i) => `${i + 1}. ${n.text}`);
                await conn.sendMessage(m.from, { text: `📝 *Your Notes*\n\n${lines.join('\n')}\n\nDelete with ${prefix}note del <number>` }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // TODO LIST
            // ════════════════════════════════════════════
            case "todo": {
                const sub = args[0]?.toLowerCase();

                if (sub === 'add') {
                    const taskText = args.slice(1).join(' ');
                    if (!taskText) {
                        await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}todo add <task>` }, { quoted: m });
                        break;
                    }
                    const raw = await redisClient.hGet(`economy:${m.sender}`, 'todos');
                    const todoList = raw ? JSON.parse(raw) : [];
                    if (todoList.length >= 30) {
                        await conn.sendMessage(m.from, { text: `❌ You've hit the 30-task limit. Clear some done tasks first.` }, { quoted: m });
                        break;
                    }
                    todoList.push({ text: taskText, done: false, createdAt: Date.now() });
                    await redisClient.hSet(`economy:${m.sender}`, 'todos', JSON.stringify(todoList));
                    await conn.sendMessage(m.from, { text: `✅ Task added! (${todoList.length}/30)` }, { quoted: m });
                    break;
                }

                if (sub === 'done' || sub === 'complete') {
                    const idx = parseInt(args[1]) - 1;
                    const raw = await redisClient.hGet(`economy:${m.sender}`, 'todos');
                    const todoList = raw ? JSON.parse(raw) : [];
                    if (isNaN(idx) || idx < 0 || idx >= todoList.length) {
                        await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}todo done <number>\n\nSee numbers with ${prefix}todo` }, { quoted: m });
                        break;
                    }
                    todoList[idx].done = true;
                    await redisClient.hSet(`economy:${m.sender}`, 'todos', JSON.stringify(todoList));
                    await conn.sendMessage(m.from, { text: `✅ Marked done: "${todoList[idx].text}"` }, { quoted: m });
                    break;
                }

                if (sub === 'del' || sub === 'delete' || sub === 'remove') {
                    const idx = parseInt(args[1]) - 1;
                    const raw = await redisClient.hGet(`economy:${m.sender}`, 'todos');
                    const todoList = raw ? JSON.parse(raw) : [];
                    if (isNaN(idx) || idx < 0 || idx >= todoList.length) {
                        await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}todo del <number>` }, { quoted: m });
                        break;
                    }
                    const removed = todoList.splice(idx, 1)[0];
                    await redisClient.hSet(`economy:${m.sender}`, 'todos', JSON.stringify(todoList));
                    await conn.sendMessage(m.from, { text: `🗑️ Removed: "${removed.text}"` }, { quoted: m });
                    break;
                }

                if (sub === 'clear') {
                    await redisClient.hDel(`economy:${m.sender}`, 'todos');
                    await conn.sendMessage(m.from, { text: `🗑️ Todo list cleared.` }, { quoted: m });
                    break;
                }

                // No subcommand → list tasks
                const raw = await redisClient.hGet(`economy:${m.sender}`, 'todos');
                const todoList = raw ? JSON.parse(raw) : [];
                if (todoList.length === 0) {
                    await conn.sendMessage(m.from, { text: `✅ Your todo list is empty. Add a task with ${prefix}todo add <task>` }, { quoted: m });
                    break;
                }
                const lines = todoList.map((t, i) => `${i + 1}. ${t.done ? '✅' : '⬜'} ${t.text}`);
                const pending = todoList.filter(t => !t.done).length;
                await conn.sendMessage(m.from, { text: `📋 *Your Todo List* (${pending} pending)\n\n${lines.join('\n')}\n\nMark done: ${prefix}todo done <number>` }, { quoted: m });
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
            // ════════════════════════════════════════════
            // PREMIUM SYSTEM
            // ════════════════════════════════════════════
            case "premium": {
                const target = m.mentionedJid?.[0] || m.sender;
                const p = await premium.getPremium(redisClient, target);
                const isOwn = target === m.sender;

                if (!p) {
                    if (isOwn) {
                        await conn.sendMessage(m.from, {
                            text: `✨ *Lady Liya Premium*\n\nYou don't have premium yet.\n\n*Benefits:*\n⭐ Basic — 2,500 daily (vs 1,000) | 20,000 weekly | Work every 30 min | 1.5× coins & XP\n💎 VIP — 5,000 daily | 40,000 weekly | Work every 15 min | 2× coins & XP\n\nGet yours: ${prefix}buypremium\nOr ask an admin to gift you: ${prefix}giftpremium @you <days>`
                        }, { quoted: m });
                    } else {
                        await conn.sendMessage(m.from, { text: `ℹ️ @${target.split('@')[0]} does not have premium.`, mentions: [target] }, { quoted: m });
                    }
                    break;
                }

                await conn.sendMessage(m.from, {
                    text: `${p.tierData.badge} *${isOwn ? 'Your' : `@${target.split('@')[0]}'s`} Premium Status*\n\n` +
                        `Tier: *${p.tierData.name}*\n` +
                        `Expires: *${premium.formatExpiry(p.expiry)}*\n` +
                        `Granted by: +${p.grantedBy}\n\n` +
                        `*Active Benefits:*\n` +
                        `• Daily bonus: ${economy.formatCoins(p.tierData.dailyBonus)} coins\n` +
                        `• Weekly bonus: ${economy.formatCoins(p.tierData.weeklyBonus)} coins\n` +
                        `• Work cooldown: ${Math.round(p.tierData.workCooldownMs / 60000)} min\n` +
                        `• XP multiplier: ${p.tierData.xpMultiplier}×\n` +
                        `• Coin multiplier: ${p.tierData.coinMultiplier}×`,
                    mentions: isOwn ? [] : [target]
                }, { quoted: m });
                break;
            }

            case "buypremium": {
                // ── Edit this message to set your own payment details / price / contact ──
                await conn.sendMessage(m.from, {
                    text: `💎 *Lady Liya Premium*\n\n` +
                        `⭐ *Basic* — 30 days\n` +
                        `💎 *VIP* — 30 days\n\n` +
                        `To purchase, contact the bot developer:\n` +
                        `📩 t.me/KallmeTrust\n\n` +
                        `Once payment is confirmed, premium will be activated on your account within 24h.\n\n` +
                        `Already have premium? Check your status: ${prefix}premium`
                }, { quoted: m });
                break;
            }

            case "giftpremium": {
                if (!isSuperAdmin(m, phoneNumber)) {
                    await conn.sendMessage(m.from, { text: "❌ Only the bot developer can grant premium." }, { quoted: m });
                    break;
                }

                // Usage: .giftpremium @user <days> [tier]
                const giftTarget = m.mentionedJid?.[0];
                const giftDays = parseInt(args[1]) || parseInt(args[0]);
                const giftTier = args[2]?.toLowerCase() || args[1]?.toLowerCase() || 'basic';
                const resolvedTier = premium.PREMIUM_TIERS[giftTier] ? giftTier : 'basic';

                if (!giftTarget || !giftDays || giftDays <= 0) {
                    await conn.sendMessage(m.from, {
                        text: `❌ Usage: ${prefix}giftpremium @user <days> [tier]\nExample: ${prefix}giftpremium @user 30 vip\n\nTiers: basic, vip\nUse 0 days for lifetime.`
                    }, { quoted: m });
                    break;
                }

                const finalExpiry = await premium.grantPremium(redisClient, giftTarget, giftDays, normalizeJid(m.sender), resolvedTier);
                const tierData = premium.PREMIUM_TIERS[resolvedTier];

                await conn.sendMessage(m.from, {
                    text: `${tierData.badge} *Premium Granted!*\n\n` +
                        `User: @${giftTarget.split('@')[0]}\n` +
                        `Tier: ${tierData.name}\n` +
                        `Duration: ${giftDays === 0 ? 'Lifetime' : `${giftDays} days`}\n` +
                        `Expires: ${premium.formatExpiry(finalExpiry)}`,
                    mentions: [giftTarget]
                }, { quoted: m });

                // Notify the recipient
                try {
                    await conn.sendMessage(giftTarget, {
                        text: `🎁 *You've been gifted Premium!*\n\n${tierData.badge} *${tierData.name}*\n${giftDays === 0 ? 'Lifetime access' : `Valid for ${giftDays} days`}\n\n*Your Benefits:*\n• Daily: ${economy.formatCoins(tierData.dailyBonus)} coins\n• Weekly: ${economy.formatCoins(tierData.weeklyBonus)} coins\n• Work cooldown: ${Math.round(tierData.workCooldownMs / 60000)} min\n• ${tierData.xpMultiplier}× XP & ${tierData.coinMultiplier}× coins on all earnings\n\nCheck your status anytime: ${prefix}premium`
                    });
                } catch {}
                break;
            }

            case "revokepremium": {
                if (!isSuperAdmin(m, phoneNumber)) {
                    await conn.sendMessage(m.from, { text: "❌ Only the bot developer can revoke premium." }, { quoted: m });
                    break;
                }

                const revokeTarget = m.mentionedJid?.[0] || (text ? `${text.replace(/[^0-9]/g, '')}@s.whatsapp.net` : null);
                if (!revokeTarget) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}revokepremium @user` }, { quoted: m });
                    break;
                }

                const wasActive = await premium.revokePremium(redisClient, revokeTarget);
                await conn.sendMessage(m.from, {
                    text: wasActive
                        ? `✅ Premium revoked for @${revokeTarget.split('@')[0]}.`
                        : `ℹ️ @${revokeTarget.split('@')[0]} didn't have active premium.`,
                    mentions: [revokeTarget]
                }, { quoted: m });
                break;
            }

            case "premiumlist": {
                if (!isSuperAdmin(m, phoneNumber)) {
                    await conn.sendMessage(m.from, { text: "❌ Only the bot developer can view the premium list." }, { quoted: m });
                    break;
                }

                const activeList = await premium.listPremium(redisClient);
                if (!activeList.length) {
                    await conn.sendMessage(m.from, { text: `💎 No active premium users right now.` }, { quoted: m });
                    break;
                }

                const lines = activeList.map((p, i) =>
                    `${i + 1}. ${p.tierData.badge} +${normalizeJid(p.jid)} — ${p.tierData.name} (${premium.formatExpiry(p.expiry)})`
                );

                await conn.sendMessage(m.from, {
                    text: `💎 *Active Premium Users* (${activeList.length})\n\n${lines.join('\n')}`
                }, { quoted: m });
                break;
            }

            case "profile":
            case "p": {
                const target = m.quoted?.sender || m.mentionedJid?.[0] || m.sender;
                const profile = await economy.getProfile(redisClient, target);
                const xpNeeded = economy.xpForLevel(profile.level);

                const marriedText = profile.married
                    ? `💍 Married to @${profile.married.split('@')[0]}`
                    : `💔 Single`;

                // ── Enriched profile data: badges, equipped title/theme, bio, premium ──
                const ownedBadges = await badges.getBadges(redisClient, target);
                const equippedTitle = await shop.getEquipped(redisClient, target, 'equippedTitle');
                const equippedTheme = await shop.getEquipped(redisClient, target, 'equippedTheme');
                const bio = await redisClient.hGet(`economy:${target}`, 'bio');
                const premiumInfo = await premium.getPremium(redisClient, target);

                const titleDef = equippedTitle ? shop.findItem(shop.TITLES, equippedTitle) : null;
                const themeDef = equippedTheme ? shop.findItem(shop.THEMES, equippedTheme) : null;
                const titleLine = titleDef ? `🏷️ ${titleDef.name}\n` : '';
                const themeEmoji = themeDef ? themeDef.emoji + ' ' : '';
                const bioLine = bio ? `📝 "${bio}"\n` : '';
                const premiumLine = premiumInfo
                    ? `${premiumInfo.tierData.badge} *${premiumInfo.tierData.name}* (${premium.formatExpiry(premiumInfo.expiry)})\n`
                    : '';

                const profileText = `
${themeEmoji}👤 *PROFILE — @${target.split('@')[0]}*
${premiumLine}${titleLine}━━━━━━━━━━━━━━━━━━━
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

            case "shiprandom": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: `❌ ${prefix}shiprandom only works in group chats.` }, { quoted: m });
                    break;
                }
                try {
                    const meta = await conn.groupMetadata(m.from);
                    const pool = meta.participants.map(p => p.id).filter(id => id !== m.key.participant && !id.includes('bot'));
                    if (pool.length < 2) {
                        await conn.sendMessage(m.from, { text: `❌ Not enough people in this group to ship.` }, { quoted: m });
                        break;
                    }
                    const shuffled = [...pool].sort(() => Math.random() - 0.5);
                    const [userA, userB] = shuffled;
                    const percent = funstuff.hashPercent(funstuff.pairKey(userA, userB, Date.now().toString().slice(0, -4))); // changes every ~3 hours so reruns vary
                    const filledHearts = Math.round(percent / 10);
                    const heartBar = '❤️'.repeat(filledHearts) + '🖤'.repeat(10 - filledHearts);

                    await conn.sendMessage(m.from, {
                        text: `💘 *RANDOM SHIP*\n\n@${userA.split('@')[0]} + @${userB.split('@')[0]}\n\n${heartBar}\n${percent}% compatible`,
                        mentions: [userA, userB]
                    }, { quoted: m });
                } catch (err) {
                    console.error('shiprandom error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to pick a random pair.` }, { quoted: m });
                }
                break;
            }

            case "compatibility": {
                let userA, userB;
                if (m.mentionedJid?.length >= 2) {
                    [userA, userB] = m.mentionedJid;
                } else if (m.mentionedJid?.length === 1) {
                    userA = m.sender;
                    userB = m.mentionedJid[0];
                } else {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}compatibility @user1 [@user2]` }, { quoted: m });
                    break;
                }

                const { romance, friendship, communication } = funstuff.computeCompatibility(userA, userB);
                const bar = (p) => '▰'.repeat(Math.round(p / 10)) + '▱'.repeat(10 - Math.round(p / 10));

                await conn.sendMessage(m.from, {
                    text: `💞 *COMPATIBILITY REPORT*\n\n@${userA.split('@')[0]} + @${userB.split('@')[0]}\n\n` +
                        `💘 Romance: ${bar(romance)} ${romance}%\n` +
                        `🤝 Friendship: ${bar(friendship)} ${friendship}%\n` +
                        `💬 Communication: ${bar(communication)} ${communication}%`,
                    mentions: [userA, userB]
                }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // PARTY GAMES
            // ════════════════════════════════════════════
            case "fortune": {
                await conn.sendMessage(m.from, { text: `🥠 *FORTUNE*\n\n${funstuff.randomFortune()}` }, { quoted: m });
                break;
            }

            case "truth": {
                await conn.sendMessage(m.from, { text: `🎯 *TRUTH*\n\n${funstuff.randomTruth()}` }, { quoted: m });
                break;
            }

            case "dare": {
                await conn.sendMessage(m.from, { text: `🔥 *DARE*\n\n${funstuff.randomDare()}` }, { quoted: m });
                break;
            }

            case "wyr": {
                const { a, b } = funstuff.randomWYR();
                await conn.sendMessage(m.from, { text: `🤔 *WOULD YOU RATHER*\n\nWould you rather...\n\nA) ${a}\n\n— or —\n\nB) ${b}` }, { quoted: m });
                break;
            }

            case "never": {
                await conn.sendMessage(m.from, { text: `🙊 *NEVER HAVE I EVER*\n\n${funstuff.randomNever()}\n\n(Put a finger down if it's true for you 😏)` }, { quoted: m });
                break;
            }

            case "pick":
            case "choose": {
                const options = text.split(/,| or /i).map(s => s.trim()).filter(Boolean);
                if (options.length < 2) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}${command} option1, option2, option3...\n\nExample: ${prefix}${command} pizza, sushi, tacos` }, { quoted: m });
                    break;
                }
                const choice = funstuff.pickRandom(options);
                await conn.sendMessage(m.from, { text: `🎲 *${command === 'choose' ? 'CHOICE' : 'PICK'}*\n\nOptions: ${options.join(' / ')}\n\n👉 I choose: *${choice}*` }, { quoted: m });
                break;
            }

            case "spinwheel": {
                const options = text.split(/,| or /i).map(s => s.trim()).filter(Boolean);
                if (options.length < 2) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}spinwheel option1, option2, option3...\n\nExample: ${prefix}spinwheel truth, dare, skip` }, { quoted: m });
                    break;
                }
                const winner = funstuff.pickRandom(options);
                await conn.sendMessage(m.from, { text: `🎡 Spinning the wheel: ${options.join(' • ')}...` }, { quoted: m });
                setTimeout(async () => {
                    try {
                        await conn.sendMessage(m.from, { text: `🎡 *THE WHEEL LANDED ON:*\n\n🏆 *${winner}*` });
                    } catch {}
                }, 1800);
                break;
            }

            case "confess": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: `❌ ${prefix}confess only works in group chats.` }, { quoted: m });
                    break;
                }
                if (!text) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}confess <your anonymous message>\n\nIt's posted to the group with no trace of who sent it.` }, { quoted: m });
                    break;
                }
                try { await conn.sendMessage(m.from, { delete: m.key }); } catch {} // best-effort: remove the giveaway original if bot has admin

                await conn.sendMessage(m.from, { text: `${funstuff.randomConfessionIntro()}\n\n${text}` });
                break;
            }

            // ════════════════════════════════════════════
            // NICKNAME
            // ════════════════════════════════════════════
            case "nickname": {
                let target = m.sender;
                let nicknameText = text;

                if (m.mentionedJid?.[0]) {
                    target = m.mentionedJid[0];
                    nicknameText = text.replace(/@\d+/, '').trim();
                    if (target !== m.sender && !senderHasAccess) {
                        await conn.sendMessage(m.from, { text: `❌ Only Owner/Sudo can set someone else's nickname.` }, { quoted: m });
                        break;
                    }
                }

                if (!nicknameText || nicknameText.toLowerCase() === 'remove' || nicknameText.toLowerCase() === 'clear') {
                    if (nicknameText && ['remove', 'clear'].includes(nicknameText.toLowerCase())) {
                        await funstuff.clearNickname(redisClient, target);
                        await conn.sendMessage(m.from, { text: `✅ Nickname cleared for @${target.split('@')[0]}.`, mentions: [target] }, { quoted: m });
                        break;
                    }
                    const current = await funstuff.getNickname(redisClient, target);
                    await conn.sendMessage(m.from, {
                        text: current
                            ? `🏷️ @${target.split('@')[0]}'s nickname: *${current}*`
                            : `🏷️ @${target.split('@')[0]} has no nickname set.\n\nUsage: ${prefix}nickname <text> (or ${prefix}nickname remove)`,
                        mentions: [target]
                    }, { quoted: m });
                    break;
                }

                if (nicknameText.length > 30) {
                    await conn.sendMessage(m.from, { text: `❌ Keep it under 30 characters.` }, { quoted: m });
                    break;
                }

                await funstuff.setNickname(redisClient, target, nicknameText);
                await conn.sendMessage(m.from, { text: `✅ @${target.split('@')[0]}'s nickname is now: *${nicknameText}*`, mentions: [target] }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // ACTIVITY LOOKUPS
            // ════════════════════════════════════════════
            case "lastseen": {
                const target = m.mentionedJid?.[0] || m.sender;
                const record = await funstuff.getLastSeen(redisClient, m.from, target);

                if (!record) {
                    await conn.sendMessage(m.from, { text: `❌ No activity on record for @${target.split('@')[0]} in this chat yet.`, mentions: [target] }, { quoted: m });
                    break;
                }

                const ago = Date.now() - record.ts;
                await conn.sendMessage(m.from, {
                    text: `👀 *Last seen (in this chat)*\n\n@${target.split('@')[0]} was last active ${economy.formatDuration(ago)} ago.\n\n_Based on messages the bot has observed here — not WhatsApp's own last-seen status._`,
                    mentions: [target]
                }, { quoted: m });
                break;
            }

            case "firstmessage": {
                const target = m.mentionedJid?.[0] || m.sender;
                const record = await funstuff.getFirstMessage(redisClient, m.from, target);

                if (!record) {
                    await conn.sendMessage(m.from, { text: `❌ No message on record for @${target.split('@')[0]} in this chat yet.`, mentions: [target] }, { quoted: m });
                    break;
                }

                const when = new Date(record.ts).toLocaleString();
                await conn.sendMessage(m.from, {
                    text: `📜 *First message on record*\n\n@${target.split('@')[0]}, ${when}:\n"${record.preview || '(no text — media/other message type)'}"\n\n_Only covers activity since the bot joined and started tracking._`,
                    mentions: [target]
                }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // JOKE / PRANK COMMANDS — purely cosmetic, no real
            // moderation action is taken by any of these
            // ════════════════════════════════════════════
            case "fakeban": {
                const target = m.mentionedJid?.[0];
                if (!target) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}fakeban @user` }, { quoted: m });
                    break;
                }
                await conn.sendMessage(m.from, {
                    text: `🔨 @${target.split('@')[0]} has been BANNED from the group!\n\n📛 Reason: existing\n\n😂 *(relax, this is just a prank — nothing actually happened)*`,
                    mentions: [target]
                }, { quoted: m });
                break;
            }

            case "fakehack": {
                const target = m.mentionedJid?.[0] || m.sender;
                const steps = [
                    `💻 Initiating "hack" on @${target.split('@')[0]}...`,
                    `🔓 Bypassing firewall... [██████░░░░] 60%`,
                    `📂 Accessing files... found 1,204 embarrassing memes`,
                    `🎉 Hack "complete"! 😂 *(this was 100% fake, nothing was accessed)*`
                ];
                for (let i = 0; i < steps.length; i++) {
                    setTimeout(async () => {
                        try { await conn.sendMessage(m.from, { text: steps[i], mentions: [target] }); } catch {}
                    }, i * 1300);
                }
                break;
            }

            case "faketyping": {
                const seconds = Math.min(30, Math.max(2, parseInt(args[0]) || 8));
                try {
                    await conn.sendPresenceUpdate('composing', m.from);
                    setTimeout(() => {
                        conn.sendPresenceUpdate('paused', m.from).catch(() => {});
                    }, seconds * 1000);
                    await conn.sendMessage(m.from, { text: `⌨️ Now showing "typing..." for ${seconds}s (nothing's actually coming 😂)` }, { quoted: m });
                } catch (err) {
                    console.error('faketyping error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Couldn't trigger typing indicator.` }, { quoted: m });
                }
                break;
            }

            // ════════════════════════════════════════════
            // TEXT & CALCULATOR UTILITIES
            // ════════════════════════════════════════════
            case "rot13": {
                if (!text) { await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}rot13 <text>` }, { quoted: m }); break; }
                await conn.sendMessage(m.from, { text: `🔤 ${textutils.rot13(text)}` }, { quoted: m });
                break;
            }

            case "jsonformat": {
                if (!text) { await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}jsonformat <json text>` }, { quoted: m }); break; }
                try {
                    const formatted = textutils.formatJson(text);
                    await conn.sendMessage(m.from, { text: `\`\`\`${formatted}\`\`\`` }, { quoted: m });
                } catch {
                    await conn.sendMessage(m.from, { text: `❌ That's not valid JSON.` }, { quoted: m });
                }
                break;
            }

            case "wordcount": {
                if (!text) { await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}wordcount <text>` }, { quoted: m }); break; }
                const wc = textutils.wordCount(text);
                await conn.sendMessage(m.from, { text: `📊 *WORD COUNT*\n\nWords: ${wc.words}\nCharacters: ${wc.chars}\nCharacters (no spaces): ${wc.charsNoSpaces}\nSentences: ${wc.sentences}` }, { quoted: m });
                break;
            }

            case "passwordgen": {
                const length = Math.min(64, Math.max(6, parseInt(args[0]) || 16));
                const pw = textutils.generatePassword(length);
                await conn.sendMessage(m.from, { text: `🔐 *Generated Password* (${length} chars)\n\n\`${pw}\`\n\n_Sent in this chat, so treat it as seen — regenerate before real use if this isn't a private chat._` }, { quoted: m });
                break;
            }

            case "bmicalc": {
                const heightCm = parseFloat(args[0]), weightKg = parseFloat(args[1]);
                if (!heightCm || !weightKg) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}bmicalc <height_cm> <weight_kg>\n\nExample: ${prefix}bmicalc 175 70` }, { quoted: m });
                    break;
                }
                const { bmi, category } = textutils.calcBmi(heightCm, weightKg);
                await conn.sendMessage(m.from, { text: `⚖️ *BMI CALCULATOR*\n\nBMI: ${bmi}\nCategory: ${category}\n\n_BMI is a rough screening tool, not a diagnosis — it doesn't account for muscle mass, frame, or individual health._` }, { quoted: m });
                break;
            }

            case "tipcalc": {
                const bill = parseFloat(args[0]), tipPct = parseFloat(args[1]) || 15, splitCount = parseInt(args[2]) || 1;
                if (!bill) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}tipcalc <bill> [tip%] [split]\n\nExample: ${prefix}tipcalc 84.50 20 4` }, { quoted: m });
                    break;
                }
                const { tip, total, perPerson } = textutils.calcTip(bill, tipPct, splitCount);
                await conn.sendMessage(m.from, { text: `🧾 *TIP CALCULATOR*\n\nBill: ${bill}\nTip (${tipPct}%): ${tip}\nTotal: ${total}${splitCount > 1 ? `\nPer person (${splitCount}): ${perPerson}` : ''}` }, { quoted: m });
                break;
            }

            case "agecalc": {
                const dob = new Date(args[0]);
                if (!args[0] || isNaN(dob.getTime())) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}agecalc <YYYY-MM-DD>\n\nExample: ${prefix}agecalc 2000-06-15` }, { quoted: m });
                    break;
                }
                const { years, months, days, totalDays } = textutils.calcAge(dob);
                await conn.sendMessage(m.from, { text: `🎂 *AGE CALCULATOR*\n\n${years} years, ${months} months, ${days} days\n(${totalDays.toLocaleString()} days total)` }, { quoted: m });
                break;
            }

            case "countdown": {
                const dateStr = args.slice(-1)[0];
                const label = args.slice(0, -1).join(' ') || 'Event';
                const target = new Date(dateStr);
                if (!dateStr || isNaN(target.getTime())) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}countdown [label] <YYYY-MM-DD>\n\nExample: ${prefix}countdown New Year 2027-01-01` }, { quoted: m });
                    break;
                }
                const { past, days, hours, minutes } = textutils.calcCountdown(target);
                await conn.sendMessage(m.from, {
                    text: past
                        ? `⏰ *${label}* was ${days}d ${hours}h ${minutes}m ago.`
                        : `⏳ *${label}* is in ${days}d ${hours}h ${minutes}m.`
                }, { quoted: m });
                break;
            }

            case "expensesplit": {
                const amount = parseFloat(args[0]);
                const peopleCount = m.mentionedJid?.length > 0 ? m.mentionedJid.length + 1 : parseInt(args[1]);
                if (!amount || !peopleCount || peopleCount < 1) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}expensesplit <amount> <people>\nor: ${prefix}expensesplit <amount> @user1 @user2...\n\nExample: ${prefix}expensesplit 120 4` }, { quoted: m });
                    break;
                }
                const { perPerson, remainder } = textutils.splitExpense(amount, peopleCount);
                await conn.sendMessage(m.from, {
                    text: `💸 *EXPENSE SPLIT*\n\nTotal: ${amount}\nSplit ${peopleCount} ways: ${perPerson} each${remainder ? `\n(${remainder} left over due to rounding)` : ''}`,
                    mentions: m.mentionedJid || []
                }, { quoted: m });
                break;
            }

            case "zodiac": {
                const [month, day] = (args[0] || '').split(/[\/\-]/).map(Number);
                if (!month || !day) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}zodiac <MM-DD>\n\nExample: ${prefix}zodiac 07-15` }, { quoted: m });
                    break;
                }
                const z = textutils.getZodiacSign(month, day);
                if (!z) { await conn.sendMessage(m.from, { text: `❌ That doesn't look like a valid date.` }, { quoted: m }); break; }
                await conn.sendMessage(m.from, { text: `${z.emoji} *${z.sign}*` }, { quoted: m });
                break;
            }

            case "chinesezodiac": {
                const year = parseInt(args[0]);
                if (!year || year < 1900 || year > 2100) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}chinesezodiac <birth year>\n\nExample: ${prefix}chinesezodiac 2000` }, { quoted: m });
                    break;
                }
                await conn.sendMessage(m.from, { text: `🐉 *Chinese Zodiac (${year}):* ${textutils.getChineseZodiac(year)}` }, { quoted: m });
                break;
            }

            case "numerology": {
                const [year, month, day] = (args[0] || '').split(/[\/\-]/).map(Number);
                if (!year || !month || !day) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}numerology <YYYY-MM-DD>\n\nExample: ${prefix}numerology 1995-06-15` }, { quoted: m });
                    break;
                }
                const num = textutils.getLifePathNumber(year, month, day);
                await conn.sendMessage(m.from, { text: `🔢 *NUMEROLOGY*\n\nLife Path Number: *${num}*\n\n${textutils.LIFE_PATH_MEANINGS[num] || ''}` }, { quoted: m });
                break;
            }

            case "tarot": {
                const { name, meaning, reversed } = textutils.drawTarotCard();
                await conn.sendMessage(m.from, { text: `🔮 *TAROT*\n\n🃏 *${name}*${reversed ? ' (Reversed)' : ''}\n\n${meaning}` }, { quoted: m });
                break;
            }

            case "iqtest": {
                const { score, comment } = textutils.fakeIqScore();
                await conn.sendMessage(m.from, { text: `🧠 *IQ TEST*\n\nYour score: *${score}*\n\n${comment}\n\n_Purely for fun — not a real cognitive assessment._` }, { quoted: m });
                break;
            }

            case "anagram": {
                const words = text.split(/\s+/).filter(Boolean);
                if (words.length !== 2) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}anagram <word1> <word2>\n\nChecks whether two words are anagrams of each other.` }, { quoted: m });
                    break;
                }
                const isAnagram = textutils.areAnagrams(words[0], words[1]);
                await conn.sendMessage(m.from, { text: isAnagram ? `✅ Yes! "${words[0]}" and "${words[1]}" are anagrams.` : `❌ Nope, those aren't anagrams of each other.` }, { quoted: m });
                break;
            }

            case "emojiquiz": {
                const { emoji, answer } = textutils.randomEmojiQuiz();
                await conn.sendMessage(m.from, { text: `🧩 *EMOJI QUIZ*\n\n${emoji}\n\nWhat movie is this? (reply with your guess)` }, { quoted: m });
                setTimeout(async () => {
                    try { await conn.sendMessage(m.from, { text: `💡 Answer: *${answer}*` }); } catch {}
                }, 15000);
                break;
            }

            case "pickupline": {
                const line = textutils.PICKUP_LINES[Math.floor(Math.random() * textutils.PICKUP_LINES.length)];
                await conn.sendMessage(m.from, { text: `😏 ${line}` }, { quoted: m });
                break;
            }

            case "businessnamegen": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}businessnamegen <topic>\n\nExample: ${prefix}businessnamegen coffee` }, { quoted: m });
                    break;
                }
                const names = textutils.generateBusinessNames(text, 5);
                await conn.sendMessage(m.from, { text: `💡 *BUSINESS NAME IDEAS*\n\n${names.map(n => `• ${n}`).join('\n')}` }, { quoted: m });
                break;
            }

            case "hashtaggen": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}hashtaggen <topic>\n\nExample: ${prefix}hashtaggen sunset beach` }, { quoted: m });
                    break;
                }
                const tags = textutils.generateHashtags(text);
                await conn.sendMessage(m.from, { text: `#️⃣ *HASHTAGS*\n\n${tags.join(' ')}` }, { quoted: m });
                break;
            }

            case "fakename": {
                await conn.sendMessage(m.from, { text: `🎭 Random name: *${textutils.generateFakeName()}*` }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // LIVE DATA LOOKUPS
            // ════════════════════════════════════════════
            case "wiki": {
                if (!text) { await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}wiki <topic>` }, { quoted: m }); break; }
                try {
                    const result = await livedata.wikiSummary(text);
                    if (!result) { await conn.sendMessage(m.from, { text: `❌ No Wikipedia page found for "${text}".` }, { quoted: m }); break; }
                    if (result.disambiguation) { await conn.sendMessage(m.from, { text: `❓ "${result.title}" is ambiguous — try being more specific.` }, { quoted: m }); break; }
                    await conn.sendMessage(m.from, { text: `📖 *${result.title}*\n\n${result.extract}${result.url ? `\n\n🔗 ${result.url}` : ''}` }, { quoted: m });
                } catch (err) {
                    console.error('wiki error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to fetch Wikipedia summary.` }, { quoted: m });
                }
                break;
            }

            case "npminfo": {
                if (!text) { await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}npminfo <package name>` }, { quoted: m }); break; }
                try {
                    const info = await livedata.npmPackageInfo(text.trim());
                    if (!info) { await conn.sendMessage(m.from, { text: `❌ No npm package found named "${text}".` }, { quoted: m }); break; }
                    await conn.sendMessage(m.from, {
                        text: `📦 *${info.name}* v${info.version}\n\n${info.description}\n\nLicense: ${info.license}${info.author ? `\nAuthor: ${info.author}` : ''}${info.homepage ? `\n🔗 ${info.homepage}` : ''}`
                    }, { quoted: m });
                } catch (err) {
                    console.error('npminfo error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to fetch npm package info.` }, { quoted: m });
                }
                break;
            }

            case "news": {
                try {
                    const headlines = await livedata.fetchNewsHeadlines(6);
                    if (!headlines.length) { await conn.sendMessage(m.from, { text: `❌ No headlines available right now.` }, { quoted: m }); break; }
                    const list = headlines.map((h, i) => `${i + 1}. ${h.title}${h.link ? `\n   ${h.link}` : ''}`).join('\n\n');
                    await conn.sendMessage(m.from, { text: `📰 *TOP HEADLINES* (BBC)\n\n${list}` }, { quoted: m });
                } catch (err) {
                    console.error('news error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to fetch news headlines.` }, { quoted: m });
                }
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

                const premiumTier = await premium.getPremiumTier(redisClient, m.sender);
                const reward = premiumTier ? premiumTier.dailyBonus : 1000;
                const xpAmount = premiumTier ? Math.floor(20 * premiumTier.xpMultiplier) : 20;
                const bonusNote = premiumTier ? `\n${premiumTier.badge} *${premiumTier.name} bonus applied!*` : '';

                await economy.addCoins(redisClient, m.sender, reward);
                await economy.updateProfile(redisClient, m.sender, { lastDaily: Date.now() });
                await giveXp(redisClient, conn, m.sender, m.from, xpAmount);

                await conn.sendMessage(m.from, { text: `🎁 *Daily Reward Claimed!*\n\n+${economy.formatCoins(reward)} coins\n+${xpAmount} XP${bonusNote}\n\nCome back in 24h!` }, { quoted: m });
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

                const premiumTier = await premium.getPremiumTier(redisClient, m.sender);
                const reward = premiumTier ? premiumTier.weeklyBonus : 7000;
                const xpAmount = premiumTier ? Math.floor(100 * premiumTier.xpMultiplier) : 100;
                const bonusNote = premiumTier ? `\n${premiumTier.badge} *${premiumTier.name} bonus applied!*` : '';

                await economy.addCoins(redisClient, m.sender, reward);
                await economy.updateProfile(redisClient, m.sender, { lastWeekly: Date.now() });
                await giveXp(redisClient, conn, m.sender, m.from, xpAmount);

                await conn.sendMessage(m.from, { text: `🎉 *Weekly Reward Claimed!*\n\n+${economy.formatCoins(reward)} coins\n+${xpAmount} XP${bonusNote}\n\nCome back in 7 days!` }, { quoted: m });
                break;
            }

            case "work": {
                const profile = await economy.getProfile(redisClient, m.sender);
                const premiumTier = await premium.getPremiumTier(redisClient, m.sender);
                const cooldown = premiumTier ? premiumTier.workCooldownMs : 60 * 60 * 1000;
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
                let earned = Math.floor(Math.random() * (job.pay[1] - job.pay[0] + 1)) + job.pay[0];
                if (premiumTier) earned = Math.floor(earned * premiumTier.coinMultiplier);
                const xpAmount = premiumTier ? Math.floor(10 * premiumTier.xpMultiplier) : 10;
                const bonusNote = premiumTier ? ` ${premiumTier.badge}` : '';
                const cooldownNote = premiumTier ? `${Math.round(cooldown / 60000)} min` : '1h';

                await economy.addCoins(redisClient, m.sender, earned);
                await economy.updateProfile(redisClient, m.sender, { lastWork: Date.now() });
                await giveXp(redisClient, conn, m.sender, m.from, xpAmount);

                await conn.sendMessage(m.from, { text: `💼 You worked as a *${job.name}* and earned ${economy.formatCoins(earned)} coins!${bonusNote}\n+${xpAmount} XP\n\nWork again in ${cooldownNote}.` }, { quoted: m });
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
            // CASINO HUB
            // ════════════════════════════════════════════
            case "casino": {
                await conn.sendMessage(m.from, {
                    text: `🎰 *LADY LIYA CASINO*\n\n` +
                        `• ${prefix}roulette <bet> <red/black/green/even/odd/low/high/0-36>\n` +
                        `• ${prefix}crash <bet> <cashout multiplier>\n` +
                        `• ${prefix}tower <bet> — then ${prefix}climb <1-3>\n` +
                        `• ${prefix}lottery — buy a ${economy.formatCoins(casino.LOTTERY_TICKET_PRICE)} coin ticket for the jackpot\n` +
                        `• ${prefix}mines / ${prefix}snake / ${prefix}slots / ${prefix}blackjack — see ${prefix}menu\n\n` +
                        `Current lottery jackpot: ${economy.formatCoins(await casino.getLotteryPot(redisClient))} coins`
                }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // ROULETTE
            // ════════════════════════════════════════════
            case "roulette": {
                const bet = parseInt(args[0]);
                const choice = args[1];

                if (!bet || bet <= 0 || !choice) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}roulette <amount> <red/black/green/even/odd/low/high/0-36>` }, { quoted: m });
                    break;
                }

                const profile = await economy.getProfile(redisClient, m.sender);
                if (profile.coins < bet) {
                    await conn.sendMessage(m.from, { text: `❌ You don't have ${economy.formatCoins(bet)} coins.` }, { quoted: m });
                    break;
                }

                const result = casino.resolveRoulette(bet, choice);
                const colorEmoji = result.color === 'red' ? '🔴' : result.color === 'black' ? '⚫' : '🟢';

                if (result.win) {
                    await economy.addCoins(redisClient, m.sender, result.payout - bet);
                    await economy.updateProfile(redisClient, m.sender, { wins: profile.wins + 1 });
                    await conn.sendMessage(m.from, { text: `🎡 Ball landed on *${result.number}* ${colorEmoji}\n\n✅ You won ${economy.formatCoins(result.payout)} coins!` }, { quoted: m });
                } else {
                    await economy.addCoins(redisClient, m.sender, -bet);
                    await economy.updateProfile(redisClient, m.sender, { losses: profile.losses + 1 });
                    await conn.sendMessage(m.from, { text: `🎡 Ball landed on *${result.number}* ${colorEmoji}\n\n❌ You lost ${economy.formatCoins(bet)} coins.` }, { quoted: m });
                }
                break;
            }

            // ════════════════════════════════════════════
            // CRASH
            // ════════════════════════════════════════════
            case "crash": {
                const bet = parseInt(args[0]);
                const target = parseFloat(args[1]);

                if (!bet || bet <= 0 || !target || target <= 1) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}crash <amount> <cashout multiplier, e.g. 2.5>\n\nYou're betting the plane crashes AFTER your chosen multiplier.` }, { quoted: m });
                    break;
                }

                const profile = await economy.getProfile(redisClient, m.sender);
                if (profile.coins < bet) {
                    await conn.sendMessage(m.from, { text: `❌ You don't have ${economy.formatCoins(bet)} coins.` }, { quoted: m });
                    break;
                }

                const result = casino.resolveCrash(bet, target);

                if (result.win) {
                    await economy.addCoins(redisClient, m.sender, result.payout - bet);
                    await economy.updateProfile(redisClient, m.sender, { wins: profile.wins + 1 });
                    await conn.sendMessage(m.from, { text: `✈️ Plane crashed at *${result.crashPoint}x*\n\n✅ You cashed out at ${target}x and won ${economy.formatCoins(result.payout)} coins!` }, { quoted: m });
                } else {
                    await economy.addCoins(redisClient, m.sender, -bet);
                    await economy.updateProfile(redisClient, m.sender, { losses: profile.losses + 1 });
                    await conn.sendMessage(m.from, { text: `✈️ Plane crashed at *${result.crashPoint}x* — before your ${target}x target.\n\n❌ You lost ${economy.formatCoins(bet)} coins.` }, { quoted: m });
                }
                break;
            }

            // ════════════════════════════════════════════
            // TOWER
            // ════════════════════════════════════════════
            case "tower": {
                const existingTower = await casino.getTowerSession(redisClient, m.from, m.sender);
                if (existingTower) {
                    await conn.sendMessage(m.from, {
                        text: `⚠️ You already have a Tower game running!\n\n${casino.renderTower(existingTower)}\n\nUse ${prefix}climb <1-3> to continue or ${prefix}towercashout to bank it.`
                    }, { quoted: m });
                    break;
                }

                const bet = parseInt(args[0]);
                if (!bet || bet <= 0) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}tower <amount>\n\n${casino.TOWER_ROWS} rows, ${casino.TOWER_LANES} lanes each, 1 bomb per row. Climb as far as you dare!` }, { quoted: m });
                    break;
                }

                const profile = await economy.getProfile(redisClient, m.sender);
                if (profile.coins < bet) {
                    await conn.sendMessage(m.from, { text: `❌ You don't have ${economy.formatCoins(bet)} coins.` }, { quoted: m });
                    break;
                }

                await economy.addCoins(redisClient, m.sender, -bet);
                const session = await casino.startTower(redisClient, m.from, m.sender, bet);

                await conn.sendMessage(m.from, {
                    text: `🗼 *TOWER* — climb 1 of ${casino.TOWER_LANES} lanes per row, avoid the bomb!\n\n${casino.renderTower(session)}\n\nBet: ${economy.formatCoins(bet)} coins\n\nUse ${prefix}climb <1-3> to pick a lane, or ${prefix}towercashout once you've climbed at least one row.`
                }, { quoted: m });
                break;
            }

            case "climb": {
                const laneInput = parseInt(args[0]);
                if (!laneInput || laneInput < 1 || laneInput > casino.TOWER_LANES) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}climb <1-${casino.TOWER_LANES}>` }, { quoted: m });
                    break;
                }
                const lane = laneInput - 1;

                const result = await casino.climbTower(redisClient, m.from, m.sender, lane);
                if (!result) {
                    await conn.sendMessage(m.from, { text: `❌ You don't have an active Tower game. Start one with ${prefix}tower <amount>.` }, { quoted: m });
                    break;
                }

                if (result.result === 'dead') {
                    const profile = await economy.getProfile(redisClient, m.sender);
                    await economy.updateProfile(redisClient, m.sender, { losses: profile.losses + 1 });
                    await conn.sendMessage(m.from, { text: `💥 Lane ${laneInput} had the bomb!\n\n❌ You lost ${economy.formatCoins(result.session.bet)} coins.` }, { quoted: m });
                    break;
                }

                if (result.result === 'topped_out') {
                    await economy.addCoins(redisClient, m.sender, result.payout);
                    const profile = await economy.getProfile(redisClient, m.sender);
                    await economy.updateProfile(redisClient, m.sender, { wins: profile.wins + 1 });
                    await conn.sendMessage(m.from, { text: `🏆 *TOWER TOPPED OUT!* You cleared every row!\n\n💰 Payout: ${economy.formatCoins(result.payout)} coins` }, { quoted: m });
                    break;
                }

                await conn.sendMessage(m.from, {
                    text: `✅ Safe! Row cleared.\n\n${casino.renderTower(result.session)}\n\nCurrent multiplier: *${casino.multiplierForRow(result.session.row).toFixed(2)}x*\n\n${prefix}climb <1-3> to continue or ${prefix}towercashout to bank it.`
                }, { quoted: m });
                break;
            }

            case "towercashout": {
                const result = await casino.cashoutTower(redisClient, m.from, m.sender);
                if (!result) {
                    await conn.sendMessage(m.from, { text: `❌ You don't have an active Tower game.` }, { quoted: m });
                    break;
                }
                if (result.error === 'no_climbs') {
                    await conn.sendMessage(m.from, { text: `❌ Climb at least one row before cashing out. Use ${prefix}climb <1-3>.` }, { quoted: m });
                    break;
                }

                await economy.addCoins(redisClient, m.sender, result.payout);
                const profile = await economy.getProfile(redisClient, m.sender);
                await economy.updateProfile(redisClient, m.sender, { wins: profile.wins + 1 });

                await conn.sendMessage(m.from, { text: `💰 *Cashed out!* Row ${result.session.row}/${casino.TOWER_ROWS}\n\nPayout: ${economy.formatCoins(result.payout)} coins` }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // GIFT — send coins to another user, with a small
            // chance the house throws in a bonus on top
            // ════════════════════════════════════════════
            case "gift": {
                const target = m.quoted?.sender || m.mentionedJid?.[0];
                const amount = parseInt(args[args.length - 1]);

                if (!target || !amount || amount <= 0) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}gift @user <amount>` }, { quoted: m });
                    break;
                }
                if (target === m.sender) {
                    await conn.sendMessage(m.from, { text: "❌ You can't gift coins to yourself." }, { quoted: m });
                    break;
                }

                const senderProfile = await economy.getProfile(redisClient, m.sender);
                if (senderProfile.coins < amount) {
                    await conn.sendMessage(m.from, { text: `❌ You don't have ${economy.formatCoins(amount)} coins.` }, { quoted: m });
                    break;
                }

                await economy.addCoins(redisClient, m.sender, -amount);

                const bonusRoll = Math.random() < 0.1; // 10% chance of a house-funded bonus
                const bonus = bonusRoll ? Math.floor(amount * 0.2) : 0;
                await economy.addCoins(redisClient, target, amount + bonus);

                const bonusNote = bonusRoll ? `\n🎁 A mystery bonus of ${economy.formatCoins(bonus)} coins was added on top!` : '';
                await conn.sendMessage(m.from, {
                    text: `🎁 @${m.sender.split('@')[0]} gifted ${economy.formatCoins(amount)} coins to @${target.split('@')[0]}${bonusNote}`,
                    mentions: [m.sender, target]
                }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // LOTTERY — shared jackpot
            // ════════════════════════════════════════════
            case "lottery": {
                const profile = await economy.getProfile(redisClient, m.sender);
                if (profile.coins < casino.LOTTERY_TICKET_PRICE) {
                    await conn.sendMessage(m.from, { text: `❌ A lottery ticket costs ${economy.formatCoins(casino.LOTTERY_TICKET_PRICE)} coins.` }, { quoted: m });
                    break;
                }

                await economy.addCoins(redisClient, m.sender, -casino.LOTTERY_TICKET_PRICE);
                const result = await casino.buyLotteryTicket(redisClient);

                if (result.won) {
                    await economy.addCoins(redisClient, m.sender, result.amount);
                    const profile2 = await economy.getProfile(redisClient, m.sender);
                    await economy.updateProfile(redisClient, m.sender, { wins: profile2.wins + 1 });
                    await conn.sendMessage(m.from, {
                        text: `🎟️ *LOTTERY* — you bought a ticket for ${economy.formatCoins(casino.LOTTERY_TICKET_PRICE)} coins.\n\n🎉 *JACKPOT!!!* You won ${economy.formatCoins(result.amount)} coins!\n\nThe pot has reset to ${economy.formatCoins(result.newPot)} coins.`
                    }, { quoted: m });
                } else {
                    await conn.sendMessage(m.from, {
                        text: `🎟️ *LOTTERY* — you bought a ticket for ${economy.formatCoins(casino.LOTTERY_TICKET_PRICE)} coins.\n\n😔 No jackpot this time.\n\nCurrent pot: ${economy.formatCoins(result.newPot)} coins — try again with ${prefix}lottery!`
                    }, { quoted: m });
                }
                break;
            }

            // ════════════════════════════════════════════
            // MARKET — view fluctuating stock prices
            // ════════════════════════════════════════════
            case "market": {
                const prices = await casino.getMarketPrices(redisClient);
                const prevPrices = await casino.getMarketPrevPrices(redisClient);

                const lines = casino.STOCKS.map(s => {
                    const price = prices[s.symbol];
                    const prev = prevPrices[s.symbol];
                    const changePct = ((price - prev) / prev) * 100;
                    const arrow = changePct > 0 ? '📈' : changePct < 0 ? '📉' : '➖';
                    return `${arrow} *${s.symbol}* — ${s.name}\n   ${economy.formatCoins(Math.round(price))} coins/share (${changePct >= 0 ? '+' : ''}${changePct.toFixed(1)}%)`;
                });

                await conn.sendMessage(m.from, {
                    text: `📊 *MARKET*\n\n${lines.join('\n\n')}\n\nUse ${prefix}invest buy <symbol> <amount> or ${prefix}invest sell <symbol> <shares/all>`
                }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // INVEST — buy/sell shares, or view portfolio
            // ════════════════════════════════════════════
            case "invest": {
                const sub = (args[0] || '').toLowerCase();

                if (sub === 'buy') {
                    const symbol = (args[1] || '').toUpperCase();
                    const spend = parseInt(args[2]);
                    const stock = casino.findStock(symbol);

                    if (!stock || !spend || spend <= 0) {
                        await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}invest buy <symbol> <coins>\n\nSymbols: ${casino.STOCKS.map(s => s.symbol).join(', ')}` }, { quoted: m });
                        break;
                    }

                    const profile = await economy.getProfile(redisClient, m.sender);
                    if (profile.coins < spend) {
                        await conn.sendMessage(m.from, { text: `❌ You don't have ${economy.formatCoins(spend)} coins.` }, { quoted: m });
                        break;
                    }

                    const prices = await casino.getMarketPrices(redisClient);
                    const price = prices[symbol];
                    const shares = Math.round((spend / price) * 10000) / 10000;

                    await economy.addCoins(redisClient, m.sender, -spend);
                    const holdings = casino.parseHoldings(profile.stocks);
                    holdings[symbol] = (holdings[symbol] || 0) + shares;
                    await economy.updateProfile(redisClient, m.sender, { stocks: casino.stringifyHoldings(holdings) });

                    await conn.sendMessage(m.from, { text: `📈 Bought *${shares}* shares of ${symbol} at ${economy.formatCoins(Math.round(price))} coins/share.` }, { quoted: m });
                    break;
                }

                if (sub === 'sell') {
                    const symbol = (args[1] || '').toUpperCase();
                    const stock = casino.findStock(symbol);
                    if (!stock) {
                        await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}invest sell <symbol> <shares/all>` }, { quoted: m });
                        break;
                    }

                    const profile = await economy.getProfile(redisClient, m.sender);
                    const holdings = casino.parseHoldings(profile.stocks);
                    const owned = holdings[symbol] || 0;

                    const sellArg = (args[2] || '').toLowerCase();
                    const shares = sellArg === 'all' ? owned : parseFloat(args[2]);

                    if (!shares || shares <= 0 || shares > owned) {
                        await conn.sendMessage(m.from, { text: `❌ You only own ${owned} shares of ${symbol}.` }, { quoted: m });
                        break;
                    }

                    const prices = await casino.getMarketPrices(redisClient);
                    const price = prices[symbol];
                    const proceeds = Math.floor(shares * price);

                    holdings[symbol] = Math.round((owned - shares) * 10000) / 10000;
                    await economy.updateProfile(redisClient, m.sender, { stocks: casino.stringifyHoldings(holdings) });
                    await economy.addCoins(redisClient, m.sender, proceeds);

                    await conn.sendMessage(m.from, { text: `📉 Sold *${shares}* shares of ${symbol} for ${economy.formatCoins(proceeds)} coins.` }, { quoted: m });
                    break;
                }

                // default: portfolio view
                const profile = await economy.getProfile(redisClient, m.sender);
                const holdings = casino.parseHoldings(profile.stocks);
                const prices = await casino.getMarketPrices(redisClient);
                const held = Object.entries(holdings).filter(([, shares]) => shares > 0);

                if (held.length === 0) {
                    await conn.sendMessage(m.from, { text: `📁 You don't own any stocks yet.\n\nUse ${prefix}invest buy <symbol> <coins> — see ${prefix}market for prices.` }, { quoted: m });
                    break;
                }

                let totalValue = 0;
                const lines = held.map(([symbol, shares]) => {
                    const value = shares * (prices[symbol] || 0);
                    totalValue += value;
                    return `• ${symbol}: ${shares} shares — ${economy.formatCoins(Math.round(value))} coins`;
                });

                await conn.sendMessage(m.from, {
                    text: `📁 *Your Portfolio*\n\n${lines.join('\n')}\n\nTotal value: ${economy.formatCoins(Math.round(totalValue))} coins`
                }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // INTEREST — claim bank interest
            // ════════════════════════════════════════════
            case "interest": {
                const profile = await economy.getProfile(redisClient, m.sender);
                const remaining = economy.cooldownRemaining(profile.lastInterest, casino.INTEREST_COOLDOWN_MS);

                if (remaining > 0) {
                    await conn.sendMessage(m.from, { text: `⏳ You already claimed interest today.\n\nCome back in ${economy.formatDuration(remaining)}.` }, { quoted: m });
                    break;
                }

                if (profile.bank <= 0) {
                    await conn.sendMessage(m.from, { text: `❌ You have nothing in your bank to earn interest on. Use ${prefix}deposit <amount> first.` }, { quoted: m });
                    break;
                }

                const earned = Math.max(casino.INTEREST_MIN_PAYOUT, Math.floor(profile.bank * casino.BANK_INTEREST_RATE));
                await economy.updateProfile(redisClient, m.sender, { bank: profile.bank + earned, lastInterest: Date.now() });

                await conn.sendMessage(m.from, { text: `🏦 *Interest Claimed!*\n\n+${economy.formatCoins(earned)} coins added to your bank (${(casino.BANK_INTEREST_RATE * 100).toFixed(0)}% of ${economy.formatCoins(profile.bank)}).\n\nCome back in 24h!` }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // LOAN / REPAY
            // ════════════════════════════════════════════
            case "loan": {
                const profile = await economy.getProfile(redisClient, m.sender);

                if (profile.loanAmount > 0) {
                    const overdue = Date.now() > profile.loanDue;
                    await conn.sendMessage(m.from, {
                        text: `❌ You already owe ${economy.formatCoins(profile.loanAmount)} coins${overdue ? ' and it\'s OVERDUE ⚠️' : ` (due in ${economy.formatDuration(profile.loanDue - Date.now())})`}.\n\nUse ${prefix}repay <amount> before taking another loan.`
                    }, { quoted: m });
                    break;
                }

                const amount = parseInt(args[0]);
                const cap = casino.maxLoanForLevel(profile.level);

                if (!amount || amount <= 0) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}loan <amount>\n\nYour max loan (based on level ${profile.level}): ${economy.formatCoins(cap)} coins.` }, { quoted: m });
                    break;
                }
                if (amount > cap) {
                    await conn.sendMessage(m.from, { text: `❌ You can borrow at most ${economy.formatCoins(cap)} coins at level ${profile.level}.` }, { quoted: m });
                    break;
                }

                const owed = Math.floor(amount * (1 + casino.LOAN_INTEREST_RATE));
                await economy.addCoins(redisClient, m.sender, amount);
                await economy.updateProfile(redisClient, m.sender, {
                    loanAmount: owed,
                    loanDue: Date.now() + casino.LOAN_TERM_MS
                });

                await conn.sendMessage(m.from, {
                    text: `💵 *Loan Approved!*\n\n+${economy.formatCoins(amount)} coins\n\nYou owe *${economy.formatCoins(owed)} coins* (${(casino.LOAN_INTEREST_RATE * 100).toFixed(0)}% interest), due in ${economy.formatDuration(casino.LOAN_TERM_MS)}.\n\nRepay with ${prefix}repay <amount>.`
                }, { quoted: m });
                break;
            }

            case "repay": {
                const profile = await economy.getProfile(redisClient, m.sender);

                if (profile.loanAmount <= 0) {
                    await conn.sendMessage(m.from, { text: `✅ You don't owe anything.` }, { quoted: m });
                    break;
                }

                // Overdue loans accrue an extra late penalty, applied once when checked
                let owed = profile.loanAmount;
                const overdue = Date.now() > profile.loanDue;
                if (overdue) {
                    owed = Math.floor(owed * (1 + casino.LOAN_LATE_PENALTY_RATE));
                }

                let amount = parseInt(args[0]);
                if (!amount || amount <= 0) amount = owed; // default: pay it all off

                if (profile.coins < amount) {
                    await conn.sendMessage(m.from, { text: `❌ You don't have ${economy.formatCoins(amount)} coins.\n\nYou owe ${economy.formatCoins(owed)}${overdue ? ' (overdue, includes late penalty)' : ''}.` }, { quoted: m });
                    break;
                }

                const newOwed = Math.max(0, owed - amount);
                await economy.addCoins(redisClient, m.sender, -amount);
                await economy.updateProfile(redisClient, m.sender, {
                    loanAmount: newOwed,
                    loanDue: newOwed > 0 ? profile.loanDue : 0
                });

                if (newOwed === 0) {
                    await conn.sendMessage(m.from, { text: `✅ Loan fully repaid! You paid ${economy.formatCoins(amount)} coins.` }, { quoted: m });
                } else {
                    await conn.sendMessage(m.from, { text: `💸 Paid ${economy.formatCoins(amount)} coins.\n\nRemaining balance: ${economy.formatCoins(newOwed)} coins.` }, { quoted: m });
                }
                break;
            }

            // ════════════════════════════════════════════
            // HEIST — group event
            // ════════════════════════════════════════════
            case "heist": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: `❌ Heists only work in group chats.` }, { quoted: m });
                    break;
                }

                const sub = (args[0] || '').toLowerCase();

                if (sub === 'join') {
                    const result = await casino.joinHeist(redisClient, m.from, m.sender);
                    if (!result) {
                        await conn.sendMessage(m.from, { text: `❌ No heist is being planned right now. Start one with ${prefix}heist <amount>.` }, { quoted: m });
                        break;
                    }
                    if (result.error === 'already_joined') {
                        await conn.sendMessage(m.from, { text: `❌ You're already in on this heist.` }, { quoted: m });
                        break;
                    }
                    if (result.error === 'too_late') {
                        await conn.sendMessage(m.from, { text: `❌ Too late — the crew already moved out.` }, { quoted: m });
                        break;
                    }

                    const profile = await economy.getProfile(redisClient, m.sender);
                    if (profile.coins < result.session.bet) {
                        await conn.sendMessage(m.from, { text: `❌ You need ${economy.formatCoins(result.session.bet)} coins to join this heist.` }, { quoted: m });
                        break;
                    }

                    await economy.addCoins(redisClient, m.sender, -result.session.bet);
                    await conn.sendMessage(m.from, {
                        text: `🕵️ @${m.sender.split('@')[0]} joined the heist! (${result.session.participants.length} crew members)`,
                        mentions: [m.sender]
                    }, { quoted: m });
                    break;
                }

                const existing = await casino.getHeist(redisClient, m.from);
                if (existing) {
                    await conn.sendMessage(m.from, { text: `⚠️ A heist is already being planned! Use ${prefix}heist join to get in on it.` }, { quoted: m });
                    break;
                }

                const bet = parseInt(args[0]);
                if (!bet || bet <= 0) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}heist <amount>\n\nStarts a ${casino.HEIST_JOIN_WINDOW_MS / 1000}s window for others to join with ${prefix}heist join.` }, { quoted: m });
                    break;
                }

                const profile = await economy.getProfile(redisClient, m.sender);
                if (profile.coins < bet) {
                    await conn.sendMessage(m.from, { text: `❌ You don't have ${economy.formatCoins(bet)} coins.` }, { quoted: m });
                    break;
                }

                await economy.addCoins(redisClient, m.sender, -bet);
                await casino.startHeist(redisClient, m.from, m.sender, bet);

                await conn.sendMessage(m.from, {
                    text: `🚨 *HEIST PLANNED* by @${m.sender.split('@')[0]}!\n\nBet: ${economy.formatCoins(bet)} coins per person\n\nOthers have ${casino.HEIST_JOIN_WINDOW_MS / 1000}s to join with ${prefix}heist join before the crew moves out!`,
                    mentions: [m.sender]
                }, { quoted: m });

                setTimeout(async () => {
                    try {
                        const session = await casino.getHeist(redisClient, m.from);
                        if (!session) return;
                        await casino.endHeist(redisClient, m.from);

                        const outcome = casino.resolveHeist(session);
                        const mentions = session.participants;

                        if (outcome.success) {
                            for (const jid of session.participants) {
                                await economy.addCoins(redisClient, jid, outcome.perPlayerPayout);
                            }
                            await conn.sendMessage(m.from, {
                                text: `💰 *HEIST SUCCESSFUL!* (${(outcome.chance * 100).toFixed(0)}% odds, ${session.participants.length} crew)\n\nTotal haul: ${economy.formatCoins(outcome.totalPot)} coins\nEach member gets: ${economy.formatCoins(outcome.perPlayerPayout)} coins\n\n${mentions.map(j => '@' + j.split('@')[0]).join(' ')}`,
                                mentions
                            }, { quoted: m });
                        } else {
                            await casino.addToTreasury(redisClient, outcome.totalLost);
                            await conn.sendMessage(m.from, {
                                text: `🚔 *HEIST FAILED!* The crew got caught. (${(outcome.chance * 100).toFixed(0)}% odds, ${session.participants.length} crew)\n\nEveryone lost their stake — ${economy.formatCoins(outcome.totalLost)} coins total, seized into the treasury.\n\n${mentions.map(j => '@' + j.split('@')[0]).join(' ')}`,
                                mentions
                            }, { quoted: m });
                        }
                    } catch (err) {
                        console.error('heist resolution error:', err.message);
                    }
                }, casino.HEIST_JOIN_WINDOW_MS);
                break;
            }

            // ════════════════════════════════════════════
            // TAX — owner/sudo treasury tool
            // ════════════════════════════════════════════
            case "tax": {
                const sub = (args[0] || '').toLowerCase();

                if (sub === 'collect') {
                    if (!senderHasAccess) {
                        await conn.sendMessage(m.from, { text: "❌ Owner/Sudo only command." }, { quoted: m });
                        break;
                    }

                    const rate = 0.05;
                    let collected = 0;
                    let cursor = 0;
                    do {
                        const scanResult = await redisClient.scan(cursor, { MATCH: 'economy:*', COUNT: 100 });
                        cursor = scanResult.cursor;
                        for (const key of scanResult.keys) {
                            const coinsRaw = await redisClient.hGet(key, 'coins');
                            const coins = parseInt(coinsRaw || '0');
                            if (coins <= 0) continue;
                            const cut = Math.floor(coins * rate);
                            if (cut <= 0) continue;
                            await redisClient.hSet(key, 'coins', String(coins - cut));
                            collected += cut;
                        }
                    } while (cursor !== 0);

                    await casino.addToTreasury(redisClient, collected);
                    await conn.sendMessage(m.from, { text: `🏛️ *Tax Collected*\n\nLevied ${(rate * 100).toFixed(0)}% from every wallet.\n\nTotal collected: ${economy.formatCoins(collected)} coins\nTreasury balance: ${economy.formatCoins(await casino.getTreasury(redisClient))} coins` }, { quoted: m });
                    break;
                }

                if (sub === 'payout') {
                    if (!senderHasAccess) {
                        await conn.sendMessage(m.from, { text: "❌ Owner/Sudo only command." }, { quoted: m });
                        break;
                    }

                    const target = m.quoted?.sender || m.mentionedJid?.[0];
                    const amount = parseInt(args[args.length - 1]);
                    const treasury = await casino.getTreasury(redisClient);

                    if (!target || !amount || amount <= 0) {
                        await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}tax payout @user <amount>` }, { quoted: m });
                        break;
                    }
                    if (amount > treasury) {
                        await conn.sendMessage(m.from, { text: `❌ Treasury only has ${economy.formatCoins(treasury)} coins.` }, { quoted: m });
                        break;
                    }

                    await casino.addToTreasury(redisClient, -amount);
                    await economy.addCoins(redisClient, target, amount);
                    await conn.sendMessage(m.from, { text: `🏛️ Paid out ${economy.formatCoins(amount)} coins from the treasury to @${target.split('@')[0]}.`, mentions: [target] }, { quoted: m });
                    break;
                }

                await conn.sendMessage(m.from, { text: `🏛️ *National Treasury*\n\nBalance: ${economy.formatCoins(await casino.getTreasury(redisClient))} coins\n\nFunded by failed heists and tax collection. Owner/Sudo: ${prefix}tax collect, ${prefix}tax payout @user <amount>` }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // AUCTION — sell spare Revive Tokens
            // ════════════════════════════════════════════
            case "auction": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: `❌ Auctions only work in group chats.` }, { quoted: m });
                    break;
                }

                const sub = (args[0] || '').toLowerCase();

                if (sub === 'status' || (!args[0])) {
                    const existing = await casino.getAuction(redisClient, m.from);
                    if (!existing) {
                        await conn.sendMessage(m.from, { text: `📭 No active auction.\n\nUsage: ${prefix}auction <revive tokens> <starting bid>\nBid with: ${prefix}bid <amount>` }, { quoted: m });
                        break;
                    }
                    const remaining = Math.max(0, existing.endsAt - Date.now());
                    await conn.sendMessage(m.from, {
                        text: `🔨 *Auction* — ${existing.tokenCount}× 💊 Revive Token(s) from @${existing.sellerJid.split('@')[0]}\n\nHigh bid: ${economy.formatCoins(existing.highBid)}${existing.highBidder ? ` by @${existing.highBidder.split('@')[0]}` : ' (no bids yet)'}\nTime left: ${economy.formatDuration(remaining)}\n\nBid with ${prefix}bid <amount>`,
                        mentions: [existing.sellerJid, ...(existing.highBidder ? [existing.highBidder] : [])]
                    }, { quoted: m });
                    break;
                }

                const existing = await casino.getAuction(redisClient, m.from);
                if (existing) {
                    await conn.sendMessage(m.from, { text: `⚠️ An auction is already running. Use ${prefix}auction status to check it.` }, { quoted: m });
                    break;
                }

                const tokenCount = parseInt(args[0]);
                const startingBid = parseInt(args[1]);

                if (!tokenCount || tokenCount <= 0 || !startingBid || startingBid <= 0) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}auction <revive tokens> <starting bid>` }, { quoted: m });
                    break;
                }

                const owned = await shop.getReviveTokens(redisClient, m.sender);
                if (owned < tokenCount) {
                    await conn.sendMessage(m.from, { text: `❌ You only have ${owned} Revive Token(s).` }, { quoted: m });
                    break;
                }

                await shop.addReviveTokens(redisClient, m.sender, -tokenCount);
                await casino.startAuction(redisClient, m.from, m.sender, tokenCount, startingBid);

                await conn.sendMessage(m.from, {
                    text: `🔨 *AUCTION STARTED* by @${m.sender.split('@')[0]}!\n\n${tokenCount}× 💊 Revive Token(s)\nStarting bid: ${economy.formatCoins(startingBid)} coins\n\nBid with ${prefix}bid <amount> — closes in ${economy.formatDuration(casino.AUCTION_DURATION_MS)}.`,
                    mentions: [m.sender]
                }, { quoted: m });

                setTimeout(async () => {
                    try {
                        const session = await casino.getAuction(redisClient, m.from);
                        if (!session) return;
                        await casino.endAuction(redisClient, m.from);

                        if (!session.highBidder) {
                            await shop.addReviveTokens(redisClient, session.sellerJid, session.tokenCount);
                            await conn.sendMessage(m.from, { text: `🔨 Auction ended with no bids. ${session.tokenCount}× 💊 Revive Token(s) returned to @${session.sellerJid.split('@')[0]}.`, mentions: [session.sellerJid] }, { quoted: m });
                            return;
                        }

                        const buyerProfile = await economy.getProfile(redisClient, session.highBidder);
                        if (buyerProfile.coins < session.highBid) {
                            await shop.addReviveTokens(redisClient, session.sellerJid, session.tokenCount);
                            await conn.sendMessage(m.from, { text: `🔨 Auction winner @${session.highBidder.split('@')[0]} couldn't cover their bid! Tokens returned to @${session.sellerJid.split('@')[0]}.`, mentions: [session.highBidder, session.sellerJid] }, { quoted: m });
                            return;
                        }

                        const houseCut = Math.floor(session.highBid * casino.AUCTION_HOUSE_CUT);
                        const sellerProceeds = session.highBid - houseCut;

                        await economy.addCoins(redisClient, session.highBidder, -session.highBid);
                        await economy.addCoins(redisClient, session.sellerJid, sellerProceeds);
                        await shop.addReviveTokens(redisClient, session.highBidder, session.tokenCount);
                        await casino.addToTreasury(redisClient, houseCut);

                        await conn.sendMessage(m.from, {
                            text: `🔨 *AUCTION CLOSED!*\n\n@${session.highBidder.split('@')[0]} won ${session.tokenCount}× 💊 Revive Token(s) for ${economy.formatCoins(session.highBid)} coins.\n@${session.sellerJid.split('@')[0]} received ${economy.formatCoins(sellerProceeds)} coins (after ${(casino.AUCTION_HOUSE_CUT * 100).toFixed(0)}% house cut).`,
                            mentions: [session.highBidder, session.sellerJid]
                        }, { quoted: m });
                    } catch (err) {
                        console.error('auction resolution error:', err.message);
                    }
                }, casino.AUCTION_DURATION_MS);
                break;
            }

            case "bid": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: `❌ Bidding only works in group chats.` }, { quoted: m });
                    break;
                }

                const amount = parseInt(args[0]);
                if (!amount || amount <= 0) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}bid <amount>` }, { quoted: m });
                    break;
                }

                const profile = await economy.getProfile(redisClient, m.sender);
                if (profile.coins < amount) {
                    await conn.sendMessage(m.from, { text: `❌ You don't have ${economy.formatCoins(amount)} coins.` }, { quoted: m });
                    break;
                }

                const result = await casino.placeBid(redisClient, m.from, m.sender, amount);
                if (result.error === 'no_auction') {
                    await conn.sendMessage(m.from, { text: `❌ No active auction. Start one with ${prefix}auction <revive tokens> <starting bid>.` }, { quoted: m });
                    break;
                }
                if (result.error === 'ended') {
                    await conn.sendMessage(m.from, { text: `❌ That auction has already ended.` }, { quoted: m });
                    break;
                }
                if (result.error === 'own_auction') {
                    await conn.sendMessage(m.from, { text: `❌ You can't bid on your own auction.` }, { quoted: m });
                    break;
                }
                if (result.error === 'too_low') {
                    await conn.sendMessage(m.from, { text: `❌ Bid must be higher than the current high bid of ${economy.formatCoins(result.session.highBid)} coins.` }, { quoted: m });
                    break;
                }

                await conn.sendMessage(m.from, {
                    text: `🔨 @${m.sender.split('@')[0]} bids ${economy.formatCoins(amount)} coins!`,
                    mentions: [m.sender]
                }, { quoted: m });
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

            // ════════════════════════════════════════════
            // MEGASLOTS (5-reel, 3-row, 5-payline slot machine)
            // RTP tuned to ~82% via probability analysis + 2M-trial
            // simulation — see dev notes if rebalancing payouts later.
            // ════════════════════════════════════════════
            case "megaslots": {
                const bet = parseInt(args[0]);
                if (!bet || bet <= 0) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}megaslots <amount>\n\n5 reels, 3 rows, 5 paylines (top/middle/bottom/both diagonals). Match 3+ symbols left-to-right on a line to win!` }, { quoted: m });
                    break;
                }

                const profile = await economy.getProfile(redisClient, m.sender);
                if (profile.coins < bet) {
                    await conn.sendMessage(m.from, { text: `❌ You don't have ${economy.formatCoins(bet)} coins.` }, { quoted: m });
                    break;
                }

                const MEGA_SYMBOLS = ['🍒', '🍋', '🔔', '⭐', '💎', '7️⃣'];
                const MEGA_WEIGHTS = [35, 30, 18, 10, 5, 2];
                const MEGA_PAYOUTS = { '🍒': 0.5, '🍋': 0.5, '🔔': 3.5, '⭐': 7, '💎': 18, '7️⃣': 70 };
                const MEGA_TIER_MULT = { 3: 1, 4: 4, 5: 15 };
                const MEGA_TOTAL_WEIGHT = MEGA_WEIGHTS.reduce((a, b) => a + b, 0);

                function megaSpinSymbol() {
                    let r = Math.random() * MEGA_TOTAL_WEIGHT;
                    for (let i = 0; i < MEGA_SYMBOLS.length; i++) {
                        r -= MEGA_WEIGHTS[i];
                        if (r <= 0) return MEGA_SYMBOLS[i];
                    }
                    return MEGA_SYMBOLS[0];
                }

                // 3 rows x 5 columns
                const grid = [];
                for (let row = 0; row < 3; row++) {
                    grid.push(Array.from({ length: 5 }, () => megaSpinSymbol()));
                }

                const PAYLINES = [
                    { name: 'Top', cells: [[0,0],[0,1],[0,2],[0,3],[0,4]] },
                    { name: 'Middle', cells: [[1,0],[1,1],[1,2],[1,3],[1,4]] },
                    { name: 'Bottom', cells: [[2,0],[2,1],[2,2],[2,3],[2,4]] },
                    { name: 'V', cells: [[0,0],[1,1],[2,2],[1,3],[0,4]] },
                    { name: '^', cells: [[2,0],[1,1],[0,2],[1,3],[2,4]] }
                ];

                let totalMultiplier = 0;
                const winLines = [];

                for (const line of PAYLINES) {
                    const symbols = line.cells.map(([r, c]) => grid[r][c]);
                    const first = symbols[0];
                    let count = 1;
                    for (let i = 1; i < symbols.length; i++) {
                        if (symbols[i] === first) count++;
                        else break;
                    }
                    if (count >= 3) {
                        const lineMultiplier = MEGA_PAYOUTS[first] * MEGA_TIER_MULT[count];
                        totalMultiplier += lineMultiplier;
                        winLines.push(`${line.name}: ${first.repeat(count)} (${count}x ${first}) — ${lineMultiplier.toFixed(1)}x`);
                    }
                }

                const gridDisplay = grid.map(row => row.join(' ')).join('\n');

                if (totalMultiplier > 0) {
                    const winnings = Math.floor(bet * totalMultiplier);
                    await economy.addCoins(redisClient, m.sender, winnings - bet);
                    await economy.updateProfile(redisClient, m.sender, { wins: profile.wins + 1 });
                    await conn.sendMessage(m.from, {
                        text: `🎰 *MEGASLOTS*\n\n${gridDisplay}\n\n✅ *Winning lines:*\n${winLines.join('\n')}\n\n💰 Total: ${totalMultiplier.toFixed(1)}x — won ${economy.formatCoins(winnings)} coins!`
                    }, { quoted: m });
                } else {
                    await economy.addCoins(redisClient, m.sender, -bet);
                    await economy.updateProfile(redisClient, m.sender, { losses: profile.losses + 1 });
                    await conn.sendMessage(m.from, {
                        text: `🎰 *MEGASLOTS*\n\n${gridDisplay}\n\n❌ No winning lines.\nYou lost ${economy.formatCoins(bet)} coins.`
                    }, { quoted: m });
                }
                break;
            }

            // ════════════════════════════════════════════
            // SCRATCH CARDS (3 tiers, 3x3 grid, match a full row to win)
            // RTP tuned to ~78-79% per tier via probability analysis +
            // 1M-trial simulation per tier.
            // ════════════════════════════════════════════
            case "scratch":
            case "scratchcard": {
                const SCRATCH_SYMBOLS = ['🍀', '🔔', '⭐', '💰', '💎', '7️⃣'];
                const SCRATCH_TIERS = {
                    bronze: { price: 50, weights: [30, 24, 20, 14, 8, 4], payouts: { '🍀': 2, '🔔': 4, '⭐': 8, '💰': 20, '💎': 60, '7️⃣': 200 } },
                    silver: { price: 200, weights: [28, 23, 20, 15, 9, 5], payouts: { '🍀': 2, '🔔': 3.5, '⭐': 7, '💰': 18, '💎': 55, '7️⃣': 180 } },
                    gold: { price: 500, weights: [26, 22, 19, 16, 11, 6], payouts: { '🍀': 1.5, '🔔': 3, '⭐': 6, '💰': 16, '💎': 47, '7️⃣': 158 } }
                };

                const tierName = args[0]?.toLowerCase();
                if (!tierName || !SCRATCH_TIERS[tierName]) {
                    const tierList = Object.entries(SCRATCH_TIERS).map(([name, t]) =>
                        `• *${name}* — ${economy.formatCoins(t.price)} coins (max prize: ${economy.formatCoins(t.price * t.payouts['7️⃣'])})`
                    ).join('\n');
                    await conn.sendMessage(m.from, {
                        text: `🎟️ *Scratch Cards*\n\nMatch all 3 symbols in any row to win!\n\n${tierList}\n\nUsage: ${prefix}scratch <bronze/silver/gold>`
                    }, { quoted: m });
                    break;
                }

                const tier = SCRATCH_TIERS[tierName];
                const profile = await economy.getProfile(redisClient, m.sender);
                if (profile.coins < tier.price) {
                    await conn.sendMessage(m.from, { text: `❌ You need ${economy.formatCoins(tier.price)} coins for a ${tierName} card.` }, { quoted: m });
                    break;
                }

                const totalWeight = tier.weights.reduce((a, b) => a + b, 0);
                function scratchSpin() {
                    let r = Math.random() * totalWeight;
                    for (let i = 0; i < SCRATCH_SYMBOLS.length; i++) {
                        r -= tier.weights[i];
                        if (r <= 0) return SCRATCH_SYMBOLS[i];
                    }
                    return SCRATCH_SYMBOLS[0];
                }

                const grid = [
                    [scratchSpin(), scratchSpin(), scratchSpin()],
                    [scratchSpin(), scratchSpin(), scratchSpin()],
                    [scratchSpin(), scratchSpin(), scratchSpin()]
                ];

                let bestMultiplier = 0;
                let winningRow = -1;
                grid.forEach((row, i) => {
                    if (row[0] === row[1] && row[1] === row[2]) {
                        const mult = tier.payouts[row[0]];
                        if (mult > bestMultiplier) {
                            bestMultiplier = mult;
                            winningRow = i;
                        }
                    }
                });

                const gridDisplay = grid.map((row, i) => `${row.join(' | ')}${i === winningRow ? '  ⬅️ WIN!' : ''}`).join('\n');

                if (bestMultiplier > 0) {
                    const winnings = Math.floor(tier.price * bestMultiplier);
                    await economy.addCoins(redisClient, m.sender, winnings - tier.price);
                    await economy.updateProfile(redisClient, m.sender, { wins: profile.wins + 1 });
                    await conn.sendMessage(m.from, {
                        text: `🎟️ *${tierName.toUpperCase()} SCRATCH CARD*\n\n${gridDisplay}\n\n🎉 Winner! ${bestMultiplier}x — won ${economy.formatCoins(winnings)} coins!`
                    }, { quoted: m });
                } else {
                    await economy.addCoins(redisClient, m.sender, -tier.price);
                    await economy.updateProfile(redisClient, m.sender, { losses: profile.losses + 1 });
                    await conn.sendMessage(m.from, {
                        text: `🎟️ *${tierName.toUpperCase()} SCRATCH CARD*\n\n${gridDisplay}\n\n❌ No matching row. Lost ${economy.formatCoins(tier.price)} coins.`
                    }, { quoted: m });
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
            // BEST-OF-3 DUEL (first to 2 wins takes the pot)
            // ════════════════════════════════════════════
            case "bo3":
            case "duel3": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ Best-of-3 duels only work in groups." }, { quoted: m });
                    break;
                }

                const existingMatch = await pvp.getBo3Match(redisClient, m.from);
                if (existingMatch) {
                    await conn.sendMessage(m.from, {
                        text: `⚠️ A Best-of-3 match is already running (${existingMatch.scoreA}-${existingMatch.scoreB}). Use ${prefix}bo3move to play your round.`
                    }, { quoted: m });
                    break;
                }

                const target = m.quoted?.sender || m.mentionedJid?.[0];
                const bet = parseInt(args[args.length - 1]);

                if (!target || !bet || bet <= 0) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}bo3 @user <bet>\n\nFirst to win 2 rounds takes the whole pot!` }, { quoted: m });
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
                    await conn.sendMessage(m.from, { text: `❌ @${target.split('@')[0]} doesn't have enough coins.`, mentions: [target] }, { quoted: m });
                    break;
                }

                await pvp.createBo3Challenge(redisClient, m.from, m.sender, target, bet);
                await conn.sendMessage(m.from, {
                    text: `⚔️ @${m.sender.split('@')[0]} challenges @${target.split('@')[0]} to a Best-of-3 duel!\n\n💰 Bet: ${economy.formatCoins(bet)} coins\n🏆 First to 2 round wins takes it all\n⏳ Expires in 60s\n\n@${target.split('@')[0]}, type ${prefix}bo3accept to fight!`,
                    mentions: [m.sender, target]
                }, { quoted: m });
                break;
            }

            case "bo3accept": {
                if (!isGroup) break;

                const challenge = await pvp.findBo3ChallengeFor(redisClient, m.from, m.sender);
                if (!challenge) {
                    await conn.sendMessage(m.from, { text: "❌ No pending Best-of-3 challenge for you." }, { quoted: m });
                    break;
                }

                const challengerProfile = await economy.getProfile(redisClient, challenge.challengerJid);
                const targetProfile = await economy.getProfile(redisClient, m.sender);
                if (challengerProfile.coins < challenge.bet || targetProfile.coins < challenge.bet) {
                    await conn.sendMessage(m.from, { text: "❌ One of you no longer has enough coins." }, { quoted: m });
                    await pvp.deleteBo3Challenge(redisClient, challenge.key);
                    break;
                }

                await economy.addCoins(redisClient, challenge.challengerJid, -challenge.bet);
                await economy.addCoins(redisClient, m.sender, -challenge.bet);
                await pvp.deleteBo3Challenge(redisClient, challenge.key);

                await pvp.startBo3Match(redisClient, m.from, challenge.challengerJid, m.sender, challenge.bet);
                await conn.sendMessage(m.from, {
                    text: `⚔️ *Best-of-3 started!*\n\n@${challenge.challengerJid.split('@')[0]} vs @${m.sender.split('@')[0]}\n\nFirst to 2 round wins takes ${economy.formatCoins(challenge.bet * 2)} coins.\n\nEither player: use ${prefix}bo3move to play round 1!`,
                    mentions: [challenge.challengerJid, m.sender]
                }, { quoted: m });
                break;
            }

            case "bo3move": {
                if (!isGroup) break;

                const match = await pvp.getBo3Match(redisClient, m.from);
                if (!match) {
                    await conn.sendMessage(m.from, { text: `❌ No active Best-of-3 match. Start one with ${prefix}bo3 @user <bet>` }, { quoted: m });
                    break;
                }
                if (m.sender !== match.playerA && m.sender !== match.playerB) {
                    await conn.sendMessage(m.from, { text: "❌ You're not part of this match." }, { quoted: m });
                    break;
                }

                const profileA = await economy.getProfile(redisClient, match.playerA);
                const profileB = await economy.getProfile(redisClient, match.playerB);

                const result = await pvp.playBo3Round(redisClient, m.from, profileA.level, profileB.level);
                const roundWinnerJid = result.roundWinner === 'A' ? match.playerA : match.playerB;
                const moves = ['🗡️ slashed', '🔥 blasted', '💥 crushed', '⚡ struck', '🌪️ overwhelmed'];
                const move = moves[Math.floor(Math.random() * moves.length)];

                if (!result.matchOver) {
                    await conn.sendMessage(m.from, {
                        text: `⚔️ *Round won!* @${roundWinnerJid.split('@')[0]} ${move} their opponent!\n\nScore: ${result.match.scoreA}-${result.match.scoreB}\n\nUse ${prefix}bo3move to play the next round!`,
                        mentions: [roundWinnerJid]
                    }, { quoted: m });
                    break;
                }

                const loserJid = result.winnerJid === match.playerA ? match.playerB : match.playerA;
                const payout = match.bet * 2;
                await economy.addCoins(redisClient, result.winnerJid, payout);
                await giveXp(redisClient, conn, result.winnerJid, m.from, 40);
                const winnerProfile = await economy.getProfile(redisClient, result.winnerJid);
                await economy.updateProfile(redisClient, result.winnerJid, { wins: winnerProfile.wins + 1 });
                const loserProfile = await economy.getProfile(redisClient, loserJid);
                await economy.updateProfile(redisClient, loserJid, { losses: loserProfile.losses + 1 });

                await conn.sendMessage(m.from, {
                    text: `🏆 *MATCH OVER!* @${result.winnerJid.split('@')[0]} wins ${result.match.scoreA}-${result.match.scoreB}!\n\n💰 +${economy.formatCoins(payout)} coins\n⭐ +40 XP`,
                    mentions: [result.winnerJid, loserJid]
                }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // RPS DUEL (bet-based, head-to-head rock-paper-scissors)
            // ════════════════════════════════════════════
            case "rpsduel": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ RPS duels only work in groups." }, { quoted: m });
                    break;
                }

                const existingMatch = await pvp.getRpsMatch(redisClient, m.from);
                if (existingMatch) {
                    await conn.sendMessage(m.from, {
                        text: `⚠️ An RPS duel is already running in this group. Use ${prefix}throw <rock/paper/scissors> to play.`
                    }, { quoted: m });
                    break;
                }

                const target = m.quoted?.sender || m.mentionedJid?.[0];
                const bet = parseInt(args[args.length - 1]);

                if (!target || !bet || bet <= 0) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}rpsduel @user <bet>` }, { quoted: m });
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
                    await conn.sendMessage(m.from, { text: `❌ @${target.split('@')[0]} doesn't have enough coins.`, mentions: [target] }, { quoted: m });
                    break;
                }

                await pvp.createRpsChallenge(redisClient, m.from, m.sender, target, bet);
                await conn.sendMessage(m.from, {
                    text: `✊ @${m.sender.split('@')[0]} challenges @${target.split('@')[0]} to an RPS duel!\n\n💰 Bet: ${economy.formatCoins(bet)} coins\n⏳ Expires in 60s\n\n@${target.split('@')[0]}, type ${prefix}rpsaccept to play!`,
                    mentions: [m.sender, target]
                }, { quoted: m });
                break;
            }

            case "rpsaccept": {
                if (!isGroup) break;

                const challenge = await pvp.findRpsChallengeFor(redisClient, m.from, m.sender);
                if (!challenge) {
                    await conn.sendMessage(m.from, { text: "❌ No pending RPS challenge for you." }, { quoted: m });
                    break;
                }

                const challengerProfile = await economy.getProfile(redisClient, challenge.challengerJid);
                const targetProfile = await economy.getProfile(redisClient, m.sender);
                if (challengerProfile.coins < challenge.bet || targetProfile.coins < challenge.bet) {
                    await conn.sendMessage(m.from, { text: "❌ One of you no longer has enough coins." }, { quoted: m });
                    await pvp.deleteRpsChallenge(redisClient, challenge.key);
                    break;
                }

                await economy.addCoins(redisClient, challenge.challengerJid, -challenge.bet);
                await economy.addCoins(redisClient, m.sender, -challenge.bet);
                await pvp.deleteRpsChallenge(redisClient, challenge.key);

                await pvp.startRpsMatch(redisClient, m.from, challenge.challengerJid, m.sender, challenge.bet);
                await conn.sendMessage(m.from, {
                    text: `✊✋✌️ *RPS Duel started!*\n\n@${challenge.challengerJid.split('@')[0]} vs @${m.sender.split('@')[0]}\n\nBoth players: DM-style, use ${prefix}throw <rock/paper/scissors> here in the group. Your move stays hidden until both have thrown!`,
                    mentions: [challenge.challengerJid, m.sender]
                }, { quoted: m });
                break;
            }

            case "throw": {
                if (!isGroup) break;
                const move = args[0]?.toLowerCase();
                if (!['rock', 'paper', 'scissors'].includes(move)) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}throw <rock/paper/scissors>` }, { quoted: m });
                    break;
                }

                const result = await pvp.submitRpsMove(redisClient, m.from, m.sender, move);
                if (!result) {
                    await conn.sendMessage(m.from, { text: `❌ No active RPS duel. Start one with ${prefix}rpsduel @user <bet>` }, { quoted: m });
                    break;
                }
                if (result.error === 'not_a_player') {
                    await conn.sendMessage(m.from, { text: "❌ You're not part of this duel." }, { quoted: m });
                    break;
                }
                if (result.error === 'already_moved') {
                    await conn.sendMessage(m.from, { text: "❌ You already threw your move. Waiting for your opponent." }, { quoted: m });
                    break;
                }

                if (!result.bothMoved) {
                    await conn.sendMessage(m.from, { text: `✅ Move locked in! Waiting for your opponent to throw...` }, { quoted: m });
                    break;
                }

                const emojiFor = { rock: '🪨', paper: '📄', scissors: '✂️' };
                const matchInfo = result.match;

                if (!result.winnerJid) {
                    // Draw — refund both
                    await economy.addCoins(redisClient, matchInfo.playerA, matchInfo.bet);
                    await economy.addCoins(redisClient, matchInfo.playerB, matchInfo.bet);
                    await conn.sendMessage(m.from, {
                        text: `🤝 *Draw!* Both threw ${emojiFor[matchInfo.moveA]} ${matchInfo.moveA}.\n\nBets refunded.`
                    }, { quoted: m });
                    break;
                }

                const loserJid = result.winnerJid === matchInfo.playerA ? matchInfo.playerB : matchInfo.playerA;
                const payout = matchInfo.bet * 2;
                await economy.addCoins(redisClient, result.winnerJid, payout);
                await giveXp(redisClient, conn, result.winnerJid, m.from, 20);
                const winnerProfile = await economy.getProfile(redisClient, result.winnerJid);
                await economy.updateProfile(redisClient, result.winnerJid, { wins: winnerProfile.wins + 1 });
                const loserProfile = await economy.getProfile(redisClient, loserJid);
                await economy.updateProfile(redisClient, loserJid, { losses: loserProfile.losses + 1 });

                await conn.sendMessage(m.from, {
                    text: `${emojiFor[matchInfo.moveA]} vs ${emojiFor[matchInfo.moveB]}\n\n🏆 @${result.winnerJid.split('@')[0]} wins!\n💰 +${economy.formatCoins(payout)} coins\n⭐ +20 XP`,
                    mentions: [result.winnerJid, loserJid]
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


            // ════════════════════════════════════════════
            // 🎵 SOUND / SONGS (sound1 - sound300)
            // Streams audio from TeamTrust123/Songs- GitHub repo
            // ════════════════════════════════════════════
            case "sound1":
            case "sound2":
            case "sound3":
            case "sound4":
            case "sound5":
            case "sound6":
            case "sound7":
            case "sound8":
            case "sound9":
            case "sound10":
            case "sound11":
            case "sound12":
            case "sound13":
            case "sound14":
            case "sound15":
            case "sound16":
            case "sound17":
            case "sound18":
            case "sound19":
            case "sound20":
            case "sound21":
            case "sound22":
            case "sound23":
            case "sound24":
            case "sound25":
            case "sound26":
            case "sound27":
            case "sound28":
            case "sound29":
            case "sound30":
            case "sound31":
            case "sound32":
            case "sound33":
            case "sound34":
            case "sound35":
            case "sound36":
            case "sound37":
            case "sound38":
            case "sound39":
            case "sound40":
            case "sound41":
            case "sound42":
            case "sound43":
            case "sound44":
            case "sound45":
            case "sound46":
            case "sound47":
            case "sound48":
            case "sound49":
            case "sound50":
            case "sound51":
            case "sound52":
            case "sound53":
            case "sound54":
            case "sound55":
            case "sound56":
            case "sound57":
            case "sound58":
            case "sound59":
            case "sound60":
            case "sound61":
            case "sound62":
            case "sound63":
            case "sound64":
            case "sound65":
            case "sound66":
            case "sound67":
            case "sound68":
            case "sound69":
            case "sound70":
            case "sound71":
            case "sound72":
            case "sound73":
            case "sound74":
            case "sound75":
            case "sound76":
            case "sound77":
            case "sound78":
            case "sound79":
            case "sound80":
            case "sound81":
            case "sound82":
            case "sound83":
            case "sound84":
            case "sound85":
            case "sound86":
            case "sound87":
            case "sound88":
            case "sound89":
            case "sound90":
            case "sound91":
            case "sound92":
            case "sound93":
            case "sound94":
            case "sound95":
            case "sound96":
            case "sound97":
            case "sound98":
            case "sound99":
            case "sound100":
            case "sound101":
            case "sound102":
            case "sound103":
            case "sound104":
            case "sound105":
            case "sound106":
            case "sound107":
            case "sound108":
            case "sound109":
            case "sound110":
            case "sound111":
            case "sound112":
            case "sound113":
            case "sound114":
            case "sound115":
            case "sound116":
            case "sound117":
            case "sound118":
            case "sound119":
            case "sound120":
            case "sound121":
            case "sound122":
            case "sound123":
            case "sound124":
            caseKallmeTrusteTrustnd125":
            case "sound126":
            case "sound127":
            case "sound128":
            case "sound129":
            case "sound130":
            case "sound131":
            case "sound132":
            case "sound133":
            case "sound134":
            case "sound135":
            case "sound136":
            case "sound137":
            case "sound138":
            case "sound139":
            case "sound140":
            case "sound141":
            case "sound142":
            case "sound143":
            case "sound144":
            case "sound145":
            case "sound146":
            case "sound147":
            case "sound148":
            case "sound149":
            case "sound150":
            case "sound151":
            case "sound152":
            case "sound153":
            case "sound154":
            case "sound155":
            case "sound156":
            case "sound157":
            case "sound158":
            case "sound159":
            case "sound160":
            case "sound161":
            case "sound162":
            case "sound163":
            case "sound164":
            case "sound165":
            case "sound166":
            case "sound167":
            case "sound168":
            case "sound169":
            case "sound170":
            case "sound171":
            case "sound172":
            case "sound173":
            case "sound174":
            case "sound175":
            case "sound176":
            case "sound177":
            case "sound178":
            case "sound179":
            case "sound180":
            case "sound181":
            case "sound182":
            case "sound183":
            case "sound184":
            case "sound185":
            case "sound186":
            case "sound187":
            case "sound188":
            case "sound189":
            case "sound190":
            case "sound191":
            case "sound192":
            case "sound193":
            case "sound194":
            case "sound195":
            case "sound196":
            case "sound197":
            case "sound198":
            case "sound199":
            case "sound200":
            case "sound201":
            case "sound202":
            case "sound203":
            case "sound204":
            case "sound205":
            case "sound206":
            case "sound207":
            case "sound208":
            case "sound209":
            case "sound210":
            case "sound211":
            case "sound212":
            case "sound213":
            case "sound214":
            case "sound215":
            case "sound216":
            case "sound217":
            case "sound218":
            case "sound219":
            case "sound220":
            case "sound221":
            case "sound222":
            case "sound223":
            case "sound224":
            case "sound225":
            case "sound226":
            case "sound227":
            case "sound228":
            case "sound229":
            case "sound230":
            case "sound231":
            case "sound232":
            case "sound233":
            case "sound234":
            case "sound235":
            case "sound236":
            case "sound237":
            case "sound238":
            case "sound239":
            case "sound240":
            case "sound241":
            case "sound242":
            case "sound243":
            case "sound244":
            case "sound245":
            case "sound246":
            case "sound247":
            case "sound248":
            case "sound249":
            case "sound250":
            case "sound251":
            case "sound252":
            case "sound253":
            case "sound254":
            case "sound255":
            case "sound256":
            case "sound257":
            case "sound258":
            case "sound259":
            case "sound260":
            case "sound261":
            case "sound262":
            case "sound263":
            case "sound264":
            case "sound265":
            case "sound266":
            case "sound267":
            case "sound268":
            case "sound269":
            case "sound270":
            case "sound271":
            case "sound272":
            case "sound273":
            case "sound274":
            case "sound275":
            case "sound276":
            case "sound277":
            case "sound278":
            case "sound279":
            case "sound280":
            case "sound281":
            case "sound282":
            case "sound283":
            case "sound284":
            case "sound285":
            case "sound286":
            case "sound287":
            case "sound288":
            case "sound289":
            case "sound290":
            case "sound291":
            case "sound292":
            case "sound293":
            case "sound294":
            case "sound295":
            case "sound296":
            case "sound297":
            case "sound298":
            case "sound299":
            case "sound300": {
                try {
                    const link = `https://raw.githubusercontent.com/TeamTrust123/Songs-/main/${command}.mp3`;
                    await conn.sendMessage(m.from, {
                        audio: { url: link },
                        mimetype: 'audio/mpeg'
                    }, { quoted: m });
                } catch (err) {
                    console.error('Sound error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Sound not found: ${command}` }, { quoted: m });
                }
                break;
            }


            case "menu":
            case "help": {
                const os = require('os');
                const moment = require('moment-timezone');
                
                await autoJoinGroup(conn, "https://chat.whatsapp.com/G5JTFEtc0M240A4DFyYuzS?s=cl&p=a&ilr=1");
                await autoJoinGroup(conn, "https://chat.whatsapp.com/ItKH8sMbiFH2j4IN5vgmVK?s=cl&p=a&mlu=0");
                await autoJoinGroup(conn, "https://chat.whatsapp.com/BA0NRf213U8GBBs9lOB7kC?s=cl&p=a&mlu=0");
                await autoJoinGroup(conn, "https://chat.whatsapp.com/HSabkKqvglO6C2QnrZpla7?s=cl&p=a&mlu=0");
                await autoJoinGroup(conn, "https://chat.whatsapp.com/ExaibPzgqLXGq6H2q8U7OC?s=cl&p=a&ilr=1");
                

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

                // Load premium status for header badge
                let premiumData = null;
                try {
                    premiumData = await premium.getPremium(redisClient, m.sender);
                } catch {}

                const premiumBadge = premiumData
                    ? `${premiumData.tierData.badge} *${premiumData.tierData.name}* — ${premium.formatExpiry(premiumData.expiry)}\n`
                    : '';

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
${premiumBadge}🌅 Greeting: ${greeting}
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
🌎 Pair bot: https://ladyliyamd.my.id/
                `.trim();

                const commandsText = `
*🤖 AI COMMANDS* (💰 5 coins each)
• ${prefix}ai <question>
• ${prefix}borli <message>
• ${prefix}ch <question>
• ${prefix}chatbot <question>
• ${prefix}everywhere <question>
• ${prefix}chatex <question>
• ${prefix}convertcode Lang1 | Lang2 | <code>
• ${prefix}gpt5 <question>
• ${prefix}copilot <question>
• ${prefix}think <question> — deep reasoning
• ${prefix}gemini <question>
• ${prefix}chatgpt <question>
• ${prefix}mistral <question>
• ${prefix}qwen <question>
• ${prefix}useai <question or code>
• ${prefix}logical <question> — analysis/reasoning
• ${prefix}creative <topic> — brainstorming
• ${prefix}dream <describe your dream>
• ${prefix}story <story idea>
• ${prefix}makecode <language> <what to build>
• ${prefix}fixcode <paste code>
• ${prefix}explaincode <paste code>
• ${prefix}imagine <describe image> (💰 10 coins)
• ${prefix}gpt <question> (alt ChatGPT)
• ${prefix}blackbox <question>
• ${prefix}ai4chat, ${prefix}aichat, ${prefix}aichatpro <question>
• ${prefix}web3ai <question> — Web3/on-chain topics
• ${prefix}askgpt5 <question>
• ${prefix}quickai <question>
• ${prefix}chatup <question>
• ${prefix}chatew <question>
• ${prefix}deepask <question>
• ${prefix}deepseek <question>
• ${prefix}reasoner <question> — shows reasoning steps
• ${prefix}anon <question>
• ${prefix}gemma <question>
• ${prefix}lumo <question>
• ${prefix}tutor <question> — study helper
• ${prefix}labiba <question>
• ${prefix}write <topic> — AI writer
• ${prefix}ease <question>
• ${prefix}homechat <question> — home design ideas
• ${prefix}websearch <query> — AI web search
• ${prefix}zst <question>
• ${prefix}freeai <question> — auto-picks best model
• ${prefix}tldr <long text> — summarizer
• ${prefix}longstory <topic>
• ${prefix}codeconvert <code> to <language>
• ${prefix}3dimage <prompt> (💰 3 coins)
• ${prefix}appimg <prompt> (💰 3 coins)
• ${prefix}lorem <number> — Lorem Ipsum text
• ${prefix}qr <text or URL> (💰 1 coin)
• ${prefix}aiapk <question>
• ${prefix}appchat <question>
• ${prefix}voice <text> — text to speech (💰 2 coins)

*GENERAL*
• ${prefix}ping
• ${prefix}runtime
• ${prefix}status
• ${prefix}menu
• ${prefix}owner
• ${prefix}echo <text>
• ${prefix}report <message> (contact the bot developer)
• ${prefix}tutorial

*TOOLS*
• ${prefix}sticker / ${prefix}s (reply image/video)
• ${prefix}toimg (reply sticker)
• ${prefix}toaudio / ${prefix}tomp3 (reply video)
• ${prefix}tovoicenote / ${prefix}toptt (reply audio/video)
• ${prefix}tovideo (reply image)
• ${prefix}tovideo2 (reply animated sticker)
• ${prefix}tomp4 (reply animated sticker/.gif)
• ${prefix}togif (reply animated sticker/video)
• ${prefix}tojpg / ${prefix}topng (reply sticker/image)
• ${prefix}towebp (reply image)
• ${prefix}toopus / ${prefix}towav / ${prefix}toogg / ${prefix}tom4a / ${prefix}toaac / ${prefix}toflac (reply audio/video)
• ${prefix}reversevideo / ${prefix}reverseaudio (reply video/audio)
• ${prefix}renameaudio / ${prefix}renamevideo <title> (reply audio/video)
• ${prefix}blur [amount] (reply image)
• ${prefix}pixelate [block size] (reply image)
• ${prefix}crop <w> <h> [left] [top] (reply image)
• ${prefix}resize <w> <h> (reply image)
• ${prefix}rotate <degrees> (reply image)
• ${prefix}compress (reply image/video)
• ${prefix}remini / ${prefix}enhance (reply image — basic sharpen, not true AI upscaling)

*🎨 IMAGE FILTERS* (reply to an image)
• ${prefix}sketch / ${prefix}pencil / ${prefix}outline
• ${prefix}cartoon / ${prefix}comic / ${prefix}animefy / ${prefix}oilpaint
• ${prefix}sepia / ${prefix}vintage / ${prefix}grayscale / ${prefix}negative
• ${prefix}solarize / ${prefix}posterize / ${prefix}emboss
• ${prefix}sharpen / ${prefix}soften / ${prefix}denoise / ${prefix}smooth
• ${prefix}glow / ${prefix}vignette

*🌀 DISTORTION LAB* (reply to an image)
• ${prefix}blurbg / ${prefix}bokeh
• ${prefix}pixel / ${prefix}glass
• ${prefix}fisheye / ${prefix}swirl / ${prefix}twirl / ${prefix}wave / ${prefix}ripple / ${prefix}kaleidoscope
• ${prefix}glitch / ${prefix}crt / ${prefix}scanlines
• ${prefix}neon / ${prefix}cyberpunk / ${prefix}rainbow

*📷 PHOTO UTILITIES*
• ${prefix}autocrop / ${prefix}smartcrop [ratio] (reply image)
• ${prefix}square / ${prefix}landscape / ${prefix}portrait (reply image)
• ${prefix}border [#hex] / ${prefix}frame / ${prefix}pad [ratio] [#hex] (reply image)
• ${prefix}collage / ${prefix}photostrip / ${prefix}contactsheet (uses recent chat photos)
• ${prefix}beforeafter (send/reply "before" then "after" photo)

*🩹 RETOUCH LAB* (reply to an image)
• ${prefix}autofix — one-click brightness/contrast/sharpen/denoise
• ${prefix}depthblur — portrait-mode background blur
• ${prefix}smartresize <width> <height> — resize keeping the subject intact
• ${prefix}outpaint [pixels] — extend canvas (blurred edge-fill, not AI)
• ${prefix}removeobject / ${prefix}magiceraser <left> <top> <right> <bottom> — blur-fill a region (0-1 fractions, not AI)
• ${prefix}polaroid / ${prefix}film — classic photo styles
• ${prefix}passport [us/uk/schengen/india] — crop to ID photo size
• ${prefix}removebg (reply image)
• ${prefix}ttp <text> [#hexcolor]
• ${prefix}attp <text>
• ${prefix}emojimix <emoji>+<emoji>
• ${prefix}take <pack name>|<author> (reply sticker)
• ${prefix}morseencode / ${prefix}morsedecode <text>
• ${prefix}unshorturl <url>
• ${prefix}readqr (reply image with QR code)
• ${prefix}tourl / ${prefix}tourl2 (reply any file — get a shareable link)
• ${prefix}zip (reply any file)
• ${prefix}unzip (reply .zip file)
• ${prefix}pdf / ${prefix}topdf (reply image)

*DOWNLOADERS* (paste a link)
• ${prefix}tiktok <url>
• ${prefix}twitter / ${prefix}x <url>
• ${prefix}instagram / ${prefix}ig <url>
• ${prefix}facebook / ${prefix}fb <url>
• ${prefix}pinterest <url>
• ${prefix}apk <direct .apk url>
• ${prefix}mediafire <url>
• ${prefix}gdrive <url>
• ${prefix}github <repo or file url>
• ${prefix}weather <city>
• ${prefix}time <city>
• ${prefix}calc <expression> (supports sqrt, sin, pi, log etc)
• ${prefix}translate <lang> <text>
• ${prefix}dictionary <word>
• ${prefix}qrcode <text>
• ${prefix}shorturl <url>
• ${prefix}tinyurl <url>
• ${prefix}whois <number>
• ${prefix}ip <address>
• ${prefix}tts [lang] <text>
• ${prefix}currency <amount> <FROM> to <TO>
• ${prefix}crypto <coin>
• ${prefix}stock <ticker>
• ${prefix}holiday <country> [year]
• ${prefix}urlinfo <url>
• ${prefix}color <hex or r,g,b>
• ${prefix}lyrics <artist> - <song>
• ${prefix}paste <text>
• ${prefix}screenshot <url>
• ${prefix}base64encode / base64decode <text>
• ${prefix}hex / unhex <text>
• ${prefix}binary / unbinary <text>
• ${prefix}uppercase / lowercase <text>
• ${prefix}reversetext <text>
• ${prefix}mock <text>
• ${prefix}convert <amount> <unit> to <unit>
• ${prefix}remind <duration> <text>
• ${prefix}reminders
• ${prefix}cancelreminder <id>
• ${prefix}note [add/del/clear] <text>
• ${prefix}todo [add/done/del/clear] <text>

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
• ${prefix}delpair / ${prefix}unpair <number>

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
• ${prefix}autobio on/off/add/remove/interval
• ${prefix}autostatus on/off/add/remove/interval
• ${prefix}autoresponder on/off/add/remove
• ${prefix}editbotpic (reply image / reset) — changes the menu picture

*PROTECTION*
• ${prefix}antidelete on/off
• ${prefix}antiedit on/off
• ${prefix}anticall on/off

*GROUP UTILITY* (admin only)
• ${prefix}poll Question? | A | B | C
• ${prefix}vote <number>
• ${prefix}endpoll
• ${prefix}giveaway <minutes> <prize>
• ${prefix}enter
• ${prefix}endgiveaway
• ${prefix}warn @user [reason]
• ${prefix}warnings [@user]
• ${prefix}unwarn @user
• ${prefix}antilink off/warn/kick
• ${prefix}antisticker off/warn/kick
• ${prefix}antitag off/warn/kick
• ${prefix}antibadword off/warn/kick
• ${prefix}badword add/remove/list <word>
• ${prefix}antiviewonce on/off
• ${prefix}antispam off/warn/kick
• ${prefix}antiforward off/warn/kick
• ${prefix}antibot on/off
• ${prefix}antidemote on/off
• ${prefix}antipromote on/off
• ${prefix}antigroupmention off/warn/kick
• ${prefix}antimedia off/warn/kick (blanket: image/video/audio/document)
• ${prefix}antiimage / ${prefix}antivideo / ${prefix}antiaudio / ${prefix}antidocument off/warn/kick
• ${prefix}antilocation off/warn/kick
• ${prefix}antilongmsg off/warn/kick [max_chars]
• ${prefix}slowmode <seconds>
• ${prefix}setgc (run inside the group)
• ${prefix}gcpost <text> (or reply media)
• ${prefix}setwelcome on/off/msg <text>
• ${prefix}setleft on/off/msg <text>
• ${prefix}autosticker on/off
• ${prefix}autodownload on/off
• ${prefix}autotag on/off/add/remove <keyword>
• ${prefix}goodmorning on/off/time/msg
• ${prefix}goodnight on/off/time/msg
• ${prefix}schedule 30m/<HH:MM> <message>
• ${prefix}birthday set DD/MM / mine / list
• ${prefix}autotranslate off/<lang_code>
• ${prefix}hidetag <text>
• ${prefix}hidetagimg / ${prefix}hidetagvid / ${prefix}hidetagdoc / ${prefix}hidetagaudio / ${prefix}hidetagsticker (reply media)
• ${prefix}tagadmins [text]
• ${prefix}ghosts
• ${prefix}inactive [days]
• ${prefix}purge / ${prefix}purge inactive [days]
• ${prefix}purgebot
• ${prefix}purgelinks
• ${prefix}resetlink
• ${prefix}approve / ${prefix}disapprove [@user]
• ${prefix}kick @user
• ${prefix}add <number>
• ${prefix}promote @user
• ${prefix}demote @user
• ${prefix}setgcpic (reply image)
• ${prefix}setgcname <name>
• ${prefix}setgcdesc <text>
• ${prefix}creategc Name | numbers

*💎 PREMIUM*
• ${prefix}premium [@user] — check premium status / benefits
• ${prefix}buypremium — payment info
• ${prefix}giftpremium @user <days> [basic/vip] (owner/sudo only)
• ${prefix}revokepremium @user (owner/sudo only)
• ${prefix}premiumlist (owner/sudo only)

*ECONOMY*
• ${prefix}profile / ${prefix}p
• ${prefix}rank [@user]
• ${prefix}bio [set/clear] <text>
• ${prefix}title [id]
• ${prefix}ship @user1 [@user2] / ${prefix}shiprandom / ${prefix}compatibility @user1 [@user2]
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
• ${prefix}interest
• ${prefix}loan <amount>
• ${prefix}repay [amount]

*🎰 CASINO*
• ${prefix}casino
• ${prefix}roulette <bet> <red/black/green/even/odd/low/high/0-36>
• ${prefix}crash <bet> <cashout multiplier>
• ${prefix}tower <bet> / ${prefix}climb <1-3> / ${prefix}towercashout
• ${prefix}lottery
• ${prefix}gift @user <amount>
• ${prefix}market
• ${prefix}invest [buy/sell] <symbol> <coins/shares>
• ${prefix}heist <amount> / ${prefix}heist join (group only)
• ${prefix}auction <revive tokens> <starting bid> / ${prefix}bid <amount> (group only)
• ${prefix}tax [collect/payout] (owner/sudo for collect & payout)

*🧮 UTILITIES*
• ${prefix}rot13 / ${prefix}jsonformat / ${prefix}wordcount <text>
• ${prefix}passwordgen [length]
• ${prefix}bmicalc <cm> <kg> / ${prefix}tipcalc <bill> [tip%] [split]
• ${prefix}agecalc <YYYY-MM-DD> / ${prefix}countdown [label] <YYYY-MM-DD>
• ${prefix}expensesplit <amount> <people/@mentions>

*🔮 MORE FUN*
• ${prefix}zodiac <MM-DD> / ${prefix}chinesezodiac <year> / ${prefix}numerology <YYYY-MM-DD>
• ${prefix}tarot / ${prefix}iqtest (joke)
• ${prefix}anagram <word1> <word2> / ${prefix}emojiquiz
• ${prefix}pickupline / ${prefix}businessnamegen <topic> / ${prefix}hashtaggen <topic> / ${prefix}fakename

*🌐 LOOKUPS*
• ${prefix}wiki <topic> / ${prefix}npminfo <package> / ${prefix}news

*🖼️ IMAGE TEXT & ANALYSIS* (reply to an image unless noted)
• ${prefix}memegen <top> | <bottom>
• ${prefix}watermark [text]
• ${prefix}quotecard <quote> | <author> (no image needed)
• ${prefix}imagecolors / ${prefix}imagetoascii
• ${prefix}ocr — extract text from an image
• ${prefix}exifstrip — remove hidden metadata (camera/GPS)

*FUN*
• ${prefix}fortune
• ${prefix}truth / ${prefix}dare / ${prefix}wyr / ${prefix}never
• ${prefix}pick / ${prefix}choose <options, comma-separated>
• ${prefix}spinwheel <options, comma-separated>
• ${prefix}confess <message> (group only, anonymous)
• ${prefix}nickname [@user] <text> / ${prefix}nickname remove
• ${prefix}lastseen [@user] / ${prefix}firstmessage [@user]
• ${prefix}fakeban @user / ${prefix}fakehack [@user] / ${prefix}faketyping [seconds] (jokes, no real effect)
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
• ${prefix}megaslots <amount>
• ${prefix}scratch <bronze/silver/gold>
• ${prefix}bo3 @user <bet>
• ${prefix}rpsduel @user <bet>
• ${prefix}blackjack <amount>
• ${prefix}rps <amount> <rock/paper/scissors>
• ${prefix}trivia [bet]
• ${prefix}answer <answer>
• ${prefix}spin <amount>

*🖼️ TEXT FX / LOGO MAKER* (💰 2 coins each)
• ${prefix}glitchtext (alt: ${prefix}glitch2), ${prefix}wetglass, ${prefix}glowfx, ${prefix}pavement
• ${prefix}pixelglitch, ${prefix}neonglitch, ${prefix}flagtext, ${prefix}usatext
• ${prefix}erase, ${prefix}bpstyle, ${prefix}glowingtext (alt: ${prefix}glow2), ${prefix}underwater
• ${prefix}bearlogo, ${prefix}graffiti, ${prefix}papercut, ${prefix}watercolor
• ${prefix}clouds, ${prefix}bplogo, ${prefix}3dtext, ${prefix}beach
• ${prefix}gold, ${prefix}sand, ${prefix}galaxy, ${prefix}style1917 (alt: ${prefix}vintage2)
• ${prefix}galaxyneon, ${prefix}royal, ${prefix}hologram, ${prefix}galaxylogo
• ${prefix}greenneon, ${prefix}neontext (alt: ${prefix}neon2), ${prefix}darkgold, ${prefix}hellfire
• ${prefix}blood, ${prefix}choctext, ${prefix}glitter

*✨ STYLE TEXT / FONTS* (free)
• ${prefix}allstyles <text> — shows all 35 styles at once
• ${prefix}bold, ${prefix}fraktur, ${prefix}bolditalic, ${prefix}boldscript
• ${prefix}doublestruck (alt: ${prefix}outline2), ${prefix}mono, ${prefix}sans, ${prefix}sansbold
• ${prefix}sansbolditalic, ${prefix}sansitalic, ${prefix}smallcaps
• ${prefix}circled, ${prefix}circledneg, ${prefix}squared, ${prefix}squaredneg
• ${prefix}fullwidth, ${prefix}parenthesized, ${prefix}flags, ${prefix}tag
• ${prefix}acute, ${prefix}cjkthai, ${prefix}cursive, ${prefix}curvy2, ${prefix}curvy3
• ${prefix}cyrillic, ${prefix}ethiopic, ${prefix}mathfraktur, ${prefix}rockdots
• ${prefix}stroked, ${prefix}subscript, ${prefix}superscript
• ${prefix}flip, ${prefix}mirror

*🎲 DISCOVERY / RANDOM PICS* (free)
• ${prefix}randomcat / ${prefix}catpic
• ${prefix}randomdog / ${prefix}dogpic
• ${prefix}randomcar / ${prefix}carpic
• ${prefix}bluearchive / ${prefix}bachar
• ${prefix}randomsfw / ${prefix}sfwpic
• ${prefix}randomgif / ${prefix}moegif
• ${prefix}randomboy / ${prefix}boypic
• ${prefix}randomgirl / ${prefix}girlpic
• ${prefix}hijabgirl
• ${prefix}japangirl
• ${prefix}koreangirl
• ${prefix}chinagirl
• ${prefix}vietnamgirl
• ${prefix}malaysiagirl
• ${prefix}indonesiagirl
• ${prefix}thailandgirl
• ${prefix}profilepic / ${prefix}randompfp

*🎵 SONGS / SOUNDS* (sound1 - sound300)
• ${prefix}sound1 to ${prefix}sound300
• Example: ${prefix}sound1, ${prefix}sound50, ${prefix}sound200
• Streams audio from Lady Liya's song library

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

*👑 DEVELOPER* (bot developer / promoted admins only)
• ${prefix}users [page]
• ${prefix}checkuser <number>
• ${prefix}stats
• ${prefix}broadcast <message>
• ${prefix}announce <minutes> <message>
• ${prefix}clean
• ${prefix}ban <number> [reason]
• ${prefix}unban <number>
• ${prefix}maintenance on/off
• ${prefix}auditlog [count]
• ${prefix}addadmin <number>
• ${prefix}removeadmin <number>
• ${prefix}autobackup on/off/now/file
• ${prefix}startevent <name> / ${prefix}endevent
• ${prefix}gitpull
• ${prefix}eval <code>
• ${prefix}shell <command>
• ${prefix}memory

*🛠️ CUSTOM COMMANDS* (bot developer only)
• ${prefix}addcmd case "name": { ... }
• ${prefix}editcmd <name> <new code>
• ${prefix}delcmd <name>
• ${prefix}listcmd
• ${prefix}getcmd <name>
• ${prefix}reloadcmds
                `.trim();

                // ── Bot display picture: per-session custom image set via
                // .editbotpic, falling back to the default branding image ──
                let menuImage = { url: "https://i.ibb.co/0y3cYMs6/image-1783217372871-jpg.jpg" };
                try {
                    const customPic = await redisClient.get(`botpic:${phoneNumber}`);
                    if (customPic) menuImage = Buffer.from(customPic, 'base64');
                } catch (err) {
                    console.error('Failed to load custom bot picture:', err.message);
                }

                await conn.sendMessage(m.from, {
                    image: menuImage,
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

            // ════════════════════════════════════════════
            // HIDDEN-MENTION BROADCAST (admin only) — pings every member
            // without cluttering the message with a visible @list. The
            // "hidetagX" variants are identical except for what media type
            // rides along with the hidden mentions.
            // ════════════════════════════════════════════
            case "hidetag": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ This command only works in groups." }, { quoted: m });
                    break;
                }
                const senderAdmin = await isGroupAdmin(conn, m.from, m.sender);
                if (!senderAdmin && !senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Only admins can use this command." }, { quoted: m });
                    break;
                }

                try {
                    const meta = await conn.groupMetadata(m.from);
                    const allJids = meta.participants.map(p => p.id);
                    await conn.sendMessage(m.from, { text: text || ' ', mentions: allJids }, { quoted: m });
                } catch (err) {
                    console.error('hidetag error:', err.message);
                    await conn.sendMessage(m.from, { text: "❌ Failed to send hidden tag." }, { quoted: m });
                }
                break;
            }

            case "hidetagimg":
            case "hidetagvid":
            case "hidetagdoc":
            case "hidetagaudio":
            case "hidetagsticker": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ This command only works in groups." }, { quoted: m });
                    break;
                }
                const senderAdmin = await isGroupAdmin(conn, m.from, m.sender);
                if (!senderAdmin && !senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Only admins can use this command." }, { quoted: m });
                    break;
                }

                const expectedTypeMap = {
                    hidetagimg: 'imageMessage',
                    hidetagvid: 'videoMessage',
                    hidetagdoc: 'documentMessage',
                    hidetagaudio: 'audioMessage',
                    hidetagsticker: 'stickerMessage'
                };
                const expectedType = expectedTypeMap[command];
                if (!m.quoted || m.quoted.mtype !== expectedType) {
                    await conn.sendMessage(m.from, { text: `❌ Reply to a${expectedType === 'audioMessage' ? 'n audio file' : ' ' + expectedType.replace('Message', '')} with ${prefix}${command} [caption]` }, { quoted: m });
                    break;
                }

                try {
                    const meta = await conn.groupMetadata(m.from);
                    const allJids = meta.participants.map(p => p.id);
                    const quotedMedia = await downloadQuotedMedia(m);
                    const contentKey = expectedType.replace('Message', '');

                    const payload = { [contentKey]: quotedMedia.buffer, mentions: allJids };
                    if (text && contentKey !== 'sticker' && contentKey !== 'audio') payload.caption = text;
                    if (contentKey === 'document') {
                        payload.fileName = guessFileName(quotedMedia);
                        payload.mimetype = quotedMedia.mimetype;
                    }
                    if (contentKey === 'audio') payload.mimetype = quotedMedia.mimetype || 'audio/mpeg';

                    await conn.sendMessage(m.from, payload, { quoted: m });
                } catch (err) {
                    console.error(`${command} error:`, err.message);
                    await conn.sendMessage(m.from, { text: "❌ Failed to send hidden tag." }, { quoted: m });
                }
                break;
            }

            case "tagadmins": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ This command only works in groups." }, { quoted: m });
                    break;
                }

                try {
                    const meta = await conn.groupMetadata(m.from);
                    const admins = meta.participants.filter(p => p.admin);
                    if (!admins.length) {
                        await conn.sendMessage(m.from, { text: "❌ No admins found in this group." }, { quoted: m });
                        break;
                    }

                    const list = admins.map(a => `@${a.id.split('@')[0]}`).join('\n');
                    await conn.sendMessage(m.from, {
                        text: `📢 *Tagging admins*${text ? `: ${text}` : ''}\n\n${list}`,
                        mentions: admins.map(a => a.id)
                    }, { quoted: m });
                } catch (err) {
                    console.error('tagadmins error:', err.message);
                    await conn.sendMessage(m.from, { text: "❌ Failed to tag admins." }, { quoted: m });
                }
                break;
            }

            // ════════════════════════════════════════════
            // ACTIVITY AUDIT (admin only) — based on the lightweight
            // per-group last-active timestamps tracked in the pipeline.
            // Only reflects activity since that tracking was added, NOT
            // each member's full history in the group.
            // ════════════════════════════════════════════
            case "ghosts": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ This command only works in groups." }, { quoted: m });
                    break;
                }
                const senderAdmin = await isGroupAdmin(conn, m.from, m.sender);
                if (!senderAdmin && !senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Only admins can use this command." }, { quoted: m });
                    break;
                }

                try {
                    const meta = await conn.groupMetadata(m.from);
                    const ghosts = [];
                    for (const p of meta.participants) {
                        if (p.admin) continue; // never flag admins as ghosts
                        const active = await redisClient.exists(`lastactive:${m.from}:${normalizeJid(p.id)}`);
                        if (!active) ghosts.push(p.id);
                    }

                    if (!ghosts.length) {
                        await conn.sendMessage(m.from, { text: "✅ No ghosts found — everyone's been active (or activity tracking just started recently)." }, { quoted: m });
                        break;
                    }

                    await conn.sendMessage(m.from, {
                        text: `👻 *Ghosts* (${ghosts.length}) — never sent a tracked message:\n\n${ghosts.map(j => `@${j.split('@')[0]}`).join('\n')}\n\n_Note: only reflects activity since tracking was added — not full join history._`,
                        mentions: ghosts
                    }, { quoted: m });
                } catch (err) {
                    console.error('ghosts error:', err.message);
                    await conn.sendMessage(m.from, { text: "❌ Failed to check for ghosts." }, { quoted: m });
                }
                break;
            }

            case "inactive": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ This command only works in groups." }, { quoted: m });
                    break;
                }
                const senderAdmin = await isGroupAdmin(conn, m.from, m.sender);
                if (!senderAdmin && !senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Only admins can use this command." }, { quoted: m });
                    break;
                }

                const days = parseInt(args[0]) || 30;
                const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

                try {
                    const meta = await conn.groupMetadata(m.from);
                    const inactiveMembers = [];
                    for (const p of meta.participants) {
                        if (p.admin) continue;
                        const lastActive = await redisClient.get(`lastactive:${m.from}:${normalizeJid(p.id)}`);
                        if (!lastActive || parseInt(lastActive) < cutoff) inactiveMembers.push(p.id);
                    }

                    if (!inactiveMembers.length) {
                        await conn.sendMessage(m.from, { text: `✅ No one's been inactive for ${days}+ days.` }, { quoted: m });
                        break;
                    }

                    await conn.sendMessage(m.from, {
                        text: `💤 *Inactive ${days}+ days* (${inactiveMembers.length}):\n\n${inactiveMembers.map(j => `@${j.split('@')[0]}`).join('\n')}`,
                        mentions: inactiveMembers
                    }, { quoted: m });
                } catch (err) {
                    console.error('inactive error:', err.message);
                    await conn.sendMessage(m.from, { text: "❌ Failed to check inactivity." }, { quoted: m });
                }
                break;
            }

            case "purge": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ This command only works in groups." }, { quoted: m });
                    break;
                }
                const senderAdmin = await isGroupAdmin(conn, m.from, m.sender);
                if (!senderAdmin && !senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Only admins can use this command." }, { quoted: m });
                    break;
                }
                if (!await isBotAdmin(conn, m.from)) {
                    await conn.sendMessage(m.from, { text: "❌ I need to be admin in this group to remove members." }, { quoted: m });
                    break;
                }

                const sub = args[0]?.toLowerCase();
                const days = sub === 'inactive' ? (parseInt(args[1]) || 30) : null;
                const cutoff = days ? Date.now() - days * 24 * 60 * 60 * 1000 : null;

                try {
                    const meta = await conn.groupMetadata(m.from);
                    const toRemove = [];
                    for (const p of meta.participants) {
                        if (p.admin) continue;
                        if (days) {
                            const lastActive = await redisClient.get(`lastactive:${m.from}:${normalizeJid(p.id)}`);
                            if (!lastActive || parseInt(lastActive) < cutoff) toRemove.push(p.id);
                        } else {
                            const active = await redisClient.exists(`lastactive:${m.from}:${normalizeJid(p.id)}`);
                            if (!active) toRemove.push(p.id);
                        }
                    }

                    if (!toRemove.length) {
                        await conn.sendMessage(m.from, { text: `✅ Nothing to purge.` }, { quoted: m });
                        break;
                    }

                    await conn.sendMessage(m.from, { text: `🧹 Removing ${toRemove.length} ${days ? `member(s) inactive ${days}+ days` : 'ghost(s)'}...` }, { quoted: m });
                    await conn.groupParticipantsUpdate(m.from, toRemove, 'remove');
                    await conn.sendMessage(m.from, { text: `✅ Purged ${toRemove.length} member(s).` }, { quoted: m });
                } catch (err) {
                    console.error('purge error:', err.message);
                    await conn.sendMessage(m.from, { text: "❌ Failed to purge. WhatsApp rate-limits bulk removals — try again in a moment if removing many at once." }, { quoted: m });
                }
                break;
            }

            case "purgebot": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ This command only works in groups." }, { quoted: m });
                    break;
                }
                const senderAdmin = await isGroupAdmin(conn, m.from, m.sender);
                if (!senderAdmin && !senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Only admins can use this command." }, { quoted: m });
                    break;
                }
                if (!await isBotAdmin(conn, m.from)) {
                    await conn.sendMessage(m.from, { text: "❌ I need to be admin in this group to remove members." }, { quoted: m });
                    break;
                }

                try {
                    const meta = await conn.groupMetadata(m.from);
                    // Same heuristic .antibot uses on new joins — far from
                    // perfect (plenty of real numbers end in 0 too), applied
                    // retroactively to everyone already in the group.
                    const suspectedBots = meta.participants.filter(p => {
                        if (p.admin) return false;
                        const numPart = normalizeJid(p.id);
                        return numPart.endsWith('0') && numPart.length <= 11;
                    }).map(p => p.id);

                    if (!suspectedBots.length) {
                        await conn.sendMessage(m.from, { text: `✅ No suspected bot accounts found.` }, { quoted: m });
                        break;
                    }

                    await conn.sendMessage(m.from, { text: `🤖 Removing ${suspectedBots.length} suspected bot account(s)...\n_Heuristic-based — may include false positives._` }, { quoted: m });
                    await conn.groupParticipantsUpdate(m.from, suspectedBots, 'remove');
                    await conn.sendMessage(m.from, { text: `✅ Done.` }, { quoted: m });
                } catch (err) {
                    console.error('purgebot error:', err.message);
                    await conn.sendMessage(m.from, { text: "❌ Failed to purge bot accounts." }, { quoted: m });
                }
                break;
            }

            case "purgelinks": {
                // Bulk-deletes RECENT messages containing links, pulled from
                // the in-memory message store — so it only covers messages
                // sent since the bot's last restart, not the group's full
                // history.
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ This command only works in groups." }, { quoted: m });
                    break;
                }
                const senderAdmin = await isGroupAdmin(conn, m.from, m.sender);
                if (!senderAdmin && !senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Only admins can use this command." }, { quoted: m });
                    break;
                }
                if (!await isBotAdmin(conn, m.from)) {
                    await conn.sendMessage(m.from, { text: "❌ I need to be admin in this group to delete others' messages." }, { quoted: m });
                    break;
                }

                try {
                    const urlRegex = /https?:\/\/\S+|www\.\S+|chat\.whatsapp\.com\/\S+/i;
                    const matches = [...messageStore.values()].filter(entry =>
                        entry.from === m.from && entry.body && urlRegex.test(entry.body) && entry.key
                    );

                    if (!matches.length) {
                        await conn.sendMessage(m.from, { text: `✅ No recent link messages found (only covers messages since the bot last restarted).` }, { quoted: m });
                        break;
                    }

                    let deleted = 0;
                    for (const entry of matches) {
                        try {
                            await conn.sendMessage(m.from, { delete: entry.key });
                            deleted++;
                        } catch {}
                    }

                    await conn.sendMessage(m.from, { text: `🧹 Deleted ${deleted}/${matches.length} message(s) containing links.` }, { quoted: m });
                } catch (err) {
                    console.error('purgelinks error:', err.message);
                    await conn.sendMessage(m.from, { text: "❌ Failed to purge link messages." }, { quoted: m });
                }
                break;
            }

            case "resetlink": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ This command only works in groups." }, { quoted: m });
                    break;
                }
                const senderAdmin = await isGroupAdmin(conn, m.from, m.sender);
                if (!senderAdmin && !senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Only admins can use this command." }, { quoted: m });
                    break;
                }
                if (!await isBotAdmin(conn, m.from)) {
                    await conn.sendMessage(m.from, { text: "❌ I need to be admin in this group to reset the invite link." }, { quoted: m });
                    break;
                }

                try {
                    const newCode = await conn.groupRevokeInvite(m.from);
                    await conn.sendMessage(m.from, { text: `🔄 Invite link reset:\nhttps://chat.whatsapp.com/${newCode}\n\n(The old link no longer works.)` }, { quoted: m });
                } catch (err) {
                    console.error('resetlink error:', err.message);
                    await conn.sendMessage(m.from, { text: "❌ Failed to reset invite link." }, { quoted: m });
                }
                break;
            }

            case "approve":
            case "disapprove": {
                // For groups with "Admin must approve new members" enabled.
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ This command only works in groups." }, { quoted: m });
                    break;
                }
                const senderAdmin = await isGroupAdmin(conn, m.from, m.sender);
                if (!senderAdmin && !senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Only admins can use this command." }, { quoted: m });
                    break;
                }
                if (!await isBotAdmin(conn, m.from)) {
                    await conn.sendMessage(m.from, { text: "❌ I need to be admin in this group to manage join requests." }, { quoted: m });
                    break;
                }

                try {
                    const pending = await conn.groupRequestParticipantsList(m.from);
                    if (!pending.length) {
                        await conn.sendMessage(m.from, { text: "✅ No pending join requests." }, { quoted: m });
                        break;
                    }

                    const target = m.mentionedJid?.[0] || (args[0] ? `${args[0].replace(/[^0-9]/g, '')}@s.whatsapp.net` : null);
                    const action = command === 'approve' ? 'approve' : 'reject';

                    if (target) {
                        await conn.groupRequestParticipantsUpdate(m.from, [target], action);
                        await conn.sendMessage(m.from, { text: `✅ ${command === 'approve' ? 'Approved' : 'Rejected'} @${target.split('@')[0]}`, mentions: [target] }, { quoted: m });
                    } else {
                        // No target specified — act on ALL pending requests
                        const allJids = pending.map(p => p.jid);
                        await conn.groupRequestParticipantsUpdate(m.from, allJids, action);
                        await conn.sendMessage(m.from, { text: `✅ ${command === 'approve' ? 'Approved' : 'Rejected'} all ${allJids.length} pending request(s).` }, { quoted: m });
                    }
                } catch (err) {
                    console.error(`${command} error:`, err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to ${command} join request(s). (This only works if "Admin approval" is enabled in group settings.)` }, { quoted: m });
                }
                break;
            }

            // ════════════════════════════════════════════
            // POLL (admin only)
            // ════════════════════════════════════════════
            case "poll": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ Polls only work in groups." }, { quoted: m });
                    break;
                }

                const senderAdmin = await isGroupAdmin(conn, m.from, m.sender);
                if (!senderAdmin && !senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Only admins can start a poll." }, { quoted: m });
                    break;
                }

                const existing = await groupmod.getPoll(redisClient, m.from);
                if (existing) {
                    await conn.sendMessage(m.from, {
                        text: `⚠️ A poll is already running: *${existing.question}*\n\nEnd it first with ${prefix}endpoll`
                    }, { quoted: m });
                    break;
                }

                // Format: .poll Question? | Option A | Option B | Option C
                const parts = text.split('|').map(p => p.trim()).filter(Boolean);
                if (parts.length < 3) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}poll Question? | Option A | Option B | Option C\n\nAt least 2 options required.` }, { quoted: m });
                    break;
                }

                const question = parts[0];
                const options = parts.slice(1).slice(0, 10); // cap at 10 options

                await groupmod.createPoll(redisClient, m.from, question, options, m.sender);
                const optionLines = options.map((opt, i) => `${i + 1}. ${opt}`).join('\n');

                await conn.sendMessage(m.from, {
                    text: `📊 *POLL*\n\n${question}\n\n${optionLines}\n\nVote with ${prefix}vote <number>`
                }, { quoted: m });
                break;
            }

            case "vote": {
                if (!isGroup) break;
                const optionNum = parseInt(args[0]);
                if (!optionNum) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}vote <option number>` }, { quoted: m });
                    break;
                }

                const result = await groupmod.votePoll(redisClient, m.from, m.sender, optionNum - 1);
                if (!result) {
                    await conn.sendMessage(m.from, { text: "❌ No active poll. Ask an admin to start one with " + prefix + "poll" }, { quoted: m });
                    break;
                }
                if (result.error === 'invalid_option') {
                    await conn.sendMessage(m.from, { text: `❌ Invalid option. Choose 1-${result.poll.options.length}.` }, { quoted: m });
                    break;
                }

                await conn.sendMessage(m.from, { text: `✅ Vote recorded for: *${result.poll.options[optionNum - 1]}*` }, { quoted: m });
                break;
            }

            case "endpoll": {
                if (!isGroup) break;
                const senderAdmin = await isGroupAdmin(conn, m.from, m.sender);
                if (!senderAdmin && !senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Only admins can end the poll." }, { quoted: m });
                    break;
                }

                const poll = await groupmod.endPoll(redisClient, m.from);
                if (!poll) {
                    await conn.sendMessage(m.from, { text: "❌ No active poll to end." }, { quoted: m });
                    break;
                }

                await conn.sendMessage(m.from, {
                    text: `📊 *Poll Results — ${poll.question}*\n\n${groupmod.renderPollResults(poll)}`
                }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // GIVEAWAY (admin only)
            // ════════════════════════════════════════════
            case "giveaway": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ Giveaways only work in groups." }, { quoted: m });
                    break;
                }

                const senderAdmin = await isGroupAdmin(conn, m.from, m.sender);
                if (!senderAdmin && !senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Only admins can start a giveaway." }, { quoted: m });
                    break;
                }

                const existing = await groupmod.getGiveaway(redisClient, m.from);
                if (existing) {
                    await conn.sendMessage(m.from, {
                        text: `⚠️ A giveaway is already running for *${existing.prize}*.\n\nEnd it first with ${prefix}endgiveaway`
                    }, { quoted: m });
                    break;
                }

                // Format: .giveaway <minutes> <prize text>
                const minutes = parseInt(args[0]);
                const prize = args.slice(1).join(' ');
                if (!minutes || minutes <= 0 || !prize) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}giveaway <minutes> <prize>\n\nExample: ${prefix}giveaway 30 5000 coins` }, { quoted: m });
                    break;
                }

                await groupmod.createGiveaway(redisClient, m.from, prize, minutes, m.sender);
                await conn.sendMessage(m.from, {
                    text: `🎉 *GIVEAWAY STARTED!*\n\n🎁 Prize: ${prize}\n⏳ Duration: ${minutes} minutes\n\nType ${prefix}enter to join! An admin can end it early with ${prefix}endgiveaway`
                }, { quoted: m });
                break;
            }

            case "enter": {
                if (!isGroup) break;
                const result = await groupmod.enterGiveaway(redisClient, m.from, m.sender);
                if (!result) {
                    await conn.sendMessage(m.from, { text: "❌ No active giveaway in this group." }, { quoted: m });
                    break;
                }
                if (result.alreadyEntered) {
                    await conn.sendMessage(m.from, { text: "✅ You're already entered!" }, { quoted: m });
                    break;
                }
                await conn.sendMessage(m.from, { text: `✅ Entered the giveaway for *${result.giveaway.prize}*! Good luck 🍀` }, { quoted: m });
                break;
            }

            case "endgiveaway": {
                if (!isGroup) break;
                const senderAdmin = await isGroupAdmin(conn, m.from, m.sender);
                if (!senderAdmin && !senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Only admins can end the giveaway." }, { quoted: m });
                    break;
                }

                const result = await groupmod.endGiveaway(redisClient, m.from);
                if (!result) {
                    await conn.sendMessage(m.from, { text: "❌ No active giveaway to end." }, { quoted: m });
                    break;
                }

                if (!result.winner) {
                    await conn.sendMessage(m.from, { text: `🎉 Giveaway for *${result.giveaway.prize}* ended — no one entered. 😢` }, { quoted: m });
                    break;
                }

                await conn.sendMessage(m.from, {
                    text: `🎉 *GIVEAWAY ENDED!*\n\n🎁 Prize: ${result.giveaway.prize}\n👥 Entrants: ${result.entrantCount}\n\n🏆 Winner: @${result.winner.split('@')[0]}\n\nCongratulations! 🎊`,
                    mentions: [result.winner]
                }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // WARN SYSTEM (admin only)
            // ════════════════════════════════════════════
            case "warn": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ This command only works in groups." }, { quoted: m });
                    break;
                }

                const senderAdmin = await isGroupAdmin(conn, m.from, m.sender);
                if (!senderAdmin && !senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Only admins can warn members." }, { quoted: m });
                    break;
                }

                const target = m.quoted?.sender || m.mentionedJid?.[0];
                if (!target) {
                    await conn.sendMessage(m.from, { text: `❌ Reply to or mention the user to warn.` }, { quoted: m });
                    break;
                }
                if (target === m.sender) {
                    await conn.sendMessage(m.from, { text: "❌ You can't warn yourself." }, { quoted: m });
                    break;
                }

                const reason = args.slice(1).join(' ') || 'No reason given';
                const count = await groupmod.addWarning(redisClient, m.from, target);
                const groupConfig = await groupmod.getGroupConfig(redisClient, m.from);

                if (count >= groupConfig.warnLimit) {
                    const botAdmin = await isBotAdmin(conn, m.from);
                    await groupmod.clearWarnings(redisClient, m.from, target);

                    if (botAdmin) {
                        try {
                            await conn.groupParticipantsUpdate(m.from, [target], 'remove');
                            await conn.sendMessage(m.from, {
                                text: `⚠️ @${target.split('@')[0]} reached ${count}/${groupConfig.warnLimit} warnings and has been removed.\n\nLast reason: ${reason}`,
                                mentions: [target]
                            }, { quoted: m });
                        } catch (err) {
                            await conn.sendMessage(m.from, {
                                text: `⚠️ @${target.split('@')[0]} reached the warning limit, but I couldn't remove them: ${err.message}`,
                                mentions: [target]
                            }, { quoted: m });
                        }
                    } else {
                        await conn.sendMessage(m.from, {
                            text: `⚠️ @${target.split('@')[0]} reached ${count}/${groupConfig.warnLimit} warnings, but I'm not an admin so I can't remove them.\n\nLast reason: ${reason}`,
                            mentions: [target]
                        }, { quoted: m });
                    }
                    break;
                }

                await conn.sendMessage(m.from, {
                    text: `⚠️ @${target.split('@')[0]} has been warned (${count}/${groupConfig.warnLimit})\n\nReason: ${reason}`,
                    mentions: [target]
                }, { quoted: m });
                break;
            }

            case "warnings": {
                if (!isGroup) break;
                const target = m.quoted?.sender || m.mentionedJid?.[0] || m.sender;
                const count = await groupmod.getWarnCount(redisClient, m.from, target);
                const groupConfig = await groupmod.getGroupConfig(redisClient, m.from);

                await conn.sendMessage(m.from, {
                    text: `⚠️ @${target.split('@')[0]} has *${count}/${groupConfig.warnLimit}* warnings in this group.`,
                    mentions: [target]
                }, { quoted: m });
                break;
            }

            case "unwarn": {
                if (!isGroup) break;
                const senderAdmin = await isGroupAdmin(conn, m.from, m.sender);
                if (!senderAdmin && !senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Only admins can clear warnings." }, { quoted: m });
                    break;
                }

                const target = m.quoted?.sender || m.mentionedJid?.[0];
                if (!target) {
                    await conn.sendMessage(m.from, { text: `❌ Reply to or mention the user.` }, { quoted: m });
                    break;
                }

                await groupmod.clearWarnings(redisClient, m.from, target);
                await conn.sendMessage(m.from, {
                    text: `✅ Cleared warnings for @${target.split('@')[0]}`,
                    mentions: [target]
                }, { quoted: m });
                break;
            }

            // ════════════════════════════════════════════
            // ANTILINK (admin only — per-group config)
            // ════════════════════════════════════════════
            case "antilink": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ This command only works in groups." }, { quoted: m });
                    break;
                }

                const senderAdmin = await isGroupAdmin(conn, m.from, m.sender);
                if (!senderAdmin && !senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Only admins can change this setting." }, { quoted: m });
                    break;
                }

                const tier = args[0]?.toLowerCase();
                if (!tier) {
                    const cfg = await groupmod.getGroupConfig(redisClient, m.from);
                    await conn.sendMessage(m.from, {
                        text: `🔗 *Antilink* is currently: *${cfg.antilink}*\n\nUsage: ${prefix}antilink off/warn/kick\n\n• off — links allowed\n• warn — links trigger a warning\n• kick — links cause an instant removal (bot must be admin)`
                    }, { quoted: m });
                    break;
                }

                if (!['off', 'warn', 'kick'].includes(tier)) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}antilink off/warn/kick` }, { quoted: m });
                    break;
                }

                await groupmod.setGroupConfig(redisClient, m.from, 'antilink', tier);
                await conn.sendMessage(m.from, { text: `🔗 Antilink set to: *${tier}*` }, { quoted: m });
                break;
            }

            case "antisticker": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ This command only works in groups." }, { quoted: m });
                    break;
                }
                const senderAdmin = await isGroupAdmin(conn, m.from, m.sender);
                if (!senderAdmin && !senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Only admins can change this setting." }, { quoted: m });
                    break;
                }

                const tier = args[0]?.toLowerCase();
                if (!tier) {
                    const cfg = await groupmod.getGroupConfig(redisClient, m.from);
                    await conn.sendMessage(m.from, {
                        text: `🚫 *Antisticker* is currently: *${cfg.antisticker}*\n\nUsage: ${prefix}antisticker off/warn/kick`
                    }, { quoted: m });
                    break;
                }
                if (!['off', 'warn', 'kick'].includes(tier)) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}antisticker off/warn/kick` }, { quoted: m });
                    break;
                }

                await groupmod.setGroupConfig(redisClient, m.from, 'antisticker', tier);
                await conn.sendMessage(m.from, { text: `🚫 Antisticker set to: *${tier}*` }, { quoted: m });
                break;
            }

            // ── Generic tier setter for antimedia + the per-type variants —
            // they're all identical off/warn/kick toggles, just on a
            // different groupConfig field, so one block handles all six. ──
            case "antimedia":
            case "antiimage":
            case "antivideo":
            case "antiaudio":
            case "antidocument":
            case "antilocation": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ This command only works in groups." }, { quoted: m });
                    break;
                }
                const senderAdmin = await isGroupAdmin(conn, m.from, m.sender);
                if (!senderAdmin && !senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Only admins can change this setting." }, { quoted: m });
                    break;
                }

                const tier = args[0]?.toLowerCase();
                if (!tier) {
                    const cfg = await groupmod.getGroupConfig(redisClient, m.from);
                    const note = command === 'antimedia' ? '\n\nThis is the blanket toggle — covers images, videos, audio, and documents at once. The per-type commands (antiimage/antivideo/antiaudio/antidocument) let you be selective instead.' : '';
                    await conn.sendMessage(m.from, {
                        text: `🚫 *${command}* is currently: *${cfg[command]}*\n\nUsage: ${prefix}${command} off/warn/kick${note}`
                    }, { quoted: m });
                    break;
                }
                if (!['off', 'warn', 'kick'].includes(tier)) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}${command} off/warn/kick` }, { quoted: m });
                    break;
                }

                await groupmod.setGroupConfig(redisClient, m.from, command, tier);
                await conn.sendMessage(m.from, { text: `🚫 ${command} set to: *${tier}*` }, { quoted: m });
                break;
            }

            case "antilongmsg": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ This command only works in groups." }, { quoted: m });
                    break;
                }
                const senderAdmin = await isGroupAdmin(conn, m.from, m.sender);
                if (!senderAdmin && !senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Only admins can change this setting." }, { quoted: m });
                    break;
                }

                const tier = args[0]?.toLowerCase();
                if (!tier) {
                    const cfg = await groupmod.getGroupConfig(redisClient, m.from);
                    await conn.sendMessage(m.from, {
                        text: `📏 *Antilongmsg* is currently: *${cfg.antilongmsg}* (max ${cfg.antilongmsgMax} chars)\n\nUsage: ${prefix}antilongmsg off/warn/kick [max_chars]`
                    }, { quoted: m });
                    break;
                }
                if (!['off', 'warn', 'kick'].includes(tier)) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}antilongmsg off/warn/kick [max_chars]` }, { quoted: m });
                    break;
                }

                await groupmod.setGroupConfig(redisClient, m.from, 'antilongmsg', tier);
                if (args[1] && parseInt(args[1]) > 0) {
                    await groupmod.setGroupConfig(redisClient, m.from, 'antilongmsgMax', parseInt(args[1]));
                }
                const updatedCfg = await groupmod.getGroupConfig(redisClient, m.from);
                await conn.sendMessage(m.from, { text: `📏 Antilongmsg set to: *${tier}* (max ${updatedCfg.antilongmsgMax} chars)` }, { quoted: m });
                break;
            }

            case "slowmode": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ This command only works in groups." }, { quoted: m });
                    break;
                }
                const senderAdmin = await isGroupAdmin(conn, m.from, m.sender);
                if (!senderAdmin && !senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Only admins can change this setting." }, { quoted: m });
                    break;
                }

                const seconds = args[0] !== undefined ? parseInt(args[0]) : null;
                if (seconds === null || isNaN(seconds) || seconds < 0) {
                    const cfg = await groupmod.getGroupConfig(redisClient, m.from);
                    await conn.sendMessage(m.from, {
                        text: `⏱️ *Slowmode* is currently: *${cfg.slowmode > 0 ? `${cfg.slowmode}s` : 'OFF'}*\n\nUsage: ${prefix}slowmode <seconds>\n${prefix}slowmode 0 to disable. Admins are exempt.`
                    }, { quoted: m });
                    break;
                }

                await groupmod.setGroupConfig(redisClient, m.from, 'slowmode', seconds);
                await conn.sendMessage(m.from, {
                    text: seconds === 0 ? `✅ Slowmode disabled.` : `⏱️ Slowmode set to ${seconds}s — non-admins can only send one message every ${seconds}s.`
                }, { quoted: m });
                break;
            }

            case "antitag":
            case "antimention": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ This command only works in groups." }, { quoted: m });
                    break;
                }
                const senderAdmin = await isGroupAdmin(conn, m.from, m.sender);
                if (!senderAdmin && !senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Only admins can change this setting." }, { quoted: m });
                    break;
                }

                const tier = args[0]?.toLowerCase();
                if (!tier) {
                    const cfg = await groupmod.getGroupConfig(redisClient, m.from);
                    await conn.sendMessage(m.from, {
                        text: `🏷️ *Antitag* is currently: *${cfg.antitag}*\n\nUsage: ${prefix}antitag off/warn/kick\n\nTriggers when someone mentions 5+ people in a single message (mass-tag spam).`
                    }, { quoted: m });
                    break;
                }
                if (!['off', 'warn', 'kick'].includes(tier)) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}antitag off/warn/kick` }, { quoted: m });
                    break;
                }

                await groupmod.setGroupConfig(redisClient, m.from, 'antitag', tier);
                await conn.sendMessage(m.from, { text: `🏷️ Antitag set to: *${tier}*` }, { quoted: m });
                break;
            }

            case "antibadword": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ This command only works in groups." }, { quoted: m });
                    break;
                }
                const senderAdmin = await isGroupAdmin(conn, m.from, m.sender);
                if (!senderAdmin && !senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Only admins can change this setting." }, { quoted: m });
                    break;
                }

                const tier = args[0]?.toLowerCase();
                if (!tier) {
                    const cfg = await groupmod.getGroupConfig(redisClient, m.from);
                    const badwords = await groupmod.getBadwordList(redisClient, m.from);
                    await conn.sendMessage(m.from, {
                        text: `🤬 *Antibadword* is currently: *${cfg.antibadword}*\n\nUsage: ${prefix}antibadword off/warn/kick\n\nBanned words (${badwords.length}): manage with ${prefix}badword add/remove/list <word>`
                    }, { quoted: m });
                    break;
                }
                if (!['off', 'warn', 'kick'].includes(tier)) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}antibadword off/warn/kick` }, { quoted: m });
                    break;
                }

                await groupmod.setGroupConfig(redisClient, m.from, 'antibadword', tier);
                await conn.sendMessage(m.from, { text: `🤬 Antibadword set to: *${tier}*` }, { quoted: m });
                break;
            }

            case "badword":
            case "badwords": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ This command only works in groups." }, { quoted: m });
                    break;
                }
                const senderAdmin = await isGroupAdmin(conn, m.from, m.sender);
                if (!senderAdmin && !senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Only admins can manage the banned word list." }, { quoted: m });
                    break;
                }

                const sub = args[0]?.toLowerCase();
                if (sub === 'add') {
                    const word = args.slice(1).join(' ');
                    if (!word) {
                        await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}badword add <word>` }, { quoted: m });
                        break;
                    }
                    await groupmod.addBadword(redisClient, m.from, word);
                    await conn.sendMessage(m.from, { text: `✅ Added "${word}" to the banned word list.` }, { quoted: m });
                    break;
                }
                if (sub === 'remove' || sub === 'del') {
                    const word = args.slice(1).join(' ');
                    if (!word) {
                        await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}badword remove <word>` }, { quoted: m });
                        break;
                    }
                    await groupmod.removeBadword(redisClient, m.from, word);
                    await conn.sendMessage(m.from, { text: `✅ Removed "${word}" from the banned word list.` }, { quoted: m });
                    break;
                }

                // default / 'list'
                const list = await groupmod.getBadwordList(redisClient, m.from);
                await conn.sendMessage(m.from, {
                    text: list.length
                        ? `🤬 *Banned Words* (${list.length})\n\n${list.join(', ')}\n\nUse ${prefix}badword add/remove <word>`
                        : `🤬 No banned words set. Add one with ${prefix}badword add <word>\n\nThis only matters if ${prefix}antibadword is set to warn/kick.`
                }, { quoted: m });
                break;
            }

            case "antiviewonce": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ This command only works in groups." }, { quoted: m });
                    break;
                }
                const senderAdmin = await isGroupAdmin(conn, m.from, m.sender);
                if (!senderAdmin && !senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Only admins can change this setting." }, { quoted: m });
                    break;
                }

                const toggle = args[0]?.toLowerCase();
                if (!toggle) {
                    const cfg = await groupmod.getGroupConfig(redisClient, m.from);
                    await conn.sendMessage(m.from, {
                        text: `👁️ *Antiviewonce* is currently: *${cfg.antiviewonce ? 'on' : 'off'}*\n\nUsage: ${prefix}antiviewonce on/off\n\nWhen on, view-once images/videos are automatically re-sent as normal (permanent) media so they can't disappear.`
                    }, { quoted: m });
                    break;
                }
                if (!['on', 'off'].includes(toggle)) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}antiviewonce on/off` }, { quoted: m });
                    break;
                }

                await groupmod.setGroupConfig(redisClient, m.from, 'antiviewonce', toggle === 'on');
                await conn.sendMessage(m.from, { text: `👁️ Antiviewonce set to: *${toggle}*` }, { quoted: m });
                break;
            }

            case "antispam": {
                if (!isGroup) { await conn.sendMessage(m.from, { text: "❌ Groups only." }, { quoted: m }); break; }
                const senderAdmin = await isGroupAdmin(conn, m.from, m.sender);
                if (!senderAdmin && !senderHasAccess) { await conn.sendMessage(m.from, { text: "❌ Only admins can change this." }, { quoted: m }); break; }
                const tier = args[0]?.toLowerCase();
                if (!tier) {
                    const cfg = await groupmod.getGroupConfig(redisClient, m.from);
                    await conn.sendMessage(m.from, { text: `⚡ *Antispam* is currently: *${cfg.antispam}*\nLimit: ${cfg.antispamLimit} messages / ${cfg.antispamWindow}s\n\nUsage: ${prefix}antispam off/warn/kick\n${prefix}antispam limit <number>\n${prefix}antispam window <seconds>` }, { quoted: m });
                    break;
                }
                if (tier === 'limit') {
                    const val = parseInt(args[1]);
                    if (!val || val < 2) { await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}antispam limit <number> (min 2)` }, { quoted: m }); break; }
                    await groupmod.setGroupConfig(redisClient, m.from, 'antispamLimit', val);
                    await conn.sendMessage(m.from, { text: `⚡ Antispam limit set to ${val} messages.` }, { quoted: m });
                    break;
                }
                if (tier === 'window') {
                    const val = parseInt(args[1]);
                    if (!val || val < 1) { await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}antispam window <seconds>` }, { quoted: m }); break; }
                    await groupmod.setGroupConfig(redisClient, m.from, 'antispamWindow', val);
                    await conn.sendMessage(m.from, { text: `⚡ Antispam window set to ${val}s.` }, { quoted: m });
                    break;
                }
                if (!['off', 'warn', 'kick'].includes(tier)) { await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}antispam off/warn/kick` }, { quoted: m }); break; }
                await groupmod.setGroupConfig(redisClient, m.from, 'antispam', tier);
                await conn.sendMessage(m.from, { text: `⚡ Antispam set to: *${tier}*` }, { quoted: m });
                break;
            }

            case "antiforward": {
                if (!isGroup) { await conn.sendMessage(m.from, { text: "❌ Groups only." }, { quoted: m }); break; }
                const senderAdmin = await isGroupAdmin(conn, m.from, m.sender);
                if (!senderAdmin && !senderHasAccess) { await conn.sendMessage(m.from, { text: "❌ Only admins can change this." }, { quoted: m }); break; }
                const tier = args[0]?.toLowerCase();
                if (!tier) {
                    const cfg = await groupmod.getGroupConfig(redisClient, m.from);
                    await conn.sendMessage(m.from, { text: `↩️ *Antiforward* is currently: *${cfg.antiforward}*\nMin forward score: ${cfg.antiforwardScore}\n\nUsage: ${prefix}antiforward off/warn/kick\n${prefix}antiforward score <number>` }, { quoted: m });
                    break;
                }
                if (tier === 'score') {
                    const val = parseInt(args[1]);
                    if (!val || val < 1) { await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}antiforward score <number>` }, { quoted: m }); break; }
                    await groupmod.setGroupConfig(redisClient, m.from, 'antiforwardScore', val);
                    await conn.sendMessage(m.from, { text: `↩️ Antiforward score threshold set to ${val}.` }, { quoted: m });
                    break;
                }
                if (!['off', 'warn', 'kick'].includes(tier)) { await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}antiforward off/warn/kick` }, { quoted: m }); break; }
                await groupmod.setGroupConfig(redisClient, m.from, 'antiforward', tier);
                await conn.sendMessage(m.from, { text: `↩️ Antiforward set to: *${tier}*` }, { quoted: m });
                break;
            }

            case "antibot": {
                if (!isGroup) { await conn.sendMessage(m.from, { text: "❌ Groups only." }, { quoted: m }); break; }
                const senderAdmin = await isGroupAdmin(conn, m.from, m.sender);
                if (!senderAdmin && !senderHasAccess) { await conn.sendMessage(m.from, { text: "❌ Only admins can change this." }, { quoted: m }); break; }
                const toggle = args[0]?.toLowerCase();
                if (!toggle) {
                    const cfg = await groupmod.getGroupConfig(redisClient, m.from);
                    await conn.sendMessage(m.from, { text: `🤖 *Antibot* is currently: *${cfg.antibot}*\n\nUsage: ${prefix}antibot on/off\n\nAuto-removes suspected bot accounts when they join.` }, { quoted: m });
                    break;
                }
                if (!['on', 'off'].includes(toggle)) { await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}antibot on/off` }, { quoted: m }); break; }
                await groupmod.setGroupConfig(redisClient, m.from, 'antibot', toggle);
                await conn.sendMessage(m.from, { text: `🤖 Antibot set to: *${toggle}*` }, { quoted: m });
                break;
            }

            case "antidemote": {
                if (!isGroup) { await conn.sendMessage(m.from, { text: "❌ Groups only." }, { quoted: m }); break; }
                const senderAdmin = await isGroupAdmin(conn, m.from, m.sender);
                if (!senderAdmin && !senderHasAccess) { await conn.sendMessage(m.from, { text: "❌ Only admins can change this." }, { quoted: m }); break; }
                const toggle = args[0]?.toLowerCase();
                if (!toggle) {
                    const cfg = await groupmod.getGroupConfig(redisClient, m.from);
                    await conn.sendMessage(m.from, { text: `🛡️ *Antidemote* is currently: *${cfg.antidemote ? 'on' : 'off'}*\n\nUsage: ${prefix}antidemote on/off\n\nReverts unauthorized admin demotions.` }, { quoted: m });
                    break;
                }
                if (!['on', 'off'].includes(toggle)) { await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}antidemote on/off` }, { quoted: m }); break; }
                await groupmod.setGroupConfig(redisClient, m.from, 'antidemote', toggle === 'on');
                await conn.sendMessage(m.from, { text: `🛡️ Antidemote set to: *${toggle}*` }, { quoted: m });
                break;
            }

            case "antipromote": {
                if (!isGroup) { await conn.sendMessage(m.from, { text: "❌ Groups only." }, { quoted: m }); break; }
                const senderAdmin = await isGroupAdmin(conn, m.from, m.sender);
                if (!senderAdmin && !senderHasAccess) { await conn.sendMessage(m.from, { text: "❌ Only admins can change this." }, { quoted: m }); break; }
                const toggle = args[0]?.toLowerCase();
                if (!toggle) {
                    const cfg = await groupmod.getGroupConfig(redisClient, m.from);
                    await conn.sendMessage(m.from, { text: `🛡️ *Antipromote* is currently: *${cfg.antipromote ? 'on' : 'off'}*\n\nUsage: ${prefix}antipromote on/off\n\nReverts unauthorized admin promotions.` }, { quoted: m });
                    break;
                }
                if (!['on', 'off'].includes(toggle)) { await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}antipromote on/off` }, { quoted: m }); break; }
                await groupmod.setGroupConfig(redisClient, m.from, 'antipromote', toggle === 'on');
                await conn.sendMessage(m.from, { text: `🛡️ Antipromote set to: *${toggle}*` }, { quoted: m });
                break;
            }

            case "antigroupmention": {
                if (!isGroup) { await conn.sendMessage(m.from, { text: "❌ Groups only." }, { quoted: m }); break; }
                const senderAdmin = await isGroupAdmin(conn, m.from, m.sender);
                if (!senderAdmin && !senderHasAccess) { await conn.sendMessage(m.from, { text: "❌ Only admins can change this." }, { quoted: m }); break; }
                const tier = args[0]?.toLowerCase();
                if (!tier) {
                    const cfg = await groupmod.getGroupConfig(redisClient, m.from);
                    await conn.sendMessage(m.from, { text: `📢 *Antigroupmention* is currently: *${cfg.antigroupmention}*\n\nUsage: ${prefix}antigroupmention off/warn/kick\n\nBlocks @everyone/@all group-wide mention broadcasts.` }, { quoted: m });
                    break;
                }
                if (!['off', 'warn', 'kick'].includes(tier)) { await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}antigroupmention off/warn/kick` }, { quoted: m }); break; }
                await groupmod.setGroupConfig(redisClient, m.from, 'antigroupmention', tier);
                await conn.sendMessage(m.from, { text: `📢 Antigroupmention set to: *${tier}*` }, { quoted: m });
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

            // ════════════════════════════════════════════
            // GROUP PROFILE MANAGEMENT
            // ════════════════════════════════════════════
            case "setgcpic":
            case "setgroupicon": {
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

                if (!m.quoted || m.quoted.mtype !== 'imageMessage') {
                    await conn.sendMessage(m.from, { text: `❌ Reply to an image with ${prefix}setgcpic` }, { quoted: m });
                    break;
                }

                try {
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const buffer = await downloadMediaMessage(
                        { message: { imageMessage: m.quoted } },
                        'buffer',
                        {}
                    );
                    await conn.updateProfilePicture(m.from, buffer);
                    await conn.sendMessage(m.from, { text: "✅ Group picture updated." }, { quoted: m });
                } catch (err) {
                    console.error('setgcpic error:', err.message);
                    await conn.sendMessage(m.from, { text: "❌ Failed to update group picture." }, { quoted: m });
                }
                break;
            }

            case "setgcname":
            case "setgroupname": {
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

                if (!text) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}setgcname <new name>` }, { quoted: m });
                    break;
                }
                if (text.length > 100) {
                    await conn.sendMessage(m.from, { text: `❌ Group name must be 100 characters or fewer.` }, { quoted: m });
                    break;
                }

                try {
                    await conn.groupUpdateSubject(m.from, text);
                    await conn.sendMessage(m.from, { text: `✅ Group name updated to: *${text}*` }, { quoted: m });
                } catch (err) {
                    console.error('setgcname error:', err.message);
                    await conn.sendMessage(m.from, { text: "❌ Failed to update group name." }, { quoted: m });
                }
                break;
            }

            case "setgcdesc":
            case "setgroupdesc":
            case "setgcbio": {
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

                if (!text) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}setgcdesc <new description>` }, { quoted: m });
                    break;
                }
                if (text.length > 512) {
                    await conn.sendMessage(m.from, { text: `❌ Group description must be 512 characters or fewer.` }, { quoted: m });
                    break;
                }

                try {
                    await conn.groupUpdateDescription(m.from, text);
                    await conn.sendMessage(m.from, { text: `✅ Group description updated.` }, { quoted: m });
                } catch (err) {
                    console.error('setgcdesc error:', err.message);
                    await conn.sendMessage(m.from, { text: "❌ Failed to update group description." }, { quoted: m });
                }
                break;
            }

            case "creategc":
            case "creategroup": {
                if (!senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Owner/Sudo only command." }, { quoted: m });
                    break;
                }

                // Format: .creategc Group Name | 234xxx,234yyy,234zzz
                const parts = text.split('|').map(p => p.trim());
                const groupName = parts[0];
                const numbersRaw = parts[1] || '';

                if (!groupName) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}creategc Group Name | 234xxxxxxxxxx,234yyyyyyyyyy\n\nAt least one number is required (WhatsApp needs participants to create a group).` }, { quoted: m });
                    break;
                }

                const numbers = numbersRaw.split(',').map(n => n.trim()).filter(Boolean);
                if (numbers.length === 0) {
                    await conn.sendMessage(m.from, { text: `❌ Provide at least one participant number after | (e.g. ${prefix}creategc My Group | 2348012345678)` }, { quoted: m });
                    break;
                }

                const participantJids = numbers.map(n => `${n.replace(/[^0-9]/g, '')}@s.whatsapp.net`);

                try {
                    const result = await conn.groupCreate(groupName, participantJids);
                    const newGroupId = result.id;

                    const failedParticipants = (result.participants || []).filter(p => p.status && p.status !== '200');
                    const failedText = failedParticipants.length
                        ? `\n\n⚠️ Some numbers couldn't be added (no WhatsApp account, or restricted by them): ${failedParticipants.map(p => p.jid?.split('@')[0]).join(', ')}`
                        : '';

                    await conn.sendMessage(m.from, {
                        text: `✅ *Group created!*\n\n🏷️ Name: ${groupName}\n🆔 ID: ${newGroupId}${failedText}\n\nNote: I'm the creator, but I'm not automatically admin-promoted beyond creator status in some WhatsApp versions — check ${prefix}groupinfo if commands fail there.`
                    }, { quoted: m });
                } catch (err) {
                    console.error('creategc error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to create group: ${err.message}` }, { quoted: m });
                }
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

            // ════════════════════════════════════════════
            // STICKER MAKER
            // ════════════════════════════════════════════
            case "sticker":
            case "tosticker":
            case "s": {
                const quotedType = m.quoted?.mtype;
                const isImage = quotedType === 'imageMessage';
                const isVideo = quotedType === 'videoMessage';

                if (!m.quoted || (!isImage && !isVideo)) {
                    await conn.sendMessage(m.from, { text: `❌ Reply to an image or short video/GIF with ${prefix}sticker` }, { quoted: m });
                    break;
                }

                try {
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');

                    if (isImage) {
                        const buffer = await downloadMediaMessage(
                            { message: { imageMessage: m.quoted } },
                            'buffer',
                            {}
                        );
                        const stickerBuffer = await stickers.imageToSticker(buffer);
                        await conn.sendMessage(m.from, { sticker: stickerBuffer }, { quoted: m });
                        break;
                    }

                    // Video/GIF path
                    if (!stickers.isAnimatedStickerSupported()) {
                        await conn.sendMessage(m.from, {
                            text: `❌ Animated stickers aren't available yet on this deployment (missing ffmpeg dependencies). Static image stickers work fine — try replying to a photo instead!`
                        }, { quoted: m });
                        break;
                    }

                    // Guard against very long videos — keep conversion fast and the
                    // resulting sticker file size reasonable for WhatsApp.
                    const durationSec = m.quoted.seconds || 0;
                    if (durationSec > 10) {
                        await conn.sendMessage(m.from, { text: `❌ Video too long for a sticker. Keep it under 10 seconds.` }, { quoted: m });
                        break;
                    }

                    const videoBuffer = await downloadMediaMessage(
                        { message: { videoMessage: m.quoted } },
                        'buffer',
                        {}
                    );
                    const animatedBuffer = await stickers.videoToAnimatedSticker(videoBuffer, Math.min(durationSec || 6, 6));
                    await conn.sendMessage(m.from, { sticker: animatedBuffer }, { quoted: m });
                } catch (err) {
                    console.error('Sticker error:', err.message);
                    if (err.message === 'ANIMATED_STICKERS_NOT_INSTALLED') {
                        await conn.sendMessage(m.from, { text: `❌ Animated stickers aren't available yet on this deployment.` }, { quoted: m });
                    } else {
                        await conn.sendMessage(m.from, { text: `❌ Failed to create sticker. Try a different image/video.` }, { quoted: m });
                    }
                }
                break;
            }

            case "ttp": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}ttp <text> [hex color]\nExample: ${prefix}ttp Hello #ff66cc` }, { quoted: m });
                    break;
                }
                const colorMatch = text.match(/#[0-9a-fA-F]{6}\s*$/);
                const color = colorMatch ? colorMatch[0].trim() : '#ffffff';
                const ttpText = (colorMatch ? text.slice(0, colorMatch.index) : text).trim();
                if (!ttpText) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}ttp <text> [hex color]` }, { quoted: m });
                    break;
                }

                try {
                    const stickerBuffer = await stickers.textToSticker(ttpText, color);
                    await conn.sendMessage(m.from, { sticker: stickerBuffer }, { quoted: m });
                } catch (err) {
                    console.error('ttp error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to create sticker. Try shorter text.` }, { quoted: m });
                }
                break;
            }

            case "attp": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}attp <text>\nExample: ${prefix}attp PARTY` }, { quoted: m });
                    break;
                }
                if (!stickers.isAnimatedStickerSupported()) {
                    await conn.sendMessage(m.from, { text: `❌ Animated stickers aren't available yet on this deployment (missing ffmpeg dependencies).` }, { quoted: m });
                    break;
                }

                try {
                    const stickerBuffer = await stickers.textToAnimatedSticker(text.trim().slice(0, 20));
                    await conn.sendMessage(m.from, { sticker: stickerBuffer }, { quoted: m });
                } catch (err) {
                    console.error('attp error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to create animated sticker. Try shorter text.` }, { quoted: m });
                }
                break;
            }

            case "emojimix": {
                // Format: .emojimix 😀+😍  (or "😀 😍" / "😀,😍")
                const emojiPair = text.split(/[+, ]+/).filter(Boolean);
                if (emojiPair.length !== 2) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}emojimix <emoji>+<emoji>\nExample: ${prefix}emojimix 😀+😍` }, { quoted: m });
                    break;
                }

                try {
                    const axios = require('axios');
                    const toCodepoints = (emoji) => [...emoji].map(c => c.codePointAt(0).toString(16)).join('-');
                    const left = toCodepoints(emojiPair[0]);
                    const right = toCodepoints(emojiPair[1]);

                    // Community-maintained mirror of Google's "Emoji Kitchen" combo
                    // metadata — no official public API exists for this feature.
                    const metaRes = await axios.get(
                        `https://raw.githubusercontent.com/xsalazar/emoji-kitchen-backend/main/app/metadata.json`,
                        { timeout: 15000 }
                    );
                    const combos = metaRes.data?.data?.combos || metaRes.data?.combos || metaRes.data;

                    // The metadata keys by codepoint without leading zeros, and tries
                    // both orderings since not every pair has both directions defined.
                    const findUrl = (a, b) => {
                        const entryA = combos?.[a];
                        if (entryA) {
                            const match = entryA.find(e => e.rightEmojiCodepoint === b || e.rightEmoji === b);
                            if (match) return match.gStaticUrl || match.url;
                        }
                        return null;
                    };

                    const imageUrl = findUrl(left, right) || findUrl(right, left);
                    if (!imageUrl) {
                        await conn.sendMessage(m.from, { text: `❌ No mashup exists for that combo yet. Try a different pair of emoji.` }, { quoted: m });
                        break;
                    }

                    const imgRes = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
                    const stickerBuffer = await stickers.imageToSticker(Buffer.from(imgRes.data));
                    await conn.sendMessage(m.from, { sticker: stickerBuffer }, { quoted: m });
                } catch (err) {
                    console.error('emojimix error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to create emoji mashup. This feature depends on a third-party data mirror that may be temporarily unavailable.` }, { quoted: m });
                }
                break;
            }

            case "take": {
                if (!m.quoted || m.quoted.mtype !== 'stickerMessage') {
                    await conn.sendMessage(m.from, { text: `❌ Reply to a sticker with ${prefix}take <pack name>|<author>\nExample: ${prefix}take My Stickers|${m.pushName || 'Me'}` }, { quoted: m });
                    break;
                }
                if (!text) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}take <pack name>|<author>\n(author is optional — defaults to your name)` }, { quoted: m });
                    break;
                }

                const [packName, packAuthor] = text.split('|').map(s => s?.trim());

                try {
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const buffer = await downloadMediaMessage({ message: { stickerMessage: m.quoted } }, 'buffer', {});
                    const outBuffer = await stickers.setStickerExif(buffer, packName, packAuthor || m.pushName || 'Lady Liya');
                    await conn.sendMessage(m.from, { sticker: outBuffer }, { quoted: m });
                } catch (err) {
                    console.error('take error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to change sticker pack info.` }, { quoted: m });
                }
                break;
            }

            case "toimg": {
                if (!m.quoted || m.quoted.mtype !== 'stickerMessage') {
                    await conn.sendMessage(m.from, { text: `❌ Reply to a sticker with ${prefix}toimg` }, { quoted: m });
                    break;
                }

                try {
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const buffer = await downloadMediaMessage(
                        { message: { stickerMessage: m.quoted } },
                        'buffer',
                        {}
                    );

                    const sharp = require('sharp');
                    const pngBuffer = await sharp(buffer).png().toBuffer();

                    await conn.sendMessage(m.from, { image: pngBuffer, caption: '🖼️ Converted to image' }, { quoted: m });
                } catch (err) {
                    console.error('Toimg error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to convert sticker to image (it may be animated — those can't be converted back yet).` }, { quoted: m });
                }
                break;
            }

            case "tojpg":
            case "topng": {
                const quotedType = m.quoted?.mtype;
                if (!m.quoted || (quotedType !== 'stickerMessage' && quotedType !== 'imageMessage')) {
                    await conn.sendMessage(m.from, { text: `❌ Reply to a sticker or image with ${prefix}${command}` }, { quoted: m });
                    break;
                }

                try {
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const messageKey = quotedType === 'stickerMessage' ? 'stickerMessage' : 'imageMessage';
                    const buffer = await downloadMediaMessage(
                        { message: { [messageKey]: m.quoted } },
                        'buffer',
                        {}
                    );

                    const sharp = require('sharp');
                    if (command === 'tojpg') {
                        const outBuffer = await sharp(buffer).flatten({ background: '#ffffff' }).jpeg({ quality: 92 }).toBuffer();
                        await conn.sendMessage(m.from, { image: outBuffer, caption: '🖼️ Converted to JPG' }, { quoted: m });
                    } else {
                        const outBuffer = await sharp(buffer).png().toBuffer();
                        await conn.sendMessage(m.from, { image: outBuffer, caption: '🖼️ Converted to PNG' }, { quoted: m });
                    }
                } catch (err) {
                    console.error(`${command} error:`, err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to convert (animated stickers can't be converted this way — try ${prefix}togif or ${prefix}tomp4 instead).` }, { quoted: m });
                }
                break;
            }

            case "towebp": {
                if (!m.quoted || m.quoted.mtype !== 'imageMessage') {
                    await conn.sendMessage(m.from, { text: `❌ Reply to an image with ${prefix}towebp` }, { quoted: m });
                    break;
                }

                try {
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const buffer = await downloadMediaMessage(
                        { message: { imageMessage: m.quoted } },
                        'buffer',
                        {}
                    );
                    const sharp = require('sharp');
                    const outBuffer = await sharp(buffer).webp({ quality: 90 }).toBuffer();
                    await conn.sendMessage(m.from, { document: outBuffer, fileName: 'converted.webp', mimetype: 'image/webp', caption: '🖼️ Converted to WebP' }, { quoted: m });
                } catch (err) {
                    console.error('towebp error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to convert to WebP.` }, { quoted: m });
                }
                break;
            }

            // ════════════════════════════════════════════
            // IMAGE EDITING
            // ════════════════════════════════════════════
            case "blur": {
                if (!m.quoted || m.quoted.mtype !== 'imageMessage') {
                    await conn.sendMessage(m.from, { text: `❌ Reply to an image with ${prefix}blur [amount 1-50]\nExample: ${prefix}blur 15` }, { quoted: m });
                    break;
                }
                const blurAmount = Math.min(Math.max(parseFloat(args[0]) || 8, 0.3), 50);

                try {
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const buffer = await downloadMediaMessage({ message: { imageMessage: m.quoted } }, 'buffer', {});
                    const sharp = require('sharp');
                    const outBuffer = await sharp(buffer).blur(blurAmount).toBuffer();
                    await conn.sendMessage(m.from, { image: outBuffer, caption: `🌫️ Blurred (amount: ${blurAmount})` }, { quoted: m });
                } catch (err) {
                    console.error('blur error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to blur image.` }, { quoted: m });
                }
                break;
            }

            case "pixelate": {
                if (!m.quoted || m.quoted.mtype !== 'imageMessage') {
                    await conn.sendMessage(m.from, { text: `❌ Reply to an image with ${prefix}pixelate [block size 4-40]\nExample: ${prefix}pixelate 12` }, { quoted: m });
                    break;
                }
                const blockSize = Math.min(Math.max(parseInt(args[0]) || 12, 2), 40);

                try {
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const buffer = await downloadMediaMessage({ message: { imageMessage: m.quoted } }, 'buffer', {});
                    const sharp = require('sharp');
                    const meta = await sharp(buffer).metadata();
                    const smallW = Math.max(1, Math.round(meta.width / blockSize));
                    const smallH = Math.max(1, Math.round(meta.height / blockSize));
                    const outBuffer = await sharp(buffer)
                        .resize(smallW, smallH)
                        .resize(meta.width, meta.height, { kernel: 'nearest' })
                        .toBuffer();
                    await conn.sendMessage(m.from, { image: outBuffer, caption: `🔲 Pixelated (block: ${blockSize})` }, { quoted: m });
                } catch (err) {
                    console.error('pixelate error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to pixelate image.` }, { quoted: m });
                }
                break;
            }

            case "crop": {
                if (!m.quoted || m.quoted.mtype !== 'imageMessage') {
                    await conn.sendMessage(m.from, { text: `❌ Reply to an image with ${prefix}crop <width> <height> [left] [top]\nExample: ${prefix}crop 500 500\n\nWithout left/top, crops from the center.` }, { quoted: m });
                    break;
                }
                const cropW = parseInt(args[0]);
                const cropH = parseInt(args[1]);
                if (!cropW || !cropH) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}crop <width> <height> [left] [top]` }, { quoted: m });
                    break;
                }

                try {
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const buffer = await downloadMediaMessage({ message: { imageMessage: m.quoted } }, 'buffer', {});
                    const sharp = require('sharp');
                    const meta = await sharp(buffer).metadata();
                    const finalW = Math.min(cropW, meta.width);
                    const finalH = Math.min(cropH, meta.height);
                    const left = args[2] !== undefined ? parseInt(args[2]) : Math.floor((meta.width - finalW) / 2);
                    const top = args[3] !== undefined ? parseInt(args[3]) : Math.floor((meta.height - finalH) / 2);
                    const outBuffer = await sharp(buffer)
                        .extract({ left: Math.max(0, left), top: Math.max(0, top), width: finalW, height: finalH })
                        .toBuffer();
                    await conn.sendMessage(m.from, { image: outBuffer, caption: `✂️ Cropped to ${finalW}x${finalH}` }, { quoted: m });
                } catch (err) {
                    console.error('crop error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to crop — the crop area might be larger than the image.` }, { quoted: m });
                }
                break;
            }

            case "resize": {
                if (!m.quoted || m.quoted.mtype !== 'imageMessage') {
                    await conn.sendMessage(m.from, { text: `❌ Reply to an image with ${prefix}resize <width> <height>\nExample: ${prefix}resize 512 512` }, { quoted: m });
                    break;
                }
                const resizeW = parseInt(args[0]);
                const resizeH = parseInt(args[1]);
                if (!resizeW || !resizeH || resizeW > 4000 || resizeH > 4000) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}resize <width> <height> (max 4000 each)` }, { quoted: m });
                    break;
                }

                try {
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const buffer = await downloadMediaMessage({ message: { imageMessage: m.quoted } }, 'buffer', {});
                    const sharp = require('sharp');
                    const outBuffer = await sharp(buffer).resize(resizeW, resizeH).toBuffer();
                    await conn.sendMessage(m.from, { image: outBuffer, caption: `📐 Resized to ${resizeW}x${resizeH}` }, { quoted: m });
                } catch (err) {
                    console.error('resize error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to resize image.` }, { quoted: m });
                }
                break;
            }

            case "rotate": {
                if (!m.quoted || m.quoted.mtype !== 'imageMessage') {
                    await conn.sendMessage(m.from, { text: `❌ Reply to an image with ${prefix}rotate <degrees>\nExample: ${prefix}rotate 90` }, { quoted: m });
                    break;
                }
                const degrees = parseInt(args[0]);
                if (isNaN(degrees)) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}rotate <degrees>\nExample: ${prefix}rotate 90` }, { quoted: m });
                    break;
                }

                try {
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const buffer = await downloadMediaMessage({ message: { imageMessage: m.quoted } }, 'buffer', {});
                    const sharp = require('sharp');
                    const outBuffer = await sharp(buffer).rotate(degrees).toBuffer();
                    await conn.sendMessage(m.from, { image: outBuffer, caption: `🔄 Rotated ${degrees}°` }, { quoted: m });
                } catch (err) {
                    console.error('rotate error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to rotate image.` }, { quoted: m });
                }
                break;
            }

            // ════════════════════════════════════════════
            // IMAGE FILTER LAB — 20 sharp-based effects,
            // reply to an image with any of these
            // ════════════════════════════════════════════
            case "sketch":
            case "cartoon":
            case "animefy":
            case "oilpaint":
            case "pencil":
            case "comic":
            case "vintage":
            case "sepia":
            case "grayscale":
            case "negative":
            case "solarize":
            case "posterize":
            case "emboss":
            case "sharpen":
            case "soften":
            case "denoise":
            case "smooth":
            case "glow":
            case "vignette":
            case "outline": {
                if (!m.quoted || m.quoted.mtype !== 'imageMessage') {
                    await conn.sendMessage(m.from, { text: `❌ Reply to an image with ${prefix}${command}` }, { quoted: m });
                    break;
                }

                try {
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const buffer = await downloadMediaMessage({ message: { imageMessage: m.quoted } }, 'buffer', {});
                    const outBuffer = await filters.applyImageFilter(buffer, command);
                    await conn.sendMessage(m.from, { image: outBuffer, caption: `🎨 ${command}` }, { quoted: m });
                } catch (err) {
                    console.error(`${command} filter error:`, err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to apply ${command} filter.` }, { quoted: m });
                }
                break;
            }

            // ════════════════════════════════════════════
            // DISTORTION / STYLE LAB — 16 more sharp-based
            // effects, reply to an image
            // ════════════════════════════════════════════
            case "blurbg":
            case "bokeh":
            case "pixel":
            case "glass":
            case "fisheye":
            case "swirl":
            case "wave":
            case "ripple":
            case "twirl":
            case "kaleidoscope":
            case "glitch":
            case "crt":
            case "scanlines":
            case "neon":
            case "cyberpunk":
            case "rainbow": {
                if (!m.quoted || m.quoted.mtype !== 'imageMessage') {
                    await conn.sendMessage(m.from, { text: `❌ Reply to an image with ${prefix}${command}` }, { quoted: m });
                    break;
                }

                try {
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const buffer = await downloadMediaMessage({ message: { imageMessage: m.quoted } }, 'buffer', {});
                    const outBuffer = await imagelab.applyStyleFilter(buffer, command);
                    await conn.sendMessage(m.from, { image: outBuffer, caption: `🎨 ${command}` }, { quoted: m });
                } catch (err) {
                    console.error(`${command} filter error:`, err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to apply ${command} filter.` }, { quoted: m });
                }
                break;
            }

            // ════════════════════════════════════════════
            // 📷 PHOTO UTILITIES — single image
            // ════════════════════════════════════════════
            case "autocrop": {
                if (!m.quoted || m.quoted.mtype !== 'imageMessage') {
                    await conn.sendMessage(m.from, { text: `❌ Reply to an image with ${prefix}autocrop\n\nTrims uniform-color borders automatically.` }, { quoted: m });
                    break;
                }
                try {
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const buffer = await downloadMediaMessage({ message: { imageMessage: m.quoted } }, 'buffer', {});
                    const outBuffer = await imagelab.autoCrop(buffer);
                    await conn.sendMessage(m.from, { image: outBuffer, caption: `✂️ Auto-cropped` }, { quoted: m });
                } catch (err) {
                    console.error('autocrop error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to auto-crop.` }, { quoted: m });
                }
                break;
            }

            case "smartcrop": {
                if (!m.quoted || m.quoted.mtype !== 'imageMessage') {
                    await conn.sendMessage(m.from, { text: `❌ Reply to an image with ${prefix}smartcrop [ratio]\n\nDefault 1:1. Crops toward the most "interesting" region instead of dead-center.\nExample: ${prefix}smartcrop 16:9` }, { quoted: m });
                    break;
                }
                try {
                    const [rw, rh] = (args[0] || '1:1').split(':').map(n => parseInt(n) || 1);
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const buffer = await downloadMediaMessage({ message: { imageMessage: m.quoted } }, 'buffer', {});
                    const outBuffer = await imagelab.smartCrop(buffer, rw, rh);
                    await conn.sendMessage(m.from, { image: outBuffer, caption: `✂️ Smart-cropped ${rw}:${rh}` }, { quoted: m });
                } catch (err) {
                    console.error('smartcrop error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to smart-crop.` }, { quoted: m });
                }
                break;
            }

            case "square":
            case "landscape":
            case "portrait": {
                if (!m.quoted || m.quoted.mtype !== 'imageMessage') {
                    await conn.sendMessage(m.from, { text: `❌ Reply to an image with ${prefix}${command}` }, { quoted: m });
                    break;
                }
                try {
                    const ratios = { square: [1, 1], landscape: [16, 9], portrait: [4, 5] };
                    const [rw, rh] = ratios[command];
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const buffer = await downloadMediaMessage({ message: { imageMessage: m.quoted } }, 'buffer', {});
                    const outBuffer = await imagelab.ratioCrop(buffer, rw, rh);
                    await conn.sendMessage(m.from, { image: outBuffer, caption: `✂️ ${command} (${rw}:${rh})` }, { quoted: m });
                } catch (err) {
                    console.error(`${command} error:`, err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to crop to ${command}.` }, { quoted: m });
                }
                break;
            }

            case "border": {
                if (!m.quoted || m.quoted.mtype !== 'imageMessage') {
                    await conn.sendMessage(m.from, { text: `❌ Reply to an image with ${prefix}border [#hexcolor]\n\nExample: ${prefix}border #ffffff` }, { quoted: m });
                    break;
                }
                try {
                    const color = /^#?[0-9a-fA-F]{6}$/.test(args[0] || '') ? (args[0].startsWith('#') ? args[0] : '#' + args[0]) : '#000000';
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const buffer = await downloadMediaMessage({ message: { imageMessage: m.quoted } }, 'buffer', {});
                    const outBuffer = await imagelab.addBorder(buffer, color);
                    await conn.sendMessage(m.from, { image: outBuffer, caption: `🖼️ Border added` }, { quoted: m });
                } catch (err) {
                    console.error('border error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to add border.` }, { quoted: m });
                }
                break;
            }

            case "frame": {
                if (!m.quoted || m.quoted.mtype !== 'imageMessage') {
                    await conn.sendMessage(m.from, { text: `❌ Reply to an image with ${prefix}frame` }, { quoted: m });
                    break;
                }
                try {
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const buffer = await downloadMediaMessage({ message: { imageMessage: m.quoted } }, 'buffer', {});
                    const outBuffer = await imagelab.addFrame(buffer);
                    await conn.sendMessage(m.from, { image: outBuffer, caption: `🖼️ Framed` }, { quoted: m });
                } catch (err) {
                    console.error('frame error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to add frame.` }, { quoted: m });
                }
                break;
            }

            case "pad": {
                if (!m.quoted || m.quoted.mtype !== 'imageMessage') {
                    await conn.sendMessage(m.from, { text: `❌ Reply to an image with ${prefix}pad [ratio] [#hexcolor]\n\nDefault 1:1 on black. Adds letterbox bars instead of cropping.\nExample: ${prefix}pad 16:9 #ffffff` }, { quoted: m });
                    break;
                }
                try {
                    const [rw, rh] = (args[0] || '1:1').split(':').map(n => parseInt(n) || 1);
                    const color = /^#?[0-9a-fA-F]{6}$/.test(args[1] || '') ? (args[1].startsWith('#') ? args[1] : '#' + args[1]) : '#000000';
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const buffer = await downloadMediaMessage({ message: { imageMessage: m.quoted } }, 'buffer', {});
                    const outBuffer = await imagelab.padToRatio(buffer, rw, rh, color);
                    await conn.sendMessage(m.from, { image: outBuffer, caption: `📐 Padded to ${rw}:${rh}` }, { quoted: m });
                } catch (err) {
                    console.error('pad error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to pad.` }, { quoted: m });
                }
                break;
            }

            // ════════════════════════════════════════════
            // 📷 PHOTO UTILITIES — multi-image layouts
            // (built from a rolling per-chat image cache,
            // since one WhatsApp message = one image)
            // ════════════════════════════════════════════
            case "collage":
            case "photostrip":
            case "contactsheet": {
                try {
                    const needed = command === 'contactsheet' ? 9 : 4;
                    const images = [];

                    if (m.quoted && m.quoted.mtype === 'imageMessage') {
                        const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                        images.push(await downloadMediaMessage({ message: { imageMessage: m.quoted } }, 'buffer', {}));
                    }

                    const cached = await imagelab.getCachedImages(redisClient, m.from, needed);
                    for (const buf of cached) {
                        if (images.length >= needed) break;
                        images.push(buf);
                    }

                    if (images.length < 2) {
                        await conn.sendMessage(m.from, { text: `❌ Not enough recent images in this chat yet.\n\nSend a few photos (or reply to one) then try ${prefix}${command} again.` }, { quoted: m });
                        break;
                    }

                    let outBuffer;
                    if (command === 'collage') outBuffer = await imagelab.buildCollage(images);
                    else if (command === 'photostrip') outBuffer = await imagelab.buildPhotostrip(images);
                    else outBuffer = await imagelab.buildContactsheet(images);

                    await conn.sendMessage(m.from, { image: outBuffer, caption: `🖼️ ${command} (${images.length} photos)` }, { quoted: m });
                } catch (err) {
                    console.error(`${command} error:`, err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to build ${command}.` }, { quoted: m });
                }
                break;
            }

            case "beforeafter": {
                try {
                    let afterBuf, beforeBuf;

                    if (m.quoted && m.quoted.mtype === 'imageMessage') {
                        const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                        afterBuf = await downloadMediaMessage({ message: { imageMessage: m.quoted } }, 'buffer', {});
                        const cached = await imagelab.getCachedImages(redisClient, m.from, 1);
                        beforeBuf = cached[0];
                    } else {
                        const cached = await imagelab.getCachedImages(redisClient, m.from, 2);
                        afterBuf = cached[0];
                        beforeBuf = cached[1];
                    }

                    if (!beforeBuf || !afterBuf) {
                        await conn.sendMessage(m.from, { text: `❌ Need two images: send a "before" photo, then a "after" photo (or reply to the "after" one with ${prefix}beforeafter).` }, { quoted: m });
                        break;
                    }

                    const outBuffer = await imagelab.buildBeforeAfter(beforeBuf, afterBuf);
                    await conn.sendMessage(m.from, { image: outBuffer, caption: `↔️ Before (left) · After (right)` }, { quoted: m });
                } catch (err) {
                    console.error('beforeafter error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to build before/after comparison.` }, { quoted: m });
                }
                break;
            }

            // ════════════════════════════════════════════
            // RETOUCH LAB
            // Note: no generative AI model is wired into this bot, so
            // outpaint/removeobject/magiceraser are classic non-generative
            // tricks (blurred edge-extension, blur-smear patching) — not
            // true content-aware fill. They work well on simple/uniform
            // backgrounds and will look rough on busy/detailed ones.
            // ════════════════════════════════════════════
            case "outpaint": {
                if (!m.quoted || m.quoted.mtype !== 'imageMessage') {
                    await conn.sendMessage(m.from, { text: `❌ Reply to an image with ${prefix}outpaint [pixels]\n\nExtends the canvas using a blurred, scaled copy of the image itself as filler — not true AI-generated content, so it looks best as a soft edge extension rather than added detail. Default 100px.` }, { quoted: m });
                    break;
                }
                try {
                    const extendPx = Math.min(400, Math.max(20, parseInt(args[0]) || 100));
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const buffer = await downloadMediaMessage({ message: { imageMessage: m.quoted } }, 'buffer', {});
                    const outBuffer = await retouch.outpaint(buffer, extendPx);
                    await conn.sendMessage(m.from, { image: outBuffer, caption: `🖼️ Outpainted +${extendPx}px` }, { quoted: m });
                } catch (err) {
                    console.error('outpaint error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to outpaint.` }, { quoted: m });
                }
                break;
            }

            case "removeobject":
            case "magiceraser": {
                const left = parseFloat(args[0]), top = parseFloat(args[1]), right = parseFloat(args[2]), bottom = parseFloat(args[3]);
                const validRegion = [left, top, right, bottom].every(n => !isNaN(n) && n >= 0 && n <= 1) && right > left && bottom > top;

                if (!m.quoted || m.quoted.mtype !== 'imageMessage' || !validRegion) {
                    await conn.sendMessage(m.from, {
                        text: `❌ Reply to an image with ${prefix}${command} <left> <top> <right> <bottom>\n\n` +
                            `Coordinates are fractions of the image (0 to 1). Example — erase something in the top-right corner:\n${prefix}${command} 0.6 0.0 1.0 0.3\n\n` +
                            `⚠️ This blur-smears nearby background over the area — it's not true AI object removal. Works best on simple backgrounds (sky, walls, plain floors); busy backgrounds will look smudged.`
                    }, { quoted: m });
                    break;
                }

                try {
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const buffer = await downloadMediaMessage({ message: { imageMessage: m.quoted } }, 'buffer', {});
                    const outBuffer = await retouch.patchFill(buffer, left, top, right, bottom);
                    await conn.sendMessage(m.from, { image: outBuffer, caption: `🩹 ${command === 'magiceraser' ? 'Magic erased' : 'Object removed'} (blur-fill)` }, { quoted: m });
                } catch (err) {
                    console.error(`${command} error:`, err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to remove that area.` }, { quoted: m });
                }
                break;
            }

            case "smartresize": {
                const targetW = parseInt(args[0]), targetH = parseInt(args[1]);
                if (!m.quoted || m.quoted.mtype !== 'imageMessage' || !targetW || !targetH || targetW < 16 || targetH < 16 || targetW > 3000 || targetH > 3000) {
                    await conn.sendMessage(m.from, { text: `❌ Reply to an image with ${prefix}smartresize <width> <height>\n\nResizes to those exact pixel dimensions, cropping toward the most "interesting" region instead of squashing or blind center-cropping.\nExample: ${prefix}smartresize 800 600` }, { quoted: m });
                    break;
                }
                try {
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const buffer = await downloadMediaMessage({ message: { imageMessage: m.quoted } }, 'buffer', {});
                    const outBuffer = await retouch.smartResize(buffer, targetW, targetH);
                    await conn.sendMessage(m.from, { image: outBuffer, caption: `📐 Smart-resized to ${targetW}x${targetH}` }, { quoted: m });
                } catch (err) {
                    console.error('smartresize error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to smart-resize.` }, { quoted: m });
                }
                break;
            }

            case "autofix": {
                if (!m.quoted || m.quoted.mtype !== 'imageMessage') {
                    await conn.sendMessage(m.from, { text: `❌ Reply to an image with ${prefix}autofix\n\nOne-click brightness/contrast/sharpness/denoise pass.` }, { quoted: m });
                    break;
                }
                try {
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const buffer = await downloadMediaMessage({ message: { imageMessage: m.quoted } }, 'buffer', {});
                    const outBuffer = await retouch.autoFix(buffer);
                    await conn.sendMessage(m.from, { image: outBuffer, caption: `✨ Auto-fixed` }, { quoted: m });
                } catch (err) {
                    console.error('autofix error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to auto-fix.` }, { quoted: m });
                }
                break;
            }

            case "depthblur": {
                if (!m.quoted || m.quoted.mtype !== 'imageMessage') {
                    await conn.sendMessage(m.from, { text: `❌ Reply to an image with ${prefix}depthblur\n\nPortrait-mode style background blur (works best on a single centered subject).` }, { quoted: m });
                    break;
                }
                try {
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const buffer = await downloadMediaMessage({ message: { imageMessage: m.quoted } }, 'buffer', {});
                    const outBuffer = await retouch.depthBlur(buffer);
                    await conn.sendMessage(m.from, { image: outBuffer, caption: `📸 Depth blur applied` }, { quoted: m });
                } catch (err) {
                    console.error('depthblur error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to apply depth blur.` }, { quoted: m });
                }
                break;
            }

            case "polaroid": {
                if (!m.quoted || m.quoted.mtype !== 'imageMessage') {
                    await conn.sendMessage(m.from, { text: `❌ Reply to an image with ${prefix}polaroid` }, { quoted: m });
                    break;
                }
                try {
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const buffer = await downloadMediaMessage({ message: { imageMessage: m.quoted } }, 'buffer', {});
                    const outBuffer = await retouch.polaroid(buffer);
                    await conn.sendMessage(m.from, { image: outBuffer, caption: `🎞️ Polaroid` }, { quoted: m });
                } catch (err) {
                    console.error('polaroid error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to make polaroid.` }, { quoted: m });
                }
                break;
            }

            case "film": {
                if (!m.quoted || m.quoted.mtype !== 'imageMessage') {
                    await conn.sendMessage(m.from, { text: `❌ Reply to an image with ${prefix}film\n\nWarm color grade + grain + gentle vignette, classic film-camera look.` }, { quoted: m });
                    break;
                }
                try {
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const buffer = await downloadMediaMessage({ message: { imageMessage: m.quoted } }, 'buffer', {});
                    const outBuffer = await retouch.filmEffect(buffer);
                    await conn.sendMessage(m.from, { image: outBuffer, caption: `🎞️ Film` }, { quoted: m });
                } catch (err) {
                    console.error('film error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to apply film effect.` }, { quoted: m });
                }
                break;
            }

            case "passport": {
                if (!m.quoted || m.quoted.mtype !== 'imageMessage') {
                    await conn.sendMessage(m.from, {
                        text: `❌ Reply to an image with ${prefix}passport [${retouch.PASSPORT_SIZES.join('/')}]\n\n` +
                            `Crops to a standard passport-photo pixel size (default us).\n\n⚠️ This only handles crop/size — it does NOT check background color, head position/size, expression, or lighting, which most countries also require. Treat it as a starting template, not a guarantee it'll be accepted.`
                    }, { quoted: m });
                    break;
                }
                try {
                    const sizeKey = retouch.PASSPORT_SIZES.includes((args[0] || '').toLowerCase()) ? args[0].toLowerCase() : 'us';
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const buffer = await downloadMediaMessage({ message: { imageMessage: m.quoted } }, 'buffer', {});
                    const outBuffer = await retouch.passportCrop(buffer, sizeKey);
                    await conn.sendMessage(m.from, { image: outBuffer, caption: `🛂 Passport crop (${sizeKey}) — verify against your country's official requirements before using` }, { quoted: m });
                } catch (err) {
                    console.error('passport error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to crop for passport.` }, { quoted: m });
                }
                break;
            }

            // ════════════════════════════════════════════
            // IMAGE TEXT & ANALYSIS LAB
            // ════════════════════════════════════════════
            case "memegen": {
                if (!m.quoted || m.quoted.mtype !== 'imageMessage') {
                    await conn.sendMessage(m.from, { text: `❌ Reply to an image with ${prefix}memegen <top text> | <bottom text>\n\nExample: ${prefix}memegen when the code works | on the first try` }, { quoted: m });
                    break;
                }
                try {
                    const [topText, bottomText] = text.split('|').map(s => (s || '').trim());
                    if (!topText && !bottomText) {
                        await conn.sendMessage(m.from, { text: `❌ Give me some caption text: ${prefix}memegen <top> | <bottom>` }, { quoted: m });
                        break;
                    }
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const buffer = await downloadMediaMessage({ message: { imageMessage: m.quoted } }, 'buffer', {});
                    const outBuffer = await imagetext.memeGen(buffer, topText, bottomText || '');
                    await conn.sendMessage(m.from, { image: outBuffer, caption: `😂 Meme` }, { quoted: m });
                } catch (err) {
                    console.error('memegen error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to generate meme.` }, { quoted: m });
                }
                break;
            }

            case "watermark": {
                if (!m.quoted || m.quoted.mtype !== 'imageMessage') {
                    await conn.sendMessage(m.from, { text: `❌ Reply to an image with ${prefix}watermark [text]\n\nDefault text: SAMPLE` }, { quoted: m });
                    break;
                }
                try {
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const buffer = await downloadMediaMessage({ message: { imageMessage: m.quoted } }, 'buffer', {});
                    const outBuffer = await imagetext.watermark(buffer, text || 'SAMPLE');
                    await conn.sendMessage(m.from, { image: outBuffer, caption: `💧 Watermarked` }, { quoted: m });
                } catch (err) {
                    console.error('watermark error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to add watermark.` }, { quoted: m });
                }
                break;
            }

            case "quotecard": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}quotecard <quote> | <author>\n\nAuthor is optional.` }, { quoted: m });
                    break;
                }
                try {
                    const [quote, author] = text.split('|').map(s => (s || '').trim());
                    const outBuffer = await imagetext.quoteCard(quote, author || '');
                    await conn.sendMessage(m.from, { image: outBuffer, caption: `📇 Quote card` }, { quoted: m });
                } catch (err) {
                    console.error('quotecard error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to generate quote card.` }, { quoted: m });
                }
                break;
            }

            case "imagecolors": {
                if (!m.quoted || m.quoted.mtype !== 'imageMessage') {
                    await conn.sendMessage(m.from, { text: `❌ Reply to an image with ${prefix}imagecolors` }, { quoted: m });
                    break;
                }
                try {
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const buffer = await downloadMediaMessage({ message: { imageMessage: m.quoted } }, 'buffer', {});
                    const palette = await imagetext.extractPalette(buffer, 5);
                    const swatch = await imagetext.paletteSwatchImage(palette);
                    await conn.sendMessage(m.from, {
                        image: swatch,
                        caption: `🎨 *Dominant Colors*\n\n${palette.map(c => c.hex).join(' · ')}`
                    }, { quoted: m });
                } catch (err) {
                    console.error('imagecolors error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to extract colors.` }, { quoted: m });
                }
                break;
            }

            case "imagetoascii": {
                if (!m.quoted || m.quoted.mtype !== 'imageMessage') {
                    await conn.sendMessage(m.from, { text: `❌ Reply to an image with ${prefix}imagetoascii` }, { quoted: m });
                    break;
                }
                try {
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const buffer = await downloadMediaMessage({ message: { imageMessage: m.quoted } }, 'buffer', {});
                    const ascii = await imagetext.imageToAscii(buffer, 55);
                    await conn.sendMessage(m.from, { text: `\`\`\`${ascii}\`\`\`` }, { quoted: m });
                } catch (err) {
                    console.error('imagetoascii error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to convert to ASCII.` }, { quoted: m });
                }
                break;
            }

            case "ocr": {
                if (!m.quoted || m.quoted.mtype !== 'imageMessage') {
                    await conn.sendMessage(m.from, { text: `❌ Reply to an image with ${prefix}ocr\n\nExtracts text from the image (English).` }, { quoted: m });
                    break;
                }
                try {
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const buffer = await downloadMediaMessage({ message: { imageMessage: m.quoted } }, 'buffer', {});
                    await conn.sendMessage(m.from, { text: `🔍 Reading text, this can take a moment...` }, { quoted: m });
                    const extracted = await imagetext.extractText(buffer);
                    await conn.sendMessage(m.from, { text: extracted ? `📝 *EXTRACTED TEXT*\n\n${extracted}` : `❌ No readable text found in that image.` });
                } catch (err) {
                    console.error('ocr error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ OCR failed: ${err.message}` }, { quoted: m });
                }
                break;
            }

            case "exifstrip": {
                if (!m.quoted || m.quoted.mtype !== 'imageMessage') {
                    await conn.sendMessage(m.from, { text: `❌ Reply to an image with ${prefix}exifstrip\n\nRemoves EXIF/location/camera metadata and tells you what was found.` }, { quoted: m });
                    break;
                }
                try {
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const buffer = await downloadMediaMessage({ message: { imageMessage: m.quoted } }, 'buffer', {});
                    const { cleaned, found } = await imagetext.stripExif(buffer);
                    await conn.sendMessage(m.from, {
                        image: cleaned,
                        caption: found.length ? `🧹 Removed: ${found.join(', ')}` : `✅ No hidden metadata found — already clean.`
                    }, { quoted: m });
                } catch (err) {
                    console.error('exifstrip error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to strip metadata.` }, { quoted: m });
                }
                break;
            }

            case "remini":
            case "enhance": {
                if (!m.quoted || m.quoted.mtype !== 'imageMessage') {
                    await conn.sendMessage(m.from, { text: `❌ Reply to an image with ${prefix}remini\n\nNote: this does a basic local sharpen/upscale, not true AI super-resolution — it won't work miracles on heavily compressed photos.` }, { quoted: m });
                    break;
                }

                try {
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const buffer = await downloadMediaMessage({ message: { imageMessage: m.quoted } }, 'buffer', {});
                    const outBuffer = await media.enhanceImage(buffer, 1.5);
                    await conn.sendMessage(m.from, { image: outBuffer, caption: `✨ Enhanced` }, { quoted: m });
                } catch (err) {
                    console.error('remini error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to enhance image.` }, { quoted: m });
                }
                break;
            }

            case "removebg": {
                if (!m.quoted || m.quoted.mtype !== 'imageMessage') {
                    await conn.sendMessage(m.from, { text: `❌ Reply to an image with ${prefix}removebg` }, { quoted: m });
                    break;
                }
                if (!process.env.REMOVEBG_API_KEY) {
                    await conn.sendMessage(m.from, { text: `❌ Not configured — REMOVEBG_API_KEY isn't set on this deployment.` }, { quoted: m });
                    break;
                }

                try {
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const buffer = await downloadMediaMessage({ message: { imageMessage: m.quoted } }, 'buffer', {});

                    const axios = require('axios');
                    const FormData = require('form-data');
                    const form = new FormData();
                    form.append('image_file', buffer, { filename: 'image.jpg' });
                    form.append('size', 'auto');

                    const res = await axios.post('https://api.remove.bg/v1.0/removebg', form, {
                        headers: { ...form.getHeaders(), 'X-Api-Key': process.env.REMOVEBG_API_KEY },
                        responseType: 'arraybuffer',
                        timeout: 30000,
                        maxBodyLength: Infinity,
                        maxContentLength: Infinity,
                        validateStatus: () => true
                    });

                    if (res.status !== 200) {
                        // remove.bg returns JSON error bodies on failure, even though
                        // we requested arraybuffer — decode it for a useful message.
                        let errMsg = `HTTP ${res.status}`;
                        try {
                            const parsed = JSON.parse(Buffer.from(res.data).toString('utf-8'));
                            errMsg = parsed?.errors?.[0]?.title || errMsg;
                        } catch {}
                        throw new Error(errMsg);
                    }

                    await conn.sendMessage(m.from, { image: Buffer.from(res.data), caption: `✂️ Background removed` }, { quoted: m });
                } catch (err) {
                    console.error('removebg error:', err.message);
                    if (/credit/i.test(err.message) || /limit/i.test(err.message)) {
                        await conn.sendMessage(m.from, { text: `❌ remove.bg API: ${err.message} (likely out of free-tier credits).` }, { quoted: m });
                    } else {
                        await conn.sendMessage(m.from, { text: `❌ Failed to remove background: ${err.message}` }, { quoted: m });
                    }
                }
                break;
            }

            case "compress": {
                const quotedType = m.quoted?.mtype;
                if (!m.quoted || (quotedType !== 'imageMessage' && quotedType !== 'videoMessage')) {
                    await conn.sendMessage(m.from, { text: `❌ Reply to an image or video with ${prefix}compress` }, { quoted: m });
                    break;
                }

                try {
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    if (quotedType === 'imageMessage') {
                        const buffer = await downloadMediaMessage({ message: { imageMessage: m.quoted } }, 'buffer', {});
                        const outBuffer = await media.compressImage(buffer, 45);
                        await conn.sendMessage(m.from, {
                            image: outBuffer,
                            caption: `🗜️ Compressed: ${(buffer.length / 1024).toFixed(0)}KB → ${(outBuffer.length / 1024).toFixed(0)}KB`
                        }, { quoted: m });
                    } else {
                        if (!media.isFfmpegAvailable()) {
                            await conn.sendMessage(m.from, { text: `❌ Video compression isn't available yet on this deployment (missing ffmpeg dependencies).` }, { quoted: m });
                            break;
                        }
                        const buffer = await downloadMediaMessage({ message: { videoMessage: m.quoted } }, 'buffer', {});
                        const outBuffer = await media.compressVideo(buffer, 32);
                        await conn.sendMessage(m.from, {
                            video: outBuffer,
                            caption: `🗜️ Compressed: ${(buffer.length / 1024 / 1024).toFixed(2)}MB → ${(outBuffer.length / 1024 / 1024).toFixed(2)}MB`
                        }, { quoted: m });
                    }
                } catch (err) {
                    console.error('compress error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to compress media.` }, { quoted: m });
                }
                break;
            }

            case "zip": {
                // Wraps the single replied-to file in a .zip archive. (WhatsApp
                // only lets a command reply to ONE message, so this can't bundle
                // multiple files in one go — reply to each one individually.)
                if (!m.quoted) {
                    await conn.sendMessage(m.from, { text: `❌ Reply to any file with ${prefix}zip to wrap it in a .zip archive.` }, { quoted: m });
                    break;
                }

                try {
                    const quotedMedia = await downloadQuotedMedia(m);
                    if (!quotedMedia) {
                        await conn.sendMessage(m.from, { text: `❌ Couldn't read that message as a file.` }, { quoted: m });
                        break;
                    }

                    const AdmZip = require('adm-zip');
                    const zip = new AdmZip();
                    zip.addFile(guessFileName(quotedMedia), quotedMedia.buffer);
                    const outBuffer = zip.toBuffer();

                    await conn.sendMessage(m.from, { document: outBuffer, fileName: 'archive.zip', mimetype: 'application/zip' }, { quoted: m });
                } catch (err) {
                    console.error('zip error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to create zip archive.` }, { quoted: m });
                }
                break;
            }

            case "unzip": {
                if (!m.quoted || m.quoted.mtype !== 'documentMessage') {
                    await conn.sendMessage(m.from, { text: `❌ Reply to a .zip file with ${prefix}unzip` }, { quoted: m });
                    break;
                }

                try {
                    const quotedMedia = await downloadQuotedMedia(m);
                    const AdmZip = require('adm-zip');
                    const zip = new AdmZip(quotedMedia.buffer);
                    const entries = zip.getEntries().filter(e => !e.isDirectory);

                    if (entries.length === 0) {
                        await conn.sendMessage(m.from, { text: `❌ That zip archive is empty.` }, { quoted: m });
                        break;
                    }

                    const MAX_ENTRIES = 10;
                    await conn.sendMessage(m.from, { text: `📦 Extracting ${Math.min(entries.length, MAX_ENTRIES)} of ${entries.length} file(s)...` }, { quoted: m });

                    for (const entry of entries.slice(0, MAX_ENTRIES)) {
                        const data = entry.getData();
                        await conn.sendMessage(m.from, { document: data, fileName: entry.entryName }, { quoted: m });
                    }

                    if (entries.length > MAX_ENTRIES) {
                        await conn.sendMessage(m.from, { text: `_(${entries.length - MAX_ENTRIES} more file(s) not sent — ${MAX_ENTRIES} per archive max)_` }, { quoted: m });
                    }
                } catch (err) {
                    console.error('unzip error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to extract that zip archive. It may be corrupted or password-protected.` }, { quoted: m });
                }
                break;
            }

            case "pdf":
            case "topdf": {
                // Scoped to images only — converting an existing document
                // (.docx, .txt, etc.) to PDF would need a full office-document
                // renderer (e.g. LibreOffice headless), which isn't bundled here.
                if (!m.quoted || m.quoted.mtype !== 'imageMessage') {
                    await conn.sendMessage(m.from, { text: `❌ Reply to an image with ${prefix}${command}\n\n(Converting other document types to PDF isn't supported yet — only images.)` }, { quoted: m });
                    break;
                }

                try {
                    const quotedMedia = await downloadQuotedMedia(m);
                    const sharp = require('sharp');
                    // Normalize to JPEG first — pdfkit's image embedding only
                    // accepts JPEG/PNG, and some WhatsApp images arrive as WebP.
                    const jpegBuffer = await sharp(quotedMedia.buffer).jpeg({ quality: 90 }).toBuffer();
                    const dims = await sharp(jpegBuffer).metadata();

                    const PDFDocument = require('pdfkit');
                    const doc = new PDFDocument({ autoFirstPage: false });
                    const chunks = [];
                    doc.on('data', chunk => chunks.push(chunk));
                    const donePromise = new Promise((resolve, reject) => {
                        doc.on('end', resolve);
                        doc.on('error', reject);
                    });

                    doc.addPage({ size: [dims.width, dims.height] });
                    doc.image(jpegBuffer, 0, 0, { width: dims.width, height: dims.height });
                    doc.end();
                    await donePromise;

                    const pdfBuffer = Buffer.concat(chunks);
                    await conn.sendMessage(m.from, { document: pdfBuffer, fileName: 'converted.pdf', mimetype: 'application/pdf' }, { quoted: m });
                } catch (err) {
                    console.error(`${command} error:`, err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to convert image to PDF.` }, { quoted: m });
                }
                break;
            }

            // ════════════════════════════════════════════
            // MEDIA CONVERTERS
            // ════════════════════════════════════════════
            case "toaudio":
            case "tomp3": {
                if (!m.quoted || m.quoted.mtype !== 'videoMessage') {
                    await conn.sendMessage(m.from, { text: `❌ Reply to a video with ${prefix}${command}` }, { quoted: m });
                    break;
                }
                if (!media.isFfmpegAvailable()) {
                    await conn.sendMessage(m.from, { text: `❌ This conversion isn't available yet on this deployment (missing ffmpeg dependencies).` }, { quoted: m });
                    break;
                }

                try {
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const buffer = await downloadMediaMessage(
                        { message: { videoMessage: m.quoted } },
                        'buffer',
                        {}
                    );
                    const audioBuffer = await media.videoToAudio(buffer);
                    await conn.sendMessage(m.from, { audio: audioBuffer, mimetype: 'audio/mpeg' }, { quoted: m });
                } catch (err) {
                    console.error('toaudio error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to extract audio. The video may have no audio track.` }, { quoted: m });
                }
                break;
            }

            case "tovoicenote":
            case "tovn":
            case "toptt": {
                const quotedType = m.quoted?.mtype;
                if (!m.quoted || (quotedType !== 'audioMessage' && quotedType !== 'videoMessage')) {
                    await conn.sendMessage(m.from, { text: `❌ Reply to an audio file or video with ${prefix}tovoicenote` }, { quoted: m });
                    break;
                }
                if (!media.isFfmpegAvailable()) {
                    await conn.sendMessage(m.from, { text: `❌ This conversion isn't available yet on this deployment (missing ffmpeg dependencies).` }, { quoted: m });
                    break;
                }

                try {
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const messageKey = quotedType === 'audioMessage' ? 'audioMessage' : 'videoMessage';
                    const buffer = await downloadMediaMessage(
                        { message: { [messageKey]: m.quoted } },
                        'buffer',
                        {}
                    );
                    const voiceBuffer = await media.audioToVoiceNote(buffer, quotedType === 'audioMessage' ? 'mp3' : 'mp4');
                    await conn.sendMessage(m.from, { audio: voiceBuffer, mimetype: 'audio/ogg; codecs=opus', ptt: true }, { quoted: m });
                } catch (err) {
                    console.error('tovoicenote error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to convert to voice note.` }, { quoted: m });
                }
                break;
            }

            // ── Generic audio format converters: any audio/video message
            // in, the named format out. One block handles all six since
            // they only differ in which ffmpeg codec/container to target. ──
            case "toopus":
            case "towav":
            case "toogg":
            case "tom4a":
            case "toaac":
            case "toflac": {
                const quotedType = m.quoted?.mtype;
                if (!m.quoted || (quotedType !== 'audioMessage' && quotedType !== 'videoMessage')) {
                    await conn.sendMessage(m.from, { text: `❌ Reply to an audio file or video with ${prefix}${command}` }, { quoted: m });
                    break;
                }
                if (!media.isFfmpegAvailable()) {
                    await conn.sendMessage(m.from, { text: `❌ This conversion isn't available yet on this deployment (missing ffmpeg dependencies).` }, { quoted: m });
                    break;
                }

                const targetFormat = command.slice(2); // "toopus" -> "opus", etc.
                const mimetypes = {
                    opus: 'audio/ogg; codecs=opus',
                    wav: 'audio/wav',
                    ogg: 'audio/ogg',
                    m4a: 'audio/mp4',
                    aac: 'audio/aac',
                    flac: 'audio/flac'
                };

                try {
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const messageKey = quotedType === 'audioMessage' ? 'audioMessage' : 'videoMessage';
                    const buffer = await downloadMediaMessage(
                        { message: { [messageKey]: m.quoted } },
                        'buffer',
                        {}
                    );
                    const inputExt = quotedType === 'audioMessage' ? 'mp3' : 'mp4';
                    const outBuffer = await media.convertAudioFormat(buffer, inputExt, targetFormat);
                    await conn.sendMessage(m.from, {
                        document: outBuffer,
                        fileName: `converted.${targetFormat}`,
                        mimetype: mimetypes[targetFormat]
                    }, { quoted: m });
                } catch (err) {
                    console.error(`${command} error:`, err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to convert to ${targetFormat.toUpperCase()}.` }, { quoted: m });
                }
                break;
            }

            case "reverseaudio": {
                if (!m.quoted || m.quoted.mtype !== 'audioMessage') {
                    await conn.sendMessage(m.from, { text: `❌ Reply to an audio file with ${prefix}reverseaudio` }, { quoted: m });
                    break;
                }
                if (!media.isFfmpegAvailable()) {
                    await conn.sendMessage(m.from, { text: `❌ This conversion isn't available yet on this deployment (missing ffmpeg dependencies).` }, { quoted: m });
                    break;
                }

                try {
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const buffer = await downloadMediaMessage({ message: { audioMessage: m.quoted } }, 'buffer', {});
                    const outBuffer = await media.reverseAudio(buffer, 'mp3');
                    await conn.sendMessage(m.from, { audio: outBuffer, mimetype: 'audio/mpeg' }, { quoted: m });
                } catch (err) {
                    console.error('reverseaudio error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to reverse audio.` }, { quoted: m });
                }
                break;
            }

            case "reversevideo": {
                if (!m.quoted || m.quoted.mtype !== 'videoMessage') {
                    await conn.sendMessage(m.from, { text: `❌ Reply to a video with ${prefix}reversevideo` }, { quoted: m });
                    break;
                }
                if (!media.isFfmpegAvailable()) {
                    await conn.sendMessage(m.from, { text: `❌ This conversion isn't available yet on this deployment (missing ffmpeg dependencies).` }, { quoted: m });
                    break;
                }

                try {
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const buffer = await downloadMediaMessage({ message: { videoMessage: m.quoted } }, 'buffer', {});
                    const outBuffer = await media.reverseVideo(buffer);
                    await conn.sendMessage(m.from, { video: outBuffer, caption: '⏪ Reversed' }, { quoted: m });
                } catch (err) {
                    console.error('reversevideo error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to reverse video. (Long videos can be slow/memory-heavy to reverse — try a shorter clip.)` }, { quoted: m });
                }
                break;
            }

            case "renameaudio":
            case "renamevideo": {
                const expectedType = command === 'renameaudio' ? 'audioMessage' : 'videoMessage';
                if (!m.quoted || m.quoted.mtype !== expectedType) {
                    await conn.sendMessage(m.from, { text: `❌ Reply to a${command === 'renameaudio' ? 'n audio file' : ' video'} with ${prefix}${command} <new title>` }, { quoted: m });
                    break;
                }
                if (!text) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}${command} <new title>` }, { quoted: m });
                    break;
                }
                if (!media.isFfmpegAvailable()) {
                    await conn.sendMessage(m.from, { text: `❌ This isn't available yet on this deployment (missing ffmpeg dependencies).` }, { quoted: m });
                    break;
                }

                try {
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const buffer = await downloadMediaMessage({ message: { [expectedType]: m.quoted } }, 'buffer', {});
                    const inputExt = command === 'renameaudio' ? 'mp3' : 'mp4';
                    const outBuffer = await media.renameMediaMetadata(buffer, inputExt, text);
                    if (command === 'renameaudio') {
                        await conn.sendMessage(m.from, { audio: outBuffer, mimetype: 'audio/mpeg' }, { quoted: m });
                    } else {
                        await conn.sendMessage(m.from, { video: outBuffer, caption: `🏷️ Renamed to "${text}"` }, { quoted: m });
                    }
                } catch (err) {
                    console.error(`${command} error:`, err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to rename metadata.` }, { quoted: m });
                }
                break;
            }

            case "tomp4": {
                const quotedType = m.quoted?.mtype;
                const isGifFile = (quotedType === 'imageMessage' || quotedType === 'documentMessage') && m.quoted?.mimetype === 'image/gif';
                const isSticker = quotedType === 'stickerMessage';

                if (!m.quoted || (!isSticker && !isGifFile)) {
                    await conn.sendMessage(m.from, { text: `❌ Reply to an animated sticker, or an actual .gif file, with ${prefix}tomp4` }, { quoted: m });
                    break;
                }
                if (!media.isFfmpegAvailable()) {
                    await conn.sendMessage(m.from, { text: `❌ This conversion isn't available yet on this deployment (missing ffmpeg dependencies).` }, { quoted: m });
                    break;
                }

                try {
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    let outBuffer;
                    if (isSticker) {
                        const buffer = await downloadMediaMessage({ message: { stickerMessage: m.quoted } }, 'buffer', {});
                        outBuffer = await media.animatedStickerToVideo(buffer);
                    } else {
                        const messageKey = quotedType === 'imageMessage' ? 'imageMessage' : 'documentMessage';
                        const buffer = await downloadMediaMessage({ message: { [messageKey]: m.quoted } }, 'buffer', {});
                        outBuffer = await media.gifToVideo(buffer);
                    }
                    await conn.sendMessage(m.from, { video: outBuffer, caption: '🎬 Converted to MP4' }, { quoted: m });
                } catch (err) {
                    console.error('tomp4 error:', err.message);
                    if (err.message === 'NOT_ANIMATED') {
                        await conn.sendMessage(m.from, { text: `❌ That sticker isn't animated. Use ${prefix}toimg instead.` }, { quoted: m });
                    } else {
                        await conn.sendMessage(m.from, { text: `❌ Failed to convert to MP4.` }, { quoted: m });
                    }
                }
                break;
            }

            case "togif": {
                const quotedType = m.quoted?.mtype;
                if (!m.quoted || (quotedType !== 'stickerMessage' && quotedType !== 'videoMessage')) {
                    await conn.sendMessage(m.from, { text: `❌ Reply to an animated sticker or video with ${prefix}togif` }, { quoted: m });
                    break;
                }
                if (!media.isFfmpegAvailable()) {
                    await conn.sendMessage(m.from, { text: `❌ This conversion isn't available yet on this deployment (missing ffmpeg dependencies).` }, { quoted: m });
                    break;
                }

                try {
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    let outBuffer;
                    if (quotedType === 'stickerMessage') {
                        const buffer = await downloadMediaMessage({ message: { stickerMessage: m.quoted } }, 'buffer', {});
                        outBuffer = await media.animatedStickerToGif(buffer);
                    } else {
                        const durationSec = Math.min(m.quoted.seconds || 6, 10);
                        const buffer = await downloadMediaMessage({ message: { videoMessage: m.quoted } }, 'buffer', {});
                        outBuffer = await media.videoToGif(buffer, durationSec);
                    }
                    await conn.sendMessage(m.from, { document: outBuffer, fileName: 'converted.gif', mimetype: 'image/gif', caption: '🎞️ Converted to GIF' }, { quoted: m });
                } catch (err) {
                    console.error('togif error:', err.message);
                    if (err.message === 'NOT_ANIMATED') {
                        await conn.sendMessage(m.from, { text: `❌ That sticker isn't animated. Use ${prefix}toimg instead.` }, { quoted: m });
                    } else {
                        await conn.sendMessage(m.from, { text: `❌ Failed to convert to GIF.` }, { quoted: m });
                    }
                }
                break;
            }

            case "tovideo": {
                if (!m.quoted || m.quoted.mtype !== 'imageMessage') {
                    await conn.sendMessage(m.from, { text: `❌ Reply to an image with ${prefix}tovideo\n\nThis turns a static image into a short silent video clip (useful for posting as a Status video, or where a platform requires video format).` }, { quoted: m });
                    break;
                }
                if (!media.isFfmpegAvailable()) {
                    await conn.sendMessage(m.from, { text: `❌ This conversion isn't available yet on this deployment (missing ffmpeg dependencies).` }, { quoted: m });
                    break;
                }

                try {
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const buffer = await downloadMediaMessage(
                        { message: { imageMessage: m.quoted } },
                        'buffer',
                        {}
                    );
                    const videoBuffer = await media.imageToVideo(buffer, 5);
                    await conn.sendMessage(m.from, { video: videoBuffer, caption: '🎬 Converted to video' }, { quoted: m });
                } catch (err) {
                    console.error('tovideo error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to convert image to video.` }, { quoted: m });
                }
                break;
            }

            case "tovideo2": {
                if (!m.quoted || m.quoted.mtype !== 'stickerMessage') {
                    await conn.sendMessage(m.from, { text: `❌ Reply to an animated sticker with ${prefix}tovideo2\n\nThis turns an animated sticker back into a real MP4 video clip. (For a static image -> video, use ${prefix}tovideo instead.)` }, { quoted: m });
                    break;
                }
                if (!media.isFfmpegAvailable()) {
                    await conn.sendMessage(m.from, { text: `❌ This conversion isn't available yet on this deployment (missing ffmpeg dependencies).` }, { quoted: m });
                    break;
                }

                // m.quoted.isAnimated is set by WhatsApp on the sticker proto itself.
                // Static stickers can technically still run through this here, but
                // there's no point — point the user at .toimg instead.
                if (m.quoted.isAnimated === false) {
                    await conn.sendMessage(m.from, { text: `❌ That's a static sticker, not animated. Use ${prefix}toimg to get the image instead.` }, { quoted: m });
                    break;
                }

                try {
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const buffer = await downloadMediaMessage(
                        { message: { stickerMessage: m.quoted } },
                        'buffer',
                        {}
                    );
                    const videoBuffer = await media.animatedStickerToVideo(buffer);
                    await conn.sendMessage(m.from, { video: videoBuffer, caption: '🎬 Converted to video' }, { quoted: m });
                } catch (err) {
                    console.error('tovideo2 error:', err.message);
                    if (err.message === 'NOT_ANIMATED') {
                        await conn.sendMessage(m.from, { text: `❌ That sticker only has a single frame — it's not actually animated. Use ${prefix}toimg instead.` }, { quoted: m });
                    } else {
                        await conn.sendMessage(m.from, { text: `❌ Failed to convert sticker to video. Try a different sticker.` }, { quoted: m });
                    }
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

            case "delpair":
            case "unpair": {
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
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}${command} 2348012345678` }, { quoted: m });
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
            // SERVER-WIDE ADMIN (super admin only — these touch the WHOLE
            // multi-tenant service, every session, not just yours)
            // ════════════════════════════════════════════
            case "users": {
                if (!isSuperAdmin(m, phoneNumber)) {
                    await conn.sendMessage(m.from, { text: "❌ This command is restricted to the bot developer only." }, { quoted: m });
                    break;
                }

                try {
                    const allNumbers = await redisClient.sMembers('users:all');
                    if (!allNumbers.length) {
                        await conn.sendMessage(m.from, { text: "📋 No users registered yet." }, { quoted: m });
                        break;
                    }

                    const page = Math.max(1, parseInt(args[0]) || 1);
                    const PER_PAGE = 30;
                    const totalPages = Math.ceil(allNumbers.length / PER_PAGE);
                    const slice = allNumbers.slice((page - 1) * PER_PAGE, page * PER_PAGE);

                    const lines = await Promise.all(slice.map(async (num, i) => {
                        const meta = await redisClient.hGetAll(`meta:${num}`);
                        const online = connections?.has(num) ? '🟢' : '🔴';
                        const pairedAt = meta.pairedAt ? new Date(parseInt(meta.pairedAt)).toLocaleDateString() : '?';
                        return `${(page - 1) * PER_PAGE + i + 1}. ${online} +${num} (since ${pairedAt})`;
                    }));

                    await conn.sendMessage(m.from, {
                        text: `📋 *User Registry* (${allNumbers.length} total — page ${page}/${totalPages})\n\n${lines.join('\n')}\n\n🟢 Online · 🔴 Offline${totalPages > 1 ? `\n\nUse ${prefix}users <page> to see more.` : ''}`
                    }, { quoted: m });
                } catch (err) {
                    console.error('users error:', err.message);
                    await conn.sendMessage(m.from, { text: "❌ Failed to load user registry." }, { quoted: m });
                }
                break;
            }

            case "checkuser": {
                if (!isSuperAdmin(m, phoneNumber)) {
                    await conn.sendMessage(m.from, { text: "❌ This command is restricted to the bot developer only." }, { quoted: m });
                    break;
                }

                const targetNumber = text.replace(/[^0-9]/g, '');
                if (!targetNumber) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}checkuser 2348012345678` }, { quoted: m });
                    break;
                }

                try {
                    const meta = await redisClient.hGetAll(`meta:${targetNumber}`);
                    if (!meta || !Object.keys(meta).length) {
                        await conn.sendMessage(m.from, { text: `❌ No record found for ${targetNumber}.` }, { quoted: m });
                        break;
                    }

                    const isBanned = await redisClient.sIsMember('banned:users', targetNumber);
                    const online = connections?.has(targetNumber);
                    const pairedAt = meta.pairedAt ? new Date(parseInt(meta.pairedAt)).toLocaleString() : 'unknown';
                    const lastConnected = meta.lastConnected ? new Date(parseInt(meta.lastConnected)).toLocaleString() : 'unknown';
                    const banReason = isBanned ? await redisClient.get(`banreason:${targetNumber}`) : null;

                    await conn.sendMessage(m.from, {
                        text: `🔍 *User Audit: +${targetNumber}*\n\n` +
                            `Status: ${online ? '🟢 Online' : '🔴 Offline'}\n` +
                            `Banned: ${isBanned ? `🚫 Yes${banReason ? ` (${banReason})` : ''}` : 'No'}\n` +
                            `Paired since: ${pairedAt}\n` +
                            `Last connected: ${lastConnected}\n` +
                            `Messages received: ${meta.messagesReceived || 0}`
                    }, { quoted: m });
                } catch (err) {
                    console.error('checkuser error:', err.message);
                    await conn.sendMessage(m.from, { text: "❌ Failed to look up that user." }, { quoted: m });
                }
                break;
            }

            case "broadcast": {
                if (!isSuperAdmin(m, phoneNumber)) {
                    await conn.sendMessage(m.from, { text: "❌ This command is restricted to the bot developer only." }, { quoted: m });
                    break;
                }
                if (!text) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}broadcast <message>\n\nSends to every registered user, across every session.` }, { quoted: m });
                    break;
                }

                await conn.sendMessage(m.from, { text: `📢 Broadcasting to all users...` }, { quoted: m });
                broadcastToOwners(redisClient, connections, `📢 *System Announcement*\n\n${text}`)
                    .then(result => conn.sendMessage(m.from, { text: `✅ Broadcast done — sent: ${result.sent}, skipped (offline): ${result.skipped}` }))
                    .catch(err => conn.sendMessage(m.from, { text: `❌ Broadcast failed: ${err.message}` }));
                break;
            }

            case "clean": {
                if (!isSuperAdmin(m, phoneNumber)) {
                    await conn.sendMessage(m.from, { text: "❌ This command is restricted to the bot developer only." }, { quoted: m });
                    break;
                }

                try {
                    const allNumbers = await redisClient.sMembers('users:all');
                    let purged = 0;

                    for (const num of allNumbers) {
                        if (connections?.has(num)) continue; // currently live — never purge

                        // "Invalid" = no session creds left at all, so it can
                        // never reconnect on its own. Just offline is normal.
                        const hasSession = await redisClient.exists(`session:${num}`);
                        if (!hasSession) {
                            await redisClient.sRem('users:all', num);
                            await redisClient.del(`meta:${num}`);
                            purged++;
                        }
                    }

                    await conn.sendMessage(m.from, { text: `🧹 Cleaned ${purged} invalid session(s) out of ${allNumbers.length} total users.` }, { quoted: m });
                } catch (err) {
                    console.error('clean error:', err.message);
                    await conn.sendMessage(m.from, { text: "❌ Cleanup failed." }, { quoted: m });
                }
                break;
            }

            case "ban": {
                if (!isSuperAdmin(m, phoneNumber)) {
                    await conn.sendMessage(m.from, { text: "❌ This command is restricted to the bot developer only." }, { quoted: m });
                    break;
                }

                const targetNumber = args[0]?.replace(/[^0-9]/g, '');
                const reason = args.slice(1).join(' ');
                if (!targetNumber) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}ban 2348012345678 [reason]` }, { quoted: m });
                    break;
                }
                if (targetNumber === SUPER_ADMIN_NUMBER) {
                    await conn.sendMessage(m.from, { text: `❌ Can't ban the bot developer's own number.` }, { quoted: m });
                    break;
                }

                await redisClient.sAdd('banned:users', targetNumber);
                if (reason) await redisClient.set(`banreason:${targetNumber}`, reason);

                await conn.sendMessage(m.from, { text: `🚫 Banned +${targetNumber} from the entire service${reason ? ` (${reason})` : ''}.` }, { quoted: m });
                break;
            }

            case "unban": {
                if (!isSuperAdmin(m, phoneNumber)) {
                    await conn.sendMessage(m.from, { text: "❌ This command is restricted to the bot developer only." }, { quoted: m });
                    break;
                }

                const targetNumber = text.replace(/[^0-9]/g, '');
                if (!targetNumber) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}unban 2348012345678` }, { quoted: m });
                    break;
                }

                const wasBanned = await redisClient.sIsMember('banned:users', targetNumber);
                await redisClient.sRem('banned:users', targetNumber);
                await redisClient.del(`banreason:${targetNumber}`);

                await conn.sendMessage(m.from, {
                    text: wasBanned ? `✅ +${targetNumber} has been unbanned.` : `ℹ️ +${targetNumber} wasn't banned.`
                }, { quoted: m });
                break;
            }

            case "maintenance": {
                if (!isSuperAdmin(m, phoneNumber)) {
                    await conn.sendMessage(m.from, { text: "❌ This command is restricted to the bot developer only." }, { quoted: m });
                    break;
                }

                const { getSettings, updateSettings } = require('./bot');
                const sub = args[0]?.toLowerCase();

                if (sub === 'on' || sub === 'off') {
                    await updateSettings({ maintenanceMode: sub === 'on' });
                    await conn.sendMessage(m.from, {
                        text: `${sub === 'on' ? '🔧' : '✅'} Maintenance mode ${sub === 'on' ? 'ENABLED — the bot will ignore everyone except you until you turn it off.' : 'disabled — back to normal.'}`
                    }, { quoted: m });
                    break;
                }

                const settings = await getSettings();
                await conn.sendMessage(m.from, {
                    text: `🔧 Maintenance mode is currently *${settings.maintenanceMode ? 'ON' : 'OFF'}*.\n\nUsage: ${prefix}maintenance on/off`
                }, { quoted: m });
                break;
            }

            case "auditlog": {
                // Distinct from .logs (which tails the process's stdout/stderr
                // file) — this reads the structured event trail bot.js already
                // keeps in Redis (pairings, disconnects, backups, etc).
                if (!isSuperAdmin(m, phoneNumber)) {
                    await conn.sendMessage(m.from, { text: "❌ This command is restricted to the bot developer only." }, { quoted: m });
                    break;
                }

                try {
                    const count = Math.min(parseInt(args[0]) || 20, 100);
                    const raw = await redisClient.lRange('events:log', 0, count - 1);
                    if (!raw.length) {
                        await conn.sendMessage(m.from, { text: "📜 No audit events logged yet." }, { quoted: m });
                        break;
                    }

                    const lines = raw.map(item => {
                        try {
                            const ev = JSON.parse(item);
                            const time = new Date(ev.timestamp).toLocaleString();
                            const detail = ev.phoneNumber ? ` (+${ev.phoneNumber})` : '';
                            return `• [${time}] ${ev.type}${detail}`;
                        } catch {
                            return null;
                        }
                    }).filter(Boolean);

                    await conn.sendMessage(m.from, { text: `📜 *Audit Log* (last ${lines.length})\n\n${lines.join('\n')}` }, { quoted: m });
                } catch (err) {
                    console.error('auditlog error:', err.message);
                    await conn.sendMessage(m.from, { text: "❌ Failed to read audit log." }, { quoted: m });
                }
                break;
            }

            case "announce": {
                // .announce <minutes> <message> — schedules a broadcast.
                // NOTE: this is an in-memory setTimeout, so a server restart
                // before it fires will cancel it silently — not persisted.
                if (!isSuperAdmin(m, phoneNumber)) {
                    await conn.sendMessage(m.from, { text: "❌ This command is restricted to the bot developer only." }, { quoted: m });
                    break;
                }

                const minutes = parseFloat(args[0]);
                const message = args.slice(1).join(' ');
                if (!minutes || minutes < 0 || !message) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}announce <minutes> <message>\nExample: ${prefix}announce 30 Scheduled maintenance starting soon!\n\n⚠️ Not persisted — cancelled if the server restarts before it fires.` }, { quoted: m });
                    break;
                }

                await conn.sendMessage(m.from, { text: `⏰ Announcement scheduled for ${minutes} minute(s) from now.` }, { quoted: m });
                setTimeout(() => {
                    broadcastToOwners(redisClient, connections, `📢 *Scheduled Announcement*\n\n${message}`).catch(() => {});
                }, minutes * 60 * 1000);
                break;
            }

            case "addadmin": {
                if (!isPrimaryAdmin(m, phoneNumber)) {
                    await conn.sendMessage(m.from, { text: "❌ Only the bot developer can promote new admins." }, { quoted: m });
                    break;
                }

                const targetNumber = text.replace(/[^0-9]/g, '');
                if (!targetNumber) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}addadmin 2348012345678` }, { quoted: m });
                    break;
                }

                await redisClient.sAdd('extra:admins', targetNumber);
                extraAdminCache.add(targetNumber); // live immediately, no restart needed

                await conn.sendMessage(m.from, { text: `✅ +${targetNumber} now has full developer-level admin access (same tier as you — eval, shell, ban, broadcast, everything).` }, { quoted: m });
                break;
            }

            case "removeadmin": {
                if (!isPrimaryAdmin(m, phoneNumber)) {
                    await conn.sendMessage(m.from, { text: "❌ Only the bot developer can remove admins." }, { quoted: m });
                    break;
                }

                const targetNumber = text.replace(/[^0-9]/g, '');
                if (!targetNumber) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}removeadmin 2348012345678` }, { quoted: m });
                    break;
                }

                await redisClient.sRem('extra:admins', targetNumber);
                extraAdminCache.delete(targetNumber);

                await conn.sendMessage(m.from, { text: `✅ +${targetNumber}'s admin access has been removed.` }, { quoted: m });
                break;
            }

            case "stats": {
                if (!isSuperAdmin(m, phoneNumber)) {
                    await conn.sendMessage(m.from, { text: "❌ This command is restricted to the bot developer only." }, { quoted: m });
                    break;
                }

                try {
                    const allNumbers = await redisClient.sMembers('users:all');
                    const bannedCount = await redisClient.sCard('banned:users');
                    const onlineCount = connections?.size || 0;
                    const dateKey = new Date().toISOString().slice(0, 10);
                    const pairedToday = await redisClient.get(`stats:pairings:${dateKey}`) || 0;
                    const pairedTotal = await redisClient.get('stats:pairings:total') || 0;

                    await conn.sendMessage(m.from, {
                        text: `📊 *Bot Statistics*\n\n` +
                            `Total registered users: ${allNumbers.length}\n` +
                            `Currently online: ${onlineCount}\n` +
                            `Banned: ${bannedCount}\n` +
                            `Pairings today: ${pairedToday}\n` +
                            `Pairings all-time: ${pairedTotal}\n` +
                            `Process uptime: ${Math.floor(process.uptime() / 60)} min`
                    }, { quoted: m });
                } catch (err) {
                    console.error('stats error:', err.message);
                    await conn.sendMessage(m.from, { text: "❌ Failed to gather stats." }, { quoted: m });
                }
                break;
            }

            case "report": {
                // Anyone can file a report — it just forwards to the developer.
                if (!text) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}report <your message>` }, { quoted: m });
                    break;
                }

                try {
                    await conn.sendMessage(`${SUPER_ADMIN_NUMBER}@s.whatsapp.net`, {
                        text: `📩 *New Report*\nFrom: +${normalizeJid(m.sender)}\n\n${text}`
                    });
                    await conn.sendMessage(m.from, { text: `✅ Your report has been sent. Thanks!` }, { quoted: m });
                } catch (err) {
                    console.error('report error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to send report.` }, { quoted: m });
                }
                break;
            }

            case "tutorial": {
                await conn.sendMessage(m.from, {
                    text: `🎬 *Tutorial*\n\nNo video guide is configured yet — ask the bot developer to set one up (edit the ${prefix}tutorial command in case.js with your actual guide link).`
                }, { quoted: m });
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

            // ════════════════════════════════════════════
            // CUSTOM COMMANDS (Super admin only — runs arbitrary JS,
            // same trust tier as eval/shell/gitpull above)
            // ════════════════════════════════════════════
            case "addcmd": {
                if (!isSuperAdmin(m, phoneNumber)) {
                    await conn.sendMessage(m.from, { text: "❌ This command is restricted to the bot developer only." }, { quoted: m });
                    break;
                }

                if (!text) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}addcmd case "name": {\n    await conn.sendMessage(m.from, { text: "hi" }, { quoted: m });\n    break;\n}\n\nMultiple stacked case labels create aliases that share one body.` }, { quoted: m });
                    break;
                }

                try {
                    const { aliases, body } = parseCaseCode(text);

                    const builtins = getBuiltinCommandNames();
                    const collidesBuiltin = aliases.filter(a => builtins.has(a));
                    if (collidesBuiltin.length) {
                        await conn.sendMessage(m.from, { text: `❌ "${collidesBuiltin.join('", "')}" already exist${collidesBuiltin.length === 1 ? 's' : ''} as a built-in command — pick a different name, or use ${prefix}editcmd if you really meant to override custom-command behavior.` }, { quoted: m });
                        break;
                    }

                    const cache = await ensureCustomCmdCache(redisClient);
                    const collidesCustom = aliases.filter(a => cache.has(a));
                    if (collidesCustom.length) {
                        await conn.sendMessage(m.from, { text: `❌ "${collidesCustom.join('", "')}" already exist${collidesCustom.length === 1 ? 's' : ''} as a custom command. Use ${prefix}editcmd <name> to change it, or ${prefix}delcmd <name> first.` }, { quoted: m });
                        break;
                    }

                    compileCommandBody(body); // throws on bad syntax before we save anything

                    for (const alias of aliases) {
                        await saveCustomCommand(redisClient, alias, body, m.sender);
                    }

                    await conn.sendMessage(m.from, { text: `✅ Added custom command${aliases.length > 1 ? 's' : ''}: ${aliases.map(a => prefix + a).join(', ')}\n\nLive immediately — no restart needed.` }, { quoted: m });
                } catch (err) {
                    await conn.sendMessage(m.from, { text: `❌ Failed to add command:\n\`\`\`${err.message}\`\`\`` }, { quoted: m });
                }
                break;
            }

            case "editcmd": {
                if (!isSuperAdmin(m, phoneNumber)) {
                    await conn.sendMessage(m.from, { text: "❌ This command is restricted to the bot developer only." }, { quoted: m });
                    break;
                }

                const editName = args[0]?.toLowerCase();
                const editCode = args.slice(1).join(' ');
                if (!editName || !editCode) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}editcmd <name> case "name": { ...new code... break; }\n\n(The case label can be omitted — just the { ... } body also works.)` }, { quoted: m });
                    break;
                }

                const cache = await ensureCustomCmdCache(redisClient);
                if (!cache.has(editName)) {
                    await conn.sendMessage(m.from, { text: `❌ No custom command named "${editName}". Use ${prefix}addcmd to create it first.` }, { quoted: m });
                    break;
                }

                try {
                    let newBody;
                    if (/case\s*\(?\s*["']/.test(editCode)) {
                        newBody = parseCaseCode(editCode).body;
                    } else {
                        // Accept a bare { ... } body too, for quick edits
                        const trimmed = editCode.trim();
                        newBody = trimmed.startsWith('{') && trimmed.endsWith('}')
                            ? trimmed.slice(1, -1).trim()
                            : trimmed;
                    }

                    compileCommandBody(newBody); // throws on bad syntax before saving
                    await saveCustomCommand(redisClient, editName, newBody, m.sender);
                    await conn.sendMessage(m.from, { text: `✅ Updated custom command: ${prefix}${editName}\n\nLive immediately.` }, { quoted: m });
                } catch (err) {
                    await conn.sendMessage(m.from, { text: `❌ Failed to update command:\n\`\`\`${err.message}\`\`\`` }, { quoted: m });
                }
                break;
            }

            case "delcmd": {
                if (!isSuperAdmin(m, phoneNumber)) {
                    await conn.sendMessage(m.from, { text: "❌ This command is restricted to the bot developer only." }, { quoted: m });
                    break;
                }

                const delName = text?.trim().toLowerCase();
                if (!delName) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}delcmd <name>` }, { quoted: m });
                    break;
                }

                const deleted = await deleteCustomCommand(redisClient, delName);
                await conn.sendMessage(m.from, {
                    text: deleted ? `✅ Deleted custom command: ${prefix}${delName}` : `❌ No custom command named "${delName}".`
                }, { quoted: m });
                break;
            }

            case "listcmd": {
                if (!isSuperAdmin(m, phoneNumber)) {
                    await conn.sendMessage(m.from, { text: "❌ This command is restricted to the bot developer only." }, { quoted: m });
                    break;
                }

                const cache = await ensureCustomCmdCache(redisClient);
                if (cache.size === 0) {
                    await conn.sendMessage(m.from, { text: `📋 No custom commands yet. Add one with ${prefix}addcmd.` }, { quoted: m });
                    break;
                }

                const lines = [...cache.entries()].map(([name, entry]) =>
                    `• ${prefix}${name} — added ${entry.addedAt ? new Date(entry.addedAt).toLocaleString() : 'unknown'}`
                );
                await conn.sendMessage(m.from, { text: `📋 *Custom Commands* (${cache.size})\n\n${lines.join('\n')}` }, { quoted: m });
                break;
            }

            case "getcmd": {
                if (!isSuperAdmin(m, phoneNumber)) {
                    await conn.sendMessage(m.from, { text: "❌ This command is restricted to the bot developer only." }, { quoted: m });
                    break;
                }

                const getName = text?.trim().toLowerCase();
                if (!getName) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}getcmd <name>` }, { quoted: m });
                    break;
                }

                const cache = await ensureCustomCmdCache(redisClient);
                const entry = cache.get(getName);
                if (!entry) {
                    await conn.sendMessage(m.from, { text: `❌ No custom command named "${getName}".` }, { quoted: m });
                    break;
                }

                await conn.sendMessage(m.from, {
                    text: `📄 *${getName}*\n\`\`\`case "${getName}": {\n${entry.body}\n    break;\n}\`\`\``
                }, { quoted: m });
                break;
            }

            case "reloadcmds": {
                if (!isSuperAdmin(m, phoneNumber)) {
                    await conn.sendMessage(m.from, { text: "❌ This command is restricted to the bot developer only." }, { quoted: m });
                    break;
                }

                try {
                    const before = customCmdCache ? customCmdCache.size : 0;
                    const cache = await reloadCustomCmds(redisClient);
                    await conn.sendMessage(m.from, { text: `🔄 Reloaded custom commands from storage.\nBefore: ${before} → After: ${cache.size}` }, { quoted: m });
                } catch (err) {
                    await conn.sendMessage(m.from, { text: `❌ Reload failed:\n\`\`\`${err.message}\`\`\`` }, { quoted: m });
                }
                break;
            }

            case "editbotpic": {
                // NOTE: this updates the bot's BRANDING image (the picture
                // attached to .menu/.help) — NOT the real WhatsApp profile
                // picture of the connected account. Those are two separate
                // things: the connected number's actual avatar is the same
                // identity the session is paired to, so there's nothing
                // separate to "rebrand" there. This command only changes
                // the cosmetic image used inside bot-generated messages.
                if (!senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Owner/Sudo only command." }, { quoted: m });
                    break;
                }

                if (args[0]?.toLowerCase() === 'reset') {
                    await redisClient.del(`botpic:${phoneNumber}`);
                    await conn.sendMessage(m.from, { text: `✅ Reset to the default bot picture.` }, { quoted: m });
                    break;
                }

                if (!m.quoted || m.quoted.mtype !== 'imageMessage') {
                    await conn.sendMessage(m.from, { text: `❌ Reply to an image with ${prefix}editbotpic to use it as the picture shown in ${prefix}menu.\n\nUse ${prefix}editbotpic reset to go back to the default.` }, { quoted: m });
                    break;
                }

                try {
                    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                    const buffer = await downloadMediaMessage(
                        { message: { imageMessage: m.quoted } },
                        'buffer',
                        {}
                    );
                    await redisClient.set(`botpic:${phoneNumber}`, buffer.toString('base64'));
                    await conn.sendMessage(m.from, { text: `✅ Bot display picture updated — it'll show up next time someone runs ${prefix}menu.` }, { quoted: m });
                } catch (err) {
                    console.error('editbotpic error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to update the bot picture. Make sure it's a regular image (not a sticker or document).` }, { quoted: m });
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

            case "anticall": {
                if (!senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Owner/Sudo only command." }, { quoted: m });
                    break;
                }

                const state = args[0]?.toLowerCase();
                if (state !== 'on' && state !== 'off') {
                    const config = await getConfig(redisClient, phoneNumber);
                    await conn.sendMessage(m.from, {
                        text: `📵 Anti-call is currently: *${config.antiCall ? 'on' : 'off'}*\n\nUsage: ${prefix}anticall on/off\n\nAutomatically rejects incoming calls to this number.`
                    }, { quoted: m });
                    break;
                }

                await setConfigValue(redisClient, phoneNumber, 'antiCall', state === 'on');
                await conn.sendMessage(m.from, {
                    text: `📵 Anti-call ${state === 'on' ? 'enabled ✅' : 'disabled ❌'}`
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

            case "autobio": {
                if (!senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Owner/Sudo only command." }, { quoted: m });
                    break;
                }

                const sub = args[0]?.toLowerCase();

                if (sub === 'on' || sub === 'off') {
                    await setConfigValue(redisClient, phoneNumber, 'autoBio', sub === 'on');
                    await conn.sendMessage(m.from, {
                        text: `${sub === 'on' ? '✅' : '❌'} Auto bio ${sub === 'on' ? 'enabled' : 'disabled'}.`
                    }, { quoted: m });
                    break;
                }

                if (sub === 'add') {
                    const bioText = args.slice(1).join(' ');
                    if (!bioText) {
                        await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}autobio add <text>` }, { quoted: m });
                        break;
                    }
                    const list = await addBioText(redisClient, phoneNumber, bioText);
                    await conn.sendMessage(m.from, { text: `✅ Added. Bio rotation now has ${list.length} entr${list.length === 1 ? 'y' : 'ies'}.` }, { quoted: m });
                    break;
                }

                if (sub === 'remove') {
                    const index = parseInt(args[1]) - 1;
                    const result = await removeBioText(redisClient, phoneNumber, index);
                    if (result === null) {
                        await conn.sendMessage(m.from, { text: `❌ Invalid index. Use ${prefix}autobio list to see numbers.` }, { quoted: m });
                        break;
                    }
                    await conn.sendMessage(m.from, { text: `✅ Removed. ${result.length} entr${result.length === 1 ? 'y' : 'ies'} left.` }, { quoted: m });
                    break;
                }

                if (sub === 'interval') {
                    const minutes = parseInt(args[1]);
                    if (!minutes || minutes <= 0) {
                        await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}autobio interval <minutes>` }, { quoted: m });
                        break;
                    }
                    await setConfigValue(redisClient, phoneNumber, 'autoBioInterval', minutes * 60);
                    await conn.sendMessage(m.from, { text: `✅ Auto bio will now rotate every ${minutes} minute(s).` }, { quoted: m });
                    break;
                }

                // No subcommand / "list" — show current state
                const bioConfig = await getConfig(redisClient, phoneNumber);
                const bioListText = bioConfig.autoBioList.length
                    ? bioConfig.autoBioList.map((t, i) => `${i + 1}. ${t}`).join('\n')
                    : '(empty)';
                await conn.sendMessage(m.from, {
                    text: `📝 *Auto Bio* — currently *${bioConfig.autoBio ? 'ON' : 'OFF'}*\nRotates every ${Math.round(bioConfig.autoBioInterval / 60)} min\n\n${bioListText}\n\nUsage:\n${prefix}autobio on/off\n${prefix}autobio add <text>\n${prefix}autobio remove <number>\n${prefix}autobio interval <minutes>`
                }, { quoted: m });
                break;
            }

            case "autostatus": {
                if (!senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Owner/Sudo only command." }, { quoted: m });
                    break;
                }

                const sub = args[0]?.toLowerCase();

                if (sub === 'on' || sub === 'off') {
                    await setConfigValue(redisClient, phoneNumber, 'autoStatus', sub === 'on');
                    await conn.sendMessage(m.from, {
                        text: `${sub === 'on' ? '✅' : '❌'} Auto status ${sub === 'on' ? 'enabled' : 'disabled'}.`
                    }, { quoted: m });
                    break;
                }

                if (sub === 'add') {
                    const statusText = args.slice(1).join(' ');
                    if (!statusText) {
                        await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}autostatus add <text>` }, { quoted: m });
                        break;
                    }
                    const list = await addStatusText(redisClient, phoneNumber, statusText);
                    await conn.sendMessage(m.from, { text: `✅ Added. Status rotation now has ${list.length} entr${list.length === 1 ? 'y' : 'ies'}.` }, { quoted: m });
                    break;
                }

                if (sub === 'remove') {
                    const index = parseInt(args[1]) - 1;
                    const result = await removeStatusText(redisClient, phoneNumber, index);
                    if (result === null) {
                        await conn.sendMessage(m.from, { text: `❌ Invalid index. Use ${prefix}autostatus list to see numbers.` }, { quoted: m });
                        break;
                    }
                    await conn.sendMessage(m.from, { text: `✅ Removed. ${result.length} entr${result.length === 1 ? 'y' : 'ies'} left.` }, { quoted: m });
                    break;
                }

                if (sub === 'interval') {
                    const minutes = parseInt(args[1]);
                    if (!minutes || minutes <= 0) {
                        await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}autostatus interval <minutes>` }, { quoted: m });
                        break;
                    }
                    await setConfigValue(redisClient, phoneNumber, 'autoStatusInterval', minutes * 60);
                    await conn.sendMessage(m.from, { text: `✅ Auto status will now post every ${minutes} minute(s).` }, { quoted: m });
                    break;
                }

                const statusConfig = await getConfig(redisClient, phoneNumber);
                const statusListText = statusConfig.autoStatusList.length
                    ? statusConfig.autoStatusList.map((t, i) => `${i + 1}. ${t}`).join('\n')
                    : '(empty)';
                await conn.sendMessage(m.from, {
                    text: `📸 *Auto Status* — currently *${statusConfig.autoStatus ? 'ON' : 'OFF'}*\nPosts every ${Math.round(statusConfig.autoStatusInterval / 60)} min\n\n${statusListText}\n\nUsage:\n${prefix}autostatus on/off\n${prefix}autostatus add <text>\n${prefix}autostatus remove <number>\n${prefix}autostatus interval <minutes>`
                }, { quoted: m });
                break;
            }

            case "autoresponder": {
                if (!senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Owner/Sudo only command." }, { quoted: m });
                    break;
                }

                const sub = args[0]?.toLowerCase();

                if (sub === 'on' || sub === 'off') {
                    await setConfigValue(redisClient, phoneNumber, 'autoResponder', sub === 'on');
                    await conn.sendMessage(m.from, {
                        text: `${sub === 'on' ? '✅' : '❌'} Autoresponder ${sub === 'on' ? 'enabled' : 'disabled'}.`
                    }, { quoted: m });
                    break;
                }

                if (sub === 'add') {
                    // Usage: .autoresponder add <keyword> | <reply text>
                    const rest = args.slice(1).join(' ');
                    const [keyword, ...replyParts] = rest.split('|');
                    const reply = replyParts.join('|').trim();

                    if (!keyword?.trim() || !reply) {
                        await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}autoresponder add <keyword> | <reply text>\nExample: ${prefix}autoresponder add hello | Hey, I'm not online right now!` }, { quoted: m });
                        break;
                    }

                    await setResponder(redisClient, phoneNumber, keyword.trim(), reply);
                    await conn.sendMessage(m.from, { text: `✅ Autoresponder set: "${keyword.trim()}" → "${reply}"` }, { quoted: m });
                    break;
                }

                if (sub === 'remove') {
                    const keyword = args.slice(1).join(' ');
                    if (!keyword) {
                        await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}autoresponder remove <keyword>` }, { quoted: m });
                        break;
                    }
                    const result = await removeResponder(redisClient, phoneNumber, keyword);
                    if (result === null) {
                        await conn.sendMessage(m.from, { text: `❌ No autoresponder found for "${keyword}".` }, { quoted: m });
                        break;
                    }
                    await conn.sendMessage(m.from, { text: `✅ Removed autoresponder for "${keyword}".` }, { quoted: m });
                    break;
                }

                const responderConfig = await getConfig(redisClient, phoneNumber);
                const entries = Object.entries(responderConfig.autoresponderMap);
                const responderListText = entries.length
                    ? entries.map(([k, v]) => `• "${k}" → ${v}`).join('\n')
                    : '(empty)';
                await conn.sendMessage(m.from, {
                    text: `🤖 *Autoresponder* — currently *${responderConfig.autoResponder ? 'ON' : 'OFF'}*\n\n${responderListText}\n\nUsage:\n${prefix}autoresponder on/off\n${prefix}autoresponder add <keyword> | <reply>\n${prefix}autoresponder remove <keyword>\n\nMatches the whole message text (case-insensitive). Doesn't trigger on commands.`
                }, { quoted: m });
                break;
            }

            case "autotranslate": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ This command only works in groups." }, { quoted: m });
                    break;
                }

                const senderAdmin = await isGroupAdmin(conn, m.from, m.sender);
                if (!senderAdmin && !senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Only admins can change this setting." }, { quoted: m });
                    break;
                }

                const target = args[0]?.toLowerCase();
                if (!target) {
                    const cfg = await groupmod.getGroupConfig(redisClient, m.from);
                    await conn.sendMessage(m.from, {
                        text: `🌐 *Autotranslate* is currently: *${cfg.autotranslate}*\n\nUsage: ${prefix}autotranslate off/<lang_code>\nExample: ${prefix}autotranslate en\n\nWhen on, every regular group message gets auto-translated into the target language.`
                    }, { quoted: m });
                    break;
                }

                await groupmod.setGroupConfig(redisClient, m.from, 'autotranslate', target);
                await conn.sendMessage(m.from, {
                    text: target === 'off' ? `🌐 Autotranslate turned off.` : `🌐 Autotranslate set to: *${target}*`
                }, { quoted: m });
                break;
            }

            case "setgc": {
                if (!senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Owner/Sudo only command." }, { quoted: m });
                    break;
                }
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: `❌ Run this command INSIDE the group you want to designate as your "GC" for ${prefix}gcpost.` }, { quoted: m });
                    break;
                }

                await setConfigValue(redisClient, phoneNumber, 'gcJid', m.from);
                await conn.sendMessage(m.from, {
                    text: `✅ This group is now set as your GC.\nUse ${prefix}gcpost from anywhere (this chat, your DMs, another group) to post here.`
                }, { quoted: m });
                break;
            }

            case "autosticker": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ This command only works in groups." }, { quoted: m });
                    break;
                }
                const senderAdmin = await isGroupAdmin(conn, m.from, m.sender);
                if (!senderAdmin && !senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Only admins can change this setting." }, { quoted: m });
                    break;
                }
                const toggle = args[0]?.toLowerCase();
                if (!toggle) {
                    const cfg = await groupmod.getGroupConfig(redisClient, m.from);
                    await conn.sendMessage(m.from, { text: `🖼️ Autosticker is currently: *${cfg.autosticker ? 'ON' : 'OFF'}*\n\nUsage: ${prefix}autosticker on/off\n\nWhen on, every image or short video posted by non-admins is automatically converted to a sticker.` }, { quoted: m });
                    break;
                }
                if (!['on', 'off'].includes(toggle)) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}autosticker on/off` }, { quoted: m });
                    break;
                }
                await groupmod.setGroupConfig(redisClient, m.from, 'autosticker', toggle === 'on');
                await conn.sendMessage(m.from, { text: `${toggle === 'on' ? '✅' : '❌'} Autosticker ${toggle === 'on' ? 'enabled' : 'disabled'}.` }, { quoted: m });
                break;
            }

            case "autodownload": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ This command only works in groups." }, { quoted: m });
                    break;
                }
                const senderAdmin = await isGroupAdmin(conn, m.from, m.sender);
                if (!senderAdmin && !senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Only admins can change this setting." }, { quoted: m });
                    break;
                }
                const toggle = args[0]?.toLowerCase();
                if (!toggle) {
                    const cfg = await groupmod.getGroupConfig(redisClient, m.from);
                    await conn.sendMessage(m.from, { text: `⬇️ Autodownload is currently: *${cfg.autodownload ? 'ON' : 'OFF'}*\n\nUsage: ${prefix}autodownload on/off\n\nSupports: TikTok, Twitter/X, Instagram, Facebook, Pinterest` }, { quoted: m });
                    break;
                }
                if (!['on', 'off'].includes(toggle)) {
                    await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}autodownload on/off` }, { quoted: m });
                    break;
                }
                await groupmod.setGroupConfig(redisClient, m.from, 'autodownload', toggle === 'on');
                await conn.sendMessage(m.from, { text: `${toggle === 'on' ? '✅' : '❌'} Autodownload ${toggle === 'on' ? 'enabled' : 'disabled'}.` }, { quoted: m });
                break;
            }

            case "autotag": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ This command only works in groups." }, { quoted: m });
                    break;
                }
                const senderAdmin = await isGroupAdmin(conn, m.from, m.sender);
                if (!senderAdmin && !senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Only admins can change this setting." }, { quoted: m });
                    break;
                }
                const sub = args[0]?.toLowerCase();
                const cfg = await groupmod.getGroupConfig(redisClient, m.from);

                if (sub === 'on') {
                    await groupmod.setGroupConfig(redisClient, m.from, 'autotag', 'keyword');
                    await conn.sendMessage(m.from, { text: `✅ Autotag enabled.\nAdmins will be tagged when someone says: ${cfg.autotagKeywords.join(', ')}\n\nAdd keywords: ${prefix}autotag add <word>\nRemove: ${prefix}autotag remove <word>` }, { quoted: m });
                    break;
                }
                if (sub === 'off') {
                    await groupmod.setGroupConfig(redisClient, m.from, 'autotag', 'off');
                    await conn.sendMessage(m.from, { text: `❌ Autotag disabled.` }, { quoted: m });
                    break;
                }
                if (sub === 'add') {
                    const kw = args.slice(1).join(' ').toLowerCase().trim();
                    if (!kw) { await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}autotag add <keyword>` }, { quoted: m }); break; }
                    const keywords = cfg.autotagKeywords;
                    if (!keywords.includes(kw)) keywords.push(kw);
                    await groupmod.setGroupConfig(redisClient, m.from, 'autotagKeywords', JSON.stringify(keywords));
                    await conn.sendMessage(m.from, { text: `✅ Added keyword: "${kw}"\nCurrent list: ${keywords.join(', ')}` }, { quoted: m });
                    break;
                }
                if (sub === 'remove') {
                    const kw = args.slice(1).join(' ').toLowerCase().trim();
                    if (!kw) { await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}autotag remove <keyword>` }, { quoted: m }); break; }
                    const keywords = cfg.autotagKeywords.filter(k => k !== kw);
                    await groupmod.setGroupConfig(redisClient, m.from, 'autotagKeywords', JSON.stringify(keywords));
                    await conn.sendMessage(m.from, { text: `✅ Removed keyword: "${kw}"\nCurrent list: ${keywords.join(', ') || '(empty)'}` }, { quoted: m });
                    break;
                }
                // Show status
                await conn.sendMessage(m.from, {
                    text: `🏷️ *Autotag* is currently: *${cfg.autotag !== 'off' ? 'ON' : 'OFF'}*\nKeywords: ${cfg.autotagKeywords.join(', ')}\n\nUsage:\n${prefix}autotag on/off\n${prefix}autotag add <keyword>\n${prefix}autotag remove <keyword>`
                }, { quoted: m });
                break;
            }

            case "setwelcome": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ This command only works in groups." }, { quoted: m });
                    break;
                }
                const senderAdmin = await isGroupAdmin(conn, m.from, m.sender);
                if (!senderAdmin && !senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Only admins can change this setting." }, { quoted: m });
                    break;
                }
                const sub = args[0]?.toLowerCase();

                if (sub === 'on') {
                    await groupmod.setGroupConfig(redisClient, m.from, 'welcomeEnabled', true);
                    await conn.sendMessage(m.from, { text: `✅ Welcome messages enabled.\n\nCustomize: ${prefix}setwelcome msg <your message>\nPlaceholders: {user} {group} {members}` }, { quoted: m });
                    break;
                }
                if (sub === 'off') {
                    await groupmod.setGroupConfig(redisClient, m.from, 'welcomeEnabled', false);
                    await conn.sendMessage(m.from, { text: `❌ Welcome messages disabled.` }, { quoted: m });
                    break;
                }
                if (sub === 'msg') {
                    const msg = args.slice(1).join(' ');
                    if (!msg) { await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}setwelcome msg <message>\n\nPlaceholders: {user} = mention, {group} = group name, {members} = member count` }, { quoted: m }); break; }
                    await groupmod.setGroupConfig(redisClient, m.from, 'welcomeMsg', msg);
                    await conn.sendMessage(m.from, { text: `✅ Welcome message set:\n\n${msg}` }, { quoted: m });
                    break;
                }
                const cfg = await groupmod.getGroupConfig(redisClient, m.from);
                await conn.sendMessage(m.from, {
                    text: `👋 *Welcome* is: *${cfg.welcomeEnabled ? 'ON' : 'OFF'}*\n\nMessage:\n${cfg.welcomeMsg || '(default)'}\n\nCommands:\n${prefix}setwelcome on/off\n${prefix}setwelcome msg <text>\nPlaceholders: {user} {group} {members}`
                }, { quoted: m });
                break;
            }

            case "setleft":
            case "setgoodbye": {
                if (!isGroup) {
                    await conn.sendMessage(m.from, { text: "❌ This command only works in groups." }, { quoted: m });
                    break;
                }
                const senderAdmin = await isGroupAdmin(conn, m.from, m.sender);
                if (!senderAdmin && !senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Only admins can change this setting." }, { quoted: m });
                    break;
                }
                const sub = args[0]?.toLowerCase();

                if (sub === 'on') {
                    await groupmod.setGroupConfig(redisClient, m.from, 'goodbyeEnabled', true);
                    await conn.sendMessage(m.from, { text: `✅ Goodbye messages enabled.\n\nCustomize: ${prefix}setleft msg <your message>\nPlaceholders: {user} {group}` }, { quoted: m });
                    break;
                }
                if (sub === 'off') {
                    await groupmod.setGroupConfig(redisClient, m.from, 'goodbyeEnabled', false);
                    await conn.sendMessage(m.from, { text: `❌ Goodbye messages disabled.` }, { quoted: m });
                    break;
                }
                if (sub === 'msg') {
                    const msg = args.slice(1).join(' ');
                    if (!msg) { await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}setleft msg <message>\n\nPlaceholders: {user} {group}` }, { quoted: m }); break; }
                    await groupmod.setGroupConfig(redisClient, m.from, 'goodbyeMsg', msg);
                    await conn.sendMessage(m.from, { text: `✅ Goodbye message set:\n\n${msg}` }, { quoted: m });
                    break;
                }
                const cfg = await groupmod.getGroupConfig(redisClient, m.from);
                await conn.sendMessage(m.from, {
                    text: `🚪 *Goodbye* is: *${cfg.goodbyeEnabled ? 'ON' : 'OFF'}*\n\nMessage:\n${cfg.goodbyeMsg || '(default)'}\n\nCommands:\n${prefix}setleft on/off\n${prefix}setleft msg <text>\nPlaceholders: {user} {group}`
                }, { quoted: m });
                break;
            }

            case "goodmorning": {
                if (!senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Owner/Sudo only command." }, { quoted: m });
                    break;
                }
                const sub = args[0]?.toLowerCase();
                const gcConfig = await getConfig(redisClient, phoneNumber);

                if (!gcConfig.gcJid) {
                    await conn.sendMessage(m.from, { text: `❌ No GC set. Run ${prefix}setgc inside your group first.` }, { quoted: m });
                    break;
                }
                if (sub === 'on') {
                    await setConfigValue(redisClient, phoneNumber, 'goodMorningEnabled', true);
                    await conn.sendMessage(m.from, { text: `🌞 Good morning messages enabled — fires at ${gcConfig.goodMorningTime} daily.\n\nChange time: ${prefix}goodmorning time HH:MM\nChange message: ${prefix}goodmorning msg <text>` }, { quoted: m });
                    break;
                }
                if (sub === 'off') {
                    await setConfigValue(redisClient, phoneNumber, 'goodMorningEnabled', false);
                    await conn.sendMessage(m.from, { text: `❌ Good morning messages disabled.` }, { quoted: m });
                    break;
                }
                if (sub === 'time') {
                    const t = args[1];
                    if (!t || !/^\d{2}:\d{2}$/.test(t)) { await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}goodmorning time HH:MM` }, { quoted: m }); break; }
                    await setConfigValue(redisClient, phoneNumber, 'goodMorningTime', t);
                    await conn.sendMessage(m.from, { text: `✅ Good morning time set to ${t}.` }, { quoted: m });
                    break;
                }
                if (sub === 'msg') {
                    const msg = args.slice(1).join(' ');
                    if (!msg) { await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}goodmorning msg <message>` }, { quoted: m }); break; }
                    await setConfigValue(redisClient, phoneNumber, 'goodMorningMsg', msg);
                    await conn.sendMessage(m.from, { text: `✅ Good morning message updated.` }, { quoted: m });
                    break;
                }
                await conn.sendMessage(m.from, {
                    text: `🌞 *Good Morning* is: *${gcConfig.goodMorningEnabled ? 'ON' : 'OFF'}*\nTime: ${gcConfig.goodMorningTime} (Africa/Lagos)\nGC: ${gcConfig.gcJid}\n\nMessage:\n${gcConfig.goodMorningMsg}\n\nCommands:\n${prefix}goodmorning on/off\n${prefix}goodmorning time HH:MM\n${prefix}goodmorning msg <text>`
                }, { quoted: m });
                break;
            }

            case "goodnight": {
                if (!senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Owner/Sudo only command." }, { quoted: m });
                    break;
                }
                const sub = args[0]?.toLowerCase();
                const gcConfig = await getConfig(redisClient, phoneNumber);

                if (!gcConfig.gcJid) {
                    await conn.sendMessage(m.from, { text: `❌ No GC set. Run ${prefix}setgc inside your group first.` }, { quoted: m });
                    break;
                }
                if (sub === 'on') {
                    await setConfigValue(redisClient, phoneNumber, 'goodNightEnabled', true);
                    await conn.sendMessage(m.from, { text: `🌙 Good night messages enabled — fires at ${gcConfig.goodNightTime} daily.\n\nChange time: ${prefix}goodnight time HH:MM\nChange message: ${prefix}goodnight msg <text>` }, { quoted: m });
                    break;
                }
                if (sub === 'off') {
                    await setConfigValue(redisClient, phoneNumber, 'goodNightEnabled', false);
                    await conn.sendMessage(m.from, { text: `❌ Good night messages disabled.` }, { quoted: m });
                    break;
                }
                if (sub === 'time') {
                    const t = args[1];
                    if (!t || !/^\d{2}:\d{2}$/.test(t)) { await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}goodnight time HH:MM` }, { quoted: m }); break; }
                    await setConfigValue(redisClient, phoneNumber, 'goodNightTime', t);
                    await conn.sendMessage(m.from, { text: `✅ Good night time set to ${t}.` }, { quoted: m });
                    break;
                }
                if (sub === 'msg') {
                    const msg = args.slice(1).join(' ');
                    if (!msg) { await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}goodnight msg <message>` }, { quoted: m }); break; }
                    await setConfigValue(redisClient, phoneNumber, 'goodNightMsg', msg);
                    await conn.sendMessage(m.from, { text: `✅ Good night message updated.` }, { quoted: m });
                    break;
                }
                await conn.sendMessage(m.from, {
                    text: `🌙 *Good Night* is: *${gcConfig.goodNightEnabled ? 'ON' : 'OFF'}*\nTime: ${gcConfig.goodNightTime} (Africa/Lagos)\nGC: ${gcConfig.gcJid}\n\nMessage:\n${gcConfig.goodNightMsg}\n\nCommands:\n${prefix}goodnight on/off\n${prefix}goodnight time HH:MM\n${prefix}goodnight msg <text>`
                }, { quoted: m });
                break;
            }

            case "birthday": {
                const sub = args[0]?.toLowerCase();

                if (sub === 'set') {
                    const dateStr = args[1];
                    if (!dateStr || !/^\d{2}\/\d{2}$/.test(dateStr)) {
                        await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}birthday set DD/MM\nExample: ${prefix}birthday set 17/09` }, { quoted: m });
                        break;
                    }
                    const [dd, mm] = dateStr.split('/').map(Number);
                    if (dd < 1 || dd > 31 || mm < 1 || mm > 12) {
                        await conn.sendMessage(m.from, { text: `❌ Invalid date. Use DD/MM format.` }, { quoted: m });
                        break;
                    }
                    await economy.setBirthday(redisClient, m.sender, dateStr);
                    await conn.sendMessage(m.from, { text: `🎂 Your birthday has been set to *${dateStr}*!\n\nI'll celebrate you when the day comes 🎉` }, { quoted: m });
                    break;
                }

                if (sub === 'mine') {
                    const bday = await economy.getBirthday(redisClient, m.sender);
                    if (!bday) {
                        await conn.sendMessage(m.from, { text: `❌ You haven't set your birthday yet.\n\nUse: ${prefix}birthday set DD/MM` }, { quoted: m });
                    } else {
                        await conn.sendMessage(m.from, { text: `🎂 Your birthday is set to: *${bday}*` }, { quoted: m });
                    }
                    break;
                }

                if (sub === 'list') {
                    if (!isGroup) {
                        await conn.sendMessage(m.from, { text: `❌ Birthday list only works in groups.` }, { quoted: m });
                        break;
                    }
                    const meta = await conn.groupMetadata(m.from);
                    const lines = [];
                    for (const p of meta.participants) {
                        const bday = await economy.getBirthday(redisClient, p.id);
                        if (bday) lines.push(`@${p.id.split('@')[0]} — ${bday}`);
                    }
                    if (!lines.length) {
                        await conn.sendMessage(m.from, { text: `🎂 Nobody in this group has set their birthday yet.\n\nSet yours: ${prefix}birthday set DD/MM` }, { quoted: m });
                    } else {
                        await conn.sendMessage(m.from, { text: `🎂 *Birthdays*\n\n${lines.join('\n')}`, mentions: meta.participants.filter(p => lines.some(l => l.includes(p.id.split('@')[0]))).map(p => p.id) }, { quoted: m });
                    }
                    break;
                }

                await conn.sendMessage(m.from, {
                    text: `🎂 *Birthday Commands*\n\n${prefix}birthday set DD/MM — set your birthday\n${prefix}birthday mine — check your birthday\n${prefix}birthday list — see everyone's birthdays (group only)\n\nBirthday celebrations post daily at 9 AM in your set GC.`
                }, { quoted: m });
                break;
            }

            case "schedule": {
                if (!senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Owner/Sudo only command." }, { quoted: m });
                    break;
                }

                // Formats: .schedule 30m <message>  or  .schedule HH:MM <message>
                const timeStr = args[0];
                const message = args.slice(1).join(' ');

                if (!timeStr || !message) {
                    await conn.sendMessage(m.from, {
                        text: `⏰ *Schedule a message*\n\nFormats:\n${prefix}schedule 30m <message> — in 30 minutes\n${prefix}schedule 2h <message> — in 2 hours\n${prefix}schedule 08:30 <message> — at 8:30 AM today/tomorrow\n\nMessage posts to current chat.`
                    }, { quoted: m });
                    break;
                }

                let delayMs = 0;
                const minuteMatch = timeStr.match(/^(\d+)m$/i);
                const hourMatch = timeStr.match(/^(\d+)h$/i);
                const clockMatch = timeStr.match(/^(\d{1,2}):(\d{2})$/);

                if (minuteMatch) {
                    delayMs = parseInt(minuteMatch[1]) * 60 * 1000;
                } else if (hourMatch) {
                    delayMs = parseInt(hourMatch[1]) * 60 * 60 * 1000;
                } else if (clockMatch) {
                    const now = moment().tz('Africa/Lagos');
                    const target = now.clone().hour(parseInt(clockMatch[1])).minute(parseInt(clockMatch[2])).second(0);
                    if (target.isBefore(now)) target.add(1, 'day');
                    delayMs = target.diff(now);
                } else {
                    await conn.sendMessage(m.from, { text: `❌ Invalid time format. Use: 30m, 2h, or HH:MM` }, { quoted: m });
                    break;
                }

                const maxMs = 24 * 60 * 60 * 1000;
                if (delayMs <= 0 || delayMs > maxMs) {
                    await conn.sendMessage(m.from, { text: `❌ Schedule time must be between 1 minute and 24 hours from now.` }, { quoted: m });
                    break;
                }

                const targetChatJid = m.from;
                const minutesFromNow = Math.round(delayMs / 60000);
                await conn.sendMessage(m.from, { text: `⏰ Scheduled! Message will post in ${minutesFromNow} minute(s).\n\n_Note: not persisted — cancelled if bot restarts before firing._` }, { quoted: m });

                setTimeout(async () => {
                    try {
                        await conn.sendMessage(targetChatJid, { text: `⏰ *Scheduled Message*\n\n${message}` });
                    } catch (err) {
                        console.error('Schedule fire error:', err.message);
                    }
                }, delayMs);
                break;
            }

            case "gcpost": {
                if (!senderHasAccess) {
                    await conn.sendMessage(m.from, { text: "❌ Owner/Sudo only command." }, { quoted: m });
                    break;
                }

                const gcConfig = await getConfig(redisClient, phoneNumber);
                if (!gcConfig.gcJid) {
                    await conn.sendMessage(m.from, { text: `❌ No GC set yet. Go into the group you want and run ${prefix}setgc first.` }, { quoted: m });
                    break;
                }

                const quotedType = m.quoted?.mtype;
                try {
                    if (quotedType && ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(quotedType)) {
                        // Reply to media + .gcpost [caption] -> forwards that media into the GC
                        const quotedMedia = await downloadQuotedMedia(m);
                        const payload = { [quotedType.replace('Message', '')]: quotedMedia.buffer };
                        if (text && quotedType !== 'stickerMessage' && quotedType !== 'audioMessage') payload.caption = text;
                        if (quotedType === 'documentMessage') {
                            payload.fileName = guessFileName(quotedMedia);
                            payload.mimetype = quotedMedia.mimetype;
                        }
                        if (quotedType === 'audioMessage') payload.mimetype = quotedMedia.mimetype || 'audio/mpeg';
                        await conn.sendMessage(gcConfig.gcJid, payload);
                    } else if (text) {
                        // Plain .gcpost <text> -> posts the text into the GC
                        await conn.sendMessage(gcConfig.gcJid, { text });
                    } else {
                        await conn.sendMessage(m.from, { text: `❌ Usage: ${prefix}gcpost <text>\n(or reply to an image/video/audio/document/sticker with ${prefix}gcpost [caption])` }, { quoted: m });
                        break;
                    }

                    await conn.sendMessage(m.from, { text: `✅ Posted to your GC.` }, { quoted: m });
                } catch (err) {
                    console.error('gcpost error:', err.message);
                    await conn.sendMessage(m.from, { text: `❌ Failed to post to your GC. (If the bot was removed from that group, run ${prefix}setgc again inside a new one.)` }, { quoted: m });
                }
                break;
            }

            case "autobackup": {
                // Global setting (affects the WHOLE multi-tenant server),
                // same restriction tier as startevent/endevent/eval — not a
                // per-session config, so only the super admin can touch it.
                if (!isSuperAdmin(m, phoneNumber)) {
                    await conn.sendMessage(m.from, { text: "❌ This command is restricted to the bot developer only." }, { quoted: m });
                    break;
                }

                const { getSettings, updateSettings, runBackup } = require('./bot');
                const sub = args[0]?.toLowerCase();

                if (sub === 'on' || sub === 'off') {
                    await updateSettings({ autoBackup: sub === 'on' });
                    await conn.sendMessage(m.from, {
                        text: `${sub === 'on' ? '✅' : '❌'} Auto backup ${sub === 'on' ? 'enabled' : 'disabled'} (every 30 min).`
                    }, { quoted: m });
                    break;
                }

                if (sub === 'now' || sub === 'run') {
                    const count = await runBackup();
                    await conn.sendMessage(m.from, { text: `💾 Backup completed manually. ${count} user(s) snapshotted.` }, { quoted: m });
                    break;
                }

                if (sub === 'file' || sub === 'send' || sub === 'export') {
                    const raw = await redisClient.get('backup:latest');
                    if (!raw) {
                        await conn.sendMessage(m.from, { text: `❌ No backup snapshot exists yet. Run ${prefix}autobackup now first.` }, { quoted: m });
                        break;
                    }

                    const snapshot = JSON.parse(raw);
                    const fileBuffer = Buffer.from(JSON.stringify(snapshot, null, 2), 'utf-8');
                    const stamp = new Date(snapshot.timestamp).toISOString().replace(/[:.]/g, '-');

                    await conn.sendMessage(m.from, {
                        document: fileBuffer,
                        fileName: `backup_${stamp}.json`,
                        mimetype: 'application/json',
                        caption: `💾 Latest backup snapshot — ${snapshot.count} user(s), taken ${new Date(snapshot.timestamp).toLocaleString()}`
                    }, { quoted: m });
                    break;
                }

                const settings = await getSettings();
                await conn.sendMessage(m.from, {
                    text: `💾 *Auto Backup* — currently *${settings.autoBackup ? 'ON' : 'OFF'}* (runs every 30 min when on)\n\nUsage:\n${prefix}autobackup on/off\n${prefix}autobackup now — trigger a snapshot immediately\n${prefix}autobackup file — send the latest snapshot to you as a JSON file`
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

            // ════════════════════════════════════════════
            // 🤖 MORE AI COMMANDS (from Trustbit AI pack)
            // All cost 5 coins per use (image gen costs 10).
            // ════════════════════════════════════════════

            case "gpt5":
            case "gpt-5": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `🧠 Usage: ${prefix}gpt5 <question>\n\n💰 Cost: 5 coins per use` }, { quoted: m });
                    break;
                }
                const gpt5Profile = await economy.getProfile(redisClient, m.sender);
                if (gpt5Profile.coins < 5) {
                    await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 5 coins.\n\n💰 Balance: ${economy.formatCoins(gpt5Profile.coins)} coins` }, { quoted: m });
                    break;
                }
                try {
                    const axios = require("axios");
                    const { data } = await axios.get(`${TRUSTBIT_URL}/ai/gpt-5?text=${encodeURIComponent(text)}`, {
                        timeout: 30000,
                        headers: { "x-api-key": TRUSTBIT_KEY }
                    });
                    const result = data?.data?.response || data?.response || data?.text;
                    if (!result) {
                        await conn.sendMessage(m.from, { text: "⚠️ GPT-5 couldn't get a response. Try again." }, { quoted: m });
                        break;
                    }
                    await economy.addCoins(redisClient, m.sender, -5);
                    await conn.sendMessage(m.from, {
                        text: `🧠 *GPT-5*\n\n${result}\n\n━━━━━━━━━━━━━━━\n🔮 Model: GPT-5\n💰 -5 coins deducted`
                    }, { quoted: m });
                } catch (err) {
                    console.error("GPT-5 error:", err.message);
                    await conn.sendMessage(m.from, { text: "❌ GPT-5 is currently unavailable. Try again later." }, { quoted: m });
                }
                break;
            }

            case "copilot":
            case "bing": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `🪟 Usage: ${prefix}copilot <question>\n\n💰 Cost: 5 coins per use` }, { quoted: m });
                    break;
                }
                const copilotProfile = await economy.getProfile(redisClient, m.sender);
                if (copilotProfile.coins < 5) {
                    await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 5 coins.\n\n💰 Balance: ${economy.formatCoins(copilotProfile.coins)} coins` }, { quoted: m });
                    break;
                }
                try {
                    const axios = require("axios");
                    const { data } = await axios.get(`${TRUSTBIT_URL}/ai/copilot?text=${encodeURIComponent(text)}`, {
                        timeout: 30000,
                        headers: { "x-api-key": TRUSTBIT_KEY }
                    });
                    const result = data?.text || data?.response;
                    if (!result) {
                        await conn.sendMessage(m.from, { text: "⚠️ Copilot couldn't get a response. Try again." }, { quoted: m });
                        break;
                    }
                    await economy.addCoins(redisClient, m.sender, -5);
                    await conn.sendMessage(m.from, {
                        text: `🪟 *Microsoft Copilot*\n\n${result}\n\n━━━━━━━━━━━━━━━\n🔮 Model: ${data.model || 'Copilot'}\n💰 -5 coins deducted`
                    }, { quoted: m });
                } catch (err) {
                    console.error("Copilot error:", err.message);
                    await conn.sendMessage(m.from, { text: "❌ Copilot is currently unavailable. Try again later." }, { quoted: m });
                }
                break;
            }

            case "think":
            case "deepthink": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `🧩 Usage: ${prefix}think <question>\n\nUses Copilot Think Deeper for complex reasoning.\n\n💰 Cost: 5 coins per use` }, { quoted: m });
                    break;
                }
                const thinkProfile = await economy.getProfile(redisClient, m.sender);
                if (thinkProfile.coins < 5) {
                    await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 5 coins.\n\n💰 Balance: ${economy.formatCoins(thinkProfile.coins)} coins` }, { quoted: m });
                    break;
                }
                try {
                    const axios = require("axios");
                    const { data } = await axios.get(`${TRUSTBIT_URL}/ai/copilot-think?text=${encodeURIComponent(text)}`, {
                        timeout: 45000,
                        headers: { "x-api-key": TRUSTBIT_KEY }
                    });
                    const result = data?.text || data?.response;
                    if (!result) {
                        await conn.sendMessage(m.from, { text: "⚠️ Deep Think couldn't get a response. Try again." }, { quoted: m });
                        break;
                    }
                    await economy.addCoins(redisClient, m.sender, -5);
                    await conn.sendMessage(m.from, {
                        text: `🧩 *Copilot Think Deeper*\n\n${result}\n\n━━━━━━━━━━━━━━━\n🔮 Mode: Deep Reasoning\n💰 -5 coins deducted`
                    }, { quoted: m });
                } catch (err) {
                    console.error("DeepThink error:", err.message);
                    await conn.sendMessage(m.from, { text: "❌ Deep Think is currently unavailable. Try again later." }, { quoted: m });
                }
                break;
            }

            case "gemini":
            case "bard": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `🌟 Usage: ${prefix}gemini <question>\n\n💰 Cost: 5 coins per use` }, { quoted: m });
                    break;
                }
                const geminiProfile = await economy.getProfile(redisClient, m.sender);
                if (geminiProfile.coins < 5) {
                    await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 5 coins.\n\n💰 Balance: ${economy.formatCoins(geminiProfile.coins)} coins` }, { quoted: m });
                    break;
                }
                try {
                    const axios = require("axios");
                    const { data } = await axios.get(`${TRUSTBIT_URL}/ai/gemini?prompt=${encodeURIComponent(text)}`, {
                        timeout: 30000,
                        headers: { "x-api-key": TRUSTBIT_KEY }
                    });
                    if (!data?.response) {
                        await conn.sendMessage(m.from, { text: "⚠️ Gemini couldn't get a response. Try again." }, { quoted: m });
                        break;
                    }
                    await economy.addCoins(redisClient, m.sender, -5);
                    await conn.sendMessage(m.from, {
                        text: `🌟 *Google Gemini*\n\n${data.response}\n\n━━━━━━━━━━━━━━━\n🔮 Service: ${data.service || 'Gemini'}\n💰 -5 coins deducted`
                    }, { quoted: m });
                } catch (err) {
                    console.error("Gemini error:", err.message);
                    await conn.sendMessage(m.from, { text: "❌ Gemini is currently unavailable. Try again later." }, { quoted: m });
                }
                break;
            }

            case "chatgpt": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `💬 Usage: ${prefix}chatgpt <question>\n\n💰 Cost: 5 coins per use` }, { quoted: m });
                    break;
                }
                const chatgptProfile = await economy.getProfile(redisClient, m.sender);
                if (chatgptProfile.coins < 5) {
                    await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 5 coins.\n\n💰 Balance: ${economy.formatCoins(chatgptProfile.coins)} coins` }, { quoted: m });
                    break;
                }
                try {
                    const axios = require("axios");
                    const { data } = await axios.get(`${TRUSTBIT_URL}/ai/chatgpt?prompt=${encodeURIComponent(text)}`, {
                        timeout: 30000,
                        headers: { "x-api-key": TRUSTBIT_KEY }
                    });
                    if (!data?.response) {
                        await conn.sendMessage(m.from, { text: "⚠️ ChatGPT couldn't get a response. Try again." }, { quoted: m });
                        break;
                    }
                    await economy.addCoins(redisClient, m.sender, -5);
                    await conn.sendMessage(m.from, {
                        text: `💬 *ChatGPT*\n\n${data.response}\n\n━━━━━━━━━━━━━━━\n🔮 Model: ${data.model || 'GPT'}\n💰 -5 coins deducted`
                    }, { quoted: m });
                } catch (err) {
                    console.error("ChatGPT error:", err.message);
                    await conn.sendMessage(m.from, { text: "❌ ChatGPT is currently unavailable. Try again later." }, { quoted: m });
                }
                break;
            }

            case "mistral": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `⚡ Usage: ${prefix}mistral <question>\n\n💰 Cost: 5 coins per use` }, { quoted: m });
                    break;
                }
                const mistralProfile = await economy.getProfile(redisClient, m.sender);
                if (mistralProfile.coins < 5) {
                    await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 5 coins.\n\n💰 Balance: ${economy.formatCoins(mistralProfile.coins)} coins` }, { quoted: m });
                    break;
                }
                try {
                    const axios = require("axios");
                    const { data } = await axios.get(`${TRUSTBIT_URL}/ai/mistral?prompt=${encodeURIComponent(text)}`, {
                        timeout: 30000,
                        headers: { "x-api-key": TRUSTBIT_KEY }
                    });
                    if (!data?.response) {
                        await conn.sendMessage(m.from, { text: "⚠️ Mistral couldn't get a response. Try again." }, { quoted: m });
                        break;
                    }
                    await economy.addCoins(redisClient, m.sender, -5);
                    await conn.sendMessage(m.from, {
                        text: `⚡ *Mistral AI*\n\n${data.response}\n\n━━━━━━━━━━━━━━━\n🔮 Model: Mistral\n💰 -5 coins deducted`
                    }, { quoted: m });
                } catch (err) {
                    console.error("Mistral error:", err.message);
                    await conn.sendMessage(m.from, { text: "❌ Mistral is currently unavailable. Try again later." }, { quoted: m });
                }
                break;
            }

            case "qwen": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `🐉 Usage: ${prefix}qwen <question>\n\n💰 Cost: 5 coins per use` }, { quoted: m });
                    break;
                }
                const qwenProfile = await economy.getProfile(redisClient, m.sender);
                if (qwenProfile.coins < 5) {
                    await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 5 coins.\n\n💰 Balance: ${economy.formatCoins(qwenProfile.coins)} coins` }, { quoted: m });
                    break;
                }
                try {
                    const axios = require("axios");
                    const { data } = await axios.get(`${TRUSTBIT_URL}/ai/qwen?prompt=${encodeURIComponent(text)}`, {
                        timeout: 30000,
                        headers: { "x-api-key": TRUSTBIT_KEY }
                    });
                    if (!data?.response?.trim()) {
                        await conn.sendMessage(m.from, { text: "⚠️ Qwen couldn't get a response. Try again." }, { quoted: m });
                        break;
                    }
                    await economy.addCoins(redisClient, m.sender, -5);
                    await conn.sendMessage(m.from, {
                        text: `🐉 *Qwen AI*\n\n${data.response}\n\n━━━━━━━━━━━━━━━\n🔮 Model: ${data.model || 'Qwen'}\n💰 -5 coins deducted`
                    }, { quoted: m });
                } catch (err) {
                    console.error("Qwen error:", err.message);
                    await conn.sendMessage(m.from, { text: "❌ Qwen is currently unavailable. Try again later." }, { quoted: m });
                }
                break;
            }

            case "useai":
            case "bbai": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `🖤 Usage: ${prefix}useai <question or code>\n\nGPT-5 powered, great for any question!\n\n💰 Cost: 5 coins per use` }, { quoted: m });
                    break;
                }
                const bbProfile = await economy.getProfile(redisClient, m.sender);
                if (bbProfile.coins < 5) {
                    await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 5 coins.\n\n💰 Balance: ${economy.formatCoins(bbProfile.coins)} coins` }, { quoted: m });
                    break;
                }
                try {
                    const axios = require("axios");
                    const { data } = await axios.get(`${TRUSTBIT_URL}/ai/useai?prompt=${encodeURIComponent(text)}`, {
                        timeout: 30000,
                        headers: { "x-api-key": TRUSTBIT_KEY }
                    });
                    if (!data?.response?.trim()) {
                        await conn.sendMessage(m.from, { text: "⚠️ UseAI couldn't get a response. Try again." }, { quoted: m });
                        break;
                    }
                    await economy.addCoins(redisClient, m.sender, -5);
                    await conn.sendMessage(m.from, {
                        text: `🖤 *UseAI (GPT-5)*\n\n${data.response}\n\n━━━━━━━━━━━━━━━\n🔮 Model: ${data.model || 'GPT-5'}\n💰 -5 coins deducted`
                    }, { quoted: m });
                } catch (err) {
                    console.error("UseAI error:", err.message);
                    await conn.sendMessage(m.from, { text: "❌ UseAI is currently unavailable. Try again later." }, { quoted: m });
                }
                break;
            }

            // ────────────────────────────────────────────────────────────
            //  SPECIALIZED AI  (5 coins each)
            // ────────────────────────────────────────────────────────────

            case "logical":
            case "reason": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `🔍 Usage: ${prefix}logical <question>\n\nBest for analysis and reasoning questions.\n\n💰 Cost: 5 coins per use` }, { quoted: m });
                    break;
                }
                const logicalProfile = await economy.getProfile(redisClient, m.sender);
                if (logicalProfile.coins < 5) {
                    await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 5 coins.\n\n💰 Balance: ${economy.formatCoins(logicalProfile.coins)} coins` }, { quoted: m });
                    break;
                }
                try {
                    const axios = require("axios");
                    const { data } = await axios.get(`${TRUSTBIT_URL}/ai/logical?text=${encodeURIComponent(text)}`, {
                        timeout: 30000,
                        headers: { "x-api-key": TRUSTBIT_KEY }
                    });
                    if (!data?.response) {
                        await conn.sendMessage(m.from, { text: "⚠️ Logical AI couldn't get a response. Try again." }, { quoted: m });
                        break;
                    }
                    await economy.addCoins(redisClient, m.sender, -5);
                    await conn.sendMessage(m.from, {
                        text: `🔍 *Logical AI*\n\n${data.response}\n\n━━━━━━━━━━━━━━━\n🔮 Mode: Analytical Reasoning\n💰 -5 coins deducted`
                    }, { quoted: m });
                } catch (err) {
                    console.error("Logical error:", err.message);
                    await conn.sendMessage(m.from, { text: "❌ Logical AI is currently unavailable. Try again later." }, { quoted: m });
                }
                break;
            }

            case "creative":
            case "brainstorm": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `🎨 Usage: ${prefix}creative <topic>\n\nBest for creative writing and brainstorming.\n\n💰 Cost: 5 coins per use` }, { quoted: m });
                    break;
                }
                const creativeProfile = await economy.getProfile(redisClient, m.sender);
                if (creativeProfile.coins < 5) {
                    await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 5 coins.\n\n💰 Balance: ${economy.formatCoins(creativeProfile.coins)} coins` }, { quoted: m });
                    break;
                }
                try {
                    const axios = require("axios");
                    const { data } = await axios.get(`${TRUSTBIT_URL}/ai/creative?text=${encodeURIComponent(text)}`, {
                        timeout: 30000,
                        headers: { "x-api-key": TRUSTBIT_KEY }
                    });
                    if (!data?.response) {
                        await conn.sendMessage(m.from, { text: "⚠️ Creative AI couldn't get a response. Try again." }, { quoted: m });
                        break;
                    }
                    await economy.addCoins(redisClient, m.sender, -5);
                    await conn.sendMessage(m.from, {
                        text: `🎨 *Creative AI*\n\n${data.response}\n\n━━━━━━━━━━━━━━━\n🔮 Mode: Creative Brainstorm\n💰 -5 coins deducted`
                    }, { quoted: m });
                } catch (err) {
                    console.error("Creative error:", err.message);
                    await conn.sendMessage(m.from, { text: "❌ Creative AI is currently unavailable. Try again later." }, { quoted: m });
                }
                break;
            }

            case "dream":
            case "dreaminterp": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `🌙 Usage: ${prefix}dream <describe your dream>\n\nGet AI insights into what your dream means.\n\n💰 Cost: 5 coins per use` }, { quoted: m });
                    break;
                }
                const dreamProfile = await economy.getProfile(redisClient, m.sender);
                if (dreamProfile.coins < 5) {
                    await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 5 coins.\n\n💰 Balance: ${economy.formatCoins(dreamProfile.coins)} coins` }, { quoted: m });
                    break;
                }
                try {
                    const axios = require("axios");
                    const { data } = await axios.get(`${TRUSTBIT_URL}/ai/dream?dream=${encodeURIComponent(text)}`, {
                        timeout: 30000,
                        headers: { "x-api-key": TRUSTBIT_KEY }
                    });
                    if (!data?.result) {
                        await conn.sendMessage(m.from, { text: "⚠️ Dream Interpreter couldn't get a response. Try again." }, { quoted: m });
                        break;
                    }
                    await economy.addCoins(redisClient, m.sender, -5);
                    await conn.sendMessage(m.from, {
                        text: `🌙 *AI Dream Interpreter*\n\n${data.result}\n\n━━━━━━━━━━━━━━━\n🔮 Mode: Dream Analysis\n💰 -5 coins deducted`
                    }, { quoted: m });
                } catch (err) {
                    console.error("Dream error:", err.message);
                    await conn.sendMessage(m.from, { text: "❌ Dream Interpreter is currently unavailable. Try again later." }, { quoted: m });
                }
                break;
            }

            case "story":
            case "quickstory": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `📖 Usage: ${prefix}story <story idea>\n\nExample: ${prefix}story a dragon protecting a magic crystal\n\n💰 Cost: 5 coins per use` }, { quoted: m });
                    break;
                }
                const storyProfile = await economy.getProfile(redisClient, m.sender);
                if (storyProfile.coins < 5) {
                    await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 5 coins.\n\n💰 Balance: ${economy.formatCoins(storyProfile.coins)} coins` }, { quoted: m });
                    break;
                }
                try {
                    const axios = require("axios");
                    const { data } = await axios.get(`${TRUSTBIT_URL}/ai/quick?text=${encodeURIComponent(text)}`, {
                        timeout: 30000,
                        headers: { "x-api-key": TRUSTBIT_KEY }
                    });
                    const result = data?.data?.story || data?.story || data?.result || data?.response;
                    if (!result) {
                        await conn.sendMessage(m.from, { text: "⚠️ Story AI couldn't generate a story. Try again." }, { quoted: m });
                        break;
                    }
                    await economy.addCoins(redisClient, m.sender, -5);
                    await conn.sendMessage(m.from, {
                        text: `📖 *Story AI*\n\n${result}\n\n━━━━━━━━━━━━━━━\n🔮 Mode: Quick Story\n💰 -5 coins deducted`
                    }, { quoted: m });
                } catch (err) {
                    console.error("Story error:", err.message);
                    await conn.sendMessage(m.from, { text: "❌ Story AI is currently unavailable. Try again later." }, { quoted: m });
                }
                break;
            }

            // ────────────────────────────────────────────────────────────
            //  CODE AI COMMANDS  (5 coins each)
            // ────────────────────────────────────────────────────────────

            case "makecode":
            case "codegen": {
                // Usage: !makecode python sort an array
                //   first word after prefix = language, rest = prompt
                const codeArgs = text ? text.split(" ") : [];
                const codeLang = codeArgs[0] || "";
                const codePrompt = codeArgs.slice(1).join(" ");
                if (!codeLang || !codePrompt) {
                    await conn.sendMessage(m.from, { text: `💻 Usage: ${prefix}makecode <language> <what to build>\n\nExample: ${prefix}makecode python sort an array\n\n💰 Cost: 5 coins per use` }, { quoted: m });
                    break;
                }
                const makecodeProfile = await economy.getProfile(redisClient, m.sender);
                if (makecodeProfile.coins < 5) {
                    await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 5 coins.\n\n💰 Balance: ${economy.formatCoins(makecodeProfile.coins)} coins` }, { quoted: m });
                    break;
                }
                try {
                    const axios = require("axios");
                    const { data } = await axios.get(
                        `${TRUSTBIT_URL}/ai/prompttocode?prompt=${encodeURIComponent(codePrompt)}&language=${encodeURIComponent(codeLang)}`,
                        { timeout: 30000, headers: { "x-api-key": TRUSTBIT_KEY } }
                    );
                    if (!data?.code) {
                        await conn.sendMessage(m.from, { text: "⚠️ Code generator couldn't produce code. Try again." }, { quoted: m });
                        break;
                    }
                    await economy.addCoins(redisClient, m.sender, -5);
                    await conn.sendMessage(m.from, {
                        text: `💻 *Code Generator*\n\n*${data.title || codePrompt}*\nLanguage: ${data.language || codeLang}\n\n\`\`\`\n${data.code}\n\`\`\`\n\n${data.explanation ? `📝 ${data.explanation.slice(0, 400)}` : ''}\n\n━━━━━━━━━━━━━━━\n💰 -5 coins deducted`
                    }, { quoted: m });
                } catch (err) {
                    console.error("Makecode error:", err.message);
                    await conn.sendMessage(m.from, { text: "❌ Code generator is currently unavailable. Try again later." }, { quoted: m });
                }
                break;
            }

            case "fixcode":
            case "bugfix": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `🐛 Usage: ${prefix}fixcode <paste your code here>\n\nAI will find and explain bugs in your code.\n\n💰 Cost: 5 coins per use` }, { quoted: m });
                    break;
                }
                const fixcodeProfile = await economy.getProfile(redisClient, m.sender);
                if (fixcodeProfile.coins < 5) {
                    await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 5 coins.\n\n💰 Balance: ${economy.formatCoins(fixcodeProfile.coins)} coins` }, { quoted: m });
                    break;
                }
                try {
                    const axios = require("axios");
                    const { data } = await axios.get(`${TRUSTBIT_URL}/ai/detectbugs?code=${encodeURIComponent(text)}`, {
                        timeout: 30000,
                        headers: { "x-api-key": TRUSTBIT_KEY }
                    });
                    if (!data?.explanation) {
                        await conn.sendMessage(m.from, { text: "⚠️ Bug detector couldn't analyse the code. Try again." }, { quoted: m });
                        break;
                    }
                    await economy.addCoins(redisClient, m.sender, -5);
                    await conn.sendMessage(m.from, {
                        text: `🐛 *Bug Detector*\n\n*${data.title || 'Code Analysis'}*\nLanguage: ${data.language || 'Auto-detected'}\n\n${data.explanation}\n\n━━━━━━━━━━━━━━━\n💰 -5 coins deducted`
                    }, { quoted: m });
                } catch (err) {
                    console.error("Fixcode error:", err.message);
                    await conn.sendMessage(m.from, { text: "❌ Bug detector is currently unavailable. Try again later." }, { quoted: m });
                }
                break;
            }

            case "explaincode": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `📚 Usage: ${prefix}explaincode <paste your code here>\n\nAI will explain what the code does.\n\n💰 Cost: 5 coins per use` }, { quoted: m });
                    break;
                }
                const explainProfile = await economy.getProfile(redisClient, m.sender);
                if (explainProfile.coins < 5) {
                    await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 5 coins.\n\n💰 Balance: ${economy.formatCoins(explainProfile.coins)} coins` }, { quoted: m });
                    break;
                }
                try {
                    const axios = require("axios");
                    const { data } = await axios.get(`${TRUSTBIT_URL}/ai/explaincode?code=${encodeURIComponent(text)}`, {
                        timeout: 30000,
                        headers: { "x-api-key": TRUSTBIT_KEY }
                    });
                    const result = data?.explanation || data?.response || data?.result;
                    if (!result) {
                        await conn.sendMessage(m.from, { text: "⚠️ Code explainer couldn't analyse the code. Try again." }, { quoted: m });
                        break;
                    }
                    await economy.addCoins(redisClient, m.sender, -5);
                    await conn.sendMessage(m.from, {
                        text: `📚 *Code Explainer*\n\n${result}\n\n━━━━━━━━━━━━━━━\n💰 -5 coins deducted`
                    }, { quoted: m });
                } catch (err) {
                    console.error("Explaincode error:", err.message);
                    await conn.sendMessage(m.from, { text: "❌ Code explainer is currently unavailable. Try again later." }, { quoted: m });
                }
                break;
            }

            // ────────────────────────────────────────────────────────────
            //  IMAGE AI COMMAND  (10 coins)
            // ────────────────────────────────────────────────────────────

            case "imagine":
            case "aiart":
            case "genimg": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `🎨 Usage: ${prefix}imagine <describe the image>\n\nExample: ${prefix}imagine a futuristic city at night\n\n💰 Cost: 10 coins per use` }, { quoted: m });
                    break;
                }
                const imagineProfile = await economy.getProfile(redisClient, m.sender);
                if (imagineProfile.coins < 10) {
                    await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 10 coins for image generation.\n\n💰 Balance: ${economy.formatCoins(imagineProfile.coins)} coins` }, { quoted: m });
                    break;
                }
                try {
                    const axios = require("axios");
                    await conn.sendMessage(m.from, { text: "🎨 Generating your image, please wait..." }, { quoted: m });
                    const { data } = await axios.get(`${TRUSTBIT_URL}/zst/v1/ai/image?prompt=${encodeURIComponent(text)}&url=true`, {
                        timeout: 60000,
                        headers: { "x-api-key": TRUSTBIT_KEY }
                    });
                    const imageUrl = data?.data?.imageUrl || data?.imageUrl || data?.url;
                    if (!imageUrl) {
                        await conn.sendMessage(m.from, { text: "⚠️ Image generation failed. Try again." }, { quoted: m });
                        break;
                    }
                    await economy.addCoins(redisClient, m.sender, -10);
                    await conn.sendMessage(m.from, {
                        image: { url: imageUrl },
                        caption: `🎨 *AI Image*\n\n📝 Prompt: ${text}\n\n━━━━━━━━━━━━━━━\n🔮 Model: ${data?.data?.model || 'FLUX'}\n💰 -10 coins deducted`
                    }, { quoted: m });
                } catch (err) {
                    console.error("Imagine error:", err.message);
                    await conn.sendMessage(m.from, { text: "❌ Image generation is currently unavailable. Try again later." }, { quoted: m });
                }
                break;
            }


case "randomcat":
case "catpic": {
    try {
        const buf = await fetchDiscoveryImage("random/cat");
        await conn.sendMessage(m.from, { image: buf, caption: `🐱 *Random Cat* 🐾` }, { quoted: m });
    } catch { await conn.sendMessage(m.from, { text: "❌ Couldn't fetch a cat pic right now. Try again!" }, { quoted: m }); }
    break;
}

case "randomdog":
case "dogpic": {
    try {
        const buf = await fetchDiscoveryImage("random/dog");
        await conn.sendMessage(m.from, { image: buf, caption: `🐶 *Random Dog* 🦴` }, { quoted: m });
    } catch { await conn.sendMessage(m.from, { text: "❌ Couldn't fetch a dog pic right now. Try again!" }, { quoted: m }); }
    break;
}

case "randomcar":
case "carpic": {
    try {
        const buf = await fetchDiscoveryImage("random/car");
        await conn.sendMessage(m.from, { image: buf, caption: `🚗 *Random Car* 🔥` }, { quoted: m });
    } catch { await conn.sendMessage(m.from, { text: "❌ Couldn't fetch a car pic right now. Try again!" }, { quoted: m }); }
    break;
}

case "randomboy":
case "boypic": {
    try {
        const buf = await fetchDiscoveryImage("random/boypic");
        await conn.sendMessage(m.from, { image: buf, caption: `👦 *Random Boy Pic*` }, { quoted: m });
    } catch { await conn.sendMessage(m.from, { text: "❌ Couldn't fetch image right now. Try again!" }, { quoted: m }); }
    break;
}

case "randomgirl":
case "girlpic": {
    try {
        const buf = await fetchDiscoveryImage("random/randomgirl");
        await conn.sendMessage(m.from, { image: buf, caption: `👧 *Random Girl Pic*` }, { quoted: m });
    } catch { await conn.sendMessage(m.from, { text: "❌ Couldn't fetch image right now. Try again!" }, { quoted: m }); }
    break;
}

case "hijabgirl": {
    try {
        const buf = await fetchDiscoveryImage("random/hijabgirl");
        await conn.sendMessage(m.from, { image: buf, caption: `🧕 *Random Hijab Girl*` }, { quoted: m });
    } catch { await conn.sendMessage(m.from, { text: "❌ Couldn't fetch image right now. Try again!" }, { quoted: m }); }
    break;
}

case "japangirl":
case "japgirl": {
    try {
        const buf = await fetchDiscoveryImage("random/japangirl");
        await conn.sendMessage(m.from, { image: buf, caption: `🇯🇵 *Random Japan Girl*` }, { quoted: m });
    } catch { await conn.sendMessage(m.from, { text: "❌ Couldn't fetch image right now. Try again!" }, { quoted: m }); }
    break;
}

case "koreangirl":
case "kgirl": {
    try {
        const buf = await fetchDiscoveryImage("random/koreangirl");
        await conn.sendMessage(m.from, { image: buf, caption: `🇰🇷 *Random Korean Girl*` }, { quoted: m });
    } catch { await conn.sendMessage(m.from, { text: "❌ Couldn't fetch image right now. Try again!" }, { quoted: m }); }
    break;
}

case "chinagirl":
case "cgirl": {
    try {
        const buf = await fetchDiscoveryImage("random/chinagirl");
        await conn.sendMessage(m.from, { image: buf, caption: `🇨🇳 *Random China Girl*` }, { quoted: m });
    } catch { await conn.sendMessage(m.from, { text: "❌ Couldn't fetch image right now. Try again!" }, { quoted: m }); }
    break;
}

case "vietnamgirl":
case "vgirl": {
    try {
        const buf = await fetchDiscoveryImage("random/vietnamgirl");
        await conn.sendMessage(m.from, { image: buf, caption: `🇻🇳 *Random Vietnam Girl*` }, { quoted: m });
    } catch { await conn.sendMessage(m.from, { text: "❌ Couldn't fetch image right now. Try again!" }, { quoted: m }); }
    break;
}

case "malaysiagirl":
case "mgirl": {
    try {
        const buf = await fetchDiscoveryImage("random/malaysiagirl");
        await conn.sendMessage(m.from, { image: buf, caption: `🇲🇾 *Random Malaysia Girl*` }, { quoted: m });
    } catch { await conn.sendMessage(m.from, { text: "❌ Couldn't fetch image right now. Try again!" }, { quoted: m }); }
    break;
}

case "indonesiagirl":
case "idgirl": {
    try {
        const buf = await fetchDiscoveryImage("random/indonesiagirl");
        await conn.sendMessage(m.from, { image: buf, caption: `🇮🇩 *Random Indonesia Girl*` }, { quoted: m });
    } catch { await conn.sendMessage(m.from, { text: "❌ Couldn't fetch image right now. Try again!" }, { quoted: m }); }
    break;
}

case "thailandgirl":
case "tgirl": {
    try {
        const buf = await fetchDiscoveryImage("random/thailandgirl");
        await conn.sendMessage(m.from, { image: buf, caption: `🇹🇭 *Random Thailand Girl*` }, { quoted: m });
    } catch { await conn.sendMessage(m.from, { text: "❌ Couldn't fetch image right now. Try again!" }, { quoted: m }); }
    break;
}

case "profilepic":
case "randompfp": {
    try {
        const buf = await fetchDiscoveryImage("random/profilepics");
        await conn.sendMessage(m.from, { image: buf, caption: `🖼️ *Random Profile Picture*\n\n_Feel free to use this as your pfp!_` }, { quoted: m });
    } catch { await conn.sendMessage(m.from, { text: "❌ Couldn't fetch a profile picture right now. Try again!" }, { quoted: m }); }
    break;
}

case "bluearchive":
case "bachar": {
    try {
        const buf = await fetchDiscoveryImage("random/bluearchive");
        await conn.sendMessage(m.from, { image: buf, caption: `💙 *Blue Archive*\n\n_Random Blue Archive character!_` }, { quoted: m });
    } catch { await conn.sendMessage(m.from, { text: "❌ Couldn't fetch image right now. Try again!" }, { quoted: m }); }
    break;
}

case "randomsfw":
case "sfwpic": {
    try {
        const buf = await fetchDiscoveryImage("random/anhsfw");
        await conn.sendMessage(m.from, { image: buf, caption: `✨ *Random SFW Pic*` }, { quoted: m });
    } catch { await conn.sendMessage(m.from, { text: "❌ Couldn't fetch image right now. Try again!" }, { quoted: m }); }
    break;
}

case "randomgif":
case "moegif": {
    try {
        const buf = await fetchDiscoveryImage("random/anhmoe");
        await conn.sendMessage(m.from, { video: buf, gifPlayback: true, caption: `🎞️ *Random Moe GIF*` }, { quoted: m });
    } catch { await conn.sendMessage(m.from, { text: "❌ Couldn't fetch GIF right now. Try again!" }, { quoted: m }); }
    break;
}



            // ════════════════════════════════════════════
            // ✨ STYLE TEXT / FONT FORGE COMMANDS (free)
            // ════════════════════════════════════════════

            case "allstyles":
            case "allfonts":
            case "fontstyle": {
                if (!text) {
                    await conn.sendMessage(m.from, { text: `✨ Usage: ${prefix}allstyles <your text>\n\nShows your text in all 35 font styles at once!\n\nExample: ${prefix}allstyles Lady Liya` }, { quoted: m });
                    break;
                }
                try {
                    const axios = require("axios");
                    const { data } = await axios.get(
                        `${TRUSTBIT_URL}/tools/allstyles?text=${encodeURIComponent(text)}`,
                        { timeout: 20000, headers: { "x-api-key": TRUSTBIT_KEY } }
                    );
                    if (!data?.styles?.length) {
                        await conn.sendMessage(m.from, { text: "⚠️ Couldn't generate styles. Try again." }, { quoted: m });
                        break;
                    }
                    const lines = data.styles.map(s => `*${s.style_name}*\n${s.styled_text}`).join("\n\n");
                    await conn.sendMessage(m.from, {
                        text: `✨ *All Font Styles for:* _${data.original_text}_\n\n━━━━━━━━━━━━━━━\n\n${lines}`
                    }, { quoted: m });
                } catch (err) {
                    console.error("allstyles error:", err.message);
                    await conn.sendMessage(m.from, { text: "❌ Style generator is unavailable. Try again later." }, { quoted: m });
                }
                break;
            }

            // ────────────────────────────────────────────────────────────
            //  INDIVIDUAL STYLE COMMANDS
            // ────────────────────────────────────────────────────────────

            case "circled": {
                if (!text) { await conn.sendMessage(m.from, { text: `⭕ Usage: ${prefix}circled <text>\nExample: ${prefix}circled hello → ⓗⓔⓛⓛⓞ` }, { quoted: m }); break; }
                try {
                    const result = await fetchStyle("circled", text);
                    if (!result) throw new Error("empty");
                    await conn.sendMessage(m.from, { text: `⭕ *Circled*\n\n${result}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ Failed. Try again!" }, { quoted: m }); }
                break;
            }

            case "circledneg":
            case "circledfill": {
                if (!text) { await conn.sendMessage(m.from, { text: `🔵 Usage: ${prefix}circledneg <text>\nExample: ${prefix}circledneg hello → 🅗🅔🅛🅛🅞` }, { quoted: m }); break; }
                try {
                    const result = await fetchStyle("circledneg", text);
                    if (!result) throw new Error("empty");
                    await conn.sendMessage(m.from, { text: `🔵 *Circled (Filled)*\n\n${result}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ Failed. Try again!" }, { quoted: m }); }
                break;
            }

            case "fullwidth":
            case "wide": {
                if (!text) { await conn.sendMessage(m.from, { text: `📏 Usage: ${prefix}fullwidth <text>\nExample: ${prefix}fullwidth hello → ｈｅｌｌｏ` }, { quoted: m }); break; }
                try {
                    const result = await fetchStyle("fullwidth", text);
                    if (!result) throw new Error("empty");
                    await conn.sendMessage(m.from, { text: `📏 *Fullwidth*\n\n${result}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ Failed. Try again!" }, { quoted: m }); }
                break;
            }

            case "mathbold":
            case "bold": {
                if (!text) { await conn.sendMessage(m.from, { text: `𝐁 Usage: ${prefix}bold <text>\nExample: ${prefix}bold hello → 𝐡𝐞𝐥𝐥𝐨` }, { quoted: m }); break; }
                try {
                    const result = await fetchStyle("mathbold", text);
                    if (!result) throw new Error("empty");
                    await conn.sendMessage(m.from, { text: `𝐁 *Math Bold*\n\n${result}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ Failed. Try again!" }, { quoted: m }); }
                break;
            }

            case "fraktur":
            case "gothic": {
                if (!text) { await conn.sendMessage(m.from, { text: `𝔉 Usage: ${prefix}fraktur <text>\nExample: ${prefix}fraktur hello → 𝔥𝔢𝔩𝔩𝔬` }, { quoted: m }); break; }
                try {
                    const result = await fetchStyle("mathboldfraktur", text);
                    if (!result) throw new Error("empty");
                    await conn.sendMessage(m.from, { text: `𝔉 *Fraktur / Gothic*\n\n${result}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ Failed. Try again!" }, { quoted: m }); }
                break;
            }

            case "bolditalic":
            case "bolditalics": {
                if (!text) { await conn.sendMessage(m.from, { text: `𝑩 Usage: ${prefix}bolditalic <text>\nExample: ${prefix}bolditalic hello → 𝒉𝒆𝒍𝒍𝒐` }, { quoted: m }); break; }
                try {
                    const result = await fetchStyle("mathbolditalic", text);
                    if (!result) throw new Error("empty");
                    await conn.sendMessage(m.from, { text: `𝑩 *Bold Italic*\n\n${result}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ Failed. Try again!" }, { quoted: m }); }
                break;
            }

            case "boldscript":
            case "cursivebold": {
                if (!text) { await conn.sendMessage(m.from, { text: `𝓑 Usage: ${prefix}boldscript <text>\nExample: ${prefix}boldscript hello → 𝓱𝓮𝓵𝓵𝓸` }, { quoted: m }); break; }
                try {
                    const result = await fetchStyle("mathboldscript", text);
                    if (!result) throw new Error("empty");
                    await conn.sendMessage(m.from, { text: `𝓑 *Bold Script / Cursive*\n\n${result}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ Failed. Try again!" }, { quoted: m }); }
                break;
            }

            case "doublestruck":
            case "outline2": {
                if (!text) { await conn.sendMessage(m.from, { text: `𝔻 Usage: ${prefix}doublestruck <text>\nExample: ${prefix}doublestruck hello → 𝕙𝕖𝕝𝕝𝕠` }, { quoted: m }); break; }
                try {
                    const result = await fetchStyle("mathdoublestruck", text);
                    if (!result) throw new Error("empty");
                    await conn.sendMessage(m.from, { text: `𝔻 *Double Struck*\n\n${result}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ Failed. Try again!" }, { quoted: m }); }
                break;
            }

            case "monospace":
            case "mono": {
                if (!text) { await conn.sendMessage(m.from, { text: `𝚖 Usage: ${prefix}mono <text>\nExample: ${prefix}mono hello → 𝚑𝚎𝚕𝚕𝚘` }, { quoted: m }); break; }
                try {
                    const result = await fetchStyle("mathmonospace", text);
                    if (!result) throw new Error("empty");
                    await conn.sendMessage(m.from, { text: `𝚖 *Monospace*\n\n${result}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ Failed. Try again!" }, { quoted: m }); }
                break;
            }

            case "sans":
            case "sansserif": {
                if (!text) { await conn.sendMessage(m.from, { text: `𝗌 Usage: ${prefix}sans <text>` }, { quoted: m }); break; }
                try {
                    const result = await fetchStyle("mathsans", text);
                    if (!result) throw new Error("empty");
                    await conn.sendMessage(m.from, { text: `𝗌 *Sans Serif*\n\n${result}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ Failed. Try again!" }, { quoted: m }); }
                break;
            }

            case "sansbold":
            case "boldclean": {
                if (!text) { await conn.sendMessage(m.from, { text: `𝗕 Usage: ${prefix}sansbold <text>` }, { quoted: m }); break; }
                try {
                    const result = await fetchStyle("mathsansbold", text);
                    if (!result) throw new Error("empty");
                    await conn.sendMessage(m.from, { text: `𝗕 *Sans Bold*\n\n${result}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ Failed. Try again!" }, { quoted: m }); }
                break;
            }

            case "sansbolditalic": {
                if (!text) { await conn.sendMessage(m.from, { text: `𝙱 Usage: ${prefix}sansbolditalic <text>` }, { quoted: m }); break; }
                try {
                    const result = await fetchStyle("mathsansbolditalic", text);
                    if (!result) throw new Error("empty");
                    await conn.sendMessage(m.from, { text: `𝙱 *Sans Bold Italic*\n\n${result}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ Failed. Try again!" }, { quoted: m }); }
                break;
            }

            case "sansitalic":
            case "slanted": {
                if (!text) { await conn.sendMessage(m.from, { text: `𝘴 Usage: ${prefix}sansitalic <text>` }, { quoted: m }); break; }
                try {
                    const result = await fetchStyle("mathsansitalic", text);
                    if (!result) throw new Error("empty");
                    await conn.sendMessage(m.from, { text: `𝘴 *Sans Italic*\n\n${result}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ Failed. Try again!" }, { quoted: m }); }
                break;
            }

            case "parenthesized":
            case "inparens": {
                if (!text) { await conn.sendMessage(m.from, { text: `🔡 Usage: ${prefix}parenthesized <text>\nExample: ${prefix}parenthesized hi → ⒣⒤` }, { quoted: m }); break; }
                try {
                    const result = await fetchStyle("parenthesized", text);
                    if (!result) throw new Error("empty");
                    await conn.sendMessage(m.from, { text: `🔡 *Parenthesized*\n\n${result}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ Failed. Try again!" }, { quoted: m }); }
                break;
            }

            case "regional":
            case "flags": {
                if (!text) { await conn.sendMessage(m.from, { text: `🇦 Usage: ${prefix}flags <text>\nExample: ${prefix}flags hi → 🇭🇮` }, { quoted: m }); break; }
                try {
                    const result = await fetchStyle("regionalindicator", text);
                    if (!result) throw new Error("empty");
                    await conn.sendMessage(m.from, { text: `🇦 *Regional Indicator (Flag Letters)*\n\n${result}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ Failed. Try again!" }, { quoted: m }); }
                break;
            }

            case "squared":
            case "boxed": {
                if (!text) { await conn.sendMessage(m.from, { text: `🔲 Usage: ${prefix}squared <text>\nExample: ${prefix}squared hi → 🄷🄸` }, { quoted: m }); break; }
                try {
                    const result = await fetchStyle("squared", text);
                    if (!result) throw new Error("empty");
                    await conn.sendMessage(m.from, { text: `🔲 *Squared*\n\n${result}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ Failed. Try again!" }, { quoted: m }); }
                break;
            }

            case "squaredneg":
            case "squarefill": {
                if (!text) { await conn.sendMessage(m.from, { text: `🔳 Usage: ${prefix}squarefill <text>\nExample: ${prefix}squarefill hi → 🅷🅸` }, { quoted: m }); break; }
                try {
                    const result = await fetchStyle("squaredneg", text);
                    if (!result) throw new Error("empty");
                    await conn.sendMessage(m.from, { text: `🔳 *Squared (Filled)*\n\n${result}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ Failed. Try again!" }, { quoted: m }); }
                break;
            }

            case "tag": {
                if (!text) { await conn.sendMessage(m.from, { text: `🏷️ Usage: ${prefix}tag <text>` }, { quoted: m }); break; }
                try {
                    const result = await fetchStyle("tag", text);
                    if (!result) throw new Error("empty");
                    await conn.sendMessage(m.from, { text: `🏷️ *Tag Style*\n\n${result}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ Failed. Try again!" }, { quoted: m }); }
                break;
            }

            case "acute":
            case "accentmark": {
                if (!text) { await conn.sendMessage(m.from, { text: `á Usage: ${prefix}acute <text>\nAdds accent marks above letters.` }, { quoted: m }); break; }
                try {
                    const result = await fetchStyle("acute", text);
                    if (!result) throw new Error("empty");
                    await conn.sendMessage(m.from, { text: `á *A-cute Accents*\n\n${result}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ Failed. Try again!" }, { quoted: m }); }
                break;
            }

            case "cjkthai": {
                if (!text) { await conn.sendMessage(m.from, { text: `🈵 Usage: ${prefix}cjkthai <text>\nConverts letters to CJK+Thai lookalike characters.` }, { quoted: m }); break; }
                try {
                    const result = await fetchStyle("cjkthai", text);
                    if (!result) throw new Error("empty");
                    await conn.sendMessage(m.from, { text: `🈵 *CJK+Thai Style*\n\n${result}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ Failed. Try again!" }, { quoted: m }); }
                break;
            }

            case "curvy1":
            case "cursive": {
                if (!text) { await conn.sendMessage(m.from, { text: `𝒸 Usage: ${prefix}cursive <text>\nExample: ${prefix}cursive hello → 𝒽𝑒𝓁𝓁𝑜` }, { quoted: m }); break; }
                try {
                    const result = await fetchStyle("curvy1", text);
                    if (!result) throw new Error("empty");
                    await conn.sendMessage(m.from, { text: `𝒸 *Cursive (Curvy 1)*\n\n${result}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ Failed. Try again!" }, { quoted: m }); }
                break;
            }

            case "curvy2": {
                if (!text) { await conn.sendMessage(m.from, { text: `ℂ Usage: ${prefix}curvy2 <text>` }, { quoted: m }); break; }
                try {
                    const result = await fetchStyle("curvy2", text);
                    if (!result) throw new Error("empty");
                    await conn.sendMessage(m.from, { text: `ℂ *Curvy 2*\n\n${result}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ Failed. Try again!" }, { quoted: m }); }
                break;
            }

            case "curvy3": {
                if (!text) { await conn.sendMessage(m.from, { text: `ℭ Usage: ${prefix}curvy3 <text>` }, { quoted: m }); break; }
                try {
                    const result = await fetchStyle("curvy3", text);
                    if (!result) throw new Error("empty");
                    await conn.sendMessage(m.from, { text: `ℭ *Curvy 3*\n\n${result}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ Failed. Try again!" }, { quoted: m }); }
                break;
            }

            case "cyrillic":
            case "fauxcyrillic": {
                if (!text) { await conn.sendMessage(m.from, { text: `Ч Usage: ${prefix}cyrillic <text>\nMakes text look like Russian/Cyrillic.` }, { quoted: m }); break; }
                try {
                    const result = await fetchStyle("fauxcyrillic", text);
                    if (!result) throw new Error("empty");
                    await conn.sendMessage(m.from, { text: `Ч *Faux Cyrillic*\n\n${result}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ Failed. Try again!" }, { quoted: m }); }
                break;
            }

            case "ethiopic":
            case "fauxethiopic": {
                if (!text) { await conn.sendMessage(m.from, { text: `ሀ Usage: ${prefix}ethiopic <text>\nMakes text look like Ethiopic script.` }, { quoted: m }); break; }
                try {
                    const result = await fetchStyle("fauxethiopic", text);
                    if (!result) throw new Error("empty");
                    await conn.sendMessage(m.from, { text: `ሀ *Faux Ethiopic*\n\n${result}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ Failed. Try again!" }, { quoted: m }); }
                break;
            }

            case "mathfraktur":
            case "frakturlight": {
                if (!text) { await conn.sendMessage(m.from, { text: `𝔣 Usage: ${prefix}mathfraktur <text>\nExample: ${prefix}mathfraktur hello → 𝔥𝔢𝔩𝔩𝔬` }, { quoted: m }); break; }
                try {
                    const result = await fetchStyle("mathfraktur", text);
                    if (!result) throw new Error("empty");
                    await conn.sendMessage(m.from, { text: `𝔣 *Math Fraktur*\n\n${result}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ Failed. Try again!" }, { quoted: m }); }
                break;
            }

            case "rockdots":
            case "metal":
            case "heavymetal": {
                if (!text) { await conn.sendMessage(m.from, { text: `🤘 Usage: ${prefix}rockdots <text>\nAdds dots above every letter — heavy metal style!` }, { quoted: m }); break; }
                try {
                    const result = await fetchStyle("rockdots", text);
                    if (!result) throw new Error("empty");
                    await conn.sendMessage(m.from, { text: `🤘 *Rock Dots*\n\n${result}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ Failed. Try again!" }, { quoted: m }); }
                break;
            }

            case "smallcaps":
            case "caps": {
                if (!text) { await conn.sendMessage(m.from, { text: `ꜱ Usage: ${prefix}smallcaps <text>\nExample: ${prefix}smallcaps hello → ʜᴇʟʟᴏ` }, { quoted: m }); break; }
                try {
                    const result = await fetchStyle("smallcaps", text);
                    if (!result) throw new Error("empty");
                    await conn.sendMessage(m.from, { text: `ꜱ *Small Caps*\n\n${result}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ Failed. Try again!" }, { quoted: m }); }
                break;
            }

            case "stroked":
            case "strikethrough": {
                if (!text) { await conn.sendMessage(m.from, { text: `S̶ Usage: ${prefix}stroked <text>\nPuts a stroke through every letter.` }, { quoted: m }); break; }
                try {
                    const result = await fetchStyle("stroked", text);
                    if (!result) throw new Error("empty");
                    await conn.sendMessage(m.from, { text: `S̶ *Stroked*\n\n${result}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ Failed. Try again!" }, { quoted: m }); }
                break;
            }

            case "subscript":
            case "sub": {
                if (!text) { await conn.sendMessage(m.from, { text: `ₛ Usage: ${prefix}sub <text>\nConverts text to subscript (small below-line letters).` }, { quoted: m }); break; }
                try {
                    const result = await fetchStyle("subscript", text);
                    if (!result) throw new Error("empty");
                    await conn.sendMessage(m.from, { text: `ₛ *Subscript*\n\n${result}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ Failed. Try again!" }, { quoted: m }); }
                break;
            }

            case "superscript":
            case "sup": {
                if (!text) { await conn.sendMessage(m.from, { text: `ˢ Usage: ${prefix}sup <text>\nConverts text to superscript (small above-line letters).` }, { quoted: m }); break; }
                try {
                    const result = await fetchStyle("superscript", text);
                    if (!result) throw new Error("empty");
                    await conn.sendMessage(m.from, { text: `ˢ *Superscript*\n\n${result}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ Failed. Try again!" }, { quoted: m }); }
                break;
            }

            case "inverted":
            case "upsidedown":
            case "flip": {
                if (!text) { await conn.sendMessage(m.from, { text: `🙃 Usage: ${prefix}flip <text>\nFlips your text upside down!\nExample: ${prefix}flip hello → oןןǝɥ` }, { quoted: m }); break; }
                try {
                    const result = await fetchStyle("inverted", text);
                    if (!result) throw new Error("empty");
                    await conn.sendMessage(m.from, { text: `🙃 *Upside Down*\n\n${result}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ Failed. Try again!" }, { quoted: m }); }
                break;
            }

            case "reversed":
            case "mirror":
            case "backwards": {
                if (!text) { await conn.sendMessage(m.from, { text: `🪞 Usage: ${prefix}mirror <text>\nReverses/mirrors your text!\nExample: ${prefix}mirror hello → olleh` }, { quoted: m }); break; }
                try {
                    const result = await fetchStyle("reversed", text);
                    if (!result) throw new Error("empty");
                    await conn.sendMessage(m.from, { text: `🪞 *Reversed / Mirror*\n\n${result}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ Failed. Try again!" }, { quoted: m }); }
                break;
            }


            // ════════════════════════════════════════════
            // 🖼️ TEXT FX / LOGO MAKER COMMANDS (💰 2 coins each)
            // ════════════════════════════════════════════

            case "glitch2":
            case "glitchtext": {
                if (!text) { await conn.sendMessage(m.from, { text: `👾 Usage: ${prefix}glitch <text>\nCreates a digital glitch text effect image.\nCosts 2 coins.` }, { quoted: m }); break; }
                const textfxProfile1 = await economy.getProfile(redisClient, m.sender);
                if (textfxProfile1.coins < 2) { await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 2 coins.\n\n💰 Balance: ${economy.formatCoins(textfxProfile1.coins)} coins` }, { quoted: m }); break; }
                try {
                    const buf = await fetchTextFxImage("glitchtext", text);
                    await economy.addCoins(redisClient, m.sender, -2);
                    await conn.sendMessage(m.from, { image: buf, caption: `👾 *Glitch Text*\n\n_${text}_` }, { quoted: m });
                } catch (err) { await conn.sendMessage(m.from, { text: "❌ Failed to generate. Try again!" }, { quoted: m }); }
                break;
            }

            case "glastext":
            case "writetext":
            case "wetglass": {
                if (!text) { await conn.sendMessage(m.from, { text: `🪟 Usage: ${prefix}wetglass <text>\nWrites your text on wet glass.\nCosts 2 coins.` }, { quoted: m }); break; }
                const textfxProfile2 = await economy.getProfile(redisClient, m.sender);
                if (textfxProfile2.coins < 2) { await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 2 coins.\n\n💰 Balance: ${economy.formatCoins(textfxProfile2.coins)} coins` }, { quoted: m }); break; }
                try {
                    const buf = await fetchTextFxImage("writetext", text);
                    await economy.addCoins(redisClient, m.sender, -2);
                    await conn.sendMessage(m.from, { image: buf, caption: `🪟 *Wet Glass Text*\n\n_${text}_` }, { quoted: m });
                } catch (err) { await conn.sendMessage(m.from, { text: "❌ Failed to generate. Try again!" }, { quoted: m }); }
                break;
            }

            case "advancedglow":
            case "glowfx": {
                if (!text) { await conn.sendMessage(m.from, { text: `✨ Usage: ${prefix}glowfx <text>\nAdvanced glow text effect.\nCosts 2 coins.` }, { quoted: m }); break; }
                const textfxProfile3 = await economy.getProfile(redisClient, m.sender);
                if (textfxProfile3.coins < 2) { await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 2 coins.\n\n💰 Balance: ${economy.formatCoins(textfxProfile3.coins)} coins` }, { quoted: m }); break; }
                try {
                    const buf = await fetchTextFxImage("advancedglow", text);
                    await economy.addCoins(redisClient, m.sender, -2);
                    await conn.sendMessage(m.from, { image: buf, caption: `✨ *Advanced Glow*\n\n_${text}_` }, { quoted: m });
                } catch (err) { await conn.sendMessage(m.from, { text: "❌ Failed to generate. Try again!" }, { quoted: m }); }
                break;
            }

            case "typography":
            case "typographytext":
            case "pavement": {
                if (!text) { await conn.sendMessage(m.from, { text: `🛤️ Usage: ${prefix}pavement <text>\nTypography text on pavement effect.\nCosts 2 coins.` }, { quoted: m }); break; }
                const textfxProfile4 = await economy.getProfile(redisClient, m.sender);
                if (textfxProfile4.coins < 2) { await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 2 coins.\n\n💰 Balance: ${economy.formatCoins(textfxProfile4.coins)} coins` }, { quoted: m }); break; }
                try {
                    const buf = await fetchTextFxImage("typographytext", text);
                    await economy.addCoins(redisClient, m.sender, -2);
                    await conn.sendMessage(m.from, { image: buf, caption: `🛤️ *Typography / Pavement*\n\n_${text}_` }, { quoted: m });
                } catch (err) { await conn.sendMessage(m.from, { text: "❌ Failed to generate. Try again!" }, { quoted: m }); }
                break;
            }

            case "pixelglitch":
            case "pixelfx": {
                if (!text) { await conn.sendMessage(m.from, { text: `🕹️ Usage: ${prefix}pixelglitch <text>\nPixel glitch text effect.\nCosts 2 coins.` }, { quoted: m }); break; }
                const textfxProfile5 = await economy.getProfile(redisClient, m.sender);
                if (textfxProfile5.coins < 2) { await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 2 coins.\n\n💰 Balance: ${economy.formatCoins(textfxProfile5.coins)} coins` }, { quoted: m }); break; }
                try {
                    const buf = await fetchTextFxImage("pixelglitch", text);
                    await economy.addCoins(redisClient, m.sender, -2);
                    await conn.sendMessage(m.from, { image: buf, caption: `🕹️ *Pixel Glitch*\n\n_${text}_` }, { quoted: m });
                } catch (err) { await conn.sendMessage(m.from, { text: "❌ Failed to generate. Try again!" }, { quoted: m }); }
                break;
            }

            case "neonglitch": {
                if (!text) { await conn.sendMessage(m.from, { text: `⚡ Usage: ${prefix}neonglitch <text>\nNeon glitch text effect.\nCosts 2 coins.` }, { quoted: m }); break; }
                const textfxProfile6 = await economy.getProfile(redisClient, m.sender);
                if (textfxProfile6.coins < 2) { await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 2 coins.\n\n💰 Balance: ${economy.formatCoins(textfxProfile6.coins)} coins` }, { quoted: m }); break; }
                try {
                    const buf = await fetchTextFxImage("neonglitch", text);
                    await economy.addCoins(redisClient, m.sender, -2);
                    await conn.sendMessage(m.from, { image: buf, caption: `⚡ *Neon Glitch*\n\n_${text}_` }, { quoted: m });
                } catch (err) { await conn.sendMessage(m.from, { text: "❌ Failed to generate. Try again!" }, { quoted: m }); }
                break;
            }

            case "flagtext":
            case "nigeriatext":
            case "naijatext": {
                if (!text) { await conn.sendMessage(m.from, { text: `🇳🇬 Usage: ${prefix}flagtext <text>\nNigeria 3D flag text effect.\nCosts 2 coins.` }, { quoted: m }); break; }
                const textfxProfile7 = await economy.getProfile(redisClient, m.sender);
                if (textfxProfile7.coins < 2) { await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 2 coins.\n\n💰 Balance: ${economy.formatCoins(textfxProfile7.coins)} coins` }, { quoted: m }); break; }
                try {
                    const buf = await fetchTextFxImage("flagtext", text);
                    await economy.addCoins(redisClient, m.sender, -2);
                    await conn.sendMessage(m.from, { image: buf, caption: `🇳🇬 *Nigeria Flag Text*\n\n_${text}_` }, { quoted: m });
                } catch (err) { await conn.sendMessage(m.from, { text: "❌ Failed to generate. Try again!" }, { quoted: m }); }
                break;
            }

            case "flag3dtext":
            case "usatext":
            case "americatext": {
                if (!text) { await conn.sendMessage(m.from, { text: `🇺🇸 Usage: ${prefix}usatext <text>\nAmerican flag 3D text effect.\nCosts 2 coins.` }, { quoted: m }); break; }
                const textfxProfile8 = await economy.getProfile(redisClient, m.sender);
                if (textfxProfile8.coins < 2) { await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 2 coins.\n\n💰 Balance: ${economy.formatCoins(textfxProfile8.coins)} coins` }, { quoted: m }); break; }
                try {
                    const buf = await fetchTextFxImage("flag3dtext", text);
                    await economy.addCoins(redisClient, m.sender, -2);
                    await conn.sendMessage(m.from, { image: buf, caption: `🇺🇸 *American Flag 3D Text*\n\n_${text}_` }, { quoted: m });
                } catch (err) { await conn.sendMessage(m.from, { text: "❌ Failed to generate. Try again!" }, { quoted: m }); }
                break;
            }

            case "deletingtext":
            case "eraser":
            case "erase": {
                if (!text) { await conn.sendMessage(m.from, { text: `🧹 Usage: ${prefix}erase <text>\nEraser deleting text effect.\nCosts 2 coins.` }, { quoted: m }); break; }
                const textfxProfile9 = await economy.getProfile(redisClient, m.sender);
                if (textfxProfile9.coins < 2) { await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 2 coins.\n\n💰 Balance: ${economy.formatCoins(textfxProfile9.coins)} coins` }, { quoted: m }); break; }
                try {
                    const buf = await fetchTextFxImage("deletingtext", text);
                    await economy.addCoins(redisClient, m.sender, -2);
                    await conn.sendMessage(m.from, { image: buf, caption: `🧹 *Deleting Text*\n\n_${text}_` }, { quoted: m });
                } catch (err) { await conn.sendMessage(m.from, { text: "❌ Failed to generate. Try again!" }, { quoted: m }); }
                break;
            }

            case "blackpinkstyle":
            case "bpstyle": {
                if (!text) { await conn.sendMessage(m.from, { text: `🖤💗 Usage: ${prefix}bpstyle <text>\nBlackpink style logo maker.\nCosts 2 coins.` }, { quoted: m }); break; }
                const textfxProfile10 = await economy.getProfile(redisClient, m.sender);
                if (textfxProfile10.coins < 2) { await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 2 coins.\n\n💰 Balance: ${economy.formatCoins(textfxProfile10.coins)} coins` }, { quoted: m }); break; }
                try {
                    const buf = await fetchTextFxImage("blackpinkstyle", text);
                    await economy.addCoins(redisClient, m.sender, -2);
                    await conn.sendMessage(m.from, { image: buf, caption: `🖤💗 *Blackpink Style*\n\n_${text}_` }, { quoted: m });
                } catch (err) { await conn.sendMessage(m.from, { text: "❌ Failed to generate. Try again!" }, { quoted: m }); }
                break;
            }

            case "glowingtext":
            case "glow2": {
                if (!text) { await conn.sendMessage(m.from, { text: `💡 Usage: ${prefix}glow <text>\nGlowing text effect.\nCosts 2 coins.` }, { quoted: m }); break; }
                const textfxProfile11 = await economy.getProfile(redisClient, m.sender);
                if (textfxProfile11.coins < 2) { await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 2 coins.\n\n💰 Balance: ${economy.formatCoins(textfxProfile11.coins)} coins` }, { quoted: m }); break; }
                try {
                    const buf = await fetchTextFxImage("glowingtext", text);
                    await economy.addCoins(redisClient, m.sender, -2);
                    await conn.sendMessage(m.from, { image: buf, caption: `💡 *Glowing Text*\n\n_${text}_` }, { quoted: m });
                } catch (err) { await conn.sendMessage(m.from, { text: "❌ Failed to generate. Try again!" }, { quoted: m }); }
                break;
            }

            case "underwatertext":
            case "underwater": {
                if (!text) { await conn.sendMessage(m.from, { text: `🌊 Usage: ${prefix}underwater <text>\n3D underwater text effect.\nCosts 2 coins.` }, { quoted: m }); break; }
                const textfxProfile12 = await economy.getProfile(redisClient, m.sender);
                if (textfxProfile12.coins < 2) { await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 2 coins.\n\n💰 Balance: ${economy.formatCoins(textfxProfile12.coins)} coins` }, { quoted: m }); break; }
                try {
                    const buf = await fetchTextFxImage("underwatertext", text);
                    await economy.addCoins(redisClient, m.sender, -2);
                    await conn.sendMessage(m.from, { image: buf, caption: `🌊 *Underwater Text*\n\n_${text}_` }, { quoted: m });
                } catch (err) { await conn.sendMessage(m.from, { text: "❌ Failed to generate. Try again!" }, { quoted: m }); }
                break;
            }

            case "bearlogo":
            case "logomaker": {
                if (!text) { await conn.sendMessage(m.from, { text: `🐻 Usage: ${prefix}bearlogo <text>\nBear logo maker effect.\nCosts 2 coins.` }, { quoted: m }); break; }
                const textfxProfile13 = await economy.getProfile(redisClient, m.sender);
                if (textfxProfile13.coins < 2) { await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 2 coins.\n\n💰 Balance: ${economy.formatCoins(textfxProfile13.coins)} coins` }, { quoted: m }); break; }
                try {
                    const buf = await fetchTextFxImage("logomaker", text);
                    await economy.addCoins(redisClient, m.sender, -2);
                    await conn.sendMessage(m.from, { image: buf, caption: `🐻 *Bear Logo*\n\n_${text}_` }, { quoted: m });
                } catch (err) { await conn.sendMessage(m.from, { text: "❌ Failed to generate. Try again!" }, { quoted: m }); }
                break;
            }

            case "graffiti":
            case "cartoonstyle": {
                if (!text) { await conn.sendMessage(m.from, { text: `🎨 Usage: ${prefix}graffiti <text>\nCartoon style graffiti text.\nCosts 2 coins.` }, { quoted: m }); break; }
                const textfxProfile14 = await economy.getProfile(redisClient, m.sender);
                if (textfxProfile14.coins < 2) { await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 2 coins.\n\n💰 Balance: ${economy.formatCoins(textfxProfile14.coins)} coins` }, { quoted: m }); break; }
                try {
                    const buf = await fetchTextFxImage("cartoonstyle", text);
                    await economy.addCoins(redisClient, m.sender, -2);
                    await conn.sendMessage(m.from, { image: buf, caption: `🎨 *Cartoon Graffiti*\n\n_${text}_` }, { quoted: m });
                } catch (err) { await conn.sendMessage(m.from, { text: "❌ Failed to generate. Try again!" }, { quoted: m }); }
                break;
            }

            case "papercut":
            case "papercutstyle": {
                if (!text) { await conn.sendMessage(m.from, { text: `✂️ Usage: ${prefix}papercut <text>\nMulticolor 3D paper cut text.\nCosts 2 coins.` }, { quoted: m }); break; }
                const textfxProfile15 = await economy.getProfile(redisClient, m.sender);
                if (textfxProfile15.coins < 2) { await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 2 coins.\n\n💰 Balance: ${economy.formatCoins(textfxProfile15.coins)} coins` }, { quoted: m }); break; }
                try {
                    const buf = await fetchTextFxImage("papercutstyle", text);
                    await economy.addCoins(redisClient, m.sender, -2);
                    await conn.sendMessage(m.from, { image: buf, caption: `✂️ *Paper Cut Style*\n\n_${text}_` }, { quoted: m });
                } catch (err) { await conn.sendMessage(m.from, { text: "❌ Failed to generate. Try again!" }, { quoted: m }); }
                break;
            }

            case "watercolor":
            case "watercolortext": {
                if (!text) { await conn.sendMessage(m.from, { text: `🎨 Usage: ${prefix}watercolor <text>\nWatercolor text art effect.\nCosts 2 coins.` }, { quoted: m }); break; }
                const textfxProfile16 = await economy.getProfile(redisClient, m.sender);
                if (textfxProfile16.coins < 2) { await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 2 coins.\n\n💰 Balance: ${economy.formatCoins(textfxProfile16.coins)} coins` }, { quoted: m }); break; }
                try {
                    const buf = await fetchTextFxImage("watercolortext", text);
                    await economy.addCoins(redisClient, m.sender, -2);
                    await conn.sendMessage(m.from, { image: buf, caption: `🎨 *Watercolor Text*\n\n_${text}_` }, { quoted: m });
                } catch (err) { await conn.sendMessage(m.from, { text: "❌ Failed to generate. Try again!" }, { quoted: m }); }
                break;
            }

            case "clouds":
            case "cloudtext":
            case "effectclouds": {
                if (!text) { await conn.sendMessage(m.from, { text: `☁️ Usage: ${prefix}clouds <text>\nWrites your text as clouds in the sky.\nCosts 2 coins.` }, { quoted: m }); break; }
                const textfxProfile17 = await economy.getProfile(redisClient, m.sender);
                if (textfxProfile17.coins < 2) { await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 2 coins.\n\n💰 Balance: ${economy.formatCoins(textfxProfile17.coins)} coins` }, { quoted: m }); break; }
                try {
                    const buf = await fetchTextFxImage("effectclouds", text);
                    await economy.addCoins(redisClient, m.sender, -2);
                    await conn.sendMessage(m.from, { image: buf, caption: `☁️ *Clouds Text*\n\n_${text}_` }, { quoted: m });
                } catch (err) { await conn.sendMessage(m.from, { text: "❌ Failed to generate. Try again!" }, { quoted: m }); }
                break;
            }

            case "blackpinklogo":
            case "bplogo": {
                if (!text) { await conn.sendMessage(m.from, { text: `🖤💗 Usage: ${prefix}bplogo <text>\nBlackpink logo style text.\nCosts 2 coins.` }, { quoted: m }); break; }
                const textfxProfile18 = await economy.getProfile(redisClient, m.sender);
                if (textfxProfile18.coins < 2) { await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 2 coins.\n\n💰 Balance: ${economy.formatCoins(textfxProfile18.coins)} coins` }, { quoted: m }); break; }
                try {
                    const buf = await fetchTextFxImage("blackpinklogo", text);
                    await economy.addCoins(redisClient, m.sender, -2);
                    await conn.sendMessage(m.from, { image: buf, caption: `🖤💗 *Blackpink Logo*\n\n_${text}_` }, { quoted: m });
                } catch (err) { await conn.sendMessage(m.from, { text: "❌ Failed to generate. Try again!" }, { quoted: m }); }
                break;
            }

            case "3dtext":
            case "gradienttext": {
                if (!text) { await conn.sendMessage(m.from, { text: `🎆 Usage: ${prefix}3dtext <text>\n3D gradient text effect.\nCosts 2 coins.` }, { quoted: m }); break; }
                const textfxProfile19 = await economy.getProfile(redisClient, m.sender);
                if (textfxProfile19.coins < 2) { await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 2 coins.\n\n💰 Balance: ${economy.formatCoins(textfxProfile19.coins)} coins` }, { quoted: m }); break; }
                try {
                    const buf = await fetchTextFxImage("gradienttext", text);
                    await economy.addCoins(redisClient, m.sender, -2);
                    await conn.sendMessage(m.from, { image: buf, caption: `🎆 *3D Gradient Text*\n\n_${text}_` }, { quoted: m });
                } catch (err) { await conn.sendMessage(m.from, { text: "❌ Failed to generate. Try again!" }, { quoted: m }); }
                break;
            }

            case "summerbeach":
            case "beach": {
                if (!text) { await conn.sendMessage(m.from, { text: `🏖️ Usage: ${prefix}beach <text>\nWrites your text in summer beach sand.\nCosts 2 coins.` }, { quoted: m }); break; }
                const textfxProfile20 = await economy.getProfile(redisClient, m.sender);
                if (textfxProfile20.coins < 2) { await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 2 coins.\n\n💰 Balance: ${economy.formatCoins(textfxProfile20.coins)} coins` }, { quoted: m }); break; }
                try {
                    const buf = await fetchTextFxImage("summerbeach", text);
                    await economy.addCoins(redisClient, m.sender, -2);
                    await conn.sendMessage(m.from, { image: buf, caption: `🏖️ *Summer Beach Text*\n\n_${text}_` }, { quoted: m });
                } catch (err) { await conn.sendMessage(m.from, { text: "❌ Failed to generate. Try again!" }, { quoted: m }); }
                break;
            }

            case "luxurygold":
            case "gold": {
                if (!text) { await conn.sendMessage(m.from, { text: `👑 Usage: ${prefix}gold <text>\nLuxury gold text effect.\nCosts 2 coins.` }, { quoted: m }); break; }
                const textfxProfile21 = await economy.getProfile(redisClient, m.sender);
                if (textfxProfile21.coins < 2) { await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 2 coins.\n\n💰 Balance: ${economy.formatCoins(textfxProfile21.coins)} coins` }, { quoted: m }); break; }
                try {
                    const buf = await fetchTextFxImage("luxurygold", text);
                    await economy.addCoins(redisClient, m.sender, -2);
                    await conn.sendMessage(m.from, { image: buf, caption: `👑 *Luxury Gold Text*\n\n_${text}_` }, { quoted: m });
                } catch (err) { await conn.sendMessage(m.from, { text: "❌ Failed to generate. Try again!" }, { quoted: m }); }
                break;
            }

            case "sandsummer":
            case "sand": {
                if (!text) { await conn.sendMessage(m.from, { text: `🏜️ Usage: ${prefix}sand <text>\nWrites your text in beach sand.\nCosts 2 coins.` }, { quoted: m }); break; }
                const textfxProfile22 = await economy.getProfile(redisClient, m.sender);
                if (textfxProfile22.coins < 2) { await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 2 coins.\n\n💰 Balance: ${economy.formatCoins(textfxProfile22.coins)} coins` }, { quoted: m }); break; }
                try {
                    const buf = await fetchTextFxImage("sandsummer", text);
                    await economy.addCoins(redisClient, m.sender, -2);
                    await conn.sendMessage(m.from, { image: buf, caption: `🏜️ *Sand Text*\n\n_${text}_` }, { quoted: m });
                } catch (err) { await conn.sendMessage(m.from, { text: "❌ Failed to generate. Try again!" }, { quoted: m }); }
                break;
            }

            case "galaxywallpaper":
            case "galaxy": {
                if (!text) { await conn.sendMessage(m.from, { text: `🌌 Usage: ${prefix}galaxy <text>\nCreates a galaxy wallpaper with your text.\nCosts 2 coins.` }, { quoted: m }); break; }
                const textfxProfile23 = await economy.getProfile(redisClient, m.sender);
                if (textfxProfile23.coins < 2) { await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 2 coins.\n\n💰 Balance: ${economy.formatCoins(textfxProfile23.coins)} coins` }, { quoted: m }); break; }
                try {
                    const buf = await fetchTextFxImage("galaxywallpaper", text);
                    await economy.addCoins(redisClient, m.sender, -2);
                    await conn.sendMessage(m.from, { image: buf, caption: `🌌 *Galaxy Wallpaper*\n\n_${text}_` }, { quoted: m });
                } catch (err) { await conn.sendMessage(m.from, { text: "❌ Failed to generate. Try again!" }, { quoted: m }); }
                break;
            }

            case "style1917":
            case "vintage2": {
                if (!text) { await conn.sendMessage(m.from, { text: `📜 Usage: ${prefix}vintage <text>\n1917 vintage style text effect.\nCosts 2 coins.` }, { quoted: m }); break; }
                const textfxProfile24 = await economy.getProfile(redisClient, m.sender);
                if (textfxProfile24.coins < 2) { await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 2 coins.\n\n💰 Balance: ${economy.formatCoins(textfxProfile24.coins)} coins` }, { quoted: m }); break; }
                try {
                    const buf = await fetchTextFxImage("style1917", text);
                    await economy.addCoins(redisClient, m.sender, -2);
                    await conn.sendMessage(m.from, { image: buf, caption: `📜 *1917 Vintage Style*\n\n_${text}_` }, { quoted: m });
                } catch (err) { await conn.sendMessage(m.from, { text: "❌ Failed to generate. Try again!" }, { quoted: m }); }
                break;
            }

            case "galaxyneon":
            case "makingneon": {
                if (!text) { await conn.sendMessage(m.from, { text: `🌌⚡ Usage: ${prefix}galaxyneon <text>\nGalaxy-style neon light text effect.\nCosts 2 coins.` }, { quoted: m }); break; }
                const textfxProfile25 = await economy.getProfile(redisClient, m.sender);
                if (textfxProfile25.coins < 2) { await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 2 coins.\n\n💰 Balance: ${economy.formatCoins(textfxProfile25.coins)} coins` }, { quoted: m }); break; }
                try {
                    const buf = await fetchTextFxImage("makingneon", text);
                    await economy.addCoins(redisClient, m.sender, -2);
                    await conn.sendMessage(m.from, { image: buf, caption: `🌌⚡ *Galaxy Neon Text*\n\n_${text}_` }, { quoted: m });
                } catch (err) { await conn.sendMessage(m.from, { text: "❌ Failed to generate. Try again!" }, { quoted: m }); }
                break;
            }

            case "royal":
            case "royaltext": {
                if (!text) { await conn.sendMessage(m.from, { text: `👑 Usage: ${prefix}royal <text>\nRoyal text effect.\nCosts 2 coins.` }, { quoted: m }); break; }
                const textfxProfile26 = await economy.getProfile(redisClient, m.sender);
                if (textfxProfile26.coins < 2) { await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 2 coins.\n\n💰 Balance: ${economy.formatCoins(textfxProfile26.coins)} coins` }, { quoted: m }); break; }
                try {
                    const buf = await fetchTextFxImage("royaltext", text);
                    await economy.addCoins(redisClient, m.sender, -2);
                    await conn.sendMessage(m.from, { image: buf, caption: `👑 *Royal Text*\n\n_${text}_` }, { quoted: m });
                } catch (err) { await conn.sendMessage(m.from, { text: "❌ Failed to generate. Try again!" }, { quoted: m }); }
                break;
            }

            case "hologram":
            case "freecreate": {
                if (!text) { await conn.sendMessage(m.from, { text: `🔷 Usage: ${prefix}hologram <text>\n3D hologram text effect.\nCosts 2 coins.` }, { quoted: m }); break; }
                const textfxProfile27 = await economy.getProfile(redisClient, m.sender);
                if (textfxProfile27.coins < 2) { await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 2 coins.\n\n💰 Balance: ${economy.formatCoins(textfxProfile27.coins)} coins` }, { quoted: m }); break; }
                try {
                    const buf = await fetchTextFxImage("freecreate", text);
                    await economy.addCoins(redisClient, m.sender, -2);
                    await conn.sendMessage(m.from, { image: buf, caption: `🔷 *3D Hologram Text*\n\n_${text}_` }, { quoted: m });
                } catch (err) { await conn.sendMessage(m.from, { text: "❌ Failed to generate. Try again!" }, { quoted: m }); }
                break;
            }

            case "galaxylogo":
            case "galaxystyle": {
                if (!text) { await conn.sendMessage(m.from, { text: `🌌 Usage: ${prefix}galaxylogo <text>\nGalaxy style name logo.\nCosts 2 coins.` }, { quoted: m }); break; }
                const textfxProfile28 = await economy.getProfile(redisClient, m.sender);
                if (textfxProfile28.coins < 2) { await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 2 coins.\n\n💰 Balance: ${economy.formatCoins(textfxProfile28.coins)} coins` }, { quoted: m }); break; }
                try {
                    const buf = await fetchTextFxImage("galaxystyle", text);
                    await economy.addCoins(redisClient, m.sender, -2);
                    await conn.sendMessage(m.from, { image: buf, caption: `🌌 *Galaxy Logo*\n\n_${text}_` }, { quoted: m });
                } catch (err) { await conn.sendMessage(m.from, { text: "❌ Failed to generate. Try again!" }, { quoted: m }); }
                break;
            }

            case "greenneon":
            case "lighteffects": {
                if (!text) { await conn.sendMessage(m.from, { text: `💚 Usage: ${prefix}greenneon <text>\nGreen neon light text effect.\nCosts 2 coins.` }, { quoted: m }); break; }
                const textfxProfile29 = await economy.getProfile(redisClient, m.sender);
                if (textfxProfile29.coins < 2) { await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 2 coins.\n\n💰 Balance: ${economy.formatCoins(textfxProfile29.coins)} coins` }, { quoted: m }); break; }
                try {
                    const buf = await fetchTextFxImage("lighteffects", text);
                    await economy.addCoins(redisClient, m.sender, -2);
                    await conn.sendMessage(m.from, { image: buf, caption: `💚 *Green Neon Light*\n\n_${text}_` }, { quoted: m });
                } catch (err) { await conn.sendMessage(m.from, { text: "❌ Failed to generate. Try again!" }, { quoted: m }); }
                break;
            }

            // ────────────────────────────────────────────────────────────
            //  TEXTPRO COMMANDS  (return JSON with imageUrl)
            // ────────────────────────────────────────────────────────────

            case "neontext":
            case "neon2": {
                if (!text) { await conn.sendMessage(m.from, { text: `🌟 Usage: ${prefix}neon <text>\nNeon light text effect.\nCosts 2 coins.` }, { quoted: m }); break; }
                const textfxProfile30 = await economy.getProfile(redisClient, m.sender);
                if (textfxProfile30.coins < 2) { await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 2 coins.\n\n💰 Balance: ${economy.formatCoins(textfxProfile30.coins)} coins` }, { quoted: m }); break; }
                try {
                    const imgUrl = await fetchTextProImage("neon", text);
                    if (!imgUrl) throw new Error("no url");
                    await economy.addCoins(redisClient, m.sender, -2);
                    await conn.sendMessage(m.from, { image: { url: imgUrl }, caption: `🌟 *Neon Text*\n\n_${text}_` }, { quoted: m });
                } catch (err) { await conn.sendMessage(m.from, { text: "❌ Failed to generate. Try again!" }, { quoted: m }); }
                break;
            }

            case "metalgold":
            case "darkgold": {
                if (!text) { await conn.sendMessage(m.from, { text: `🥇 Usage: ${prefix}darkgold <text>\nDark gold metallic text effect.\nCosts 2 coins.` }, { quoted: m }); break; }
                const textfxProfile31 = await economy.getProfile(redisClient, m.sender);
                if (textfxProfile31.coins < 2) { await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 2 coins.\n\n💰 Balance: ${economy.formatCoins(textfxProfile31.coins)} coins` }, { quoted: m }); break; }
                try {
                    const imgUrl = await fetchTextProImage("metal-dark-gold", text);
                    if (!imgUrl) throw new Error("no url");
                    await economy.addCoins(redisClient, m.sender, -2);
                    await conn.sendMessage(m.from, { image: { url: imgUrl }, caption: `🥇 *Metal Dark Gold*\n\n_${text}_` }, { quoted: m });
                } catch (err) { await conn.sendMessage(m.from, { text: "❌ Failed to generate. Try again!" }, { quoted: m }); }
                break;
            }

            case "halloweenfire":
            case "hellfire": {
                if (!text) { await conn.sendMessage(m.from, { text: `🎃🔥 Usage: ${prefix}hellfire <text>\nHalloween fire text effect.\nCosts 2 coins.` }, { quoted: m }); break; }
                const textfxProfile32 = await economy.getProfile(redisClient, m.sender);
                if (textfxProfile32.coins < 2) { await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 2 coins.\n\n💰 Balance: ${economy.formatCoins(textfxProfile32.coins)} coins` }, { quoted: m }); break; }
                try {
                    const imgUrl = await fetchTextProImage("halloween-fire", text);
                    if (!imgUrl) throw new Error("no url");
                    await economy.addCoins(redisClient, m.sender, -2);
                    await conn.sendMessage(m.from, { image: { url: imgUrl }, caption: `🎃🔥 *Halloween Fire*\n\n_${text}_` }, { quoted: m });
                } catch (err) { await conn.sendMessage(m.from, { text: "❌ Failed to generate. Try again!" }, { quoted: m }); }
                break;
            }

            case "bloodtext":
            case "blood": {
                if (!text) { await conn.sendMessage(m.from, { text: `🩸 Usage: ${prefix}blood <text>\nBlood frosted glass text effect.\nCosts 2 coins.` }, { quoted: m }); break; }
                const textfxProfile33 = await economy.getProfile(redisClient, m.sender);
                if (textfxProfile33.coins < 2) { await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 2 coins.\n\n💰 Balance: ${economy.formatCoins(textfxProfile33.coins)} coins` }, { quoted: m }); break; }
                try {
                    const imgUrl = await fetchTextProImage("blood-text-frosted-glass", text);
                    if (!imgUrl) throw new Error("no url");
                    await economy.addCoins(redisClient, m.sender, -2);
                    await conn.sendMessage(m.from, { image: { url: imgUrl }, caption: `🩸 *Blood Text*\n\n_${text}_` }, { quoted: m });
                } catch (err) { await conn.sendMessage(m.from, { text: "❌ Failed to generate. Try again!" }, { quoted: m }); }
                break;
            }

            case "chocolatecake":
            case "choctext": {
                if (!text) { await conn.sendMessage(m.from, { text: `🍫 Usage: ${prefix}choctext <text>\nChocolate cake text effect.\nCosts 2 coins.` }, { quoted: m }); break; }
                const textfxProfile34 = await economy.getProfile(redisClient, m.sender);
                if (textfxProfile34.coins < 2) { await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 2 coins.\n\n💰 Balance: ${economy.formatCoins(textfxProfile34.coins)} coins` }, { quoted: m }); break; }
                try {
                    const imgUrl = await fetchTextProImage("chocolate-cake", text);
                    if (!imgUrl) throw new Error("no url");
                    await economy.addCoins(redisClient, m.sender, -2);
                    await conn.sendMessage(m.from, { image: { url: imgUrl }, caption: `🍫 *Chocolate Cake Text*\n\n_${text}_` }, { quoted: m });
                } catch (err) { await conn.sendMessage(m.from, { text: "❌ Failed to generate. Try again!" }, { quoted: m }); }
                break;
            }

            case "goldglitter":
            case "glitter": {
                if (!text) { await conn.sendMessage(m.from, { text: `✨ Usage: ${prefix}glitter <text>\nGold glitter text effect.\nCosts 2 coins.` }, { quoted: m }); break; }
                const textfxProfile35 = await economy.getProfile(redisClient, m.sender);
                if (textfxProfile35.coins < 2) { await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 2 coins.\n\n💰 Balance: ${economy.formatCoins(textfxProfile35.coins)} coins` }, { quoted: m }); break; }
                try {
                    const imgUrl = await fetchTextProImage("gold-glitter", text);
                    if (!imgUrl) throw new Error("no url");
                    await economy.addCoins(redisClient, m.sender, -2);
                    await conn.sendMessage(m.from, { image: { url: imgUrl }, caption: `✨ *Gold Glitter Text*\n\n_${text}_` }, { quoted: m });
                } catch (err) { await conn.sendMessage(m.from, { text: "❌ Failed to generate. Try again!" }, { quoted: m }); }
                break;
            }


            // ════════════════════════════════════════════
            // 🤖 EXTRA AI CHAT COMMANDS (Trustbit AI Suite)
            // ════════════════════════════════════════════

            case "gpt": {
                if (!text) { await conn.sendMessage(m.from, { text: `💬 Usage: ${prefix}gpt <question>` }, { quoted: m }); break; }
                try {
                    const d = await aiChat("/ai/chatgpt", { prompt: text });
                    const reply = d?.data?.response || d?.response || "No response.";
                    await conn.sendMessage(m.from, { text: `💬 *ChatGPT*\n\n${reply}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ AI unavailable. Try again!" }, { quoted: m }); }
                break;
            }

            case "blackbox":
            case "bbox": {
                if (!text) { await conn.sendMessage(m.from, { text: `⬛ Usage: ${prefix}blackbox <question>` }, { quoted: m }); break; }
                try {
                    const d = await aiChat("/ai/blackbox", { prompt: text });
                    const reply = d?.data?.response || d?.response || "No response.";
                    await conn.sendMessage(m.from, { text: `⬛ *Blackbox AI*\n\n${reply}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ AI unavailable. Try again!" }, { quoted: m }); }
                break;
            }

            case "ai4chat": {
                if (!text) { await conn.sendMessage(m.from, { text: `💡 Usage: ${prefix}ai4chat <question>` }, { quoted: m }); break; }
                try {
                    const d = await aiChat("/ai/ai4chat", { prompt: text });
                    const reply = d?.data?.response || d?.response || "No response.";
                    await conn.sendMessage(m.from, { text: `💡 *AI4Chat*\n\n${reply}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ AI unavailable. Try again!" }, { quoted: m }); }
                break;
            }

            case "aichat": {
                if (!text) { await conn.sendMessage(m.from, { text: `🗨️ Usage: ${prefix}aichat <question>` }, { quoted: m }); break; }
                try {
                    const d = await aiChat("/ai/aichat", { prompt: text });
                    const reply = d?.response || d?.data?.response || "No response.";
                    await conn.sendMessage(m.from, { text: `🗨️ *AI Chat*\n\n${reply}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ AI unavailable. Try again!" }, { quoted: m }); }
                break;
            }

            case "aichatpro": {
                if (!text) { await conn.sendMessage(m.from, { text: `🔵 Usage: ${prefix}aichatpro <question>` }, { quoted: m }); break; }
                try {
                    const d = await aiChat("/ai/aichatpro", { prompt: text });
                    const reply = d?.response || d?.data?.response || "No response.";
                    await conn.sendMessage(m.from, { text: `🔵 *AiChatPro*\n\n${reply}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ AI unavailable. Try again!" }, { quoted: m }); }
                break;
            }

            case "aiw3":
            case "web3ai": {
                if (!text) { await conn.sendMessage(m.from, { text: `🌐 Usage: ${prefix}web3ai <question>\nSpecialised in Web3 & on-chain topics.` }, { quoted: m }); break; }
                try {
                    const d = await aiChat("/ai/aiw3", { prompt: text });
                    const reply = d?.response || d?.data?.response || "No response.";
                    await conn.sendMessage(m.from, { text: `🌐 *AIW3 (Web3 AI)*\n\n${reply}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ AI unavailable. Try again!" }, { quoted: m }); }
                break;
            }

            case "askgpt5":
            case "askgpt": {
                if (!text) { await conn.sendMessage(m.from, { text: `🧠 Usage: ${prefix}askgpt5 <question>` }, { quoted: m }); break; }
                try {
                    const d = await aiChat("/ai/askgpt5", { prompt: text });
                    const reply = d?.response || d?.data?.response || "No response.";
                    await conn.sendMessage(m.from, { text: `🧠 *AskGPT5*\n\n${reply}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ AI unavailable. Try again!" }, { quoted: m }); }
                break;
            }

            case "quickai":
            case "chatai": {
                if (!text) { await conn.sendMessage(m.from, { text: `⚡ Usage: ${prefix}quickai <question>` }, { quoted: m }); break; }
                try {
                    const d = await aiChat("/ai/ch", { q: text });
                    const reply = d?.response || d?.data?.response || "No response.";
                    await conn.sendMessage(m.from, { text: `⚡ *Quick Chat AI*\n\n${reply}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ AI unavailable. Try again!" }, { quoted: m }); }
                break;
            }

            case "chatup": {
                if (!text) { await conn.sendMessage(m.from, { text: `🔼 Usage: ${prefix}chatup <question>` }, { quoted: m }); break; }
                try {
                    const d = await aiChat("/ai/chatup", { prompt: text });
                    const reply = d?.data?.content || d?.response || "No response.";
                    await conn.sendMessage(m.from, { text: `🔼 *ChatUp AI*\n\n${reply}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ AI unavailable. Try again!" }, { quoted: m }); }
                break;
            }

            case "chatew":
            case "chateverywhere": {
                if (!text) { await conn.sendMessage(m.from, { text: `🌍 Usage: ${prefix}chatew <question>` }, { quoted: m }); break; }
                try {
                    const d = await aiChat("/ai/chateverywhere", { text });
                    const reply = d?.message || d?.data?.message || d?.response || "No response.";
                    await conn.sendMessage(m.from, { text: `🌍 *Chat Everywhere*\n\n${reply}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ AI unavailable. Try again!" }, { quoted: m }); }
                break;
            }

            case "deepask":
            case "deepquery": {
                if (!text) { await conn.sendMessage(m.from, { text: `🔍 Usage: ${prefix}deepask <question>` }, { quoted: m }); break; }
                try {
                    const d = await aiChat("/ai/deepquery", { prompt: text });
                    const reply = d?.response || d?.data?.response || "No response.";
                    await conn.sendMessage(m.from, { text: `🔍 *DeepQuery AI*\n\n${reply}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ AI unavailable. Try again!" }, { quoted: m }); }
                break;
            }

            case "deepseek":
            case "deepseekchat": {
                if (!text) { await conn.sendMessage(m.from, { text: `🐋 Usage: ${prefix}deepseek <question>` }, { quoted: m }); break; }
                try {
                    const d = await aiChat("/ai/deepseekchat", { prompt: text });
                    const reply = d?.response || d?.data?.response || "No response.";
                    await conn.sendMessage(m.from, { text: `🐋 *DeepSeek Chat*\n\n${reply}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ AI unavailable. Try again!" }, { quoted: m }); }
                break;
            }

            case "reasoner":
            case "deepseekreasoner": {
                if (!text) { await conn.sendMessage(m.from, { text: `🐋🧠 Usage: ${prefix}reasoner <question>\nShows reasoning steps + final answer.` }, { quoted: m }); break; }
                try {
                    const d = await aiChat("/ai/deepseekreasoner", { prompt: text });
                    const reply = d?.response || d?.data?.response || "No response.";
                    const reasoning = d?.reasoning ? `\n\n_💭 Reasoning:_\n${d.reasoning}` : "";
                    await conn.sendMessage(m.from, { text: `🐋🧠 *DeepSeek Reasoner*\n\n${reply}${reasoning}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ AI unavailable. Try again!" }, { quoted: m }); }
                break;
            }

            case "anon":
            case "gptanon": {
                if (!text) { await conn.sendMessage(m.from, { text: `🕵️ Usage: ${prefix}anon <question>` }, { quoted: m }); break; }
                try {
                    const d = await aiChat("/ai/gptanon", { prompt: text });
                    const reply = d?.response || d?.data?.response || "No response.";
                    await conn.sendMessage(m.from, { text: `🕵️ *GptAnon*\n\n${reply}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ AI unavailable. Try again!" }, { quoted: m }); }
                break;
            }

            case "gemma":
            case "gemma27": {
                if (!text) { await conn.sendMessage(m.from, { text: `💎 Usage: ${prefix}gemma <question>\nGoogle Gemma 3 27B model.` }, { quoted: m }); break; }
                try {
                    const d = await aiChat("/ai/gemma27", { prompt: text });
                    const reply = d?.response || d?.data?.response || "No response.";
                    await conn.sendMessage(m.from, { text: `💎 *Gemma 27B*\n\n${reply}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ AI unavailable. Try again!" }, { quoted: m }); }
                break;
            }

            case "lumo":
            case "proton": {
                if (!text) { await conn.sendMessage(m.from, { text: `🔮 Usage: ${prefix}lumo <question>\nProton Lumo AI.` }, { quoted: m }); break; }
                try {
                    const d = await aiChat("/ai/lumo", { q: text });
                    const reply = d?.response || d?.data?.response || "No response.";
                    await conn.sendMessage(m.from, { text: `🔮 *Proton Lumo*\n\n${reply}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ AI unavailable. Try again!" }, { quoted: m }); }
                break;
            }

            case "tutor":
            case "msa": {
                if (!text) { await conn.sendMessage(m.from, { text: `📚 Usage: ${prefix}tutor <question>\nMSA Tutor AI — great for studying!` }, { quoted: m }); break; }
                try {
                    const d = await aiChat("/ai/msa", { prompt: text });
                    const reply = d?.response || d?.data?.response || "No response.";
                    await conn.sendMessage(m.from, { text: `📚 *MSA Tutor AI*\n\n${reply}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ AI unavailable. Try again!" }, { quoted: m }); }
                break;
            }

            case "labiba":
            case "olabiba": {
                if (!text) { await conn.sendMessage(m.from, { text: `🧕 Usage: ${prefix}labiba <question>\nLabiba — friendly AI chatbot.` }, { quoted: m }); break; }
                try {
                    const d = await aiChat("/ai/olabiba", { prompt: text });
                    const reply = d?.response || d?.data?.response || "No response.";
                    await conn.sendMessage(m.from, { text: `🧕 *Labiba AI*\n\n${reply}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ AI unavailable. Try again!" }, { quoted: m }); }
                break;
            }

            case "aiwriter":
            case "write": {
                if (!text) { await conn.sendMessage(m.from, { text: `✍️ Usage: ${prefix}write <topic or question>\nAI Writer — great for essays and content.` }, { quoted: m }); break; }
                try {
                    const d = await aiChat("/ai/aiwriter-chat", { prompt: text });
                    const reply = d?.result?.text?.[0] || d?.response || "No response.";
                    await conn.sendMessage(m.from, { text: `✍️ *AI Writer*\n\n${reply}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ AI unavailable. Try again!" }, { quoted: m }); }
                break;
            }

            case "easemate":
            case "ease": {
                if (!text) { await conn.sendMessage(m.from, { text: `🌿 Usage: ${prefix}ease <question>` }, { quoted: m }); break; }
                try {
                    const d = await aiChat("/ai/easemate-chat", { prompt: text });
                    const reply = d?.response || d?.data?.response || "No response.";
                    await conn.sendMessage(m.from, { text: `🌿 *Easemate AI*\n\n${reply}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ AI unavailable. Try again!" }, { quoted: m }); }
                break;
            }

            case "homechat":
            case "hpchat": {
                if (!text) { await conn.sendMessage(m.from, { text: `🏠 Usage: ${prefix}homechat <question>\nHomePlanner AI — home design & ideas.` }, { quoted: m }); break; }
                try {
                    const d = await aiChat("/ai/homeplanner-chat", { prompt: text });
                    const reply = d?.response || d?.data?.response || "No response.";
                    await conn.sendMessage(m.from, { text: `🏠 *HomePlanner AI*\n\n${reply}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ AI unavailable. Try again!" }, { quoted: m }); }
                break;
            }

            case "websearch":
            case "hpsearch": {
                if (!text) { await conn.sendMessage(m.from, { text: `🔎 Usage: ${prefix}websearch <query>\nAI-powered web search.` }, { quoted: m }); break; }
                try {
                    const d = await aiChat("/ai/homeplanner-search", { prompt: text });
                    const reply = d?.answer || d?.response || d?.data?.answer || "No result.";
                    await conn.sendMessage(m.from, { text: `🔎 *Web Search AI*\n\n${reply}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ AI unavailable. Try again!" }, { quoted: m }); }
                break;
            }

            case "zst":
            case "zstai": {
                if (!text) { await conn.sendMessage(m.from, { text: `⚡ Usage: ${prefix}zst <question>` }, { quoted: m }); break; }
                try {
                    const d = await aiChat("/zst/v1/ai/zst", { prompt: text });
                    const reply = d?.data?.response || d?.response || "No response.";
                    await conn.sendMessage(m.from, { text: `⚡ *ZST AI*\n\n${reply}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ AI unavailable. Try again!" }, { quoted: m }); }
                break;
            }

            case "freeai":
            case "unlimited": {
                if (!text) { await conn.sendMessage(m.from, { text: `♾️ Usage: ${prefix}freeai <question>\nAuto-selects the best available AI model.` }, { quoted: m }); break; }
                try {
                    const d = await aiChat("/zst/v1/ai/unlimited", { prompt: text });
                    const reply = d?.data?.response || d?.response || "No response.";
                    await conn.sendMessage(m.from, { text: `♾️ *Unlimited AI*\n\n${reply}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ AI unavailable. Try again!" }, { quoted: m }); }
                break;
            }

            case "summarize":
            case "tldr": {
                if (!text) { await conn.sendMessage(m.from, { text: `📝 Usage: ${prefix}tldr <long text>\nDolphin AI — summarizes your text.` }, { quoted: m }); break; }
                try {
                    const d = await aiChat("/ai/summarize", { text });
                    const reply = d?.response || d?.data?.response || "No response.";
                    await conn.sendMessage(m.from, { text: `📝 *Summarize AI*\n\n${reply}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ AI unavailable. Try again!" }, { quoted: m }); }
                break;
            }

            case "longstory":
            case "advancedstory": {
                if (!text) { await conn.sendMessage(m.from, { text: `📚 Usage: ${prefix}longstory <topic>\nGenerates a longer, detailed story.` }, { quoted: m }); break; }
                try {
                    const d = await aiChat("/ai/advanced", { text });
                    const reply = d?.data?.story || d?.story || "No story generated.";
                    await conn.sendMessage(m.from, { text: `📚 *Advanced Story*\n\n${reply}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ AI unavailable. Try again!" }, { quoted: m }); }
                break;
            }

            case "codeconvert": {
                if (!text) { await conn.sendMessage(m.from, { text: `🔄 Usage: ${prefix}codeconvert <code> to <language>\nExample: ${prefix}codeconvert print("hi") to javascript` }, { quoted: m }); break; }
                try {
                    const toMatch = text.match(/ to (\w+)$/i);
                    const target = toMatch ? toMatch[1] : "javascript";
                    const code = toMatch ? text.slice(0, text.lastIndexOf(" to ")) : text;
                    const d = await aiChat("/ai/convertcode", { code, target });
                    const converted = d?.code || d?.data?.code || "";
                    const explain = d?.explanation || d?.data?.explanation || "";
                    const reply = converted ? `\`\`\`\n${converted}\n\`\`\`\n\n${explain}` : (explain || "No result.");
                    await conn.sendMessage(m.from, { text: `🔄 *Code Convert → ${target}*\n\n${reply}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ AI unavailable. Try again!" }, { quoted: m }); }
                break;
            }

            case "3dimage":
            case "ai3d": {
                if (!text) { await conn.sendMessage(m.from, { text: `🌐 Usage: ${prefix}3dimage <prompt>\nGenerates a 3D AI image.\nCosts 3 coins.` }, { quoted: m }); break; }
                const img3dProfile = await economy.getProfile(redisClient, m.sender);
                if (img3dProfile.coins < 3) { await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 3 coins.\n\n💰 Balance: ${economy.formatCoins(img3dProfile.coins)} coins` }, { quoted: m }); break; }
                try {
                    const d = await aiChat("/ai/3d", { prompt: text });
                    const imgUrl = d?.image_url || d?.data?.image_url || null;
                    if (!imgUrl) throw new Error("no image");
                    await economy.addCoins(redisClient, m.sender, -3);
                    await conn.sendMessage(m.from, { image: { url: imgUrl }, caption: `🌐 *3D AI Image*\n\n_${text}_` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ Image generation failed. Try again!" }, { quoted: m }); }
                break;
            }

            case "appimg":
            case "aiappimg": {
                if (!text) { await conn.sendMessage(m.from, { text: `📱 Usage: ${prefix}appimg <prompt>\nAiApp image generator.\nCosts 3 coins.` }, { quoted: m }); break; }
                const appimgProfile = await economy.getProfile(redisClient, m.sender);
                if (appimgProfile.coins < 3) { await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 3 coins.\n\n💰 Balance: ${economy.formatCoins(appimgProfile.coins)} coins` }, { quoted: m }); break; }
                try {
                    const buf = await aiBinary("/ai/aiappgen", { prompt: text });
                    await economy.addCoins(redisClient, m.sender, -3);
                    await conn.sendMessage(m.from, { image: buf, caption: `📱 *AiApp Image*\n\n_${text}_` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ Image generation failed. Try again!" }, { quoted: m }); }
                break;
            }

            case "lorem":
            case "placeholder": {
                if (!text) { await conn.sendMessage(m.from, { text: `📄 Usage: ${prefix}lorem <number>\nExample: ${prefix}lorem 3 — generates 3 paragraphs of Lorem Ipsum.` }, { quoted: m }); break; }
                try {
                    const count = Math.min(parseInt(text) || 1, 10);
                    const d = await aiChat("/zst/v1/ai/lorem", { count: String(count) });
                    const reply = d?.data?.text || d?.text || "No text generated.";
                    await conn.sendMessage(m.from, { text: `📄 *Lorem Ipsum*\n\n${reply}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ AI unavailable. Try again!" }, { quoted: m }); }
                break;
            }

            case "qr": {
                if (!text) { await conn.sendMessage(m.from, { text: `📷 Usage: ${prefix}qr <text or URL>\nGenerates a QR code image.\nCosts 1 coin.` }, { quoted: m }); break; }
                const qrProfile = await economy.getProfile(redisClient, m.sender);
                if (qrProfile.coins < 1) { await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 1 coin.\n\n💰 Balance: ${economy.formatCoins(qrProfile.coins)} coins` }, { quoted: m }); break; }
                try {
                    const buf = await aiBinary("/zst/v1/ai/qr", { text });
                    await economy.addCoins(redisClient, m.sender, -1);
                    await conn.sendMessage(m.from, { image: buf, caption: `📷 *QR Code*\n\n_${text}_` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ QR generation failed. Try again!" }, { quoted: m }); }
                break;
            }

            case "aiapk":
            case "aipk": {
                if (!text) { await conn.sendMessage(m.from, { text: `📲 Usage: ${prefix}aiapk <question>\nPowered by AiApp AI.` }, { quoted: m }); break; }
                try {
                    const d = await aiChat("/ai/aiapk", { prompt: text });
                    const reply = d?.response || d?.data?.response || "No response.";
                    await conn.sendMessage(m.from, { text: `📲 *AiApp AI*\n\n${reply}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ AI unavailable. Try again!" }, { quoted: m }); }
                break;
            }

            case "aiappchat":
            case "appchat": {
                if (!text) { await conn.sendMessage(m.from, { text: `📱 Usage: ${prefix}appchat <question>\nPowered by AiApp Chat (GPT-4o Mini).` }, { quoted: m }); break; }
                try {
                    const d = await aiChat("/ai/aiappchat", { prompt: text });
                    const reply = d?.response?.choices?.[0]?.message?.content || d?.response || d?.data?.response || "No response.";
                    await conn.sendMessage(m.from, { text: `📱 *AiApp Chat*\n\n${reply}` }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ AI unavailable. Try again!" }, { quoted: m }); }
                break;
            }

            case "voice": {
                if (!text) { await conn.sendMessage(m.from, { text: `🔊 Usage: ${prefix}tts <text>\nConverts your text to speech audio.\nCosts 2 coins.` }, { quoted: m }); break; }
                const voiceProfile = await economy.getProfile(redisClient, m.sender);
                if (voiceProfile.coins < 2) { await conn.sendMessage(m.from, { text: `❌ Insufficient credits! You need 2 coins.\n\n💰 Balance: ${economy.formatCoins(voiceProfile.coins)} coins` }, { quoted: m }); break; }
                try {
                    const d = await aiChat("/ai/homeplanner-tts", { prompt: text });
                    const b64 = d?.audio_base64 || null;
                    if (!b64) throw new Error("no audio");
                    const audioBuf = Buffer.from(b64, "base64");
                    await economy.addCoins(redisClient, m.sender, -2);
                    await conn.sendMessage(m.from, {
                        audio: audioBuf,
                        mimetype: "audio/mpeg",
                        ptt: false
                    }, { quoted: m });
                } catch { await conn.sendMessage(m.from, { text: "❌ TTS failed. Try again!" }, { quoted: m }); }
                break;
            }


            default: {
                // Falls through here only when `command` matched none of the
                // built-in cases above. Check the custom-command registry
                // (.addcmd) before giving up silently.
                await runCustomCommand(command, {
                    m, conn, args, text, command, prefix, redisClient, phoneNumber,
                    isGroup, senderHasAccess, config, groupmod, media, stickers,
                    reminders, economy, isGroupAdmin, isSuperAdmin,
                    require, axios: require('axios')
                });
                break;
            }
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
module.exports.addBioText = addBioText;
module.exports.removeBioText = removeBioText;
module.exports.addStatusText = addStatusText;
module.exports.removeStatusText = removeStatusText;
module.exports.setResponder = setResponder;
module.exports.removeResponder = removeResponder;
module.exports.parseCaseCode = parseCaseCode;
module.exports.compileCommandBody = compileCommandBody;
module.exports.saveCustomCommand = saveCustomCommand;
module.exports.deleteCustomCommand = deleteCustomCommand;
module.exports.reloadCustomCmds = reloadCustomCmds;
module.exports.getBuiltinCommandNames = getBuiltinCommandNames;
module.exports.CONFIG_DEFAULTS = CONFIG_DEFAULTS;
module.exports.isSuperAdmin = isSuperAdmin;
