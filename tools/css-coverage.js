#!/usr/bin/env node
// CSS class-selector coverage report.
//
// Walks src/styles.css for class selectors (`.foo`, `.foo.bar`, `.foo:hover`,
// `.parent .child`, …), then greps src/*.jsx + index.html for every class name
// found. Reports selectors whose every referenced class is absent from the
// codebase (i.e. likely dead).
//
// HEURISTIC ONLY. The script does not understand template strings, dynamic
// className concatenation (`'btn ' + variant`), or runtime-toggled classes via
// classList.add. Treat the output as a starting point for human review, not a
// removal list — false positives are expected.
//
// Usage:
//   node tools/css-coverage.js              # text report
//   node tools/css-coverage.js --verbose    # full lists
//   node tools/css-coverage.js --format=json

const fs   = require('fs');
const path = require('path');

const ROOT     = path.resolve(__dirname, '..');
const CSS_FILE = path.join(ROOT, 'src', 'styles.css');

const argv    = process.argv.slice(2);
const verbose = argv.includes('--verbose');
const fmtArg  = argv.find(a => a.startsWith('--format='));
const format  = (fmtArg ? fmtArg.split('=')[1] : 'text').toLowerCase();

// ── Collect class names referenced in source ─────────────────────────────────
function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'assets') continue;
      out.push(...walk(p));
    } else if (/\.(jsx?|tsx?|html)$/.test(ent.name)) {
      out.push(p);
    }
  }
  return out;
}

const refClasses = new Set();
const sources = [
  ...walk(path.join(ROOT, 'src')),
  path.join(ROOT, 'index.html'),
].filter(p => fs.existsSync(p) && p !== CSS_FILE);

// className=... can take five shapes that we care about:
//   className="foo bar"            — plain double-quoted string
//   className='foo bar'            — single-quoted
//   className={`foo ${x}`}         — template literal inside JSX braces
//   className={`foo ${cond?'a':'b'}`} — same, with nested expression strings
//   className={cond ? 'a' : 'b'}   — JS expression with string literals
//
// A naive `["'`{]…["'`}]` group with lazy matching closes at the FIRST quote
// inside the JSX brace (e.g. on the opening backtick of a template literal),
// which would silently miss everything after it. Instead, locate each
// `className=` and pull all string-literal tokens from a bounded window after
// it — the JSX attribute, in practice, never spans more than a few hundred
// characters before the next attribute or `>`.
function tokenize(str) {
  if (!str) return;
  for (const tok of str.split(/\s+/)) {
    if (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(tok)) refClasses.add(tok);
  }
}

const ATTR_RE       = /\bclass(?:Name)?\s*=\s*/g;
const STRLIT_RE     = /(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g;

for (const f of sources) {
  const txt = fs.readFileSync(f, 'utf8');
  // 1) String literals inside className= attributes.
  ATTR_RE.lastIndex = 0;
  let am;
  while ((am = ATTR_RE.exec(txt)) !== null) {
    const start = ATTR_RE.lastIndex;
    // Bounded window: up to the next un-nested `}` or `>`, capped at 400 chars
    // so a malformed source can't make us scan to EOF.
    const window = txt.slice(start, start + 400);
    let end = window.length;
    let depth = 0;
    for (let i = 0; i < window.length; i++) {
      const c = window[i];
      if (c === '{') depth++;
      else if (c === '}') { if (depth === 0) { end = i; break; } depth--; }
      else if (c === '>' && depth === 0) { end = i; break; }
    }
    const slice = window.slice(0, end);
    STRLIT_RE.lastIndex = 0;
    let sm;
    while ((sm = STRLIT_RE.exec(slice)) !== null) {
      tokenize(sm[1] || sm[2] || sm[3] || '');
    }
  }
  // 2) classList.add('foo'), classList.toggle('bar', cond) — JS path
  const listRe = /classList\.(?:add|remove|toggle|replace)\(([^)]*)\)/g;
  let lm;
  while ((lm = listRe.exec(txt)) !== null) {
    for (const piece of lm[1].split(',')) {
      const sm = piece.match(/['"`]([a-zA-Z][a-zA-Z0-9_-]*)['"`]/);
      if (sm) refClasses.add(sm[1]);
    }
  }
  // 3) document.querySelector('.foo'), .matches('.bar'), getElementsByClassName('baz')
  const qsRe = /(?:querySelector(?:All)?|matches|closest|getElementsByClassName)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  let qm;
  while ((qm = qsRe.exec(txt)) !== null) {
    for (const piece of qm[1].split(/[,\s]+/)) {
      // Strip leading `.` from class selectors; ignore tag/id selectors.
      if (piece.startsWith('.')) tokenize(piece.slice(1));
    }
  }
}

// ── Parse selectors out of styles.css ─────────────────────────────────────────
// Strip comments, then take everything before each `{` as a selector group.
const cssRaw  = fs.readFileSync(CSS_FILE, 'utf8');
const cssNoCm = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '');

const selectorBlocks = []; // [{ selector, classes: [class…] }]
let depth = 0;
let buf   = '';
let inStr = null;
for (let i = 0; i < cssNoCm.length; i++) {
  const c = cssNoCm[i];
  if (inStr) {
    if (c === '\\') { buf += c + cssNoCm[++i]; continue; }
    if (c === inStr) inStr = null;
    buf += c;
    continue;
  }
  if (c === '"' || c === "'") { inStr = c; buf += c; continue; }
  if (c === '{') {
    if (depth === 0) {
      const sel = buf.trim();
      if (sel && !sel.startsWith('@')) selectorBlocks.push({ selector: sel });
      buf = '';
    }
    depth++;
    continue;
  }
  if (c === '}') {
    depth--;
    if (depth < 0) depth = 0;
    if (depth === 0) buf = '';
    continue;
  }
  if (depth === 0) buf += c;
}

// Extract class names from each selector group. A group can have multiple
// comma-separated selectors; we treat the group as dead only if EVERY selector
// in it has at least one class and none of those classes are referenced.
const CLASS_TOKEN_RE = /\.([a-zA-Z_][a-zA-Z0-9_-]*)/g;
function classesIn(selector) {
  const out = [];
  let m;
  CLASS_TOKEN_RE.lastIndex = 0;
  while ((m = CLASS_TOKEN_RE.exec(selector)) !== null) out.push(m[1]);
  return out;
}

const dead = [];
const live = [];
for (const block of selectorBlocks) {
  const groups = block.selector.split(',').map(s => s.trim()).filter(Boolean);
  let everyGroupDead = true;
  let everyGroupHasClass = true;
  for (const g of groups) {
    const cls = classesIn(g);
    if (cls.length === 0) { everyGroupHasClass = false; break; } // tag/id selectors not analysed
    const anyAlive = cls.some(c => refClasses.has(c));
    if (anyAlive) { everyGroupDead = false; break; }
  }
  if (everyGroupHasClass && everyGroupDead) dead.push(block.selector);
  else live.push(block.selector);
}

const report = {
  cssBlocks:        selectorBlocks.length,
  classRefs:        refClasses.size,
  liveSelectors:    live.length,
  deadSelectors:    dead.length,
  candidates:       dead,
};

if (format === 'json') {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`CSS selector coverage`);
  console.log(`─────────────────────`);
  console.log(`Selector blocks parsed:   ${report.cssBlocks}`);
  console.log(`Distinct class refs:      ${report.classRefs}`);
  console.log(`Likely live selectors:    ${report.liveSelectors}`);
  console.log(`Likely dead selectors:    ${report.deadSelectors}`);
  console.log('');
  console.log('Heuristic — does NOT understand dynamic classNames. Each candidate');
  console.log('below should be cross-checked against runtime usage before deletion.');
  console.log('');
  if (report.deadSelectors === 0) {
    console.log('  (no dead candidates)');
  } else {
    const cap = verbose ? Infinity : 30;
    for (const s of dead.slice(0, cap)) console.log(`  • ${s}`);
    if (dead.length > cap) console.log(`  … and ${dead.length - cap} more (run with --verbose)`);
  }
}

process.exitCode = 0; // informational only — never fail the run
