// ══════════════════════════════════════════════════
// src/services/otc-service.js
// OTC investor daily drip — $200K released gradually over 24 hours.
// ══════════════════════════════════════════════════

const pool = require('../db/pool');
const { logAudit } = require('./audit-service');
const { generateClaimsForTier } = require('./claims-service');
const { alertTierAdvanced } = require('./alert-service');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(tz);

async function createOtcAllocation(investorName, investorWallet, amountUsd, paymentRef, notes) {
  // Get active tier
  const tierResult = await pool.query('SELECT * FROM tiers WHERE is_active = true LIMIT 1');
  if (tierResult.rows.length === 0) throw new Error('No active tier');
  const tier = tierResult.rows[0];
  const tierPrice = parseFloat(tier.price);
  const tokens = amountUsd / tierPrice;
  const now = new Date();
  const endTime = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  const result = await pool.query(
    `INSERT INTO otc_allocations (investor_name, investor_wallet, daily_amount_usd, total_allocated_usd, total_tokens_allocated,
       tier_at_allocation, tier_price, tokens_today, usd_today, drip_start_time, drip_end_time, drip_status, payment_method, payment_reference, notes, day_gmt4)
     VALUES ($1,$2,$3,$3,$4,$5,$6,$4,$3,$7,$8,'active','direct_to_agency',$9,$10,$11) RETURNING id`,
    [investorName, investorWallet, amountUsd, tokens, tier.id, tierPrice, now, endTime, paymentRef, notes,
     dayjs().tz(process.env.TIMEZONE || 'Asia/Dubai').format('YYYY-MM-DD')]
  );
  await logAudit('otc_allocation', null, investorWallet, null, null,
    { amount: amountUsd, tokens, tier: tier.id }, 'OTC allocation created', 'admin');
  return { id: result.rows[0].id, tokens, drip_ends_at: endTime };
}

async function processOtcDrip() {
  try {
    const actives = await pool.query("SELECT * FROM otc_allocations WHERE drip_status = 'active'");
    for (const alloc of actives.rows) {
      const now = new Date();
      const start = new Date(alloc.drip_start_time);
      const end = new Date(alloc.drip_end_time);
      const totalMs = end.getTime() - start.getTime();
      const elapsedMs = now.getTime() - start.getTime();
      const pct = Math.min(elapsedMs / totalMs, 1.0);
      const shouldHaveReleased = parseFloat(alloc.daily_amount_usd) * pct;
      const alreadyReleased = parseFloat(alloc.drip_released_usd);
      const increment = shouldHaveReleased - alreadyReleased;

      if (increment <= 0) continue;

      // Get current active tier
      const tierResult = await pool.query('SELECT * FROM tiers WHERE is_active = true LIMIT 1');
      if (tierResult.rows.length === 0) continue;
      const tier = tierResult.rows[0];
      const tierPrice = parseFloat(tier.price);
      const incrementTokens = increment / tierPrice;

      // Add to tier raised
      await pool.query('UPDATE tiers SET total_raised_usd = total_raised_usd + $1 WHERE id = $2', [increment, tier.id]);

      // Update allocation
      await pool.query('UPDATE otc_allocations SET drip_released_usd = $1 WHERE id = $2', [shouldHaveReleased, alloc.id]);

      // Log drip
      await pool.query(
        `INSERT INTO otc_drip_log (otc_allocation_id, amount_usd, tokens, tier_at_drip, tier_price, cumulative_released)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [alloc.id, increment, incrementTokens, tier.id, tierPrice, shouldHaveReleased]
      );

      // Check if tier cap reached
      const updatedTier = await pool.query('SELECT * FROM tiers WHERE id = $1', [tier.id]);
      if (parseFloat(updatedTier.rows[0].total_raised_usd) >= parseFloat(updatedTier.rows[0].hard_cap_usd)) {
        // Advance tier
        await pool.query('UPDATE tiers SET is_active = false, closed_at = NOW() WHERE id = $1', [tier.id]);
        const nextId = tier.id + 1;
        if (nextId <= 8) {
          await pool.query('UPDATE tiers SET is_active = true, opened_at = NOW() WHERE id = $1', [nextId]);
        }
        // Generate claims for closed tier
        await generateClaimsForTier(tier.id);
        await logAudit('tier_advanced', null, null, null, {tier:tier.id}, {tier:nextId}, 'OTC drip triggered tier advance', 'system');
        await alertTierAdvanced(tier.id, nextId <= 8 ? nextId : null);
      }

      // Check if drip complete
      if (pct >= 1.0) {
        await pool.query("UPDATE otc_allocations SET drip_status = 'completed' WHERE id = $1", [alloc.id]);
      }
    }
  } catch (err) { console.error('[OTC] Drip failed:', err.message); }
}

module.exports = { createOtcAllocation, processOtcDrip };
