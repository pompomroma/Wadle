"""Portable Executable (.exe / .dll) reading and targeted patching.

Pure standard library — no pefile dependency, so this works on a bare Python
install. It parses the real on-disk structure: DOS stub, COFF header, optional
header, section table, data directories, import/export tables and the resource
tree, including the VS_VERSIONINFO block used for file metadata.

What this does NOT do, and will not pretend to: turn machine code back into
editable source. A compiled binary cannot be "redesigned" by reading its bytes.
What is real and supported is inspection plus targeted rewriting of structured
regions (version metadata, string tables, embedded resources), followed by a
correct checksum so the result is a valid executable.
"""

from __future__ import annotations

import math
import struct
from dataclasses import dataclass, field
from typing import Any

MACHINE_NAMES = {
    0x014C: "i386",
    0x0200: "ia64",
    0x8664: "x86-64",
    0x01C0: "arm",
    0xAA64: "arm64",
    0x01C4: "armnt",
}

SUBSYSTEM_NAMES = {
    1: "native",
    2: "windows-gui",
    3: "windows-cui",
    5: "os2-cui",
    7: "posix-cui",
    9: "windows-ce-gui",
    10: "efi-application",
    16: "windows-boot-application",
}

DIRECTORY_NAMES = [
    "export", "import", "resource", "exception", "security", "basereloc",
    "debug", "architecture", "globalptr", "tls", "load_config", "bound_import",
    "iat", "delay_import", "com_descriptor", "reserved",
]

RT_VERSION = 16
RT_ICON = 3
RT_GROUP_ICON = 14
RT_STRING = 6
RT_MANIFEST = 24

RESOURCE_TYPE_NAMES = {
    1: "CURSOR", 2: "BITMAP", 3: "ICON", 4: "MENU", 5: "DIALOG", 6: "STRING",
    7: "FONTDIR", 8: "FONT", 9: "ACCELERATOR", 10: "RCDATA", 11: "MESSAGETABLE",
    12: "GROUP_CURSOR", 14: "GROUP_ICON", 16: "VERSION", 17: "DLGINCLUDE",
    19: "PLUGPLAY", 20: "VXD", 21: "ANICURSOR", 22: "ANIICON", 23: "HTML",
    24: "MANIFEST",
}


class PEError(Exception):
    """Raised when the file is not a PE, or is structurally unusable."""


@dataclass
class Section:
    name: str
    virtual_size: int
    virtual_address: int
    raw_size: int
    raw_offset: int
    characteristics: int
    entropy: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "virtualSize": self.virtual_size,
            "virtualAddress": self.virtual_address,
            "rawSize": self.raw_size,
            "rawOffset": self.raw_offset,
            "characteristics": f"0x{self.characteristics:08x}",
            "executable": bool(self.characteristics & 0x20000000),
            "writable": bool(self.characteristics & 0x80000000),
            "entropy": round(self.entropy, 3),
        }


@dataclass
class ResourceLeaf:
    type_id: int | str
    name_id: int | str
    lang_id: int
    rva: int
    size: int
    offset: int
    code_page: int
    # File offset of the IMAGE_RESOURCE_DATA_ENTRY itself, so its Size field
    # can be rewritten when the payload changes.
    entry_offset: int = 0

    def to_dict(self) -> dict[str, Any]:
        type_label = (
            RESOURCE_TYPE_NAMES.get(self.type_id, str(self.type_id))
            if isinstance(self.type_id, int)
            else self.type_id
        )
        return {
            "type": type_label,
            "typeId": self.type_id,
            "name": self.name_id,
            "language": self.lang_id,
            "size": self.size,
            "offset": self.offset,
        }


@dataclass
class PEFile:
    data: bytearray
    pe_offset: int = 0
    machine: int = 0
    number_of_sections: int = 0
    timestamp: int = 0
    characteristics: int = 0
    optional_offset: int = 0
    magic: int = 0
    is_64: bool = False
    entry_point: int = 0
    image_base: int = 0
    checksum_offset: int = 0
    checksum: int = 0
    subsystem: int = 0
    dll_characteristics: int = 0
    size_of_image: int = 0
    sections: list[Section] = field(default_factory=list)
    directories: list[tuple[int, int]] = field(default_factory=list)

    # -- parsing ---------------------------------------------------------

    @classmethod
    def parse(cls, raw: bytes) -> "PEFile":
        data = bytearray(raw)
        if len(data) < 0x40 or data[0:2] != b"MZ":
            raise PEError("Not a PE file: missing 'MZ' DOS signature.")

        pe_offset = struct.unpack_from("<I", data, 0x3C)[0]
        if pe_offset + 24 > len(data) or data[pe_offset:pe_offset + 4] != b"PE\0\0":
            raise PEError("Not a PE file: missing 'PE\\0\\0' signature.")

        pe = cls(data=data, pe_offset=pe_offset)
        coff = pe_offset + 4
        (
            pe.machine,
            pe.number_of_sections,
            pe.timestamp,
            _sym_ptr,
            _sym_count,
            size_of_optional,
            pe.characteristics,
        ) = struct.unpack_from("<HHIIIHH", data, coff)

        pe.optional_offset = coff + 20
        if size_of_optional == 0:
            raise PEError("Object file (no optional header); not an executable image.")

        opt = pe.optional_offset
        pe.magic = struct.unpack_from("<H", data, opt)[0]
        if pe.magic == 0x20B:
            pe.is_64 = True
        elif pe.magic != 0x10B:
            raise PEError(f"Unsupported optional header magic 0x{pe.magic:04x}.")

        pe.entry_point = struct.unpack_from("<I", data, opt + 16)[0]
        if pe.is_64:
            pe.image_base = struct.unpack_from("<Q", data, opt + 24)[0]
            dir_count_offset = opt + 108
            dir_offset = opt + 112
        else:
            pe.image_base = struct.unpack_from("<I", data, opt + 28)[0]
            dir_count_offset = opt + 92
            dir_offset = opt + 96

        pe.size_of_image = struct.unpack_from("<I", data, opt + 56)[0]
        pe.checksum_offset = opt + 64
        pe.checksum = struct.unpack_from("<I", data, pe.checksum_offset)[0]
        pe.subsystem = struct.unpack_from("<H", data, opt + 68)[0]
        pe.dll_characteristics = struct.unpack_from("<H", data, opt + 70)[0]

        dir_count = struct.unpack_from("<I", data, dir_count_offset)[0]
        dir_count = min(dir_count, 16)
        for i in range(dir_count):
            rva, size = struct.unpack_from("<II", data, dir_offset + i * 8)
            pe.directories.append((rva, size))

        section_offset = pe.optional_offset + size_of_optional
        for i in range(pe.number_of_sections):
            base = section_offset + i * 40
            if base + 40 > len(data):
                break
            raw_name = bytes(data[base:base + 8]).rstrip(b"\0")
            vsize, vaddr, rsize, roff = struct.unpack_from("<IIII", data, base + 8)
            chars = struct.unpack_from("<I", data, base + 36)[0]
            section = Section(
                name=raw_name.decode("utf-8", "replace"),
                virtual_size=vsize,
                virtual_address=vaddr,
                raw_size=rsize,
                raw_offset=roff,
                characteristics=chars,
            )
            section.entropy = _entropy(data[roff:roff + min(rsize, 1 << 20)])
            pe.sections.append(section)

        return pe

    # -- address translation ---------------------------------------------

    def rva_to_offset(self, rva: int) -> int | None:
        for section in self.sections:
            start = section.virtual_address
            end = start + max(section.virtual_size, section.raw_size)
            if start <= rva < end:
                delta = rva - start
                if delta >= section.raw_size:
                    return None  # inside virtual padding, not present on disk
                return section.raw_offset + delta
        # Headers are mapped 1:1.
        if rva < (self.sections[0].raw_offset if self.sections else len(self.data)):
            return rva
        return None

    def read_cstring(self, offset: int, limit: int = 512) -> str:
        end = self.data.find(b"\0", offset, offset + limit)
        if end == -1:
            end = offset + limit
        return bytes(self.data[offset:end]).decode("utf-8", "replace")

    # -- tables ----------------------------------------------------------

    def imports(self) -> list[dict[str, Any]]:
        if len(self.directories) < 2:
            return []
        rva, size = self.directories[1]
        if not rva or not size:
            return []
        offset = self.rva_to_offset(rva)
        if offset is None:
            return []

        result: list[dict[str, Any]] = []
        cursor = offset
        while cursor + 20 <= len(self.data) and len(result) < 256:
            original_thunk, _ts, _fc, name_rva, first_thunk = struct.unpack_from(
                "<IIIII", self.data, cursor
            )
            if not any((original_thunk, name_rva, first_thunk)):
                break
            name_offset = self.rva_to_offset(name_rva) if name_rva else None
            dll = self.read_cstring(name_offset) if name_offset is not None else "?"
            result.append(
                {"dll": dll, "functions": self._thunk_names(original_thunk or first_thunk)}
            )
            cursor += 20
        return result

    def _thunk_names(self, thunk_rva: int) -> list[str]:
        if not thunk_rva:
            return []
        offset = self.rva_to_offset(thunk_rva)
        if offset is None:
            return []
        width = 8 if self.is_64 else 4
        fmt = "<Q" if self.is_64 else "<I"
        ordinal_flag = 1 << (63 if self.is_64 else 31)
        names: list[str] = []
        cursor = offset
        while cursor + width <= len(self.data) and len(names) < 512:
            value = struct.unpack_from(fmt, self.data, cursor)[0]
            if value == 0:
                break
            if value & ordinal_flag:
                names.append(f"#{value & 0xFFFF}")
            else:
                hint_offset = self.rva_to_offset(value & 0x7FFFFFFF)
                if hint_offset is not None:
                    names.append(self.read_cstring(hint_offset + 2))
            cursor += width
        return names

    def exports(self) -> dict[str, Any]:
        if not self.directories:
            return {"name": None, "functions": []}
        rva, size = self.directories[0]
        if not rva or not size:
            return {"name": None, "functions": []}
        offset = self.rva_to_offset(rva)
        if offset is None or offset + 40 > len(self.data):
            return {"name": None, "functions": []}

        (
            _flags, _ts, _major, _minor, name_rva, _base,
            _num_functions, num_names, _addr_functions, addr_names, _addr_ords,
        ) = struct.unpack_from("<IIHHIIIIIII", self.data, offset)

        name_offset = self.rva_to_offset(name_rva) if name_rva else None
        module = self.read_cstring(name_offset) if name_offset is not None else None

        functions: list[str] = []
        names_offset = self.rva_to_offset(addr_names) if addr_names else None
        if names_offset is not None:
            for i in range(min(num_names, 2048)):
                entry = names_offset + i * 4
                if entry + 4 > len(self.data):
                    break
                fn_rva = struct.unpack_from("<I", self.data, entry)[0]
                fn_offset = self.rva_to_offset(fn_rva)
                if fn_offset is not None:
                    functions.append(self.read_cstring(fn_offset))
        return {"name": module, "functions": functions}

    def resources(self) -> list[ResourceLeaf]:
        if len(self.directories) < 3:
            return []
        rva, size = self.directories[2]
        if not rva or not size:
            return []
        base = self.rva_to_offset(rva)
        if base is None:
            return []
        leaves: list[ResourceLeaf] = []
        self._walk_resource_dir(base, base, 0, [], leaves)
        return leaves

    def _walk_resource_dir(
        self,
        base: int,
        offset: int,
        depth: int,
        path: list[int | str],
        out: list[ResourceLeaf],
    ) -> None:
        if depth > 3 or offset + 16 > len(self.data) or len(out) > 4096:
            return
        named, ident = struct.unpack_from("<HH", self.data, offset + 12)
        entries_at = offset + 16
        for i in range(named + ident):
            entry = entries_at + i * 8
            if entry + 8 > len(self.data):
                return
            name_field, data_field = struct.unpack_from("<II", self.data, entry)

            if name_field & 0x80000000:
                key: int | str = self._resource_name(base + (name_field & 0x7FFFFFFF))
            else:
                key = name_field

            if data_field & 0x80000000:
                self._walk_resource_dir(
                    base, base + (data_field & 0x7FFFFFFF), depth + 1, path + [key], out
                )
            else:
                leaf_at = base + data_field
                if leaf_at + 16 > len(self.data):
                    continue
                data_rva, data_size, code_page, _reserved = struct.unpack_from(
                    "<IIII", self.data, leaf_at
                )
                file_offset = self.rva_to_offset(data_rva)
                if file_offset is None:
                    continue
                full = path + [key]
                out.append(
                    ResourceLeaf(
                        type_id=full[0] if len(full) > 0 else 0,
                        name_id=full[1] if len(full) > 1 else 0,
                        lang_id=full[2] if len(full) > 2 and isinstance(full[2], int) else 0,
                        rva=data_rva,
                        size=data_size,
                        offset=file_offset,
                        code_page=code_page,
                        entry_offset=leaf_at,
                    )
                )

    def _resource_name(self, offset: int) -> str:
        if offset + 2 > len(self.data):
            return "?"
        length = struct.unpack_from("<H", self.data, offset)[0]
        raw = bytes(self.data[offset + 2: offset + 2 + length * 2])
        return raw.decode("utf-16-le", "replace")

    # -- version metadata -------------------------------------------------

    def version_strings(self) -> dict[str, str]:
        leaf = self._version_leaf()
        if leaf is None:
            return {}
        block = bytes(self.data[leaf.offset: leaf.offset + leaf.size])
        return _parse_version_strings(block)

    def _version_leaf(self) -> ResourceLeaf | None:
        for leaf in self.resources():
            if leaf.type_id == RT_VERSION:
                return leaf
        return None

    def set_version_strings(self, updates: dict[str, str]) -> dict[str, Any]:
        """Rewrite StringFileInfo values in place.

        Values are written into the existing allocation. A replacement that
        needs more room than the original reserved would require relaying out
        and growing the .rsrc section; rather than corrupt the binary, that case
        is reported back as `skipped` with the reason.
        """
        leaf = self._version_leaf()
        if leaf is None:
            raise PEError("This binary has no VERSION resource to patch.")

        block = bytes(self.data[leaf.offset: leaf.offset + leaf.size])
        applied: dict[str, str] = {}
        skipped: list[dict[str, Any]] = []

        for key, new_value in updates.items():
            location = _find_version_value(block, key)
            if location is None:
                skipped.append({"key": key, "reason": "key not present in this binary"})
                continue
            value_offset, value_chars = location
            encoded = new_value.encode("utf-16-le") + b"\0\0"
            capacity = value_chars * 2
            if len(encoded) > capacity:
                skipped.append(
                    {
                        "key": key,
                        "reason": (
                            f"value needs {len(encoded)} bytes but only {capacity} are "
                            "reserved; growing the resource would require relaying out "
                            "the .rsrc section"
                        ),
                    }
                )
                continue
            absolute = leaf.offset + value_offset
            self.data[absolute: absolute + capacity] = encoded.ljust(capacity, b"\0")
            applied[key] = new_value

        return {"applied": applied, "skipped": skipped}

    # -- output -----------------------------------------------------------

    def recompute_checksum(self) -> int:
        """Standard PE checksum: 16-bit ones-complement sum plus file length."""
        data = bytearray(self.data)
        struct.pack_into("<I", data, self.checksum_offset, 0)

        total = 0
        length = len(data)
        # Sum as 16-bit words with end-around carry.
        for i in range(0, length - (length % 2), 2):
            total += data[i] | (data[i + 1] << 8)
            total = (total & 0xFFFF) + (total >> 16)
        if length % 2:
            total += data[length - 1]
            total = (total & 0xFFFF) + (total >> 16)

        checksum = (total + length) & 0xFFFFFFFF
        struct.pack_into("<I", self.data, self.checksum_offset, checksum)
        self.checksum = checksum
        return checksum

    def to_dict(self) -> dict[str, Any]:
        exports = self.exports()
        return {
            "format": "pe",
            "machine": MACHINE_NAMES.get(self.machine, f"0x{self.machine:04x}"),
            "bits": 64 if self.is_64 else 32,
            "subsystem": SUBSYSTEM_NAMES.get(self.subsystem, str(self.subsystem)),
            "isDll": bool(self.characteristics & 0x2000),
            "entryPoint": f"0x{self.entry_point:08x}",
            "imageBase": f"0x{self.image_base:x}",
            "sizeOfImage": self.size_of_image,
            "timestamp": self.timestamp,
            "checksum": f"0x{self.checksum:08x}",
            "sections": [section.to_dict() for section in self.sections],
            "dataDirectories": [
                {"name": DIRECTORY_NAMES[i] if i < len(DIRECTORY_NAMES) else str(i),
                 "rva": rva, "size": size}
                for i, (rva, size) in enumerate(self.directories)
                if rva or size
            ],
            "imports": self.imports(),
            "exports": exports,
            "resources": [leaf.to_dict() for leaf in self.resources()[:200]],
            "versionStrings": self.version_strings(),
        }


# -- VS_VERSIONINFO helpers ------------------------------------------------


def _align4(value: int) -> int:
    return (value + 3) & ~3


def _read_sz(block: bytes, offset: int) -> tuple[str, int]:
    """Read a NUL-terminated UTF-16 string; return it and the offset after it."""
    end = offset
    while end + 1 < len(block) and block[end: end + 2] != b"\0\0":
        end += 2
    text = block[offset:end].decode("utf-16-le", "replace")
    return text, end + 2


def _parse_version_strings(block: bytes) -> dict[str, str]:
    """Walk VS_VERSIONINFO → StringFileInfo → StringTable → String entries."""
    result: dict[str, str] = {}
    for key, _value_offset, _chars, value in _iter_version_entries(block):
        result[key] = value
    return result


def _find_version_value(block: bytes, key: str) -> tuple[int, int] | None:
    for entry_key, value_offset, chars, _value in _iter_version_entries(block):
        if entry_key.lower() == key.lower():
            return value_offset, chars
    return None


def _iter_version_entries(block: bytes):
    """Yield (key, value_offset, value_chars, value) for every String entry."""
    if len(block) < 6:
        return

    def walk(offset: int, end: int, depth: int):
        while offset + 6 <= end and depth < 6:
            length, value_length, value_type = struct.unpack_from("<HHH", block, offset)
            if length == 0:
                return
            node_end = min(offset + length, end)
            key, after_key = _read_sz(block, offset + 6)
            value_offset = _align4(after_key)

            if value_type == 1 and value_length > 0 and key not in (
                "VS_VERSION_INFO", "StringFileInfo", "VarFileInfo"
            ):
                # value_length counts UTF-16 code units including the
                # terminator. Decode the whole slice and strip NULs afterwards —
                # splitting the *bytes* on b"\0\0" would cut mid code unit
                # (the trailing 0x00 of an ASCII char plus the first
                # terminator byte look identical to a terminator).
                raw = block[value_offset: value_offset + value_length * 2]
                text = raw.decode("utf-16-le", "replace").rstrip("\0")
                yield key, value_offset, value_length, text
            else:
                child = value_offset + (value_length if value_type != 1 else value_length * 2)
                yield from walk(_align4(child), node_end, depth + 1)

            offset = _align4(node_end)
            if offset <= 0:
                return

    yield from walk(0, len(block), 0)


def _entropy(data: bytes | bytearray) -> float:
    if not data:
        return 0.0
    counts = [0] * 256
    for byte in data:
        counts[byte] += 1
    total = len(data)
    result = 0.0
    for count in counts:
        if count:
            p = count / total
            result -= p * math.log2(p)
    return result
