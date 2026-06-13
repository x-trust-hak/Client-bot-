require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { startBot } = require('./bot');
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, '../public')));
io.on('connection', (socket) => {
    console.log('Frontend connected');
   setInterval(() => {
    socket.emit("stats", {
        active: connections.size,
        max: 50,
        uptime: process.uptime(),
        sessions: [...connections.keys()]
    });
}, 3000);
    socket.on('request-code', async (phoneNumber) => {
        console.log('Phone number received:', phoneNumber);
        try {
            const code = await startBot(phoneNumber, socket);
        } catch (error) {
            console.error('Error starting bot:', error);
            socket.emit('error', 'Failed to start bot');
        }
    });
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
