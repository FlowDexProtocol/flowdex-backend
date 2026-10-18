// ══════════════════════════════════════════════════
// src/services/otc-service.js
// OTC investor daily drip — $200K released gradually over 24 hours.
// ══════════════════════════════════════════════════

const pool = require('../db/pool');
const { logAudit } = require('./audit-service');
const { generateClaimsForTier } = require('./claims-service');
const { alertTierAdvanced, sendAlert } = require('./alert-service');
const { announcePurchase } = require('./announce-service');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(tz);

// scheduledStartTime is optional. Omitted, null, or any time already past
// means "start now", which is how every existing caller behaves. A future
// time parks the allocation in drip_status 'scheduled' until
// activateScheduledOtc() picks it up, so an admin can set up a 3am drip
// without being awake at 3am.
async function createOtcAllocation(investorName, investorWallet, amountUsd, paymentRef, notes, scheduledStartTime = null) {
  // Get active tier
  const tierResult = await pool.query('SELECT * FROM tiers WHERE is_active = true LIMIT 1');
  if (tierResult.rows.length === 0) throw new Error('No active tier');
  const tier = tierResult.rows[0];
  const tierPrice = parseFloat(tier.price);
  const tokens = amountUsd / tierPrice;
  const now = new Date();

  // A scheduled time only counts if it parses and is actually in the future.
  // A malformed or past value silently degrades to an immediate start rather
  // than erroring, because an OTC deal that quietly fails to begin is worse
  // than one that begins early and is visible in the list.
  const requested = scheduledStartTime ? new Date(scheduledStartTime) : null;
  const isScheduled = !!(requested && !isNaN(requested.getTime()) && requested.getTime() > now.getTime());

  const startTime = isScheduled ? requested : now;
  const endTime = new Date(startTime.getTime() + 24 * 60 * 60 * 1000);
  const dripStatus = isScheduled ? 'scheduled' : 'active';

  const result = await pool.query(
    `INSERT INTO otc_allocations (investor_name, investor_wallet, daily_amount_usd, total_allocated_usd, total_tokens_allocated,
       tier_at_allocation, tier_price, tokens_today, usd_today, drip_start_time, drip_end_time, drip_status, payment_method, payment_reference, notes, day_gmt4, scheduled_start_time)
     VALUES ($1,$2,$3,$3,$4,$5,$6,$4,$3,$7,$8,$12,'direct_to_agency',$9,$10,$11,$13) RETURNING id`,
    [investorName, investorWallet, amountUsd, tokens, tier.id, tierPrice, startTime, endTime, paymentRef, notes,
     dayjs().tz(process.env.TIMEZONE || 'Asia/Dubai').format('YYYY-MM-DD'),
     dripStatus, isScheduled ? startTime : null]
  );
  await logAudit('otc_allocation', null, investorWallet, null, null,
    { amount: amountUsd, tokens, tier: tier.id, scheduled_start: isScheduled ? startTime.toISOString() : null },
    isScheduled ? 'OTC allocation scheduled' : 'OTC allocation created', 'admin');

  // Announced once, at the agreed size. The drip releases this in small
  // increments every few minutes, so announcing per increment would post
  // hundreds of messages for one deal.
  const allocationId = result.rows[0].id;

  // Not scheduled means start now, and "start" is now the whole thing: the
  // money is already in, so the allocation is released, settled and announced
  // in one step rather than trickling out over 24 hours.
  if (!isScheduled) {
    await releaseAllocationInFull(
      {
        id: allocationId,
        investor_wallet: investorWallet,
        total_allocated_usd: amountUsd,
        total_tokens_allocated: tokens,
        tier_price: tierPrice,
      },
      tier
    );
  }

  return {
    id: allocationId,
    tokens,
    drip_starts_at: startTime,
    drip_ends_at: endTime,
    scheduled: isScheduled,
  };
}

// ══════════════════════════════════════════════════
// releaseAllocationInFull — completes an OTC allocation in one step.
//
// An allocation is only ever created once the money is already in hand, so
// there is nothing to wait for: the tokens are credited to the tier, the
// allocation is marked paid, and the purchase is announced, all at once.
//
// This replaces the 24-hour drip for new allocations. processOtcDrip() is
// left in place for any allocation already mid-drip, but nothing new enters
// that path: every allocation created or activated from here lands as
// drip_status 'completed'.
//
// Tier advancement is handled here for the same reason it was handled in the
// drip: a large allocation can fill the active tier, and if nothing closes it
// the presale silently keeps selling at the old price.
// ══════════════════════════════════════════════════
async function releaseAllocationInFull(alloc, tier) {
  const usd = parseFloat(alloc.total_allocated_usd);
  const tokens = parseFloat(alloc.total_tokens_allocated);
  const tierPrice = parseFloat(alloc.tier_price);

  await pool.query('UPDATE tiers SET total_raised_usd = total_raised_usd + $1 WHERE id = $2', [usd, tier.id]);

  await pool.query(
    `INSERT INTO otc_drip_log (otc_allocation_id, amount_usd, tokens, tier_at_drip, tier_price, cumulative_released)
     VALUES ($1,$2,$3,$4,$5,$2)`,
    [alloc.id, usd, tokens, tier.id, tierPrice]
  );

  await pool.query(
    `UPDATE otc_allocations
     SET drip_released_usd = $1, drip_status = 'completed',
         paid_amount = $1, paid_tokens = $2, status = 'completed'
     WHERE id = $3`,
    [usd, tokens, alloc.id]
  );

  await logAudit('otc_payment_recorded', null, alloc.investor_wallet, null,
    { paid_amount: 0, paid_tokens: 0, status: 'allocated' },
    { paid_amount: usd, paid_tokens: tokens, status: 'completed', tier: tier.id },
    'OTC allocation released in full', 'system');

  console.log('[OTC] Released allocation #' + alloc.id + ' in full: $' + usd +
    ' / ' + Math.round(tokens).toLocaleString() + ' FDP (tier ' + tier.id + ')');

  // ── Tier advance ──
  const updated = await pool.query('SELECT * FROM tiers WHERE id = $1', [tier.id]);
  const row = updated.rows[0];
  if (row && parseFloat(row.total_raised_usd) >= parseFloat(row.hard_cap_usd)) {
    await pool.query('UPDATE tiers SET is_active = false, closed_at = NOW() WHERE id = $1', [tier.id]);
    const nextId = tier.id + 1;
    // 20 seeded tiers (src/db/seed-tiers.js) — keep in sync, or the presale
    // stops advancing once the last tier fills and no tier is left active.
    if (nextId <= 20) {
      await pool.query('UPDATE tiers SET is_active = true, opened_at = NOW() WHERE id = $1', [nextId]);
    }
    await generateClaimsForTier(tier.id);
    await logAudit('tier_advanced', null, null, null, { tier: tier.id }, { tier: nextId },
      'OTC allocation filled the tier', 'system');
    await alertTierAdvanced(tier.id, nextId <= 20 ? nextId : null);
  }

  // ── Public announcement ──
  // Same format as an on-chain purchase; nothing marks it as OTC.
  try {
    await announcePurchase({
      wallet: alloc.investor_wallet,
      usdValue: usd,
      tokens,
      tierName: tier.name,
      tierPrice,
    });
  } catch (err) {
    console.error('[ANNOUNCE] OTC announcement failed:', err.message);
  }
}

async function processOtcDrip() {
  try {
    // status != 'cancelled' guards against a cancelled allocation continuing
    // to drip out tokens that were supposedly "returned to the pool" — the
    // only status value that should ever stop a drip already in progress.
    const actives = await pool.query("SELECT * FROM otc_allocations WHERE drip_status = 'active' AND status != 'cancelled'");
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
        // 20 seeded tiers (src/db/seed-tiers.js) — keep this in sync with the
        // highest tier id there, or the presale silently stops advancing once
        // the last tier fills and no tier is ever left active.
        if (nextId <= 20) {
          await pool.query('UPDATE tiers SET is_active = true, opened_at = NOW() WHERE id = $1', [nextId]);
        }
        // Generate claims for closed tier
        await generateClaimsForTier(tier.id);
        await logAudit('tier_advanced', null, null, null, {tier:tier.id}, {tier:nextId}, 'OTC drip triggered tier advance', 'system');
        await alertTierAdvanced(tier.id, nextId <= 20 ? nextId : null);
      }

      // Check if drip complete
      if (pct >= 1.0) {
        await pool.query("UPDATE otc_allocations SET drip_status = 'completed' WHERE id = $1", [alloc.id]);
      }
    }
  } catch (err) { console.error('[OTC] Drip failed:', err.message); }
}

// ══════════════════════════════════════════════════
// activateScheduledOtc — flips due scheduled allocations to active.
//
// Runs every minute. The drip window is recomputed from the activation
// moment rather than from scheduled_start_time, so an allocation still gets
// its full 24 hours even if the server was down when its time came round.
//
// The agreed token figure is deliberately NOT re-priced here. An OTC
// allocation is a negotiated deal, and silently changing its size because
// a tier closed between scheduling and activation would rewrite terms
// nobody agreed to. processOtcDrip() already prices each released
// increment against whichever tier is active at the time, so the ledger
// stays correct either way. When the tier has moved, that is flagged
// rather than acted on.
// ══════════════════════════════════════════════════
async function activateScheduledOtc() {
  try {
    const due = await pool.query(
      `SELECT * FROM otc_allocations
       WHERE drip_status = 'scheduled'
         AND status != 'cancelled'
         AND scheduled_start_time IS NOT NULL
         AND scheduled_start_time <= NOW()
       ORDER BY scheduled_start_time ASC`
    );
    if (!due.rows.length) return;

    for (const alloc of due.rows) {
      const now = new Date();
      const endTime = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      const activated = await pool.query(
        `UPDATE otc_allocations
         SET drip_status = 'active', drip_start_time = $1, drip_end_time = $2
         WHERE id = $3 AND drip_status = 'scheduled' AND status != 'cancelled'`,
        [now, endTime, alloc.id]
      );

      // Lost the race: an admin paused or cancelled it between the read and
      // the write. Nothing to announce, nothing to log.
      if (activated.rowCount === 0) {
        console.log('[OTC] Allocation #' + alloc.id + ' no longer scheduled at activation time — skipped.');
        continue;
      }

      const lateBySec = Math.round((now.getTime() - new Date(alloc.scheduled_start_time).getTime()) / 1000);

      await logAudit('otc_activated', null, alloc.investor_wallet, null,
        { drip_status: 'scheduled' },
        { drip_status: 'active', scheduled_for: alloc.scheduled_start_time, started_at: now.toISOString(), late_seconds: lateBySec },
        'Scheduled OTC allocation activated', 'system');

      // A minute or two late is the cron cadence. Hours late means the
      // process was down through the scheduled moment, and someone should
      // know a deal started at the wrong time.
      if (lateBySec > 900) {
        await sendAlert('OTC Started Late',
          'Allocation #' + alloc.id + ' (' + alloc.investor_name + ') was scheduled for ' +
          new Date(alloc.scheduled_start_time).toISOString() + '\n' +
          'It activated ' + Math.round(lateBySec / 60) + ' minutes late.\n' +
          'The drip still runs a full 24 hours from activation.',
          'warning');
      }

      // Tier drift — re-price to the tier that is live at activation.
      //
      // The allocation is priced at whatever tier is actually running when
      // the drip begins, not the tier that happened to be open when an admin
      // filled in the form. A deal scheduled on Monday against tier 1 and
      // activating on Friday against tier 3 buys tier 3's tokens. This also
      // keeps the stored figure consistent with processOtcDrip(), which has
      // always priced each released increment against the live tier.
      const tierResult = await pool.query('SELECT * FROM tiers WHERE is_active = true LIMIT 1');
      const activeTier = tierResult.rows[0];

      if (activeTier && activeTier.id !== alloc.tier_at_allocation) {
        const newPrice = parseFloat(activeTier.price);
        const usd = parseFloat(alloc.total_allocated_usd);
        const newTokens = usd / newPrice;
        const oldTokens = parseFloat(alloc.total_tokens_allocated);

        await pool.query(
          `UPDATE otc_allocations
           SET tier_at_allocation = $1, tier_price = $2, total_tokens_allocated = $3, tokens_today = $3
           WHERE id = $4`,
          [activeTier.id, newPrice, newTokens, alloc.id]
        );

        alloc.tier_at_allocation = activeTier.id;
        alloc.tier_price = newPrice;
        alloc.total_tokens_allocated = newTokens;

        console.warn('[OTC] Allocation #' + alloc.id + ' re-priced from tier ' +
          alloc.tier_at_allocation + ' to tier ' + activeTier.id + ' at activation.');

        await logAudit('otc_repriced', null, alloc.investor_wallet, null,
          { tier: alloc.tier_at_allocation, price: alloc.tier_price, tokens: oldTokens },
          { tier: activeTier.id, price: newPrice, tokens: newTokens },
          'Scheduled allocation re-priced to the tier live at activation', 'system');

        // The investor was quoted a different number when the deal was
        // scheduled, so someone has to tell them before the drip finishes.
        await sendAlert('OTC Re-priced at Activation',
          'Allocation #' + alloc.id + ' (' + alloc.investor_name + ') activated against a different tier.\n' +
          'Scheduled at $' + alloc.tier_price + ' for ' + Math.round(oldTokens).toLocaleString() + ' FDP.\n' +
          'Activated at $' + newPrice + ' for ' + Math.round(newTokens).toLocaleString() + ' FDP.\n' +
          'USD value is unchanged at $' + usd.toLocaleString() + '. The investor should be told.',
          'warning');
      }

      // The scheduled moment has arrived, so the deal completes now: full
      // amount to the tier, marked paid, announced. Nothing is left for an
      // admin to click.
      const releaseTier = activeTier
        || (await pool.query('SELECT * FROM tiers WHERE id = $1', [alloc.tier_at_allocation])).rows[0];

      if (!releaseTier) {
        console.error('[OTC] Allocation #' + alloc.id + ' activated but no tier available to release against.');
        await sendAlert('OTC Activation Stalled',
          'Allocation #' + alloc.id + ' (' + alloc.investor_name + ') activated, but there is no tier to credit it to. ' +
          'It is marked active and unreleased, and needs manual attention.',
          'critical');
        continue;
      }

      await releaseAllocationInFull(alloc, releaseTier);
    }
  } catch (err) {
    console.error('[OTC] Scheduled activation failed:', err.message);
  }
}

module.exports = { createOtcAllocation, processOtcDrip, activateScheduledOtc, releaseAllocationInFull };
