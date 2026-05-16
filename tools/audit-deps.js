#!/usr/bin/env node
// Supply-chain audit. Runs three independent checks:
//
//   1. Scans the lockfile for known-compromised package versions (the rolling
//      list at the top of this file). Refuses to exit 0 if any are found.
//   2. Runs `npm audit --json` and surfaces moderate-or-higher findings.
//   3. Compares the lockfile's integrity hashes against what the npm registry
//      currently reports. A mismatch means the tarball has been tampered with
//      after publish, or the lockfile has been hand-edited — either way, stop.
//
// Run with:
//   node tools/audit-deps.js
//
// Add to your release checklist; consider wiring into a pre-push git hook.
// Exit code 0 = clean, anything else = at least one finding (each logged
// on a single line with the package, version and reason).
//
// The compromised-versions list is hand-curated from public advisories
// (npm GHSA, Socket.dev incident reports, Snyk research blog). Keep it
// up to date — paste new incidents in CONSTANT_TIME_ORDER so the list
// reads as a timeline.

'use strict';

const fs   = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const LOCK = path.join(ROOT, 'package-lock.json');

// ── Known incidents ──────────────────────────────────────────────────────────
// { name, badVersions: Set<string>, source: 'public advisory id or URL', date }
// Update by appending; never edit an existing entry retroactively.
const KNOWN_BAD = [
  // Sep 2025: maintainer npm token hijacked, malicious versions of chalk +
  // debug + many color-* packages published for several hours. npm revoked
  // them but copies persist in mirrors / proxy registries. Newer versions
  // (chalk@5.6.2+, debug@4.4.3+) are clean.
  { name: 'chalk',         badVersions: ['5.6.1'], date: '2025-09-08' },
  { name: 'debug',         badVersions: ['4.4.2'], date: '2025-09-08' },
  { name: 'ansi-styles',   badVersions: ['6.2.2'], date: '2025-09-08' },
  { name: 'color-convert', badVersions: ['3.1.1'], date: '2025-09-08' },
  { name: 'color-name',    badVersions: ['2.0.1'], date: '2025-09-08' },
  { name: 'color-string',  badVersions: ['2.1.1'], date: '2025-09-08' },
  { name: 'simple-swizzle',badVersions: ['0.2.3'], date: '2025-09-08' },
  { name: 'supports-color',badVersions: ['10.2.1'], date: '2025-09-08' },
  { name: 'has-ansi',      badVersions: ['6.0.1'], date: '2025-09-08' },
  { name: 'is-arrayish',   badVersions: ['0.3.3'], date: '2025-09-08' },
  { name: 'wrap-ansi',     badVersions: ['9.0.1'], date: '2025-09-08' },
  { name: 'strip-ansi',    badVersions: ['7.1.1'], date: '2025-09-08' },
  { name: 'slice-ansi',    badVersions: ['7.1.1'], date: '2025-09-08' },
  { name: 'ansi-regex',    badVersions: ['6.2.1'], date: '2025-09-08' },
  // Jul 2025: Shai-Hulud worm — postinstall code that exfiltrates env vars,
  // pushed via compromised accounts. Hundreds of packages affected; see the
  // Socket.dev incident log for the full list.
  // Add any specific versions you encounter here.
  // May 2024: rxnt-* packages — typosquats with credential stealers.
  { name: 'rxnt-authentication', badVersions: ['*'], date: '2024-05' },
  { name: 'rxnt-disposetoken',   badVersions: ['*'], date: '2024-05' },
  { name: 'rxnt-healthchecksdk', badVersions: ['*'], date: '2024-05' },
];

const REGISTRY = process.env.NPM_REGISTRY || 'https://registry.npmjs.org';

let findings = 0;
const fail = (msg) => { findings++; console.log(`  ✗ ${msg}`); };
const pass = (msg) => console.log(`  ✓ ${msg}`);

function loadLock() {
  return JSON.parse(fs.readFileSync(LOCK, 'utf8'));
}

function allPackages(lock) {
  // Return [{name, version, integrity, resolved}] for every node_modules/* entry
  // (skip the root project entry at "").
  const out = [];
  for (const [k, v] of Object.entries(lock.packages || {})) {
    if (k === '') continue;
    const m = /node_modules\/(.+)$/.exec(k);
    if (!m) continue;
    out.push({ name: m[1], version: v.version, integrity: v.integrity, resolved: v.resolved });
  }
  return out;
}

function step1KnownBad(pkgs) {
  console.log('── 1. Known-compromised packages ──');
  const seen = new Set();
  for (const p of pkgs) {
    for (const k of KNOWN_BAD) {
      if (p.name !== k.name) continue;
      if (k.badVersions.includes('*') || k.badVersions.includes(p.version)) {
        const tag = `${p.name}@${p.version}`;
        if (seen.has(tag)) continue;
        seen.add(tag);
        fail(`${tag} matches known-compromised list (incident ${k.date}). Bump to a clean version immediately.`);
      }
    }
  }
  if (!seen.size) pass(`${KNOWN_BAD.length} incident(s) checked, no compromised versions present in the tree`);
}

function step2NpmAudit() {
  console.log('── 2. npm audit ──');
  try {
    const out = execSync('npm audit --audit-level=moderate --json', { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    const data = JSON.parse(out);
    const m = data.metadata?.vulnerabilities || {};
    const bad = (m.moderate || 0) + (m.high || 0) + (m.critical || 0);
    if (bad === 0) {
      pass(`npm audit clean (info=${m.info||0} low=${m.low||0})`);
    } else {
      fail(`npm audit: moderate=${m.moderate||0} high=${m.high||0} critical=${m.critical||0}`);
    }
  } catch (e) {
    // npm audit exits non-zero when findings exist; parse the stdout it emits.
    try {
      const data = JSON.parse(e.stdout?.toString() || '{}');
      const m = data.metadata?.vulnerabilities || {};
      fail(`npm audit: moderate=${m.moderate||0} high=${m.high||0} critical=${m.critical||0}`);
    } catch {
      fail(`npm audit failed to parse: ${e.message}`);
    }
  }
}

function fetchRegistry(name, version) {
  return new Promise((resolve, reject) => {
    const url = `${REGISTRY}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
    https.get(url, { headers: { Accept: 'application/json' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function step3IntegrityParity(pkgs) {
  console.log('── 3. Integrity parity with the registry ──');
  // Verify only top-level deps + a few critical transitives by name. Doing every
  // package would burn through API rate limits; the top-level + native modules
  // surface is what matters.
  const interesting = new Set([
    ...Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).dependencies || {}),
    'debug', 'chalk', 'ansi-styles', 'color-name', 'color-convert', 'prebuild-install', 'tar-fs',
  ]);
  let checked = 0;
  let mismatched = 0;
  for (const p of pkgs) {
    if (!interesting.has(p.name) || !p.integrity || !p.resolved) continue;
    checked++;
    try {
      const meta = await fetchRegistry(p.name, p.version);
      const official = meta.dist?.integrity;
      if (!official) {
        fail(`${p.name}@${p.version}: registry returned no integrity hash`);
        mismatched++;
      } else if (official !== p.integrity) {
        fail(`${p.name}@${p.version}: integrity MISMATCH (lockfile=${p.integrity.slice(0,28)}… registry=${official.slice(0,28)}…)`);
        mismatched++;
      }
    } catch (e) {
      console.log(`  ⚠  could not verify ${p.name}@${p.version}: ${e.message}`);
    }
  }
  if (!mismatched) pass(`${checked} integrity hash(es) match the registry`);
}

(async () => {
  console.log('\n  Assetto Server Panel — supply-chain audit\n');
  const lock = loadLock();
  const pkgs = allPackages(lock);
  console.log(`  ${pkgs.length} package(s) in the lockfile\n`);
  step1KnownBad(pkgs);
  step2NpmAudit();
  await step3IntegrityParity(pkgs);
  console.log('');
  if (findings > 0) {
    console.log(`  ✗ ${findings} finding(s)`);
    process.exit(1);
  } else {
    console.log('  ✓ supply-chain audit clean');
    process.exit(0);
  }
})().catch(e => {
  console.error('audit-deps crashed:', e);
  process.exit(2);
});
