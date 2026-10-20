// ══════════════════════════════════════════════════
// src/services/otc-import-service.js
// Bulk import of OTC allocations from CSV.
//
// Each row is one investor's allocation and the moment it should happen.
// release_at is that moment: when the tokens are credited and the channel
// is told. Nothing in a committed batch fires at commit time — every row
// is written as 'scheduled' and picked up by activateScheduledOtc(), the
// same once-a-minute sweep that serves the single-allocation form. That
// sweep prices each row against whichever tier is live when it releases,
// so a batch spanning days gets each day's real tier.
//
// When the money arrived is a private bookkeeping detail. received_at is
// optional, never shown publicly, and never announced.
//
// Two stages on purpose. preview() parses and validates and writes
// nothing; commit() writes. Finding out at row 312 of 400 that a column
// was misaligned, after the money has been credited, is the failure this
// shape exists to prevent.
// ══════════════════════════════════════════════════

const crypto = require('crypto');
const pool = require('../db/pool');
const { logAudit } = require('./audit-service');

// A mistake has to have a ceiling. 500 rows is far more than a busy day
// and still small enough that a bad import can be reasoned about.
const MAX_ROWS = 500;

const REQUIRED = ['investor_name', 'investor_wallet', 'usd_amount', 'payment_currency', 'release_at'];
const OPTIONAL = ['crypto_amount', 'received_at', 'notes'];

// Matches the single-allocation form's limit. A release further out than
// this is a mistyped year far more often than it is a real plan.
const MAX_SCHEDULE_DAYS = 90;

// Mirrors the buy page's accepted methods. An unrecognised ticker is a
// warning rather than an error, because a buyer may legitimately send
// something new and refusing the whole batch over it is worse.
const KNOWN_CURRENCIES = ['ETH', 'USDT', 'USDC', 'BNB', 'SOL', 'BTC', 'TRX', 'POL', 'MATIC', 'DAI', 'BUSD'];

// Dollar-pegged, so the crypto amount equals the USD amount exactly and can
// be filled in rather than typed. Only these two: they are what the buy page
// accepts, and their peg is the reason this is arithmetic rather than a
// guess. No volatile coin is ever filled in this way — the investor paid at
// the rate on their day, and a figure derived from any other rate is one
// they did not send.
const DOLLAR_PEGGED = ['USDT', 'USDC'];

// A payment older than this is probably a mistyped year. Flagged, not blocked.
const STALE_DAYS = 60;

// ───────────────────────────────────────────────
// CSV parsing
//
// Hand-rolled rather than adding a dependency: the format is one the admin
// controls, and the only real subtlety is quoted fields containing commas,
// which a wallet label or a note will eventually have.
// ───────────────────────────────────────────────
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < src.length; i++) {
    const c = src[i];

    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }   // escaped quote
        else inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }

  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

// ───────────────────────────────────────────────
// Validation
// ───────────────────────────────────────────────

// Deliberately loose: Ethereum, Solana and Bitcoin addresses have nothing
// in common, and rejecting a valid address because the format check was
// too strict costs more than letting an odd one through to the warning.
function walletLooksValid(w) {
  const a = String(w || '').trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(a)) return true;            // EVM
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return true;   // Solana / BTC base58
  if (/^(bc1|tb1)[a-z0-9]{20,70}$/i.test(a)) return true;     // BTC bech32
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) return true;     // TRON
  return false;
}

// The fingerprint identifies a payment. Re-importing the same file produces
// the same fingerprints, and the unique index refuses them.
// Keyed on release_at rather than received_at: received_at is optional now,
// and two rows for the same wallet, amount, currency and release moment are
// a duplicated line far more often than they are two real allocations.
function fingerprint({ investor_wallet, usd_amount, payment_currency, release_at }) {
  return crypto.createHash('sha256')
    .update([
      String(investor_wallet).trim().toLowerCase(),
      Number(usd_amount).toFixed(2),
      String(payment_currency).trim().toUpperCase(),
      new Date(release_at).toISOString(),
    ].join('|'))
    .digest('hex');
}

function validateRow(raw, index) {
  const errors = [];
  const warnings = [];

  const row = {
    investor_name: (raw.investor_name || '').trim(),
    investor_wallet: (raw.investor_wallet || '').trim(),
    usd_amount: parseFloat(raw.usd_amount),
    payment_currency: (raw.payment_currency || '').trim().toUpperCase(),
    crypto_amount: raw.crypto_amount ? parseFloat(raw.crypto_amount) : null,
    release_at: (raw.release_at || '').trim(),
    received_at: (raw.received_at || '').trim() || null,
    notes: (raw.notes || '').trim() || null,
  };

  if (!row.investor_name) errors.push('investor_name is required');
  if (!row.investor_wallet) errors.push('investor_wallet is required');
  else if (!walletLooksValid(row.investor_wallet)) errors.push('investor_wallet does not look like a valid address');

  if (!Number.isFinite(row.usd_amount) || row.usd_amount <= 0) errors.push('usd_amount must be a number above 0');
  if (!row.payment_currency) errors.push('payment_currency is required');
  else if (!KNOWN_CURRENCIES.includes(row.payment_currency)) warnings.push(`unrecognised currency '${row.payment_currency}'`);

  if (row.crypto_amount !== null && (!Number.isFinite(row.crypto_amount) || row.crypto_amount <= 0)) {
    errors.push('crypto_amount must be a number above 0 when present');
  }

  // A stablecoin row left blank gets its amount filled from the USD figure.
  // Anything typed in the file wins: the admin read it off the wallet.
  if (row.crypto_amount === null
      && DOLLAR_PEGGED.includes(row.payment_currency)
      && Number.isFinite(row.usd_amount) && row.usd_amount > 0) {
    row.crypto_amount = row.usd_amount;
  }

  // release_at is the whole point of the file: when this allocation happens
  // and when the channel is told. A past value is refused rather than
  // released immediately, because an immediate release cannot be taken back
  // once the announcement has gone out — and a past timestamp here is almost
  // always a timezone slip or a typed year, not an instruction.
  const when = new Date(row.release_at);
  if (!row.release_at) {
    errors.push('release_at is required');
  } else if (isNaN(when.getTime())) {
    errors.push('release_at is not a valid date');
  } else if (when.getTime() <= Date.now()) {
    errors.push('release_at is in the past — it must be a future time');
  } else if (when.getTime() > Date.now() + MAX_SCHEDULE_DAYS * 86400000) {
    errors.push(`release_at is more than ${MAX_SCHEDULE_DAYS} days ahead`);
  }

  // Optional, private, and never announced. Validated only so a typo is
  // caught at import rather than discovered during reconciliation.
  if (row.received_at) {
    const paid = new Date(row.received_at);
    if (isNaN(paid.getTime())) {
      errors.push('received_at is not a valid date');
    } else if (paid.getTime() > Date.now() + 60 * 1000) {
      errors.push('received_at is in the future');
    } else if (paid.getTime() < Date.now() - STALE_DAYS * 86400000) {
      warnings.push(`received_at is more than ${STALE_DAYS} days ago`);
    }
  }

  return {
    line: index + 2, // +1 for zero-index, +1 for the header row
    row,
    errors,
    warnings,
    fingerprint: errors.length ? null : fingerprint(row),
  };
}

// ───────────────────────────────────────────────
// preview — parses, validates, writes nothing
// ───────────────────────────────────────────────
async function preview(csvText) {
  const table = parseCsv(csvText);
  if (!table.length) return { ok: false, error: 'The file is empty.' };

  const header = table[0].map((h) => h.trim().toLowerCase());
  const missing = REQUIRED.filter((c) => !header.includes(c));
  if (missing.length) {
    return { ok: false, error: `Missing required column(s): ${missing.join(', ')}. Expected: ${[...REQUIRED, ...OPTIONAL].join(', ')}` };
  }

  const body = table.slice(1);
  if (body.length > MAX_ROWS) {
    return { ok: false, error: `${body.length} rows exceeds the ${MAX_ROWS}-row limit. Split the file.` };
  }

  const results = body.map((cells, i) => {
    const raw = {};
    header.forEach((h, c) => { raw[h] = cells[c] ?? ''; });
    return validateRow(raw, i);
  });

  // Duplicates inside this file.
  const seen = new Map();
  for (const r of results) {
    if (!r.fingerprint) continue;
    if (seen.has(r.fingerprint)) {
      r.errors.push(`duplicate of line ${seen.get(r.fingerprint)} in this file`);
      r.fingerprint = null;
    } else {
      seen.set(r.fingerprint, r.line);
    }
  }

  // Duplicates against payments already imported.
  const fps = results.map((r) => r.fingerprint).filter(Boolean);
  if (fps.length) {
    const existing = await pool.query(
      'SELECT row_fingerprint FROM otc_allocations WHERE row_fingerprint = ANY($1)', [fps]
    );
    const already = new Set(existing.rows.map((x) => x.row_fingerprint));
    for (const r of results) {
      if (r.fingerprint && already.has(r.fingerprint)) {
        r.errors.push('this payment has already been imported');
        r.fingerprint = null;
      }
    }
  }

  // Same wallet under different names is usually a copy/paste slip.
  const byWallet = new Map();
  for (const r of results) {
    if (r.errors.length) continue;
    const w = r.row.investor_wallet.toLowerCase();
    const names = byWallet.get(w) || new Set();
    names.add(r.row.investor_name);
    byWallet.set(w, names);
  }
  for (const r of results) {
    if (r.errors.length) continue;
    const names = byWallet.get(r.row.investor_wallet.toLowerCase());
    if (names && names.size > 1) {
      r.warnings.push(`this wallet also appears under a different name (${[...names].join(', ')})`);
    }
  }

  const valid = results.filter((r) => !r.errors.length);
  const totalUsd = valid.reduce((s, r) => s + r.row.usd_amount, 0);

  const tier = await pool.query('SELECT id, name, price FROM tiers WHERE is_active = true LIMIT 1');

  return {
    ok: true,
    rows: results,
    summary: {
      total_rows: results.length,
      valid_rows: valid.length,
      error_rows: results.length - valid.length,
      warning_rows: results.filter((r) => !r.errors.length && r.warnings.length).length,
      total_usd: Number(totalUsd.toFixed(2)),
      // The window the batch covers, so the admin can see at a glance
      // whether the file releases all at once or over days.
      first_release: valid.length
        ? new Date(Math.min(...valid.map((r) => new Date(r.row.release_at).getTime()))).toISOString()
        : null,
      last_release: valid.length
        ? new Date(Math.max(...valid.map((r) => new Date(r.row.release_at).getTime()))).toISOString()
        : null,
      // Indicative only: a large batch can advance the tier partway through,
      // and each row is priced at the tier live when it is released.
      active_tier: tier.rows[0] || null,
      estimated_tokens: tier.rows[0] ? Number((totalUsd / parseFloat(tier.rows[0].price)).toFixed(0)) : null,
    },
  };
}


// ───────────────────────────────────────────────
// commit — writes the batch and releases every row
//
// Re-validates from the file rather than trusting whatever the preview
// returned: the two calls are separate HTTP requests, and the second one
// must not be able to write something the first never checked.
//
// Rows are processed one at a time, each in its own transaction. Sequential
// matters: a large batch can fill the active tier partway through, and rows
// after that point must price against the tier that is then live. It also
// means a failure on row 300 leaves rows 1-299 correctly recorded rather
// than rolling back work that already credited tiers and posted messages.
// ───────────────────────────────────────────────
async function commit(csvText, { filename, adminUsername, ip }) {
  const pre = await preview(csvText);
  if (!pre.ok) return pre;

  const valid = pre.rows.filter((r) => !r.errors.length);
  if (!valid.length) {
    return { ok: false, error: 'No valid rows to import.' };
  }

  const batch = await pool.query(
    `INSERT INTO otc_import_batches (filename, uploaded_by, row_count, total_usd)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [filename || null, adminUsername, valid.length, pre.summary.total_usd]
  );
  const batchId = batch.rows[0].id;

  await logAudit('otc_import_started', null, null, null, null,
    { batch_id: batchId, rows: valid.length, total_usd: pre.summary.total_usd, filename },
    'OTC bulk import committed', adminUsername, ip);

  const imported = [];
  const failed = [];

  for (const r of valid) {
    try {
      const tierResult = await pool.query('SELECT * FROM tiers WHERE is_active = true LIMIT 1');
      if (!tierResult.rows.length) throw new Error('No active tier — presale is complete');
      const tier = tierResult.rows[0];

      const tierPrice = parseFloat(tier.price);
      const tokens = r.row.usd_amount / tierPrice;
      const wallet = r.row.investor_wallet.toLowerCase();

      // Written as 'scheduled', never released here. activateScheduledOtc()
      // runs every minute, and at release_at it re-prices this row to the
      // tier live at that moment, credits it in full and announces it.
      //
      // tier_at_allocation / tier_price below record the tier at import time
      // so the preview's estimate has something to sit against. They are
      // indicative: the activation sweep overwrites both if the tier has
      // moved on by the time the row is due.
      const releaseAt = new Date(r.row.release_at);
      const dripEnd = new Date(releaseAt.getTime() + 24 * 60 * 60 * 1000);

      const ins = await pool.query(
        `INSERT INTO otc_allocations (
           investor_name, investor_wallet, daily_amount_usd, total_allocated_usd,
           total_tokens_allocated, tier_at_allocation, tier_price, tokens_today, usd_today,
           drip_start_time, drip_end_time, drip_status, payment_method, payment_reference,
           notes, day_gmt4, payment_currency, payment_crypto_amount, received_at,
           scheduled_start_time, import_batch_id, row_fingerprint
         ) VALUES ($1,$2,$3,$3,$4,$5,$6,$4,$3,$12,$13,'scheduled','otc_import',NULL,
                   $7,$8,$9,$10,$11,$12,$14,$15)
         RETURNING id`,
        [
          r.row.investor_name, wallet, r.row.usd_amount, tokens, tier.id, tierPrice,
          r.row.notes,
          releaseAt.toISOString().slice(0, 10),
          r.row.payment_currency, r.row.crypto_amount,
          r.row.received_at ? new Date(r.row.received_at) : null,
          releaseAt, dripEnd, batchId, r.fingerprint,
        ]
      );

      const allocId = ins.rows[0].id;

      imported.push({
        line: r.line,
        allocation_id: allocId,
        usd: r.row.usd_amount,
        release_at: releaseAt.toISOString(),
      });
    } catch (err) {
      // A unique-violation here means the same payment was imported by a
      // concurrent request between preview and commit.
      const reason = err.code === '23505'
        ? 'already imported (detected at write time)'
        : err.message;
      failed.push({ line: r.line, error: reason });
      console.error('[OTC IMPORT] Row ' + r.line + ' failed: ' + reason);
    }
  }

  await pool.query('UPDATE otc_import_batches SET row_count = $1, total_usd = $2 WHERE id = $3',
    [imported.length, imported.reduce((s2, x) => s2 + x.usd, 0), batchId]);

  await logAudit('otc_import_finished', null, null, null, null,
    { batch_id: batchId, imported: imported.length, failed: failed.length },
    'OTC bulk import finished', adminUsername, ip);

  return {
    ok: true,
    batch_id: batchId,
    imported: imported.length,
    failed: failed.length,
    failures: failed,
    total_usd: imported.reduce((s2, x) => s2 + x.usd, 0),
  };
}

// ───────────────────────────────────────────────
// revert — undoes a committed batch
//
// Refused once claims exist for any tier the batch touched: at that point
// buyers have been told what they can claim, and quietly removing the
// purchases behind those numbers would break the claim ledger.
//
// A batch whose rows are still scheduled reverts cleanly — nothing has been
// credited and nothing announced. A batch partway through its schedule
// reverses only the rows that have already released; the rest simply
// disappear before their time comes. What cannot be undone is the Telegram
// post for a row that already went out.
// ───────────────────────────────────────────────
async function revert(batchId, { adminUsername, ip }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const b = await client.query('SELECT * FROM otc_import_batches WHERE id = $1 FOR UPDATE', [batchId]);
    if (!b.rows.length) { await client.query('ROLLBACK'); return { ok: false, error: 'Batch not found' }; }
    if (b.rows[0].status === 'reverted') { await client.query('ROLLBACK'); return { ok: false, error: 'Batch already reverted' }; }

    const allocs = await client.query(
      'SELECT id, tier_at_allocation, total_allocated_usd, investor_wallet, drip_status FROM otc_allocations WHERE import_batch_id = $1',
      [batchId]
    );
    if (!allocs.rows.length) { await client.query('ROLLBACK'); return { ok: false, error: 'Batch has no allocations' }; }

    const tierIds = [...new Set(allocs.rows.map((a) => a.tier_at_allocation))];
    const claims = await client.query(
      'SELECT COUNT(*)::int AS n FROM claims WHERE tier_id = ANY($1)', [tierIds]
    );
    if (claims.rows[0].n > 0) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'Claims have been generated for a tier in this batch — it can no longer be reverted.' };
    }

    // Reverse each tier's credit by what this batch actually added.
    //
    // Only released rows ever touched a tier total. A batch reverted before
    // its release times have come round has credited nothing, so subtracting
    // for those rows would take the tier below its true figure.
    const byTier = {};
    for (const a of allocs.rows) {
      if (a.drip_status !== 'completed') continue;
      byTier[a.tier_at_allocation] = (byTier[a.tier_at_allocation] || 0) + parseFloat(a.total_allocated_usd);
    }
    for (const [tierId, usd] of Object.entries(byTier)) {
      await client.query(
        'UPDATE tiers SET total_raised_usd = GREATEST(total_raised_usd - $1, 0) WHERE id = $2',
        [usd, tierId]
      );
    }

    const ids = allocs.rows.map((a) => a.id);
    await client.query('DELETE FROM otc_drip_log WHERE otc_allocation_id = ANY($1)', [ids]);
    await client.query('DELETE FROM otc_allocations WHERE id = ANY($1)', [ids]);
    await client.query(
      "UPDATE otc_import_batches SET status = 'reverted', reverted_at = NOW(), reverted_by = $1 WHERE id = $2",
      [adminUsername, batchId]
    );

    await client.query('COMMIT');

    await logAudit('otc_import_reverted', null, null, null,
      { batch_id: batchId, allocations: ids.length },
      { reversed_usd: byTier },
      'OTC import batch reverted', adminUsername, ip);

    return { ok: true, reverted: ids.length, tiers_adjusted: byTier };
  } catch (err) {
    await client.query('ROLLBACK');
    return { ok: false, error: err.message };
  } finally {
    client.release();
  }
}

module.exports = { preview, commit, revert, parseCsv, validateRow, fingerprint, walletLooksValid, MAX_ROWS, REQUIRED, OPTIONAL };
