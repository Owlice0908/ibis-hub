#!/usr/bin/env python3
"""Generate PWA-ready icons from src/assets/app-icon.png.

Produces dark-background + white-logo icons in 192/512 sizes with the logo
sized at 70% of canvas to satisfy maskable safe-area (centre 80%) on Android,
Windows taskbar, etc. Without this, the transparent app-icon.png shows up as
a "white square" because the OS fills transparency with white.
"""
from PIL import Image
from pathlib import Path

ROOT = Path("/home/nakamura/ibis-hub")
SRC = ROOT / "src/assets/app-icon.png"
OUT_DIRS = [ROOT / "dist", ROOT / "public"]
BG = (15, 15, 15, 255)  # theme_color #0f0f0f
SIZES = [192, 512]
LOGO_SCALE = 0.70

src = Image.open(SRC).convert("RGBA")

def whiten(img):
    """Replace RGB with white, keeping alpha."""
    r, g, b, a = img.split()
    white = Image.new("L", img.size, 255)
    return Image.merge("RGBA", (white, white, white, a))

for size in SIZES:
    canvas = Image.new("RGBA", (size, size), BG)
    logo_size = int(size * LOGO_SCALE)
    logo = src.resize((logo_size, logo_size), Image.LANCZOS)
    logo = whiten(logo)
    off = ((size - logo_size) // 2, (size - logo_size) // 2)
    canvas.paste(logo, off, logo)
    for d in OUT_DIRS:
        out = d / f"icon-{size}.png"
        canvas.save(out, "PNG", optimize=True)
        print(f"wrote {out} ({size}x{size}, {out.stat().st_size} bytes)")
