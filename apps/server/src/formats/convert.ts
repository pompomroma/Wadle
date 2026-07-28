import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { run } from "../sandbox/exec.js";
import { convertData, isDataFormat, type DataFormat } from "./data.js";
import { extractZip, zipDirectory } from "./archive.js";
import { sniffFile, type FormatInfo } from "./sniff.js";
import { callToolbox } from "./toolbox.js";

/**
 * How a requested conversion will actually be performed.
 *
 * Three outcomes, and the distinction is the whole point:
 *
 *  • `mechanical` — a real, deterministic transformation exists (JSON→YAML,
 *    DOCX→PDF, PNG→JPEG, extract-and-repack). Runs immediately.
 *
 *  • `generative` — no mechanical mapping exists, but the target is something
 *    that can be *built*. "Turn this .ini into an .exe" has no byte-level
 *    meaning; what it can honestly mean is "write me a real program that reads
 *    this config and compile it". The agent generates that program, builds it,
 *    and runs it before delivery.
 *
 *  • `refuse` — neither applies. Wadle says so instead of renaming the file
 *    and calling it converted.
 */
export type ConversionRoute =
  | {
      kind: "mechanical";
      via: string;
      description: string;
      lossy: boolean;
    }
  | {
      kind: "generative";
      description: string;
      /** Guidance handed to the agent describing what to build. */
      brief: string;
    }
  | { kind: "refuse"; reason: string };

const DOCUMENT_TARGETS = new Set([
  "pdf", "docx", "odt", "rtf", "txt", "html", "xlsx", "ods", "csv", "pptx", "odp",
]);
const IMAGE_TARGETS = new Set(["png", "jpg", "jpeg", "webp", "bmp", "gif", "tiff"]);
const ARCHIVE_TARGETS = new Set(["zip", "tar", "gz", "tgz"]);
const EXECUTABLE_TARGETS = new Set(["exe", "elf", "gba", "bin", "app", "wasm"]);
const CODE_TARGETS = new Set([
  "py", "js", "ts", "go", "rs", "c", "cpp", "java", "rb", "php", "sh", "html",
]);

/** Decide how a conversion should be performed, without performing it. */
export function planConversion(
  source: FormatInfo,
  target: string,
): ConversionRoute {
  const to = target.toLowerCase().replace(/^\./, "");
  const from = source.format;

  if (from === to) {
    return {
      kind: "refuse",
      reason: `The file is already ${to.toUpperCase()}; there is nothing to convert.`,
    };
  }

  // 1. Structured data ↔ structured data.
  if (isDataFormat(from) && isDataFormat(to)) {
    return {
      kind: "mechanical",
      via: "data",
      description: `Parse the ${from.toUpperCase()} and re-serialise it as ${to.toUpperCase()}, preserving every key and value.`,
      lossy: to === "ini" || to === "dotenv" || to === "csv" || to === "tsv",
    };
  }

  // 2. Documents, via LibreOffice.
  if (
    (source.family === "document" || from === "text" || from === "markdown") &&
    DOCUMENT_TARGETS.has(to)
  ) {
    return {
      kind: "mechanical",
      via: "libreoffice",
      description: `Convert to ${to.toUpperCase()} with LibreOffice in headless mode.`,
      lossy: true,
    };
  }

  // 3. Images.
  if (source.family === "image" && IMAGE_TARGETS.has(to)) {
    return {
      kind: "mechanical",
      via: "image",
      description: `Decode the image and re-encode it as ${to.toUpperCase()}.`,
      lossy: to === "jpg" || to === "jpeg",
    };
  }

  // 4. Archives — including "package this into a zip", which works for
  //    literally any input.
  if (ARCHIVE_TARGETS.has(to)) {
    return {
      kind: "mechanical",
      via: "archive",
      description:
        source.family === "archive"
          ? `Extract the archive and repack it as ${to.toUpperCase()}.`
          : `Package the file into a ${to.toUpperCase()} archive.`,
      lossy: false,
    };
  }
  if (source.family === "archive" && !ARCHIVE_TARGETS.has(to)) {
    return {
      kind: "generative",
      description: `Unpack the archive and build a ${to.toUpperCase()} from its contents.`,
      brief:
        `The input is an archive. Extract it, read what is inside, and produce a ` +
        `working ${to.toUpperCase()} target from that content.`,
    };
  }

  // 5. Anything → executable or source. No mechanical mapping exists, but a
  //    real program that consumes the input can be written and compiled.
  if (EXECUTABLE_TARGETS.has(to) || CODE_TARGETS.has(to)) {
    return {
      kind: "generative",
      description:
        `There is no byte-level conversion from ${from.toUpperCase()} to ${to.toUpperCase()} — ` +
        `a ${from.toUpperCase()} file has no program semantics. Wadle will instead write a real ` +
        `program that reads and acts on this file, then build and run it to prove it works.`,
      brief:
        `The user supplied a ${from.toUpperCase()} file and asked for a ${to.toUpperCase()}. ` +
        `Write a complete, working program that embeds or reads the supplied file, does something ` +
        `genuinely useful with its contents (parse it, validate it, apply it, present it), and ` +
        `report results clearly on stdout or in a window. The program must run and produce real ` +
        `output — a stub that exits immediately is not acceptable.`,
    };
  }

  // 6. Binary → binary across unrelated formats.
  if (source.family === "executable" || source.family === "rom") {
    return {
      kind: "refuse",
      reason:
        `Wadle will not claim to convert a compiled ${from.toUpperCase()} binary into ${to.toUpperCase()}. ` +
        `Machine code cannot be mechanically transformed into an unrelated format, and it cannot be ` +
        `decompiled back into editable source. What is available for this file: structural inspection, ` +
        `resource and metadata patching, and IPS/UPS/BPS patch generation.`,
    };
  }

  return {
    kind: "refuse",
    reason:
      `No conversion path from ${from.toUpperCase()} to ${to.toUpperCase()} exists. ` +
      `Rather than rename the file and call it converted, Wadle is telling you it cannot do this.`,
  };
}

export interface ConversionOutcome {
  outputPath: string;
  route: ConversionRoute;
  notes: string[];
}

/**
 * Execute a mechanical conversion. Generative routes are handled by the agent,
 * which needs the model and the build loop; calling this with one is a bug.
 */
export async function runMechanicalConversion(
  inputPath: string,
  target: string,
  outputDir: string,
): Promise<ConversionOutcome> {
  const info = await sniffFile(inputPath);
  const route = planConversion(info, target);

  if (route.kind !== "mechanical") {
    throw new Error(
      route.kind === "refuse"
        ? route.reason
        : "This conversion needs the generative path, not the mechanical one.",
    );
  }

  const to = target.toLowerCase().replace(/^\./, "");
  const stem = basename(inputPath, extname(inputPath));
  const outputPath = resolve(outputDir, `${stem}.${to}`);
  await mkdir(outputDir, { recursive: true });
  const notes: string[] = [];

  switch (route.via) {
    case "data": {
      const text = await readFile(inputPath, "utf8");
      const converted = convertData(
        text,
        info.format as DataFormat,
        to as DataFormat,
      );
      await writeFile(outputPath, converted, "utf8");
      if (route.lossy) {
        notes.push(
          `${to.toUpperCase()} is a flatter format than ${info.format.toUpperCase()}; ` +
            `nested structures it cannot express would have raised an error rather than being dropped.`,
        );
      }
      break;
    }

    case "libreoffice": {
      const result = await run({
        cwd: outputDir,
        command: "soffice",
        args: [
          "--headless",
          "--norestore",
          "--convert-to",
          to,
          "--outdir",
          outputDir,
          inputPath,
        ],
        timeoutMs: 120_000,
        allowNetwork: false,
      });
      if (result.notFound) {
        throw new Error(
          "Document conversion needs LibreOffice (`soffice`), which is not installed on this host. " +
            "Run Wadle via docker compose, where it is included.",
        );
      }
      if (result.code !== 0) {
        throw new Error(
          `LibreOffice could not convert this file: ${result.stderr.slice(0, 400)}`,
        );
      }
      notes.push("Converted with LibreOffice; complex layouts may reflow.");
      break;
    }

    case "image": {
      const result = await callToolbox("image.convert", {
        src: inputPath,
        dst: outputPath,
      });
      if (!result.ok) throw new Error(result.error);
      break;
    }

    case "archive": {
      await convertArchive(inputPath, info, to, outputPath, notes);
      break;
    }

    default:
      throw new Error(`Unknown mechanical conversion route '${route.via}'.`);
  }

  return { outputPath, route, notes };
}

async function convertArchive(
  inputPath: string,
  info: FormatInfo,
  to: string,
  outputPath: string,
  notes: string[],
): Promise<void> {
  const staging = await mkdtemp(join(tmpdir(), "wadle-convert-"));
  try {
    if (info.family === "archive") {
      if (info.format === "zip") {
        await extractZip(inputPath, staging);
      } else {
        const result = await run({
          cwd: staging,
          command: "tar",
          args: ["-xf", inputPath, "-C", staging],
          allowNetwork: false,
        });
        if (result.code !== 0) {
          throw new Error(`Could not extract archive: ${result.stderr.slice(0, 300)}`);
        }
      }
      notes.push("Archive contents were extracted and repacked, not merely renamed.");
    } else {
      await copyFile(inputPath, join(staging, basename(inputPath)));
    }

    if (to === "zip") {
      await zipDirectory(staging, outputPath);
      return;
    }

    const flags = to === "tar" ? "-cf" : "-czf";
    const result = await run({
      cwd: staging,
      command: "tar",
      args: [flags, outputPath, "."],
      allowNetwork: false,
    });
    if (result.code !== 0) {
      throw new Error(`Could not create archive: ${result.stderr.slice(0, 300)}`);
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Human-readable summary of what Wadle can turn a given file into. */
export function conversionTargetsFor(info: FormatInfo): string[] {
  const targets = new Set<string>();
  if (isDataFormat(info.format)) {
    for (const format of ["json", "yaml", "toml", "ini", "xml", "csv"]) {
      if (format !== info.format) targets.add(format);
    }
  }
  if (info.family === "document" || info.family === "text") {
    for (const format of DOCUMENT_TARGETS) targets.add(format);
  }
  if (info.family === "image") {
    for (const format of IMAGE_TARGETS) targets.add(format);
  }
  targets.add("zip");
  for (const format of ["exe", "py", "js", "html"]) targets.add(format);
  targets.delete(info.format);
  return [...targets].sort();
}

export { dirname };
