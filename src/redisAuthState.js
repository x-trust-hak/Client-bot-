// redisAuthState.js
const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

// ── Small retry helper ─────────────────────────────────────
// IMPORTANT: never let a transient Redis error (timeout, brief
// disconnect, Upstash throttling under load) look like "this key
// doesn't exist". Baileys treats a missing signal/session key as
// corruption and kills the connection with badSession/Bad MAC.
// Under concurrent multi-user load, transient Redis blips become much
// more likely — retry a couple of times, and if it still fails, throw
// a real error instead of silently returning null. A thrown error
// surfaces loudly (and just fails/retries this one operation) instead
// of permanently poisoning the session's crypto state.
async function withRetry(fn, { attempts = 3, baseDelayMs = 150 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise(r => setTimeout(r, baseDelayMs * Math.pow(2, i)));
      }
    }
  }
  throw lastErr;
}

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
    const val = await withRetry(() => redis.hGet(KEY, field));
    if (!val) return null; // genuinely absent — not the same as "Redis errored"
    try {
      return JSON.parse(val, BufferJSON.reviver);
    } catch (err) {
      // Corrupt JSON stored under this field is a real problem worth
      // knowing about, but it's still not the same class of failure as
      // a Redis timeout — log it loudly rather than pretending it's fine.
      console.error(`redisAuthState: failed to parse stored value for ${KEY}.${field}:`, err.message);
      throw err;
    }
  }

  // Helper: write one key to Redis hash
  async function writeData(field, data) {
    await withRetry(() => redis.hSet(KEY, field, JSON.stringify(data, BufferJSON.replacer)));
  }

  // Helper: delete one key from Redis hash
  async function removeData(field) {
    await withRetry(() => redis.hDel(KEY, field));
  }

  // Load existing creds or create fresh ones
  const creds = (await readData('creds').catch(err => {
    console.error(`redisAuthState: could not load creds for ${phoneNumber}, starting fresh:`, err.message);
    return null;
  })) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          // Batch all reads for this call into a single pipeline instead
          // of N sequential round-trips — fewer round-trips means fewer
          // chances for any single one to fail under concurrent load.
          const results = await withRetry(async () => {
            const multi = redis.multi();
            for (const id of ids) {
              multi.hGet(KEY, `${type}-${id}`);
            }
            return multi.exec();
          });

          ids.forEach((id, i) => {
            const raw = results[i];
            if (!raw) {
              data[id] = null;
              return;
            }
            try {
              let val = JSON.parse(raw, BufferJSON.reviver);
              if (type === 'app-state-sync-key' && val) {
                const { proto } = require('@whiskeysockets/baileys');
                val = proto.Message.AppStateSyncKeyData.fromObject(val);
              }
              data[id] = val;
            } catch (err) {
              console.error(`redisAuthState: failed to parse ${type}-${id} for ${phoneNumber}:`, err.message);
              data[id] = null;
            }
          });

          return data;
        },

        set: async (data) => {
          // Batch all writes/deletes for this call into a single pipeline
          // so they either all go out together quickly, or the whole
          // batch is retried together — avoids partial writes under load.
          await withRetry(async () => {
            const multi = redis.multi();
            let hasOps = false;
            for (const [type, ids] of Object.entries(data)) {
              for (const [id, val] of Object.entries(ids)) {
                hasOps = true;
                if (val) {
                  multi.hSet(KEY, `${type}-${id}`, JSON.stringify(val, BufferJSON.replacer));
                } else {
                  multi.hDel(KEY, `${type}-${id}`);
                }
              }
            }
            if (hasOps) await multi.exec();
          });
        },
      },
    },

    saveCreds: async () => {
      await writeData('creds', creds);
    },
  };
}

module.exports = { useRedisAuthState };
