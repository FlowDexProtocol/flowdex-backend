-- ══════════════════════════════════════════════════
-- 2026-10-18-otc-missing-columns.sql
--
-- Brings otc_allocations in line with schema.sql.
--
-- The payment and cancellation columns were added to schema.sql when the
-- OTC cancellation and payment-tracking work shipped, but schema.sql uses
-- CREATE TABLE IF NOT EXISTS, which does nothing to a table that already
-- exists. The live table was created before that change, so it never got
-- them. Anything touching otc_allocations.status has been failing since:
-- the cancel endpoint, record-payment, and the scheduled-activation job.
--
-- Every column is nullable or carries a default, so existing rows fill in
-- without a rewrite. Safe to run more than once.
-- ══════════════════════════════════════════════════

BEGIN;

ALTER TABLE otc_allocations
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'allocated',
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by INTEGER,
  ADD COLUMN IF NOT EXISTS cancel_reason TEXT,
  ADD COLUMN IF NOT EXISTS paid_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS paid_tokens DECIMAL(36,8) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tokens_returned DECIMAL(36,8) NOT NULL DEFAULT 0;

-- Indexes from schema.sql that were never created either, for the same reason.
CREATE INDEX IF NOT EXISTS idx_otc_payment_status ON otc_allocations(status);
CREATE INDEX IF NOT EXISTS idx_otc_wallet ON otc_allocations(investor_wallet);
CREATE INDEX IF NOT EXISTS idx_otc_status ON otc_allocations(drip_status);

COMMIT;
