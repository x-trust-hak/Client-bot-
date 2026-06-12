const { 

    proto, 

    generateWAMessageFromContent, 

    prepareWAMessageMedia, 

    areJidsSameUser, 

    getContentType 

} = require('@whiskeysockets/baileys');
const { getUptime } = require('./uptime');

const chalk = require('chalk');

const fs = require('fs');

const os = require('os');

const axios = require('axios');

const { exec } = require('child_process');

const moment = require('moment-timezone');
const speed = require('performance-now')   // npm install performance-now
const { performance } = require('perf_hooks')
const human = require('human-readable')

// Database path

const dbPath = './database/database.json';

module.exports = async (devtrust, m, chatUpdate, store) => {

    try {

        const { from, sender, body, mtype, isGroup, pushName } = m;
        
        const quoted = m.quoted ? m.quoted : m;

        // --- DATABASE SAFETY CHECK ---

        if (!fs.existsSync('./database')) fs.mkdirSync('./database');

        let globalDB;

        try {

            const rawData = fs.readFileSync(dbPath, 'utf8');

            globalDB = rawData ? JSON.parse(rawData) : { chats: {}, users: {}, settings: {} };

        } catch (e) {

            globalDB = { chats: {}, users: {}, settings: {} };

        }

        if (!globalDB.settings) globalDB.settings = {};
        
       if (!globalDB.settings.sudo) globalDB.settings.sudo = [];

        if (typeof globalDB.settings.prefix === 'undefined') globalDB.settings.prefix = ".";

        if (!globalDB.settings.statusEmoji) globalDB.settings.statusEmoji = "🔥";
        
global.db = globalDB

if (!global.db.users[sender]) {
  global.db.users[sender] = {
    money: 0,
    exp: 0,
    bank: 0,
    lastkerja: 0,
    lastbansos: 0,
    lastmisi: 0,
    ojekk: 0
  }
}

        let prefix = globalDB.settings.prefix;

if (!body.startsWith(prefix)) return;

const isCmd = true;
      //  const isCmd = body.startsWith(prefix);

        const command = isCmd ? body.slice(prefix.length).trim().split(/ +/).shift().toLowerCase() : '';

        const args = body.trim().split(/ +/).slice(1);

        const text = args.join(" ");

        

        const botNumber = await devtrust.decodeJid(devtrust.user.id);

        const ownerNumber = ["2347041560392@s.whatsapp.net"]; 

        const isOwner = ownerNumber.includes(sender) || m.key.fromMe;
        





const isSudo = globalDB.settings.sudo.includes(sender);
// ===== SELF MODE CHECK =====
if (globalDB.settings.selfMode && !isOwner && !isSudo) {
    return; // ignore all commands from others
}
        // --- GROUP METADATA ---

        const groupMetadata = isGroup ? await devtrust.groupMetadata(from) : '';

        const groupName = isGroup ? groupMetadata.subject : '';

        const participants = isGroup ? await groupMetadata.participants : '';

        const groupAdmins = isGroup ? participants.filter(v => v.admin !== null).map(v => v.id) : [];

        const isBotAdmins = isGroup ? groupAdmins.includes(botNumber) : false;

        const isAdmins = isGroup ? groupAdmins.includes(sender) : false;

        // --- HELPER: RUNTIME ---

        const runtime = (seconds) => {

            seconds = Number(seconds);

            var d = Math.floor(seconds / (3600 * 24));

            var h = Math.floor(seconds % (3600 * 24) / 3600);

            var m = Math.floor(seconds % 3600 / 60);

            var s = Math.floor(seconds % 60);

            return `${d}d ${h}h ${m}m ${s}s`;

        };
        
        
        const FileType = require('file-type')
const axios = require('axios')

devtrust.sendFile = async (jid, url, filename = '', caption = '', quoted) => {
    let res = await axios.get(url, { responseType: 'arraybuffer' })
    let buffer = res.data

    let type = await FileType.fromBuffer(buffer)

    let message = {}

    if (type.mime.startsWith('image')) {
        message.image = buffer
        message.caption = caption
    } 
    else if (type.mime.startsWith('video')) {
        message.video = buffer
        message.caption = caption
    } 
    else if (type.mime.startsWith('audio')) {
        message.audio = buffer
        message.mimetype = 'audio/mp4'
    } 
    else {
        message.document = buffer
        message.fileName = filename || 'file'
        message.mimetype = type.mime
        message.caption = caption
    }

    return devtrust.sendMessage(jid, message, { quoted })
}

        const ownername = 'sirtrust'
        let thumb =
    "https://user-images.githubusercontent.com/72728486/235316834-f9f84ba0-8df3-4444-81d8-db5270995e6d.jpg";
        const fkontak = { key: {participant: `0@s.whatsapp.net`, ...(m.chat ? { remoteJid: `status@broadcast` } : {}) }, message: {
newsletterAdminInviteMessage: {
newsletterJid: '120363331321673219@newsletter',
    newsletterName: 'Pain v1 🇦🇱',
    caption: 'kallmetrust\nPain v1 ' , 'contactMessage': { 'displayName': ownername, 'vcard': `BEGIN:VCARD\nVERSION:3.0\nN:XL;${ownername},;;;\nFN:${ownername}\nitem1.TEL;waid=23481xxxxx:23481xxxxx\nitem1.X-ABLabel:Mobile\nEND:VCARD`, 'jpegThumbnail': thumb, thumbnail: thumb,sendEphemeral: true}}}}

        // --- NEWSLETTER CONTEXT ---

        const channelContext = {

            forwardingScore: 999,

            isForwarded: true,

            forwardedNewsletterMessageInfo: {

                newsletterJid: '120363331321673219@newsletter',

                newsletterName: '𝑬𝒍𝒊𝒙𝒊𝒓 𝑫𝒆𝒂𝒅𝒍𝒚 𝑽𝟑 🇦🇱',

                serverMessageId: 143

            }

        };

        const reply = (teks) => {

            devtrust.sendMessage(from, { text: teks, contextInfo: channelContext }, { quoted: m });

        };
        const replynano = async (teks) => {
  try {
    const imageBuffer = fs.readFileSync('./data/image/thumb.jpg'); // Read the image file

    devtrust.sendMessage(from, {
      text: teks,
      contextInfo: {
        mentionedJid: [sender],
        forwardingScore: 9999,
        isForwarded: true,
        forwardedNewsletterMessageInfo: {
          newsletterJid: '120363331321673219@newsletter', 
         newsletterName: '𝑬𝒍𝒊𝒙𝒊𝒓 𝑫𝒆𝒂𝒅𝒍𝒚 𝑽𝟑 🇦🇱' 
        },
        externalAdReply: {
          showAdAttribution: false,
          containsAutoReply: true,
          title: `𝑬𝑳𝑰𝑿𝑰𝑹 𝑫𝑬𝑨𝑫𝑳𝒀 𝑽𝟑`,
          body: `© POWERED BY DEVTRUST`,
          previewType: "VIDEO", // or try "NONE"
          thumbnail: imageBuffer,  // Try sending the binary data
          mediaUrl: 'https://i.ibb.co/HfsqQk68/tourl-1770546013264.jpg', // Add mediaUrl
          sourceUrl: 'https://i.ibb.co/HfsqQk68/tourl-1770546013264.jpg',
          renderLargerThumbnail: false  // Or try true

        }
      }
    }, { quoted: fkontak });
  } catch (error) {
    console.error("Error in replynano:", error);
    // Handle the error appropriately (e.g., send an error message)
  }
};
// FORMATP
const formatp = human.sizeFormatter({
  std: 'JEDEC', // MB, GB
  decimalPlaces: 2,
  keepTrailingZeroes: false,
  render: (literal, symbol) => `${literal} ${symbol}B`
})

// MESS
const mess = {
  wait: '⏳ Please wait...',
  done: '✅ Done!',
  error: '❌ Error occurred',
  owner: '❌ Owner only command',
  admin: '❌ Admin only',
  group: '❌ Group only',
  private: '❌ Private chat only'
}
// count case
penis = fs.readFileSync("./case.js").toString(),
matches = penis.match(/case '[^']+'(?!.*case '[^']+')/g) || [],
caseCount = matches.length,
caseNames = matches.map(match => match.match(/case '([^']+)'/)[1]);

let totalCases = caseCount,
listCases = caseNames.join('\n⭔ '); 

        // --- LOGGING ---

        if (isCmd) console.log(chalk.black.bgCyan('[ COMMAND ]'), chalk.green(command), 'from', chalk.yellow(pushName));
        
  // --- NEW ALIVE HELPERS (Add at the top inside exports) ---
const getGreeting = () => {
    const hour = moment().tz('Africa/Lagos').hour();
    if (hour < 12) return 'Good Morning 🌅';
    if (hour < 17) return 'Good Afternoon ☀️';
    return 'Good Evening 🌙';
};

const getHealthBar = () => {
    const healths = ["▓░░░░░░░░░", "▓▓░░░░░░░░", "▓▓▓▓░░░░░░", "▓▓▓▓▓▓░░░░", "▓▓▓▓▓▓▓▓░░", "▓▓▓▓▓▓▓▓▓▓"];
    const uptime = process.uptime();
    if (uptime < 3600) return healths[1] + " (Stable)";
    if (uptime < 86400) return healths[3] + " (Strong)";
    return healths[5] + " (Elite)";
};      



async function petFight(type){
if (!isGroup) return replynano(mess.only.group)

let user = global.db.users[sender]
let users = participants.map(p => p.id)

let enemy = users[Math.floor(Math.random()*users.length)]
while (enemy === sender || !global.db.users[enemy]){
  enemy = users[Math.floor(Math.random()*users.length)]
}

if (!devtrust.petfight) devtrust.petfight = {}
if (devtrust.petfight[sender]) return replynano('⚔️ Already in a fight')

devtrust.petfight[sender] = true

let time = Math.floor(Math.random()*5)+1
replynano(`⚔️ ${type} fight started!\nWait ${time} minutes...`)

await new Promise(r=>setTimeout(r, time*60000))

let my = user[type] || 0
let enemyPet = global.db.users[enemy][type] || 0

let myScore = Math.floor(Math.random()*my*2)
let enemyScore = Math.floor(Math.random()*enemyPet*2)

let text = `⚔️ ${type.toUpperCase()} BATTLE\n\n`

if (myScore > enemyScore){
 let win = (myScore-enemyScore)*1000
 user.money += win
 text += `🏆 YOU WIN\n+${win} coins`
}
else if (myScore < enemyScore){
 let lose = (enemyScore-myScore)*1000
 user.money -= lose
 text += `💀 YOU LOST\n-${lose} coins`
}
else{
 text += `🤝 DRAW`
}

replynano(text, { mentions:[enemy] })
delete devtrust.petfight[sender]
}
        
        // ====================== Helper Functions ====================== //
function clockString(ms) {
    let h = Math.floor(ms / 3600000)
    let m = Math.floor(ms / 60000) % 60
    let s = Math.floor(ms / 1000) % 60
    return [h, m, s].map(v => v.toString().padStart(2, '0')).join(':')
}

function pickRandom(list) {
    return list[Math.floor(Math.random() * list.length)]
}
        
        

        switch (command) {

            // ==========================================

            //       🚀 BASIC & SYSTEM COMMANDS

            // ==========================================

            case 'ping': case 'speed': {

                const start = Date.now();

                await devtrust.sendMessage(from, { react: { text: "⚡", key: m.key } });

                const end = Date.now();

                reply(`🚀 *Pong!* Speed: ${end - start}ms`);

            }
break;

            case 'setdesc': {

                if (!isGroup || !isAdmins) return;

                await devtrust.groupUpdateDescription(from, text);

                reply("Success.");

            }

            

            break;

            default:

                if (isOwner && body.startsWith('>')) {

                    try {

                        let evaled = await eval(body.slice(2));

                        if (typeof evaled !== 'string') evaled = require('util').inspect(evaled);

                        reply(evaled);

                    } catch (err) { reply(String(err)); }

                }

                break;
   
        }
        // --- AUTO RESPOND ---
// --- AUTO RESPOND ---
/*if (!isCmd && body.toLowerCase().includes('leesha') && !m.key.fromMe) {
    const responses = [
        "Yes? I'm here! 💖",
        "Mention me one more time and I'll kick you. 😒",
        "At your service! 👑",
        "Pain v1a is online! ✨",
        "Who summoned the queen? 👀",
        "I'm watching you… always. 🧿",
        "Talk to me nicely 😌",
        "Do you need something or just missing me? 🤭",
        "I heard my name!",
        "Don't spam me oh 😭",
        "I'm not your mate 😤",
        "Say please first 🙄",
        "Bot is active and judging you.",
        "You called? I'm expensive though 💅",
        "I no dey rest but you keep tagging me 😒",
        "Make it quick, I'm busy ruling.",
        "Tag me again and see what happens 😌",
        "I’m online. Behave yourself.",
        "Calm down, I’ve arrived.",
        "You rang, my loyal subject?",
        "Respect the queen 👑",
        "I'm always here… watching.",
        "Do you want command or trouble?",
        "Ping received.",
        "I heard noise. What's happening?",
        "Abeg what do you want 😭",
        "Another mention? You people won't rest.",
        "I'm not Google but I'll try.",
        "Talk fast.",
        "State your problem.",
        "I'm awake now.",
        "Who disturb my peace?",
        "Make it make sense.",
        "Don't waste my battery 🔋",
        "I'm only responding because I'm nice.",
        "Try again politely.",
        "Loading attitude… done.",
        "You again? 😭",
        "This better be important.",
        "Say it with your chest.",
        "I'm listening… kinda.",
        "Processing your disturbance…",
        "You called the right bot."
    ];
    reply(responses[Math.floor(Math.random() * responses.length)]);
}*/
if (!isCmd && bodyText.includes('leesha') && !m.key.fromMe) {
    const responses = [
        "Yes? I'm here! 💖",
        "Mention me one more time and I'll kick you. 😒",
        "At your service! 👑",
        "Pain v1 is online! ✨",
        "Who summoned the queen? 👀",
        "I'm watching you… always. 🧿",
        "Talk to me nicely 😌",
        "Do you need something or just missing me? 🤭",
        "I heard my name!",
        "Don't spam me oh 😭",
        "I'm not your mate 😤",
        "Say please first 🙄",
        "Bot is active and judging you.",
        "You called? I'm expensive though 💅",
        "I no dey rest but you keep tagging me 😒",
        "Make it quick, I'm busy ruling.",
        "Tag me again and see what happens 😌",
        "I’m online. Behave yourself.",
        "Calm down, I’ve arrived.",
        "You rang, my loyal subject?",
        "Respect the queen 👑",
        "I'm always here… watching.",
        "Do you want command or trouble?",
        "Ping received.",
        "I heard noise. What's happening?",
        "Abeg what do you want 😭",
        "Another mention? You people won't rest.",
        "I'm not Google but I'll try.",
        "Talk fast.",
        "State your problem.",
        "I'm awake now.",
        "Who disturb my peace?",
        "Make it make sense.",
        "Don't waste my battery 🔋",
        "I'm only responding because I'm nice.",
        "Try again politely.",
        "Loading attitude… done.",
        "You again? 😭",
        "This better be important.",
        "Say it with your chest.",
        "I'm listening… kinda.",
        "Processing your disturbance…",
        "You called the right bot."
    ];
    reply(responses[Math.floor(Math.random() * responses.length)]);
}
// your command cases here

fs.writeFileSync(dbPath, JSON.stringify(global.db, null, 2))

    } catch (err) {

        console.log(chalk.red("Error in case.js: "), err);

    }

};
