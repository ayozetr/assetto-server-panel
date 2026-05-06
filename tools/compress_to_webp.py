"""
compress_to_webp.py
-------------------
Converts all PNG/JPG images inside a directory tree to WebP format
and removes the originals. Useful if you copied assets manually and
need to compress them in bulk.

Note: extract_kunos_assets.py already converts to WebP on the fly, so
you only need this script if you added images some other way.

Requirements:
    pip install Pillow

Usage:
    python tools/compress_to_webp.py
"""

import os
import sys

try:
    from PIL import Image
except ImportError:
    print("Error: The 'Pillow' library is required.")
    print("Install it with:  pip install Pillow")
    sys.exit(1)


def convert_directory(directory, quality=85):
    converted = 0
    failed    = 0

    for root, _, files in os.walk(directory):
        for filename in files:
            ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
            if ext not in ("png", "jpg", "jpeg"):
                continue

            src  = os.path.join(root, filename)
            dest = os.path.splitext(src)[0] + ".webp"

            try:
                with Image.open(src) as img:
                    img.save(dest, "webp", quality=quality)
                os.remove(src)
                print(f"  Converted: {os.path.relpath(src, directory)}")
                converted += 1
            except Exception as e:
                print(f"  Failed:    {os.path.relpath(src, directory)} — {e}")
                failed += 1

    return converted, failed


def prompt(message, default):
    suffix = f" [{default}]" if default else ""
    value = input(f"{message}{suffix}: ").strip()
    return value if value else default


if __name__ == "__main__":
    print("=" * 60)
    print("  Bulk PNG/JPG → WebP converter")
    print("=" * 60)
    print()

    script_dir   = os.path.dirname(os.path.abspath(__file__))
    project_dir  = os.path.dirname(script_dir)
    default_dir  = os.path.join(project_dir, "src", "assets", "kunos")

    target = prompt("Directory to convert (recursively)", default_dir)

    if not os.path.isdir(target):
        print(f"\nError: directory not found: {target}")
        sys.exit(1)

    quality_str = prompt("WebP quality (1–100)", "85")
    try:
        quality = max(1, min(100, int(quality_str)))
    except ValueError:
        quality = 85

    print(f"\nConverting images in: {target}")
    print(f"Quality: {quality}")
    confirm = input("Proceed? [Y/n]: ").strip().lower()
    if confirm and confirm != "y":
        print("Aborted.")
        sys.exit(0)

    print()
    converted, failed = convert_directory(target, quality)

    print()
    print(f"Done. {converted} converted, {failed} failed.")
