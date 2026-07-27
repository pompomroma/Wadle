"""Game Boy Advance ROM reading and header patching.

The GBA cartridge header is a fixed, fully documented layout, so reading and
rewriting it is exact rather than heuristic. Everything here operates on that
real structure: title, game code, maker code, version, and the complement check
byte that the BIOS validates at boot.

Scope note: this modifies ROM *data*, it does not decompile ARM7 machine code
into editable source. Gameplay changes to an existing commercial ROM are made
the way the romhacking community actually makes them — by patching bytes and
distributing an IPS/UPS/BPS patch (see patches.py) — not by asking a model to
read a binary and rewrite the game.
"""

from __future__ import annotations

import struct
from typing import Any

HEADER_SIZE = 0xC0
LOGO_OFFSET = 0x04
LOGO_SIZE = 156
TITLE_OFFSET = 0xA0
TITLE_SIZE = 12
GAME_CODE_OFFSET = 0xAC
MAKER_CODE_OFFSET = 0xB0
FIXED_BYTE_OFFSET = 0xB2
UNIT_CODE_OFFSET = 0xB3
DEVICE_TYPE_OFFSET = 0xB4
VERSION_OFFSET = 0xBC
COMPLEMENT_OFFSET = 0xBD

# First bytes of the mandatory Nintendo logo — a reliable GBA fingerprint.
LOGO_PREFIX = bytes([0x24, 0xFF, 0xAE, 0x51, 0x69, 0x9A])


class ROMError(Exception):
    """Raised when the data is not a usable GBA ROM."""


def header_checksum(data: bytes | bytearray) -> int:
    """Complement check over header bytes 0xA0..0xBC inclusive."""
    total = 0
    for offset in range(TITLE_OFFSET, COMPLEMENT_OFFSET):
        total = (total - data[offset]) & 0xFF
    return (total - 0x19) & 0xFF


def _ascii(raw: bytes) -> str:
    return raw.rstrip(b"\0").decode("ascii", "replace")


def read_header(raw: bytes) -> dict[str, Any]:
    if len(raw) < HEADER_SIZE:
        raise ROMError(
            f"File is {len(raw)} bytes; a GBA ROM needs at least {HEADER_SIZE}."
        )

    logo_ok = bytes(raw[LOGO_OFFSET:LOGO_OFFSET + len(LOGO_PREFIX)]) == LOGO_PREFIX
    stored = raw[COMPLEMENT_OFFSET]
    computed = header_checksum(raw)

    entry = struct.unpack_from("<I", raw, 0)[0]
    return {
        "format": "gba",
        "title": _ascii(bytes(raw[TITLE_OFFSET:TITLE_OFFSET + TITLE_SIZE])),
        "gameCode": _ascii(bytes(raw[GAME_CODE_OFFSET:GAME_CODE_OFFSET + 4])),
        "makerCode": _ascii(bytes(raw[MAKER_CODE_OFFSET:MAKER_CODE_OFFSET + 2])),
        "version": raw[VERSION_OFFSET],
        "unitCode": raw[UNIT_CODE_OFFSET],
        "deviceType": raw[DEVICE_TYPE_OFFSET],
        "entryPoint": f"0x{entry:08x}",
        "romSize": len(raw),
        "nintendoLogoValid": logo_ok,
        "fixedByteValid": raw[FIXED_BYTE_OFFSET] == 0x96,
        "headerChecksum": stored,
        "headerChecksumComputed": computed,
        "headerChecksumValid": stored == computed,
        "saveType": detect_save_type(raw),
    }


def detect_save_type(raw: bytes) -> str | None:
    """GBA carts advertise their backup hardware as a plain ASCII marker."""
    markers = [
        (b"EEPROM_V", "EEPROM"),
        (b"SRAM_V", "SRAM"),
        (b"SRAM_F_V", "SRAM"),
        (b"FLASH_V", "FLASH 64K"),
        (b"FLASH512_V", "FLASH 512K"),
        (b"FLASH1M_V", "FLASH 1M"),
    ]
    for marker, label in markers:
        if marker in raw:
            return label
    return None


def patch_header(
    raw: bytes,
    *,
    title: str | None = None,
    game_code: str | None = None,
    maker_code: str | None = None,
    version: int | None = None,
) -> tuple[bytearray, dict[str, Any]]:
    """Rewrite header fields and fix the complement check.

    Fields are fixed-width in the cartridge header, so an over-long value is
    rejected rather than silently truncated into a ROM that boots with a
    mangled title.
    """
    if len(raw) < HEADER_SIZE:
        raise ROMError("File is too small to contain a GBA header.")

    data = bytearray(raw)
    changes: dict[str, Any] = {}

    if title is not None:
        encoded = title.upper().encode("ascii", "replace")
        if len(encoded) > TITLE_SIZE:
            raise ROMError(
                f"Title '{title}' is {len(encoded)} characters; the GBA header "
                f"reserves exactly {TITLE_SIZE}."
            )
        data[TITLE_OFFSET:TITLE_OFFSET + TITLE_SIZE] = encoded.ljust(TITLE_SIZE, b"\0")
        changes["title"] = title.upper()

    if game_code is not None:
        encoded = game_code.upper().encode("ascii", "replace")
        if len(encoded) != 4:
            raise ROMError(f"Game code must be exactly 4 characters, got '{game_code}'.")
        data[GAME_CODE_OFFSET:GAME_CODE_OFFSET + 4] = encoded
        changes["gameCode"] = game_code.upper()

    if maker_code is not None:
        encoded = maker_code.upper().encode("ascii", "replace")
        if len(encoded) != 2:
            raise ROMError(f"Maker code must be exactly 2 characters, got '{maker_code}'.")
        data[MAKER_CODE_OFFSET:MAKER_CODE_OFFSET + 2] = encoded
        changes["makerCode"] = maker_code.upper()

    if version is not None:
        if not 0 <= version <= 255:
            raise ROMError("Version must be a byte in the range 0-255.")
        data[VERSION_OFFSET] = version
        changes["version"] = version

    data[COMPLEMENT_OFFSET] = header_checksum(data)
    changes["headerChecksum"] = data[COMPLEMENT_OFFSET]
    return data, changes


def export_tiles(
    raw: bytes,
    *,
    offset: int,
    count: int,
    bpp: int = 4,
    palette: list[tuple[int, int, int]] | None = None,
    columns: int = 16,
) -> dict[str, Any]:
    """Decode GBA character data into an RGB bitmap.

    GBA tiles are 8x8, either 4bpp (two pixels per byte, low nibble first) or
    8bpp. Returns raw RGB rows plus geometry; the caller turns that into a PNG.
    """
    if bpp not in (4, 8):
        raise ROMError("GBA tiles are either 4bpp or 8bpp.")

    tile_bytes = 32 if bpp == 4 else 64
    needed = offset + count * tile_bytes
    if needed > len(raw):
        raise ROMError(
            f"Tile range needs {needed} bytes but the ROM is {len(raw)} bytes."
        )

    if palette is None:
        # Neutral ramp so structure is visible without knowing the real palette.
        steps = 16 if bpp == 4 else 256
        palette = [(i * 255 // (steps - 1),) * 3 for i in range(steps)]

    rows = (count + columns - 1) // columns
    width = columns * 8
    height = rows * 8
    pixels = bytearray(width * height * 3)

    for index in range(count):
        tile_x = (index % columns) * 8
        tile_y = (index // columns) * 8
        base = offset + index * tile_bytes
        for y in range(8):
            for x in range(8):
                if bpp == 4:
                    byte = raw[base + y * 4 + x // 2]
                    value = (byte & 0x0F) if x % 2 == 0 else (byte >> 4)
                else:
                    value = raw[base + y * 8 + x]
                colour = palette[value % len(palette)]
                pos = ((tile_y + y) * width + (tile_x + x)) * 3
                pixels[pos] = colour[0]
                pixels[pos + 1] = colour[1]
                pixels[pos + 2] = colour[2]

    return {"width": width, "height": height, "rgb": bytes(pixels), "tiles": count}


def read_palette(raw: bytes, offset: int, colours: int = 16) -> list[tuple[int, int, int]]:
    """GBA palettes are 15-bit BGR555, one halfword per colour."""
    result: list[tuple[int, int, int]] = []
    for i in range(colours):
        at = offset + i * 2
        if at + 2 > len(raw):
            break
        value = struct.unpack_from("<H", raw, at)[0]
        r = (value & 0x1F) << 3
        g = ((value >> 5) & 0x1F) << 3
        b = ((value >> 10) & 0x1F) << 3
        result.append((r | r >> 5, g | g >> 5, b | b >> 5))
    return result
