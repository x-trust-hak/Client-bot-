const fs = require("fs");

module.exports = async (conn, m, chatUpdate) => {
    try {
        const body = m.body || "";
        const prefix = ".";

        if (!body.startsWith(prefix)) return;

        const args = body.slice(prefix.length).trim().split(/ +/);
        const command = args.shift().toLowerCase();
        const text = args.join(" ");

        console.log("Command:", command);

        switch (command) {
            case "ping":
                await conn.sendMessage(m.from, {
                    text: "🏓 Pong!"
                }, {
                    quoted: m
                });
                break;

            case "hi":
                await conn.sendMessage(m.from, {
                    text: `Hello ${m.sender}`
                }, {
                    quoted: m
                });
                break;

            case "owner":
                await conn.sendMessage(m.from, {
                    text: "👑 Bot Owner"
                }, {
                    quoted: m
                });
                break;

            case "echo":
                await conn.sendMessage(m.from, {
                    text: text || "Nothing to echo."
                }, {
                    quoted: m
                });
                break;

            default:
                // Ignore unknown commands
                break;
        }
    } catch (err) {
        console.log("case.js error:", err);
    }
};
