// ══════════════════════════════════════════════════
// src/db/run-migration.js
// Applies a single .sql file to the database using the same connection
// the seed scripts use.
//
// The seed scripts cannot carry a change like this: seedFaqs() bails out
// entirely when any FAQ row exists, and the blog/page seeds are
// ON CONFLICT DO NOTHING. They are first-install scripts. Changing copy
// or tier parameters on a database that is already populated needs real
// UPDATE statements, which is what the migration files hold.
//
// Usage, from the backend repo root:
//   node src/db/run-migration.js src/db/migrations/2026-10-11-uniform-vesting.sql
//
// The whole file is sent as one statement batch, so a migration that
// wraps itself in BEGIN/COMMIT either fully applies or fully rolls back.
// ══════════════════════════════════════════════════

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node src/db/run-migration.js <path-to-.sql>');
    process.exit(1);
  }

  const abs = path.resolve(process.cwd(), file);
  if (!fs.existsSync(abs)) {
    console.error(`No such file: ${abs}`);
    process.exit(1);
  }

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Run this where the backend env is available.');
    process.exit(1);
  }

  const sql = fs.readFileSync(abs, 'utf8');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  console.log(`Applying ${path.basename(abs)} ...`);
  try {
    await pool.query(sql);
    console.log('Applied successfully.');
  } catch (err) {
    // A migration that raises its own exception (for example a guard that
    // refuses to run under unsafe conditions) lands here. The transaction
    // has already rolled back, so nothing was written.
    console.error('\nMigration failed, nothing was written:');
    console.error(`  ${err.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
