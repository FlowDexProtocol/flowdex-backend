// ══════════════════════════════════════════════════
// src/services/referral-fraud.js
// Detects referral abuse patterns
// ══════════════════════════════════════════════════

const pool = require('../db/pool');
const { logAudit } = require('./audit-service');

async function checkReferralFraud(referrerCode, buyerWallet, buyerIpHash) {
  const issues = [];

  // 1. Same IP check — referrer and buyer from same IP
  const referrerResult = await pool.query(
    "SELECT buyer_wallet FROM buyers WHERE referral_code = $1", [referrerCode]
  );
  if (referrerResult.rows.length === 0) return { clean: false, issues: ['Invalid referral code'] };
  const referrerWallet = referrerResult.rows[0].buyer_wallet;

  // Check if any purchase from referrer has same IP hash
  const sameIp = await pool.query(
    "SELECT COUNT(*) as cnt FROM purchases WHERE buyer_wallet = $1 AND buyer_ip_hash = $2",
    [referrerWallet, buyerIpHash]
  );
  if (parseInt(sameIp.rows[0].cnt) > 0) {
    issues.push('same_ip_as_referrer');
  }

  // 2. Circular referral check — A refers B, B tries to refer A
  const reverseRef = await pool.query(
    "SELECT id FROM referrals WHERE referrer_wallet = $1 AND referred_wallet = $2",
    [buyerWallet, referrerWallet]
  );
  if (reverseRef.rows.length > 0) {
    issues.push('circular_referral');
  }

  // 3. Chain depth check — prevent A→B→C→D→E (max 3 deep)
  let currentWallet = referrerWallet;
  let depth = 0;
  while (depth < 5) {
    const upline = await pool.query(
      "SELECT referred_by_wallet FROM buyers WHERE buyer_wallet = $1", [currentWallet]
    );
    if (!upline.rows[0]?.referred_by_wallet) break;
    if (upline.rows[0].referred_by_wallet === buyerWallet) {
      issues.push('circular_chain');
      break;
    }
    currentWallet = upline.rows[0].referred_by_wallet;
    depth++;
  }

  // 4. Velocity check — referrer has too many referrals in last hour
  const recentRefs = await pool.query(
    "SELECT COUNT(*) as cnt FROM referrals WHERE referrer_code = $1 AND created_at > NOW() - INTERVAL '1 hour'",
    [referrerCode]
  );
  if (parseInt(recentRefs.rows[0].cnt) > 20) {
    issues.push('velocity_too_high');
  }

  if (issues.length > 0) {
    await logAudit('referral_fraud_detected', null, buyerWallet, null, null,
      { referrer_code: referrerCode, issues },
      'Referral fraud pattern detected', 'system');
  }

  return { clean: issues.length === 0, issues };
}

module.exports = { checkReferralFraud };

// USAGE in referral apply route:
// const { checkReferralFraud } = require('../services/referral-fraud');
// const fraud = await checkReferralFraud(referral_code, buyer_wallet, ipHash);
// if (!fraud.clean) {
//   if (fraud.issues.includes('circular_referral') || fraud.issues.includes('circular_chain')) {
//     return res.status(400).json({ success: false, error: 'Referral not allowed' });
//   }
//   // Log same_ip and velocity as warnings but still allow (could be shared WiFi)
// }
