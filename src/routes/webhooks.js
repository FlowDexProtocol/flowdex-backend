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
const { verifyEvm, verifySolana } = require('../services/chain-verify');
const { sendAlert } = require('../services/alert-service');

// 🔴 EVM_RECEIVING_ADDRESS from .env
const EVM_ADDRESS = (process.env.EVM_RECEIVING_ADDRESS || '').toLowerCase();
// 🔴 SOLANA_RECEIVING_ADDRESS from .env
const SOLANA_ADDRESS = process.env.SOLANA_RECEIVING_ADDRESS || '';

// Alchemy's `activity.network` is one of its own enum values (e.g.
// "ETH_MAINNET", "BNB_MAINNET"), not the app's internal chain slug used
// everywhere else (purchases.chain, token-registry.js, NETWORK_NAMES,
// price-service.js, etc). Without this normalization, BSC activity would
// fall through as an unrecognized chain string — lookupToken()/getNativeToken()
// would silently misidentify BNB and BEP-20 transfers as Ethereum ones.
const ALCHEMY_NETWORK_TO_CHAIN = {
  ETH_MAINNET: 'ethereum',
  BNB_MAINNET: 'bsc',
  MATIC_MAINNET: 'polygon',
  ARB_MAINNET: 'arbitrum',
  OPT_MAINNET: 'optimism',
  BASE_MAINNET: 'base',
};

function normalizeChain(network) {
  if (!network) return 'ethereum';
  return ALCHEMY_NETWORK_TO_CHAIN[network.toUpperCase()] || network.toLowerCase();
}

// ═══ On-chain gate ═══
// A webhook payload is a claim, not proof. Every inbound payment is
// confirmed against the chain before it is credited, so a forged payload
// fails even if the signing key is known — or, as was the case on the
// Helius route, absent entirely.
//
// Three outcomes:
//   verified          → credit it
//   failOpen (API down) → credit it, but alert; reconciliation.js (6-hourly)
//                         compares on-chain against the database and will
//                         surface anything that should not have passed
//   rejected          → do not credit; audit-log it and alert
async function passesChainCheck(check, ctx) {
  if (check.verified) return true;

  if (check.failOpen) {
    console.error('[WEBHOOK] ⚠️ Chain verification unavailable (' + check.reason + '): ' +
      check.detail + ' — crediting on signature alone. tx=' + ctx.txHash);
    await sendAlert('Chain Verification Unavailable',
      'Could not confirm a payment on-chain; it was credited on the webhook signature alone.\n' +
      'Reason: ' + check.reason + '\nDetail: ' + check.detail + '\n' +
      'Chain: ' + ctx.chain + '\nTx: ' + ctx.txHash + '\nWallet: ' + ctx.wallet,
      'warning');
    return true;
  }

  console.warn('[WEBHOOK] 🚫 REJECTED unverified payment (' + check.reason + '): ' +
    check.detail + ' tx=' + ctx.txHash);
  await logAudit('payment_rejected_unverified', null, (ctx.wallet || '').toLowerCase(), ctx.txHash,
    null, { reason: check.reason, detail: check.detail, chain: ctx.chain,
            claimed_amount: ctx.amount, claimed_currency: ctx.currency },
    'Webhook claimed a payment that does not match the chain', 'system');
  await sendAlert('Forged Payment Blocked',
    'A webhook claimed a payment that the chain does not confirm.\n' +
    'Reason: ' + check.reason + '\nDetail: ' + check.detail + '\n' +
    'Chain: ' + ctx.chain + '\nTx: ' + ctx.txHash + '\nWallet: ' + ctx.wallet + '\n' +
    'Claimed: ' + ctx.amount + ' ' + ctx.currency,
    'critical');
  return false;
}

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
      const chain = normalizeChain(activity.network);

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

      // ── Confirm against the chain before crediting ──
      const evmCheck = await verifyEvm({
        txHash,
        chain,
        expectedTo: EVM_ADDRESS,
        expectedFrom: senderWallet,
        expectedAmount: amount,
        contractAddress: contractAddress || null,
        decimals,
      });
      if (!await passesChainCheck(evmCheck, { txHash, chain, wallet: senderWallet, amount, currency })) continue;

      console.log('[WEBHOOK] ' + (isKnown ? '' : '⚠️ UNKNOWN TOKEN: ') + amount + ' ' + currency + ' from ' + senderWallet + ' (' + chain + ') — ' + evmCheck.detail);

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
        console.log('[WEBHOOK] Purchase #' + result.purchaseId + ': ' + (result.tokensAllocated ? result.tokensAllocated.toFixed(0) + ' FDP' : 'needs pricing'));
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
    // Helius signs nothing. Its only authentication is an Authorization
    // header you configure on the webhook ("Auth Header" in the Helius
    // dashboard) and it echoes back verbatim. Without this check the
    // endpoint credits any well-formed POST from anyone who knows the URL.
    const expectedAuth = process.env.HELIUS_AUTH_HEADER;
    if (!expectedAuth) {
      console.error('[WEBHOOK] HELIUS_AUTH_HEADER is not set — rejecting webhook. Configure it in .env and in the Helius dashboard.');
      return res.status(401).json({ error: 'Webhook verification not configured' });
    }
    if (req.headers['authorization'] !== expectedAuth) {
      console.warn('[WEBHOOK] Helius rejected: bad auth header — possible spoofing. IP: ' + (req.headers['x-forwarded-for'] || req.socket.remoteAddress));
      return res.status(401).json({ error: 'Unauthorized' });
    }

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

        const solCheck = await verifySolana({
          txHash,
          expectedTo: SOLANA_ADDRESS,
          expectedFrom: senderWallet,
          expectedAmount: amount,
        });
        if (!await passesChainCheck(solCheck, { txHash, chain: 'solana', wallet: senderWallet, amount, currency: 'SOL' })) continue;

        console.log('[WEBHOOK] ' + amount + ' SOL from ' + senderWallet + ' — ' + solCheck.detail);

        const result = await processPayment({
          senderWallet,
          amount,
          currency: 'SOL',
          chain: 'solana',
          txHash,
        });

        if (result.success) {
          console.log('[WEBHOOK] Purchase #' + result.purchaseId + ': ' + (result.tokensAllocated ? result.tokensAllocated.toFixed(0) + ' FDP' : 'needs pricing'));
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

        const splCheck = await verifySolana({
          txHash,
          expectedTo: SOLANA_ADDRESS,
          expectedFrom: senderWallet,
          expectedAmount: amount,
          mint: t.mint,
        });
        if (!await passesChainCheck(splCheck, { txHash, chain: 'solana', wallet: senderWallet, amount, currency })) continue;

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
