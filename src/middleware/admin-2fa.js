// ══════════════════════════════════════════════════
// src/middleware/admin-2fa.js
// Time-based One-Time Password (TOTP) for admin login
// npm install otplib qrcode
// ══════════════════════════════════════════════════

const { authenticator } = require('otplib');
const QRCode = require('qrcode');

// 🔴 Generate this ONCE during first setup, then store in .env
// Run: node -e "const { authenticator } = require('otplib'); console.log(authenticator.generateSecret());"
// Add to .env: ADMIN_2FA_SECRET=🔴_INSERT_GENERATED_SECRET

// FIRST-TIME SETUP: Generate QR code for admin to scan
async function generate2FASetup() {
  const secret = process.env.ADMIN_2FA_SECRET;
  if (!secret) throw new Error('ADMIN_2FA_SECRET not set in .env');

  const otpauth = authenticator.keyuri(
    process.env.ADMIN_USERNAME,
    'FlowDex Admin',
    secret
  );

  // Generate QR code as data URL
  const qrDataUrl = await QRCode.toDataURL(otpauth);
  return { secret, qrDataUrl, manual_entry_key: secret };
}

// VERIFY: Check 2FA code — `secret` is the per-admin_users-row secret for a
// real user login; falls back to the legacy env var for the bootstrap
// login path (no admin_users row to read a secret from).
function verify2FA(token, secret = process.env.ADMIN_2FA_SECRET) {
  if (!secret) return true; // If 2FA not configured, skip (dev mode)
  return authenticator.verify({ token, secret });
}

// Generates a fresh TOTP secret for a new admin user or a 2FA reset —
// same otplib call the original single-admin ADMIN_2FA_SECRET setup
// instructions used, just invoked at runtime instead of once by hand.
function generateTotpSecret() {
  return authenticator.generateSecret();
}

module.exports = { generate2FASetup, verify2FA, generateTotpSecret };
