// ══════════════════════════════════════════════════
// src/routes/subscribe.js
// Public email-updates signup (landing page "Get Updates" form).
// ══════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { ipRateLimit } = require('../middleware/ip-rate-limit');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /api/subscribe — { email }
router.post('/subscribe', ipRateLimit(3, 60 * 60 * 1000), async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
      return res.status(400).json({ success: false, error: 'A valid email address is required' });
    }

    await pool.query(
      `INSERT INTO email_subscribers (email) VALUES ($1)
       ON CONFLICT (email) DO UPDATE SET is_active = true`,
      [email.trim().toLowerCase()]
    );

    res.json({ success: true, message: "You're subscribed!" });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports = router;
