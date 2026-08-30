// ══════════════════════════════════════════════════
// src/middleware/validation.js
// Input validation for all endpoints
// ══════════════════════════════════════════════════

// Validate EVM wallet address (0x + 40 hex chars)
function isValidEvmAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

// Validate Solana address (32-44 base58 chars)
function isValidSolanaAddress(address) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}

// Validate Bitcoin address (bc1 bech32 or legacy)
function isValidBtcAddress(address) {
  return /^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,62}$/.test(address);
}

// Validate TRON address (starts with T, 34 characters, base58)
function isValidTronAddress(address) {
  return /^T[a-zA-HJ-NP-Za-km-z1-9]{33}$/.test(address);
}

// Validate wallet address for any chain
function isValidWallet(address, chain) {
  if (!address || typeof address !== 'string') return false;
  if (chain === 'tron') return isValidTronAddress(address);
  if (chain === 'solana') return isValidSolanaAddress(address);
  if (chain === 'bitcoin') return isValidBtcAddress(address);
  return isValidEvmAddress(address); // Default: EVM
}

// Validate positive number
function isPositiveNumber(value) {
  const num = parseFloat(value);
  return !isNaN(num) && num > 0 && isFinite(num);
}

// Sanitize string (prevent SQL injection and XSS)
function sanitizeString(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>'";\/]/g, '').trim().substring(0, 500);
}

// Validate purchase intent
function validatePurchaseIntent(req, res, next) {
  const { buyer_wallet, chain, crypto, usd_amount } = req.body;

  if (!buyer_wallet || !isValidWallet(buyer_wallet, chain)) {
    return res.status(400).json({ success: false, error: 'Invalid wallet address', code: 'INVALID_WALLET' });
  }
  if (!['ethereum', 'bsc', 'solana', 'bitcoin', 'tron', 'arbitrum', 'polygon', 'base'].includes(chain)) {
    return res.status(400).json({ success: false, error: 'Invalid chain', code: 'INVALID_CHAIN' });
  }
  if (!['ETH', 'USDT', 'USDC', 'BNB', 'SOL', 'BTC', 'TRX'].includes(crypto?.toUpperCase())) {
    return res.status(400).json({ success: false, error: 'Invalid currency', code: 'INVALID_CURRENCY' });
  }
  if (!isPositiveNumber(usd_amount) || parseFloat(usd_amount) <= 0) {
    return res.status(400).json({ success: false, error: 'Amount must be greater than $0', code: 'BELOW_MINIMUM' });
  }
  if (parseFloat(usd_amount) > 10000000) {
    return res.status(400).json({ success: false, error: 'Amount too large', code: 'ABOVE_MAXIMUM' });
  }

  // Normalize
  req.body.buyer_wallet = buyer_wallet.toLowerCase();
  req.body.crypto = crypto.toUpperCase();
  req.body.usd_amount = parseFloat(usd_amount);
  next();
}

// Validate referral code format
function isValidReferralCode(code) {
  return /^FDX-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code);
}

// Wallet address middleware for URL params
function validateWalletParam(req, res, next) {
  const wallet = req.params.wallet;
  if (!wallet || (!isValidEvmAddress(wallet) && !isValidSolanaAddress(wallet))) {
    return res.status(400).json({ success: false, error: 'Invalid wallet address', code: 'INVALID_WALLET' });
  }
  req.params.wallet = wallet.toLowerCase();
  next();
}

module.exports = {
  isValidEvmAddress, isValidSolanaAddress, isValidBtcAddress, isValidTronAddress, isValidWallet,
  isPositiveNumber, sanitizeString, validatePurchaseIntent, isValidReferralCode,
  validateWalletParam
};
