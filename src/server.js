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
const { refreshPriceCache } = require('./services/price-service');
const { processOtcDrip } = require('./services/otc-service');
const { checkWebhookHealthAndAlert, resetDailyCounter } = require('./services/webhook-health');

// ── Jobs ──
const { cleanupExpiredIntents } = require('./jobs/cleanup-intents');
const { checkBtcPayments } = require('./jobs/btc-monitor');
const { checkTronPayments } = require('./jobs/tron-monitor');
const { runReconciliation } = require('./jobs/reconciliation');
const { takeBalanceSnapshot } = require('./jobs/balance-snapshot');
const { aggregateDailyStats, aggregateWeeklyStats, aggregateMonthlyStats } = require('./jobs/stats-aggregator');

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
app.use('/webhooks', webhookRoutes);
app.use('/admin', adminRoutes);

app.get('/health', (req, res) => res.json({ ok: true, env: process.env.NODE_ENV }));

// ══ ERROR HANDLER (must be last) ══
app.use(errorHandler);

// ══ ALL CRON JOBS ══

// Price cache: every 25 seconds
cron.schedule('*/25 * * * * *', () => refreshPriceCache());

// OTC drip: every 5 minutes
cron.schedule('*/5 * * * *', () => processOtcDrip());

// Cleanup expired intents: every 5 minutes
cron.schedule('*/5 * * * *', () => cleanupExpiredIntents());

// BTC monitor: every 60 seconds
cron.schedule('*/60 * * * * *', () => checkBtcPayments());

// TRON monitor: every 30 seconds
cron.schedule('*/30 * * * * *', () => checkTronPayments());

// Reconciliation: every 6 hours
cron.schedule('5 */6 * * *', () => runReconciliation());

// Balance snapshot: every 6 hours (offset by 30 min)
cron.schedule('35 */6 * * *', () => takeBalanceSnapshot());

// Webhook health check: every 5 minutes
cron.schedule('*/5 * * * *', () => checkWebhookHealthAndAlert());

// Daily stats: 00:05 GMT+4 = 20:05 UTC
cron.schedule('5 20 * * *', () => aggregateDailyStats());

// Weekly stats: Monday 00:05 GMT+4 = Sunday 20:05 UTC
cron.schedule('5 20 * * 0', () => aggregateWeeklyStats());

// Monthly stats: 1st of month 00:05 GMT+4 = last day 20:05 UTC (approximation — runs at 20:05 UTC daily-checked)
cron.schedule('5 20 28-31 * *', () => {
  const dayjs = require('dayjs');
  const tomorrow = dayjs().add(1, 'day');
  if (tomorrow.date() === 1) aggregateMonthlyStats();
});

// Reset webhook counter: midnight UTC
cron.schedule('0 0 * * *', () => resetDailyCounter());

app.listen(PORT, () => {
  console.log('═══ FlowDex Protocol Backend V2 ═══');
  console.log('Listening on port ' + PORT + ' (' + (process.env.NODE_ENV || 'development') + ')');
  refreshPriceCache(); // warm the price cache on boot
});

module.exports = app;
