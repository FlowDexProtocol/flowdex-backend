require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const fs = require('fs');
const path = require('path');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function setup() {
  try {
    console.log('Connecting to database...');
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(schema);
    console.log('All 32 tables created');

    // Migration-safe: CREATE TABLE IF NOT EXISTS in schema.sql only adds the
    // purchases_tx_hash_unique constraint on a brand-new table. On a database
    // that already has `purchases` from before this constraint existed, add
    // it here — guarded so re-running setup never tries to add it twice.
    const constraintCheck = await pool.query(
      "SELECT 1 FROM pg_constraint WHERE conname = 'purchases_tx_hash_unique'"
    );
    if (constraintCheck.rows.length === 0) {
      console.log('Adding purchases_tx_hash_unique constraint...');
      await pool.query('ALTER TABLE purchases ADD CONSTRAINT purchases_tx_hash_unique UNIQUE (tx_hash)');
      console.log('Constraint added.');
    } else {
      console.log('purchases_tx_hash_unique already exists — skipping.');
    }

    // Migration-safe: CREATE TABLE IF NOT EXISTS in schema.sql only adds
    // these columns on a brand-new cms_banners table. ADD COLUMN IF NOT
    // EXISTS is natively idempotent in Postgres, so this is safe to run
    // unconditionally on every setup.js run.
    console.log('Ensuring cms_banners image/countdown columns exist...');
    await pool.query(`
      ALTER TABLE cms_banners ADD COLUMN IF NOT EXISTS image_url_desktop TEXT;
      ALTER TABLE cms_banners ADD COLUMN IF NOT EXISTS image_url_mobile TEXT;
      ALTER TABLE cms_banners ADD COLUMN IF NOT EXISTS countdown_end TIMESTAMPTZ;
      ALTER TABLE cms_banners ADD COLUMN IF NOT EXISTS show_countdown BOOLEAN DEFAULT false;
      ALTER TABLE cms_banners ADD COLUMN IF NOT EXISTS bg_color VARCHAR(20);
    `);
    console.log('cms_banners columns OK.');

    // Migration-safe: same ADD COLUMN IF NOT EXISTS pattern for the
    // multi-admin-roles + email-notifications migration.
    console.log('Ensuring email_subscribers.wallet_address and admin_backup_codes.admin_id exist...');
    await pool.query(`
      ALTER TABLE email_subscribers ADD COLUMN IF NOT EXISTS wallet_address VARCHAR(100);
      ALTER TABLE admin_backup_codes ADD COLUMN IF NOT EXISTS admin_id INTEGER REFERENCES admin_users(id);
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_email_subscribers_wallet ON email_subscribers(wallet_address)');
    console.log('Migration columns OK.');

    // Seed the bootstrap super_admin from the env-var credentials — only
    // when admin_users is completely empty, so this is a no-op on every
    // subsequent run. This is what makes the first login after migrating
    // seamless: same username/password/2FA secret as the legacy env-var
    // login, just now backed by a real admin_users row with role
    // 'super_admin'.
    const adminCount = await pool.query('SELECT COUNT(*) as t FROM admin_users');
    if (parseInt(adminCount.rows[0].t, 10) === 0) {
      const username = process.env.ADMIN_USERNAME;
      const password = process.env.ADMIN_PASSWORD;
      if (username && password) {
        console.log('Seeding bootstrap super_admin from ADMIN_USERNAME/ADMIN_PASSWORD...');
        const passwordHash = await bcrypt.hash(password, 12);
        const totpSecret = process.env.ADMIN_2FA_SECRET || authenticator.generateSecret();
        await pool.query(
          `INSERT INTO admin_users (username, password_hash, role, display_name, totp_secret)
           VALUES ($1, $2, 'super_admin', $3, $4)`,
          [username, passwordHash, username, totpSecret]
        );
        console.log('Bootstrap super_admin seeded: ' + username);
      } else {
        console.log('ADMIN_USERNAME/ADMIN_PASSWORD not set — skipping bootstrap super_admin seed (legacy env-var login remains available until admin_users has at least one row).');
      }
    } else {
      console.log('admin_users already has ' + adminCount.rows[0].t + ' row(s) — skipping bootstrap seed.');
    }

    const result = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name"
    );
    console.log('Tables (' + result.rows.length + '):');
    result.rows.forEach(r => console.log('  ' + r.table_name));
    await pool.end();
  } catch (err) {
    console.error('Setup failed:', err.message);
    process.exit(1);
  }
}
setup();
