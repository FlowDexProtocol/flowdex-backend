// ══════════════════════════════════════════════════
// src/jobs/stats-aggregator.js
// Aggregates daily/weekly/monthly stats — includes burns and Terminal Credits.
// Daily runs at 00:05 GMT+4 (20:05 UTC). All timestamps stored UTC, displayed GMT+4 (rule #7).
// ══════════════════════════════════════════════════

const pool = require('../db/pool');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');
const isoWeek = require('dayjs/plugin/isoWeek');
dayjs.extend(utc);
dayjs.extend(tz);
dayjs.extend(isoWeek);

const TZ = process.env.TIMEZONE || 'Asia/Dubai';

function currencyVolume(rows, currency, chain) {
  const row = rows.find(r => r.crypto_currency === currency && (!chain || r.chain === chain));
  return row ? { vol: parseFloat(row.vol), cnt: parseInt(row.cnt) } : { vol: 0, cnt: 0 };
}

async function aggregateDailyStats(targetDate) {
  const date = targetDate || dayjs().tz(TZ).subtract(1, 'day').format('YYYY-MM-DD');

  const totals = await pool.query(
    `SELECT COALESCE(SUM(usd_value),0) as raised, COUNT(*) as purchases, COUNT(DISTINCT buyer_wallet) as buyers
     FROM purchases WHERE day_gmt4 = $1 AND status = 'confirmed'`, [date]
  );
  const newBuyers = await pool.query(
    `SELECT COUNT(*) as t FROM buyers WHERE created_at::date = $1::date`, [date]
  );
  const tokensSold = await pool.query(
    `SELECT COALESCE(SUM(tokens_allocated),0) as t FROM purchases WHERE day_gmt4 = $1 AND status = 'confirmed'`, [date]
  );
  const burned = await pool.query(
    `SELECT COALESCE(SUM(tokens_burned),0) as t FROM burn_log WHERE created_at::date = $1::date`, [date]
  );
  const credits = await pool.query(
    `SELECT COALESCE(SUM(amount_usd),0) as t FROM terminal_credits WHERE created_at::date = $1::date`, [date]
  );
  const byCurrency = await pool.query(
    `SELECT crypto_currency, chain, SUM(usd_value) as vol, COUNT(*) as cnt
     FROM purchases WHERE day_gmt4 = $1 AND status = 'confirmed' GROUP BY crypto_currency, chain`, [date]
  );
  const rows = byCurrency.rows;
  const eth = currencyVolume(rows, 'ETH');
  const usdt = currencyVolume(rows, 'USDT');
  const usdc = currencyVolume(rows, 'USDC');
  const bnb = currencyVolume(rows, 'BNB');
  const sol = currencyVolume(rows, 'SOL');
  const btc = currencyVolume(rows, 'BTC');
  const tronUsdt = currencyVolume(rows, 'USDT', 'tron');
  const trx = currencyVolume(rows, 'TRX');
  const known = new Set(['ETH', 'USDT', 'USDC', 'BNB', 'SOL', 'BTC', 'TRX']);
  const otherRows = rows.filter(r => !known.has(r.crypto_currency));
  const other = { vol: otherRows.reduce((s, r) => s + parseFloat(r.vol), 0), cnt: otherRows.reduce((s, r) => s + parseInt(r.cnt), 0) };

  await pool.query(`
    INSERT INTO daily_stats (
      date_gmt4, total_raised_usd, total_purchases, total_buyers, new_buyers, tokens_sold, tokens_burned,
      terminal_credits_issued, eth_volume, eth_tx_count, usdt_volume, usdt_tx_count, usdc_volume, usdc_tx_count,
      bnb_volume, bnb_tx_count, sol_volume, sol_tx_count, btc_volume, btc_tx_count,
      tron_usdt_volume, tron_usdt_tx_count, trx_volume, trx_tx_count, other_volume, other_tx_count
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
    ON CONFLICT (date_gmt4) DO UPDATE SET
      total_raised_usd=$2, total_purchases=$3, total_buyers=$4, new_buyers=$5, tokens_sold=$6, tokens_burned=$7,
      terminal_credits_issued=$8, eth_volume=$9, eth_tx_count=$10, usdt_volume=$11, usdt_tx_count=$12,
      usdc_volume=$13, usdc_tx_count=$14, bnb_volume=$15, bnb_tx_count=$16, sol_volume=$17, sol_tx_count=$18,
      btc_volume=$19, btc_tx_count=$20, tron_usdt_volume=$21, tron_usdt_tx_count=$22, trx_volume=$23, trx_tx_count=$24,
      other_volume=$25, other_tx_count=$26
  `, [date, totals.rows[0].raised, totals.rows[0].purchases, totals.rows[0].buyers, newBuyers.rows[0].t,
      tokensSold.rows[0].t, burned.rows[0].t, credits.rows[0].t,
      eth.vol, eth.cnt, usdt.vol, usdt.cnt, usdc.vol, usdc.cnt, bnb.vol, bnb.cnt, sol.vol, sol.cnt, btc.vol, btc.cnt,
      tronUsdt.vol, tronUsdt.cnt, trx.vol, trx.cnt, other.vol, other.cnt]);

  console.log('[STATS] Daily stats aggregated for ' + date);
}

async function aggregateWeeklyStats(targetWeekStart) {
  const weekStart = targetWeekStart || dayjs().tz(TZ).subtract(1, 'week').startOf('isoWeek').format('YYYY-MM-DD');
  const weekEnd = dayjs(weekStart).endOf('isoWeek').format('YYYY-MM-DD');

  const totals = await pool.query(
    `SELECT COALESCE(SUM(usd_value),0) as raised, COUNT(*) as purchases, COUNT(DISTINCT buyer_wallet) as buyers
     FROM purchases WHERE week_gmt4 = $1 AND status = 'confirmed'`, [weekStart]
  );
  const newBuyers = await pool.query(
    `SELECT COUNT(*) as t FROM buyers WHERE created_at::date BETWEEN $1::date AND $2::date`, [weekStart, weekEnd]
  );
  const tokensSold = await pool.query(
    `SELECT COALESCE(SUM(tokens_allocated),0) as t FROM purchases WHERE week_gmt4 = $1 AND status = 'confirmed'`, [weekStart]
  );
  const burned = await pool.query(
    `SELECT COALESCE(SUM(tokens_burned),0) as t FROM burn_log WHERE created_at::date BETWEEN $1::date AND $2::date`, [weekStart, weekEnd]
  );
  const credits = await pool.query(
    `SELECT COALESCE(SUM(amount_usd),0) as t FROM terminal_credits WHERE created_at::date BETWEEN $1::date AND $2::date`, [weekStart, weekEnd]
  );

  await pool.query(`
    INSERT INTO weekly_stats (week_start_gmt4, week_end_gmt4, total_raised_usd, total_purchases, total_buyers, new_buyers, tokens_sold, tokens_burned, terminal_credits_issued)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (week_start_gmt4) DO UPDATE SET
      week_end_gmt4=$2, total_raised_usd=$3, total_purchases=$4, total_buyers=$5, new_buyers=$6, tokens_sold=$7, tokens_burned=$8, terminal_credits_issued=$9
  `, [weekStart, weekEnd, totals.rows[0].raised, totals.rows[0].purchases, totals.rows[0].buyers,
      newBuyers.rows[0].t, tokensSold.rows[0].t, burned.rows[0].t, credits.rows[0].t]);

  console.log('[STATS] Weekly stats aggregated for week of ' + weekStart);
}

async function aggregateMonthlyStats(targetMonth) {
  const month = targetMonth || dayjs().tz(TZ).subtract(1, 'month').format('YYYY-MM');

  const totals = await pool.query(
    `SELECT COALESCE(SUM(usd_value),0) as raised, COUNT(*) as purchases, COUNT(DISTINCT buyer_wallet) as buyers
     FROM purchases WHERE month_gmt4 = $1 AND status = 'confirmed'`, [month]
  );
  const newBuyers = await pool.query(
    `SELECT COUNT(*) as t FROM buyers WHERE to_char(created_at, 'YYYY-MM') = $1`, [month]
  );
  const tokensSold = await pool.query(
    `SELECT COALESCE(SUM(tokens_allocated),0) as t FROM purchases WHERE month_gmt4 = $1 AND status = 'confirmed'`, [month]
  );
  const burned = await pool.query(
    `SELECT COALESCE(SUM(tokens_burned),0) as t FROM burn_log WHERE to_char(created_at, 'YYYY-MM') = $1`, [month]
  );
  const credits = await pool.query(
    `SELECT COALESCE(SUM(amount_usd),0) as t FROM terminal_credits WHERE to_char(created_at, 'YYYY-MM') = $1`, [month]
  );

  await pool.query(`
    INSERT INTO monthly_stats (month_gmt4, total_raised_usd, total_purchases, total_buyers, new_buyers, tokens_sold, tokens_burned, terminal_credits_issued)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (month_gmt4) DO UPDATE SET
      total_raised_usd=$2, total_purchases=$3, total_buyers=$4, new_buyers=$5, tokens_sold=$6, tokens_burned=$7, terminal_credits_issued=$8
  `, [month, totals.rows[0].raised, totals.rows[0].purchases, totals.rows[0].buyers,
      newBuyers.rows[0].t, tokensSold.rows[0].t, burned.rows[0].t, credits.rows[0].t]);

  console.log('[STATS] Monthly stats aggregated for ' + month);
}

module.exports = { aggregateDailyStats, aggregateWeeklyStats, aggregateMonthlyStats };
