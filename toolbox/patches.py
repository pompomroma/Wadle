"""Binary patch formats: IPS, UPS and BPS.

These are how ROM modifications are actually distributed. Wadle can both create
a patch (diff an original against a modified ROM) and apply one, so a change
made here is portable and verifiable rather than locked inside a rebuilt file.

All three formats are implemented against their published specifications, with
the checksums each defines so a bad apply is detected instead of silently
producing a corrupt ROM.
"""

from __future__ import annotations

import zlib
from typing import Any

IPS_MAGIC = b"PATCH"
IPS_EOF = b"EOF"
IPS_MAX_OFFSET = 0xFFFFFF  # 3-byte offsets cap IPS at 16 MiB
UPS_MAGIC = b"UPS1"
BPS_MAGIC = b"BPS1"


class PatchError(Exception):
    """Raised when a patch is malformed or does not match its target."""


# --------------------------------------------------------------------------
# IPS
# --------------------------------------------------------------------------


def create_ips(original: bytes, modified: bytes) -> bytes:
    """Diff two files into an IPS patch.

    IPS records are (offset, length, data) runs over the changed regions, with
    an RLE form for long identical fills. Records cannot start at offset
    0x454F46 because that collides with the "EOF" terminator, so such a record
    is nudged one byte earlier — the standard workaround.
    """
    if len(modified) > IPS_MAX_OFFSET + 1:
        raise PatchError(
            f"IPS cannot address beyond {IPS_MAX_OFFSET + 1} bytes; this target is "
            f"{len(modified)} bytes. Use UPS or BPS instead."
        )

    out = bytearray(IPS_MAGIC)
    position = 0
    limit = len(modified)
    # A record header costs 5 bytes, so bridging a gap shorter than that is
    # cheaper than closing the record and opening a new one.
    min_gap = 6

    while position < limit:
        same_here = position < len(original) and original[position] == modified[position]
        if same_here:
            position += 1
            continue

        start = position
        # `last_diff` is the exclusive end of the most recent differing byte;
        # the record always ends there, never on trailing identical bytes.
        last_diff = position + 1
        cursor = position
        while cursor < limit and (cursor - start) < 0xFFFF:
            same = cursor < len(original) and original[cursor] == modified[cursor]
            if not same:
                last_diff = cursor + 1
            elif cursor - last_diff >= min_gap:
                break
            cursor += 1

        if start == 0x454F46 and start > 0:  # collides with the "EOF" marker
            start -= 1
        chunk = modified[start:last_diff]
        if not chunk:
            position = last_diff
            continue

        # Prefer the RLE record when the chunk is one repeated byte.
        if len(chunk) > 3 and len(set(chunk)) == 1:
            out += start.to_bytes(3, "big")
            out += (0).to_bytes(2, "big")
            out += len(chunk).to_bytes(2, "big")
            out += bytes([chunk[0]])
        else:
            out += start.to_bytes(3, "big")
            out += len(chunk).to_bytes(2, "big")
            out += chunk

        position = last_diff

    out += IPS_EOF
    if len(modified) < len(original):
        out += len(modified).to_bytes(3, "big")
    return bytes(out)


def apply_ips(original: bytes, patch: bytes) -> bytes:
    if patch[:5] != IPS_MAGIC:
        raise PatchError("Not an IPS patch: missing 'PATCH' magic.")

    data = bytearray(original)
    cursor = 5

    while cursor + 3 <= len(patch):
        marker = patch[cursor:cursor + 3]
        if marker == IPS_EOF:
            cursor += 3
            # Optional 3-byte truncation length.
            if cursor + 3 <= len(patch):
                truncate_to = int.from_bytes(patch[cursor:cursor + 3], "big")
                del data[truncate_to:]
            return bytes(data)

        offset = int.from_bytes(marker, "big")
        cursor += 3
        if cursor + 2 > len(patch):
            raise PatchError("Truncated IPS record header.")
        size = int.from_bytes(patch[cursor:cursor + 2], "big")
        cursor += 2

        if size == 0:  # RLE record
            if cursor + 3 > len(patch):
                raise PatchError("Truncated IPS RLE record.")
            run_length = int.from_bytes(patch[cursor:cursor + 2], "big")
            value = patch[cursor + 2]
            cursor += 3
            payload = bytes([value]) * run_length
        else:
            if cursor + size > len(patch):
                raise PatchError("Truncated IPS data record.")
            payload = patch[cursor:cursor + size]
            cursor += size

        if offset + len(payload) > len(data):
            data.extend(b"\0" * (offset + len(payload) - len(data)))
        data[offset:offset + len(payload)] = payload

    raise PatchError("IPS patch ended without an 'EOF' marker.")


# --------------------------------------------------------------------------
# Variable-length integers, shared by UPS and BPS
# --------------------------------------------------------------------------


def _encode_vli(value: int) -> bytes:
    out = bytearray()
    while True:
        chunk = value & 0x7F
        value >>= 7
        if value == 0:
            out.append(0x80 | chunk)
            break
        out.append(chunk)
        value -= 1
    return bytes(out)


def _decode_vli(data: bytes, cursor: int) -> tuple[int, int]:
    value = 0
    shift = 1
    while True:
        if cursor >= len(data):
            raise PatchError("Truncated variable-length integer.")
        byte = data[cursor]
        cursor += 1
        value += (byte & 0x7F) * shift
        if byte & 0x80:
            return value, cursor
        shift <<= 7
        value += shift


# --------------------------------------------------------------------------
# UPS
# --------------------------------------------------------------------------


def create_ups(original: bytes, modified: bytes) -> bytes:
    """UPS encodes the XOR delta as runs terminated by a zero byte."""
    out = bytearray(UPS_MAGIC)
    out += _encode_vli(len(original))
    out += _encode_vli(len(modified))

    span = max(len(original), len(modified))
    position = 0
    last_write = 0

    while position < span:
        a = original[position] if position < len(original) else 0
        b = modified[position] if position < len(modified) else 0
        if a == b:
            position += 1
            continue

        out += _encode_vli(position - last_write)
        while position < span:
            a = original[position] if position < len(original) else 0
            b = modified[position] if position < len(modified) else 0
            delta = a ^ b
            out.append(delta)
            position += 1
            if delta == 0:
                break
        else:
            out.append(0)
        last_write = position

    # The trailing patch CRC covers everything before it — body *and* the two
    # preceding checksums — so it must be computed last.
    out += zlib.crc32(original).to_bytes(4, "little")
    out += zlib.crc32(modified).to_bytes(4, "little")
    out += zlib.crc32(bytes(out)).to_bytes(4, "little")
    return bytes(out)


def apply_ups(original: bytes, patch: bytes) -> bytes:
    if patch[:4] != UPS_MAGIC:
        raise PatchError("Not a UPS patch: missing 'UPS1' magic.")
    if len(patch) < 4 + 12:
        raise PatchError("UPS patch is too short to contain its footer.")

    expected_input_crc = int.from_bytes(patch[-12:-8], "little")
    expected_output_crc = int.from_bytes(patch[-8:-4], "little")
    expected_patch_crc = int.from_bytes(patch[-4:], "little")

    if zlib.crc32(patch[:-4]) != expected_patch_crc:
        raise PatchError("UPS patch is corrupt (patch CRC32 mismatch).")
    if zlib.crc32(original) != expected_input_crc:
        raise PatchError(
            "This UPS patch was built for a different source file "
            "(input CRC32 mismatch)."
        )

    cursor = 4
    input_size, cursor = _decode_vli(patch, cursor)
    output_size, cursor = _decode_vli(patch, cursor)
    if input_size != len(original):
        raise PatchError(
            f"UPS expects a {input_size}-byte source; got {len(original)} bytes."
        )

    data = bytearray(output_size)
    copy_len = min(len(original), output_size)
    data[:copy_len] = original[:copy_len]

    position = 0
    body_end = len(patch) - 12
    while cursor < body_end:
        skip, cursor = _decode_vli(patch, cursor)
        position += skip
        while cursor < body_end:
            delta = patch[cursor]
            cursor += 1
            if delta == 0:
                position += 1
                break
            if position < output_size:
                base = original[position] if position < len(original) else 0
                data[position] = base ^ delta
            position += 1

    if zlib.crc32(bytes(data)) != expected_output_crc:
        raise PatchError("UPS apply produced the wrong result (output CRC32 mismatch).")
    return bytes(data)


# --------------------------------------------------------------------------
# BPS
# --------------------------------------------------------------------------

_SOURCE_READ = 0
_TARGET_READ = 1
_SOURCE_COPY = 2
_TARGET_COPY = 3


def create_bps(original: bytes, modified: bytes) -> bytes:
    """Encode a valid BPS patch using SourceRead and TargetRead actions.

    A greedy encoder: stretches where source and target already agree become
    SourceRead (zero payload), everything else becomes a literal TargetRead.
    That is a correct BPS patch. It is not as compact as an encoder that also
    emits SourceCopy/TargetCopy back-references, which is a deliberate
    trade — correctness over compression.
    """
    out = bytearray(BPS_MAGIC)
    out += _encode_vli(len(original))
    out += _encode_vli(len(modified))
    out += _encode_vli(0)  # no metadata

    position = 0
    limit = len(modified)

    while position < limit:
        matches = position < len(original) and original[position] == modified[position]
        run_start = position
        while position < limit:
            same = position < len(original) and original[position] == modified[position]
            if same != matches:
                break
            position += 1
        length = position - run_start
        action = _SOURCE_READ if matches else _TARGET_READ
        out += _encode_vli(((length - 1) << 2) | action)
        if action == _TARGET_READ:
            out += modified[run_start:position]

    out += zlib.crc32(original).to_bytes(4, "little")
    out += zlib.crc32(modified).to_bytes(4, "little")
    out += zlib.crc32(bytes(out)).to_bytes(4, "little")
    return bytes(out)


def apply_bps(original: bytes, patch: bytes) -> bytes:
    if patch[:4] != BPS_MAGIC:
        raise PatchError("Not a BPS patch: missing 'BPS1' magic.")
    if len(patch) < 4 + 12:
        raise PatchError("BPS patch is too short to contain its footer.")

    expected_input_crc = int.from_bytes(patch[-12:-8], "little")
    expected_output_crc = int.from_bytes(patch[-8:-4], "little")
    expected_patch_crc = int.from_bytes(patch[-4:], "little")

    if zlib.crc32(patch[:-4]) != expected_patch_crc:
        raise PatchError("BPS patch is corrupt (patch CRC32 mismatch).")
    if zlib.crc32(original) != expected_input_crc:
        raise PatchError(
            "This BPS patch was built for a different source file "
            "(input CRC32 mismatch)."
        )

    cursor = 4
    source_size, cursor = _decode_vli(patch, cursor)
    target_size, cursor = _decode_vli(patch, cursor)
    metadata_size, cursor = _decode_vli(patch, cursor)
    cursor += metadata_size

    if source_size != len(original):
        raise PatchError(
            f"BPS expects a {source_size}-byte source; got {len(original)} bytes."
        )

    target = bytearray(target_size)
    output_offset = 0
    source_relative = 0
    target_relative = 0
    body_end = len(patch) - 12

    while cursor < body_end and output_offset < target_size:
        value, cursor = _decode_vli(patch, cursor)
        action = value & 3
        length = (value >> 2) + 1

        if action == _SOURCE_READ:
            for _ in range(length):
                target[output_offset] = original[output_offset]
                output_offset += 1
        elif action == _TARGET_READ:
            target[output_offset:output_offset + length] = patch[cursor:cursor + length]
            cursor += length
            output_offset += length
        else:
            raw, cursor = _decode_vli(patch, cursor)
            delta = (-1 if raw & 1 else 1) * (raw >> 1)
            if action == _SOURCE_COPY:
                source_relative += delta
                for _ in range(length):
                    target[output_offset] = original[source_relative]
                    source_relative += 1
                    output_offset += 1
            else:
                target_relative += delta
                for _ in range(length):
                    target[output_offset] = target[target_relative]
                    target_relative += 1
                    output_offset += 1

    if zlib.crc32(bytes(target)) != expected_output_crc:
        raise PatchError("BPS apply produced the wrong result (output CRC32 mismatch).")
    return bytes(target)


# --------------------------------------------------------------------------
# Dispatch
# --------------------------------------------------------------------------

_CREATORS = {"ips": create_ips, "ups": create_ups, "bps": create_bps}
_APPLIERS = {"ips": apply_ips, "ups": apply_ups, "bps": apply_bps}


def create(fmt: str, original: bytes, modified: bytes) -> bytes:
    creator = _CREATORS.get(fmt.lower())
    if not creator:
        raise PatchError(f"Unsupported patch format '{fmt}'. Use ips, ups or bps.")
    return creator(original, modified)


def apply(original: bytes, patch: bytes) -> bytes:
    """Detect the format from the patch's own magic bytes and apply it."""
    if patch[:5] == IPS_MAGIC:
        return apply_ips(original, patch)
    if patch[:4] == UPS_MAGIC:
        return apply_ups(original, patch)
    if patch[:4] == BPS_MAGIC:
        return apply_bps(original, patch)
    raise PatchError("Unrecognised patch format (expected IPS, UPS or BPS magic).")


def describe(patch: bytes) -> dict[str, Any]:
    if patch[:5] == IPS_MAGIC:
        return {"format": "ips", "size": len(patch), "checksums": False}
    if patch[:4] == UPS_MAGIC:
        return {"format": "ups", "size": len(patch), "checksums": True}
    if patch[:4] == BPS_MAGIC:
        return {"format": "bps", "size": len(patch), "checksums": True}
    return {"format": "unknown", "size": len(patch), "checksums": False}
