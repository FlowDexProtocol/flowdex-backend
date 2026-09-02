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
