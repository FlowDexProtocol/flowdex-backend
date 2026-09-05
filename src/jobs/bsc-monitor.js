// ══════════════════════════════════════════════════
// src/jobs/bsc-monitor.js
// Fallback BSC payment monitor. The Alchemy webhook (POST /webhooks/alchemy)
// already covers BSC natively — its `network` field is normalized to 'bsc'
// alongside 'ethereum' (see routes/webhooks.js) — but this polls Etherscan
// V2 (chainid=56 covers BSC; no separate BscScan key needed, see
// ETHERSCAN_API_KEY in .env) as a belt-and-suspenders fallback in case that
// webhook is ever missed or Alchemy's BSC coverage is unavailable.
// processPayment()'s tx_hash+chain idempotency check means finding the same
// payment via both paths is harmless — same pattern as btc-monitor.js and
// tron-monitor.js already running alongside their own webhooks.
// ══════════════════════════════════════════════════

const axios = require('axios');
const pool = require('../db/pool');
const { processPayment } = require('../services/payment-service');
const { lookupToken } = require('../config/token-registry');

const BSC_CHAIN_ID = 56;
// 🔴 Same EVM_RECEIVING_ADDRESS used for Ethereum — one address covers every EVM chain
const BSC_ADDRESS = (process.env.EVM_RECEIVING_ADDRESS || '').toLowerCase();

async function checkBscPayments() {
  if (!BSC_ADDRESS) return;
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) return;

  try {
    // ── Native BNB transfers ──
    const nativeUrl = `https://api.etherscan.io/v2/api?chainid=${BSC_CHAIN_ID}&module=account&action=txlist&address=${BSC_ADDRESS}&startblock=0&endblock=99999999&sort=desc&apikey=${apiKey}`;
    const nativeResponse = await axios.get(nativeUrl, { timeout: 5000 });
    const nativeTxs = (nativeResponse.data.result || []).slice(0, 50);

    for (const tx of nativeTxs) {
      if (tx.isError !== '0') continue;
      if ((tx.to || '').toLowerCase() !== BSC_ADDRESS) continue;

      const exists = await pool.query(
        "SELECT id FROM purchases WHERE tx_hash = $1 AND chain = 'bsc'", [tx.hash]
      );
      if (exists.rows.length > 0) continue;

      const amount = parseInt(tx.value) / 1e18;
      if (!amount || amount <= 0) continue;

      console.log('[BSC] BNB payment detected: ' + amount + ' BNB from ' + tx.from);

      await processPayment({
        senderWallet: tx.from,
        amount,
        currency: 'BNB',
        chain: 'bsc',
        txHash: tx.hash,
      });
    }

    // ── BEP-20 token transfers (USDT, USDC, BUSD, etc.) ──
    const tokenUrl = `https://api.etherscan.io/v2/api?chainid=${BSC_CHAIN_ID}&module=account&action=tokentx&address=${BSC_ADDRESS}&startblock=0&endblock=99999999&sort=desc&apikey=${apiKey}`;
    const tokenResponse = await axios.get(tokenUrl, { timeout: 5000 });
    const tokenTxs = (tokenResponse.data.result || []).slice(0, 50);

    for (const tx of tokenTxs) {
      if ((tx.to || '').toLowerCase() !== BSC_ADDRESS) continue;

      const exists = await pool.query(
        "SELECT id FROM purchases WHERE tx_hash = $1 AND chain = 'bsc'", [tx.hash]
      );
      if (exists.rows.length > 0) continue;

      const contractAddress = (tx.contractAddress || '').toLowerCase();
      const known = lookupToken(contractAddress, 'bsc');
      const decimals = known ? known.decimals : parseInt(tx.tokenDecimal || '18', 10);
      const amount = parseInt(tx.value) / Math.pow(10, decimals);
      if (!amount || amount <= 0) continue;

      const currency = known ? known.symbol : (tx.tokenSymbol || 'UNKNOWN');

      console.log('[BSC] ' + (known ? '' : '⚠️ UNKNOWN TOKEN: ') + amount + ' ' + currency + ' from ' + tx.from);

      await processPayment({
        senderWallet: tx.from,
        amount,
        currency,
        chain: 'bsc',
        txHash: tx.hash,
        tokenName: known ? known.name : (tx.tokenName || currency),
        contractAddress,
        isKnownToken: !!known,
      });
    }

  } catch (err) {
    console.error('[BSC] Monitor failed:', err.message);
  }
}

module.exports = { checkBscPayments };
