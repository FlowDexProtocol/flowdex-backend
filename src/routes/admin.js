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
const { requireRole } = require('../middleware/require-role');
const { verify2FA, generate2FASetup, generateTotpSecret } = require('../middleware/admin-2fa');
const { loginRateLimit, recordFailedLogin, recordSuccessfulLogin } = require('../middleware/admin-login-rate-limit');
const { logAudit } = require('../services/audit-service');
const { createOtcAllocation, processOtcDrip } = require('../services/otc-service');
const { getSupplyStatus } = require('../services/supply-service');
const { scanForMissedPayments } = require('../services/payment-recovery');
const { confirmPayment } = require('../services/payment-service');
const { getWebhookHealth } = require('../services/webhook-health');
const { runReconciliation } = require('../jobs/reconciliation');

// ── Pagination + CSV helpers ──

// Reads ?page=&limit= off a request, clamped to sane bounds.
function getPagination(req) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

// Resolves a client-supplied `sort` query param against an allowlist of
// real column names — sort/order can never be interpolated raw into SQL
// (no $n placeholder works for identifiers), so anything not in the
// allowlist silently falls back to the default.
function resolveSort(req, allowlist, defaultSort) {
  const requested = req.query.sort;
  const sortKey = typeof requested === 'string' && Object.prototype.hasOwnProperty.call(allowlist, requested) ? requested : defaultSort;
  const column = allowlist[sortKey];
  const order = String(req.query.order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  return `${column} ${order}`;
}

function toCsv(rows) {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]).join(',');
  const body = rows.map((r) => Object.values(r).map((v) => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(',')).join('\n');
  return headers + '\n' + body;
}

function csvFilename(name) {
  return `${name}_${new Date().toISOString().split('T')[0]}.csv`;
}

function sendCsv(res, name, rows) {
  if (rows.length === 0) return res.status(404).json({ success: false, error: `No ${name} to export` });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${csvFilename(name)}"`);
  res.send(toCsv(rows));
}

function truncateWallet(w) {
  if (!w || w.length < 12) return w;
  return w.slice(0, 6) + '...' + w.slice(-4);
}

// Editor role gets read access to purchases/buyers (not a route block —
// see requireRole('editor') on the CMS mount for the route-level gate) but
// with wallet addresses truncated and location/PII-adjacent fields
// dropped. Aggregate financial figures (usd_value, tokens_allocated,
// total_usd_spent, etc.) stay visible — those are needed for the CMS/
// content-editor's day-to-day judgment calls and aren't identifying on
// their own. super_admin sees the row unmodified.
function redactPurchaseForEditor(row, role) {
  if (role !== 'editor') return row;
  const { buyer_wallet, buyer_country, buyer_state, buyer_city, buyer_ip_hash, ...rest } = row;
  return { ...rest, buyer_wallet: truncateWallet(buyer_wallet) };
}

function redactBuyerForEditor(row, role) {
  if (role !== 'editor') return row;
  const { buyer_wallet, country, state, city, tag, ...rest } = row;
  return { ...rest, buyer_wallet: truncateWallet(buyer_wallet) };
}

// ══ AUTH ══

// Checks a plaintext backup code against the stored bcrypt hashes and
// consumes it (one-time use) on match. O(unused codes) bcrypt compares —
// there's no way to index a salted hash for direct lookup, and the unused
// set is small (starts at 10 per generation).
//
// adminId scopes the search: a real admin_users login only matches codes
// generated FOR that user; the legacy bootstrap login (adminId = null)
// only matches codes with no owning user (generated before any
// admin_users row existed). `IS NOT DISTINCT FROM` is NULL-safe equality —
// plain `=` never matches NULL, even against another NULL.
async function verifyAndConsumeBackupCode(code, adminId = null) {
  if (!code) return false;
  const result = await pool.query(
    'SELECT id, code_hash FROM admin_backup_codes WHERE is_used = false AND admin_id IS NOT DISTINCT FROM $1',
    [adminId]
  );
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

// POST /admin/login — username + password + TOTP 2FA (or a backup code).
// Checks admin_users first (bcrypt password, per-user TOTP secret, per-user
// backup codes); falls back to the legacy ADMIN_USERNAME/ADMIN_PASSWORD/
// ADMIN_2FA_SECRET env-var login only when there's no matching active
// admin_users row — in practice this means "before setup.js has seeded the
// bootstrap super_admin row," since that seed uses these same env vars.
// Once seeded, the identical credentials flow through the admin_users
// branch instead (bcrypt-verified, not plaintext) — seamless migration.
router.post('/login', loginRateLimit, async (req, res) => {
  try {
    const { username, password, totp_code, backup_code } = req.body;

    const userResult = await pool.query(
      'SELECT * FROM admin_users WHERE username = $1 AND is_active = true', [username]
    );

    if (userResult.rows.length > 0) {
      const user = userResult.rows[0];
      const validPassword = await bcrypt.compare(password || '', user.password_hash);
      if (!validPassword) {
        recordFailedLogin(req);
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
      }

      const secondFactorOk = backup_code
        ? await verifyAndConsumeBackupCode(backup_code, user.id)
        : verify2FA(totp_code, user.totp_secret);
      if (!secondFactorOk) {
        recordFailedLogin(req);
        return res.status(401).json({
          success: false,
          error: backup_code ? 'Invalid or already-used backup code' : 'Invalid 2FA code',
        });
      }

      recordSuccessfulLogin(req);
      await pool.query('UPDATE admin_users SET last_login = NOW() WHERE id = $1', [user.id]);
      const token = jwt.sign(
        { user_id: user.id, username: user.username, role: user.role },
        process.env.JWT_SECRET, { expiresIn: '24h' }
      );
      await logAudit('admin_login', null, null, null, null,
        { username: user.username, role: user.role, via: backup_code ? 'backup_code' : 'totp' },
        'Admin logged in', user.username, req.ip);
      return res.json({ success: true, token });
    }

    // ── Legacy bootstrap fallback ──
    if (username !== process.env.ADMIN_USERNAME) {
      recordFailedLogin(req);
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    // 🔴 ADMIN_PASSWORD must be set in .env (plaintext) — only reachable
    // pre-migration; see comment above.
    const validPassword = (password === process.env.ADMIN_PASSWORD);
    if (!validPassword) {
      recordFailedLogin(req);
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const secondFactorOk = backup_code ? await verifyAndConsumeBackupCode(backup_code, null) : verify2FA(totp_code);
    if (!secondFactorOk) {
      recordFailedLogin(req);
      return res.status(401).json({
        success: false,
        error: backup_code ? 'Invalid or already-used backup code' : 'Invalid 2FA code',
      });
    }

    recordSuccessfulLogin(req);
    const token = jwt.sign({ user_id: 0, username, role: 'super_admin' }, process.env.JWT_SECRET, { expiresIn: '24h' });
    await logAudit('admin_login', null, null, null, null, { username, via: backup_code ? 'backup_code' : 'totp' },
      'Admin logged in (legacy env-var path)', 'admin (legacy)', req.ip);
    res.json({ success: true, token });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /admin/change-password — { current_password, new_password }, own
// password only. If the caller has a real admin_users row (user_id > 0),
// updates it (bcrypt hash) directly — persists for real, unlike the old
// env-var-only version. Falls back to the legacy in-memory env var update
// only for the bootstrap user_id === 0 case.
router.post('/change-password', adminAuth, requireRole('super_admin'), async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ success: false, error: 'current_password and new_password are required' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ success: false, error: 'New password must be at least 8 characters' });
    }

    if (req.admin.user_id) {
      const userResult = await pool.query('SELECT * FROM admin_users WHERE id = $1', [req.admin.user_id]);
      if (userResult.rows.length === 0) return res.status(404).json({ success: false, error: 'User not found' });
      const user = userResult.rows[0];

      const validPassword = await bcrypt.compare(current_password, user.password_hash);
      if (!validPassword) return res.status(401).json({ success: false, error: 'Current password is incorrect' });

      const newHash = await bcrypt.hash(new_password, 12);
      await pool.query('UPDATE admin_users SET password_hash = $1 WHERE id = $2', [newHash, req.admin.user_id]);

      await logAudit('admin_password_changed', null, null, null, null, null,
        'Admin changed their own password', req.admin.username, req.ip);
      return res.json({ success: true, message: 'Password changed.' });
    }

    // Legacy bootstrap user_id === 0 — no admin_users row to update yet.
    if (current_password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ success: false, error: 'Current password is incorrect' });
    }
    process.env.ADMIN_PASSWORD = new_password;

    await logAudit(
      'admin_password_changed', null, null, null, null, null,
      'Admin password changed — in-memory only, update the ADMIN_PASSWORD env var (e.g. in Coolify) to persist across redeploys',
      'admin (legacy)', req.ip
    );
    res.json({
      success: true,
      message: 'Password changed. This only persists until the next redeploy — update your Coolify env var to make it permanent.',
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /admin/2fa/generate-backup-codes — regenerates the CALLER's backup
// code set, invalidating any previous batch OF THEIRS (scoped by admin_id —
// does not touch other users' codes). Returns the plain codes ONCE.
router.post('/2fa/generate-backup-codes', adminAuth, requireRole('super_admin'), async (req, res) => {
  try {
    const codes = Array.from({ length: 10 }, generateBackupCode);
    const adminId = req.admin.user_id || null;

    await pool.query('DELETE FROM admin_backup_codes WHERE admin_id IS NOT DISTINCT FROM $1', [adminId]);
    for (const code of codes) {
      const hash = await bcrypt.hash(code, 10);
      await pool.query('INSERT INTO admin_backup_codes (admin_id, code_hash) VALUES ($1, $2)', [adminId, hash]);
    }

    await logAudit(
      'admin_backup_codes_generated', null, null, null, null, { count: codes.length },
      'Admin generated new 2FA backup codes — previous batch invalidated', req.admin.username, req.ip
    );
    res.json({ success: true, codes });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ══ ADMIN USER MANAGEMENT (super_admin only) ══

// GET /admin/users — list, safe field subset only (no password_hash/totp_secret)
router.get('/users', adminAuth, requireRole('super_admin'), async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, role, display_name, email, is_active, last_login, created_at FROM admin_users ORDER BY created_at ASC'
    );
    res.json({ success: true, users: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /admin/users — create { username, password, role, display_name, email }
router.post('/users', adminAuth, requireRole('super_admin'), async (req, res) => {
  try {
    const { username, password, role, display_name, email } = req.body;
    if (!username || !password || !role) {
      return res.status(400).json({ success: false, error: 'username, password, and role are required' });
    }
    if (!['super_admin', 'editor', 'viewer'].includes(role)) {
      return res.status(400).json({ success: false, error: 'role must be super_admin, editor, or viewer' });
    }
    if (password.length < 8) {
      return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
    }

    const existing = await pool.query('SELECT id FROM admin_users WHERE username = $1', [username]);
    if (existing.rows.length > 0) return res.status(400).json({ success: false, error: 'Username already exists' });

    const passwordHash = await bcrypt.hash(password, 12);
    const totpSecret = generateTotpSecret();

    const result = await pool.query(
      `INSERT INTO admin_users (username, password_hash, role, display_name, email, totp_secret, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, username, role, display_name, email, is_active, created_at`,
      [username, passwordHash, role, display_name || null, email || null, totpSecret, req.admin.user_id || null]
    );

    await logAudit('admin_user_created', null, null, null, null,
      { username, role }, 'New admin user created', req.admin.username, req.ip);

    // totp_secret returned ONCE — never re-exposed after this response.
    res.json({ success: true, user: result.rows[0], totp_secret: totpSecret });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// PUT /admin/users/:id — update { role, display_name, is_active, email }
router.put('/users/:id', adminAuth, requireRole('super_admin'), async (req, res) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    const { role, display_name, is_active, email } = req.body;

    if (targetId === req.admin.user_id) {
      if (role !== undefined) return res.status(400).json({ success: false, error: 'Cannot change your own role' });
      if (is_active === false) return res.status(400).json({ success: false, error: 'Cannot deactivate your own account' });
    }
    if (role !== undefined && !['super_admin', 'editor', 'viewer'].includes(role)) {
      return res.status(400).json({ success: false, error: 'role must be super_admin, editor, or viewer' });
    }

    const existing = await pool.query('SELECT * FROM admin_users WHERE id = $1', [targetId]);
    if (existing.rows.length === 0) return res.status(404).json({ success: false, error: 'User not found' });

    const sets = [];
    const params = [];
    let i = 1;
    if (role !== undefined) { sets.push(`role = $${i++}`); params.push(role); }
    if (display_name !== undefined) { sets.push(`display_name = $${i++}`); params.push(display_name); }
    if (is_active !== undefined) { sets.push(`is_active = $${i++}`); params.push(is_active); }
    if (email !== undefined) { sets.push(`email = $${i++}`); params.push(email); }
    if (sets.length === 0) return res.status(400).json({ success: false, error: 'No valid fields to update' });

    params.push(targetId);
    const result = await pool.query(
      `UPDATE admin_users SET ${sets.join(', ')} WHERE id = $${params.length}
       RETURNING id, username, role, display_name, email, is_active, last_login, created_at`,
      params
    );

    await logAudit('admin_user_updated', null, null, null, existing.rows[0],
      result.rows[0], 'Admin user updated', req.admin.username, req.ip);
    res.json({ success: true, user: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// DELETE /admin/users/:id — soft delete (is_active = false)
router.delete('/users/:id', adminAuth, requireRole('super_admin'), async (req, res) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    if (targetId === req.admin.user_id) {
      return res.status(400).json({ success: false, error: 'Cannot delete your own account' });
    }

    const existing = await pool.query('SELECT * FROM admin_users WHERE id = $1', [targetId]);
    if (existing.rows.length === 0) return res.status(404).json({ success: false, error: 'User not found' });

    await pool.query('UPDATE admin_users SET is_active = false WHERE id = $1', [targetId]);
    await logAudit('admin_user_deactivated', null, null, null, existing.rows[0],
      { is_active: false }, 'Admin user soft-deleted', req.admin.username, req.ip);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /admin/users/:id/reset-password — { new_password }
router.post('/users/:id/reset-password', adminAuth, requireRole('super_admin'), async (req, res) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    const { new_password } = req.body;
    if (!new_password || new_password.length < 8) {
      return res.status(400).json({ success: false, error: 'new_password must be at least 8 characters' });
    }

    const existing = await pool.query('SELECT id, username FROM admin_users WHERE id = $1', [targetId]);
    if (existing.rows.length === 0) return res.status(404).json({ success: false, error: 'User not found' });

    const newHash = await bcrypt.hash(new_password, 12);
    await pool.query('UPDATE admin_users SET password_hash = $1 WHERE id = $2', [newHash, targetId]);

    await logAudit('admin_user_password_reset', null, null, null, null,
      { target_user: existing.rows[0].username }, 'Admin reset another user’s password', req.admin.username, req.ip);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /admin/users/:id/reset-2fa — new secret, returned ONCE
router.post('/users/:id/reset-2fa', adminAuth, requireRole('super_admin'), async (req, res) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    const existing = await pool.query('SELECT id, username FROM admin_users WHERE id = $1', [targetId]);
    if (existing.rows.length === 0) return res.status(404).json({ success: false, error: 'User not found' });

    const totpSecret = generateTotpSecret();
    await pool.query('UPDATE admin_users SET totp_secret = $1 WHERE id = $2', [totpSecret, targetId]);
    // Old backup codes are tied to the old factor setup — invalidate them too.
    await pool.query('DELETE FROM admin_backup_codes WHERE admin_id = $1', [targetId]);

    await logAudit('admin_user_2fa_reset', null, null, null, null,
      { target_user: existing.rows[0].username }, 'Admin reset another user’s 2FA secret', req.admin.username, req.ip);
    res.json({ success: true, totp_secret: totpSecret });
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
    // total_buyers = wallets with at least one confirmed purchase — NOT every
    // row in `buyers`, which also includes wallets that only created an
    // intent (or connected) and never actually paid. total_wallets_connected
    // is the old all-wallets count, kept as a separate secondary stat.
    const buyers = await pool.query("SELECT COUNT(DISTINCT buyer_wallet) as t FROM purchases WHERE status = 'confirmed'");
    const walletsConnected = await pool.query('SELECT COUNT(*) as t FROM buyers');
    const activeTier = await pool.query('SELECT * FROM tiers WHERE is_active = true LIMIT 1');
    const lastReconciliation = await pool.query('SELECT * FROM reconciliation_results ORDER BY created_at DESC LIMIT 1');
    const lastSnapshot = await pool.query('SELECT * FROM balance_snapshots ORDER BY created_at DESC LIMIT 1');
    const webhookHealth = getWebhookHealth();

    res.json({
      success: true,
      total_raised: parseFloat(raised.rows[0].t),
      total_buyers: parseInt(buyers.rows[0].t),
      total_wallets_connected: parseInt(walletsConnected.rows[0].t),
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

const PURCHASES_SORT = {
  created_at: 'created_at',
  usd_value: 'usd_value',
  tokens_allocated: 'tokens_allocated',
};

// Shared filter/search builder for /purchases and /purchases/export/csv —
// keeps both in sync on what "matching rows" means.
function buildPurchaseFilter(query) {
  const { tier, currency, status, from, to, search } = query;
  const conditions = [];
  const params = [];
  let i = 1;

  if (tier) { conditions.push(`tier_at_purchase = $${i++}`); params.push(tier); }
  if (currency) { conditions.push(`crypto_currency = $${i++}`); params.push(currency); }
  if (status) { conditions.push(`status = $${i++}`); params.push(status); }
  if (from) { conditions.push(`created_at >= $${i++}`); params.push(from); }
  if (to) { conditions.push(`created_at <= $${i++}`); params.push(to); }
  if (search) {
    conditions.push(`(buyer_wallet ILIKE $${i} OR tx_hash ILIKE $${i} OR crypto_currency ILIKE $${i})`);
    params.push(`%${search}%`);
    i++;
  }

  return { where: conditions.length ? 'WHERE ' + conditions.join(' AND ') : '', params };
}

router.get('/purchases', adminAuth, requireRole('editor'), async (req, res) => {
  try {
    const { where, params } = buildPurchaseFilter(req.query);
    const { page, limit, offset } = getPagination(req);
    const orderBy = resolveSort(req, PURCHASES_SORT, 'created_at');

    const countResult = await pool.query(`SELECT COUNT(*) as t FROM purchases ${where}`, params);
    const total = parseInt(countResult.rows[0].t, 10);

    const dataResult = await pool.query(
      `SELECT * FROM purchases ${where} ORDER BY ${orderBy} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    const data = dataResult.rows.map((r) => redactPurchaseForEditor(r, req.admin.role));

    res.json({ data, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /admin/purchases/export — CSV export (legacy path, kept for compat)
router.get('/purchases/export', adminAuth, requireRole('editor'), async (req, res) => {
  try {
    const purchases = await pool.query('SELECT * FROM purchases ORDER BY created_at DESC');
    const rows = purchases.rows.map((r) => redactPurchaseForEditor(r, req.admin.role));
    sendCsv(res, 'purchases', rows);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /admin/purchases/export/csv — same as above, at the requested path.
// Honors the same filters as GET /purchases but returns every matching row
// (not just one page).
router.get('/purchases/export/csv', adminAuth, requireRole('editor'), async (req, res) => {
  try {
    const { where, params } = buildPurchaseFilter(req.query);
    const result = await pool.query(`SELECT * FROM purchases ${where} ORDER BY created_at DESC`, params);
    const rows = result.rows.map((r) => redactPurchaseForEditor(r, req.admin.role));
    sendCsv(res, 'purchases', rows);
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

const BUYERS_SORT = {
  total_usd_spent: 'total_usd_spent',
  total_tokens: 'total_tokens',
  created_at: 'created_at',
};

function buildBuyerFilter(query) {
  const { search } = query;
  if (!search) return { where: '', params: [] };
  return { where: 'WHERE (buyer_wallet ILIKE $1 OR tag ILIKE $1)', params: [`%${search}%`] };
}

router.get('/buyers', adminAuth, requireRole('editor'), async (req, res) => {
  try {
    const { where, params } = buildBuyerFilter(req.query);
    const { page, limit, offset } = getPagination(req);
    const orderBy = resolveSort(req, BUYERS_SORT, 'total_usd_spent');

    const countResult = await pool.query(`SELECT COUNT(*) as t FROM buyers ${where}`, params);
    const total = parseInt(countResult.rows[0].t, 10);

    const dataResult = await pool.query(
      `SELECT * FROM buyers ${where} ORDER BY ${orderBy} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    const data = dataResult.rows.map((r) => redactBuyerForEditor(r, req.admin.role));

    res.json({ data, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/buyers/export/csv', adminAuth, requireRole('editor'), async (req, res) => {
  try {
    const { where, params } = buildBuyerFilter(req.query);
    const result = await pool.query(`SELECT * FROM buyers ${where} ORDER BY total_usd_spent DESC`, params);
    const rows = result.rows.map((r) => redactBuyerForEditor(r, req.admin.role));
    sendCsv(res, 'buyers', rows);
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
    const { page, limit, offset } = getPagination(req);

    const countResult = await pool.query('SELECT COUNT(*) as t FROM referrals');
    const total = parseInt(countResult.rows[0].t, 10);

    const dataResult = await pool.query('SELECT * FROM referrals ORDER BY created_at DESC LIMIT $1 OFFSET $2', [limit, offset]);

    res.json({ data: dataResult.rows, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/referrals/export/csv', adminAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM referrals ORDER BY created_at DESC');
    sendCsv(res, 'referrals', result.rows);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ══ CLAIMS ══

function buildClaimFilter(query) {
  const { tier, status, from, to } = query;
  const conditions = [];
  const params = [];
  let i = 1;
  if (tier) { conditions.push(`tier_id = $${i++}`); params.push(tier); }
  if (status) { conditions.push(`status = $${i++}`); params.push(status); }
  if (from) { conditions.push(`created_at >= $${i++}`); params.push(from); }
  if (to) { conditions.push(`created_at <= $${i++}`); params.push(to); }
  return { where: conditions.length ? 'WHERE ' + conditions.join(' AND ') : '', params };
}

router.get('/claims', adminAuth, async (req, res) => {
  try {
    const { where, params } = buildClaimFilter(req.query);
    const { page, limit, offset } = getPagination(req);

    const countResult = await pool.query(`SELECT COUNT(*) as t FROM claims ${where}`, params);
    const total = parseInt(countResult.rows[0].t, 10);

    const dataResult = await pool.query(
      `SELECT * FROM claims ${where} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    res.json({ data: dataResult.rows, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/claims/export/csv', adminAuth, async (req, res) => {
  try {
    const { where, params } = buildClaimFilter(req.query);
    const result = await pool.query(`SELECT * FROM claims ${where} ORDER BY created_at DESC`, params);
    sendCsv(res, 'claims', result.rows);
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

// event_type/wallet stay as exact-match filters (unchanged); `search` is
// additive — a partial, case-insensitive OR across event_type/related_wallet/
// reason, for consistency with the search behavior on the other list endpoints.
function buildAuditFilter(query) {
  const { event_type, wallet, from, to, search } = query;
  const conditions = [];
  const params = [];
  let i = 1;
  if (event_type) { conditions.push(`event_type = $${i++}`); params.push(event_type); }
  if (wallet) { conditions.push(`related_wallet = $${i++}`); params.push(wallet.toLowerCase()); }
  if (from) { conditions.push(`created_at >= $${i++}`); params.push(from); }
  if (to) { conditions.push(`created_at <= $${i++}`); params.push(to); }
  if (search) {
    conditions.push(`(event_type ILIKE $${i} OR related_wallet ILIKE $${i} OR reason ILIKE $${i})`);
    params.push(`%${search}%`);
    i++;
  }
  return { where: conditions.length ? 'WHERE ' + conditions.join(' AND ') : '', params };
}

router.get('/audit-log', adminAuth, async (req, res) => {
  try {
    const { where, params } = buildAuditFilter(req.query);
    const { page, limit, offset } = getPagination(req);

    const countResult = await pool.query(`SELECT COUNT(*) as t FROM audit_log ${where}`, params);
    const total = parseInt(countResult.rows[0].t, 10);

    const dataResult = await pool.query(
      `SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    res.json({ data: dataResult.rows, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/audit-log/export/csv', adminAuth, async (req, res) => {
  try {
    const { where, params } = buildAuditFilter(req.query);
    const result = await pool.query(`SELECT * FROM audit_log ${where} ORDER BY created_at DESC`, params);
    sendCsv(res, 'audit_log', result.rows);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ══ RECONCILIATION & BALANCE ══

router.get('/reconciliation', adminAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM reconciliation_results ORDER BY created_at DESC LIMIT 100');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/reconciliation/run', adminAuth, requireRole('super_admin'), async (req, res) => {
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

router.get('/withdrawals', adminAuth, requireRole('super_admin'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM withdrawals ORDER BY created_at DESC LIMIT 500');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/withdrawals', adminAuth, requireRole('super_admin'), async (req, res) => {
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

router.post('/otc/allocate', adminAuth, requireRole('super_admin'), async (req, res) => {
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

router.get('/otc/today', adminAuth, requireRole('super_admin'), async (req, res) => {
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

router.get('/otc/history', adminAuth, requireRole('super_admin'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM otc_allocations ORDER BY created_at DESC LIMIT 500');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/otc/pause/:id', adminAuth, requireRole('super_admin'), async (req, res) => {
  try {
    await pool.query("UPDATE otc_allocations SET drip_status = 'paused' WHERE id = $1 AND drip_status = 'active'", [req.params.id]);
    await logAudit('otc_paused', null, null, null, { status: 'active' }, { status: 'paused' }, 'OTC drip paused by admin', req.admin.username, req.ip);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/otc/resume/:id', adminAuth, requireRole('super_admin'), async (req, res) => {
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

router.get('/otc/investor/:wallet', adminAuth, requireRole('super_admin'), async (req, res) => {
  try {
    const wallet = req.params.wallet.toLowerCase();
    const allocations = await pool.query('SELECT * FROM otc_allocations WHERE investor_wallet = $1 ORDER BY created_at DESC', [wallet]);
    const claims = await pool.query('SELECT * FROM claims WHERE buyer_wallet = $1', [wallet]);
    res.json({ success: true, allocations: allocations.rows, claims: claims.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ══ DISPLAY OVERRIDES ══

router.get('/overrides', adminAuth, requireRole('super_admin'), async (req, res) => {
  try {
    const overrides = await pool.query('SELECT * FROM display_overrides WHERE is_active = true');
    const realTier = await pool.query('SELECT * FROM tiers WHERE is_active = true LIMIT 1');
    res.json({ success: true, overrides: overrides.rows, real_data: realTier.rows[0] || null });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/overrides/set', adminAuth, requireRole('super_admin'), async (req, res) => {
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

router.post('/overrides/clear/:key', adminAuth, requireRole('super_admin'), async (req, res) => {
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

router.get('/overrides/history', adminAuth, requireRole('super_admin'), async (req, res) => {
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
    // Same fix as /admin/dashboard: confirmed-purchase wallets, not every
    // row in `buyers` (which includes never-paid intents).
    const totalBuyers = await pool.query("SELECT COUNT(DISTINCT buyer_wallet) as t FROM purchases WHERE status = 'confirmed'");
    const totalWalletsConnected = await pool.query("SELECT COUNT(*) as t FROM buyers");
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
        total_wallets_connected: parseInt(totalWalletsConnected.rows[0].t),
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
    // Filename fixed from a copy-paste leftover ("flowdex_purchases_...") —
    // this exports the financial report, not the raw purchases table.
    sendCsv(res, 'financial_report', purchases.rows);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports = router;
