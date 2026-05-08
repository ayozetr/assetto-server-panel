#!/usr/bin/env node
// Walk the audit_log table and verify the hash chain.
// Usage:  node tools/verify-audit.js [path/to/assetto.db]
//
// Exits 0 if the chain is intact, 1 on first break.
//
// Chain versions:
//   0 — legacy `|`-joined canonicalization (vulnerable to separator collisions; no
//       longer written, still verified for old rows).
//   1 — JSON.stringify([version, prev, logged_at, actor, action, target, detail]).

const path    = require('path');
const crypto  = require('crypto');
const dbPath  = process.argv[2] || path.join(__dirname, '..', 'assetto.db');

let Database;
try { Database = require('better-sqlite3'); }
catch (e) { console.error('better-sqlite3 not installed.'); process.exit(2); }

function expectedHashV0(prev, r) {
  const data = `${prev}|${r.logged_at}|${r.actor}|${r.action}|${r.target || ''}|${r.detail || ''}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}
function expectedHashV1(prev, r) {
  const data = JSON.stringify([1, prev, r.logged_at, r.actor, r.action, r.target || '', r.detail || '']);
  return crypto.createHash('sha256').update(data).digest('hex');
}

const db = new Database(dbPath, { readonly: true });

// chain_version may not exist on very old DBs; pragma_table_info lets us decide
// without a try/catch around the SELECT.
const hasVersionCol = db.prepare(
  `SELECT 1 FROM pragma_table_info('audit_log') WHERE name = 'chain_version'`
).get();
const versionExpr = hasVersionCol ? 'chain_version' : '0 AS chain_version';

const rows = db.prepare(
  `SELECT id, actor, action, target, detail, logged_at, prev_hash, row_hash, ${versionExpr} FROM audit_log ORDER BY id ASC`
).all();

let prev = '';
let ok = 0, broken = 0;
for (const r of rows) {
  if (!r.row_hash) {
    // Pre-migration row before the hash chain shipped — accept and seed the chain
    prev = r.row_hash || '';
    continue;
  }
  const expected = r.chain_version === 1 ? expectedHashV1(prev, r) : expectedHashV0(prev, r);
  if (r.prev_hash !== prev) {
    console.error(`BROKEN at id=${r.id}: prev_hash mismatch (stored=${r.prev_hash.slice(0, 8)}, expected=${prev.slice(0, 8)})`);
    broken++;
    if (broken === 1) process.exitCode = 1;
  } else if (r.row_hash !== expected) {
    console.error(`BROKEN at id=${r.id}: row_hash mismatch (stored=${r.row_hash.slice(0, 8)}, expected=${expected.slice(0, 8)}, version=${r.chain_version})`);
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
