# Tested on

Reference of the exact environments the panel is **known to run on** as of the latest tagged release. This page is a snapshot — for the current versions the panel pins or expects, the source of truth is `package.json` (engines + dependencies). For the public summary, see the *Tested on* section in [`../README.md`](../README.md).

The two rows below are the ones the maintainer operates personally (a production server and a development workstation). Anything else is not actively tested and may need tweaks, but the panel does not rely on distribution-specific behaviour beyond a POSIX filesystem.

---

## Hosts

### Production — Ubuntu 24.04.4 LTS

| Component           | Version                                                          |
| ------------------- | ---------------------------------------------------------------- |
| Distribution        | Ubuntu 24.04.4 LTS (Noble Numbat)                                |
| Kernel              | 6.8.0-111-generic                                                |
| Architecture        | x86_64                                                           |
| Node.js             | v20.20.2 (LTS, installed via nvm)                                |
| npm                 | 11.13.0                                                          |
| System SQLite       | 3.45.1 (only used for `tools/verify-audit.js` and ad-hoc admin)  |
| Python              | 3.12.3 (only used by `tools/*.py` — Kunos asset extraction)      |
| git                 | 2.43.0                                                           |
| Reverse proxy       | Cloudflare Tunnel (`cloudflared`) — `TRUST_PROXY=on`             |
| Service manager     | `systemd` unit `assetto-dashboard.service` (Restart=always)      |
| acServer            | Stock Kunos `acServer` 1.x next to the panel under `~/ac_server` |

### Development — CachyOS (Arch rolling)

| Component           | Version                                            |
| ------------------- | -------------------------------------------------- |
| Distribution        | CachyOS Linux (Arch-based, rolling)                |
| Kernel              | 7.0.5-2-cachyos                                    |
| Architecture        | x86_64                                             |
| Node.js             | v20.20.2 (matched to production via nvm)           |
| npm                 | 11.14.1                                            |
| System SQLite       | 3.53.0                                             |
| Python              | 3.14.4                                             |
| git                 | 2.54.0                                             |

Both hosts run **the same `node` major version (20 LTS)** and the same lockfile, so `better-sqlite3` and the other native modules don't need to be rebuilt twice. If you're targeting a different Node version, `npm rebuild better-sqlite3` after install.

---

## Bundled npm packages

Resolved versions from `npm ls --depth=0` against the lockfile committed to the repo. Identical on both hosts.

```
assetto-server-panel@1.5.1
├── 7zip-bin@5.2.0           — bundled 7z static binaries (mod extraction fallback)
├── @resvg/resvg-js@2.6.2    — pure-WASM SVG → PNG rasteriser (public profile OG + download cards)
├── better-sqlite3@12.10.0   — synchronous SQLite bindings (native)
├── dotenv@16.6.1            — .env loader
├── esbuild@0.28.0           — JSX → JS transpile at boot
├── node-7z@3.0.0            — Node wrapper around 7z (uses 7zip-bin)
├── node-stream-zip@1.15.0   — streaming ZIP reader (mods)
└── node-unrar-js@2.0.2      — pure-JS RAR extractor (no system unrar needed)
```

`react@18.3.1` and `react-dom@18.3.1` are **not** installed via npm — they are loaded from `unpkg.com` with SRI hashes pinned in `index.html`. The QR library `qrcode-generator` (MIT, Kazuhiko Arase) is vendored under `src/vendor/` so it does not appear in `package.json` either.

---

## Minimum versions the panel itself enforces

These checks live in `package.json` + boot-time guards in `server.js`:

- `engines.node` → `>=20` (20 LTS line; v18 reaches EOL and is no longer supported)
- `better-sqlite3` requires Node ABI ≥ 115 (Node 20+) — pre-built binaries ship for x64 Linux/macOS/Windows; ARM hosts will compile from source via `node-gyp`
- `esbuild` requires Node 14+ (we go further, see above)

If you're on a Node version older than 20, the panel will refuse to start with a message pointing at `engines`.

---

## Untested but expected to work

These are reasonable extrapolations from how the code is written — no guarantees, no continuous testing, but if you try one and hit a problem please open an issue:

- Debian 12 / 13, Fedora 40+, Rocky Linux 9 — all ship Node 20 in repos or via NodeSource.
- Raspberry Pi OS 64-bit (Bookworm) on a Pi 4/5 — `better-sqlite3` will compile from source on ARM (~1 minute on a Pi 5); plan for a slightly slower first `npm install`.
- Docker via the bundled `Dockerfile` / `docker-compose.yml` — multi-stage build with Alpine 3.x + tini. See [`docker.md`](docker.md).
- macOS 14+ for local development — the panel boots, but acServer is Linux/Windows only, so the actual game integration isn't testable from macOS.

---

## How to report a new tested combination

Open an issue titled `tested on <distro> <version> + Node <x.y.z>` with the output of:

```
uname -srm
cat /etc/os-release | head
node --version
npm --version
sqlite3 --version
node -e "console.log(require('./package.json').version)"
```

…and a one-line note on whether `npm install`, `npm run build`, `npm test` and `npm start` all completed cleanly. Reports get folded into this page on the next release.
