// ══════════════════════════════════════════════════
// src/jobs/solana-monitor.js
// Fallback Solana payment monitor. The Helius webhook
// (POST /webhooks/helius) is the primary path, but a webhook that is
// never delivered — provider outage, misconfiguration, a deploy window —
// means a buyer pays and is never credited. Every other chain already has
// a polling fallback (btc-monitor, tron-monitor, bsc-monitor); Solana had
// none, and for a period had no detection at all.
//
// Reads the chain directly, so unlike the webhook path there is nothing
// to verify after the fact: this IS the on-chain source. processPayment()'s
// tx_hash+chain idempotency means finding the same payment via both the
// webhook and this poll is harmless.
// ══════════════════════════════════════════════════

const axios = require('axios');
const pool = require('../db/pool');
const { processPayment } = require('../services/payment-service');
const { logAudit } = require('../services/audit-service');

// 🔴 SOLANA_RECEIVING_ADDRESS from .env
const SOLANA_ADDRESS = process.env.SOLANA_RECEIVING_ADDRESS;

// Official USDC mint on Solana mainnet — do NOT change.
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// How many recent signatures to examine per run. At a 60s cadence this is
// far more headroom than presale volume needs, and the DB check below means
// re-examining an already-recorded payment costs one indexed lookup.
const SIGNATURE_LIMIT = 25;

function rpcUrl() {
  const key = process.env.HELIUS_API_KEY;
  return key ? `https://mainnet.helius-rpc.com/?api-key=${key}` : null;
}

async function rpc(method, params) {
  const url = rpcUrl();
  if (!url) return null;
  const res = await axios.post(url, { jsonrpc: '2.0', id: 1, method, params }, { timeout: 8000 });
  if (res.data?.error) throw new Error(res.data.error.message || 'rpc error');
  return res.data?.result ?? null;
}

async function checkSolanaPayments() {
  if (!SOLANA_ADDRESS || !rpcUrl()) return;

  try {
    const signatures = await rpc('getSignaturesForAddress', [
      SOLANA_ADDRESS,
      { limit: SIGNATURE_LIMIT },
    ]);
    if (!Array.isArray(signatures) || !signatures.length) return;

    for (const entry of signatures) {
      const txHash = entry.signature;
      if (!txHash || entry.err) continue;

      const exists = await pool.query(
        "SELECT id FROM purchases WHERE tx_hash = $1 AND chain = 'solana'", [txHash]
      );
      if (exists.rows.length > 0) continue;

      const tx = await rpc('getTransaction', [
        txHash,
        { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed', commitment: 'confirmed' },
      ]);
      if (!tx || tx.meta?.err) continue;

      const keys = (tx.transaction?.message?.accountKeys || []).map((k) =>
        typeof k === 'string' ? k : k.pubkey
      );

      // ── SPL token credit (USDC and anything else sent to us) ──
      // Checked before native SOL: an SPL transfer moves no lamports to us,
      // so if a token balance grew, that is the payment.
      const post = tx.meta?.postTokenBalances || [];
      const pre = tx.meta?.preTokenBalances || [];
      const ourTokens = post.filter((b) => b.owner === SOLANA_ADDRESS);

      let credited = 0;
      let mint = null;
      for (const after of ourTokens) {
        const before = pre.find((b) => b.accountIndex === after.accountIndex);
        const delta = (after.uiTokenAmount?.uiAmount || 0) - (before?.uiTokenAmount?.uiAmount || 0);
        if (delta > credited) {
          credited = delta;
          mint = after.mint;
        }
      }

      if (credited > 0 && mint) {
        const currency = mint === USDC_MINT ? 'USDC' : 'UNKNOWN';
        // The sender is whichever token account shrank; fall back to the
        // fee payer, which is the signer who initiated the transfer.
        const senderWallet =
          (pre.find((b) => {
            const after = post.find((x) => x.accountIndex === b.accountIndex);
            return b.owner !== SOLANA_ADDRESS &&
              (b.uiTokenAmount?.uiAmount || 0) > (after?.uiTokenAmount?.uiAmount || 0);
          })?.owner) || keys[0];

        console.log('[SOLANA] ' + currency + ' payment detected: ' + credited + ' from ' + senderWallet);

        await processPayment({
          senderWallet,
          amount: credited,
          currency,
          chain: 'solana',
          txHash,
          contractAddress: mint,
          isKnownToken: currency !== 'UNKNOWN',
        });

        await logAudit('purchase_created', null, senderWallet, txHash, null,
          { amount: credited, currency, chain: 'solana', mint },
          'Solana SPL payment detected by fallback monitor', 'system');
        continue;
      }

      // ── Native SOL credit ──
      const idx = keys.indexOf(SOLANA_ADDRESS);
      if (idx === -1) continue;

      const preLamports = tx.meta?.preBalances?.[idx];
      const postLamports = tx.meta?.postBalances?.[idx];
      if (preLamports === undefined || postLamports === undefined) continue;

      const amount = (postLamports - preLamports) / 1e9;
      if (amount <= 0) continue;

      // keys[0] is the fee payer, i.e. the wallet that sent the SOL.
      const senderWallet = keys[0];

      console.log('[SOLANA] SOL payment detected: ' + amount + ' from ' + senderWallet);

      await processPayment({
        senderWallet,
        amount,
        currency: 'SOL',
        chain: 'solana',
        txHash,
      });

      await logAudit('purchase_created', null, senderWallet, txHash, null,
        { amount, currency: 'SOL', chain: 'solana' },
        'Solana payment detected by fallback monitor', 'system');
    }
  } catch (err) {
    console.error('[SOLANA] Monitor error:', err.message);
  }
}

module.exports = { checkSolanaPayments };
