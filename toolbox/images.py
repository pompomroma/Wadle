"""Image encoding and conversion.

`write_png` is pure standard library, so extracting graphics from a ROM works on
a bare Python install with nothing to install first. Broader format conversion
(JPEG, WebP, BMP, resizing) uses Pillow when it is available; when it is not,
the caller is told so explicitly rather than handed a silently wrong file.
"""

from __future__ import annotations

import struct
import zlib
from typing import Any

try:  # optional
    from PIL import Image  # type: ignore

    HAVE_PILLOW = True
except Exception:  # pragma: no cover - depends on the host
    Image = None  # type: ignore
    HAVE_PILLOW = False


def _chunk(tag: bytes, payload: bytes) -> bytes:
    return (
        struct.pack(">I", len(payload))
        + tag
        + payload
        + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
    )


def write_png(width: int, height: int, rgb: bytes) -> bytes:
    """Encode raw RGB bytes as a PNG (8-bit, colour type 2, no interlace)."""
    expected = width * height * 3
    if len(rgb) != expected:
        raise ValueError(f"Expected {expected} RGB bytes, got {len(rgb)}.")

    # Each scanline is prefixed with filter type 0 (None).
    raw = bytearray()
    stride = width * 3
    for y in range(height):
        raw.append(0)
        raw += rgb[y * stride: (y + 1) * stride]

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", header)
        + _chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + _chunk(b"IEND", b"")
    )


def convert(src: str, dst: str, *, width: int | None = None, height: int | None = None) -> dict[str, Any]:
    if not HAVE_PILLOW:
        raise RuntimeError(
            "Image conversion needs Pillow, which is not installed on this host. "
            "Install it with `pip install Pillow`, or run Wadle via docker compose "
            "where it is preinstalled. PNG output from ROM/tile extraction still "
            "works without it."
        )
    with Image.open(src) as image:  # type: ignore[union-attr]
        if width or height:
            target = (width or image.width, height or image.height)
            image = image.resize(target)
        if dst.lower().endswith((".jpg", ".jpeg")) and image.mode in ("RGBA", "P"):
            image = image.convert("RGB")
        image.save(dst)
        return {"width": image.width, "height": image.height, "mode": image.mode}


def inspect(src: str) -> dict[str, Any]:
    if not HAVE_PILLOW:
        return {"format": "image", "pillow": False}
    with Image.open(src) as image:  # type: ignore[union-attr]
        return {
            "format": (image.format or "").lower(),
            "width": image.width,
            "height": image.height,
            "mode": image.mode,
            "pillow": True,
        }
