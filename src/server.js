require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cookieParser = require('cookie-parser');
const {
  startBot,
  restoreAllSessions,
  connections,
  getRedis,
  logEvent,
  adminEvents,
  getSettings,
  updateSettings
} = require('./bot');
const reminders = require('./reminders');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'lady-liya-admin-secret';

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '../public')));

// ── Restore all sessions when server starts ──
restoreAllSessions();

// ── Auto Backup: periodically snapshot user metadata into ONE Redis key ──
// (Lightweight — stores summary data only, not full session creds)
setInterval(async () => {
  try {
    const settings = await getSettings();
    if (!settings.autoBackup) return;

    const redis = await getRedis();
    const phoneNumbers = await redis.sMembers('users:all');
    const snapshot = [];

    for (const phone of phoneNumbers) {
      const meta = await redis.hGetAll(`meta:${phone}`);
      snapshot.push({ phone, ...meta });
    }

    await redis.set('backup:latest', JSON.stringify({
      timestamp: Date.now(),
      count: snapshot.length,
      data: snapshot
    }));

    await logEvent('backup_completed', { count: snapshot.length });
    console.log(`💾 Auto backup completed (${snapshot.length} users)`);
  } catch (err) {
    console.error('Auto backup error:', err);
  }
}, 1000 * 60 * 30); // every 30 minutes

// ── Reminder Checker: deliver due personal reminders ──
// Each reminder records WHICH paired session (phoneNumber) should send it,
// since this bot is multi-tenant and only that session's own socket can DM
// the user. If that session isn't currently connected, the reminder is
// requeued a short distance into the future rather than dropped, so it
// still fires once the owner's session reconnects.
setInterval(async () => {
  try {
    const redis = await getRedis();
    const due = await reminders.getDueReminders(redis);

    for (const reminder of due) {
      const conn = connections.get(reminder.phoneNumber);

      if (!conn) {
        // Session not connected right now — requeue a short distance out
        // rather than dropping the reminder, so a brief disconnect doesn't
        // lose it. Capped at 10 retries (~20 min) so a permanently
        // unpaired session can't cause an infinite silent requeue loop.
        const retryCount = (reminder.retryCount || 0) + 1;
        await reminders.deleteReminder(redis, reminder.id);
        if (retryCount <= 10) {
          await reminders.createReminder(redis, {
            phoneNumber: reminder.phoneNumber,
            chatJid: reminder.chatJid,
            jid: reminder.jid,
            text: reminder.text,
            delayMs: 2 * 60 * 1000,
            retryCount
          });
        } else {
          console.log(`Reminder ${reminder.id} dropped after 10 retries — session ${reminder.phoneNumber} never reconnected.`);
        }
        continue;
      }

      try {
        await conn.sendMessage(reminder.chatJid, {
          text: `⏰ *Reminder!*\n\n${reminder.text}`,
          mentions: [reminder.jid]
        });
      } catch (sendErr) {
        console.error('Reminder send error:', sendErr.message);
      }

      await reminders.deleteReminder(redis, reminder.id);
    }
  } catch (err) {
    console.error('Reminder checker error:', err);
  }
}, 30 * 1000); // check every 30 seconds

// ════════════════════════════════════════════════════════
// ADMIN AUTH MIDDLEWARE
// ════════════════════════════════════════════════════════
function requireAdmin(req, res, next) {
  const token = req.cookies?.admin_token || req.headers['x-admin-token'];
  if (token === ADMIN_TOKEN) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

// ── Login ──
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.cookie('admin_token', ADMIN_TOKEN, {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 7 // 7 days
    });
    return res.json({ success: true });
  }
  return res.status(401).json({ error: 'Invalid password' });
});

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('admin_token');
  res.json({ success: true });
});

// ════════════════════════════════════════════════════════
// DASHBOARD STATS
// ════════════════════════════════════════════════════════
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const redis = await getRedis();
    const settings = await getSettings();

    const totalUsers = await redis.sCard('users:all');
    const active = connections.size;

    const today = new Date().toISOString().slice(0, 10);

    const pairingsToday = parseInt(await redis.get(`stats:pairings:${today}`) || '0');
    const pairingsTotal = parseInt(await redis.get('stats:pairings:total') || '0');

    // Week / month aggregation (sum daily counters)
    let pairingsWeek = 0, pairingsMonth = 0;
    const now = new Date();
    for (let i = 0; i < 30; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = `stats:pairings:${d.toISOString().slice(0, 10)}`;
      const val = parseInt(await redis.get(key) || '0');
      if (i < 7) pairingsWeek += val;
      pairingsMonth += val;
    }

    res.json({
      status: settings.maintenanceMode ? 'maintenance' : 'online',
      totalUsers,
      active,
      maxSlots: settings.maxSlots,
      uptime: Math.floor(process.uptime()),
      pairingsToday,
      pairingsWeek,
      pairingsMonth,
      pairingsTotal,
      maintenanceMode: settings.maintenanceMode,
      autoReconnect: settings.autoReconnect,
      autoBackup: settings.autoBackup,
      pairTimeoutSeconds: settings.pairTimeoutSeconds
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

// ════════════════════════════════════════════════════════
// PAIRED USERS LIST
// ════════════════════════════════════════════════════════
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const redis = await getRedis();
    const phoneNumbers = await redis.sMembers('users:all');

    const users = [];
    for (const phone of phoneNumbers) {
      const meta = await redis.hGetAll(`meta:${phone}`);
      const isOnline = connections.has(phone);

      users.push({
        phone,
        status: isOnline ? 'online' : (meta.status || 'offline'),
        pairedAt: meta.pairedAt ? parseInt(meta.pairedAt) : null,
        lastConnected: meta.lastConnected ? parseInt(meta.lastConnected) : null,
        messagesReceived: parseInt(meta.messagesReceived || '0')
      });
    }

    // Sort: online first, then by most recently connected
    users.sort((a, b) => {
      if (a.status === 'online' && b.status !== 'online') return -1;
      if (b.status === 'online' && a.status !== 'online') return 1;
      return (b.lastConnected || 0) - (a.lastConnected || 0);
    });

    res.json({ users });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load users' });
  }
});

// ── Single user detail ──
app.get('/api/admin/users/:phone', requireAdmin, async (req, res) => {
  try {
    const { phone } = req.params;
    const redis = await getRedis();
    const meta = await redis.hGetAll(`meta:${phone}`);

    if (!meta || Object.keys(meta).length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const isOnline = connections.has(phone);

    res.json({
      phone,
      status: isOnline ? 'online' : 'offline',
      pairedAt: meta.pairedAt ? parseInt(meta.pairedAt) : null,
      lastConnected: meta.lastConnected ? parseInt(meta.lastConnected) : null,
      messagesReceived: parseInt(meta.messagesReceived || '0'),
      sessionHealthy: isOnline
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load user' });
  }
});

// ── User actions: logout / delete / restart ──
app.post('/api/admin/users/:phone/logout', requireAdmin, async (req, res) => {
  try {
    const { phone } = req.params;
    const redis = await getRedis();
    const conn = connections.get(phone);

    if (conn) {
      try { await conn.logout(); } catch {}
      connections.delete(phone);
    }

    await redis.del(`session:${phone}`);
    await redis.hSet(`meta:${phone}`, 'status', 'offline');
    await logEvent('logged_out', { phoneNumber: phone });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to logout user' });
  }
});

app.post('/api/admin/users/:phone/delete', requireAdmin, async (req, res) => {
  try {
    const { phone } = req.params;
    const redis = await getRedis();
    const conn = connections.get(phone);

    if (conn) {
      try { await conn.logout(); } catch {}
      connections.delete(phone);
    }

    await redis.del(`session:${phone}`);
    await redis.del(`meta:${phone}`);
    await redis.sRem('users:all', phone);

    await logEvent('session_deleted', { phoneNumber: phone });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

app.post('/api/admin/users/:phone/restart', requireAdmin, async (req, res) => {
  try {
    const { phone } = req.params;
    const conn = connections.get(phone);

    if (conn) {
      try { conn.end(); } catch {}
      connections.delete(phone);
    }

    setTimeout(() => startBot(phone, null), 1000);

    await logEvent('restarted', { phoneNumber: phone });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to restart session' });
  }
});

// ════════════════════════════════════════════════════════
// SESSION STORAGE INFO
// ════════════════════════════════════════════════════════
app.get('/api/admin/storage', requireAdmin, async (req, res) => {
  try {
    const redis = await getRedis();
    const totalUsers = await redis.sCard('users:all');
    const info = await redis.info('memory');

    const usedMatch = info.match(/used_memory_human:(.+)/);
    const usedMemory = usedMatch ? usedMatch[1].trim() : 'unknown';

    const backupRaw = await redis.get('backup:latest');
    let lastBackup = null;
    if (backupRaw) {
      try {
        const parsed = JSON.parse(backupRaw);
        lastBackup = { timestamp: parsed.timestamp, count: parsed.count };
      } catch {}
    }

    const settings = await getSettings();

    res.json({
      totalSessions: totalUsers,
      redisConnected: redis.isOpen,
      memoryUsed: usedMemory,
      autoBackup: settings.autoBackup,
      lastBackup
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load storage info' });
  }
});

app.post('/api/admin/storage/backup', requireAdmin, async (req, res) => {
  try {
    const redis = await getRedis();
    const phoneNumbers = await redis.sMembers('users:all');
    const snapshot = [];

    for (const phone of phoneNumbers) {
      const meta = await redis.hGetAll(`meta:${phone}`);
      snapshot.push({ phone, ...meta });
    }

    await redis.set('backup:latest', JSON.stringify({
      timestamp: Date.now(),
      count: snapshot.length,
      data: snapshot
    }));

    await logEvent('backup_completed', { count: snapshot.length });
    res.json({ success: true, count: snapshot.length, timestamp: Date.now() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Backup failed' });
  }
});

app.post('/api/admin/storage/export', requireAdmin, async (req, res) => {
  try {
    const redis = await getRedis();
    const phoneNumbers = await redis.sMembers('users:all');
    const exportData = [];

    for (const phone of phoneNumbers) {
      const meta = await redis.hGetAll(`meta:${phone}`);
      exportData.push({ phone, ...meta });
    }

    res.json({ exportedAt: Date.now(), count: exportData.length, data: exportData });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to export' });
  }
});

app.post('/api/admin/storage/clean', requireAdmin, async (req, res) => {
  try {
    const redis = await getRedis();
    const phoneNumbers = await redis.sMembers('users:all');
    let cleaned = 0;

    for (const phone of phoneNumbers) {
      const hasCreds = await redis.hExists(`session:${phone}`, 'creds');
      if (!hasCreds && !connections.has(phone)) {
        await redis.del(`session:${phone}`);
        await redis.del(`meta:${phone}`);
        await redis.sRem('users:all', phone);
        cleaned++;
      }
    }

    await logEvent('storage_cleaned', { count: cleaned });
    res.json({ success: true, cleaned });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to clean storage' });
  }
});

// ════════════════════════════════════════════════════════
// SETTINGS
// ════════════════════════════════════════════════════════
app.get('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    const settings = await getSettings();
    res.json({ settings });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

app.post('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    const allowed = ['maxSlots', 'autoReconnect', 'autoBackup', 'pairTimeoutSeconds', 'maintenanceMode'];
    const updates = {};

    for (const key of allowed) {
      if (key in req.body) {
        let val = req.body[key];

        if (key === 'maxSlots' || key === 'pairTimeoutSeconds') {
          val = parseInt(val);
          if (isNaN(val) || val <= 0) {
            return res.status(400).json({ error: `Invalid value for ${key}` });
          }
        }

        if (key === 'autoReconnect' || key === 'autoBackup' || key === 'maintenanceMode') {
          val = Boolean(val);
        }

        updates[key] = val;
      }
    }

    const settings = await updateSettings(updates);

    await logEvent('settings_updated', { updates });

    res.json({ success: true, settings });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});


app.get('/api/admin/logs', requireAdmin, async (req, res) => {
  try {
    const redis = await getRedis();
    const raw = await redis.lRange('events:log', 0, 99);
    const logs = raw.map(item => {
      try { return JSON.parse(item); } catch { return null; }
    }).filter(Boolean);

    res.json({ logs });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load logs' });
  }
});

// ════════════════════════════════════════════════════════
// BROADCAST TO ALL CONNECTED BOTS
// ════════════════════════════════════════════════════════
app.post('/api/admin/broadcast', requireAdmin, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });

    let sent = 0;
    for (const [phone, conn] of connections.entries()) {
      try {
        await conn.sendMessage(`${phone}@s.whatsapp.net`, { text: message });
        sent++;
      } catch (err) {
        console.error(`Broadcast failed for ${phone}:`, err.message);
      }
    }

    await logEvent('broadcast_sent', { sent, message });
    res.json({ success: true, sent });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to broadcast' });
  }
});

// ════════════════════════════════════════════════════════
// ADMIN SOCKET NAMESPACE (live monitor)
// ════════════════════════════════════════════════════════
const adminIo = io.of('/admin');

adminIo.use((socket, next) => {
  // Parse cookies from the handshake headers (httpOnly cookie is sent automatically by browser)
  const cookieHeader = socket.handshake.headers?.cookie || '';
  const cookies = Object.fromEntries(
    cookieHeader.split(';').map(c => {
      const [k, ...v] = c.trim().split('=');
      return [k, v.join('=')];
    }).filter(([k]) => k)
  );

  if (cookies.admin_token === ADMIN_TOKEN) return next();
  next(new Error('Unauthorized'));
});

adminIo.on('connection', (socket) => {
  console.log('Admin dashboard connected');

  // Push live stats every second
  const interval = setInterval(async () => {
    try {
      const redis = await getRedis();
      const settings = await getSettings();
      const totalUsers = await redis.sCard('users:all');

      socket.emit('live-stats', {
        active: connections.size,
        max: settings.maxSlots,
        totalUsers,
        uptime: Math.floor(process.uptime()),
        maintenanceMode: settings.maintenanceMode
      });
    } catch {}
  }, 1000);

  // Forward bot events to admin dashboard in real time
  const onEvent = (event) => {
    socket.emit('live-event', event);
  };
  adminEvents.on('event', onEvent);

  socket.on('disconnect', () => {
    clearInterval(interval);
    adminEvents.off('event', onEvent);
    console.log('Admin dashboard disconnected');
  });
});

// ════════════════════════════════════════════════════════
// FRONTEND SOCKET (pairing page)
// ════════════════════════════════════════════════════════
io.on('connection', (socket) => {
  console.log('Frontend connected');

  const statsInterval = setInterval(async () => {
    const settings = await getSettings();
    socket.emit('stats', {
      active: connections.size,
      max: settings.maxSlots,
      uptime: Math.floor(process.uptime()),
      sessions: [...connections.keys()],
      maintenanceMode: settings.maintenanceMode
    });
  }, 3000);

  socket.on('disconnect', () => {
    clearInterval(statsInterval);
    console.log('Frontend disconnected');
  });

  socket.on('request-code', async (phoneNumber) => {
    if (!phoneNumber) {
      socket.emit('error', 'Phone number is required');
      return;
    }
    console.log('Phone number received:', phoneNumber);
    try {
      await startBot(phoneNumber, socket);
    } catch (error) {
      console.error('Error starting bot:', error);
      socket.emit('error', 'Failed to start bot');
    }
  });
});

// ════════════════════════════════════════════════════════
// SELF-PING (keep Render free instance awake)
// ════════════════════════════════════════════════════════
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()), timestamp: Date.now() });
});

// Ping ourselves every 5 seconds to prevent the free instance from sleeping.
// Requires SELF_URL env var (e.g. https://your-app.onrender.com)
if (process.env.SELF_URL) {
  const SELF_PING_INTERVAL = 300000; // 5 minutes 

  setInterval(() => {
    const url = `${process.env.SELF_URL.replace(/\/$/, '')}/health`;

    require('https').get(url, (res) => {
      // Drain response to free up memory
      res.resume();
    }).on('error', (err) => {
      console.error('Self-ping failed:', err.message);
    });
  }, SELF_PING_INTERVAL);

  console.log(`🔁 Self-ping enabled — pinging ${process.env.SELF_URL}/health every ${SELF_PING_INTERVAL / 1000}s`);
} else {
  console.log('ℹ️ SELF_URL not set — self-ping disabled. Set SELF_URL env var to enable.');
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
