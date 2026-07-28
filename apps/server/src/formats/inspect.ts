import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { listZip } from "./archive.js";
import { conversionTargetsFor } from "./convert.js";
import { sniffFile, type FormatInfo } from "./sniff.js";
import { callToolbox } from "./toolbox.js";

export interface InspectionReport {
  filename: string;
  size: number;
  format: FormatInfo;
  /** Format-specific structural detail, or null when none is available. */
  detail: Record<string, unknown> | null;
  /** Why detail is missing, when it is. */
  detailError?: string;
  conversionTargets: string[];
  /** A short factual statement the UI shows to set expectations. */
  summary: string;
}

/**
 * Produce everything Wadle knows about a file: what it is, what can be done
 * with it, and — for structured binaries — the real parsed structure.
 *
 * The `summary` is written to be honest about limits. A user who uploads a
 * compiled game should learn immediately that they will get patching, not
 * decompilation, rather than after a long build that cannot deliver.
 */
export async function inspectFile(path: string): Promise<InspectionReport> {
  const [info, stats] = await Promise.all([sniffFile(path), stat(path)]);

  let detail: Record<string, unknown> | null = null;
  let detailError: string | undefined;

  try {
    detail = await detailFor(path, info);
  } catch (error) {
    detailError = (error as Error).message;
  }

  return {
    filename: basename(path),
    size: stats.size,
    format: info,
    detail,
    ...(detailError ? { detailError } : {}),
    conversionTargets: conversionTargetsFor(info),
    summary: summarise(info, detail, stats.size),
  };
}

async function detailFor(
  path: string,
  info: FormatInfo,
): Promise<Record<string, unknown> | null> {
  switch (info.format) {
    case "pe": {
      const result = await callToolbox("pe.inspect", { path });
      if (!result.ok) throw new Error(result.error);
      const { ok: _ok, ...rest } = result;
      return rest as Record<string, unknown>;
    }
    case "gba": {
      const result = await callToolbox("gba.header", { path });
      if (!result.ok) throw new Error(result.error);
      const { ok: _ok, ...rest } = result;
      return rest as Record<string, unknown>;
    }
    case "png":
    case "jpeg":
    case "gif": {
      const result = await callToolbox("image.inspect", { path });
      if (!result.ok) return null;
      const { ok: _ok, ...rest } = result;
      return rest as Record<string, unknown>;
    }
    case "zip":
    case "docx":
    case "xlsx":
    case "pptx":
    case "odt": {
      const entries = await listZip(path);
      return {
        entryCount: entries.length,
        totalUncompressed: entries.reduce((sum, e) => sum + e.size, 0),
        entries: entries.slice(0, 200),
      };
    }
    case "elf": {
      return { note: "ELF structure is reported by the build loop when needed." };
    }
    default: {
      if (info.family === "data" || info.family === "source" || info.family === "text") {
        const text = await readFile(path, "utf8").catch(() => "");
        const lines = text.split("\n");
        return {
          lines: lines.length,
          characters: text.length,
          preview: lines.slice(0, 40).join("\n").slice(0, 4000),
        };
      }
      return null;
    }
  }
}

function summarise(
  info: FormatInfo,
  detail: Record<string, unknown> | null,
  size: number,
): string {
  const kb = `${(size / 1024).toFixed(1)} KB`;

  switch (info.format) {
    case "pe": {
      const machine = detail?.["machine"] ?? "unknown architecture";
      const bits = detail?.["bits"] ?? "?";
      return (
        `Windows ${bits}-bit ${machine} executable, ${kb}. ` +
        `Wadle can read its structure and rewrite version metadata, icons and embedded ` +
        `resources, then rebuild it with a valid checksum. It will not decompile the ` +
        `machine code into editable source, and it will not run the binary.`
      );
    }
    case "gba": {
      const title = detail?.["title"] ?? "untitled";
      const valid = detail?.["headerChecksumValid"] === true;
      return (
        `Game Boy Advance ROM "${title}", ${kb}${valid ? "" : " (header checksum currently invalid)"}. ` +
        `Wadle can rewrite the cartridge header, extract graphics, and produce IPS/UPS/BPS ` +
        `patches — the way ROM hacks are actually made. It cannot turn compiled ARM code back into source.`
      );
    }
    case "elf":
      return `Linux ELF binary, ${kb}. Read-only structural inspection; not executed.`;
    case "zip":
      return (
        `Zip archive, ${kb}, ${detail?.["entryCount"] ?? "?"} entries. ` +
        `Full round-trip: unpack, edit anything inside, repack.`
      );
    case "binary":
      return (
        `Unrecognised binary, ${kb}. Wadle will report size and structure but will not ` +
        `claim to modify a format it cannot identify.`
      );
    default:
      return `${info.format.toUpperCase()} (${info.family}), ${kb}. ${info.capability}`;
  }
}
