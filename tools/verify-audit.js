#!/usr/bin/env node
// Walk the audit_log table and verify the hash chain.
// Usage:  node tools/verify-audit.js [path/to/assetto.db]
//
// Exits 0 if the chain is intact, 1 on first break.

const path    = require('path');
const crypto  = require('crypto');
const dbPath  = process.argv[2] || path.join(__dirname, '..', 'assetto.db');

let Database;
try { Database = require('better-sqlite3'); }
catch (e) { console.error('better-sqlite3 not installed.'); process.exit(2); }

const db = new Database(dbPath, { readonly: true });
const rows = db.prepare(
  'SELECT id, actor, action, target, detail, logged_at, prev_hash, row_hash FROM audit_log ORDER BY id ASC'
).all();

let prev = '';
let ok = 0, broken = 0;
for (const r of rows) {
  if (!r.row_hash) {
    // Pre-migration row before the hash chain shipped — accept and seed the chain
    prev = r.row_hash || '';
    continue;
  }
  const data = `${prev}|${r.logged_at}|${r.actor}|${r.action}|${r.target || ''}|${r.detail || ''}`;
  const expected = crypto.createHash('sha256').update(data).digest('hex');
  if (r.prev_hash !== prev) {
    console.error(`BROKEN at id=${r.id}: prev_hash mismatch (stored=${r.prev_hash.slice(0, 8)}, expected=${prev.slice(0, 8)})`);
    broken++;
    if (broken === 1) process.exitCode = 1;
  } else if (r.row_hash !== expected) {
    console.error(`BROKEN at id=${r.id}: row_hash mismatch (stored=${r.row_hash.slice(0, 8)}, expected=${expected.slice(0, 8)})`);
    broken++;
    if (broken === 1) process.exitCode = 1;
  } else {
    ok++;
  }
  prev = r.row_hash;
}

if (broken) {
  console.error(`\n${broken} broken entries out of ${rows.length} (${ok} ok)`);
} else {
  console.log(`Audit chain OK — ${ok} entries verified${rows.length > ok ? ` (${rows.length - ok} pre-migration entries skipped)` : ''}.`);
}
