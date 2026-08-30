// ══════════════════════════════════════════════════
// src/routes/stats.js
// Daily/weekly/monthly/currency stats — includes burns and credits
// ══════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');
const isoWeek = require('dayjs/plugin/isoWeek');
dayjs.extend(utc);
dayjs.extend(tz);
dayjs.extend(isoWeek);

const TZ = process.env.TIMEZONE || 'Asia/Dubai';

// GET /api/stats — overview stats
router.get('/', async (req, res) => {
  try {
    const raised = await pool.query('SELECT COALESCE(SUM(total_raised_usd),0) as t FROM tiers');
    const buyers = await pool.query('SELECT COUNT(*) as t FROM buyers');
    const purchases = await pool.query("SELECT COUNT(*) as t FROM purchases WHERE status = 'confirmed'");
    const burned = await pool.query('SELECT COALESCE(SUM(tokens_burned),0) as t FROM burn_log');
    const credits = await pool.query('SELECT COALESCE(SUM(amount_usd),0) as t FROM terminal_credits');
    const activeTier = await pool.query('SELECT * FROM tiers WHERE is_active = true LIMIT 1');

    res.json({
      total_raised_usd: parseFloat(raised.rows[0].t),
      total_buyers: parseInt(buyers.rows[0].t),
      total_purchases: parseInt(purchases.rows[0].t),
      total_tokens_burned: parseFloat(burned.rows[0].t),
      total_terminal_credits_issued: parseFloat(credits.rows[0].t),
      active_tier: activeTier.rows[0] || null,
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/stats/daily — today's stats (GMT+4)
router.get('/daily', async (req, res) => {
  try {
    const today = dayjs().tz(TZ).format('YYYY-MM-DD');
    const result = await pool.query('SELECT * FROM daily_stats WHERE date_gmt4 = $1', [today]);
    res.json(result.rows[0] || { date_gmt4: today, message: 'No data yet for today' });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/stats/weekly — this week's stats (Mon-Sun GMT+4)
router.get('/weekly', async (req, res) => {
  try {
    const weekStart = dayjs().tz(TZ).startOf('isoWeek').format('YYYY-MM-DD');
    const result = await pool.query('SELECT * FROM weekly_stats WHERE week_start_gmt4 = $1', [weekStart]);
    res.json(result.rows[0] || { week_start_gmt4: weekStart, message: 'No data yet for this week' });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/stats/monthly — this month's stats
router.get('/monthly', async (req, res) => {
  try {
    const month = dayjs().tz(TZ).format('YYYY-MM');
    const result = await pool.query('SELECT * FROM monthly_stats WHERE month_gmt4 = $1', [month]);
    res.json(result.rows[0] || { month_gmt4: month, message: 'No data yet for this month' });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/stats/by-currency — volume by cryptocurrency
router.get('/by-currency', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT crypto_currency, chain, COUNT(*) as tx_count, SUM(usd_value) as total_usd, SUM(crypto_amount) as total_crypto
       FROM purchases WHERE status = 'confirmed'
       GROUP BY crypto_currency, chain ORDER BY total_usd DESC`
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports = router;
