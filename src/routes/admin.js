// ══════════════════════════════════════════════════
// src/routes/admin.js
// Admin dashboard + OTC + overrides + claims + geo + burns + recovery + reports
// ══════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const pool = require('../db/pool');
const { adminAuth } = require('../middleware/admin-auth');
const { verify2FA, generate2FASetup } = require('../middleware/admin-2fa');
const { loginRateLimit, recordFailedLogin, recordSuccessfulLogin } = require('../middleware/admin-login-rate-limit');
const { logAudit } = require('../services/audit-service');
const { createOtcAllocation, processOtcDrip } = require('../services/otc-service');
const { getSupplyStatus } = require('../services/supply-service');
const { scanForMissedPayments } = require('../services/payment-recovery');
const { confirmPayment } = require('../services/payment-service');
const { getWebhookHealth } = require('../services/webhook-health');
const { runReconciliation } = require('../jobs/reconciliation');

// ══ AUTH ══

// Checks a plaintext backup code against the stored bcrypt hashes and
// consumes it (one-time use) on match. O(unused codes) bcrypt compares —
// there's no way to index a salted hash for direct lookup, and the unused
// set is small (starts at 10 per generation).
async function verifyAndConsumeBackupCode(code) {
  if (!code) return false;
  const result = await pool.query('SELECT id, code_hash FROM admin_backup_codes WHERE is_used = false');
  for (const row of result.rows) {
    const match = await bcrypt.compare(code, row.code_hash);
    if (match) {
      await pool.query('UPDATE admin_backup_codes SET is_used = true, used_at = NOW() WHERE id = $1', [row.id]);
      return true;
    }
  }
  return false;
}

function generateBackupCode() {
  // Avoid ambiguous characters (0/O, 1/I/L) for readability when typed by hand.
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[bytes[i] % chars.length];
  return code;
}

// POST /admin/login — username + plaintext password + TOTP 2FA (or a backup code)
router.post('/login', loginRateLimit, async (req, res) => {
  try {
    const { username, password, totp_code, backup_code } = req.body;
    if (username !== process.env.ADMIN_USERNAME) {
      recordFailedLogin(req);
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    // 🔴 ADMIN_PASSWORD must be set in .env (plaintext)
    const validPassword = (password === process.env.ADMIN_PASSWORD);
    if (!validPassword) {
      recordFailedLogin(req);
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const secondFactorOk = backup_code ? await verifyAndConsumeBackupCode(backup_code) : verify2FA(totp_code);
    if (!secondFactorOk) {
      recordFailedLogin(req);
      return res.status(401).json({
        success: false,
        error: backup_code ? 'Invalid or already-used backup code' : 'Invalid 2FA code',
      });
    }

    recordSuccessfulLogin(req);
    const token = jwt.sign({ username, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '24h' });
    await logAudit('admin_login', null, null, null, null, { username, via: backup_code ? 'backup_code' : 'totp' }, 'Admin logged in', username, req.ip);
    res.json({ success: true, token });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /admin/change-password — { current_password, new_password }
// Only persists in memory until the next redeploy — the admin must also
// update the ADMIN_PASSWORD env var (e.g. in Coolify) for it to stick.
router.post('/change-password', adminAuth, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ success: false, error: 'current_password and new_password are required' });
    }
    if (current_password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ success: false, error: 'Current password is incorrect' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ success: false, error: 'New password must be at least 8 characters' });
    }

    process.env.ADMIN_PASSWORD = new_password;

    await logAudit(
      'admin_password_changed', null, null, null, null, null,
      'Admin password changed — in-memory only, update the ADMIN_PASSWORD env var (e.g. in Coolify) to persist across redeploys',
      req.admin.username, req.ip
    );
    res.json({
      success: true,
      message: 'Password changed. This only persists until the next redeploy — update your Coolify env var to make it permanent.',
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /admin/2fa/generate-backup-codes — regenerates the backup code set,
// invalidating any previous batch. Returns the plain codes ONCE.
router.post('/2fa/generate-backup-codes', adminAuth, async (req, res) => {
  try {
    const codes = Array.from({ length: 10 }, generateBackupCode);

    await pool.query('DELETE FROM admin_backup_codes');
    for (const code of codes) {
      const hash = await bcrypt.hash(code, 10);
      await pool.query('INSERT INTO admin_backup_codes (code_hash) VALUES ($1)', [hash]);
    }

    await logAudit(
      'admin_backup_codes_generated', null, null, null, null, { count: codes.length },
      'Admin generated new 2FA backup codes — previous batch invalidated', req.admin.username, req.ip
    );
    res.json({ success: true, codes });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /admin/2fa-setup — one-time: returns QR code to scan with Google Authenticator
router.get('/2fa-setup', async (req, res) => {
  try {
    const setup = await generate2FASetup();
    res.json({ success: true, ...setup });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ══ DASHBOARD ══

router.get('/dashboard', adminAuth, async (req, res) => {
  try {
    const raised = await pool.query('SELECT COALESCE(SUM(total_raised_usd),0) as t FROM tiers');
    const buyers = await pool.query('SELECT COUNT(*) as t FROM buyers');
    const activeTier = await pool.query('SELECT * FROM tiers WHERE is_active = true LIMIT 1');
    const lastReconciliation = await pool.query('SELECT * FROM reconciliation_results ORDER BY created_at DESC LIMIT 1');
    const lastSnapshot = await pool.query('SELECT * FROM balance_snapshots ORDER BY created_at DESC LIMIT 1');
    const webhookHealth = getWebhookHealth();

    res.json({
      success: true,
      total_raised: parseFloat(raised.rows[0].t),
      total_buyers: parseInt(buyers.rows[0].t),
      active_tier: activeTier.rows[0] || null,
      last_reconciliation: lastReconciliation.rows[0] || null,
      last_balance_snapshot: lastSnapshot.rows[0] || null,
      webhook_health: webhookHealth,
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /admin/supply — full token supply accounting
router.get('/supply', adminAuth, async (req, res) => {
  try {
    const status = await getSupplyStatus();
    res.json(status);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /admin/webhook-health
router.get('/webhook-health', adminAuth, (req, res) => {
  res.json(getWebhookHealth());
});

// ══ PURCHASE MANAGEMENT ══

router.get('/purchases', adminAuth, async (req, res) => {
  try {
    const { tier, currency, status, from, to } = req.query;
    const conditions = [];
    const params = [];
    let i = 1;

    if (tier) { conditions.push(`tier_at_purchase = $${i++}`); params.push(tier); }
    if (currency) { conditions.push(`crypto_currency = $${i++}`); params.push(currency); }
    if (status) { conditions.push(`status = $${i++}`); params.push(status); }
    if (from) { conditions.push(`created_at >= $${i++}`); params.push(from); }
    if (to) { conditions.push(`created_at <= $${i++}`); params.push(to); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const result = await pool.query(
      `SELECT * FROM purchases ${where} ORDER BY created_at DESC LIMIT 500`, params
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /admin/purchases/export — CSV export
router.get('/purchases/export', adminAuth, async (req, res) => {
  try {
    const purchases = await pool.query('SELECT * FROM purchases ORDER BY created_at DESC');
    const rows = purchases.rows;
    if (rows.length === 0) return res.status(404).json({ error: 'No purchases to export' });

    const headers = Object.keys(rows[0]).join(',');
    const csvRows = rows.map(r => Object.values(r).map(v => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(','));
    const csv = headers + '\n' + csvRows.join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=flowdex_purchases_' + new Date().toISOString().split('T')[0] + '.csv');
    res.send(csv);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /admin/purchases/needs-pricing — unknown tokens awaiting admin pricing
router.get('/purchases/needs-pricing', adminAuth, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM purchases WHERE status = 'needs_pricing' ORDER BY created_at DESC");
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /admin/purchase/:id/set-price — admin sets USD value for unknown token
router.post('/purchase/:id/set-price', adminAuth, async (req, res) => {
  try {
    const { usd_value } = req.body;
    const id = req.params.id;

    if (!usd_value || usd_value <= 0) {
      return res.status(400).json({ success: false, error: 'Valid usd_value required' });
    }

    const purchase = await pool.query('SELECT * FROM purchases WHERE id = $1', [id]);
    if (purchase.rows.length === 0) return res.status(404).json({ error: 'Not found' });

    const p = purchase.rows[0];
    if (p.status !== 'needs_pricing') {
      return res.status(400).json({ error: 'Purchase does not need pricing. Status: ' + p.status });
    }

    const tier = await pool.query('SELECT * FROM tiers WHERE id = $1', [p.tier_at_purchase]);
    const tierPrice = parseFloat(tier.rows[0].price);
    const tokensAllocated = parseFloat(usd_value) / tierPrice;
    const pricePerUnit = parseFloat(usd_value) / parseFloat(p.crypto_amount);

    await pool.query(`
      UPDATE purchases SET
        usd_value = $1, price_at_purchase = $2, price_source = 'admin_manual',
        tokens_allocated = $3, status = 'pending', payment_match_status = 'exact',
        resolution = 'admin_priced', resolved_by = $4, resolved_at = NOW()
      WHERE id = $5
    `, [usd_value, pricePerUnit, tokensAllocated, req.admin.username, id]);

    await confirmPayment(id, parseFloat(p.crypto_amount));

    await logAudit('admin_override', id, p.buyer_wallet, p.tx_hash,
      { status: 'needs_pricing', usd_value: 0 },
      { status: 'confirmed', usd_value, tokens: tokensAllocated, price_per_unit: pricePerUnit },
      'Admin set USD price for unknown token: ' + p.crypto_currency,
      req.admin.username, req.ip);

    res.json({
      success: true, purchase_id: id, token: p.crypto_currency, amount: p.crypto_amount,
      usd_value, price_per_unit: pricePerUnit, tokens_allocated: tokensAllocated,
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /admin/purchase/:id/resolve — resolve a flagged transaction
router.post('/purchase/:id/resolve', adminAuth, async (req, res) => {
  try {
    const { resolution, reason } = req.body;
    if (!reason || reason.trim() === '') {
      return res.status(400).json({ success: false, error: 'Reason is required' });
    }
    if (!resolution) {
      return res.status(400).json({ success: false, error: 'Resolution is required' });
    }

    const purchase = await pool.query('SELECT * FROM purchases WHERE id = $1', [req.params.id]);
    if (purchase.rows.length === 0) return res.status(404).json({ success: false, error: 'Not found' });
    const p = purchase.rows[0];

    await pool.query(
      `UPDATE purchases SET resolution = $1, resolved_by = $2, resolved_at = NOW() WHERE id = $3`,
      [resolution, req.admin.username, req.params.id]
    );

    await logAudit('admin_override', p.id, p.buyer_wallet, p.tx_hash,
      { status: p.status }, { resolution, reason }, reason, req.admin.username, req.ip);

    res.json({ success: true, purchase_id: p.id, resolution });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ══ BUYERS ══

router.get('/buyers', adminAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM buyers ORDER BY total_usd_spent DESC LIMIT 500');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/buyer/:wallet', adminAuth, async (req, res) => {
  try {
    const wallet = req.params.wallet.toLowerCase();
    const buyer = await pool.query('SELECT * FROM buyers WHERE buyer_wallet = $1', [wallet]);
    if (buyer.rows.length === 0) return res.status(404).json({ success: false, error: 'Buyer not found' });

    const purchases = await pool.query('SELECT * FROM purchases WHERE buyer_wallet = $1 ORDER BY created_at DESC', [wallet]);
    const referrals = await pool.query('SELECT * FROM referrals WHERE referrer_wallet = $1', [wallet]);
    const claims = await pool.query('SELECT * FROM claims WHERE buyer_wallet = $1', [wallet]);
    const credits = await pool.query('SELECT * FROM terminal_credits WHERE wallet = $1', [wallet]);

    res.json({
      success: true,
      buyer: buyer.rows[0],
      purchases: purchases.rows,
      referrals: referrals.rows,
      claims: claims.rows,
      terminal_credits: credits.rows,
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ══ TIERS ══

router.get('/tiers', adminAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tiers ORDER BY id');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ══ REFERRALS ══

router.get('/referrals', adminAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM referrals ORDER BY created_at DESC LIMIT 500');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ══ CLAIMS ══

router.get('/claims', adminAuth, async (req, res) => {
  try {
    const { tier, status, from, to } = req.query;
    const conditions = [];
    const params = [];
    let i = 1;
    if (tier) { conditions.push(`tier_id = $${i++}`); params.push(tier); }
    if (status) { conditions.push(`status = $${i++}`); params.push(status); }
    if (from) { conditions.push(`created_at >= $${i++}`); params.push(from); }
    if (to) { conditions.push(`created_at <= $${i++}`); params.push(to); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const result = await pool.query(`SELECT * FROM claims ${where} ORDER BY created_at DESC LIMIT 500`, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/claims/stats', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT tier_id, tier_name,
        COUNT(*) as total_claims,
        COUNT(*) FILTER (WHERE status = 'claimed') as claimed_count,
        COUNT(*) FILTER (WHERE status = 'eligible') as eligible_count,
        SUM(total_claimable) as total_claimable,
        SUM(total_claimable) FILTER (WHERE status = 'claimed') as total_claimed
      FROM claims GROUP BY tier_id, tier_name ORDER BY tier_id
    `);
    res.json(result.rows.map(r => ({
      ...r,
      claim_rate_pct: r.total_claims > 0 ? ((r.claimed_count / r.total_claims) * 100).toFixed(2) : '0.00',
    })));
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ══ AUDIT LOG ══

router.get('/audit-log', adminAuth, async (req, res) => {
  try {
    const { event_type, wallet, from, to } = req.query;
    const conditions = [];
    const params = [];
    let i = 1;
    if (event_type) { conditions.push(`event_type = $${i++}`); params.push(event_type); }
    if (wallet) { conditions.push(`related_wallet = $${i++}`); params.push(wallet.toLowerCase()); }
    if (from) { conditions.push(`created_at >= $${i++}`); params.push(from); }
    if (to) { conditions.push(`created_at <= $${i++}`); params.push(to); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const result = await pool.query(`SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT 500`, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ══ RECONCILIATION & BALANCE ══

router.get('/reconciliation', adminAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM reconciliation_results ORDER BY created_at DESC LIMIT 100');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/reconciliation/run', adminAuth, async (req, res) => {
  try {
    const results = await runReconciliation();
    res.json({ success: true, results });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/balance', adminAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM balance_snapshots ORDER BY created_at DESC LIMIT 100');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ══ WITHDRAWALS ══

router.get('/withdrawals', adminAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM withdrawals ORDER BY created_at DESC LIMIT 500');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/withdrawals', adminAuth, async (req, res) => {
  try {
    const { tx_hash, chain, crypto_currency, crypto_amount, usd_value, recipient, purpose, notes } = req.body;
    if (!chain || !crypto_currency || !crypto_amount || !usd_value || !recipient || !purpose) {
      return res.status(400).json({ success: false, error: 'chain, crypto_currency, crypto_amount, usd_value, recipient, purpose are required' });
    }

    const result = await pool.query(`
      INSERT INTO withdrawals (tx_hash, chain, crypto_currency, crypto_amount, usd_value, recipient, purpose, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id
    `, [tx_hash || null, chain, crypto_currency, crypto_amount, usd_value, recipient, purpose, notes || null, req.admin.username]);

    await logAudit('withdrawal_recorded', null, recipient, tx_hash || null, null,
      { chain, crypto_currency, crypto_amount, usd_value, purpose }, 'Withdrawal recorded', req.admin.username, req.ip);

    res.json({ success: true, withdrawal_id: result.rows[0].id });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ══ GEO STATS ══

router.get('/stats/by-country', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT buyer_country as country, buyer_country_code as country_code,
        COUNT(DISTINCT buyer_wallet) as buyers, SUM(usd_value) as volume
      FROM purchases WHERE status = 'confirmed' AND buyer_country IS NOT NULL
      GROUP BY buyer_country, buyer_country_code ORDER BY volume DESC
    `);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/stats/by-city', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT buyer_city as city, buyer_country as country,
        COUNT(DISTINCT buyer_wallet) as buyers, SUM(usd_value) as volume
      FROM purchases WHERE status = 'confirmed' AND buyer_city IS NOT NULL
      GROUP BY buyer_city, buyer_country ORDER BY volume DESC
    `);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/stats/geo-map', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT buyer_country_code as country_code, buyer_country as country,
        COUNT(DISTINCT buyer_wallet) as buyers, SUM(usd_value) as volume
      FROM purchases WHERE status = 'confirmed' AND buyer_country_code IS NOT NULL
      GROUP BY buyer_country_code, buyer_country
    `);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ══ OTC INVESTOR DRIP ══

router.post('/otc/allocate', adminAuth, async (req, res) => {
  try {
    const { investor_name, investor_wallet, amount_usd, payment_reference, notes } = req.body;
    if (!investor_name || !investor_wallet) {
      return res.status(400).json({ success: false, error: 'investor_name and investor_wallet are required' });
    }
    if (!amount_usd || amount_usd <= 0) {
      return res.status(400).json({ success: false, error: 'Amount must be greater than $0' });
    }

    const result = await createOtcAllocation(investor_name, investor_wallet.toLowerCase(), parseFloat(amount_usd), payment_reference, notes);
    res.json({ success: true, allocation_id: result.id, tokens: result.tokens, drip_ends_at: result.drip_ends_at });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/otc/today', adminAuth, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM otc_allocations WHERE drip_status = 'active' ORDER BY drip_start_time DESC");
    const rows = result.rows.map(a => {
      const allocated = parseFloat(a.daily_amount_usd);
      const released = parseFloat(a.drip_released_usd);
      const remaining = allocated - released;
      const pct = allocated > 0 ? ((released / allocated) * 100).toFixed(1) : '0.0';
      return {
        id: a.id, investor_name: a.investor_name, investor_wallet: a.investor_wallet,
        allocation: allocated, released, remaining, progress: pct + '%',
        estimated_completion: a.drip_end_time,
      };
    });
    res.json(rows);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/otc/history', adminAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM otc_allocations ORDER BY created_at DESC LIMIT 500');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/otc/pause/:id', adminAuth, async (req, res) => {
  try {
    await pool.query("UPDATE otc_allocations SET drip_status = 'paused' WHERE id = $1 AND drip_status = 'active'", [req.params.id]);
    await logAudit('otc_paused', null, null, null, { status: 'active' }, { status: 'paused' }, 'OTC drip paused by admin', req.admin.username, req.ip);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/otc/resume/:id', adminAuth, async (req, res) => {
  try {
    // Shift drip_start_time/drip_end_time forward by the paused duration so the remaining
    // amount releases over the remaining time, not instantly.
    const alloc = await pool.query('SELECT * FROM otc_allocations WHERE id = $1', [req.params.id]);
    if (alloc.rows.length === 0) return res.status(404).json({ success: false, error: 'Not found' });
    const a = alloc.rows[0];

    const originalTotalMs = new Date(a.drip_end_time).getTime() - new Date(a.drip_start_time).getTime();
    const releasedFraction = parseFloat(a.drip_released_usd) / parseFloat(a.daily_amount_usd);
    const newStart = new Date(Date.now() - releasedFraction * originalTotalMs);
    const newEnd = new Date(newStart.getTime() + originalTotalMs);

    await pool.query(
      "UPDATE otc_allocations SET drip_status = 'active', drip_start_time = $1, drip_end_time = $2 WHERE id = $3",
      [newStart, newEnd, req.params.id]
    );
    await logAudit('otc_resumed', null, null, null, { status: 'paused' }, { status: 'active' }, 'OTC drip resumed by admin', req.admin.username, req.ip);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/otc/investor/:wallet', adminAuth, async (req, res) => {
  try {
    const wallet = req.params.wallet.toLowerCase();
    const allocations = await pool.query('SELECT * FROM otc_allocations WHERE investor_wallet = $1 ORDER BY created_at DESC', [wallet]);
    const claims = await pool.query('SELECT * FROM claims WHERE buyer_wallet = $1', [wallet]);
    res.json({ success: true, allocations: allocations.rows, claims: claims.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ══ DISPLAY OVERRIDES ══

router.get('/overrides', adminAuth, async (req, res) => {
  try {
    const overrides = await pool.query('SELECT * FROM display_overrides WHERE is_active = true');
    const realTier = await pool.query('SELECT * FROM tiers WHERE is_active = true LIMIT 1');
    res.json({ success: true, overrides: overrides.rows, real_data: realTier.rows[0] || null });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/overrides/set', adminAuth, async (req, res) => {
  try {
    const { key, value, reason } = req.body;
    if (!reason || reason.trim() === '') {
      return res.status(400).json({ success: false, error: 'Reason is required for all overrides' });
    }
    if (!key) return res.status(400).json({ success: false, error: 'key is required' });

    await pool.query(`
      INSERT INTO display_overrides (key, value, is_active, reason, set_by, set_at)
      VALUES ($1,$2,true,$3,$4,NOW())
      ON CONFLICT (key) DO UPDATE SET value=$2, is_active=true, reason=$3, set_by=$4, set_at=NOW()
    `, [key, String(value), reason, req.admin.username]);

    await pool.query(
      `INSERT INTO admin_overrides (key, value, action, reason, performed_by) VALUES ($1,$2,'set',$3,$4)`,
      [key, String(value), reason, req.admin.username]
    );

    await logAudit('admin_override', null, null, null, null, { key, value, reason }, reason, req.admin.username, req.ip);
    res.json({ success: true, key, value });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/overrides/clear/:key', adminAuth, async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason || reason.trim() === '') {
      return res.status(400).json({ success: false, error: 'Reason is required for all overrides' });
    }

    await pool.query('UPDATE display_overrides SET is_active = false WHERE key = $1', [req.params.key]);
    await pool.query(
      `INSERT INTO admin_overrides (key, value, action, reason, performed_by) VALUES ($1,NULL,'clear',$2,$3)`,
      [req.params.key, reason, req.admin.username]
    );

    await logAudit('admin_override', null, null, null, { key: req.params.key, active: true }, { active: false }, reason, req.admin.username, req.ip);
    res.json({ success: true, key: req.params.key, cleared: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/overrides/history', adminAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM admin_overrides ORDER BY created_at DESC LIMIT 500');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ══ BURNS & TERMINAL CREDITS ══

router.get('/burns', adminAuth, async (req, res) => {
  try {
    const total = await pool.query('SELECT COALESCE(SUM(tokens_burned),0) as total_burned, COALESCE(SUM(burn_value_usd),0) as total_value FROM burn_log');
    const recent = await pool.query('SELECT * FROM burn_log ORDER BY created_at DESC LIMIT 200');
    res.json({ success: true, total_tokens_burned: parseFloat(total.rows[0].total_burned), total_burn_value_usd: parseFloat(total.rows[0].total_value), recent: recent.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/terminal-credits', adminAuth, async (req, res) => {
  try {
    const total = await pool.query('SELECT COALESCE(SUM(amount_usd),0) as issued, COALESCE(SUM(remaining_amount),0) as remaining FROM terminal_credits');
    const recent = await pool.query('SELECT * FROM terminal_credits ORDER BY created_at DESC LIMIT 200');
    res.json({ success: true, total_issued_usd: parseFloat(total.rows[0].issued), total_remaining_usd: parseFloat(total.rows[0].remaining), recent: recent.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ══ MISSED PAYMENT RECOVERY ══

router.post('/recovery/scan', adminAuth, async (req, res) => {
  try {
    const hoursBack = req.body.hours_back || 24;
    const result = await scanForMissedPayments(hoursBack);
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ══ FINANCIAL REPORTS ══

router.get('/report/financial', adminAuth, async (req, res) => {
  try {
    const tierData = await pool.query('SELECT * FROM tiers ORDER BY id');
    const totalRaised = await pool.query("SELECT COALESCE(SUM(total_raised_usd),0) as t FROM tiers");
    const totalBuyers = await pool.query("SELECT COUNT(*) as t FROM buyers");
    const totalPurchases = await pool.query("SELECT COUNT(*) as t FROM purchases WHERE status='confirmed'");
    const totalBurned = await pool.query("SELECT COALESCE(SUM(tokens_burned),0) as t FROM burn_log");
    const totalCredits = await pool.query("SELECT COALESCE(SUM(amount_usd),0) as t FROM terminal_credits");
    const totalOtc = await pool.query("SELECT COALESCE(SUM(total_allocated_usd),0) as t FROM otc_allocations");
    const totalWithdrawn = await pool.query("SELECT COALESCE(SUM(usd_value),0) as t FROM withdrawals");
    const byCurrency = await pool.query(
      "SELECT crypto_currency, SUM(usd_value) as vol, COUNT(*) as txs FROM purchases WHERE status='confirmed' GROUP BY crypto_currency ORDER BY vol DESC"
    );
    const byCountry = await pool.query(
      "SELECT buyer_country, COUNT(DISTINCT buyer_wallet) as buyers, SUM(usd_value) as vol FROM purchases WHERE status='confirmed' AND buyer_country IS NOT NULL GROUP BY buyer_country ORDER BY vol DESC LIMIT 20"
    );
    const supply = await getSupplyStatus();
    const withdrawals = await pool.query("SELECT purpose, SUM(usd_value) as total FROM withdrawals GROUP BY purpose ORDER BY total DESC");

    res.json({
      generated_at: new Date().toISOString(),
      summary: {
        total_raised_usd: totalRaised.rows[0].t,
        total_buyers: parseInt(totalBuyers.rows[0].t),
        total_purchases: parseInt(totalPurchases.rows[0].t),
        total_tokens_burned: totalBurned.rows[0].t,
        total_terminal_credits_issued: totalCredits.rows[0].t,
        total_otc_allocated: totalOtc.rows[0].t,
        total_withdrawn: totalWithdrawn.rows[0].t,
        net_in_treasury: parseFloat(totalRaised.rows[0].t) - parseFloat(totalWithdrawn.rows[0].t),
      },
      supply,
      tiers: tierData.rows,
      by_currency: byCurrency.rows,
      by_country: byCountry.rows,
      withdrawals_by_purpose: withdrawals.rows,
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/report/financial/csv', adminAuth, async (req, res) => {
  try {
    const purchases = await pool.query(
      "SELECT id, buyer_wallet, tx_hash, chain, crypto_currency, crypto_amount, usd_value, tier_at_purchase, tier_name, tier_price, tokens_allocated, status, buyer_country, buyer_city, referred_by_code, created_at, confirmed_at FROM purchases ORDER BY created_at DESC"
    );

    const headers = Object.keys(purchases.rows[0] || {}).join(',');
    const rows = purchases.rows.map(r => Object.values(r).map(v => '"' + String(v || '').replace(/"/g, '""') + '"').join(','));
    const csv = headers + '\n' + rows.join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=flowdex_purchases_' + new Date().toISOString().split('T')[0] + '.csv');
    res.send(csv);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports = router;
