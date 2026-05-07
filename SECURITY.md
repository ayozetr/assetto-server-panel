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

- `scrypt` password hashing with constant-time compare; legacy PBKDF2 hashes are upgraded on the next successful login.
- `HttpOnly; SameSite=Strict` session cookies; CSRF rejected by an `Origin`/`Referer` check on every unsafe HTTP method.
- CSP without `unsafe-eval`/`unsafe-inline` for scripts, plus `Permissions-Policy`, `X-Frame-Options: DENY`, `Referrer-Policy`, and HSTS when proxied via HTTPS.
- Static-file allow-list — only `/dist/`, `/src/assets/`, `/src/styles.css`, `/index.html`, `/sw.js`, and `/manifest.webmanifest` are reachable as static.
- INI value sanitisation, archive entry-count and aggregate-size caps, strict zip-slip abort, streaming multipart upload to disk.
- Per-IP rate limits on login, change-password, server start/stop/restart, config writes, mod uploads. Login lockouts persist across restarts.
- Audit log with hash-chained rows (tamper-evident); verify with `node tools/verify-audit.js`.
- Forced password change for the seeded admin until a new password is set, enforced server-side on every authenticated route.

If you are deploying the Panel in production, please also read [`README.md`](README.md), the [deployment guide](docs/deployment.md), and [`TASKS.md`](TASKS.md) (the audit backlog — local-only) if you have a copy.
