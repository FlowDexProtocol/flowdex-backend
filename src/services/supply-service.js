// ══════════════════════════════════════════════════
// src/services/supply-service.js
// Token supply guard — prevents over-allocation
// ══════════════════════════════════════════════════

const pool = require('../db/pool');

const TOTAL_SUPPLY = 10000000000;                    // 10 billion
const PRESALE_ALLOCATION_PCT = 22.5;                 // 22.5%
const PRESALE_MAX_TOKENS = TOTAL_SUPPLY * PRESALE_ALLOCATION_PCT / 100;  // 2,250,000,000

async function getSupplyStatus() {
  // Tokens allocated through regular purchases
  const purchases = await pool.query(
    "SELECT COALESCE(SUM(tokens_allocated), 0) as total FROM purchases WHERE status IN ('confirmed', 'pending')"
  );
  // Tokens allocated through bonus (referrals)
  const bonuses = await pool.query(
    "SELECT COALESCE(SUM(bonus_tokens), 0) as total FROM bonus_allocations"
  );
  // Tokens allocated through OTC
  const otc = await pool.query(
    "SELECT COALESCE(SUM(total_tokens_allocated), 0) as total FROM otc_allocations"
  );
  // Tokens burned (reduces outstanding, not allocation)
  const burned = await pool.query(
    "SELECT COALESCE(SUM(tokens_burned), 0) as total FROM burn_log"
  );

  const totalAllocated = parseFloat(purchases.rows[0].total)
    + parseFloat(bonuses.rows[0].total)
    + parseFloat(otc.rows[0].total);

  const totalBurned = parseFloat(burned.rows[0].total);
  const netOutstanding = totalAllocated - totalBurned;
  const remaining = PRESALE_MAX_TOKENS - totalAllocated;

  return {
    total_supply: TOTAL_SUPPLY,
    presale_max: PRESALE_MAX_TOKENS,
    allocated_purchases: parseFloat(purchases.rows[0].total),
    allocated_bonuses: parseFloat(bonuses.rows[0].total),
    allocated_otc: parseFloat(otc.rows[0].total),
    total_allocated: totalAllocated,
    total_burned: totalBurned,
    net_outstanding: netOutstanding,
    remaining_to_allocate: remaining,
    utilization_pct: ((totalAllocated / PRESALE_MAX_TOKENS) * 100).toFixed(4),
  };
}

// Call BEFORE every allocation — returns false if allocation would exceed supply
async function canAllocate(tokenAmount) {
  const status = await getSupplyStatus();
  if (status.remaining_to_allocate < tokenAmount) {
    console.error('[SUPPLY] HARD STOP: Cannot allocate ' + tokenAmount + ' tokens. Only ' + status.remaining_to_allocate + ' remaining.');
    return { allowed: false, remaining: status.remaining_to_allocate, requested: tokenAmount };
  }
  if (parseFloat(status.utilization_pct) > 95) {
    const { alertSupplyLow } = require('./alert-service');
    await alertSupplyLow(status.remaining_to_allocate, status.utilization_pct);
  }
  return { allowed: true, remaining: status.remaining_to_allocate - tokenAmount };
}

module.exports = { getSupplyStatus, canAllocate, PRESALE_MAX_TOKENS, TOTAL_SUPPLY };

// ══════════════════════════════════════════════════
// USAGE: In payment-service.js, BEFORE recording allocation:
//
// const { canAllocate } = require('./supply-service');
// const check = await canAllocate(tokensAllocated);
// if (!check.allowed) {
//   // Reject purchase — presale allocation exhausted
//   return { success: false, reason: 'supply_exhausted', remaining: check.remaining };
// }
// ══════════════════════════════════════════════════
