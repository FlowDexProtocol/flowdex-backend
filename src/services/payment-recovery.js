// ══════════════════════════════════════════════════
// src/services/payment-recovery.js
// Scans blockchain for payments not in database
// ══════════════════════════════════════════════════

const axios = require('axios');
const pool = require('../db/pool');
const { processPayment } = require('./payment-service');
const { logAudit } = require('./audit-service');

async function scanForMissedPayments(hoursBack) {
  // 🔴 Uses ETHERSCAN_API_KEY and EVM_RECEIVING_ADDRESS from .env
  const address = process.env.EVM_RECEIVING_ADDRESS;
  const apiKey = process.env.ETHERSCAN_API_KEY;
  const cutoff = Math.floor((Date.now() - hoursBack * 60 * 60 * 1000) / 1000);

  const url = `https://api.etherscan.io/v2/api?chainid=1&module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&sort=desc&apikey=${apiKey}`;
  const response = await axios.get(url);
  const txs = (response.data.result || []).filter(tx => {
    return parseInt(tx.timeStamp) >= cutoff
      && tx.to.toLowerCase() === address.toLowerCase()
      && tx.isError === '0';
  });

  let recovered = 0;
  let alreadyRecorded = 0;

  for (const tx of txs) {
    // Check if already in database
    const exists = await pool.query(
      'SELECT id FROM purchases WHERE tx_hash = $1', [tx.hash]
    );
    if (exists.rows.length > 0) {
      alreadyRecorded++;
      continue;
    }

    // This payment was missed — process it
    const ethAmount = parseInt(tx.value) / 1e18;
    if (ethAmount <= 0) continue;

    try {
      await processPayment({
        senderWallet: tx.from,
        amount: ethAmount,
        currency: 'ETH',
        chain: 'ethereum',
        txHash: tx.hash,
      });
      recovered++;
      await logAudit('payment_recovered', null, tx.from, tx.hash, null,
        { amount: ethAmount, source: 'manual_scan' },
        'Missed payment recovered via scan', 'admin');
    } catch (err) {
      console.error('[RECOVERY] Failed to process ' + tx.hash + ':', err.message);
    }
  }

  return { scanned: txs.length, already_recorded: alreadyRecorded, recovered, hours_back: hoursBack };
}

module.exports = { scanForMissedPayments };
