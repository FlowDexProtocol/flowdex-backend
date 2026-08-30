// ══════════════════════════════════════════════════
// src/routes/public.js
// Public, unauthenticated marketing/info endpoints
// ══════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

function truncateWallet(wallet) {
  if (!wallet || wallet.length <= 10) return wallet;
  return wallet.slice(0, 6) + '...' + wallet.slice(-4);
}

// GET /api/public/staking — static staking info
router.get('/staking', (req, res) => {
  res.json({
    status: 'coming_soon',
    phase: 3,
    fee_share_pct: 40,
    token: '$FDP',
    description: 'Stake $FDP to earn 40% of protocol fees from every trade - crypto, stocks, forex, commodities, and more. Governance voting and routing priority included. In Phase 3, stakers become FlowChain validators.',
    features: ['40% fee sharing', 'Governance voting', 'Routing priority', 'FlowChain validator (Phase 3)'],
  });
});

// GET /api/public/leaders?limit=10 — top presale buyers by total USD spent
router.get('/leaders', async (req, res) => {
  try {
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 10;
    limit = Math.min(limit, 50);

    const result = await pool.query(
      `SELECT p.buyer_wallet,
              SUM(p.usd_value) AS total_usd,
              SUM(p.tokens_allocated) AS total_tokens,
              COUNT(*) AS purchase_count,
              b.tag AS buyer_tag
       FROM purchases p
       LEFT JOIN buyers b ON b.buyer_wallet = p.buyer_wallet
       WHERE p.status = 'confirmed'
       GROUP BY p.buyer_wallet, b.tag
       ORDER BY total_usd DESC
       LIMIT $1`,
      [limit]
    );

    const leaders = result.rows.map(row => ({
      wallet: truncateWallet(row.buyer_wallet),
      total_usd: parseFloat(row.total_usd),
      total_tokens: parseFloat(row.total_tokens),
      purchase_count: parseInt(row.purchase_count, 10),
      buyer_tag: row.buyer_tag || null,
    }));

    res.json(leaders);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/public/scenarios — market cap scenario data
router.get('/scenarios', (req, res) => {
  res.json({
    listing_price: 0.05,
    total_supply: 10000000000,
    scenarios: [
      { label: 'Listing', multiplier: 1, price: 0.05, mcap: 500000000 },
      { label: '5x', multiplier: 5, price: 0.25, mcap: 2500000000 },
      { label: '10x', multiplier: 10, price: 0.50, mcap: 5000000000 },
      { label: '50x', multiplier: 50, price: 2.50, mcap: 25000000000 },
      { label: '100x', multiplier: 100, price: 5.00, mcap: 50000000000 },
    ],
  });
});

// GET /api/public/stats — public presale stats (no auth required)
router.get('/stats', async (req, res) => {
  try {
    const raised = await pool.query('SELECT COALESCE(SUM(total_raised_usd),0) as t FROM tiers');
    const buyers = await pool.query('SELECT COUNT(*) as t FROM buyers');
    const activeTier = await pool.query('SELECT * FROM tiers WHERE is_active = true LIMIT 1');

    res.json({
      total_raised_usd: parseFloat(raised.rows[0].t),
      total_buyers: parseInt(buyers.rows[0].t, 10),
      current_tier: activeTier.rows[0] || null,
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports = router;
