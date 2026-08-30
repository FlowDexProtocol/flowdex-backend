const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { processClaim } = require('../services/claims-service');

// GET /api/claims/:wallet — all claims for this wallet
router.get('/:wallet', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM claims WHERE buyer_wallet = $1 ORDER BY tier_id', [req.params.wallet.toLowerCase()]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/claims/:wallet/claim — process a TGE claim
router.post('/:wallet/claim', async (req, res) => {
  try {
    const { tier_id } = req.body;
    if (!tier_id) return res.status(400).json({ error: 'tier_id required' });
    const result = await processClaim(req.params.wallet.toLowerCase(), tier_id);
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
