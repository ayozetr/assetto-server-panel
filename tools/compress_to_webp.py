#!/usr/bin/env python3
"""
compress_to_webp.py
-------------------
Bulk-convert PNG / JPG / JPEG / BMP / TIFF images inside a directory tree
to WebP. Cross-platform, no dependencies beyond Pillow.

Two ways to run it:

    # 1) Interactive — the script asks for everything:
    python tools/compress_to_webp.py

    # 2) Scriptable — pass everything on the command line:
    python tools/compress_to_webp.py --path ./assets --quality 82 --delete --yes

Safety defaults:
  - The original files are KEPT unless you pass --delete (or answer "yes"
    to the deletion prompt). Easier to recover from a bad run.
  - --dry-run shows what would happen without touching any file.
  - Refuses to run against obviously dangerous roots like /, $HOME, /etc.
  - Skips a file if a same-named .webp already exists, unless --overwrite.

Output:
  Per-file conversion line + a summary with total bytes saved.

Requirements:
    pip install Pillow
"""

import argparse
import os
import sys

try:
    from PIL import Image, UnidentifiedImageError
except ImportError:
    sys.stderr.write(
        "Error: the 'Pillow' library is required.\n"
        "Install it with:  pip install Pillow\n"
    )
    sys.exit(1)


SUPPORTED_EXTS = {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff"}

# Resolved absolute paths we refuse to process — accidental `--path /` would
# rewrite half the disk. The user can still force a subdirectory.
FORBIDDEN_ROOTS = {
    os.path.abspath(os.sep),                       # filesystem root
    os.path.abspath(os.path.expanduser("~")),      # user's home
    os.path.abspath("/etc") if os.name != "nt" else "",
    os.path.abspath("/usr") if os.name != "nt" else "",
    os.path.abspath("/var") if os.name != "nt" else "",
}


def human_bytes(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def iter_images(root, recursive):
    if recursive:
        for dirpath, _, filenames in os.walk(root):
            for name in filenames:
                if os.path.splitext(name)[1].lower() in SUPPORTED_EXTS:
                    yield os.path.join(dirpath, name)
    else:
        try:
            for name in os.listdir(root):
                full = os.path.join(root, name)
                if os.path.isfile(full) and os.path.splitext(name)[1].lower() in SUPPORTED_EXTS:
                    yield full
        except OSError as e:
            sys.stderr.write(f"Cannot read directory {root}: {e}\n")


def convert_one(src, quality, lossless, overwrite, delete_original, dry_run, root):
    dest = os.path.splitext(src)[0] + ".webp"
    rel  = os.path.relpath(src, root)

    if os.path.exists(dest) and not overwrite:
        return ("skip", rel, 0, 0, "destination .webp already exists")

    try:
        orig_size = os.path.getsize(src)
    except OSError as e:
        return ("fail", rel, 0, 0, f"stat: {e}")

    if dry_run:
        return ("dry",  rel, orig_size, 0, f"-> {os.path.basename(dest)}")

    try:
        with Image.open(src) as img:
            save_kwargs = {"quality": quality, "method": 6}
            if lossless:
                save_kwargs["lossless"] = True

            # PNG / TIFF with alpha — preserve it. JPEG never has alpha.
            if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
                img = img.convert("RGBA")
            elif img.mode not in ("RGB", "RGBA"):
                img = img.convert("RGB")

            img.save(dest, "webp", **save_kwargs)
    except (UnidentifiedImageError, OSError, ValueError) as e:
        # Don't leave a half-written destination behind.
        if os.path.exists(dest):
            try: os.remove(dest)
            except OSError: pass
        return ("fail", rel, 0, 0, str(e))

    try:
        new_size = os.path.getsize(dest)
    except OSError as e:
        return ("fail", rel, 0, 0, f"stat dest: {e}")

    if delete_original:
        try:
            os.remove(src)
        except OSError as e:
            return ("ok-keep", rel, orig_size, new_size, f"converted but could not delete original: {e}")

    return ("ok", rel, orig_size, new_size, "")


def looks_dangerous(path):
    p = os.path.abspath(path)
    return p in {r for r in FORBIDDEN_ROOTS if r}


def prompt(message, default=None):
    suffix = f" [{default}]" if default is not None else ""
    try:
        value = input(f"{message}{suffix}: ").strip()
    except EOFError:
        return default
    return value if value else default


def ask_bool(message, default=False):
    d = "Y/n" if default else "y/N"
    raw = prompt(f"{message} ({d})", None)
    if raw is None or raw == "":
        return default
    return raw.lower() in ("y", "yes", "s", "si", "sí")


def run_interactive(args):
    print("=" * 60)
    print("  Bulk PNG/JPG → WebP converter")
    print("=" * 60)
    print()

    path = args.path or prompt("Folder to scan", os.getcwd())
    if not path:
        print("No folder given. Aborted.")
        sys.exit(1)
    args.path = os.path.abspath(os.path.expanduser(path))

    if args.quality is None:
        q = prompt("Quality (1–100, ignored when lossless)", "82")
        try: args.quality = max(1, min(100, int(q)))
        except (TypeError, ValueError): args.quality = 82

    if not args.lossless and not args.no_ask_lossless:
        args.lossless = ask_bool("Use lossless mode? (recommended for icons/transparent PNGs)", False)

    if not args.recursive and not args.no_recursive:
        args.recursive = ask_bool("Recurse into subdirectories?", True)

    if not args.overwrite:
        args.overwrite = ask_bool("Overwrite existing .webp targets?", False)

    if not args.delete:
        args.delete = ask_bool("Delete original files after a successful conversion?", False)

    if not args.dry_run:
        args.dry_run = ask_bool("Dry run (no files written or deleted)?", False)

    return args


def main():
    p = argparse.ArgumentParser(
        description="Bulk-convert images to WebP.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--path", help="Directory to scan. Prompted if omitted.")
    p.add_argument("--quality", type=int, help="WebP quality 1–100 (default 82, ignored when --lossless).")
    p.add_argument("--lossless", action="store_true", help="Lossless WebP (larger but pixel-perfect).")
    p.add_argument("--no-ask-lossless", action="store_true", help=argparse.SUPPRESS)
    p.add_argument("--recursive",   action="store_true", help="Recurse into subdirectories.")
    p.add_argument("--no-recursive", action="store_true", help="Top-level only (overrides --recursive prompt).")
    p.add_argument("--overwrite",   action="store_true", help="Replace existing .webp files at the destination.")
    p.add_argument("--delete",      action="store_true", help="Delete the original after a successful conversion.")
    p.add_argument("--dry-run",     action="store_true", help="Show what would happen; do not write or delete anything.")
    p.add_argument("-y", "--yes",   action="store_true", help="Skip the final confirmation prompt (non-interactive runs).")
    args = p.parse_args()

    # Interactive fill-in only when key inputs are missing AND stdin is a TTY.
    needs_prompt = args.path is None or args.quality is None
    if needs_prompt and sys.stdin.isatty():
        args = run_interactive(args)
    else:
        if args.path is None:
            sys.stderr.write("Error: --path is required when running non-interactively.\n")
            sys.exit(2)
        if args.quality is None:
            args.quality = 82

    args.path = os.path.abspath(os.path.expanduser(args.path))

    if not os.path.isdir(args.path):
        sys.stderr.write(f"Error: not a directory: {args.path}\n")
        sys.exit(1)

    if looks_dangerous(args.path):
        sys.stderr.write(
            f"Refusing to operate on {args.path} — it looks like a system root.\n"
            "Point --path at a project subdirectory instead.\n"
        )
        sys.exit(1)

    recursive = args.recursive or (not args.no_recursive and not args.recursive and False)
    # If neither --recursive nor --no-recursive was passed in non-interactive mode,
    # default to recursive (the common case for an assets tree).
    if not args.recursive and not args.no_recursive:
        recursive = True
    elif args.no_recursive:
        recursive = False
    else:
        recursive = True

    print()
    print(f"  Folder:     {args.path}")
    print(f"  Recursive:  {recursive}")
    print(f"  Mode:       {'lossless' if args.lossless else f'lossy q={args.quality}'}")
    print(f"  Overwrite:  {args.overwrite}")
    print(f"  Delete:     {args.delete}  (originals will be {'REMOVED' if args.delete else 'kept'})")
    print(f"  Dry run:    {args.dry_run}")
    print()

    if not args.yes and sys.stdin.isatty():
        if not ask_bool("Proceed?", True):
            print("Aborted.")
            sys.exit(0)

    counts = {"ok": 0, "ok-keep": 0, "skip": 0, "fail": 0, "dry": 0}
    saved_before = 0
    saved_after  = 0

    for src in iter_images(args.path, recursive):
        status, rel, before, after, note = convert_one(
            src, args.quality, args.lossless,
            args.overwrite, args.delete, args.dry_run, args.path,
        )
        counts[status] += 1
        if status in ("ok", "ok-keep"):
            saved_before += before
            saved_after  += after
            ratio = (1 - after / before) * 100 if before else 0
            print(f"  [ok]   {rel}  ({human_bytes(before)} → {human_bytes(after)}, -{ratio:.0f}%)")
        elif status == "dry":
            print(f"  [dry]  {rel}  {note}")
        elif status == "skip":
            print(f"  [skip] {rel}  ({note})")
        else:
            print(f"  [fail] {rel}  — {note}")

    print()
    converted = counts["ok"] + counts["ok-keep"]
    print(
        f"Done. converted={converted} skipped={counts['skip']} "
        f"failed={counts['fail']} dry={counts['dry']}"
    )
    if converted and saved_before:
        delta = saved_before - saved_after
        ratio = (1 - saved_after / saved_before) * 100
        print(f"Total size: {human_bytes(saved_before)} → {human_bytes(saved_after)}  "
              f"(saved {human_bytes(delta)}, -{ratio:.1f}%)")

    sys.exit(1 if counts["fail"] else 0)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.stderr.write("\nInterrupted.\n")
        sys.exit(130)
