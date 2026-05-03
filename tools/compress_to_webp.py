import os
from PIL import Image

def convert_to_webp(directory):
    for root, dirs, files in os.walk(directory):
        for file in files:
            if file.lower().endswith(('.png', '.jpg', '.jpeg')):
                filepath = os.path.join(root, file)
                # Ensure we only compress images in kunos, skipping any outside
                if 'kunos' not in filepath:
                    continue
                
                name, ext = os.path.splitext(filepath)
                webp_path = name + '.webp'
                
                try:
                    with Image.open(filepath) as img:
                        img.save(webp_path, 'webp', quality=85)
                    print(f"Converted: {filepath} -> {webp_path}")
                    os.remove(filepath)
                except Exception as e:
                    print(f"Failed to convert {filepath}: {e}")

if __name__ == "__main__":
    kunos_dir = os.path.abspath("./src/assets/kunos")
    print(f"Converting images in {kunos_dir} to WebP...")
    convert_to_webp(kunos_dir)
    print("Done!")
