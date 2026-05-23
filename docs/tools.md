# Tools

The `tools/` folder contains:

- Two **Python scripts** for managing the bundled Kunos asset previews that the dashboard uses as fallbacks when a car or track has no thumbnails in the AC content directory.
- Several **Node scripts**: audit-chain verifier, i18n / CSS / dependency coverage reports, smoke + unit test runners, and a synthetic UDP plugin generator for the dashboard.

## Tests

Two layered test scripts ship in this repo:

- `npm run test:unit` — fast pure-function tests (no I/O, no HTTP boot). Loads `lib/pure.js` directly and asserts on CSV quoting + log parsing invariants. Runs in ~5 ms.
- `npm run test:smoke` — boots a throwaway panel against `/tmp` paths and a fresh DB, exercises the security-relevant endpoints (login + must-change gate, CSRF, rate limit, 2FA, INI guard) over a real HTTP socket. Runs in ~1 s.
- `npm test` — chains both (unit first, smoke second) so a broken invariant fails before paying the smoke-boot cost.

Both exit `0` only when every assertion held; CI / a human can jump straight to the first `✗` line that includes the assertion name + the failing diff.

## Requirements

The Python scripts require Python 3 and the [Pillow](https://pillow.readthedocs.io/) image library:

```bash
pip install Pillow
```

The Node scripts use only built-in modules and `better-sqlite3` (already installed by `npm install`); no extra dependencies needed.

---

## extract_kunos_assets.py

Copies car and track UI assets (badges, skin previews, track previews, JSON metadata) from a local Assetto Corsa installation into `src/assets/kunos/`. All images are converted to WebP on the fly to keep the bundle small.

Run this script once after cloning the project if you want to bundle your own Kunos asset previews.

```bash
python tools/extract_kunos_assets.py
```

The script will ask for:

1. **Path to `assettocorsa/content`** — your AC installation's content directory. Common locations:
   - Windows: `C:\Program Files (x86)\Steam\steamapps\common\assettocorsa\content`
   - Linux: `~/.local/share/Steam/steamapps/common/assettocorsa/content`
   - macOS: `~/Library/Application Support/Steam/steamapps/common/assettocorsa/content`

2. **Destination folder** — defaults to `src/assets/kunos/` inside the project. You generally don't need to change this.

After confirming, the script processes all cars and tracks and prints a summary of how many were extracted.

### What gets extracted

| Source | Destination |
|--------|-------------|
| `cars/<id>/ui/ui_car.json` | `kunos/cars/<id>/ui/ui_car.json` |
| `cars/<id>/ui/badge.png` | `kunos/cars/<id>/ui/badge.webp` |
| `cars/<id>/skins/<skin>/ui_skin.json` | `kunos/cars/<id>/skins/<skin>/ui_skin.json` |
| `cars/<id>/skins/<skin>/preview.*` | `kunos/cars/<id>/skins/<skin>/preview.webp` |
| `tracks/<id>/ui/ui_track.json` | `kunos/tracks/<id>/ui/ui_track.json` |
| `tracks/<id>/ui/preview.png` | `kunos/tracks/<id>/ui/preview.webp` |
| `tracks/<id>/ui/<layout>/ui_track.json` | `kunos/tracks/<id>/ui/<layout>/ui_track.json` |
| `tracks/<id>/ui/<layout>/preview.png` | `kunos/tracks/<id>/ui/<layout>/preview.webp` |

---

## compress_to_webp.py

General-purpose bulk converter from PNG / JPG / JPEG / BMP / TIFF to WebP. Cross-platform, no external dependencies beyond Pillow. Works both interactively and as a scripted CLI.

> If you only need to extract the bundled Kunos assets, `extract_kunos_assets.py` already converts to WebP on the fly — you do **not** need to run this script after it. This script is for the general case: shrinking a folder of mod previews, badge images you copied manually, screenshots, etc.

### Interactive mode (default)

```bash
python tools/compress_to_webp.py
```

The script asks for:

1. **Folder to scan** — defaults to the current working directory.
2. **Quality** — 1 to 100, defaults to 82 (ignored when lossless is chosen).
3. **Lossless mode** — recommended for icons and PNGs with transparency.
4. **Recursive** — descend into subdirectories (yes by default).
5. **Overwrite** — replace an existing `.webp` at the destination (no by default).
6. **Delete originals** — remove the source PNG/JPG after a successful conversion (no by default — opt-in, so a bad run is recoverable).
7. **Dry run** — show what would happen without writing or deleting anything.

### Non-interactive / scripted mode

Pass everything on the command line and skip every prompt:

```bash
python tools/compress_to_webp.py --path ./assets --quality 82 --recursive --yes
python tools/compress_to_webp.py --path ./icons --lossless --overwrite --delete --yes
python tools/compress_to_webp.py --path ./mods --dry-run --yes      # preview only
```

Flags:

| Flag             | Effect                                                          |
| ---------------- | --------------------------------------------------------------- |
| `--path PATH`    | Directory to scan (required in non-interactive mode).           |
| `--quality N`    | 1–100, default 82. Ignored when `--lossless`.                   |
| `--lossless`     | Pixel-perfect WebP. Larger files, recommended for icons.        |
| `--recursive`    | Descend into subdirectories.                                    |
| `--no-recursive` | Top-level only.                                                 |
| `--overwrite`    | Replace existing `.webp` files at the destination.              |
| `--delete`       | Remove the original file after successful conversion.           |
| `--dry-run`      | Print actions without writing or deleting anything.             |
| `-y`, `--yes`    | Skip the final "Proceed?" confirmation (CI / scripts).          |

### Safety defaults

- Originals are **kept** unless you pass `--delete`.
- Refuses to operate on `/`, `$HOME`, `/etc`, `/usr`, `/var` — point it at a project subdirectory.
- Skips any image that already has a same-named `.webp` neighbour (unless `--overwrite`).
- Preserves alpha channels (PNG transparency stays transparent in the WebP output).
- Cleans up partial output if a conversion crashes mid-write.
- Exits non-zero if any file failed to convert (useful in scripts).

### Output

Each converted file prints a line with the before/after size and savings:

```
  [ok]   icons/car-1.png  (84.2 KB → 18.7 KB, -78%)
  [skip] icons/car-2.png  (destination .webp already exists)
  [fail] icons/car-3.png  — cannot identify image file
```

…followed by a summary with the total bytes saved across the run.

---

## verify-audit.js

Walks the `audit_log` table in a SQLite snapshot and verifies the SHA-256 hash chain. The verifier reads each row's `chain_version` to pick the right canonicalization — current rows (`v1`) are hashed as `JSON.stringify([1, prev_hash, logged_at, actor, action, target, detail])`; legacy rows (`v0`) use the older `|`-joined form. A tampered or deleted row breaks every subsequent hash and the verifier reports the first break.

```bash
node tools/verify-audit.js path/to/assetto.db
```

Defaults to `./assetto.db` if no path is given. Exits `0` on a clean chain, `1` on the first break.

Pair this with the periodic `/api/admin/backup` download to detect tampering by comparing chains across snapshots — once a row is hashed in, you cannot edit `detail` (or any other column) without breaking every later row.

---

## i18n-coverage.js

Cross-references `t('key')` calls in `src/` against the per-language dictionaries in `src/i18n.jsx` and reports gaps in both directions:

- **Missing** — keys used in code but never translated (per language).
- **Orphaned** — keys defined in a dictionary but never referenced in code.

```bash
node tools/i18n-coverage.js                # text report
node tools/i18n-coverage.js --verbose      # full lists, not capped
node tools/i18n-coverage.js --format=json  # machine-readable
```

Exits `0` when every language is fully covered, `1` if any key is missing — useful as a CI guard against translation drift.

---

## css-coverage.js

Heuristic dead-selector report for `src/styles.css`. Parses class selectors out of the stylesheet, then greps the JSX/HTML for class names referenced via `className=…`, `classList.add/toggle(...)`, and the common DOM query helpers (`querySelector`, `closest`, `getElementsByClassName`). Selectors with zero references are listed as candidates.

```bash
node tools/css-coverage.js
node tools/css-coverage.js --verbose
node tools/css-coverage.js --format=json
```

Output is informational only (always exits `0`). Treat candidates as a starting point for review, not a removal list — the script does not understand classes built at runtime by string concatenation outside template literals.

---

## udp-synthetic-test.js

Sends a scripted sequence of Kunos UDP plugin packets at the local dashboard so the listener can be exercised without a running `acServer`. Useful when developing the parser against a binary you don't have access to, or to reproduce edge cases (e.g. a duplicate `LAP_COMPLETED` that must be deduped by the runtime index).

```bash
# Default target: 127.0.0.1:12001 (panel's UDP_PLUGIN_ADDRESS)
node tools/udp-synthetic-test.js

# Custom port
node tools/udp-synthetic-test.js 12005
```

The packet sequence covers `NEW_SESSION`, two `NEW_CONNECTION` joins, three `LAP_COMPLETED` events (the third intentionally duplicates the second to validate dedup) and a `CONNECTION_CLOSED`. After running, query `laps` and `players` in the DB to confirm exactly three lap rows landed and `total_laps` incremented correctly.
