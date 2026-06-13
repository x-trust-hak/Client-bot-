// redisAuthState.js
const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

/**
 * Redis-backed auth state for Baileys
 * Replaces useMultiFileAuthState
 * @param {RedisClient} redis - connected Redis client
 * @param {string} phoneNumber - unique session key
 */
async function useRedisAuthState(redis, phoneNumber) {
  const KEY = `session:${phoneNumber}`;

  // Helper: read one key from Redis hash
  async function readData(field) {
    try {
      const val = await redis.hGet(KEY, field);
      if (!val) return null;
      return JSON.parse(val, BufferJSON.reviver);
    } catch {
      return null;
    }
  }

  // Helper: write one key to Redis hash
  async function writeData(field, data) {
    await redis.hSet(
      KEY,
      field,
      JSON.stringify(data, BufferJSON.replacer)
    );
  }

  // Helper: delete one key from Redis hash
  async function removeData(field) {
    await redis.hDel(KEY, field);
  }

  // Load existing creds or create fresh ones
  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            let val = await readData(`${type}-${id}`);
            // pre-keys need special handling
            if (type === 'app-state-sync-key' && val) {
              const { proto } = require('@whiskeysockets/baileys');
              val = proto.Message.AppStateSyncKeyData.fromObject(val);
            }
            data[id] = val;
          }
          return data;
        },

        set: async (data) => {
          for (const [type, ids] of Object.entries(data)) {
            for (const [id, val] of Object.entries(ids)) {
              if (val) {
                await writeData(`${type}-${id}`, val);
              } else {
                await removeData(`${type}-${id}`);
              }
            }
          }
        },
      },
    },

    saveCreds: async () => {
      await writeData('creds', creds);
    },
  };
}

module.exports = { useRedisAuthState };
