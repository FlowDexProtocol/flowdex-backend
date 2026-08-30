// ══════════════════════════════════════════════════
// src/routes/prices.js
// Live price endpoint — reads from the 30-second cache
// ══════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const { getPrice } = require('../services/price-service');

// GET /api/price/:crypto — live price from cache
router.get('/:crypto', async (req, res) => {
  try {
    const price = await getPrice(req.params.crypto);
    if (!price) {
      return res.status(503).json({
        success: false,
        error: 'Price feed temporarily unavailable. Try again in a minute.',
        code: 'PRICE_UNAVAILABLE',
      });
    }
    res.json({
      crypto: req.params.crypto.toUpperCase(),
      usd_price: parseFloat(price.usd_price),
      updated_at: price.updated_at,
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports = router;
