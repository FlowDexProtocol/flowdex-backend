require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function setup() {
  try {
    console.log('Connecting to database...');
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(schema);
    console.log('All 30 tables created');

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
