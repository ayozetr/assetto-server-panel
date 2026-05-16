# Security policy

## Reporting a vulnerability

If you believe you have found a security issue in the Assetto Server Panel, please **do not open a public GitHub issue**. Instead, send the details by email:

- **Email:** `ayozetr@proton.me`
- **Subject:** start with `[SECURITY]`

Please include:

1. The version (commit hash or release tag) you were testing against.
2. A clear description of the issue and the impact you believe it has.
3. Steps to reproduce, or a minimal proof-of-concept where applicable.
4. Whether the issue requires authenticated access (and which role) or is reachable anonymously.
5. Any suggested fix you have in mind.

## What you can expect

- An acknowledgement within **5 working days**.
- A first triage assessment within **14 working days**.
- For confirmed issues, a coordinated disclosure timeline. The Panel is a single-author hobby project — patches usually ship within days for high-severity findings, but please do not assume same-day turnaround.
- Public credit in the changelog if you wish (please tell us how you would like to be credited).

## What is in scope

- The HTTP API exposed by `server.js`.
- The frontend bundled into `dist/` (XSS, auth bypass, CSRF, prototype pollution).
- The mod-extraction pipeline (`processModBuffer` and the ZIP/RAR/7z extractors).
- The session, audit log, and rate-limit subsystems.

## What is out of scope

- Vulnerabilities in third-party libraries (`better-sqlite3`, `node-stream-zip`, `node-unrar-js`, `node-7z`, `7zip-bin`, `dotenv`, `esbuild`, React, ReactDOM). Please report those upstream.
- The Assetto Corsa dedicated server itself (`acServer`) — that is a Kunos product.
- Issues that require root/host access on the machine where the Panel is installed.
- Behaviour explicitly documented in the threat model in [`README.md`](README.md#threat-model) (for example: panel admins can install mods, and mods are not sandboxed).
- Denial-of-service via authenticated abuse beyond the per-user upload quota and rate-limit windows already enforced in code.

## Security posture as of publication

The author makes a good-faith effort that each tagged release is free of *known* vulnerabilities at the time it is pushed. There is no warranty, express or implied, about future versions or about vulnerabilities discovered after a release is published. See `LICENSE` (sections 5 and 6) for the full disclaimer.

## Hardening features that are already in place

- `scrypt` password hashing with constant-time compare; cost parameters pinned in a `SCRYPT_PARAMS` constant and passed explicitly to both hash and verify so the comparison never silently relies on Node's defaults. Legacy PBKDF2 hashes are upgraded on the next successful login.
- `ADMIN_TOKEN` header (when configured) is compared in constant time via `crypto.timingSafeEqual` to avoid byte-by-byte timing leaks.
- `HttpOnly; SameSite=Strict` session cookies; the `Secure` flag is appended automatically when the request arrived over HTTPS (direct or via `X-Forwarded-Proto: https`). CSRF rejected by an `Origin`/`Referer` check on every unsafe HTTP method.
- CSP without `unsafe-eval`/`unsafe-inline` for scripts, plus `Permissions-Policy`, `X-Frame-Options: DENY`, `Referrer-Policy`, and HSTS when proxied via HTTPS.
- Static-file allow-list — only `/dist/`, `/src/assets/`, `/src/styles.css`, `/index.html`, `/sw.js`, and `/manifest.webmanifest` are reachable as static.
- INI value sanitisation, archive entry-count and aggregate-size caps, strict zip-slip abort, streaming multipart upload to disk.
- Per-IP rate limits on login, change-password, server start/stop/restart, config writes, mod uploads. Login lockouts persist across restarts. Per-user concurrent SSE log-stream cap (6 connections) so an authenticated client cannot pin unlimited file descriptors.
- Audit log with hash-chained rows (tamper-evident); rows are canonicalised as `JSON.stringify([chain_version, prev, ts, actor, action, target, detail])` so a `|` in a field cannot collide with a different field assignment. Legacy `|`-joined rows still validate via `chain_version = 0`. Verify with `node tools/verify-audit.js`.
- Forced password change for the seeded admin until a new password is set, enforced server-side on every authenticated route. The panel refuses to delete or demote the last remaining admin so an operator cannot accidentally lock everyone out.

If you are deploying the Panel in production, please also read [`README.md`](README.md), the [deployment guide](docs/deployment.md), and [`TASKS.md`](TASKS.md) (the audit backlog — local-only) if you have a copy.

## Supply-chain hygiene

npm supply-chain attacks against the open-source ecosystem are recurring: maintainer accounts get compromised (the Sep 2025 chalk/debug/ansi-styles incident, the Jul 2025 Shai-Hulud worm, the May 2024 rxnt-* typosquats, and so on). The Panel ships defences against the most common patterns:

- **`npm ci` in production** (documented in `docs/deployment.md`). Refuses to install if `package-lock.json` and `package.json` disagree — a hostile actor cannot just amend `package.json` and have your next deploy pull their malicious version.
- **Pinned `package-lock.json` with integrity hashes**. Every dependency in the lockfile carries a sha512 hash that npm verifies against the downloaded tarball. A tampered tarball fails the install.
- **`npm run audit:deps`** runs three independent checks before any release:
  1. Scans the lockfile against a hand-curated list of versions known to be compromised in past incidents (kept in `tools/audit-deps.js`; update by appending).
  2. Runs `npm audit --audit-level=moderate` and fails on moderate-or-higher.
  3. Compares each top-level package's lockfile integrity hash against what `registry.npmjs.org` currently reports. A mismatch means either the tarball was retroactively swapped (very rare) or the lockfile was hand-edited (more common — and almost always a mistake).

  Run it as part of every release checklist; consider wiring into a pre-push git hook if you push from an automated environment.
- **No `postinstall` scripts in this project**. The panel's own `package.json` only declares `prestart` (runs `build.js` — purely local) and a couple of `tools/*.js` runners. Transitive deps may run their own scripts during install; if you want to opt out of that surface in production add `--ignore-scripts` to `npm ci`, and document any postinstall step the deps actually need (currently only `better-sqlite3`'s prebuild download, which fetches a signed binary from GitHub Releases — not arbitrary code).
- **`npm-shrinkwrap.json` is not used** intentionally: the lockfile is the source of truth and ships with the repo. If you fork the project, do not delete `package-lock.json` to "force a fresh install" — that disables every integrity check above.

If you discover that a package in our lockfile has been compromised after publication, **please open a security advisory immediately** so we can bump it. Do not push a fix yourself without coordinating — an emergency major-version bump of a transitive dep can break the build chain in subtle ways.
