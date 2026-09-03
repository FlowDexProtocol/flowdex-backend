-- ══════════════════════════════════════════════════
-- FLOWDEX PROTOCOL DATABASE V2 — 30 TABLES
-- Run via: npm run db:setup
-- ══════════════════════════════════════════════════

-- ── Table 1: tiers ──
CREATE TABLE IF NOT EXISTS tiers (
  id INTEGER PRIMARY KEY,
  name VARCHAR(50) NOT NULL,
  price DECIMAL(18,8) NOT NULL,
  hard_cap_usd DECIMAL(18,2) NOT NULL,
  total_raised_usd DECIMAL(18,2) NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT false,
  claims_open BOOLEAN NOT NULL DEFAULT false,
  tge_percentage DECIMAL(5,2) NOT NULL,
  cliff_months INTEGER NOT NULL DEFAULT 0,
  vest_months INTEGER NOT NULL DEFAULT 0,
  opened_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ
);

-- ── Table 2: purchases ──
-- NEVER delete a row here. Mark as failed/refunded/cancelled instead.
CREATE TABLE IF NOT EXISTS purchases (
  id SERIAL PRIMARY KEY,
  buyer_wallet VARCHAR(255) NOT NULL,
  tx_hash VARCHAR(255) NOT NULL,
  chain VARCHAR(50) NOT NULL,
  network_name VARCHAR(100),
  crypto_currency VARCHAR(20) NOT NULL,
  crypto_amount DECIMAL(36,18) NOT NULL DEFAULT 0,
  usd_value DECIMAL(18,2) NOT NULL DEFAULT 0,
  price_at_purchase DECIMAL(18,8) NOT NULL DEFAULT 0,
  price_source VARCHAR(50),
  price_lock_status VARCHAR(20) DEFAULT 'active',
  price_lock_expires_at TIMESTAMPTZ,
  tier_at_purchase INTEGER REFERENCES tiers(id),
  tier_name VARCHAR(50),
  tier_price DECIMAL(18,8),
  tokens_allocated DECIMAL(36,8) NOT NULL DEFAULT 0,
  status VARCHAR(30) NOT NULL DEFAULT 'intent',
  payment_match_status VARCHAR(30) DEFAULT 'exact',
  token_name VARCHAR(100),
  contract_address VARCHAR(255),
  is_known_token BOOLEAN DEFAULT true,
  referred_by_code VARCHAR(20),
  buyer_country VARCHAR(100),
  buyer_country_code VARCHAR(10),
  buyer_state VARCHAR(100),
  buyer_city VARCHAR(100),
  buyer_ip_hash VARCHAR(64),
  resolution VARCHAR(50),
  resolved_by VARCHAR(100),
  resolved_at TIMESTAMPTZ,
  webhook_received_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  day_gmt4 DATE,
  week_gmt4 VARCHAR(10),
  month_gmt4 VARCHAR(7),
  UNIQUE(tx_hash, chain),
  CONSTRAINT purchases_tx_hash_unique UNIQUE (tx_hash)
);
CREATE INDEX IF NOT EXISTS idx_purchases_wallet ON purchases(buyer_wallet);
CREATE INDEX IF NOT EXISTS idx_purchases_status ON purchases(status);
CREATE INDEX IF NOT EXISTS idx_purchases_tier ON purchases(tier_at_purchase);
CREATE INDEX IF NOT EXISTS idx_purchases_created ON purchases(created_at);

-- ── Table 3: buyers ──
CREATE TABLE IF NOT EXISTS buyers (
  buyer_wallet VARCHAR(255) PRIMARY KEY,
  referral_code VARCHAR(20) UNIQUE NOT NULL,
  referred_by_wallet VARCHAR(255),
  referred_by_code VARCHAR(20),
  country VARCHAR(100),
  country_code VARCHAR(10),
  state VARCHAR(100),
  city VARCHAR(100),
  tag VARCHAR(50),
  btc_deposit_address VARCHAR(100),
  btc_address_index INTEGER,
  total_purchases INTEGER NOT NULL DEFAULT 0,
  total_usd_spent DECIMAL(18,2) NOT NULL DEFAULT 0,
  total_tokens DECIMAL(36,8) NOT NULL DEFAULT 0,
  total_referral_purchases INTEGER NOT NULL DEFAULT 0,
  total_referral_volume_usd DECIMAL(18,2) NOT NULL DEFAULT 0,
  total_referral_earnings_usd DECIMAL(18,2) NOT NULL DEFAULT 0,
  total_referral_earnings_tokens DECIMAL(36,8) NOT NULL DEFAULT 0,
  total_terminal_credits_usd DECIMAL(18,2) NOT NULL DEFAULT 0,
  total_bonus_tokens DECIMAL(36,8) NOT NULL DEFAULT 0,
  total_tokens_burned DECIMAL(36,8) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_buyers_referral_code ON buyers(referral_code);
CREATE INDEX IF NOT EXISTS idx_buyers_referred_by ON buyers(referred_by_wallet);

-- ── Table 4: price_cache ──
CREATE TABLE IF NOT EXISTS price_cache (
  crypto VARCHAR(20) PRIMARY KEY,
  usd_price DECIMAL(24,10) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Table 5: referrals ──
CREATE TABLE IF NOT EXISTS referrals (
  id SERIAL PRIMARY KEY,
  referrer_wallet VARCHAR(255) NOT NULL,
  referrer_code VARCHAR(20) NOT NULL,
  referred_wallet VARCHAR(255) NOT NULL UNIQUE,
  referred_by_code VARCHAR(20) NOT NULL,
  has_purchased BOOLEAN NOT NULL DEFAULT false,
  first_purchase_at TIMESTAMPTZ,
  total_purchases INTEGER NOT NULL DEFAULT 0,
  total_volume_usd DECIMAL(18,2) NOT NULL DEFAULT 0,
  referrer_bonus_usd DECIMAL(18,2) NOT NULL DEFAULT 0,
  referrer_terminal_credits DECIMAL(18,2) NOT NULL DEFAULT 0,
  referrer_bonus_tokens DECIMAL(36,8) NOT NULL DEFAULT 0,
  referrer_tokens_burned DECIMAL(36,8) NOT NULL DEFAULT 0,
  buyer_bonus_usd DECIMAL(18,2) NOT NULL DEFAULT 0,
  buyer_terminal_credits DECIMAL(18,2) NOT NULL DEFAULT 0,
  buyer_bonus_tokens DECIMAL(36,8) NOT NULL DEFAULT 0,
  buyer_tokens_burned DECIMAL(36,8) NOT NULL DEFAULT 0,
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_wallet);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer_code ON referrals(referrer_code);

-- ── Table 6: terminal_credits ──
CREATE TABLE IF NOT EXISTS terminal_credits (
  id SERIAL PRIMARY KEY,
  wallet VARCHAR(255) NOT NULL,
  amount_usd DECIMAL(18,2) NOT NULL,
  source VARCHAR(50) NOT NULL,
  source_purchase_id INTEGER REFERENCES purchases(id),
  remaining_amount DECIMAL(18,2) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_terminal_credits_wallet ON terminal_credits(wallet);

-- ── Table 7: bonus_allocations ──
CREATE TABLE IF NOT EXISTS bonus_allocations (
  id SERIAL PRIMARY KEY,
  wallet VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL,
  source_purchase_id INTEGER REFERENCES purchases(id),
  bonus_usd_value DECIMAL(18,2) NOT NULL,
  bonus_tokens DECIMAL(36,8) NOT NULL,
  tier_at_bonus INTEGER REFERENCES tiers(id),
  tier_price DECIMAL(18,8) NOT NULL,
  tokens_burned DECIMAL(36,8) NOT NULL DEFAULT 0,
  terminal_credits_usd DECIMAL(18,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bonus_allocations_wallet ON bonus_allocations(wallet);
CREATE INDEX IF NOT EXISTS idx_bonus_allocations_tier ON bonus_allocations(tier_at_bonus);

-- ── Table 8: burn_log ──
CREATE TABLE IF NOT EXISTS burn_log (
  id SERIAL PRIMARY KEY,
  source VARCHAR(50) NOT NULL,
  source_id INTEGER,
  tokens_burned DECIMAL(36,8) NOT NULL,
  burn_value_usd DECIMAL(18,2) NOT NULL,
  tier_at_burn INTEGER REFERENCES tiers(id),
  tier_price DECIMAL(18,8) NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Table 9: claims ──
-- UNIQUE(buyer_wallet, tier_id) physically prevents double claims.
CREATE TABLE IF NOT EXISTS claims (
  id SERIAL PRIMARY KEY,
  buyer_wallet VARCHAR(255) NOT NULL,
  tier_id INTEGER NOT NULL REFERENCES tiers(id),
  tier_name VARCHAR(50),
  total_purchased_tokens DECIMAL(36,8) NOT NULL DEFAULT 0,
  tge_percentage DECIMAL(5,2) NOT NULL,
  claimable_tokens DECIMAL(36,8) NOT NULL DEFAULT 0,
  bonus_tokens_claimable DECIMAL(36,8) NOT NULL DEFAULT 0,
  total_claimable DECIMAL(36,8) NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'eligible',
  claimed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(buyer_wallet, tier_id)
);
CREATE INDEX IF NOT EXISTS idx_claims_wallet ON claims(buyer_wallet);

-- ── Table 10: daily_stats ──
CREATE TABLE IF NOT EXISTS daily_stats (
  id SERIAL PRIMARY KEY,
  date_gmt4 DATE NOT NULL UNIQUE,
  total_raised_usd DECIMAL(18,2) NOT NULL DEFAULT 0,
  total_purchases INTEGER NOT NULL DEFAULT 0,
  total_buyers INTEGER NOT NULL DEFAULT 0,
  new_buyers INTEGER NOT NULL DEFAULT 0,
  tokens_sold DECIMAL(36,8) NOT NULL DEFAULT 0,
  tokens_burned DECIMAL(36,8) NOT NULL DEFAULT 0,
  terminal_credits_issued DECIMAL(18,2) NOT NULL DEFAULT 0,
  eth_volume DECIMAL(18,2) NOT NULL DEFAULT 0,
  eth_tx_count INTEGER NOT NULL DEFAULT 0,
  usdt_volume DECIMAL(18,2) NOT NULL DEFAULT 0,
  usdt_tx_count INTEGER NOT NULL DEFAULT 0,
  usdc_volume DECIMAL(18,2) NOT NULL DEFAULT 0,
  usdc_tx_count INTEGER NOT NULL DEFAULT 0,
  bnb_volume DECIMAL(18,2) NOT NULL DEFAULT 0,
  bnb_tx_count INTEGER NOT NULL DEFAULT 0,
  sol_volume DECIMAL(18,2) NOT NULL DEFAULT 0,
  sol_tx_count INTEGER NOT NULL DEFAULT 0,
  btc_volume DECIMAL(18,2) NOT NULL DEFAULT 0,
  btc_tx_count INTEGER NOT NULL DEFAULT 0,
  tron_usdt_volume DECIMAL(18,2) NOT NULL DEFAULT 0,
  tron_usdt_tx_count INTEGER NOT NULL DEFAULT 0,
  trx_volume DECIMAL(18,2) NOT NULL DEFAULT 0,
  trx_tx_count INTEGER NOT NULL DEFAULT 0,
  other_volume DECIMAL(18,2) NOT NULL DEFAULT 0,
  other_tx_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Table 11: weekly_stats ──
CREATE TABLE IF NOT EXISTS weekly_stats (
  id SERIAL PRIMARY KEY,
  week_start_gmt4 DATE NOT NULL UNIQUE,
  week_end_gmt4 DATE NOT NULL,
  total_raised_usd DECIMAL(18,2) NOT NULL DEFAULT 0,
  total_purchases INTEGER NOT NULL DEFAULT 0,
  total_buyers INTEGER NOT NULL DEFAULT 0,
  new_buyers INTEGER NOT NULL DEFAULT 0,
  tokens_sold DECIMAL(36,8) NOT NULL DEFAULT 0,
  tokens_burned DECIMAL(36,8) NOT NULL DEFAULT 0,
  terminal_credits_issued DECIMAL(18,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Table 12: monthly_stats ──
CREATE TABLE IF NOT EXISTS monthly_stats (
  id SERIAL PRIMARY KEY,
  month_gmt4 VARCHAR(7) NOT NULL UNIQUE,
  total_raised_usd DECIMAL(18,2) NOT NULL DEFAULT 0,
  total_purchases INTEGER NOT NULL DEFAULT 0,
  total_buyers INTEGER NOT NULL DEFAULT 0,
  new_buyers INTEGER NOT NULL DEFAULT 0,
  tokens_sold DECIMAL(36,8) NOT NULL DEFAULT 0,
  tokens_burned DECIMAL(36,8) NOT NULL DEFAULT 0,
  terminal_credits_issued DECIMAL(18,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Table 13: audit_log ──
-- Every change to every record — who, when, why, old/new values. NEVER skip this.
CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  event_type VARCHAR(50) NOT NULL,
  related_purchase_id INTEGER,
  related_wallet VARCHAR(255),
  related_tx_hash VARCHAR(255),
  old_value JSONB,
  new_value JSONB,
  reason TEXT,
  performed_by VARCHAR(100) NOT NULL DEFAULT 'system',
  ip_address VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_event_type ON audit_log(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_wallet ON audit_log(related_wallet);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

-- ── Table 14: reconciliation_results ──
CREATE TABLE IF NOT EXISTS reconciliation_results (
  id SERIAL PRIMARY KEY,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  chain VARCHAR(50) NOT NULL,
  total_on_chain_txs INTEGER NOT NULL DEFAULT 0,
  total_database_records INTEGER NOT NULL DEFAULT 0,
  matched INTEGER NOT NULL DEFAULT 0,
  unmatched_incoming INTEGER NOT NULL DEFAULT 0,
  unmatched_records INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(30) NOT NULL,
  discrepancy_details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Table 15: tier_snapshots ──
-- Frozen data for Merkle root generation at tier close.
CREATE TABLE IF NOT EXISTS tier_snapshots (
  id SERIAL PRIMARY KEY,
  tier_id INTEGER NOT NULL REFERENCES tiers(id),
  snapshot_data JSONB NOT NULL,
  merkle_root VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Table 16: balance_snapshots ──
CREATE TABLE IF NOT EXISTS balance_snapshots (
  id SERIAL PRIMARY KEY,
  chain VARCHAR(50) NOT NULL,
  wallet_address VARCHAR(255) NOT NULL,
  on_chain_balance DECIMAL(36,18) NOT NULL DEFAULT 0,
  expected_balance DECIMAL(36,18) NOT NULL DEFAULT 0,
  difference DECIMAL(36,18) NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'match',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Table 17: withdrawals ──
CREATE TABLE IF NOT EXISTS withdrawals (
  id SERIAL PRIMARY KEY,
  tx_hash VARCHAR(255),
  chain VARCHAR(50) NOT NULL,
  crypto_currency VARCHAR(20) NOT NULL,
  crypto_amount DECIMAL(36,18) NOT NULL,
  usd_value DECIMAL(18,2) NOT NULL,
  recipient VARCHAR(255) NOT NULL,
  purpose VARCHAR(100) NOT NULL,
  notes TEXT,
  created_by VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Table 18: otc_allocations ──
CREATE TABLE IF NOT EXISTS otc_allocations (
  id SERIAL PRIMARY KEY,
  investor_name VARCHAR(255) NOT NULL,
  investor_wallet VARCHAR(255) NOT NULL,
  daily_amount_usd DECIMAL(18,2) NOT NULL,
  total_allocated_usd DECIMAL(18,2) NOT NULL,
  total_tokens_allocated DECIMAL(36,8) NOT NULL,
  tier_at_allocation INTEGER NOT NULL REFERENCES tiers(id),
  tier_price DECIMAL(18,8) NOT NULL,
  tokens_today DECIMAL(36,8) NOT NULL DEFAULT 0,
  usd_today DECIMAL(18,2) NOT NULL DEFAULT 0,
  drip_start_time TIMESTAMPTZ NOT NULL,
  drip_end_time TIMESTAMPTZ NOT NULL,
  drip_released_usd DECIMAL(18,2) NOT NULL DEFAULT 0,
  drip_status VARCHAR(20) NOT NULL DEFAULT 'active',
  payment_method VARCHAR(50),
  payment_reference VARCHAR(255),
  notes TEXT,
  day_gmt4 DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_otc_wallet ON otc_allocations(investor_wallet);
CREATE INDEX IF NOT EXISTS idx_otc_status ON otc_allocations(drip_status);

-- ── Table 19: otc_drip_log ──
CREATE TABLE IF NOT EXISTS otc_drip_log (
  id SERIAL PRIMARY KEY,
  otc_allocation_id INTEGER NOT NULL REFERENCES otc_allocations(id),
  amount_usd DECIMAL(18,2) NOT NULL,
  tokens DECIMAL(36,8) NOT NULL,
  tier_at_drip INTEGER NOT NULL REFERENCES tiers(id),
  tier_price DECIMAL(18,8) NOT NULL,
  cumulative_released DECIMAL(18,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Table 20: admin_overrides ──
-- History of every manual admin change (set + clear actions).
CREATE TABLE IF NOT EXISTS admin_overrides (
  id SERIAL PRIMARY KEY,
  key VARCHAR(100) NOT NULL,
  value TEXT,
  action VARCHAR(10) NOT NULL,
  reason TEXT NOT NULL,
  performed_by VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Table 21: display_overrides ──
-- Active display settings. Affects DISPLAY ONLY — TGE and reconciliation always use real data.
CREATE TABLE IF NOT EXISTS display_overrides (
  key VARCHAR(100) PRIMARY KEY,
  value TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  reason TEXT NOT NULL,
  set_by VARCHAR(100) NOT NULL,
  set_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Table 22: notifications ──
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  wallet VARCHAR(255) NOT NULL,
  type VARCHAR(50) NOT NULL,
  title VARCHAR(200) NOT NULL,
  message TEXT NOT NULL,
  is_read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notif_wallet ON notifications(wallet);

-- ══════════════════════════════════════════════════
-- CMS — content the admin can manage without code changes
-- ══════════════════════════════════════════════════

-- ── Table 23: cms_banners ──
CREATE TABLE IF NOT EXISTS cms_banners (
  id SERIAL PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  subtitle TEXT,
  cta_text VARCHAR(100),
  cta_link VARCHAR(500),
  image_url TEXT,
  image_url_desktop TEXT,
  image_url_mobile TEXT,
  countdown_end TIMESTAMPTZ,
  show_countdown BOOLEAN DEFAULT false,
  bg_color VARCHAR(20),
  bg_style TEXT DEFAULT 'gradient',
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cms_banners_active ON cms_banners(is_active, sort_order);

-- ── Table 24: cms_faqs ──
CREATE TABLE IF NOT EXISTS cms_faqs (
  id SERIAL PRIMARY KEY,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  category VARCHAR(50) DEFAULT 'general',
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cms_faqs_active ON cms_faqs(is_active, category, sort_order);

-- ── Table 25: cms_blog_posts ──
CREATE TABLE IF NOT EXISTS cms_blog_posts (
  id SERIAL PRIMARY KEY,
  title VARCHAR(300) NOT NULL,
  slug VARCHAR(300) NOT NULL UNIQUE,
  excerpt TEXT,
  content TEXT NOT NULL,
  cover_image_url TEXT,
  category VARCHAR(50) DEFAULT 'updates',
  author VARCHAR(100) DEFAULT 'FlowDex Team',
  is_published BOOLEAN DEFAULT false,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cms_blog_published ON cms_blog_posts(is_published, published_at);

-- ── Table 26: cms_pages ──
-- Editable page content (section titles, descriptions, any text block), keyed by page.section.field.
CREATE TABLE IF NOT EXISTS cms_pages (
  id SERIAL PRIMARY KEY,
  page VARCHAR(50) NOT NULL,
  section VARCHAR(50) NOT NULL,
  field VARCHAR(50) NOT NULL,
  value TEXT NOT NULL,
  UNIQUE(page, section, field),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cms_pages_page ON cms_pages(page);

-- ── Table 27: cms_media ──
CREATE TABLE IF NOT EXISTS cms_media (
  id SERIAL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  type VARCHAR(50) NOT NULL,
  url TEXT NOT NULL,
  alt_text VARCHAR(300),
  category VARCHAR(50) DEFAULT 'general',
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cms_media_category ON cms_media(category, is_active, sort_order);

-- ── Table 28: cms_team ──
CREATE TABLE IF NOT EXISTS cms_team (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  role VARCHAR(100) NOT NULL,
  bio TEXT,
  photo_url TEXT,
  linkedin_url VARCHAR(500),
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cms_team_active ON cms_team(is_active, sort_order);

-- ── Table 29: email_subscribers ──
CREATE TABLE IF NOT EXISTS email_subscribers (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  subscribed_at TIMESTAMPTZ DEFAULT NOW(),
  is_active BOOLEAN DEFAULT true
);

-- ── Table 30: admin_backup_codes ──
-- 2FA backup codes — single global admin, so no per-user column.
CREATE TABLE IF NOT EXISTS admin_backup_codes (
  id SERIAL PRIMARY KEY,
  code_hash VARCHAR(255) NOT NULL,
  is_used BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  used_at TIMESTAMPTZ
);
