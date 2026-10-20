// ══════════════════════════════════════════════════
// src/db/schema-drift.js
// Reports where the live database differs from schema.sql.
//
// schema.sql is written with CREATE TABLE IF NOT EXISTS, which creates a
// missing table but does NOTHING to a table that already exists. So any
// column added to schema.sql after a table was first created never reaches
// a database that already had it. The code then expects a column the
// database does not have, and the failure surfaces at runtime, in whichever
// query happens to touch it first.
//
// Read-only. Prints what is missing; changes nothing.
//
//   node src/db/schema-drift.js
// ══════════════════════════════════════════════════

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const SCHEMA = path.resolve(__dirname, 'schema.sql');

// Lines inside CREATE TABLE that declare a constraint rather than a column.
const NOT_A_COLUMN = /^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT|EXCLUDE)\b/i;

function parseSchema(sql) {
  const tables = {};
  // Non-greedy to the first ");" at the start of a line, which is how every
  // table in this file ends.
  const re = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\n\);/g;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const [, table, body] = m;
    const cols = [];
    for (let raw of body.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('--')) continue;
      if (NOT_A_COLUMN.test(line)) continue;
      const name = line.match(/^"?(\w+)"?\s/);
      if (name) cols.push(name[1].toLowerCase());
    }
    tables[table.toLowerCase()] = cols;
  }
  return tables;
}

async function main() {
  const expected = parseSchema(fs.readFileSync(SCHEMA, 'utf8'));
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const live = await pool.query(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'`
  );

  const actual = {};
  for (const r of live.rows) {
    (actual[r.table_name] ||= []).push(r.column_name.toLowerCase());
  }

  let missingTables = 0;
  let missingColumns = 0;

  console.log('Comparing ' + Object.keys(expected).length + ' tables in schema.sql against the live database.\n');

  for (const [table, cols] of Object.entries(expected)) {
    if (!actual[table]) {
      console.log('MISSING TABLE  ' + table);
      missingTables++;
      continue;
    }
    const gap = cols.filter((c) => !actual[table].includes(c));
    if (gap.length) {
      console.log('MISSING COLUMNS  ' + table);
      gap.forEach((c) => console.log('    - ' + c));
      missingColumns += gap.length;
    }
  }

  // Columns the database has but schema.sql does not describe. Usually a
  // migration that was applied but never folded back into schema.sql, which
  // means a fresh install would not get it.
  //
  // The table-level case was the blind spot that let otc_import_batches live
  // in production while schema.sql had never heard of it: the loop above only
  // walks tables schema.sql already knows, so a whole table created by a
  // migration and never folded back was invisible here. It is checked first
  // now, because a missing table is worse than a missing column — anything
  // referencing it fails outright on a fresh install.
  let undocumentedTables = 0;
  for (const table of Object.keys(actual)) {
    if (expected[table]) continue;
    console.log('NOT IN schema.sql  ' + table + '  (whole table)');
    undocumentedTables++;
  }

  let undocumented = 0;
  for (const [table, cols] of Object.entries(actual)) {
    if (!expected[table]) continue;
    const extra = cols.filter((c) => !expected[table].includes(c));
    if (extra.length) {
      console.log('NOT IN schema.sql  ' + table + ': ' + extra.join(', '));
      undocumented += extra.length;
    }
  }

  console.log('\n' + (missingTables + missingColumns === 0
    ? 'No missing tables or columns.'
    : missingTables + ' missing table(s), ' + missingColumns + ' missing column(s).'));
  if (undocumentedTables) {
    console.log(undocumentedTables + ' live table(s) absent from schema.sql — a fresh install would not create these.');
  }
  if (undocumented) {
    console.log(undocumented + ' live column(s) absent from schema.sql — a fresh install would not create these.');
  }

  await pool.end();
}

main().catch((err) => { console.error('Drift check failed:', err.message); process.exit(1); });
