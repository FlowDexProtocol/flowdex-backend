// ══════════════════════════════════════════════════
// src/middleware/admin-login-rate-limit.js
// Rate limits POST /admin/login per IP (same in-memory pattern as
// wallet-rate-limit.js) — 5 failed attempts per 15-minute window get a
// soft throttle; 10 cumulative failed attempts trigger a hard 30-minute
// block regardless of window. A successful login clears the slate.
// ══════════════════════════════════════════════════

const { getClientIP } = require('../services/geo-service');

const WINDOW_MS = 15 * 60 * 1000;
const WINDOW_MAX = 5;
const HARD_BLOCK_THRESHOLD = 10;
const HARD_BLOCK_MS = 30 * 60 * 1000;

const attemptsByIP = new Map();

function loginRateLimit(req, res, next) {
  const ip = getClientIP(req);
  const now = Date.now();

  let entry = attemptsByIP.get(ip);
  if (!entry) {
    entry = { failTimestamps: [], totalFails: 0, blockedUntil: null };
    attemptsByIP.set(ip, entry);
  }

  if (entry.blockedUntil && entry.blockedUntil > now) {
    const minutesLeft = Math.ceil((entry.blockedUntil - now) / 60000);
    return res.status(429).json({ success: false, error: `Too many login attempts. Try again in ${minutesLeft} minutes.` });
  }

  // Prune failures outside the rolling window.
  entry.failTimestamps = entry.failTimestamps.filter((t) => now - t < WINDOW_MS);

  if (entry.failTimestamps.length >= WINDOW_MAX) {
    const oldest = entry.failTimestamps[0];
    const minutesLeft = Math.max(1, Math.ceil((WINDOW_MS - (now - oldest)) / 60000));
    return res.status(429).json({ success: false, error: `Too many login attempts. Try again in ${minutesLeft} minutes.` });
  }

  req._loginRateLimitEntry = entry;
  next();
}

function recordFailedLogin(req) {
  const entry = req._loginRateLimitEntry;
  if (!entry) return;
  const now = Date.now();
  entry.failTimestamps.push(now);
  entry.totalFails++;
  if (entry.totalFails >= HARD_BLOCK_THRESHOLD) {
    entry.blockedUntil = now + HARD_BLOCK_MS;
  }
}

function recordSuccessfulLogin(req) {
  const entry = req._loginRateLimitEntry;
  if (!entry) return;
  entry.failTimestamps = [];
  entry.totalFails = 0;
  entry.blockedUntil = null;
}

// Cleanup idle entries every 10 minutes.
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of attemptsByIP.entries()) {
    const idle = !entry.blockedUntil && entry.failTimestamps.length === 0;
    const blockExpired = entry.blockedUntil && entry.blockedUntil < now;
    if (idle || blockExpired) attemptsByIP.delete(ip);
  }
}, 10 * 60 * 1000);

module.exports = { loginRateLimit, recordFailedLogin, recordSuccessfulLogin };
