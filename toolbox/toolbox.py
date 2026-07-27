#!/usr/bin/env python3
"""Wadle binary toolbox — JSON in on stdin, JSON out on stdout.

Invoked as a subprocess by the Node server:

    echo '{"path": "game.gba"}' | python3 toolbox/toolbox.py gba.header

Keeping this as a separate process means a malformed binary can only crash the
toolbox, never the server, and it keeps the parsing code in the language with
the cleanest byte-level story.

Every command returns {"ok": true, ...} or {"ok": false, "error": "..."} and
exits 0 either way, so the caller distinguishes "this file cannot be handled"
from "the toolbox itself broke".
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from typing import Any, Callable

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import gba  # noqa: E402
import images  # noqa: E402
import patches  # noqa: E402
import pe  # noqa: E402

Handler = Callable[[dict[str, Any]], dict[str, Any]]


def _read(path: str) -> bytes:
    with open(path, "rb") as handle:
        return handle.read()


def _write(path: str, data: bytes) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(data)


# -- commands --------------------------------------------------------------


def cmd_capabilities(_: dict[str, Any]) -> dict[str, Any]:
    return {
        "python": sys.version.split()[0],
        "pillow": images.HAVE_PILLOW,
        "formats": {
            "pe": {"inspect": True, "patchVersion": True, "checksum": True},
            "gba": {"inspect": True, "patchHeader": True, "exportTiles": True},
            "patches": {"ips": True, "ups": True, "bps": True},
            "images": {"png": True, "convert": images.HAVE_PILLOW},
        },
    }


def cmd_pe_inspect(payload: dict[str, Any]) -> dict[str, Any]:
    binary = pe.PEFile.parse(_read(payload["path"]))
    return binary.to_dict()


def cmd_pe_patch(payload: dict[str, Any]) -> dict[str, Any]:
    binary = pe.PEFile.parse(_read(payload["path"]))
    result = binary.set_version_strings(payload.get("versionStrings", {}))
    checksum = binary.recompute_checksum()
    _write(payload["out"], bytes(binary.data))
    return {
        "out": payload["out"],
        "checksum": f"0x{checksum:08x}",
        **result,
    }


def cmd_pe_strings(payload: dict[str, Any]) -> dict[str, Any]:
    data = _read(payload["path"])
    minimum = int(payload.get("min", 6))
    limit = int(payload.get("limit", 500))
    found: list[str] = []
    current = bytearray()
    for byte in data:
        if 32 <= byte < 127:
            current.append(byte)
            continue
        if len(current) >= minimum:
            found.append(current.decode("ascii"))
            if len(found) >= limit:
                break
        current.clear()
    if len(current) >= minimum and len(found) < limit:
        found.append(current.decode("ascii"))
    return {"strings": found}


def cmd_gba_header(payload: dict[str, Any]) -> dict[str, Any]:
    return gba.read_header(_read(payload["path"]))


def cmd_gba_patch_header(payload: dict[str, Any]) -> dict[str, Any]:
    data, changes = gba.patch_header(
        _read(payload["path"]),
        title=payload.get("title"),
        game_code=payload.get("gameCode"),
        maker_code=payload.get("makerCode"),
        version=payload.get("version"),
    )
    _write(payload["out"], bytes(data))
    return {"out": payload["out"], "changes": changes}


def cmd_gba_export_tiles(payload: dict[str, Any]) -> dict[str, Any]:
    rom = _read(payload["path"])
    palette = None
    if "paletteOffset" in payload:
        palette = gba.read_palette(
            rom,
            int(payload["paletteOffset"]),
            int(payload.get("paletteColours", 16)),
        )
    result = gba.export_tiles(
        rom,
        offset=int(payload.get("offset", 0)),
        count=int(payload.get("count", 256)),
        bpp=int(payload.get("bpp", 4)),
        palette=palette,
        columns=int(payload.get("columns", 16)),
    )
    png = images.write_png(result["width"], result["height"], result["rgb"])
    _write(payload["out"], png)
    return {
        "out": payload["out"],
        "width": result["width"],
        "height": result["height"],
        "tiles": result["tiles"],
    }


def cmd_patch_create(payload: dict[str, Any]) -> dict[str, Any]:
    original = _read(payload["original"])
    modified = _read(payload["modified"])
    fmt = payload.get("format", "ips")
    data = patches.create(fmt, original, modified)
    _write(payload["out"], data)
    return {"out": payload["out"], "format": fmt, "size": len(data)}


def cmd_patch_apply(payload: dict[str, Any]) -> dict[str, Any]:
    original = _read(payload["original"])
    patch = _read(payload["patch"])
    result = patches.apply(original, patch)
    _write(payload["out"], result)
    return {
        "out": payload["out"],
        "size": len(result),
        "patch": patches.describe(patch),
    }


def cmd_patch_describe(payload: dict[str, Any]) -> dict[str, Any]:
    return patches.describe(_read(payload["path"]))


def cmd_image_convert(payload: dict[str, Any]) -> dict[str, Any]:
    return images.convert(
        payload["src"],
        payload["dst"],
        width=payload.get("width"),
        height=payload.get("height"),
    )


def cmd_image_inspect(payload: dict[str, Any]) -> dict[str, Any]:
    return images.inspect(payload["path"])


COMMANDS: dict[str, Handler] = {
    "capabilities": cmd_capabilities,
    "pe.inspect": cmd_pe_inspect,
    "pe.patch": cmd_pe_patch,
    "pe.strings": cmd_pe_strings,
    "gba.header": cmd_gba_header,
    "gba.patchHeader": cmd_gba_patch_header,
    "gba.exportTiles": cmd_gba_export_tiles,
    "patch.create": cmd_patch_create,
    "patch.apply": cmd_patch_apply,
    "patch.describe": cmd_patch_describe,
    "image.convert": cmd_image_convert,
    "image.inspect": cmd_image_inspect,
}


def main() -> int:
    if len(sys.argv) < 2:
        json.dump(
            {"ok": False, "error": f"Usage: toolbox.py <command>. Known: {sorted(COMMANDS)}"},
            sys.stdout,
        )
        return 0

    command = sys.argv[1]
    handler = COMMANDS.get(command)
    if handler is None:
        json.dump(
            {"ok": False, "error": f"Unknown command '{command}'. Known: {sorted(COMMANDS)}"},
            sys.stdout,
        )
        return 0

    raw = sys.stdin.read().strip()
    try:
        payload = json.loads(raw) if raw else {}
    except json.JSONDecodeError as error:
        json.dump({"ok": False, "error": f"Invalid JSON input: {error}"}, sys.stdout)
        return 0

    try:
        result = handler(payload)
        json.dump({"ok": True, **result}, sys.stdout)
    except (pe.PEError, gba.ROMError, patches.PatchError) as error:
        json.dump({"ok": False, "error": str(error)}, sys.stdout)
    except FileNotFoundError as error:
        json.dump({"ok": False, "error": f"File not found: {error.filename}"}, sys.stdout)
    except Exception as error:  # noqa: BLE001 - report, never crash the caller
        json.dump(
            {
                "ok": False,
                "error": f"{type(error).__name__}: {error}",
                "traceback": traceback.format_exc(limit=6),
            },
            sys.stdout,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
