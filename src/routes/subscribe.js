// ══════════════════════════════════════════════════
// src/routes/subscribe.js
// Public email-updates signup (landing page "Get Updates" form, and the
// purchase page's Dashboard email-capture banner).
// ══════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { ipRateLimit } = require('../middleware/ip-rate-limit');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /api/subscribe — { email, wallet_address? }. wallet_address is
// optional (the landing page's anonymous form doesn't have one) — when
// present, it links the subscription so GET /api/buyer/:wallet/subscription
// can find it, same as the purchase-intent email-capture flow does.
router.post('/subscribe', ipRateLimit(3, 60 * 60 * 1000), async (req, res) => {
  try {
    const { email, wallet_address } = req.body;
    if (!email || typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
      return res.status(400).json({ success: false, error: 'A valid email address is required' });
    }

    const wallet = typeof wallet_address === 'string' && wallet_address.trim() ? wallet_address.trim().toLowerCase() : null;

    await pool.query(
      `INSERT INTO email_subscribers (email, wallet_address) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET is_active = true, wallet_address = COALESCE(email_subscribers.wallet_address, $2)`,
      [email.trim().toLowerCase(), wallet]
    );

    res.json({ success: true, message: "You're subscribed!" });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports = router;
