// ══════════════════════════════════════════════════
// src/services/payment-service.js
// 7-step payment processing — called by every chain monitor
// (Alchemy/Helius webhooks, btc-monitor, tron-monitor, payment-recovery)
//
// STEP 1: Idempotency check       — tx_hash + chain is the unique compound key (rule #6)
// STEP 2: Lock active tier        — SELECT ... FOR UPDATE prevents concurrent overfill (MISSING 8)
// STEP 3: Price conversion        — stablecoin peg / known token cache / unknown token lookup
// STEP 4: Match purchase intent   — locks in intent price, flags over/underpayment
// STEP 5: Supply + tier cap guard — hard stop at 2.25B presale allocation
// STEP 6: Record + allocate       — insert/confirm purchase, update tier + buyer totals
// STEP 7: Referral + notify + alert
// ══════════════════════════════════════════════════

const pool = require('../db/pool');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');
const isoWeek = require('dayjs/plugin/isoWeek');
dayjs.extend(utc);
dayjs.extend(tz);
dayjs.extend(isoWeek);

const { getPrice, fetchPriceByContract } = require('./price-service');
const { canAllocate } = require('./supply-service');
const { processReferralBonus } = require('./referral-service');
const { generateClaimsForTier } = require('./claims-service');
const { logAudit } = require('./audit-service');
const { alertLargePurchase, alertTierNearlyFull, alertTierAdvanced, alertUnknownToken, alertSupplyLow, alertLatePayment, alertPurchaseFlagged } = require('./alert-service');
const { announcePurchase } = require('./announce-service');
const { sendPurchaseConfirmation, sendReferralNotification, sendLargePurchaseAlert } = require('./email-service');

const TZ = process.env.TIMEZONE || 'Asia/Dubai';

const NETWORK_NAMES = {
  ethereum: 'Ethereum Mainnet',
  bsc: 'BNB Smart Chain',
  solana: 'Solana',
  bitcoin: 'Bitcoin',
  tron: 'TRON',
  arbitrum: 'Arbitrum One',
  polygon: 'Polygon',
  base: 'Base',
  optimism: 'Optimism',
};

const CONFIRMATIONS_REQUIRED = {
  ethereum: 6,
  bsc: 20,
  solana: 1,
  bitcoin: 3,
  tron: 19,
  arbitrum: 6,
  polygon: 6,
  base: 6,
  optimism: 6,
};

function gmtDates() {
  const now = dayjs().tz(TZ);
  return {
    dayGmt4: now.format('YYYY-MM-DD'),
    weekGmt4: now.startOf('isoWeek').format('YYYY-MM-DD'),
    monthGmt4: now.format('YYYY-MM'),
  };
}

// ══════════════════════════════════════════════════
// Main entry point — called by webhooks + monitors
// ══════════════════════════════════════════════════
async function processPayment({ senderWallet, amount, currency, chain, txHash, tokenName, contractAddress, isKnownToken }) {
  const buyerWallet = senderWallet.toLowerCase();
  const { dayGmt4, weekGmt4, monthGmt4 } = gmtDates();
  const networkName = NETWORK_NAMES[chain] || chain;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── STEP 1: IDEMPOTENCY — tx_hash + chain is the unique compound key ──
    const existing = await client.query(
      'SELECT id FROM purchases WHERE tx_hash = $1 AND chain = $2', [txHash, chain]
    );
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return { success: true, alreadyProcessed: true, purchaseId: existing.rows[0].id };
    }

    // ── STEP 2: LOCK ACTIVE TIER (prevents concurrent tier overfill) ──
    const tierResult = await client.query('SELECT * FROM tiers WHERE is_active = true LIMIT 1 FOR UPDATE');
    if (tierResult.rows.length === 0) {
      // Presale complete — no active tier. Record but don't allocate.
      await client.query(`
        INSERT INTO purchases (buyer_wallet, tx_hash, chain, network_name, crypto_currency, crypto_amount,
          usd_value, price_at_purchase, tokens_allocated, status, payment_match_status, token_name,
          contract_address, is_known_token, created_at, day_gmt4, week_gmt4, month_gmt4)
        VALUES ($1,$2,$3,$4,$5,$6,0,0,0,'presale_complete','presale_complete',$7,$8,$9,NOW(),$10,$11,$12)
      `, [buyerWallet, txHash, chain, networkName, currency, amount, tokenName || currency, contractAddress || null,
          isKnownToken !== false, dayGmt4, weekGmt4, monthGmt4]);
      await logAudit('purchase_flagged', null, buyerWallet, txHash, null,
        { reason: 'presale_complete' }, 'Payment received after presale ended', 'system');
      await client.query('COMMIT');
      return { success: true, flagged: 'presale_complete' };
    }
    const tier = tierResult.rows[0];

    // ── STEP 3: PRICE CONVERSION ──
    let usdPrice;
    let priceSource = 'coinmarketcap';

    if (['USDT', 'USDC', 'BUSD', 'DAI'].includes(currency.toUpperCase())) {
      usdPrice = 1.0;
      priceSource = 'stablecoin_peg';
    } else if (isKnownToken !== false) {
      const priceData = await getPrice(currency);
      usdPrice = priceData ? parseFloat(priceData.usd_price) : null;
    } else {
      try {
        const priceData = await getPrice(currency);
        if (priceData) {
          usdPrice = parseFloat(priceData.usd_price);
          priceSource = 'coinmarketcap_symbol_match';
        } else {
          usdPrice = await fetchPriceByContract(contractAddress, chain);
          priceSource = usdPrice ? 'coinmarketcap_contract' : 'unknown';
        }
      } catch (err) {
        usdPrice = null;
        priceSource = 'unknown';
      }
    }

    if (!usdPrice || usdPrice <= 0) {
      // Unknown token, no price found — record and flag for admin pricing
      const insertResult = await client.query(`
        INSERT INTO purchases (
          buyer_wallet, tx_hash, chain, network_name, crypto_currency,
          crypto_amount, usd_value, price_at_purchase, price_source,
          tier_at_purchase, tier_name, tier_price, tokens_allocated,
          status, payment_match_status, token_name, contract_address, is_known_token,
          webhook_received_at, created_at, day_gmt4, week_gmt4, month_gmt4
        ) VALUES (
          $1, $2, $3, $4, $5, $6, 0, 0, 'unknown',
          $7, $8, $9, 0,
          'needs_pricing', 'unknown_token', $10, $11, false,
          NOW(), NOW(), $12, $13, $14
        ) RETURNING id
      `, [buyerWallet, txHash, chain, networkName, currency,
          amount, tier.id, tier.name, tier.price, tokenName || currency, contractAddress || null,
          dayGmt4, weekGmt4, monthGmt4]);

      await logAudit('purchase_created', insertResult.rows[0].id, buyerWallet, txHash,
        null, { currency, amount, status: 'needs_pricing', reason: 'Unknown token — no price available' },
        'Unknown token received — admin must set USD value', 'system');

      await client.query('COMMIT');

      await alertUnknownToken(currency, tokenName, amount, contractAddress, chain, buyerWallet);

      return { success: true, purchaseId: insertResult.rows[0].id, needsPricing: true };
    }

    const usdValue = amount * usdPrice;

    // ── STEP 4: MATCH AGAINST OPEN PURCHASE INTENT (price lock + over/underpayment) ──
    // Also matches an intent that cleanup-intents.js has already flipped to
    // 'expired' (its 15-minute price lock passed before payment arrived) —
    // a buyer who's a few minutes late must never be repriced at the
    // confirmation-time market price. Bounded to intents from the last 24
    // hours so a stray payment can't attach itself to a long-abandoned one.
    // (There's no per-buyer receiving address to match against for EVM
    // chains — every buyer shares the same env-configured address — so
    // buyer_wallet, the actual payment sender, is the correct match key.)
    const intentResult = await client.query(
      `SELECT * FROM purchases WHERE buyer_wallet = $1 AND chain = $2 AND crypto_currency = $3
         AND status IN ('intent', 'expired') AND created_at > NOW() - INTERVAL '24 hours'
         ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [buyerWallet, chain, currency]
    );
    const intent = intentResult.rows[0] || null;

    let matchStatus = 'exact';
    let finalUsdValue = usdValue;
    let finalPrice = usdPrice;
    let finalPriceSource = priceSource;
    let isLatePayment = false;

    if (intent) {
      const lockActive = intent.price_lock_status === 'active'
        && new Date(intent.price_lock_expires_at).getTime() > Date.now();

      // Whether the lock is still active or already expired, an intent
      // match always honors its ORIGINAL locked price — never the
      // (possibly worse) price at confirmation time.
      finalPrice = parseFloat(intent.price_at_purchase);
      finalUsdValue = amount * finalPrice;
      finalPriceSource = intent.price_source;

      if (!lockActive) {
        isLatePayment = true;
      }

      const expectedCrypto = parseFloat(intent.crypto_amount);
      if (expectedCrypto > 0) {
        if (amount > expectedCrypto * 1.0001) matchStatus = 'overpayment';
        else if (amount < expectedCrypto * 0.9999) matchStatus = 'underpayment';
      }
      if (isLatePayment) matchStatus = 'late_payment';
    }

    // ── STEP 5: SPLIT ACROSS TIER BOUNDARIES ──
    //
    // A payment larger than the room left in the active tier fills that tier
    // to its cap and buys the remainder at the next tier's price, cascading
    // as far as it needs to. Every tier it touches is locked FOR UPDATE in
    // ascending id order, which is also the order the active-tier lock above
    // took, so two concurrent payments can never deadlock against each other.
    //
    // The buyer is never repriced downward for the part that fit: the first
    // segment keeps the tier that was live when they paid.
    const segments = [];
    let remainingUsd = finalUsdValue;
    let cursor = tier;

    while (remainingUsd > 0.01 && cursor) {
      const room = parseFloat(cursor.hard_cap_usd) - parseFloat(cursor.total_raised_usd);
      const take = Math.min(remainingUsd, Math.max(room, 0));

      if (take > 0.0001) {
        segments.push({
          tier: cursor,
          usd: take,
          tokens: take / parseFloat(cursor.price),
        });
        remainingUsd -= take;
      }

      if (remainingUsd > 0.01) {
        const nextId = cursor.id + 1;
        // 20 seeded tiers (src/db/seed-tiers.js). Past the last one there is
        // nothing left to sell, and the leftover is handled below.
        if (nextId > 20) { cursor = null; break; }
        const nextRow = await client.query('SELECT * FROM tiers WHERE id = $1 FOR UPDATE', [nextId]);
        cursor = nextRow.rows[0] || null;
      } else {
        cursor = null;
      }
    }

    const tokensAllocated = segments.reduce((sum, seg) => sum + seg.tokens, 0);

    // ── SUPPLY GUARD ──
    //
    // Still a hard stop. Unallocatable money is flagged whole rather than
    // part-credited: a purchase that is half allocated and half not is far
    // harder to reason about afterwards than one that is cleanly held for
    // review. remainingUsd above zero means the presale ran out of tiers
    // mid-payment, which is the same situation.
    const supplyCheck = await canAllocate(tokensAllocated);
    const ranOutOfTiers = remainingUsd > 0.01;

    if (!supplyCheck.allowed || ranOutOfTiers || segments.length === 0) {
      const reason = !supplyCheck.allowed ? 'supply_exhausted' : 'tier_cap_exceeded';
      const purchaseInsert = await client.query(`
        INSERT INTO purchases (buyer_wallet, tx_hash, chain, network_name, crypto_currency, crypto_amount,
          usd_value, price_at_purchase, price_source, tier_at_purchase, tier_name, tier_price, tokens_allocated,
          status, payment_match_status, token_name, contract_address, is_known_token,
          webhook_received_at, created_at, day_gmt4, week_gmt4, month_gmt4)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'flagged',$14,$15,$16,$17,NOW(),NOW(),$18,$19,$20)
        RETURNING id
      `, [buyerWallet, txHash, chain, networkName, currency, amount, finalUsdValue, finalPrice, finalPriceSource,
          tier.id, tier.name, tier.price, tokensAllocated, reason, tokenName || currency, contractAddress || null,
          isKnownToken !== false, dayGmt4, weekGmt4, monthGmt4]);

      await logAudit('purchase_flagged', purchaseInsert.rows[0].id, buyerWallet, txHash,
        null, { reason, requested_tokens: tokensAllocated, remaining_supply: supplyCheck.remaining },
        'Payment received but ' + reason + ' — admin review required', 'system');

      // The buyer's money is in the wallet and their tokens are not. They
      // find out here rather than by noticing nothing happened.
      await client.query(
        `INSERT INTO notifications (wallet, type, title, message) VALUES ($1, 'purchase_flagged', 'Purchase Under Review', $2)`,
        [buyerWallet, 'Your payment was received and is being reviewed before tokens are allocated. '
          + 'This is normally resolved within a few hours and no action is needed from you.']
      );

      await client.query('COMMIT');

      // Alerts after COMMIT: the purchase is already durable, so a failing
      // alert can never roll one back.
      //
      // This used to fire only for exhausted supply, which meant a payment
      // held for any other reason was recorded and never mentioned to
      // anyone. Every held payment now raises one.
      if (!supplyCheck.allowed) {
        await alertSupplyLow(supplyCheck.remaining, '100+');
      }
      await alertPurchaseFlagged(purchaseInsert.rows[0].id, buyerWallet, finalUsdValue, reason, txHash);

      return { success: true, purchaseId: purchaseInsert.rows[0].id, flagged: reason };
    }

    // ── STEP 6: RECORD + ALLOCATE ──
    //
    // entryTier is the tier the buyer actually entered at. Normally that is
    // the tier that was active, but a tier sitting exactly at its cap while
    // still flagged active contributes no segment, and the entry is then the
    // tier after it.
    const entryTier = segments[0].tier;

    let purchaseId;
    if (intent) {
      await client.query(`
        UPDATE purchases SET
          crypto_amount = $1, usd_value = $2, price_at_purchase = $3, price_source = $4,
          tokens_allocated = $5, status = 'confirmed', payment_match_status = $6,
          token_name = $7, contract_address = $8, is_known_token = $9,
          tier_at_purchase = $12, tier_name = $13, tier_price = $14,
          webhook_received_at = NOW(), confirmed_at = NOW(), tx_hash = $10
        WHERE id = $11
      `, [amount, finalUsdValue, finalPrice, finalPriceSource, tokensAllocated, matchStatus,
          tokenName || currency, contractAddress || null, isKnownToken !== false, txHash, intent.id,
          entryTier.id, entryTier.name, entryTier.price]);
      purchaseId = intent.id;
    } else {
      const insertResult = await client.query(`
        INSERT INTO purchases (buyer_wallet, tx_hash, chain, network_name, crypto_currency, crypto_amount,
          usd_value, price_at_purchase, price_source, tier_at_purchase, tier_name, tier_price, tokens_allocated,
          status, payment_match_status, token_name, contract_address, is_known_token,
          webhook_received_at, confirmed_at, created_at, day_gmt4, week_gmt4, month_gmt4)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'confirmed',$14,$15,$16,$17,NOW(),NOW(),NOW(),$18,$19,$20)
        RETURNING id
      `, [buyerWallet, txHash, chain, networkName, currency, amount, finalUsdValue, finalPrice, finalPriceSource,
          entryTier.id, entryTier.name, entryTier.price, tokensAllocated, matchStatus, tokenName || currency, contractAddress || null,
          isKnownToken !== false, dayGmt4, weekGmt4, monthGmt4]);
      purchaseId = insertResult.rows[0].id;
    }

    // Ensure buyer record exists (payment may arrive before /api/wallet/connect)
    const refCode = 'FDX-' + Math.random().toString(36).substring(2,6).toUpperCase() + '-' + Math.random().toString(36).substring(2,6).toUpperCase();
    await client.query(
      `INSERT INTO buyers (buyer_wallet, referral_code) VALUES ($1, $2) ON CONFLICT (buyer_wallet) DO NOTHING`,
      [buyerWallet, refCode]
    );

    await client.query(
      `UPDATE buyers SET total_purchases = total_purchases + 1, total_usd_spent = total_usd_spent + $1,
         total_tokens = total_tokens + $2, updated_at = NOW() WHERE buyer_wallet = $3`,
      [finalUsdValue, tokensAllocated, buyerWallet]
    );

    // Each tier is credited only its own segment, and the breakdown is
    // written alongside. Claim generation reads that breakdown rather than
    // purchases.tier_at_purchase, so a buyer who crossed a boundary gets a
    // claim in each tier they bought into, on that tier's vesting clock.
    for (const seg of segments) {
      await client.query(
        'UPDATE tiers SET total_raised_usd = total_raised_usd + $1 WHERE id = $2',
        [seg.usd, seg.tier.id]
      );
      await client.query(
        `INSERT INTO purchase_tier_allocations (purchase_id, tier_id, tier_name, tier_price, usd_amount, tokens)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (purchase_id, tier_id) DO NOTHING`,
        [purchaseId, seg.tier.id, seg.tier.name, seg.tier.price, seg.usd, seg.tokens]
      );
    }

    await client.query(
      `INSERT INTO notifications (wallet, type, title, message) VALUES ($1, 'purchase_confirmed', 'Purchase Confirmed', $2)`,
      [buyerWallet, 'Your purchase of ' + tokensAllocated.toFixed(0) + ' FDP has been confirmed.']
    );

    // ── STEP 7: REFERRAL BONUS ──
    const purchaseRow = await client.query('SELECT * FROM purchases WHERE id = $1', [purchaseId]);
    const purchase = purchaseRow.rows[0];

    if (!intent || !intent.referred_by_code) {
      // Attach referral code if buyer has one on file and hasn't purchased before
      const buyerRow = await client.query('SELECT referred_by_code FROM buyers WHERE buyer_wallet = $1', [buyerWallet]);
      if (buyerRow.rows[0]?.referred_by_code) {
        purchase.referred_by_code = buyerRow.rows[0].referred_by_code;
        await client.query('UPDATE purchases SET referred_by_code = $1 WHERE id = $2', [purchase.referred_by_code, purchaseId]);
      }
    }
    if (purchase.referred_by_code) {
      await processReferralBonus(client, purchase);
    }

    await logAudit('purchase_confirmed', purchaseId, buyerWallet, txHash,
      null, { usd_value: finalUsdValue, tokens: tokensAllocated, tier: tier.id, match_status: matchStatus },
      'Payment confirmed and allocated', 'system');

    if (isLatePayment) {
      await logAudit('late_payment_matched', purchaseId, buyerWallet, txHash,
        { intent_id: intent.id, price_lock_expires_at: intent.price_lock_expires_at },
        { locked_price: finalPrice, usd_value: finalUsdValue },
        'Late payment received for expired intent #' + intent.id, 'system');
    }

    await client.query('COMMIT');

    // ── Post-commit alerts (tier progress, tier advance, large purchase) ──
    if (isLatePayment) {
      await alertLatePayment(finalUsdValue, buyerWallet, intent.id);
    }

    if (finalUsdValue > 10000) {
      await alertLargePurchase(buyerWallet, finalUsdValue, tokensAllocated);
    }

    // ── Public channel announcement ──
    // Deliberately after COMMIT and outside the transaction: the purchase is
    // already durable, so a Telegram failure can never roll one back. The
    // service no-ops unless PUBLIC_ANNOUNCE_ENABLED is 'true'.
    try {
      await announcePurchase({
        wallet: buyerWallet,
        cryptoAmount: amount,
        currency,
        usdValue: finalUsdValue,
        tokens: tokensAllocated,
        // entryTier.price is the FDP price of the tier, e.g. 0.0005. Not
        // finalPrice, which is the locked USD price of the coin they sent,
        // e.g. 2415.33 for ETH. Passing that printed the coin price as the
        // tier price in the channel.
        //
        // A purchase that crossed a boundary is announced at the tier it
        // entered: that is the price the buyer saw when they clicked buy.
        tierName: entryTier.name,
        tierPrice: entryTier.price,
      });
    } catch (err) {
      console.error('[ANNOUNCE] Purchase announcement failed:', err.message);
    }

    // ── Post-commit emails — never allowed to affect the purchase result ──
    try {
      await sendPurchaseConfirmation(purchase, tier);
      if (purchase.referred_by_code) {
        const referrerResult = await pool.query(
          'SELECT buyer_wallet FROM buyers WHERE referral_code = $1', [purchase.referred_by_code]
        );
        const referrerWallet = referrerResult.rows[0]?.buyer_wallet;
        if (referrerWallet) await sendReferralNotification(referrerWallet, purchase);
      }
      if (finalUsdValue > 10000) {
        await sendLargePurchaseAlert(purchase);
      }
    } catch (emailErr) {
      console.error('[EMAIL] Post-purchase email dispatch failed:', emailErr.message);
    }

    // A split purchase can fill more than one tier at once, so every tier it
    // touched is checked, in ascending order. Only the last segment's tier can
    // be left partly full, which is why the nearly-full alert can only ever
    // apply to that one.
    //
    // generateClaimsForTier opens its own transaction, so this runs after the
    // COMMIT above — calling it while still holding the tier rows FOR UPDATE
    // would deadlock against itself.
    for (const seg of segments) {
      const updatedTier = await pool.query('SELECT * FROM tiers WHERE id = $1', [seg.tier.id]);
      const t = updatedTier.rows[0];
      if (!t) continue;
      const pctFull = (parseFloat(t.total_raised_usd) / parseFloat(t.hard_cap_usd)) * 100;

      if (pctFull >= 90 && pctFull < 100) {
        await alertTierNearlyFull(seg.tier.id, pctFull.toFixed(1));
        continue;
      }

      if (parseFloat(t.total_raised_usd) >= parseFloat(t.hard_cap_usd)) {
        await pool.query('UPDATE tiers SET is_active = false, closed_at = NOW() WHERE id = $1', [seg.tier.id]);
        const nextId = seg.tier.id + 1;
        let advancedTo = null;
        // 20 seeded tiers (src/db/seed-tiers.js) — keep this in sync with the
        // highest tier id there, or the presale silently stops advancing once
        // the last tier fills and no tier is ever left active.
        if (nextId <= 20) {
          await pool.query('UPDATE tiers SET is_active = true, opened_at = NOW() WHERE id = $1', [nextId]);
          advancedTo = nextId;
        }
        await generateClaimsForTier(seg.tier.id);
        await logAudit('tier_advanced', null, null, null, { tier: seg.tier.id }, { tier: advancedTo },
          'Tier filled — advanced to next tier', 'system');
        await alertTierAdvanced(seg.tier.id, advancedTo);
      }
    }

    return { success: true, purchaseId, tokensAllocated, usdValue: finalUsdValue, matchStatus };

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[PAYMENT] Processing failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

// ══════════════════════════════════════════════════
// confirmPayment — finalizes a 'needs_pricing' purchase once admin sets a price
// (called from POST /admin/purchase/:id/set-price)
// ══════════════════════════════════════════════════
async function confirmPayment(purchaseId, actualCryptoAmount) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query('SELECT * FROM purchases WHERE id = $1', [purchaseId]);
    if (result.rows.length === 0) throw new Error('Purchase not found');
    const purchase = result.rows[0];

    await client.query(
      `UPDATE purchases SET status = 'confirmed', confirmed_at = NOW() WHERE id = $1`,
      [purchaseId]
    );

    const refCode = 'FDX-' + Math.random().toString(36).substring(2,6).toUpperCase() + '-' + Math.random().toString(36).substring(2,6).toUpperCase();
    await client.query(
      `INSERT INTO buyers (buyer_wallet, referral_code) VALUES ($1, $2) ON CONFLICT (buyer_wallet) DO NOTHING`,
      [purchase.buyer_wallet, refCode]
    );
    await client.query(
      `UPDATE buyers SET total_purchases = total_purchases + 1, total_usd_spent = total_usd_spent + $1,
         total_tokens = total_tokens + $2, updated_at = NOW() WHERE buyer_wallet = $3`,
      [purchase.usd_value, purchase.tokens_allocated, purchase.buyer_wallet]
    );
    await client.query(
      'UPDATE tiers SET total_raised_usd = total_raised_usd + $1 WHERE id = $2',
      [purchase.usd_value, purchase.tier_at_purchase]
    );
    await client.query(
      `INSERT INTO notifications (wallet, type, title, message) VALUES ($1, 'purchase_confirmed', 'Purchase Confirmed', $2)`,
      [purchase.buyer_wallet, 'Your purchase of ' + parseFloat(purchase.tokens_allocated).toFixed(0) + ' FDP has been confirmed.']
    );

    if (purchase.referred_by_code) {
      await processReferralBonus(client, purchase);
    }

    await client.query('COMMIT');

    // ── Post-commit emails — never allowed to affect the confirmation result ──
    try {
      const tierResult = await pool.query('SELECT * FROM tiers WHERE id = $1', [purchase.tier_at_purchase]);
      const tier = tierResult.rows[0];
      if (tier) await sendPurchaseConfirmation(purchase, tier);
      if (purchase.referred_by_code) {
        const referrerResult = await pool.query(
          'SELECT buyer_wallet FROM buyers WHERE referral_code = $1', [purchase.referred_by_code]
        );
        const referrerWallet = referrerResult.rows[0]?.buyer_wallet;
        if (referrerWallet) await sendReferralNotification(referrerWallet, purchase);
      }
      if (parseFloat(purchase.usd_value) > 10000) {
        await sendLargePurchaseAlert(purchase);
      }
    } catch (emailErr) {
      console.error('[EMAIL] Post-purchase email dispatch failed:', emailErr.message);
    }

    // ── Public channel announcement ──
    // An admin-priced purchase credits tokens exactly like an automatic one,
    // so it belongs in the channel too. Separate try block from the emails so
    // a mail failure does not swallow the announcement, or the reverse.
    try {
      const tierRow = await pool.query('SELECT * FROM tiers WHERE id = $1', [purchase.tier_at_purchase]);
      await announcePurchase({
        wallet: purchase.buyer_wallet,
        cryptoAmount: actualCryptoAmount ?? purchase.crypto_amount,
        currency: purchase.crypto_currency,
        usdValue: purchase.usd_value,
        tokens: purchase.tokens_allocated,
        tierName: tierRow.rows[0]?.name,
        // The tier's own price, for the same reason as above —
        // purchase.price_at_purchase is the coin price, not the FDP price.
        tierPrice: tierRow.rows[0]?.price,
      });
    } catch (err) {
      console.error('[ANNOUNCE] Purchase announcement failed:', err.message);
    }

    return { success: true, purchaseId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { processPayment, confirmPayment, NETWORK_NAMES, CONFIRMATIONS_REQUIRED };
