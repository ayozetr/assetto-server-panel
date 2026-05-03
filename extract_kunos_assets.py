import os
import shutil
import glob

def copy_file(src, dest):
    if os.path.exists(src):
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.copy2(src, dest)
        return True
    return False

def extract_cars(cars_src, dest_base):
    if not os.path.exists(cars_src):
        print(f"Cars source directory not found: {cars_src}")
        return

    for car_id in os.listdir(cars_src):
        car_path = os.path.join(cars_src, car_id)
        if not os.path.isdir(car_path):
            continue
            
        ui_path = os.path.join(car_path, "ui")
        dest_car_ui = os.path.join(dest_base, "cars", car_id, "ui")
        
        # Base UI files
        if os.path.exists(os.path.join(ui_path, "ui_car.json")):
            copy_file(os.path.join(ui_path, "ui_car.json"), os.path.join(dest_car_ui, "ui_car.json"))
            copy_file(os.path.join(ui_path, "badge.png"), os.path.join(dest_car_ui, "badge.png"))
            
        # Skins
        skins_path = os.path.join(car_path, "skins")
        if os.path.exists(skins_path):
            for skin_id in os.listdir(skins_path):
                skin_path = os.path.join(skins_path, skin_id)
                if not os.path.isdir(skin_path):
                    continue
                    
                dest_skin = os.path.join(dest_base, "cars", car_id, "skins", skin_id)
                
                if os.path.exists(os.path.join(skin_path, "ui_skin.json")):
                    copy_file(os.path.join(skin_path, "ui_skin.json"), os.path.join(dest_skin, "ui_skin.json"))
                    
                    # Look for preview image (can be jpg or png)
                    previews = glob.glob(os.path.join(skin_path, "preview.*"))
                    for preview in previews:
                        ext = preview.split('.')[-1].lower()
                        if ext in ['jpg', 'jpeg', 'png']:
                            copy_file(preview, os.path.join(dest_skin, f"preview.{ext}"))

def extract_tracks(tracks_src, dest_base):
    if not os.path.exists(tracks_src):
        print(f"Tracks source directory not found: {tracks_src}")
        return

    for track_id in os.listdir(tracks_src):
        track_path = os.path.join(tracks_src, track_id)
        if not os.path.isdir(track_path):
            continue
            
        ui_path = os.path.join(track_path, "ui")
        if not os.path.exists(ui_path):
            continue
            
        dest_track_ui = os.path.join(dest_base, "tracks", track_id, "ui")
        
        # Default layout (if ui_track.json is right inside ui/)
        if os.path.exists(os.path.join(ui_path, "ui_track.json")):
            copy_file(os.path.join(ui_path, "ui_track.json"), os.path.join(dest_track_ui, "ui_track.json"))
            copy_file(os.path.join(ui_path, "preview.png"), os.path.join(dest_track_ui, "preview.png"))
            copy_file(os.path.join(ui_path, "outline.png"), os.path.join(dest_track_ui, "outline.png"))
            
        # Layouts
        for layout_id in os.listdir(ui_path):
            layout_path = os.path.join(ui_path, layout_id)
            if not os.path.isdir(layout_path):
                continue
                
            if os.path.exists(os.path.join(layout_path, "ui_track.json")):
                dest_layout = os.path.join(dest_track_ui, layout_id)
                copy_file(os.path.join(layout_path, "ui_track.json"), os.path.join(dest_layout, "ui_track.json"))
                copy_file(os.path.join(layout_path, "preview.png"), os.path.join(dest_layout, "preview.png"))
                copy_file(os.path.join(layout_path, "outline.png"), os.path.join(dest_layout, "outline.png"))

if __name__ == "__main__":
    print("=== Assetto Corsa Kunos Assets Extractor by ayozetr===")
    
    # Try to guess default content directory based on OS
    default_ac_path = ""
    if os.name == 'nt':
        default_ac_path = r"C:\Program Files (x86)\Steam\steamapps\common\assettocorsa\content"
    else:
        default_ac_path = os.path.expanduser("~/.local/share/Steam/steamapps/common/assettocorsa/content")
        
    ac_content_path = input(f"Assetto Corsa content directory (assettocorsa/content)\n[{default_ac_path}]: ").strip()
    if not ac_content_path:
        ac_content_path = default_ac_path
        
    default_dest = "./src/assets/kunos"
    dest_path = input(f"Destination path\n[{default_dest}]: ").strip()
    if not dest_path:
        dest_path = default_dest
        
    cars_src = os.path.join(ac_content_path, "cars")
    tracks_src = os.path.join(ac_content_path, "tracks")
    
    print("\nExtracting cars...")
    extract_cars(cars_src, dest_path)
    
    print("Extracting tracks...")
    extract_tracks(tracks_src, dest_path)
    
    print("Extraction completed!")
