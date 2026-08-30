const pool = require('../db/pool');

async function logAudit(eventType, purchaseId, wallet, txHash, oldVal, newVal, reason, performedBy, ip) {
  try {
    await pool.query(
      `INSERT INTO audit_log (event_type,related_purchase_id,related_wallet,related_tx_hash,old_value,new_value,reason,performed_by,ip_address)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [eventType, purchaseId||null, wallet||null, txHash||null,
       oldVal ? JSON.stringify(oldVal) : null, newVal ? JSON.stringify(newVal) : null,
       reason||'', performedBy||'system', ip||null]
    );
  } catch (err) {
    console.error('[AUDIT] Failed:', eventType, err.message);
  }
}

module.exports = { logAudit };
