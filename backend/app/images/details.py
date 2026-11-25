"""'Detalhes' of a photo in the panel (24/10/2026): what the camera wrote in the file, read from the
ORIGINAL as stored (the RAW, HEIC… when there is one), in two levels — the main details and, on
"Ver mais detalhes", every tag.

Left out on purpose: the location (removed at upload, LGPD Art. 6, III — there is nothing to show), the
camera owner's name and serial numbers (identify a person or a device and serve no purpose here), and the
temporary file's own data (name, folder, permissions, dates of the copy).
"""
from __future__ import annotations

import re

from app.db.models import Image
from app.images import exiftool
from app.storage.port import ObjectStorage

_HIDDEN_GROUPS = {"ExifTool", "System"}
_HIDDEN = re.compile(r"gps|serial|owner|thumbnail|previewimage|jpgfromraw|otherimage|datadump|makernoteunknown", re.I)
_GROUP_LABEL = {"File": "Arquivo", "Composite": "Calculados", "IFD0": "EXIF (principal)", "ExifIFD": "EXIF (captura)",
                "IFD1": "EXIF (miniatura)", "InteropIFD": "EXIF (interoperabilidade)", "ICC_Profile": "Perfil de cor",
                "ICC-header": "Perfil de cor (cabeçalho)", "JFIF": "JFIF", "XMP-dc": "XMP", "IPTC": "IPTC"}


def format_bytes(n: int) -> str:
    if n >= 1024 ** 3:
        return f"{n / 1024 ** 3:.1f} GB".replace(".", ",")
    if n >= 1024 ** 2:
        return f"{n / 1024 ** 2:.1f} MB".replace(".", ",")
    return f"{max(1, round(n / 1024))} KB"


def _first(tags: dict, *names: str):
    for name in names:
        for key, value in tags.items():
            if key.split(":", 1)[-1] == name and value not in (None, "", "Unknown", "n/a"):
                return value
    return None


def read(storage: ObjectStorage, image: Image) -> dict:
    original_key = image.source_key or image.object_key
    original_format = (image.source_format or "jpg").lower()
    original_bytes = image.source_bytes if image.source_key else image.size_bytes
    tags: dict = {}
    unavailable = False
    try:
        tags = exiftool.read_tags(storage.get(original_key), original_format)
    except exiftool.ExifToolUnavailable:
        unavailable = True   # the summary still has what the database knows

    width = _first(tags, "ImageWidth", "ExifImageWidth") or image.width
    height = _first(tags, "ImageHeight", "ExifImageHeight") or image.height
    try:
        mp = f" ({int(width) * int(height) / 1e6:.1f} MP)".replace(".", ",")
    except (TypeError, ValueError):
        mp = ""
    camera = " ".join(str(x) for x in dict.fromkeys(filter(None, [_first(tags, "Make"), _first(tags, "Model")])))
    exposure = " · ".join(filter(None, [
        f"f/{_first(tags, 'FNumber', 'Aperture')}" if _first(tags, "FNumber", "Aperture") else None,
        f"{_first(tags, 'ExposureTime', 'ShutterSpeed')} s" if _first(tags, "ExposureTime", "ShutterSpeed") else None,
        f"ISO {_first(tags, 'ISO')}" if _first(tags, "ISO") else None,
        str(_first(tags, "FocalLength")) if _first(tags, "FocalLength") else None,
    ]))
    summary = [
        ("Arquivo original", f"{'JPEG' if original_format in ('jpg', 'jpeg') else original_format.upper()} · "
                             f"{format_bytes(original_bytes)}"),
        *([("Cópia JPEG (telas e downloads)", format_bytes(image.size_bytes))] if image.source_key else []),
        ("Dimensões", f"{width} × {height} px{mp}"),
        ("Câmera", camera or None),
        ("Lente", _first(tags, "LensModel", "LensID", "Lens", "LensType")),
        ("Exposição", exposure or None),
        ("Flash", _first(tags, "Flash")),
        ("Data de captura", _first(tags, "DateTimeOriginal", "CreateDate")),
        ("Programa de edição", _first(tags, "Software", "CreatorTool")),
        ("Perfil de cor", _first(tags, "ColorSpace", "ProfileDescription")),
        ("Localização", "Removida no envio, por privacidade"),
    ]
    groups: dict[str, list[dict]] = {}
    for key, value in tags.items():
        if ":" not in key:
            continue
        group, name = key.split(":", 1)
        if group in _HIDDEN_GROUPS or _HIDDEN.search(name) or _HIDDEN.search(group):
            continue
        text = str(value)
        if text.startswith("(Binary data") or len(text) > 300:
            continue
        groups.setdefault(_GROUP_LABEL.get(group, group), []).append({"label": name, "value": text})
    return {
        "summary": [{"label": k, "value": str(v)} for k, v in summary if v],
        "groups": [{"name": g, "items": items} for g, items in groups.items()],
        "complete": not unavailable,
    }
