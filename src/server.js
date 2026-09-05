// ══════════════════════════════════════════════════
// src/server.js
// FlowDex Protocol Backend V2 — main entry point
// ══════════════════════════════════════════════════

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');

const { errorHandler } = require('./middleware/error-handler');

// ── Services (cron targets) ──
// Note: price-service is not on this list — prices are fetched on-demand by
// GET /api/price/:crypto and purchase intents, not on a background cron.
const { processOtcDrip } = require('./services/otc-service');
const { checkWebhookHealthAndAlert, resetDailyCounter } = require('./services/webhook-health');

// ── Jobs ──
const { cleanupExpiredIntents } = require('./jobs/cleanup-intents');
const { checkBtcPayments } = require('./jobs/btc-monitor');
const { checkTronPayments } = require('./jobs/tron-monitor');
const { runReconciliation } = require('./jobs/reconciliation');
const { takeBalanceSnapshot } = require('./jobs/balance-snapshot');
const { aggregateDailyStats, aggregateWeeklyStats, aggregateMonthlyStats } = require('./jobs/stats-aggregator');
const { checkDiskUsage } = require('./jobs/disk-monitor');

// ── Routes ──
const walletRoutes = require('./routes/wallet');
const buyerRoutes = require('./routes/buyers');
const tierRoutes = require('./routes/tiers');
const priceRoutes = require('./routes/prices');
const purchaseRoutes = require('./routes/purchases');
const referralRoutes = require('./routes/referrals');
const claimRoutes = require('./routes/claims');
const statsRoutes = require('./routes/stats');
const webhookRoutes = require('./routes/webhooks');
const adminRoutes = require('./routes/admin');
const publicRoutes = require('./routes/public');
const subscribeRoutes = require('./routes/subscribe');
const { cmsRoutes, cmsAdminRoutes } = require('./routes/cms');
const { adminAuth } = require('./middleware/admin-auth');
const { requireRole } = require('./middleware/require-role');
const { sendDailyAdminDigest } = require('./services/email-service');

const app = express();
const PORT = process.env.PORT || 3000;

// ══ MIDDLEWARE ══
const allowedOrigins = [
  ...(process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(',').map(u => u.trim()) : []),
  ...(process.env.ADMIN_URL ? process.env.ADMIN_URL.split(',').map(u => u.trim()) : []),
  'http://localhost:3000',
  'http://localhost:3001',
].filter(Boolean);

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));
app.options('*', cors());

app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginOpenerPolicy: false,
}));

app.use(express.json({ limit: '1mb' }));

// Public rate limit — 100 requests/minute per IP (scenario 50)
const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Try again in a minute.' },
});
app.use('/api', publicLimiter);

// ══ ROUTES ══
app.use('/api/wallet', walletRoutes);
app.use('/api/buyer', buyerRoutes);
app.use('/api/tiers', tierRoutes);
app.use('/api/price', priceRoutes);
app.use('/api/purchases', purchaseRoutes);
app.use('/api/referral', referralRoutes);
app.use('/api/claims', claimRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/cms', cmsRoutes);
app.use('/api', subscribeRoutes);
app.use('/webhooks', webhookRoutes);
app.use('/admin', adminRoutes);
app.use('/admin/cms', adminAuth, requireRole('editor'), cmsAdminRoutes);

app.get('/health', (req, res) => res.json({ ok: true, env: process.env.NODE_ENV }));

// ══ ERROR HANDLER (must be last) ══
app.use(errorHandler);

// ══ ALL CRON JOBS ══

// Overlap protection: if a job's previous tick hasn't finished, skip the
// current one instead of letting two runs race each other.
const cronRunning = {};
function guardOverlap(key, fn) {
  return async () => {
    if (cronRunning[key]) {
      console.log('[CRON] ' + key + ' still running from a previous tick — skipping.');
      return;
    }
    cronRunning[key] = true;
    try {
      await fn();
    } catch (err) {
      console.error('[CRON] ' + key + ' failed:', err.message);
    } finally {
      cronRunning[key] = false;
    }
  };
}

// OTC drip: every 5 minutes
cron.schedule('*/5 * * * *', () => processOtcDrip());

// Cleanup expired intents: every 5 minutes
cron.schedule('*/5 * * * *', () => cleanupExpiredIntents());

// BTC monitor: every 60 seconds
cron.schedule('*/60 * * * * *', guardOverlap('btcMonitor', checkBtcPayments));

// TRON monitor: every 30 seconds
cron.schedule('*/30 * * * * *', guardOverlap('tronMonitor', checkTronPayments));

// Reconciliation: every 6 hours
cron.schedule('5 */6 * * *', guardOverlap('reconciliation', runReconciliation));

// Balance snapshot: every 6 hours (offset by 30 min)
cron.schedule('35 */6 * * *', guardOverlap('balanceSnapshot', takeBalanceSnapshot));

// Webhook health check: every 5 minutes
cron.schedule('*/5 * * * *', () => checkWebhookHealthAndAlert());

// Daily stats: 00:05 GMT+4 = 20:05 UTC
cron.schedule('5 20 * * *', guardOverlap('dailyStats', aggregateDailyStats));

// Weekly stats: Monday 00:05 GMT+4 = Sunday 20:05 UTC
cron.schedule('5 20 * * 0', guardOverlap('weeklyStats', aggregateWeeklyStats));

// Monthly stats: 1st of month 00:05 GMT+4 = last day 20:05 UTC (approximation — runs at 20:05 UTC daily-checked)
const monthlyStatsGuarded = guardOverlap('monthlyStats', aggregateMonthlyStats);
cron.schedule('5 20 28-31 * *', () => {
  const dayjs = require('dayjs');
  const tomorrow = dayjs().add(1, 'day');
  if (tomorrow.date() === 1) monthlyStatsGuarded();
});

// Daily admin digest email: 08:00 GMT+4 = 04:00 UTC
cron.schedule('0 4 * * *', guardOverlap('dailyAdminDigest', sendDailyAdminDigest));

// Reset webhook counter: midnight UTC
cron.schedule('0 0 * * *', () => resetDailyCounter());

// Disk space check: 3 AM daily
cron.schedule('0 3 * * *', () => checkDiskUsage());

app.listen(PORT, () => {
  console.log('═══ FlowDex Protocol Backend V2 ═══');
  console.log('Listening on port ' + PORT + ' (' + (process.env.NODE_ENV || 'development') + ')');
});

module.exports = app;
