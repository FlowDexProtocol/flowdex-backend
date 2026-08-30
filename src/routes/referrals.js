// ══════════════════════════════════════════════════
// src/routes/referrals.js
// Referral codes, stats, list, terminal credits, apply
// ══════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { isValidReferralCode } = require('../middleware/validation');
const { checkReferralFraud } = require('../services/referral-fraud');
const { getClientIP, hashIP } = require('../services/geo-service');
const { logAudit } = require('../services/audit-service');

// GET /api/referral/:wallet/code — referral code
router.get('/:wallet/code', async (req, res) => {
  try {
    const result = await pool.query('SELECT referral_code FROM buyers WHERE buyer_wallet = $1', [req.params.wallet.toLowerCase()]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Buyer not found' });
    res.json({ success: true, referral_code: result.rows[0].referral_code });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/referral/:wallet/stats — referral earnings
router.get('/:wallet/stats', async (req, res) => {
  try {
    const wallet = req.params.wallet.toLowerCase();
    const buyer = await pool.query(
      `SELECT referral_code, total_referral_purchases, total_referral_volume_usd,
              total_referral_earnings_usd, total_referral_earnings_tokens,
              total_terminal_credits_usd, total_bonus_tokens, total_tokens_burned
       FROM buyers WHERE buyer_wallet = $1`, [wallet]
    );
    if (buyer.rows.length === 0) return res.status(404).json({ success: false, error: 'Buyer not found' });
    res.json({ success: true, stats: buyer.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/referral/:wallet/list — referred users
router.get('/:wallet/list', async (req, res) => {
  try {
    const wallet = req.params.wallet.toLowerCase();
    const result = await pool.query(
      `SELECT referred_wallet, has_purchased, first_purchase_at, total_purchases, total_volume_usd,
              referrer_bonus_usd, referrer_terminal_credits, referrer_bonus_tokens, status, created_at
       FROM referrals WHERE referrer_wallet = $1 ORDER BY created_at DESC`, [wallet]
    );
    res.json({ success: true, referrals: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/referral/:wallet/credits — Terminal Credits balance
router.get('/:wallet/credits', async (req, res) => {
  try {
    const wallet = req.params.wallet.toLowerCase();
    const result = await pool.query(
      "SELECT COALESCE(SUM(remaining_amount), 0) as total FROM terminal_credits WHERE wallet = $1 AND status = 'active'",
      [wallet]
    );
    res.json({
      success: true,
      total_credits: parseFloat(result.rows[0].total),
      status: 'active',
      message: 'Redeemable when Intelligence Terminal launches',
      expires: (process.env.REFERRAL_CREDIT_EXPIRY_MONTHS || 6) + ' months after Terminal launch',
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /api/referral/apply — apply a referral code
router.post('/apply', async (req, res) => {
  try {
    const { buyer_wallet, referral_code } = req.body;
    if (!buyer_wallet || !referral_code) {
      return res.status(400).json({ success: false, error: 'buyer_wallet and referral_code required' });
    }

    const wallet = buyer_wallet.toLowerCase();
    const code = referral_code.toUpperCase();

    if (!isValidReferralCode(code)) {
      return res.status(400).json({ success: false, error: 'Invalid referral code', code: 'INVALID_CODE' });
    }

    const referrerLookup = await pool.query('SELECT buyer_wallet FROM buyers WHERE referral_code = $1', [code]);
    if (referrerLookup.rows.length === 0) {
      return res.status(400).json({ success: false, error: 'Invalid referral code', code: 'INVALID_CODE' });
    }
    const referrerWallet = referrerLookup.rows[0].buyer_wallet;

    if (referrerWallet === wallet) {
      return res.status(400).json({ success: false, error: 'Cannot refer yourself', code: 'SELF_REFERRAL' });
    }

    const buyer = await pool.query('SELECT referred_by_code FROM buyers WHERE buyer_wallet = $1', [wallet]);
    if (buyer.rows.length > 0 && buyer.rows[0].referred_by_code) {
      return res.status(400).json({ success: false, error: 'Already referred', code: 'ALREADY_REFERRED' });
    }

    const ip = getClientIP(req);
    const ipHash = hashIP(ip);

    const fraud = await checkReferralFraud(code, wallet, ipHash);
    if (!fraud.clean && (fraud.issues.includes('circular_referral') || fraud.issues.includes('circular_chain'))) {
      return res.status(400).json({ success: false, error: 'Referral not allowed', code: 'REFERRAL_FRAUD' });
    }

    // Ensure buyer record exists, then attach referrer
    const buyerRefCode = 'FDX-' + Math.random().toString(36).substring(2,6).toUpperCase() + '-' + Math.random().toString(36).substring(2,6).toUpperCase();
    await pool.query(
      `INSERT INTO buyers (buyer_wallet, referral_code) VALUES ($1, $2) ON CONFLICT (buyer_wallet) DO NOTHING`,
      [wallet, buyerRefCode]
    );
    await pool.query(
      'UPDATE buyers SET referred_by_wallet = $1, referred_by_code = $2 WHERE buyer_wallet = $3',
      [referrerWallet, code, wallet]
    );

    await pool.query(
      `INSERT INTO referrals (referrer_wallet, referrer_code, referred_wallet, referred_by_code)
       VALUES ($1, $2, $3, $4) ON CONFLICT (referred_wallet) DO NOTHING`,
      [referrerWallet, code, wallet, code]
    );

    await logAudit('referral_applied', null, wallet, null, null,
      { referrer: referrerWallet, code, fraud_flags: fraud.issues }, 'Referral code applied', 'system');

    res.json({ success: true, bonus: '15%' });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports = router;
