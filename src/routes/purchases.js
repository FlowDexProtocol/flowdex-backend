// ══════════════════════════════════════════════════
// src/routes/purchases.js
// Purchase intent (price lock + receiving address) + recent activity feed
// Includes IP geolocation lookup on purchase intent (analytics only, no blocking)
// ══════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');
const isoWeek = require('dayjs/plugin/isoWeek');
dayjs.extend(utc);
dayjs.extend(tz);
dayjs.extend(isoWeek);

const { validatePurchaseIntent } = require('../middleware/validation');
const { walletRateLimit } = require('../middleware/wallet-rate-limit');
const { ipRateLimit } = require('../middleware/ip-rate-limit');
const { getPrice, lockPrice } = require('../services/price-service');
const { lookupIP, hashIP, getClientIP } = require('../services/geo-service');
const { getBtcAddressForBuyer } = require('../services/btc-address-service');
const { logAudit } = require('../services/audit-service');

const TZ = process.env.TIMEZONE || 'Asia/Dubai';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /api/purchases/intent — generate payment instruction
router.post('/intent', walletRateLimit(10, 60000), validatePurchaseIntent, async (req, res) => {
  try {
    const { buyer_wallet, chain, crypto, usd_amount, email } = req.body;

    if (email !== undefined && email !== null && email !== '' && !EMAIL_RE.test(String(email).trim())) {
      return res.status(400).json({ success: false, error: 'Invalid email address', code: 'INVALID_EMAIL' });
    }

    // ── Presale complete check ──
    const tierResult = await pool.query('SELECT * FROM tiers WHERE is_active = true LIMIT 1');
    if (tierResult.rows.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Presale has ended. All tiers are complete.',
        code: 'PRESALE_COMPLETE',
      });
    }
    const tier = tierResult.rows[0];

    // ── Price freshness check ──
    // getPrice() only returns null when nothing is cached at all AND both
    // CoinMarketCap and the CoinGecko fallback failed — a stale-but-cached
    // price is still returned (see the stale-price note below) rather than
    // refused.
    const currentPrice = await getPrice(crypto);
    if (!currentPrice) {
      return res.status(503).json({
        success: false,
        error: 'Price unavailable',
        code: 'PRICE_UNAVAILABLE',
      });
    }

    // ── Price lock ──
    let locked;
    try {
      locked = await lockPrice(crypto);
    } catch (err) {
      return res.status(503).json({
        success: false,
        error: 'Price unavailable',
        code: 'PRICE_UNAVAILABLE',
      });
    }

    const cryptoAmount = usd_amount / locked.price;
    const tokensEstimated = usd_amount / parseFloat(tier.price);

    // ── Receiving address by chain ──
    let receivingAddress;
    if (chain === 'tron') {
      receivingAddress = process.env.TRON_RECEIVING_ADDRESS; // 🔴
    } else if (chain === 'bitcoin') {
      receivingAddress = await getBtcAddressForBuyer(buyer_wallet);
    } else if (chain === 'solana') {
      receivingAddress = process.env.SOLANA_RECEIVING_ADDRESS; // 🔴
    } else {
      // Ethereum, BSC, Arbitrum, Polygon, Base — all same EVM address
      receivingAddress = process.env.EVM_RECEIVING_ADDRESS; // 🔴
    }

    // ── Geolocation (analytics only, no blocking) ──
    const clientIP = getClientIP(req);
    const geo = await lookupIP(clientIP);
    const ipHash = hashIP(clientIP);

    const referredByCode = req.body.referral_code || null;

    const now = dayjs().tz(TZ);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    const insertResult = await pool.query(`
      INSERT INTO purchases (
        buyer_wallet, tx_hash, chain, crypto_currency, crypto_amount, usd_value,
        price_at_purchase, price_source, price_lock_status, price_lock_expires_at,
        tier_at_purchase, tier_name, tier_price, tokens_allocated, status,
        buyer_country, buyer_country_code, buyer_state, buyer_city, buyer_ip_hash,
        referred_by_code, created_at, day_gmt4, week_gmt4, month_gmt4
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, 'active', $9,
        $10, $11, $12, $13, 'intent',
        $14, $15, $16, $17, $18,
        $19, NOW(), $20, $21, $22
      ) RETURNING id
    `, [
      buyer_wallet, 'intent-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8), chain, crypto, cryptoAmount, usd_amount,
      locked.price, locked.source, expiresAt,
      tier.id, tier.name, tier.price, tokensEstimated,
      geo?.country || null, geo?.country_code || null, geo?.state || null, geo?.city || null, ipHash,
      referredByCode,
      now.format('YYYY-MM-DD'), now.startOf('isoWeek').format('YYYY-MM-DD'), now.format('YYYY-MM'),
    ]);

    await logAudit('purchase_intent', insertResult.rows[0].id, buyer_wallet, null,
      null, { usd_amount, crypto, chain, price_locked: locked.price },
      'Purchase intent created — price locked for 15 minutes', 'system', clientIP);

    if (email && EMAIL_RE.test(String(email).trim())) {
      try {
        await pool.query(
          `INSERT INTO email_subscribers (email, wallet_address) VALUES ($1, $2)
           ON CONFLICT (email) DO UPDATE SET is_active = true, wallet_address = COALESCE(email_subscribers.wallet_address, $2)`,
          [String(email).trim().toLowerCase(), buyer_wallet]
        );
      } catch (subErr) {
        console.error('[PURCHASES] Failed to upsert email_subscribers:', subErr.message);
      }
    }

    res.json({
      success: true,
      intent_id: insertResult.rows[0].id,
      receiving_address: receivingAddress,
      crypto_amount: cryptoAmount.toFixed(8),
      price_locked: locked.price,
      expires_in: '15 minutes',
      tokens_estimated: tokensEstimated,
      tier: { id: tier.id, name: tier.name, price: parseFloat(tier.price) },
      // The price was stale (upstream fetch failed/skipped) but we allow the
      // purchase anyway — this 15-minute lock is normally what's used for
      // final allocation, but payment-service.js falls back to a fresh
      // confirmation-time price if the lock expires before the payment lands.
      ...(locked.stale ? { note: 'Price may be slightly delayed. Final token allocation will use the price at confirmation time.' } : {}),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/purchases/recent — last 10 purchases (wallets truncated)
router.get('/recent', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT buyer_wallet, crypto_currency, chain, usd_value, tokens_allocated, created_at
       FROM purchases WHERE status = 'confirmed' ORDER BY created_at DESC LIMIT 10`
    );
    const truncated = result.rows.map(r => ({
      wallet: r.buyer_wallet.substring(0, 6) + '...' + r.buyer_wallet.slice(-4),
      crypto_currency: r.crypto_currency,
      chain: r.chain,
      usd_value: parseFloat(r.usd_value),
      tokens_allocated: parseFloat(r.tokens_allocated),
      created_at: r.created_at,
    }));
    res.json(truncated);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/purchases/status/:tx_hash — public lookup, no wallet connection
// needed. tx_hash is stored verbatim (not lowercased) at webhook-ingest time
// (see webhooks.js), so this is an exact-match lookup.
router.get('/status/:tx_hash', ipRateLimit(20, 60000), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT status, usd_value, tokens_allocated, tier_name, created_at, confirmed_at
       FROM purchases WHERE tx_hash = $1`,
      [req.params.tx_hash]
    );
    if (result.rows.length === 0) return res.json({ found: false });

    const p = result.rows[0];
    res.json({
      found: true,
      status: p.status,
      usd_value: p.usd_value !== null ? parseFloat(p.usd_value) : null,
      tokens_allocated: p.tokens_allocated !== null ? parseFloat(p.tokens_allocated) : null,
      tier_name: p.tier_name,
      created_at: p.created_at,
      confirmed_at: p.confirmed_at,
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports = router;
