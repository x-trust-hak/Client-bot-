// fileAuthState.js
// File-based session storage replacing Redis auth state
const fs = require('fs').promises;
const path = require('path');
const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

async function useFileAuthState(phoneNumber) {
  // Create sessions directory if it doesn't exist
  const sessionDir = path.join(process.cwd(), 'sessions', phoneNumber);
  await fs.mkdir(sessionDir, { recursive: true });

  const credsPath = path.join(sessionDir, 'creds.json');
  const keysDir = path.join(sessionDir, 'keys');
  await fs.mkdir(keysDir, { recursive: true });

  // Load or initialize credentials
  let creds;
  try {
    const data = await fs.readFile(credsPath, 'utf-8');
    creds = JSON.parse(data, BufferJSON.reviver);
    console.log(`✅ Loaded creds for ${phoneNumber}`);
  } catch (err) {
    console.log(`📝 Creating new creds for ${phoneNumber}`);
    creds = initAuthCreds();
  }

  // Helper: read key from file
  async function readKey(type, id) {
    try {
      const keyPath = path.join(keysDir, `${type}-${id}.json`);
      const data = await fs.readFile(keyPath, 'utf-8');
      let val = JSON.parse(data, BufferJSON.reviver);
      
      if (type === 'app-state-sync-key' && val) {
        const { proto } = require('@whiskeysockets/baileys');
        val = proto.Message.AppStateSyncKeyData.fromObject(val);
      }
      return val;
    } catch (err) {
      return null; // File doesn't exist
    }
  }

  // Helper: write key to file
  async function writeKey(type, id, data) {
    try {
      const keyPath = path.join(keysDir, `${type}-${id}.json`);
      await fs.writeFile(keyPath, JSON.stringify(data, BufferJSON.replacer), 'utf-8');
    } catch (err) {
      console.error(`Error writing key ${type}-${id}:`, err.message);
    }
  }

  // Helper: delete key file
  async function deleteKey(type, id) {
    try {
      const keyPath = path.join(keysDir, `${type}-${id}.json`);
      await fs.unlink(keyPath);
    } catch (err) {
      // File might not exist
    }
  }

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            data[id] = await readKey(type, id);
          }
          return data;
        },

        set: async (data) => {
          for (const [type, ids] of Object.entries(data)) {
            for (const [id, val] of Object.entries(ids)) {
              if (val) {
                await writeKey(type, id, val);
              } else {
                await deleteKey(type, id);
              }
            }
          }
        },
      },
    },

    saveCreds: async () => {
      try {
        await fs.writeFile(credsPath, JSON.stringify(creds, BufferJSON.replacer), 'utf-8');
      } catch (err) {
        console.error(`Error saving creds for ${phoneNumber}:`, err.message);
      }
    },
  };
}

module.exports = { useFileAuthState };
