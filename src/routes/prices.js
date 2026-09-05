// ══════════════════════════════════════════════════
// src/routes/prices.js
// Live price endpoint — fetched on-demand (no background cron); see
// src/services/price-service.js for the cache-freshness/fallback/cooldown
// logic.
// ══════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const { getPrice } = require('../services/price-service');

// GET /api/price/:crypto — on-demand price lookup
router.get('/:crypto', async (req, res) => {
  try {
    const price = await getPrice(req.params.crypto);
    // Nothing cached at all, and both CMC and the CoinGecko fallback failed.
    if (!price) {
      return res.status(503).json({ error: 'Price unavailable' });
    }
    res.json({
      crypto: req.params.crypto.toUpperCase(),
      usd_price: parseFloat(price.usd_price),
      updated_at: price.updated_at,
      // true when this is a stale cached price served because a fresh fetch
      // (CMC, then CoinGecko) failed or was skipped — still returned rather
      // than refused outright.
      stale: !!price.stale,
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports = router;
