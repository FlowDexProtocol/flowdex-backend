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

// VERIFY: Check 2FA code on every admin login
function verify2FA(token) {
  const secret = process.env.ADMIN_2FA_SECRET;
  if (!secret) return true; // If 2FA not configured, skip (dev mode)
  return authenticator.verify({ token, secret });
}

module.exports = { generate2FASetup, verify2FA };
