// ══════════════════════════════════════════════════
// src/jobs/tron-monitor.js
// Monitors TRON address for incoming TRC-20 USDT
// ══════════════════════════════════════════════════

const axios = require('axios');
const pool = require('../db/pool');
const { processPayment } = require('../services/payment-service');
const { logAudit } = require('../services/audit-service');

// 🔴 TRON_RECEIVING_ADDRESS must be set in .env
const TRON_ADDRESS = process.env.TRON_RECEIVING_ADDRESS;

// USDT TRC-20 contract on TRON mainnet (this is the official USDT contract — do NOT change)
const USDT_TRC20_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

async function checkTronPayments() {
  if (!TRON_ADDRESS) return;

  try {
    // Get TRC-20 transfers to our address
    const url = 'https://api.trongrid.io/v1/accounts/' + TRON_ADDRESS + '/transactions/trc20';
    const response = await axios.get(url, {
      params: {
        only_to: true,
        limit: 50,
        contract_address: USDT_TRC20_CONTRACT,
      },
      headers: {
        // 🔴 OPTIONAL: Insert TronGrid API key for higher rate limits
        // 'TRON-PRO-API-KEY': process.env.TRONGRID_API_KEY || '',
      },
      timeout: 5000,
    });

    const transfers = response.data.data || [];

    for (const tx of transfers) {
      // Check if already recorded
      const txHash = tx.transaction_id;
      const exists = await pool.query(
        "SELECT id FROM purchases WHERE tx_hash = $1 AND chain = 'tron'",
        [txHash]
      );
      if (exists.rows.length > 0) continue;

      // Only process confirmed transactions
      if (tx.type !== 'Transfer') continue;

      // Calculate amount (USDT TRC-20 has 6 decimals)
      const amount = parseFloat(tx.value) / 1000000;
      if (amount <= 0) continue;

      const senderAddress = tx.from;

      console.log('[TRON] USDT payment detected: $' + amount.toFixed(2) + ' from ' + senderAddress);

      await processPayment({
        senderWallet: senderAddress,
        amount: amount,
        currency: 'USDT',
        chain: 'tron',
        txHash: txHash,
      });

      await logAudit('purchase_created', null, senderAddress, txHash, null,
        { amount, currency: 'USDT', chain: 'tron', network: 'TRC-20' },
        'TRON USDT payment detected', 'system');
    }

    // Also check native TRX transfers (in case someone sends TRX)
    const trxUrl = 'https://api.trongrid.io/v1/accounts/' + TRON_ADDRESS + '/transactions';
    const trxResponse = await axios.get(trxUrl, {
      params: { only_to: true, limit: 20 },
      timeout: 5000,
    });

    const trxTxs = trxResponse.data.data || [];
    for (const tx of trxTxs) {
      if (!tx.raw_data?.contract?.[0]) continue;
      const contract = tx.raw_data.contract[0];
      if (contract.type !== 'TransferContract') continue;

      const txHash = tx.txID;
      const exists = await pool.query(
        "SELECT id FROM purchases WHERE tx_hash = $1 AND chain = 'tron'",
        [txHash]
      );
      if (exists.rows.length > 0) continue;

      const value = contract.parameter?.value;
      if (!value || value.to_address !== TRON_ADDRESS) continue;

      const trxAmount = (value.amount || 0) / 1000000; // SUN to TRX
      if (trxAmount <= 0) continue;

      console.log('[TRON] TRX payment detected: ' + trxAmount + ' TRX');

      await processPayment({
        senderWallet: value.owner_address,
        amount: trxAmount,
        currency: 'TRX',
        chain: 'tron',
        txHash: txHash,
      });
    }

  } catch (err) {
    console.error('[TRON] Monitor failed:', err.message);
  }
}

module.exports = { checkTronPayments };
