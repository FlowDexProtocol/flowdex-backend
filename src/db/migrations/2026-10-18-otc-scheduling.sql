-- ══════════════════════════════════════════════════
-- 2026-10-18-otc-scheduling.sql
--
-- Lets an admin create an OTC allocation now and have its drip begin at a
-- chosen time later. Before this, createOtcAllocation() set the drip window
-- from the clock at the instant of creation, so starting a drip at 3am
-- required an admin awake at 3am.
--
-- scheduled_start_time records the intended start. drip_status gains a
-- 'scheduled' value, which processOtcDrip() ignores because it selects only
-- drip_status = 'active'; the activateScheduledOtc() job flips them over
-- when their time arrives.
--
-- Safe to run on a populated database: existing rows get NULL, which the
-- code treats as "start immediately", exactly as before.
-- ══════════════════════════════════════════════════

BEGIN;

ALTER TABLE otc_allocations
  ADD COLUMN IF NOT EXISTS scheduled_start_time TIMESTAMPTZ;

-- Partial index: the activation job only ever looks at scheduled rows, and
-- in normal operation those are a tiny fraction of the table.
CREATE INDEX IF NOT EXISTS idx_otc_scheduled
  ON otc_allocations (scheduled_start_time)
  WHERE drip_status = 'scheduled';

COMMIT;
