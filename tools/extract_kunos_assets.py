"""
extract_kunos_assets.py
-----------------------
Extracts UI assets (badges, skin previews, track previews, JSON metadata)
from a local Assetto Corsa installation and saves them into the dashboard's
bundled assets folder (src/assets/kunos/).

All images are converted to WebP on the fly to keep the bundle small.

Requirements:
    pip install Pillow

Usage:
    python tools/extract_kunos_assets.py
"""

import os
import sys
import shutil
import glob

try:
    from PIL import Image
except ImportError:
    print("Error: The 'Pillow' library is required.")
    print("Install it with:  pip install Pillow")
    sys.exit(1)


# ── Helpers ────────────────────────────────────────────────────────────────────

def copy_file(src, dest):
    if os.path.exists(src):
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.copy2(src, dest)
        return True
    return False


def copy_as_webp(src, dest):
    """Convert any image to WebP and save it at dest."""
    if not os.path.exists(src):
        return False
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    try:
        with Image.open(src) as img:
            img.save(dest, "webp", quality=85)
        return True
    except Exception as e:
        print(f"  Warning: could not convert {src}: {e}")
        return False


# ── Extraction ─────────────────────────────────────────────────────────────────

def extract_cars(cars_src, dest_base):
    if not os.path.exists(cars_src):
        print(f"  Cars directory not found: {cars_src}")
        return 0

    count = 0
    for car_id in sorted(os.listdir(cars_src)):
        car_path = os.path.join(cars_src, car_id)
        if not os.path.isdir(car_path):
            continue

        ui_path = os.path.join(car_path, "ui")
        dest_ui = os.path.join(dest_base, "cars", car_id, "ui")

        if not os.path.exists(os.path.join(ui_path, "ui_car.json")):
            continue

        copy_file(os.path.join(ui_path, "ui_car.json"), os.path.join(dest_ui, "ui_car.json"))
        copy_as_webp(os.path.join(ui_path, "badge.png"), os.path.join(dest_ui, "badge.webp"))

        # Skins
        skins_path = os.path.join(car_path, "skins")
        if os.path.exists(skins_path):
            for skin_id in os.listdir(skins_path):
                skin_path = os.path.join(skins_path, skin_id)
                if not os.path.isdir(skin_path):
                    continue
                if not os.path.exists(os.path.join(skin_path, "ui_skin.json")):
                    continue
                dest_skin = os.path.join(dest_base, "cars", car_id, "skins", skin_id)
                copy_file(os.path.join(skin_path, "ui_skin.json"), os.path.join(dest_skin, "ui_skin.json"))
                for preview in glob.glob(os.path.join(skin_path, "preview.*")):
                    if preview.rsplit(".", 1)[-1].lower() in ("jpg", "jpeg", "png"):
                        copy_as_webp(preview, os.path.join(dest_skin, "preview.webp"))
                        break

        count += 1

    return count


def extract_tracks(tracks_src, dest_base):
    if not os.path.exists(tracks_src):
        print(f"  Tracks directory not found: {tracks_src}")
        return 0

    count = 0
    for track_id in sorted(os.listdir(tracks_src)):
        track_path = os.path.join(tracks_src, track_id)
        if not os.path.isdir(track_path):
            continue

        ui_path = os.path.join(track_path, "ui")
        if not os.path.exists(ui_path):
            continue

        dest_ui = os.path.join(dest_base, "tracks", track_id, "ui")

        # Single-layout
        if os.path.exists(os.path.join(ui_path, "ui_track.json")):
            copy_file(os.path.join(ui_path, "ui_track.json"), os.path.join(dest_ui, "ui_track.json"))
            copy_as_webp(os.path.join(ui_path, "preview.png"), os.path.join(dest_ui, "preview.webp"))
            copy_file(os.path.join(ui_path, "outline.png"), os.path.join(dest_ui, "outline.png"))

        # Multi-layout
        for layout_id in os.listdir(ui_path):
            layout_path = os.path.join(ui_path, layout_id)
            if not os.path.isdir(layout_path):
                continue
            if not os.path.exists(os.path.join(layout_path, "ui_track.json")):
                continue
            dest_layout = os.path.join(dest_ui, layout_id)
            copy_file(os.path.join(layout_path, "ui_track.json"), os.path.join(dest_layout, "ui_track.json"))
            copy_as_webp(os.path.join(layout_path, "preview.png"), os.path.join(dest_layout, "preview.webp"))
            copy_file(os.path.join(layout_path, "outline.png"), os.path.join(dest_layout, "outline.png"))

        count += 1

    return count


# ── Main ───────────────────────────────────────────────────────────────────────

def guess_ac_content():
    """Try to find the AC content directory on common install paths."""
    candidates = []
    if os.name == "nt":
        candidates = [
            r"C:\Program Files (x86)\Steam\steamapps\common\assettocorsa\content",
            r"C:\Program Files\Steam\steamapps\common\assettocorsa\content",
        ]
    else:
        home = os.path.expanduser("~")
        candidates = [
            os.path.join(home, ".local/share/Steam/steamapps/common/assettocorsa/content"),
            os.path.join(home, ".steam/steam/steamapps/common/assettocorsa/content"),
        ]
    for path in candidates:
        if os.path.isdir(path):
            return path
    return ""


def prompt(message, default):
    suffix = f" [{default}]" if default else ""
    value = input(f"{message}{suffix}: ").strip()
    return value if value else default


if __name__ == "__main__":
    print("=" * 60)
    print("  Assetto Corsa — Kunos Assets Extractor")
    print("  Copies car/track UI assets into the dashboard bundle.")
    print("=" * 60)
    print()

    default_ac = guess_ac_content()
    ac_content = prompt("Path to assettocorsa/content", default_ac)

    if not os.path.isdir(ac_content):
        print(f"\nError: directory not found: {ac_content}")
        sys.exit(1)

    # Destination defaults to src/assets/kunos relative to the project root
    script_dir  = os.path.dirname(os.path.abspath(__file__))
    project_dir = os.path.dirname(script_dir)
    default_dest = os.path.join(project_dir, "src", "assets", "kunos")
    dest = prompt("Destination folder", default_dest)

    print()
    print(f"Source : {ac_content}")
    print(f"Dest   : {dest}")
    confirm = input("\nProceed? [Y/n]: ").strip().lower()
    if confirm and confirm != "y":
        print("Aborted.")
        sys.exit(0)

    print()
    print("Extracting cars …")
    cars_count = extract_cars(os.path.join(ac_content, "cars"), dest)
    print(f"  Done — {cars_count} cars processed.")

    print("Extracting tracks …")
    tracks_count = extract_tracks(os.path.join(ac_content, "tracks"), dest)
    print(f"  Done — {tracks_count} tracks processed.")

    print()
    print(f"Finished. Assets saved to: {dest}")
