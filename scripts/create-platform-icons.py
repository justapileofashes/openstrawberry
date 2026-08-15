from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "resources" / "icon.png"
OUTPUT = ROOT / "resources" / "iconset"
ICO = ROOT / "resources" / "icon.ico"


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with Image.open(SOURCE) as source:
        image = source.convert("RGBA")
        if image.width != image.height:
            raise ValueError("OpenStrawberry source icon must be square.")
        sizes = (16, 32, 64, 128, 256, 512, 1024)
        for size in sizes:
            resized = image.resize((size, size), Image.Resampling.LANCZOS)
        mac_representations = ((16, "icon_16x16.png"), (32, "icon_16x16@2x.png"), (32, "icon_32x32.png"), (64, "icon_32x32@2x.png"), (128, "icon_128x128.png"), (256, "icon_128x128@2x.png"), (256, "icon_256x256.png"), (512, "icon_256x256@2x.png"), (512, "icon_512x512.png"), (1024, "icon_512x512@2x.png"))
        for size, name in mac_representations:
            image.resize((size, size), Image.Resampling.LANCZOS).save(OUTPUT / name, format="PNG", optimize=True)
        image.save(ICO, format="ICO", sizes=[(size, size) for size in sizes])


if __name__ == "__main__":
    main()
