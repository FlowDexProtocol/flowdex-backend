// ══════════════════════════════════════════════════
// src/services/claims-service.js
// TGE Claims — auto-generates when tier closes, one claim per buyer per tier.
// ══════════════════════════════════════════════════

const pool = require('../db/pool');
const { logAudit } = require('./audit-service');

// Called when a tier closes — generates claim eligibility for all buyers in that tier
async function generateClaimsForTier(tierId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get tier info
    const tierResult = await client.query('SELECT * FROM tiers WHERE id = $1', [tierId]);
    if (tierResult.rows.length === 0) throw new Error('Tier not found');
    const tier = tierResult.rows[0];

    // Open claims for this tier
    await client.query('UPDATE tiers SET claims_open = true WHERE id = $1', [tierId]);

    // ── Tokens bought on-chain, per wallet, for THIS tier ──
    //
    // Read from purchase_tier_allocations rather than purchases.tier_at_purchase:
    // a payment that crossed a tier boundary is one purchases row but two
    // allocations, and each belongs to its own tier's vesting clock. Every
    // confirmed purchase has at least one row here (the 2026-10-20 migration
    // backfilled the older ones), so there is no second path to maintain.
    const purchases = await client.query(
      `SELECT p.buyer_wallet, SUM(a.tokens) AS total_tokens
       FROM purchase_tier_allocations a
       JOIN purchases p ON p.id = a.purchase_id
       WHERE a.tier_id = $1 AND p.status = 'confirmed'
       GROUP BY p.buyer_wallet`, [tierId]
    );

    // ── Tokens bought OTC, per wallet, for THIS tier ──
    //
    // paid_tokens, not total_tokens_allocated: only what was actually
    // released counts. And the status filter matters more than it looks —
    // without it a CANCELLED allocation still produced a claim, and so did a
    // SCHEDULED one whose release time had not yet arrived, handing out
    // claims for tokens that were never credited to the tier.
    const otcResult = await client.query(
      `SELECT investor_wallet, SUM(paid_tokens) AS total_tokens
       FROM otc_allocations
       WHERE tier_at_allocation = $1
         AND status IN ('completed', 'partial')
         AND paid_tokens > 0
       GROUP BY investor_wallet`, [tierId]
    );

    // ── Bonus tokens, per wallet, for THIS tier ──
    const bonuses = await client.query(
      `SELECT wallet, SUM(bonus_tokens) as total_bonus
       FROM bonus_allocations WHERE tier_at_bonus = $1
       GROUP BY wallet`, [tierId]
    );

    // ── Merge all three before writing anything ──
    //
    // Previously purchases and OTC were inserted as two separate passes, both
    // with ON CONFLICT (buyer_wallet, tier_id) DO NOTHING. A wallet holding
    // both a purchase and an OTC allocation in the same tier therefore got
    // the first claim and had the second silently dropped, losing those
    // tokens at TGE. One claim per wallet, summed first, cannot do that.
    const totals = new Map();
    const add = (wallet, purchased, bonus) => {
      const key = String(wallet).toLowerCase();
      const cur = totals.get(key) || { wallet, purchased: 0, bonus: 0 };
      cur.purchased += purchased;
      cur.bonus += bonus;
      totals.set(key, cur);
    };

    for (const r of purchases.rows) add(r.buyer_wallet, parseFloat(r.total_tokens), 0);
    for (const r of otcResult.rows) add(r.investor_wallet, parseFloat(r.total_tokens), 0);
    for (const b of bonuses.rows) add(b.wallet, 0, parseFloat(b.total_bonus));

    let claimsCreated = 0;
    for (const entry of totals.values()) {
      const totalPurchased = entry.purchased;
      const bonusTokens = entry.bonus;

      // A wallet with only a bonus and no purchase in this tier has nothing
      // to vest here; a bonus rides along with a purchase, it is not one.
      if (totalPurchased <= 0) continue;

      const totalTokens = totalPurchased + bonusTokens;
      const claimableTokens = totalTokens * (tier.tge_percentage / 100);

      // UNIQUE(buyer_wallet, tier_id) makes re-running this safe.
      await client.query(
        `INSERT INTO claims (buyer_wallet, tier_id, tier_name, total_purchased_tokens, tge_percentage, claimable_tokens, bonus_tokens_claimable, total_claimable, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'eligible')
         ON CONFLICT (buyer_wallet, tier_id) DO NOTHING`,
        [entry.wallet, tierId, tier.name, totalPurchased, tier.tge_percentage,
         totalPurchased * (tier.tge_percentage / 100),
         bonusTokens * (tier.tge_percentage / 100),
         claimableTokens]
      );

      await client.query(
        `INSERT INTO notifications (wallet, type, title, message) VALUES ($1, 'claim_ready', $2, $3)`,
        [entry.wallet, 'Tier ' + tierId + ' Has Closed',
         'Your TGE claim is now available. You have ' + claimableTokens.toFixed(0) + ' FDP ready to claim from Tier ' + tierId + '.']
      );

      claimsCreated++;
    }

    await logAudit('tier_closed', null, null, null, { tier: tierId, claims_open: false },
      { tier: tierId, claims_open: true, claims_created: claimsCreated },
      'Tier ' + tierId + ' closed, ' + claimsCreated + ' claims generated', 'system');

    await client.query('COMMIT');
    console.log('[CLAIMS] Tier ' + tierId + ': ' + claimsCreated + ' claims generated');
    return claimsCreated;
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[CLAIMS] Generation failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

// Process a single claim
async function processClaim(wallet, tierId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check tier has claims open
    const tierCheck = await client.query('SELECT claims_open FROM tiers WHERE id = $1', [tierId]);
    if (!tierCheck.rows[0]?.claims_open) {
      await client.query('ROLLBACK');
      return { success: false, error: 'Claims not open for this tier' };
    }

    // Check claim exists and is eligible
    const claimResult = await client.query(
      'SELECT * FROM claims WHERE buyer_wallet = $1 AND tier_id = $2', [wallet, tierId]
    );
    if (claimResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: 'No claim found for this wallet in this tier' };
    }

    const claim = claimResult.rows[0];
    if (claim.status === 'claimed') {
      await client.query('ROLLBACK');
      return { success: false, error: 'Already claimed. Tokens were claimed on ' + claim.claimed_at };
    }
    if (claim.status !== 'eligible') {
      await client.query('ROLLBACK');
      return { success: false, error: 'Claim status: ' + claim.status };
    }

    // Process the claim
    await client.query(
      `UPDATE claims SET status = 'claimed', claimed_at = NOW() WHERE id = $1`, [claim.id]
    );

    await logAudit('claim_processed', null, wallet, null,
      { status: 'eligible' },
      { status: 'claimed', tokens: claim.total_claimable, tier: tierId },
      'TGE claim processed for Tier ' + tierId, 'system');

    await client.query('COMMIT');
    return {
      success: true,
      tokens_claimed: parseFloat(claim.total_claimable),
      tier: tierId,
      tier_name: claim.tier_name,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { generateClaimsForTier, processClaim };
