"""Fixture builders — synthesise structurally valid binaries for tests.

Real .exe and .gba files cannot be committed to the repo, so the test suite
builds genuine ones byte by byte: a PE32+ image with a section table, data
directories and a real VS_VERSIONINFO resource tree, and a GBA ROM with a valid
cartridge header. These exercise the same code paths as files a user uploads.
"""

from __future__ import annotations

import struct

import gba

# -- VS_VERSIONINFO --------------------------------------------------------


def _align4(value: int) -> int:
    return (value + 3) & ~3


def _pad4(block: bytearray) -> None:
    while len(block) % 4:
        block.append(0)


def _wsz(text: str) -> bytes:
    return text.encode("utf-16-le") + b"\0\0"


def _node(key: str, value: bytes, value_length: int, value_type: int) -> bytearray:
    """Build one length-prefixed version node (header, key, padding, value)."""
    body = bytearray()
    body += struct.pack("<HHH", 0, value_length, value_type)  # length backfilled
    body += _wsz(key)
    _pad4(body)
    body += value
    _pad4(body)
    struct.pack_into("<H", body, 0, len(body))
    return body


def build_version_resource(strings: dict[str, str]) -> bytes:
    """A complete VS_VERSIONINFO block with one StringTable."""
    # String children
    children = bytearray()
    for key, value in strings.items():
        encoded = _wsz(value)
        node = _node(key, encoded, len(encoded) // 2, 1)
        children += node

    string_table = _node("040904b0", bytes(children), 0, 1)
    struct.pack_into("<H", string_table, 0, len(string_table))

    string_file_info = _node("StringFileInfo", bytes(string_table), 0, 1)
    struct.pack_into("<H", string_file_info, 0, len(string_file_info))

    # VS_FIXEDFILEINFO — 52 bytes, signature 0xFEEF04BD.
    fixed = struct.pack(
        "<IIIIIIIIIIIII",
        0xFEEF04BD, 0x00010000,
        0x00010000, 0x00000000,   # file version 1.0.0.0
        0x00010000, 0x00000000,   # product version 1.0.0.0
        0x0000003F, 0x00000000,
        0x00040004, 0x00000001,   # VOS_NT_WINDOWS32, VFT_APP
        0x00000000, 0x00000000, 0x00000000,
    )

    root = bytearray()
    root += struct.pack("<HHH", 0, len(fixed), 0)
    root += _wsz("VS_VERSION_INFO")
    _pad4(root)
    root += fixed
    _pad4(root)
    root += string_file_info
    struct.pack_into("<H", root, 0, len(root))
    return bytes(root)


# -- PE image --------------------------------------------------------------

FILE_ALIGN = 0x200
SECTION_ALIGN = 0x1000
HEADERS_SIZE = 0x400


def _round_up(value: int, alignment: int) -> int:
    return (value + alignment - 1) // alignment * alignment


def build_pe(version_strings: dict[str, str] | None = None) -> bytes:
    """Build a minimal but structurally valid PE32+ executable image."""
    version_strings = version_strings or {
        "CompanyName": "Wadle Test Fixtures",
        "FileDescription": "Synthetic PE used by the Wadle test suite",
        "FileVersion": "1.0.0.0",
        "InternalName": "fixture",
        "OriginalFilename": "fixture.exe",
        "ProductName": "Wadle Fixture",
        "ProductVersion": "1.0.0.0",
    }

    version_block = build_version_resource(version_strings)

    # .rsrc layout: three directory levels, one data entry, then the payload.
    rsrc_va = 0x2000
    dir_root = 0
    dir_type = 24
    dir_name = 48
    data_entry = 72
    payload_at = 88

    rsrc = bytearray(payload_at)

    def write_dir(at: int, entry_id: int, target: int, is_dir: bool) -> None:
        struct.pack_into("<IIHHHH", rsrc, at, 0, 0, 0, 0, 0, 1)
        struct.pack_into(
            "<II", rsrc, at + 16, entry_id, target | (0x80000000 if is_dir else 0)
        )

    write_dir(dir_root, gba_unused := 16, dir_type, True)  # RT_VERSION
    write_dir(dir_type, 1, dir_name, True)                 # resource id 1
    write_dir(dir_name, 1033, data_entry, False)           # lang en-US
    struct.pack_into(
        "<IIII", rsrc, data_entry, rsrc_va + payload_at, len(version_block), 0, 0
    )
    rsrc += version_block

    text = bytearray(b"\x48\x31\xC0\xC3")  # xor rax,rax ; ret
    text += b"WADLE-FIXTURE-MARKER\0"
    text += b"\0" * (0x100 - len(text))

    text_raw = _round_up(len(text), FILE_ALIGN)
    rsrc_raw = _round_up(len(rsrc), FILE_ALIGN)
    text_offset = HEADERS_SIZE
    rsrc_offset = text_offset + text_raw

    sections = [
        # name, vsize, va, raw size, raw offset, characteristics
        (b".text", len(text), 0x1000, text_raw, text_offset, 0x60000020),
        (b".rsrc", len(rsrc), rsrc_va, rsrc_raw, rsrc_offset, 0x40000040),
    ]

    size_of_image = _round_up(rsrc_va + len(rsrc), SECTION_ALIGN)
    image = bytearray(rsrc_offset + rsrc_raw)

    # DOS header + stub
    struct.pack_into("<H", image, 0, 0x5A4D)  # "MZ"
    struct.pack_into("<I", image, 0x3C, 0x80)
    image[0x40:0x4E] = b"This is a PE.\0"

    pe_at = 0x80
    image[pe_at:pe_at + 4] = b"PE\0\0"

    optional_size = 112 + 16 * 8
    struct.pack_into(
        "<HHIIIHH", image, pe_at + 4,
        0x8664,            # machine: x86-64
        len(sections),
        0x67E0_0000,       # timestamp
        0, 0,
        optional_size,
        0x0022,            # EXECUTABLE_IMAGE | LARGE_ADDRESS_AWARE
    )

    opt = pe_at + 24
    struct.pack_into("<H", image, opt, 0x20B)          # PE32+
    image[opt + 2] = 14                                 # linker major
    struct.pack_into("<I", image, opt + 4, text_raw)    # SizeOfCode
    struct.pack_into("<I", image, opt + 16, 0x1000)     # AddressOfEntryPoint
    struct.pack_into("<I", image, opt + 20, 0x1000)     # BaseOfCode
    struct.pack_into("<Q", image, opt + 24, 0x140000000)  # ImageBase
    struct.pack_into("<I", image, opt + 32, SECTION_ALIGN)
    struct.pack_into("<I", image, opt + 36, FILE_ALIGN)
    struct.pack_into("<H", image, opt + 48, 6)          # subsystem major
    struct.pack_into("<I", image, opt + 56, size_of_image)
    struct.pack_into("<I", image, opt + 60, HEADERS_SIZE)
    struct.pack_into("<I", image, opt + 64, 0)          # checksum (filled later)
    struct.pack_into("<H", image, opt + 68, 3)          # subsystem: console
    struct.pack_into("<I", image, opt + 108, 16)        # NumberOfRvaAndSizes

    # Data directory 2 = resources.
    struct.pack_into("<II", image, opt + 112 + 2 * 8, rsrc_va, len(rsrc))

    section_table = opt + optional_size
    for index, (name, vsize, va, raw_size, raw_offset, chars) in enumerate(sections):
        at = section_table + index * 40
        image[at:at + 8] = name.ljust(8, b"\0")
        struct.pack_into("<IIII", image, at + 8, vsize, va, raw_size, raw_offset)
        struct.pack_into("<I", image, at + 36, chars)

    image[text_offset:text_offset + len(text)] = text
    image[rsrc_offset:rsrc_offset + len(rsrc)] = rsrc
    return bytes(image)


def build_gba(title: str = "WADLEDEMO", game_code: str = "AWDE", size: int = 0x8000) -> bytes:
    """Build a GBA ROM with a valid cartridge header and save-type marker."""
    rom = bytearray(b"\0" * size)
    struct.pack_into("<I", rom, 0, 0xEA00002E)  # ARM branch
    rom[gba.LOGO_OFFSET:gba.LOGO_OFFSET + len(gba.LOGO_PREFIX)] = gba.LOGO_PREFIX
    rom[0xA0:0xAC] = title.upper().encode("ascii").ljust(12, b"\0")[:12]
    rom[0xAC:0xB0] = game_code.upper().encode("ascii").ljust(4, b"\0")[:4]
    rom[0xB0:0xB2] = b"01"
    rom[0xB2] = 0x96
    rom[0xBC] = 0
    rom[0xBD] = gba.header_checksum(rom)
    rom[0x1000:0x1008] = b"EEPROM_V"
    for i in range(0x2000, min(0x3000, size)):
        rom[i] = (i * 7) & 0xFF
    return bytes(rom)
