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
    console.log('All 28 tables created');
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
