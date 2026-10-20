-- ══════════════════════════════════════════════════
-- 2026-10-20 — tier-boundary splitting, and two claim fixes
--
-- WHY THIS EXISTS
--
-- A payment that was larger than the room left in the active tier used to be
-- written as 'flagged': no tokens, no email, no announcement, and no alert of
-- any kind. The money sat in the wallet and nobody was told. That is not an
-- edge case — it is guaranteed at every one of the twenty tier boundaries,
-- and the larger the purchase the likelier it is.
--
-- A payment now fills the current tier to its cap and buys the remainder at
-- the next tier's price, cascading as far as it needs to.
--
-- WHY A SEPARATE TABLE
--
-- Vesting is per tier, and each tier's clock starts when that tier closes.
-- A purchase spanning two tiers therefore genuinely has two vesting
-- schedules, and the single tier_at_purchase column on `purchases` cannot
-- say that. The alternative was to write one purchases row per segment,
-- which would have meant dropping the UNIQUE constraint on tx_hash — the
-- thing that stops a replayed webhook crediting the same payment twice.
-- Weakening that to gain a column was the wrong trade, so the breakdown
-- lives here instead and `purchases` keeps exactly one row per transaction.
--
-- On a split purchase, purchases.tier_at_purchase is the tier the buyer
-- ENTERED at, and purchases.tokens_allocated is the total across all
-- segments. The per-tier truth is in this table.
-- ══════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS purchase_tier_allocations (
  id SERIAL PRIMARY KEY,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  tier_id INTEGER NOT NULL REFERENCES tiers(id),
  tier_name VARCHAR(50) NOT NULL,
  tier_price DECIMAL(18,8) NOT NULL,
  usd_amount DECIMAL(18,2) NOT NULL,
  tokens DECIMAL(36,18) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One row per purchase per tier. Re-running a credit cannot duplicate a
  -- segment, and claim generation can be re-run safely.
  UNIQUE (purchase_id, tier_id)
);

CREATE INDEX IF NOT EXISTS idx_pta_tier ON purchase_tier_allocations (tier_id);
CREATE INDEX IF NOT EXISTS idx_pta_purchase ON purchase_tier_allocations (purchase_id);

-- Backfill every existing confirmed purchase as a single-segment allocation,
-- so claim generation can read from this table alone rather than carrying a
-- fallback path for older rows forever.
INSERT INTO purchase_tier_allocations (purchase_id, tier_id, tier_name, tier_price, usd_amount, tokens)
SELECT p.id, p.tier_at_purchase, COALESCE(p.tier_name, ''), COALESCE(p.tier_price, 0),
       p.usd_value, p.tokens_allocated
FROM purchases p
WHERE p.status = 'confirmed'
  AND p.tier_at_purchase IS NOT NULL
ON CONFLICT (purchase_id, tier_id) DO NOTHING;
