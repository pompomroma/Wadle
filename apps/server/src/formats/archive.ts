import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import yazl from "yazl";

export interface ArchiveEntry {
  path: string;
  size: number;
  compressedSize: number;
  isDirectory: boolean;
  modified: number;
}

/**
 * Guard against zip-slip: an entry that escapes the extraction root.
 *
 * yauzl also validates entry names and rejects most traversal itself, so in
 * practice this is a second layer. It is kept — and tested directly — because
 * relying on a dependency's validation as the only defence is how these bugs
 * come back when the dependency changes.
 */
export function safeJoin(root: string, entryPath: string): string {
  // Zip entries are always forward-slash separated regardless of platform.
  const normalised = entryPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const target = resolve(root, normalised);
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || rel.startsWith(`..${sep}`)) {
    throw new Error(
      `Refusing to extract '${entryPath}': it escapes the destination directory.`,
    );
  }
  return target;
}

/** List an archive's contents without writing anything to disk. */
export function listZip(file: string): Promise<ArchiveEntry[]> {
  return new Promise((done, fail) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error || !zip) {
        fail(error ?? new Error("Could not open archive"));
        return;
      }
      const entries: ArchiveEntry[] = [];
      zip.on("entry", (entry: yauzl.Entry) => {
        entries.push({
          path: entry.fileName,
          size: entry.uncompressedSize,
          compressedSize: entry.compressedSize,
          isDirectory: entry.fileName.endsWith("/"),
          modified: entry.getLastModDate().getTime(),
        });
        zip.readEntry();
      });
      zip.on("end", () => done(entries));
      zip.on("error", fail);
      zip.readEntry();
    });
  });
}

/**
 * Extract a zip archive. Every entry path is validated against the destination
 * root first, so a crafted archive cannot write outside it.
 */
export function extractZip(file: string, destination: string): Promise<number> {
  return new Promise((done, fail) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true }, async (error, zip) => {
      if (error || !zip) {
        fail(error ?? new Error("Could not open archive"));
        return;
      }

      let count = 0;
      zip.on("entry", (entry: yauzl.Entry) => {
        void (async () => {
          try {
            const target = safeJoin(destination, entry.fileName);
            if (entry.fileName.endsWith("/")) {
              await mkdir(target, { recursive: true });
              zip.readEntry();
              return;
            }
            await mkdir(dirname(target), { recursive: true });
            zip.openReadStream(entry, async (streamError, stream) => {
              if (streamError || !stream) {
                fail(streamError ?? new Error("Could not read archive entry"));
                return;
              }
              try {
                await pipeline(stream, createWriteStream(target));
                count += 1;
                zip.readEntry();
              } catch (writeError) {
                fail(writeError as Error);
              }
            });
          } catch (entryError) {
            fail(entryError as Error);
          }
        })();
      });
      zip.on("end", () => done(count));
      zip.on("error", fail);
      zip.readEntry();
    });
  });
}

/** Zip a directory tree, preserving relative paths. */
export async function zipDirectory(
  source: string,
  outputFile: string,
  options: { exclude?: RegExp[] } = {},
): Promise<number> {
  const zip = new yazl.ZipFile();
  const exclude = options.exclude ?? [
    /(^|\/)node_modules(\/|$)/,
    /(^|\/)\.git(\/|$)/,
    /(^|\/)__pycache__(\/|$)/,
    /(^|\/)\.venv(\/|$)/,
    /(^|\/)target\/(debug|release)(\/|$)/,
  ];

  let added = 0;
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      const rel = relative(source, absolute).split(sep).join("/");
      if (exclude.some((pattern) => pattern.test(rel))) continue;
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        zip.addFile(absolute, rel);
        added += 1;
      }
    }
  };

  await walk(source);
  await mkdir(dirname(outputFile), { recursive: true });

  await new Promise<void>((done, fail) => {
    const output = createWriteStream(outputFile);
    output.on("close", done);
    output.on("error", fail);
    zip.outputStream.on("error", fail);
    zip.outputStream.pipe(output);
    zip.end();
  });

  return added;
}

/** Bundle explicit files (not a whole tree) into a zip. */
export async function zipFiles(
  files: Array<{ absolutePath: string; nameInArchive: string }>,
  outputFile: string,
): Promise<void> {
  const zip = new yazl.ZipFile();
  for (const file of files) zip.addFile(file.absolutePath, file.nameInArchive);
  await mkdir(dirname(outputFile), { recursive: true });
  await new Promise<void>((done, fail) => {
    const output = createWriteStream(outputFile);
    output.on("close", done);
    output.on("error", fail);
    zip.outputStream.on("error", fail);
    zip.outputStream.pipe(output);
    zip.end();
  });
}

/** Read one entry's bytes without extracting the whole archive. */
export function readZipEntry(file: string, entryPath: string): Promise<Buffer> {
  return new Promise((done, fail) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error || !zip) {
        fail(error ?? new Error("Could not open archive"));
        return;
      }
      let found = false;
      zip.on("entry", (entry: yauzl.Entry) => {
        if (entry.fileName !== entryPath) {
          zip.readEntry();
          return;
        }
        found = true;
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            fail(streamError ?? new Error("Could not read entry"));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("end", () => done(Buffer.concat(chunks)));
          stream.on("error", fail);
        });
      });
      zip.on("end", () => {
        if (!found) fail(new Error(`Archive has no entry '${entryPath}'`));
      });
      zip.on("error", fail);
      zip.readEntry();
    });
  });
}

/** Total size of a directory tree, used for artifact reporting. */
export async function directorySize(dir: string): Promise<number> {
  let total = 0;
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        await walk(absolute);
      } else if (entry.isFile()) {
        total += (await stat(absolute)).size;
      }
    }
  };
  await walk(dir);
  return total;
}

/** Copy a text file after applying a transform — used by adjustment passes. */
export async function editTextFile(
  file: string,
  transform: (contents: string) => string,
): Promise<void> {
  const original = await readFile(file, "utf8");
  await writeFile(file, transform(original), "utf8");
}
