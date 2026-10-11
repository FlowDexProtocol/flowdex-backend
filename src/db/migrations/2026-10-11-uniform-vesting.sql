-- ══════════════════════════════════════════════════
-- 2026-10-11 — Uniform presale vesting
--
-- Replaces the sliding per-tier vesting schedule (Tier 1: 5% TGE /
-- 12-month cliff / 24-month vest, descending to Tier 20: 100% TGE /
-- no lockup) with terms that are IDENTICAL across all 20 tiers:
--
--     TGE unlock   10%
--     Cliff        none
--     Linear vest  12 months, monthly
--
-- Rationale: under the old schedule Tier 1 paid the lowest price AND
-- waited the longest, so the price advantage and the time penalty
-- cancelled out and a rational buyer waited for a later tier. Making
-- terms identical leaves price as the only variable between tiers.
-- Earliness is still rewarded, because a tier's vesting clock starts
-- when that tier CLOSES rather than at listing: Tier 1 therefore
-- reaches full unlock before any later tier. Sell pressure is still
-- distributed, because the twenty tiers close sequentially and their
-- vesting streams are naturally offset across roughly twenty months.
--
-- Safe to run: verified every tier had total_raised_usd = 0 at the time
-- of writing, so no participant's published terms are changed
-- retroactively. The guard below enforces that rather than trusting it.
-- ══════════════════════════════════════════════════

BEGIN;

-- Refuse to run if anyone has already purchased. Changing vesting terms
-- after a sale would alter the deal those buyers agreed to.
DO $$
DECLARE raised NUMERIC;
BEGIN
  SELECT COALESCE(SUM(total_raised_usd), 0) INTO raised FROM tiers;
  IF raised > 0 THEN
    RAISE EXCEPTION
      'Aborting: tiers show % USD raised. Vesting terms must not change after purchases exist — resolve manually.', raised;
  END IF;
END $$;

-- 1. Uniform vesting across all tiers.
UPDATE tiers
SET tge_percentage = 10.00,
    cliff_months   = 0,
    vest_months    = 12;

-- 2. FAQ copy describing the old sliding schedule.
UPDATE cms_faqs
SET answer = 'Every presale tier has identical vesting terms: 10% of your tokens unlock at that tier''s TGE, and the remaining 90% vest monthly across the following 12 months. There is no cliff. Price is the only thing that differs between tiers. Because each tier''s vesting clock starts when that tier closes rather than at listing, earlier tiers finish unlocking earlier.'
WHERE question = 'What is the token vesting schedule?';

UPDATE cms_faqs
SET answer = 'Claims open once your tier reaches its Token Generation Event, which happens when that tier closes. 10% of your allocation unlocks immediately and the remaining 90% releases monthly across the following 12 months, with no cliff. You can check and claim available tokens any time from your dashboard.'
WHERE question = 'When can I claim my tokens?';

-- 3. Blog post paragraph describing the old sliding schedule.
UPDATE cms_blog_posts
SET content = replace(
      content,
      'Each presale tier has its own vesting terms. Tier 1 (Genesis) at $0.0005 gets 5% at TGE with a 12-month cliff and 24-month vest. Tier 20 (Prestige) at $0.01 gets 100% at TGE with no cliff or vest. Earlier tiers get better prices but longer lockups. Later tiers cost more but tokens unlock faster.',
      'Every presale tier carries identical vesting terms: 10% at that tier''s TGE, then the remaining 90% vesting monthly over 12 months, with no cliff anywhere in the schedule. Price is the only variable between tiers, running from $0.0005 at Tier 1 (Genesis) to $0.01 at Tier 20 (Prestige). Earliness is rewarded through the per-tier TGE clock rather than through different terms: because a tier''s vesting starts when that tier closes, Tier 1 buyers pay the lowest price and reach full unlock before any later tier.'
    )
WHERE slug = 'understanding-fdp-tokenomics';

COMMIT;

-- ── Verification ──────────────────────────────────
-- Expect: 20 rows, every one 10.00 / 0 / 12
--   SELECT id, name, price, tge_percentage, cliff_months, vest_months
--   FROM tiers ORDER BY id;
--
-- Expect: 0
--   SELECT COUNT(*) FROM tiers
--   WHERE tge_percentage <> 10.00 OR cliff_months <> 0 OR vest_months <> 12;
--
-- Expect: 0
--   SELECT COUNT(*) FROM cms_faqs WHERE answer ILIKE '%cliff period%';
--
-- Expect: 0
--   SELECT COUNT(*) FROM cms_blog_posts WHERE content ILIKE '%12-month cliff%';
