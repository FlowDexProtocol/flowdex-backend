// ══════════════════════════════════════════════════
// src/routes/buyers.js
// Buyer profile, purchase history, notifications
// Session comes from POST /api/wallet/connect (src/routes/wallet.js)
// ══════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { buyerAuth } = require('../middleware/buyer-auth');
const { validateWalletParam } = require('../middleware/validation');
const { walletRateLimit } = require('../middleware/wallet-rate-limit');
const { markAsRead, markAllRead } = require('../services/notification-service');

// GET /api/buyer/:wallet/profile — full buyer profile
router.get('/:wallet/profile', validateWalletParam, walletRateLimit(30, 60000), buyerAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM buyers WHERE buyer_wallet = $1', [req.params.wallet]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Buyer not found' });
    }
    res.json({ success: true, buyer: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/buyer/:wallet/purchases — purchase history
router.get('/:wallet/purchases', validateWalletParam, walletRateLimit(30, 60000), buyerAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, tx_hash, chain, network_name, crypto_currency, crypto_amount, usd_value, tier_at_purchase,
              tier_name, tier_price, tokens_allocated, status, payment_match_status, created_at, confirmed_at
       FROM purchases WHERE buyer_wallet = $1 ORDER BY created_at DESC`,
      [req.params.wallet]
    );
    res.json({ success: true, purchases: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/buyer/:wallet/purchases/by-tier — grouped by tier
router.get('/:wallet/purchases/by-tier', validateWalletParam, walletRateLimit(30, 60000), buyerAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT tier_at_purchase as tier_id, tier_name, COUNT(*) as purchase_count,
              SUM(usd_value) as total_usd, SUM(tokens_allocated) as total_tokens
       FROM purchases WHERE buyer_wallet = $1 AND status = 'confirmed'
       GROUP BY tier_at_purchase, tier_name ORDER BY tier_at_purchase`,
      [req.params.wallet]
    );
    res.json({ success: true, by_tier: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/buyer/:wallet/notifications — unread notifications (frontend polls every 30s)
router.get('/:wallet/notifications', validateWalletParam, buyerAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM notifications WHERE wallet = $1 AND is_read = false ORDER BY created_at DESC LIMIT 20',
      [req.params.wallet]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /api/buyer/:wallet/notifications/read — mark one as read
router.post('/:wallet/notifications/read', validateWalletParam, buyerAuth, async (req, res) => {
  try {
    const { notification_id } = req.body;
    if (!notification_id) return res.status(400).json({ success: false, error: 'notification_id required' });
    await markAsRead(req.params.wallet, notification_id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /api/buyer/:wallet/notifications/read-all — mark all as read
router.post('/:wallet/notifications/read-all', validateWalletParam, buyerAuth, async (req, res) => {
  try {
    await markAllRead(req.params.wallet);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports = router;
