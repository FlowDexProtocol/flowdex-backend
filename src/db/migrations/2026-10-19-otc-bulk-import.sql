-- ══════════════════════════════════════════════════
-- 2026-10-19-otc-bulk-import.sql
--
-- Bulk import of OTC payments.
--
-- Each imported row is one investor's allocation: the buyer, the coin they
-- paid in, how much of it, its USD value, and when the allocation should
-- happen.
--
-- Nothing is credited at import. Each row is written with drip_status
-- 'scheduled' and a scheduled_start_time, and the existing once-a-minute
-- activateScheduledOtc() sweep releases and announces it when due. The
-- scheduled_start_time column itself comes from the 2026-10-18 migration.
--
-- received_at stays nullable: when the money arrived is optional private
-- bookkeeping, never shown publicly and never announced.
--
-- row_fingerprint is what stops a re-uploaded file doubling the raise. It
-- is a hash of the fields that identify a payment, and it is UNIQUE, so a
-- duplicate row is rejected by the database itself rather than relying on
-- the import code to notice.
--
-- Additive and idempotent; existing allocations get NULLs and behave as
-- before.
-- ══════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS otc_import_batches (
  id SERIAL PRIMARY KEY,
  filename VARCHAR(255),
  uploaded_by VARCHAR(100) NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  total_usd DECIMAL(18,2) NOT NULL DEFAULT 0,
  -- 'committed' | 'reverted'
  status VARCHAR(20) NOT NULL DEFAULT 'committed',
  reverted_at TIMESTAMPTZ,
  reverted_by VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE otc_allocations
  -- The coin the buyer actually sent. NULL on allocations created through
  -- the single-allocation form, which records a USD figure only.
  ADD COLUMN IF NOT EXISTS payment_currency VARCHAR(20),
  ADD COLUMN IF NOT EXISTS payment_crypto_amount DECIMAL(36,18),
  -- When the payment landed, as distinct from when it was entered.
  ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS import_batch_id INTEGER REFERENCES otc_import_batches(id),
  ADD COLUMN IF NOT EXISTS row_fingerprint VARCHAR(64);

-- Partial unique index rather than a column constraint: rows created by the
-- single-allocation form have no fingerprint, and several NULLs must stay
-- legal.
CREATE UNIQUE INDEX IF NOT EXISTS idx_otc_row_fingerprint
  ON otc_allocations (row_fingerprint)
  WHERE row_fingerprint IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_otc_import_batch ON otc_allocations (import_batch_id);

COMMIT;
