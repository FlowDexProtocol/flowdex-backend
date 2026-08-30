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

    // Get all confirmed purchases for this tier, grouped by wallet
    const purchases = await client.query(
      `SELECT buyer_wallet, SUM(tokens_allocated) as total_tokens
       FROM purchases WHERE tier_at_purchase = $1 AND status = 'confirmed'
       GROUP BY buyer_wallet`, [tierId]
    );

    // Get bonus tokens for each wallet in this tier
    const bonuses = await client.query(
      `SELECT wallet, SUM(bonus_tokens) as total_bonus
       FROM bonus_allocations WHERE tier_at_bonus = $1
       GROUP BY wallet`, [tierId]
    );
    const bonusMap = {};
    bonuses.rows.forEach(b => { bonusMap[b.wallet] = parseFloat(b.total_bonus); });

    let claimsCreated = 0;
    for (const row of purchases.rows) {
      const totalPurchased = parseFloat(row.total_tokens);
      const bonusTokens = bonusMap[row.buyer_wallet] || 0;
      const totalTokens = totalPurchased + bonusTokens;
      const claimableTokens = totalTokens * (tier.tge_percentage / 100);

      // UNIQUE(buyer_wallet, tier_id) prevents duplicates
      await client.query(
        `INSERT INTO claims (buyer_wallet, tier_id, tier_name, total_purchased_tokens, tge_percentage, claimable_tokens, bonus_tokens_claimable, total_claimable, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'eligible')
         ON CONFLICT (buyer_wallet, tier_id) DO NOTHING`,
        [row.buyer_wallet, tierId, tier.name, totalPurchased, tier.tge_percentage,
         totalPurchased * (tier.tge_percentage / 100),
         bonusTokens * (tier.tge_percentage / 100),
         claimableTokens]
      );

      await client.query(
        `INSERT INTO notifications (wallet, type, title, message) VALUES ($1, 'claim_ready', $2, $3)`,
        [row.buyer_wallet, 'Tier ' + tierId + ' Has Closed',
         'Your TGE claim is now available. You have ' + claimableTokens.toFixed(0) + ' $FDP ready to claim from Tier ' + tierId + '.']
      );

      claimsCreated++;
    }

    // Also generate claims for OTC investor if applicable
    const otcResult = await client.query(
      `SELECT investor_wallet, SUM(total_tokens_allocated) as total_tokens
       FROM otc_allocations WHERE tier_at_allocation = $1
       GROUP BY investor_wallet`, [tierId]
    );
    for (const otc of otcResult.rows) {
      const tokens = parseFloat(otc.total_tokens);
      const claimable = tokens * (tier.tge_percentage / 100);
      await client.query(
        `INSERT INTO claims (buyer_wallet, tier_id, tier_name, total_purchased_tokens, tge_percentage, claimable_tokens, bonus_tokens_claimable, total_claimable, status)
         VALUES ($1, $2, $3, $4, $5, $6, 0, $6, 'eligible')
         ON CONFLICT (buyer_wallet, tier_id) DO NOTHING`,
        [otc.investor_wallet, tierId, tier.name, tokens, tier.tge_percentage, claimable]
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
