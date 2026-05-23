#!/usr/bin/env node
// Pure-function unit tests. Complements tools/test-smoke.js — that one boots
// the HTTP server and checks end-to-end behaviour; this one imports lib/pure.js
// directly and asserts on input → output behaviour without any I/O. Run with:
//
//   npm run test:unit
//
// What this covers:
//   - _csvCell: RFC 4180 quoting (quote, comma, CR, LF, embedded quotes)
//   - parseLine: acServer log heuristic tags + level classification
//
// Exit code 0 = all assertions held. Anything else = at least one mismatch
// (each failure logs the assertion + expected/actual on a single line).

'use strict';

const assert = require('node:assert/strict');
const { _csvCell, parseLine } = require('../lib/pure.js');

let failures = 0;
let count    = 0;
const t0     = Date.now();

function it(name, fn) {
  count++;
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.log(`  ✗ ${name}\n    ${e.message.split('\n')[0]}`); }
}

console.log('\n  Assetto Server Panel — unit tests\n');

// ── _csvCell ────────────────────────────────────────────────────────────────
it('_csvCell: null and undefined → empty string', () => {
  assert.equal(_csvCell(null),      '');
  assert.equal(_csvCell(undefined), '');
});
it('_csvCell: plain ASCII passes through unquoted', () => {
  assert.equal(_csvCell('hello world'), 'hello world');
  assert.equal(_csvCell('42'),          '42');
});
it('_csvCell: comma forces quoting', () => {
  assert.equal(_csvCell('a,b'), '"a,b"');
});
it('_csvCell: embedded double-quote is escaped by doubling', () => {
  assert.equal(_csvCell('say "hi"'), '"say ""hi"""');
});
it('_csvCell: newline and CR force quoting', () => {
  assert.equal(_csvCell('a\nb'), '"a\nb"');
  assert.equal(_csvCell('a\rb'), '"a\rb"');
});
it('_csvCell: numbers and booleans stringify', () => {
  assert.equal(_csvCell(123),  '123');
  assert.equal(_csvCell(true), 'true');
});

// ── parseLine ───────────────────────────────────────────────────────────────
it('parseLine: ERROR keyword raises level to error', () => {
  const r = parseLine('Initialization error: cannot bind port', 7);
  assert.equal(r.lvl, 'error');
  assert.equal(r.id, 7);
});
it('parseLine: deprecated/skipped/missing classify as warn', () => {
  assert.equal(parseLine('Skipped track xyz', 0).lvl, 'warn');
  assert.equal(parseLine('Missing car definition', 0).lvl, 'warn');
});
it('parseLine: connected / joined / lap completed classify as ok', () => {
  assert.equal(parseLine('PlayerName connected', 0).lvl, 'ok');
  assert.equal(parseLine('Lap completed for car 0', 0).lvl, 'ok');
});
it('parseLine: unclassified lines fall back to info', () => {
  assert.equal(parseLine('Booting acServer 1.16.0', 0).lvl, 'info');
});
it('parseLine: bracket tag wins over heuristic tags', () => {
  const r = parseLine('[ACSP] new connection', 0);
  assert.equal(r.tag, 'ACSP');
});
it('parseLine: HTTP prefix → HTTP tag when no bracket', () => {
  assert.equal(parseLine('GET /api/foo HTTP/1.1', 0).tag, 'HTTP');
});
it('parseLine: timestamp extracted from anywhere in the line', () => {
  const r = parseLine('[12:34:56] Some event', 0);
  assert.equal(r.time, '12:34:56');
});
it('parseLine: missing timestamp → empty string, not crash', () => {
  assert.equal(parseLine('no timestamp here', 0).time, '');
});

console.log(`\n  ${failures ? '✖' : '✓'} ${count - failures}/${count} assertions passed in ${Date.now() - t0} ms\n`);
process.exit(failures ? 1 : 0);
