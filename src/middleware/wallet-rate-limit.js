// ══════════════════════════════════════════════════
// src/middleware/wallet-rate-limit.js
// Rate limits authenticated endpoints per wallet address
// ══════════════════════════════════════════════════

const walletRequestCounts = new Map();

function walletRateLimit(maxRequests, windowMs) {
  return (req, res, next) => {
    const wallet = req.buyerWallet || req.params.wallet;
    if (!wallet) return next();

    const key = wallet.toLowerCase();
    const now = Date.now();

    if (!walletRequestCounts.has(key)) {
      walletRequestCounts.set(key, { count: 1, windowStart: now });
      return next();
    }

    const entry = walletRequestCounts.get(key);

    // Reset window if expired
    if (now - entry.windowStart > windowMs) {
      entry.count = 1;
      entry.windowStart = now;
      return next();
    }

    // Check limit
    entry.count++;
    if (entry.count > maxRequests) {
      return res.status(429).json({
        success: false,
        error: 'Too many requests from this wallet. Please wait.',
        code: 'WALLET_RATE_LIMITED',
        retry_after_seconds: Math.ceil((windowMs - (now - entry.windowStart)) / 1000),
      });
    }

    next();
  };
}

// Cleanup old entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of walletRequestCounts.entries()) {
    if (now - entry.windowStart > 600000) { // 10 minutes
      walletRequestCounts.delete(key);
    }
  }
}, 10 * 60 * 1000);

module.exports = { walletRateLimit };
