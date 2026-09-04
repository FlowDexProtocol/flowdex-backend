// ══════════════════════════════════════════════════
// src/routes/prices.js
// Live price endpoint — reads from the price cache (refreshed on a 5-minute
// cron; see src/services/price-service.js)
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
      // true once the price is over 5 minutes old — the buy page should
      // show a "Prices may be delayed" warning but keep showing the price.
      // Prices over 15 minutes old are refused entirely (503) above.
      is_delayed: !!price.is_delayed,
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports = router;
