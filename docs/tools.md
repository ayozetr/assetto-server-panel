# Tools

The `tools/` folder contains:

- Two **Python scripts** for managing the bundled Kunos asset previews that the dashboard uses as fallbacks when a car or track has no thumbnails in the AC content directory.
- Three **Node scripts**: one verifies the integrity of the audit log hash chain, two report coverage gaps (i18n keys and CSS class selectors) against the source tree.

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

Converts all PNG and JPG images inside a directory tree to WebP format and removes the originals. Useful if you copied assets manually without using the extractor script.

> You only need this if you added images some other way. `extract_kunos_assets.py` already converts to WebP during extraction.

```bash
python tools/compress_to_webp.py
```

The script will ask for:

1. **Directory to convert** — defaults to `src/assets/kunos/`.
2. **WebP quality** — a number from 1 to 100, defaults to 85. Higher means better quality and larger files.

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
