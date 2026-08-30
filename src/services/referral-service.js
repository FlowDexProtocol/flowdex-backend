// ══════════════════════════════════════════════════
// src/services/referral-service.js
// Complete referral logic: 30% referrer + 15% buyer, 70/30 credit/token split, full burn, no compression.
// ══════════════════════════════════════════════════

const pool = require('../db/pool');
const { logAudit } = require('./audit-service');

const REFERRER_PCT = parseFloat(process.env.REFERRAL_REFERRER_BONUS_PCT || 30) / 100;  // 0.30
const BUYER_PCT = parseFloat(process.env.REFERRAL_BUYER_BONUS_PCT || 15) / 100;        // 0.15
const CREDIT_PCT = parseFloat(process.env.REFERRAL_TERMINAL_CREDIT_PCT || 70) / 100;   // 0.70
const TOKEN_PCT = parseFloat(process.env.REFERRAL_TOKEN_BONUS_PCT || 30) / 100;        // 0.30
const CREDIT_EXPIRY_MONTHS = parseInt(process.env.REFERRAL_CREDIT_EXPIRY_MONTHS || 6);

async function processReferralBonus(client, purchase) {
  if (!purchase.referred_by_code) return;

  // Get referrer wallet from the code
  const referrerResult = await client.query(
    'SELECT buyer_wallet FROM buyers WHERE referral_code = $1', [purchase.referred_by_code]
  );
  if (referrerResult.rows.length === 0) return;
  const referrerWallet = referrerResult.rows[0].buyer_wallet;

  const purchaseUsd = parseFloat(purchase.usd_value);
  const tierPrice = parseFloat(purchase.tier_price);
  const tierId = purchase.tier_at_purchase;

  // ═══ REFERRER BONUS (30%) ═══
  const referrerBonusUsd = purchaseUsd * REFERRER_PCT;                    // $300
  const referrerCreditsUsd = referrerBonusUsd * CREDIT_PCT;               // $210
  const referrerTokenUsd = referrerBonusUsd * TOKEN_PCT;                  // $90
  const referrerTokens = referrerTokenUsd / tierPrice;                    // 90,000
  const referrerBurnTokens = referrerBonusUsd / tierPrice;                // 300,000 (full amount, NO compression)

  // ═══ BUYER BONUS (15%) ═══
  const buyerBonusUsd = purchaseUsd * BUYER_PCT;                          // $150
  const buyerCreditsUsd = buyerBonusUsd * CREDIT_PCT;                     // $105
  const buyerTokenUsd = buyerBonusUsd * TOKEN_PCT;                        // $45
  const buyerTokens = buyerTokenUsd / tierPrice;                          // 45,000
  const buyerBurnTokens = buyerBonusUsd / tierPrice;                      // 150,000 (full amount, NO compression)

  const totalBurned = referrerBurnTokens + buyerBurnTokens;               // 450,000

  const creditExpiresAt = new Date(Date.now() + CREDIT_EXPIRY_MONTHS * 30 * 24 * 60 * 60 * 1000);

  // ═══ INSERT TERMINAL CREDITS ═══
  // Referrer credits
  await client.query(
    `INSERT INTO terminal_credits (wallet, amount_usd, source, source_purchase_id, remaining_amount, expires_at)
     VALUES ($1, $2, 'referral_referrer', $3, $2, $4)`,
    [referrerWallet, referrerCreditsUsd, purchase.id, creditExpiresAt]
  );
  // Buyer credits
  await client.query(
    `INSERT INTO terminal_credits (wallet, amount_usd, source, source_purchase_id, remaining_amount, expires_at)
     VALUES ($1, $2, 'referral_buyer', $3, $2, $4)`,
    [purchase.buyer_wallet, buyerCreditsUsd, purchase.id, creditExpiresAt]
  );

  // ═══ INSERT BONUS TOKEN ALLOCATIONS ═══
  // Referrer tokens
  await client.query(
    `INSERT INTO bonus_allocations (wallet, role, source_purchase_id, bonus_usd_value, bonus_tokens, tier_at_bonus, tier_price, tokens_burned, terminal_credits_usd)
     VALUES ($1, 'referrer', $2, $3, $4, $5, $6, $7, $8)`,
    [referrerWallet, purchase.id, referrerBonusUsd, referrerTokens, tierId, tierPrice, referrerBurnTokens, referrerCreditsUsd]
  );
  // Buyer tokens
  await client.query(
    `INSERT INTO bonus_allocations (wallet, role, source_purchase_id, bonus_usd_value, bonus_tokens, tier_at_bonus, tier_price, tokens_burned, terminal_credits_usd)
     VALUES ($1, 'buyer', $2, $3, $4, $5, $6, $7, $8)`,
    [purchase.buyer_wallet, purchase.id, buyerBonusUsd, buyerTokens, tierId, tierPrice, buyerBurnTokens, buyerCreditsUsd]
  );

  // ═══ LOG BURNS ═══
  await client.query(
    `INSERT INTO burn_log (source, source_id, tokens_burned, burn_value_usd, tier_at_burn, tier_price, reason)
     VALUES ('referral_referrer', $1, $2, $3, $4, $5, 'Referrer bonus burn at full tier price')`,
    [purchase.id, referrerBurnTokens, referrerBonusUsd, tierId, tierPrice]
  );
  await client.query(
    `INSERT INTO burn_log (source, source_id, tokens_burned, burn_value_usd, tier_at_burn, tier_price, reason)
     VALUES ('referral_buyer', $1, $2, $3, $4, $5, 'Buyer bonus burn at full tier price')`,
    [purchase.id, buyerBurnTokens, buyerBonusUsd, tierId, tierPrice]
  );

  // ═══ UPDATE REFERRAL RECORD ═══
  await client.query(
    `UPDATE referrals SET
       has_purchased = true,
       first_purchase_at = COALESCE(first_purchase_at, NOW()),
       total_purchases = total_purchases + 1,
       total_volume_usd = total_volume_usd + $1,
       referrer_bonus_usd = referrer_bonus_usd + $2,
       referrer_terminal_credits = referrer_terminal_credits + $3,
       referrer_bonus_tokens = referrer_bonus_tokens + $4,
       referrer_tokens_burned = referrer_tokens_burned + $5,
       buyer_bonus_usd = buyer_bonus_usd + $6,
       buyer_terminal_credits = buyer_terminal_credits + $7,
       buyer_bonus_tokens = buyer_bonus_tokens + $8,
       buyer_tokens_burned = buyer_tokens_burned + $9,
       status = 'purchased'
     WHERE referred_wallet = $10`,
    [purchaseUsd, referrerBonusUsd, referrerCreditsUsd, referrerTokens, referrerBurnTokens,
     buyerBonusUsd, buyerCreditsUsd, buyerTokens, buyerBurnTokens, purchase.buyer_wallet]
  );

  // ═══ UPDATE REFERRER BUYER PROFILE ═══
  await client.query(
    `UPDATE buyers SET
       total_referral_purchases = total_referral_purchases + 1,
       total_referral_volume_usd = total_referral_volume_usd + $1,
       total_referral_earnings_usd = total_referral_earnings_usd + $2,
       total_referral_earnings_tokens = total_referral_earnings_tokens + $3,
       total_terminal_credits_usd = total_terminal_credits_usd + $4,
       total_bonus_tokens = total_bonus_tokens + $3,
       total_tokens_burned = total_tokens_burned + $5
     WHERE referral_code = $6`,
    [purchaseUsd, referrerBonusUsd, referrerTokens, referrerCreditsUsd, referrerBurnTokens, purchase.referred_by_code]
  );

  // ═══ UPDATE BUYER PROFILE ═══
  await client.query(
    `UPDATE buyers SET
       total_terminal_credits_usd = total_terminal_credits_usd + $1,
       total_bonus_tokens = total_bonus_tokens + $2,
       total_tokens_burned = total_tokens_burned + $3
     WHERE buyer_wallet = $4`,
    [buyerCreditsUsd, buyerTokens, buyerBurnTokens, purchase.buyer_wallet]
  );

  // ═══ NOTIFICATIONS ═══
  await client.query(
    `INSERT INTO notifications (wallet, type, title, message) VALUES ($1, 'referral_bonus', 'Referral Bonus Earned', $2)`,
    [referrerWallet, 'You earned ' + referrerTokens.toFixed(0) + ' bonus $FDP + $' + referrerCreditsUsd.toFixed(2) + ' Terminal Credits from a referral purchase.']
  );

  // ═══ AUDIT LOG ═══
  await logAudit('referral_earned', purchase.id, purchase.buyer_wallet, purchase.tx_hash, null, {
    referrer: referrerWallet,
    referrer_credits: referrerCreditsUsd,
    referrer_tokens: referrerTokens,
    referrer_burned: referrerBurnTokens,
    buyer_credits: buyerCreditsUsd,
    buyer_tokens: buyerTokens,
    buyer_burned: buyerBurnTokens,
    total_burned: totalBurned,
  }, 'Referral bonus processed — no compression', 'system');

  console.log('[REFERRAL] Purchase #' + purchase.id + ': ' + totalBurned.toFixed(0) + ' tokens burned, $' + (referrerCreditsUsd + buyerCreditsUsd).toFixed(2) + ' credits issued');
}

module.exports = { processReferralBonus };
