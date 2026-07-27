import { open } from "node:fs/promises";
import { extname } from "node:path";

export type FormatFamily =
  | "archive"
  | "executable"
  | "rom"
  | "image"
  | "audio"
  | "video"
  | "document"
  | "data"
  | "source"
  | "text"
  | "unknown";

/** How much Wadle can actually do with a file — stated honestly. */
export type HandlingTier =
  /** Unpack, edit real contents, repack. Full round-trip. */
  | "round-trip"
  /** Parse structure, rewrite specific fields/resources, rebuild. */
  | "inspect-patch"
  /** Read-only structural report. */
  | "inspect-only";

export interface FormatInfo {
  /** Canonical short name, e.g. "zip", "pe", "gba". */
  format: string;
  family: FormatFamily;
  mime: string;
  tier: HandlingTier;
  /** Human-readable statement of what can be done, shown in the UI. */
  capability: string;
  extension: string;
}

interface Signature {
  format: string;
  family: FormatFamily;
  mime: string;
  tier: HandlingTier;
  capability: string;
  /** Byte pattern; `null` entries are wildcards. */
  magic?: Array<number | null>;
  offset?: number;
  /** Fallback when magic bytes are absent or ambiguous. */
  extensions?: string[];
}

const SIGNATURES: Signature[] = [
  {
    format: "zip",
    family: "archive",
    mime: "application/zip",
    tier: "round-trip",
    capability:
      "Unpack, edit any file inside, and repack as a valid archive.",
    magic: [0x50, 0x4b, 0x03, 0x04],
    extensions: [".zip", ".jar", ".apk", ".docx", ".xlsx", ".pptx", ".odt"],
  },
  {
    format: "gzip",
    family: "archive",
    mime: "application/gzip",
    tier: "round-trip",
    capability: "Decompress, edit contents, recompress.",
    magic: [0x1f, 0x8b],
    extensions: [".gz", ".tgz"],
  },
  {
    format: "tar",
    family: "archive",
    mime: "application/x-tar",
    tier: "round-trip",
    capability: "Extract, edit contents, re-archive.",
    magic: [0x75, 0x73, 0x74, 0x61, 0x72],
    offset: 257,
    extensions: [".tar"],
  },
  {
    format: "7z",
    family: "archive",
    mime: "application/x-7z-compressed",
    tier: "round-trip",
    capability: "Extract, edit contents, re-archive (requires 7z).",
    magic: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c],
    extensions: [".7z"],
  },
  {
    format: "pe",
    family: "executable",
    mime: "application/vnd.microsoft.portable-executable",
    tier: "inspect-patch",
    capability:
      "Read headers, sections, imports/exports, strings and resources; rewrite version info, icons and embedded resources; rebuild with a valid checksum. Machine code is not decompiled back to source, and uploaded binaries are never executed.",
    magic: [0x4d, 0x5a],
    extensions: [".exe", ".dll", ".sys", ".ocx"],
  },
  {
    format: "elf",
    family: "executable",
    mime: "application/x-elf",
    tier: "inspect-only",
    capability:
      "Report ELF headers, sections, symbols and dynamic dependencies. Not executed.",
    magic: [0x7f, 0x45, 0x4c, 0x46],
    extensions: [".elf", ".so", ".o"],
  },
  {
    format: "gba",
    family: "rom",
    mime: "application/x-gba-rom",
    tier: "inspect-patch",
    capability:
      "Read and rewrite the ROM header (title, game code, maker, version), recompute the header checksum, extract graphics and palettes, and generate or apply IPS/UPS/BPS patches — the standard way GBA ROMs are modified.",
    // Fixed 156-byte Nintendo logo starts at 0x04; first bytes are stable.
    magic: [0x24, 0xff, 0xae, 0x51, 0x69, 0x9a],
    offset: 4,
    extensions: [".gba"],
  },
  {
    format: "nes",
    family: "rom",
    mime: "application/x-nes-rom",
    tier: "inspect-patch",
    capability: "Read the iNES header, extract CHR/PRG banks, apply patches.",
    magic: [0x4e, 0x45, 0x53, 0x1a],
    extensions: [".nes"],
  },
  {
    format: "png",
    family: "image",
    mime: "image/png",
    tier: "round-trip",
    capability: "Decode, transform, re-encode; convert to other image formats.",
    magic: [0x89, 0x50, 0x4e, 0x47],
    extensions: [".png"],
  },
  {
    format: "jpeg",
    family: "image",
    mime: "image/jpeg",
    tier: "round-trip",
    capability: "Decode, transform, re-encode; convert to other image formats.",
    magic: [0xff, 0xd8, 0xff],
    extensions: [".jpg", ".jpeg"],
  },
  {
    format: "gif",
    family: "image",
    mime: "image/gif",
    tier: "round-trip",
    capability: "Decode, transform, re-encode.",
    magic: [0x47, 0x49, 0x46, 0x38],
    extensions: [".gif"],
  },
  {
    format: "pdf",
    family: "document",
    mime: "application/pdf",
    tier: "inspect-patch",
    capability: "Extract text and pages; convert to and from other documents.",
    magic: [0x25, 0x50, 0x44, 0x46],
    extensions: [".pdf"],
  },
  {
    format: "wasm",
    family: "executable",
    mime: "application/wasm",
    tier: "inspect-only",
    capability: "Report module sections, imports and exports.",
    magic: [0x00, 0x61, 0x73, 0x6d],
    extensions: [".wasm"],
  },
];

/** Extension-only classification for text formats, which have no magic bytes. */
const TEXT_FORMATS: Record<
  string,
  { format: string; family: FormatFamily; mime: string }
> = {
  ".ini": { format: "ini", family: "data", mime: "text/plain" },
  ".cfg": { format: "ini", family: "data", mime: "text/plain" },
  ".conf": { format: "ini", family: "data", mime: "text/plain" },
  ".json": { format: "json", family: "data", mime: "application/json" },
  ".yaml": { format: "yaml", family: "data", mime: "application/yaml" },
  ".yml": { format: "yaml", family: "data", mime: "application/yaml" },
  ".toml": { format: "toml", family: "data", mime: "application/toml" },
  ".xml": { format: "xml", family: "data", mime: "application/xml" },
  ".csv": { format: "csv", family: "data", mime: "text/csv" },
  ".tsv": { format: "tsv", family: "data", mime: "text/tab-separated-values" },
  ".env": { format: "dotenv", family: "data", mime: "text/plain" },
  ".md": { format: "markdown", family: "text", mime: "text/markdown" },
  ".txt": { format: "text", family: "text", mime: "text/plain" },
  ".html": { format: "html", family: "source", mime: "text/html" },
  ".css": { format: "css", family: "source", mime: "text/css" },
  ".js": { format: "javascript", family: "source", mime: "text/javascript" },
  ".mjs": { format: "javascript", family: "source", mime: "text/javascript" },
  ".ts": { format: "typescript", family: "source", mime: "text/typescript" },
  ".tsx": { format: "typescript", family: "source", mime: "text/typescript" },
  ".jsx": { format: "javascript", family: "source", mime: "text/javascript" },
  ".py": { format: "python", family: "source", mime: "text/x-python" },
  ".go": { format: "go", family: "source", mime: "text/x-go" },
  ".rs": { format: "rust", family: "source", mime: "text/x-rust" },
  ".c": { format: "c", family: "source", mime: "text/x-c" },
  ".h": { format: "c", family: "source", mime: "text/x-c" },
  ".cpp": { format: "cpp", family: "source", mime: "text/x-c++" },
  ".java": { format: "java", family: "source", mime: "text/x-java" },
  ".rb": { format: "ruby", family: "source", mime: "text/x-ruby" },
  ".php": { format: "php", family: "source", mime: "text/x-php" },
  ".sh": { format: "shell", family: "source", mime: "text/x-shellscript" },
  ".sql": { format: "sql", family: "source", mime: "text/x-sql" },
};

function matches(buffer: Buffer, signature: Signature): boolean {
  if (!signature.magic) return false;
  const offset = signature.offset ?? 0;
  if (buffer.length < offset + signature.magic.length) return false;
  return signature.magic.every((byte, index) => {
    if (byte === null) return true;
    return buffer[offset + index] === byte;
  });
}

/**
 * Identify a file by content first, extension second. Extension alone is a
 * claim, not evidence — a `.exe` that is really a zip must be handled as a zip.
 */
export async function sniffFile(path: string): Promise<FormatInfo> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await handle.read(buffer, 0, 512, 0);
    return sniffBuffer(buffer.subarray(0, bytesRead), path);
  } finally {
    await handle.close();
  }
}

export function sniffBuffer(buffer: Buffer, filename = ""): FormatInfo {
  const extension = extname(filename).toLowerCase();

  for (const signature of SIGNATURES) {
    if (!matches(buffer, signature)) continue;

    // Office/OpenDocument files are zip containers. Prefer the document
    // reading when the extension says so — the contents differ meaningfully.
    if (
      signature.format === "zip" &&
      [".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp"].includes(extension)
    ) {
      return {
        format: extension.slice(1),
        family: "document",
        mime: officeMime(extension),
        tier: "round-trip",
        capability:
          "Read and rewrite document contents, and convert to other document formats via LibreOffice.",
        extension,
      };
    }

    return {
      format: signature.format,
      family: signature.family,
      mime: signature.mime,
      tier: signature.tier,
      capability: signature.capability,
      extension,
    };
  }

  const text = TEXT_FORMATS[extension];
  if (text) {
    return {
      ...text,
      tier: "round-trip",
      capability:
        "Read and rewrite the full contents; convert to related formats.",
      extension,
    };
  }

  // Heuristic: mostly-printable bytes with no NULs is text we can still edit.
  if (looksLikeText(buffer)) {
    return {
      format: "text",
      family: "text",
      mime: "text/plain",
      tier: "round-trip",
      capability: "Read and rewrite the full contents.",
      extension,
    };
  }

  return {
    format: "binary",
    family: "unknown",
    mime: "application/octet-stream",
    tier: "inspect-only",
    capability:
      "Unrecognised binary format — Wadle reports size, entropy and a hex preview but will not claim to modify it.",
    extension,
  };
}

function officeMime(extension: string): string {
  switch (extension) {
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    default:
      return "application/vnd.oasis.opendocument.text";
  }
}

function looksLikeText(buffer: Buffer): boolean {
  if (buffer.length === 0) return true;
  let printable = 0;
  for (const byte of buffer) {
    if (byte === 0) return false;
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127)) {
      printable += 1;
    }
  }
  return printable / buffer.length > 0.85;
}
