"""The institutional watermark of the visitor's download.

Only the copy that leaves the system to the public gets it: the original in the collection is never
changed, and the accounts (people working for CESMAC) download without it.
"""
from __future__ import annotations

import io
from pathlib import Path

import piexif
from PIL import Image, ImageDraw, ImageFont, ImageOps

from app.images import processing

TEXT = "CESMAC"
# Montserrat ExtraBold: the typeface of the FOTOMAC logo (SIL Open Font License, see OFL.txt).
FONT = Path(__file__).resolve().parent.parent / "assets" / "fonts" / "Montserrat_800ExtraBold.ttf"
HEIGHT = 0.045      # letter size: 4.5% of the shorter side — discreet, but readable on a phone
MARGIN = 0.03       # distance from the edges, also proportional
LEFT, RIGHT = 0, 1  # parameter "watermark_corner"


def layer(w: int, h: int, corner: int = RIGHT) -> Image.Image:
    """The mark alone, on a transparent layer of w x h: the photos and the videos (RF035) get the same mark."""
    short = min(w, h)
    font = ImageFont.truetype(str(FONT), max(12, round(short * HEIGHT)))
    left, top, right, bottom = font.getbbox(TEXT)
    margin = max(6, round(short * MARGIN))
    x = margin - left if corner == LEFT else w - margin - right
    y = h - margin - bottom
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(out)
    shadow = max(1, round(font.size / 20))
    # A soft dark shadow keeps the white letters readable over light and dark images alike.
    draw.text((x + shadow, y + shadow), TEXT, font=font, fill=(0, 0, 0, 90))
    draw.text((x, y), TEXT, font=font, fill=(255, 255, 255, 190))
    return out


def apply(jpeg: bytes, signature: str, corner: int = RIGHT) -> bytes:
    """A new JPEG with "CESMAC" in a bottom corner, same capture data, credits and notice."""
    image = Image.open(io.BytesIO(jpeg))
    try:
        exif = piexif.load(jpeg)
    except Exception:
        exif = {"0th": {}, "Exif": {}, "GPS": {}, "1st": {}, "thumbnail": None}
    # The pixels are turned upright first, so the mark lands in the bottom corner the person SEES;
    # the orientation tag then says "as is", or the viewer would turn the photo a second time.
    image = ImageOps.exif_transpose(image).convert("RGB")
    exif["0th"][piexif.ImageIFD.Orientation] = 1
    exif["1st"], exif["thumbnail"] = {}, None

    marked = Image.alpha_composite(image.convert("RGBA"), layer(*image.size, corner)).convert("RGB")

    out = io.BytesIO()
    marked.save(out, "JPEG", quality=95, exif=piexif.dump(exif))
    # Pillow keeps only the EXIF: the XMP and IPTC blocks are written again, as at upload.
    return processing.with_metadata(out.getvalue(), signature)
