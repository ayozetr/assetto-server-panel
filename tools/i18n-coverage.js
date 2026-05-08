#!/usr/bin/env node
// i18n coverage report.
//
// Walks src/ for `t('key')` / `t("key")` / `AppI18n.t('key')` calls, parses the
// dictionaries out of src/i18n.jsx, and reports:
//   • used-but-missing   keys (per language)
//   • defined-but-unused keys (per language)
//   • per-language coverage % vs the union of used keys
//
// Usage: node tools/i18n-coverage.js [--verbose] [--format=text|json]
// Exits non-zero when any language has missing keys (CI-friendly).

const fs   = require('fs');
const path = require('path');

const ROOT     = path.resolve(__dirname, '..');
const SRC_DIR  = path.join(ROOT, 'src');
const I18N_FILE = path.join(SRC_DIR, 'i18n.jsx');

const argv     = process.argv.slice(2);
const verbose  = argv.includes('--verbose');
const fmtArg   = argv.find(a => a.startsWith('--format='));
const format   = (fmtArg ? fmtArg.split('=')[1] : 'text').toLowerCase();

// ── Collect t('...') / t("...") usages ────────────────────────────────────────
// Match the function-call form only. Leading `\b` would also accept names that
// end in `t` (last, set, etc.); we anchor on a non-word char (or BOL) instead.
// `[^'"\\\n]*` keeps the regex linear (no escape handling — the dict keys never
// embed quotes anyway).
const T_CALL_RE = /(?:^|[^A-Za-z0-9_$])t\(\s*['"]([a-zA-Z0-9_.\-]+)['"]/g;

function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'assets') continue; // images / fonts
      out.push(...walk(p));
    } else if (/\.(jsx?|tsx?|html)$/.test(ent.name)) {
      out.push(p);
    }
  }
  return out;
}

const usedByFile = new Map(); // key → Set<filePath>
function recordUse(key, file) {
  if (!usedByFile.has(key)) usedByFile.set(key, new Set());
  usedByFile.get(key).add(path.relative(ROOT, file));
}

const files = walk(SRC_DIR).filter(f => f !== I18N_FILE);
for (const f of files) {
  const txt = fs.readFileSync(f, 'utf8');
  let m;
  T_CALL_RE.lastIndex = 0;
  while ((m = T_CALL_RE.exec(txt)) !== null) {
    recordUse(m[1], f);
  }
}
const usedKeys = new Set(usedByFile.keys());

// ── Parse src/i18n.jsx ────────────────────────────────────────────────────────
// Structure: `const dict = { en: { 'k': 'v', … }, es: {…}, it: {…} };`
// We slice out each language object by tracking brace depth so commas / braces
// inside translated strings cannot confuse us.
const i18nText = fs.readFileSync(I18N_FILE, 'utf8');

function extractLangBlocks(src) {
  const langs = {};
  // Locate `const dict = {` and walk into it.
  const dictStart = src.indexOf('const dict');
  if (dictStart < 0) throw new Error('Could not find `const dict` in i18n.jsx');
  const openIdx = src.indexOf('{', dictStart);
  if (openIdx < 0) throw new Error('Could not find opening brace of dict');

  // Walk the dict body collecting top-level "name: { ... }" entries.
  let i = openIdx + 1;
  const langHeader = /\s*([a-z]{2,4})\s*:\s*\{/y;
  while (i < src.length) {
    // Skip whitespace and commas
    while (i < src.length && /[\s,]/.test(src[i])) i++;
    if (src[i] === '}') break; // end of dict
    langHeader.lastIndex = i;
    const hm = langHeader.exec(src);
    if (!hm) break;
    const lang = hm[1];
    let depth = 1;
    let j = langHeader.lastIndex; // first char after the opening brace
    let inStr = null;
    while (j < src.length && depth > 0) {
      const c = src[j];
      if (inStr) {
        if (c === '\\') { j += 2; continue; }
        if (c === inStr) inStr = null;
      } else {
        if (c === "'" || c === '"' || c === '`') inStr = c;
        else if (c === '{') depth++;
        else if (c === '}') depth--;
      }
      j++;
    }
    langs[lang] = src.slice(langHeader.lastIndex, j - 1);
    i = j;
  }
  return langs;
}

function extractKeys(blockText) {
  // Keys are quoted strings followed by `:` at the start of a (logical) line.
  // We accept single, double, or backtick-quoted keys and reject ones with `:`
  // or `,` inside. Comments (`// …`) are stripped first so they don't get misread.
  const noComments = blockText.replace(/\/\/[^\n]*/g, '');
  const out = new Set();
  const re = /(^|[\s,{])\s*['"`]([a-zA-Z0-9_.\-]+)['"`]\s*:/g;
  let m;
  while ((m = re.exec(noComments)) !== null) out.add(m[2]);
  return out;
}

const langBlocks = extractLangBlocks(i18nText);
const langKeys   = {};
for (const [lang, body] of Object.entries(langBlocks)) {
  langKeys[lang] = extractKeys(body);
}

// ── Diff ──────────────────────────────────────────────────────────────────────
const allDefined = new Set();
for (const ks of Object.values(langKeys)) for (const k of ks) allDefined.add(k);

const report = {
  filesScanned:  files.length,
  totalUsedKeys: usedKeys.size,
  languages: {},
  unusedAcrossAll: [],
};

for (const [lang, ks] of Object.entries(langKeys)) {
  const missing  = [...usedKeys].filter(k => !ks.has(k)).sort();
  const orphaned = [...ks].filter(k => !usedKeys.has(k)).sort();
  const coverage = usedKeys.size === 0 ? 1 : (usedKeys.size - missing.length) / usedKeys.size;
  report.languages[lang] = {
    defined:  ks.size,
    missing,
    orphaned,
    coverage: Math.round(coverage * 1000) / 10, // % with one decimal
  };
}

// Keys defined in some language but not referenced anywhere in src/. These are
// the strongest "definitely unused" signal — orphaned in the union, not just
// stale in one language.
report.unusedAcrossAll = [...allDefined].filter(k => !usedKeys.has(k)).sort();

// ── Output ────────────────────────────────────────────────────────────────────
function fmtList(items, max = 15) {
  if (items.length === 0) return '  (none)';
  const head = items.slice(0, max).map(k => `  • ${k}`).join('\n');
  const tail = items.length > max ? `\n  … and ${items.length - max} more` : '';
  return head + tail;
}

if (format === 'json') {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`i18n coverage`);
  console.log(`─────────────`);
  console.log(`Scanned ${report.filesScanned} source files; found ${report.totalUsedKeys} unique t() keys.\n`);

  for (const [lang, r] of Object.entries(report.languages)) {
    console.log(`[${lang.toUpperCase()}] ${r.defined} defined · ${r.coverage}% coverage`);
    console.log(`  Missing (used in code, no translation): ${r.missing.length}`);
    if (verbose || r.missing.length <= 15) console.log(fmtList(r.missing));
    console.log(`  Orphaned (translated, never used): ${r.orphaned.length}`);
    if (verbose) console.log(fmtList(r.orphaned, 1000));
    console.log('');
  }

  if (report.unusedAcrossAll.length) {
    console.log(`Defined in at least one language but referenced nowhere in src/: ${report.unusedAcrossAll.length}`);
    if (verbose) console.log(fmtList(report.unusedAcrossAll, 1000));
  }

  if (verbose && usedKeys.size) {
    console.log(`\nKey → file references (top 20):`);
    const sample = [...usedByFile.entries()].slice(0, 20);
    for (const [k, set] of sample) {
      console.log(`  ${k}  ←  ${[...set].slice(0, 3).join(', ')}${set.size > 3 ? `, +${set.size - 3} more` : ''}`);
    }
  }
}

const anyMissing = Object.values(report.languages).some(r => r.missing.length > 0);
process.exitCode = anyMissing ? 1 : 0;
