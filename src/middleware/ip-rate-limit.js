// ══════════════════════════════════════════════════
// src/middleware/ip-rate-limit.js
// Simple per-IP rate limiter — same fixed-window pattern as
// wallet-rate-limit.js, keyed by client IP instead of wallet address.
// ══════════════════════════════════════════════════

const { getClientIP } = require('../services/geo-service');

const ipRequestCounts = new Map();

function ipRateLimit(maxRequests, windowMs) {
  return (req, res, next) => {
    const ip = getClientIP(req);
    const now = Date.now();

    if (!ipRequestCounts.has(ip)) {
      ipRequestCounts.set(ip, { count: 1, windowStart: now });
      return next();
    }

    const entry = ipRequestCounts.get(ip);

    if (now - entry.windowStart > windowMs) {
      entry.count = 1;
      entry.windowStart = now;
      return next();
    }

    entry.count++;
    if (entry.count > maxRequests) {
      return res.status(429).json({
        success: false,
        error: 'Too many requests. Please try again later.',
        retry_after_seconds: Math.ceil((windowMs - (now - entry.windowStart)) / 1000),
      });
    }

    next();
  };
}

// Cleanup old entries every 10 minutes.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of ipRequestCounts.entries()) {
    if (now - entry.windowStart > 60 * 60 * 1000) {
      ipRequestCounts.delete(key);
    }
  }
}, 10 * 60 * 1000);

module.exports = { ipRateLimit };
