// ══════════════════════════════════════════════════
// src/jobs/btc-monitor.js
// Polls all derived BTC addresses for incoming payments
// ══════════════════════════════════════════════════

const axios = require('axios');
const pool = require('../db/pool');
const { processPayment } = require('../services/payment-service');

async function checkBtcPayments() {
  try {
    // Get all BTC deposit addresses that have been assigned to buyers
    const addresses = await pool.query(
      "SELECT buyer_wallet, btc_deposit_address FROM buyers WHERE btc_deposit_address IS NOT NULL"
    );

    for (const row of addresses.rows) {
      const addr = row.btc_deposit_address;
      try {
        // Blockstream API — free, no key needed
        const res = await axios.get(
          'https://blockstream.info/api/address/' + addr + '/txs',
          { timeout: 5000 }
        );
        const txs = res.data || [];

        for (const tx of txs) {
          // Check if this tx is already recorded
          const exists = await pool.query(
            "SELECT id FROM purchases WHERE tx_hash = $1 AND chain = 'bitcoin'",
            [tx.txid]
          );
          if (exists.rows.length > 0) continue;

          // Find the output going to our address
          let btcAmount = 0;
          for (const vout of tx.vout) {
            if (vout.scriptpubkey_address === addr) {
              btcAmount += vout.value / 100000000; // Satoshis to BTC
            }
          }
          if (btcAmount <= 0) continue;

          console.log('[BTC] Payment detected: ' + btcAmount + ' BTC to ' + addr);

          await processPayment({
            senderWallet: row.buyer_wallet, // We know who this address belongs to
            amount: btcAmount,
            currency: 'BTC',
            chain: 'bitcoin',
            txHash: tx.txid,
          });
        }

        // Rate limit: don't hammer Blockstream API
        await new Promise(resolve => setTimeout(resolve, 200));

      } catch (err) {
        if (err.response?.status !== 404) {
          console.error('[BTC] Check failed for ' + addr + ':', err.message);
        }
      }
    }
  } catch (err) {
    console.error('[BTC] Monitor failed:', err.message);
  }
}

module.exports = { checkBtcPayments };
