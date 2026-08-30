// ══════════════════════════════════════════════════
// src/routes/wallet.js
// Wallet connection, disconnection, and error handling
// NO SIGNATURE REQUIRED — connection IS authentication
// ══════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { createBuyerSession, destroyBuyerSession, buyerAuth } = require('../middleware/buyer-auth');
const { isValidEvmAddress, isValidSolanaAddress } = require('../middleware/validation');
const { lookupIP, getClientIP } = require('../services/geo-service');
const { logAudit } = require('../services/audit-service');

// ═══ WALLET ERRORS — human-readable responses ═══
const WALLET_ERRORS = {
  INVALID_ADDRESS: {
    status: 400,
    code: 'INVALID_ADDRESS',
    message: 'The wallet address is not valid. Please disconnect and reconnect your wallet.',
  },
  SESSION_EXPIRED: {
    status: 401,
    code: 'SESSION_EXPIRED',
    message: 'Your session has expired. Please reconnect your wallet.',
  },
  WALLET_MISMATCH: {
    status: 403,
    code: 'WALLET_MISMATCH',
    message: 'Connected wallet does not match the requested account.',
  },
  CONNECTION_FAILED: {
    status: 500,
    code: 'CONNECTION_FAILED',
    message: 'Unable to establish wallet connection. Please try again.',
  },
  NETWORK_UNSUPPORTED: {
    status: 400,
    code: 'NETWORK_UNSUPPORTED',
    message: 'Please switch your wallet to Ethereum, BSC, or Solana network.',
  },
};

// ═══ POST /api/wallet/connect ═══
// Called when buyer's wallet connects via WalletConnect/Web3Modal
// NO signature — connection IS authentication
router.post('/connect', async (req, res) => {
  try {
    const { wallet_address, chain_id, wallet_type } = req.body;

    // ── Validate address ──
    if (!wallet_address) {
      return res.status(400).json({ success: false, ...WALLET_ERRORS.INVALID_ADDRESS });
    }

    const address = wallet_address.toLowerCase().trim();

    // Check address format
    if (!isValidEvmAddress(address) && !isValidSolanaAddress(address)) {
      return res.status(400).json({ success: false, ...WALLET_ERRORS.INVALID_ADDRESS });
    }

    // ── Check supported network ──
    const supportedChainIds = [
      1,       // Ethereum Mainnet
      56,      // BSC Mainnet
      137,     // Polygon
      42161,   // Arbitrum One
      8453,    // Base
      10,      // Optimism
      // Testnets (remove for production)
      11155111, // Sepolia
      97,      // BSC Testnet
    ];

    if (chain_id && !supportedChainIds.includes(parseInt(chain_id))) {
      return res.status(400).json({
        success: false,
        ...WALLET_ERRORS.NETWORK_UNSUPPORTED,
        supported_networks: ['Ethereum (1)', 'BSC (56)', 'Polygon (137)', 'Arbitrum (42161)', 'Base (8453)'],
        your_chain_id: chain_id,
      });
    }

    // ── Location lookup (analytics only, no blocking) ──
    const clientIP = getClientIP(req);
    const geo = await lookupIP(clientIP);

    // ── Create session (NO SIGNATURE) ──
    const token = await createBuyerSession(address);

    // ── Get or create buyer record with referral code ──
    let referralCode = null;
    let isNewBuyer = false;

    const existing = await pool.query(
      'SELECT referral_code, total_purchases FROM buyers WHERE buyer_wallet = $1',
      [address]
    );

    if (existing.rows.length > 0) {
      referralCode = existing.rows[0].referral_code;
    } else {
      // New buyer — generate referral code immediately at connection
      referralCode = 'FDX-' +
        Math.random().toString(36).substring(2, 6).toUpperCase() + '-' +
        Math.random().toString(36).substring(2, 6).toUpperCase();

      await pool.query(
        `INSERT INTO buyers (buyer_wallet, referral_code, country, country_code, state, city)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (buyer_wallet) DO NOTHING`,
        [address, referralCode,
         geo?.country || null, geo?.country_code || null,
         geo?.state || null, geo?.city || null]
      );
      isNewBuyer = true;
    }

    // ── Check for pending claims ──
    const pendingClaims = await pool.query(
      "SELECT tier_id, total_claimable FROM claims WHERE buyer_wallet = $1 AND status = 'eligible'",
      [address]
    );

    // ── Get buyer's purchase summary ──
    const summary = await pool.query(
      "SELECT COALESCE(SUM(tokens_allocated), 0) as total_tokens, COALESCE(SUM(usd_value), 0) as total_spent, COUNT(*) as purchase_count FROM purchases WHERE buyer_wallet = $1 AND status = 'confirmed'",
      [address]
    );

    // ── Get terminal credits ──
    const credits = await pool.query(
      "SELECT COALESCE(SUM(remaining_amount), 0) as total FROM terminal_credits WHERE wallet = $1 AND status = 'active'",
      [address]
    );

    // ── Log connection ──
    await logAudit('wallet_connected', null, address, null, null, {
      chain_id, wallet_type: wallet_type || 'unknown',
      country: geo?.country || 'unknown', is_new: isNewBuyer,
    }, 'Wallet connected — session created', 'system');

    // ── Return everything the frontend needs ──
    res.json({
      success: true,
      token,
      expires_in: '30 minutes',
      wallet: address,
      referral_code: referralCode,
      is_new_buyer: isNewBuyer,
      summary: {
        total_tokens: parseFloat(summary.rows[0].total_tokens),
        total_spent: parseFloat(summary.rows[0].total_spent),
        purchase_count: parseInt(summary.rows[0].purchase_count),
      },
      terminal_credits: parseFloat(credits.rows[0].total),
      pending_claims: pendingClaims.rows.map(c => ({
        tier: c.tier_id,
        tokens: parseFloat(c.total_claimable),
      })),
    });

  } catch (err) {
    console.error('[WALLET] Connect error:', err.message);
    res.status(500).json({ success: false, ...WALLET_ERRORS.CONNECTION_FAILED, debug: process.env.NODE_ENV === 'development' ? err.message : undefined });
  }
});

// ═══ POST /api/wallet/disconnect ═══
router.post('/disconnect', buyerAuth, (req, res) => {
  destroyBuyerSession(req.buyerWallet);
  res.json({ success: true, message: 'Wallet disconnected. Session destroyed.' });
});

// ═══ GET /api/wallet/session ═══
// Frontend calls this to check if session is still valid
router.get('/session', buyerAuth, (req, res) => {
  res.json({ success: true, wallet: req.buyerWallet, message: 'Session active' });
});

// ═══ POST /api/wallet/refresh ═══
// Frontend calls this to extend the 30-minute timer
router.post('/refresh', buyerAuth, (req, res) => {
  res.json({ success: true, wallet: req.buyerWallet, expires_in: '30 minutes' });
});

module.exports = router;
