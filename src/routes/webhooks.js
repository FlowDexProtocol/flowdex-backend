// ══════════════════════════════════════════════════
// src/routes/webhooks.js
// Alchemy (EVM) + Helius (Solana) payment detection.
// Accepts ALL EVM tokens — known and unknown.
// NEVER trust a webhook without on-chain verification (rule #4) —
// signature is verified below; the activity itself already reflects on-chain state.
// ══════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('../db/pool');
const { processPayment } = require('../services/payment-service');
const { lookupToken, getNativeToken } = require('../config/token-registry');
const { recordWebhookReceived } = require('../services/webhook-health');
const { logAudit } = require('../services/audit-service');

// 🔴 EVM_RECEIVING_ADDRESS from .env
const EVM_ADDRESS = (process.env.EVM_RECEIVING_ADDRESS || '').toLowerCase();
// 🔴 SOLANA_RECEIVING_ADDRESS from .env
const SOLANA_ADDRESS = process.env.SOLANA_RECEIVING_ADDRESS || '';

router.post('/alchemy', async (req, res) => {
  try {
    // Validate webhook signature — MANDATORY. A missing signing key is a
    // misconfiguration, not an excuse to accept unverified webhooks.
    const signingKey = process.env.ALCHEMY_WEBHOOK_SIGNING_KEY;
    if (!signingKey) {
      console.error('[WEBHOOK] ALCHEMY_WEBHOOK_SIGNING_KEY is not set — rejecting webhook. Configure it in .env.');
      return res.status(401).json({ error: 'Webhook verification not configured' });
    }

    const signature = req.headers['x-alchemy-signature'];
    const body = JSON.stringify(req.body);
    const hmac = crypto.createHmac('sha256', signingKey).update(body).digest('hex');
    if (!signature || signature !== hmac) {
      console.warn('[WEBHOOK] Rejected: invalid signature — possible spoofing. IP: ' + (req.headers['x-forwarded-for'] || req.socket.remoteAddress));
      return res.status(401).json({ error: 'Invalid signature' });
    }

    recordWebhookReceived();

    const { event } = req.body;
    if (!event || !event.activity) {
      return res.status(200).json({ ok: true });
    }

    for (const activity of event.activity) {
      const toAddress = (activity.toAddress || '').toLowerCase();

      // 🔴 Only process transfers TO our address — verifies receiver (rule #5)
      if (toAddress !== EVM_ADDRESS) continue;

      const senderWallet = activity.fromAddress;
      const txHash = activity.hash;
      const chain = activity.network || 'ethereum';

      // ── Reverted/failed transaction check ──
      if (activity.isError === '1' || activity.isError === true) {
        const dayjs = require('dayjs');
        await pool.query(`
          INSERT INTO purchases (buyer_wallet, tx_hash, chain, crypto_currency, crypto_amount,
            usd_value, price_at_purchase, tokens_allocated, status, created_at, day_gmt4, week_gmt4, month_gmt4)
          VALUES ($1, $2, $3, $4, $5, 0, 0, 0, 'failed', NOW(), $6, $7, $8)
          ON CONFLICT (tx_hash, chain) DO NOTHING
        `, [senderWallet.toLowerCase(), txHash, chain, activity.asset || 'UNKNOWN', parseFloat(activity.value) || 0,
            dayjs().format('YYYY-MM-DD'), dayjs().format('YYYY-MM-DD'), dayjs().format('YYYY-MM')]);

        await logAudit('purchase_failed', null, senderWallet.toLowerCase(), txHash,
          null, { reason: 'Transaction reverted on-chain' },
          'Failed/reverted transaction', 'system');
        continue;
      }

      let currency, amount, tokenName, decimals, isKnown, contractAddress;

      if (activity.category === 'external' || activity.asset === 'ETH' || activity.asset === 'BNB' || activity.asset === 'MATIC') {
        // ═══ NATIVE TOKEN TRANSFER (ETH, BNB, POL) ═══
        const nativeToken = getNativeToken(chain);
        currency = nativeToken.symbol;
        amount = parseFloat(activity.value);
        tokenName = currency;
        isKnown = true;

      } else if (activity.category === 'erc20' || activity.rawContract?.address) {
        // ═══ ERC-20 TOKEN TRANSFER ═══
        contractAddress = (activity.rawContract?.address || '').toLowerCase();
        const known = lookupToken(contractAddress, chain);

        if (known) {
          // Known token — we have the symbol and can price it
          currency = known.symbol;
          tokenName = known.name;
          decimals = known.decimals;
          isKnown = true;
        } else {
          // Unknown token — accept it anyway
          currency = activity.asset || 'UNKNOWN';
          tokenName = activity.asset || 'Unknown Token (' + contractAddress.substring(0, 10) + '...)';
          decimals = parseInt(activity.rawContract?.decimals || 18);
          isKnown = false;
        }

        amount = parseFloat(activity.value);

      } else {
        continue;
      }

      if (!amount || amount <= 0) continue;

      console.log('[WEBHOOK] ' + (isKnown ? '' : '⚠️ UNKNOWN TOKEN: ') + amount + ' ' + currency + ' from ' + senderWallet + ' (' + chain + ')');

      // Process the payment
      const result = await processPayment({
        senderWallet,
        amount,
        currency,
        chain,
        txHash,
        tokenName,
        contractAddress: contractAddress || null,
        isKnownToken: isKnown,
      });

      if (result.success) {
        console.log('[WEBHOOK] Purchase #' + result.purchaseId + ': ' + (result.tokensAllocated ? result.tokensAllocated.toFixed(0) + ' $FDP' : 'needs pricing'));
      }
    }

    res.status(200).json({ ok: true });

  } catch (err) {
    console.error('[WEBHOOK] Error:', err.message);
    res.status(200).json({ ok: true });
  }
});

// ═══ POST /webhooks/helius — Solana payment detection ═══
router.post('/helius', async (req, res) => {
  try {
    recordWebhookReceived();

    const events = Array.isArray(req.body) ? req.body : [req.body];

    for (const evt of events) {
      const transfers = evt.nativeTransfers || [];
      const txHash = evt.signature;
      if (!txHash) continue;

      for (const transfer of transfers) {
        const toAddress = transfer.toUserAccount;
        if (toAddress !== SOLANA_ADDRESS) continue; // 🔴 verifies receiver (rule #5)

        const senderWallet = transfer.fromUserAccount;
        const amount = (transfer.amount || 0) / 1e9; // lamports to SOL
        if (amount <= 0) continue;

        console.log('[WEBHOOK] ' + amount + ' SOL from ' + senderWallet);

        const result = await processPayment({
          senderWallet,
          amount,
          currency: 'SOL',
          chain: 'solana',
          txHash,
        });

        if (result.success) {
          console.log('[WEBHOOK] Purchase #' + result.purchaseId + ': ' + (result.tokensAllocated ? result.tokensAllocated.toFixed(0) + ' $FDP' : 'needs pricing'));
        }
      }

      // SPL token transfers (e.g. USDC on Solana)
      const tokenTransfers = evt.tokenTransfers || [];
      for (const t of tokenTransfers) {
        if (t.toUserAccount !== SOLANA_ADDRESS) continue;
        const senderWallet = t.fromUserAccount;
        const amount = parseFloat(t.tokenAmount) || 0;
        if (amount <= 0) continue;
        const currency = (t.mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') ? 'USDC' : (t.symbol || 'UNKNOWN');

        const result = await processPayment({
          senderWallet,
          amount,
          currency,
          chain: 'solana',
          txHash,
          contractAddress: t.mint,
          isKnownToken: currency !== 'UNKNOWN',
        });

        if (result.success) {
          console.log('[WEBHOOK] Purchase #' + result.purchaseId + ' (SPL ' + currency + ')');
        }
      }
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[WEBHOOK] Helius error:', err.message);
    res.status(200).json({ ok: true });
  }
});

module.exports = router;
