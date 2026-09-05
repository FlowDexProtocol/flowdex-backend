// ══════════════════════════════════════════════════
// src/middleware/buyer-auth.js
// Buyer session management — wallet connection = login
// ══════════════════════════════════════════════════

const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

const SESSION_TTL_MINUTES = 20;
const SESSION_TTL_MS = SESSION_TTL_MINUTES * 60 * 1000;
const SESSION_TTL_SECONDS = SESSION_TTL_MINUTES * 60;

// Active sessions stored in memory (or Redis for production)
const activeSessions = new Map();

// Generate session when wallet connects
async function createBuyerSession(walletAddress) {
  const token = jwt.sign(
    { wallet: walletAddress.toLowerCase(), type: 'buyer' },
    process.env.JWT_SECRET,
    { expiresIn: SESSION_TTL_MINUTES + 'm' }
  );

  activeSessions.set(walletAddress.toLowerCase(), {
    token,
    connectedAt: new Date(),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    lastActivity: new Date(),
  });

  return token;
}

// Destroy session on disconnect
function destroyBuyerSession(walletAddress) {
  activeSessions.delete(walletAddress.toLowerCase());
}

// Refresh session timer on activity
function refreshSession(walletAddress) {
  const session = activeSessions.get(walletAddress.toLowerCase());
  if (session) {
    session.lastActivity = new Date();
    session.expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  }
}

// Middleware: verify buyer is connected
function buyerAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, error: 'Wallet not connected', code: 'NO_SESSION' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.type !== 'buyer') return res.status(401).json({ success: false, error: 'Invalid session', code: 'INVALID_SESSION' });

    // Verify wallet in URL matches wallet in token
    const urlWallet = req.params.wallet?.toLowerCase();
    if (urlWallet && urlWallet !== decoded.wallet) {
      return res.status(403).json({ success: false, error: 'Wallet mismatch', code: 'WALLET_MISMATCH' });
    }

    // Check session is still active
    const session = activeSessions.get(decoded.wallet);
    if (!session) return res.status(401).json({ success: false, error: 'Session expired. Reconnect wallet.', code: 'SESSION_EXPIRED' });

    // Check inactivity timeout
    const inactiveMs = Date.now() - session.lastActivity.getTime();
    if (inactiveMs > SESSION_TTL_MS) {
      activeSessions.delete(decoded.wallet);
      return res.status(401).json({ success: false, error: 'Session timed out. Reconnect wallet.', code: 'SESSION_TIMEOUT' });
    }

    // Refresh timer
    refreshSession(decoded.wallet);
    req.buyerWallet = decoded.wallet;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Invalid or expired token', code: 'TOKEN_INVALID' });
  }
}

// Cleanup expired sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [wallet, session] of activeSessions.entries()) {
    if (now - session.lastActivity.getTime() > SESSION_TTL_MS) {
      activeSessions.delete(wallet);
    }
  }
}, 5 * 60 * 1000);

module.exports = { createBuyerSession, destroyBuyerSession, buyerAuth, SESSION_TTL_SECONDS };
