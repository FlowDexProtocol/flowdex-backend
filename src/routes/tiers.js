// ══════════════════════════════════════════════════
// src/routes/tiers.js
// Tier endpoints — checks display_overrides before returning data.
// Overrides affect DISPLAY ONLY — real data is always used for TGE/reconciliation.
// ══════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

async function getActiveOverrides() {
  const result = await pool.query('SELECT key, value FROM display_overrides WHERE is_active = true');
  const map = {};
  result.rows.forEach(r => { map[r.key] = r.value; });
  return map;
}

// GET /api/tiers/current — active tier with progress
router.get('/current', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tiers WHERE is_active = true LIMIT 1');
    if (result.rows.length === 0) {
      return res.json({ message: 'Presale complete' });
    }
    const tier = result.rows[0];
    const overrides = await getActiveOverrides();

    const realRaised = parseFloat(tier.total_raised_usd);
    const displayRaised = overrides.raised_override !== undefined ? parseFloat(overrides.raised_override) : realRaised;
    const displayPrice = overrides.price_override !== undefined ? parseFloat(overrides.price_override) : parseFloat(tier.price);
    const displayTierId = overrides.tier_override !== undefined ? parseInt(overrides.tier_override) : tier.id;
    const progressPct = overrides.progress_bar_override !== undefined
      ? parseFloat(overrides.progress_bar_override)
      : (realRaised / parseFloat(tier.hard_cap_usd)) * 100;

    // FDP still available at this tier's price. Computed from the display
    // figures rather than the real ones, so an admin raised-override moves
    // this number with it instead of contradicting it.
    //
    // Note for whoever hides the cap next: this does not conceal it on its
    // own. tokens_remaining * price + total_raised_usd is the hard cap, and
    // both of the other two are public. Concealing it means dropping
    // hard_cap_usd and progress_pct from this response and the /api/tiers
    // list, which can happen once no front end reads them.
    const tokensRemaining = Math.max(
      (parseFloat(tier.hard_cap_usd) - displayRaised) / displayPrice, 0
    );

    res.json({
      id: displayTierId,
      name: tier.name,
      price: displayPrice,
      total_raised_usd: displayRaised,
      hard_cap_usd: parseFloat(tier.hard_cap_usd),
      tokens_remaining: tokensRemaining,
      progress_pct: Math.min(progressPct, 100).toFixed(2),
      tge_percentage: parseFloat(tier.tge_percentage),
      cliff_months: tier.cliff_months,
      vest_months: tier.vest_months,
      claims_open: tier.claims_open,
      bonus: overrides.bonus_override || null,
      status: overrides.status_override || null,
      countdown: overrides.countdown_override || null,
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/tiers — all 20 tiers
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tiers ORDER BY id');
    // tokens_remaining alongside each tier, so a list can show what is left
    // without each caller repeating the arithmetic differently.
    const rows = result.rows.map((t) => ({
      ...t,
      tokens_remaining: Math.max(
        (parseFloat(t.hard_cap_usd) - parseFloat(t.total_raised_usd)) / parseFloat(t.price), 0
      ),
    }));
    res.json(rows);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports = router;
