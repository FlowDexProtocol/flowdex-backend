// ══════════════════════════════════════════════════
// src/jobs/cleanup-intents.js
// Expires stale price locks that were never fulfilled
// ══════════════════════════════════════════════════

const pool = require('../db/pool');

async function cleanupExpiredIntents() {
  try {
    const result = await pool.query(`
      UPDATE purchases
      SET status = 'expired', price_lock_status = 'expired'
      WHERE status = 'intent'
        AND price_lock_expires_at < NOW()
        AND price_lock_status = 'active'
      RETURNING id
    `);
    if (result.rows.length > 0) {
      console.log('[CLEANUP] Expired ' + result.rows.length + ' stale purchase intents');
    }
  } catch (err) { console.error('[CLEANUP] Failed:', err.message); }
}

module.exports = { cleanupExpiredIntents };
