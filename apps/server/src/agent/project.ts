import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { assertInsideWorkspaceRoot } from "../sandbox/exec.js";

export interface FileOperation {
  path: string;
  action: "write" | "delete";
  contents?: string;
}

export interface ProjectCommands {
  install: string;
  build: string;
  start: string;
  test: string;
}

export interface ProjectManifest {
  kind: string;
  language: string;
  commands: ProjectCommands;
  port: number | null;
  entrypoint: string;
  summary: string;
}

const MANIFEST_FILE = ".wadle/manifest.json";

const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "__pycache__",
  ".venv",
  "venv",
  "dist",
  "build",
  "target",
  ".next",
  ".cache",
  "vendor",
]);

/**
 * Validate a model-supplied path before it is used for any filesystem call.
 *
 * The model writes these paths, so they are untrusted input: `../../etc/passwd`
 * and absolute paths must never reach `writeFile`. Resolution is checked
 * against the project root, not merely string-inspected.
 */
export function resolveProjectPath(projectDir: string, candidate: string): string {
  const cleaned = candidate.replace(/\\/g, "/").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") {
    throw new Error(`Invalid file path: '${candidate}'`);
  }
  // An absolute path is refused rather than quietly reinterpreted as relative.
  // Silently turning '/etc/passwd' into '<project>/etc/passwd' would hide a
  // request that should have been an obvious error.
  if (cleaned.startsWith("/") || /^[a-zA-Z]:[/\\]/.test(cleaned)) {
    throw new Error(
      `Refusing to write outside the project: '${candidate}' is an absolute path; file paths must be relative to the project root.`,
    );
  }
  const target = resolve(projectDir, cleaned);
  const rel = relative(resolve(projectDir), target);
  if (rel.startsWith("..") || rel.startsWith(`..${sep}`) || rel === "") {
    throw new Error(
      `Refusing to write outside the project: '${candidate}' resolves beyond the workspace.`,
    );
  }
  assertInsideWorkspaceRoot(target);
  return target;
}

/** Apply a batch of file operations, returning the paths actually touched. */
export async function applyFileOperations(
  projectDir: string,
  operations: FileOperation[],
): Promise<{ written: string[]; deleted: string[]; rejected: string[] }> {
  const written: string[] = [];
  const deleted: string[] = [];
  const rejected: string[] = [];

  for (const operation of operations) {
    let target: string;
    try {
      target = resolveProjectPath(projectDir, operation.path);
    } catch (error) {
      rejected.push(`${operation.path}: ${(error as Error).message}`);
      continue;
    }

    if (operation.action === "delete") {
      await rm(target, { force: true, recursive: true });
      deleted.push(operation.path);
      continue;
    }

    if (typeof operation.contents !== "string") {
      rejected.push(`${operation.path}: write operation had no contents`);
      continue;
    }

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, operation.contents, "utf8");
    written.push(operation.path);
  }

  return { written, deleted, rejected };
}

export interface ProjectFile {
  path: string;
  size: number;
}

/** List the project's own files, skipping dependency and build directories. */
export async function listProjectFiles(
  projectDir: string,
  limit = 400,
): Promise<ProjectFile[]> {
  const files: ProjectFile[] = [];

  const walk = async (dir: string): Promise<void> => {
    if (files.length >= limit) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= limit) return;
      if (entry.name.startsWith(".") && entry.name !== ".wadle") {
        if (entry.name !== ".env.example" && entry.isDirectory()) continue;
      }
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        await walk(absolute);
      } else if (entry.isFile()) {
        const info = await stat(absolute).catch(() => null);
        if (!info) continue;
        files.push({
          path: relative(projectDir, absolute).split(sep).join("/"),
          size: info.size,
        });
      }
    }
  };

  await walk(projectDir);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** A compact tree listing for prompts. */
export async function describeProject(projectDir: string): Promise<string> {
  const files = await listProjectFiles(projectDir);
  if (files.length === 0) return "";
  return files
    .map((file) => `  ${file.path} (${formatBytes(file.size)})`)
    .join("\n");
}

/**
 * Read the files most likely relevant to a failure, budgeted so a large project
 * cannot blow the context window. Files named in the error output come first.
 */
export async function readRelevantSources(
  projectDir: string,
  hints: string[],
  budgetChars = 60_000,
): Promise<string> {
  const files = await listProjectFiles(projectDir);
  const isSource = (path: string) =>
    /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|c|h|cpp|java|rb|php|sh|html|css|json|toml|yaml|yml|sql)$/i.test(
      path,
    );

  const scored = files
    .filter((file) => isSource(file.path))
    .map((file) => {
      let score = 0;
      for (const hint of hints) {
        if (hint && file.path.includes(hint)) score += 100;
      }
      // Manifests and entrypoints matter disproportionately.
      if (/^(package\.json|tsconfig\.json|go\.mod|Cargo\.toml|Makefile|requirements\.txt|pyproject\.toml)$/i.test(file.path)) {
        score += 50;
      }
      if (/(^|\/)(index|main|app|server)\.[a-z]+$/i.test(file.path)) score += 30;
      score -= Math.floor(file.size / 4000);
      return { file, score };
    })
    .sort((a, b) => b.score - a.score);

  const parts: string[] = [];
  let used = 0;
  for (const { file } of scored) {
    if (used >= budgetChars) break;
    const contents = await readFile(join(projectDir, file.path), "utf8").catch(
      () => null,
    );
    if (contents === null) continue;
    const slice =
      contents.length > 12_000
        ? `${contents.slice(0, 12_000)}\n…[truncated, file is ${contents.length} chars]`
        : contents;
    const block = `### ${file.path}\n\`\`\`\n${slice}\n\`\`\`\n`;
    if (used + block.length > budgetChars) break;
    parts.push(block);
    used += block.length;
  }

  return parts.join("\n");
}

/* ---------------------------- manifest ---------------------------- */

export async function readManifest(
  projectDir: string,
): Promise<ProjectManifest | null> {
  try {
    const raw = await readFile(join(projectDir, MANIFEST_FILE), "utf8");
    return JSON.parse(raw) as ProjectManifest;
  } catch {
    return null;
  }
}

export async function writeManifest(
  projectDir: string,
  manifest: ProjectManifest,
): Promise<void> {
  const target = join(projectDir, MANIFEST_FILE);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/** Merge freshly-returned commands over the stored ones, ignoring blanks. */
export function mergeCommands(
  current: ProjectCommands,
  incoming: Partial<ProjectCommands> | undefined,
): ProjectCommands {
  if (!incoming) return current;
  return {
    install: incoming.install?.trim() || current.install,
    build: incoming.build?.trim() || current.build,
    start: incoming.start?.trim() || current.start,
    test: incoming.test?.trim() || current.test,
  };
}

export const EMPTY_COMMANDS: ProjectCommands = {
  install: "",
  build: "",
  start: "",
  test: "",
};

/* ---------------------------- snapshots ---------------------------- */

/**
 * Copy the project into a revision snapshot. Dependency and build directories
 * are excluded — they are reproducible from the manifest and would otherwise
 * make every revision hundreds of megabytes.
 */
export async function snapshotProject(
  projectDir: string,
  snapshotDir: string,
): Promise<void> {
  await mkdir(snapshotDir, { recursive: true });
  await cp(projectDir, snapshotDir, {
    recursive: true,
    force: true,
    filter: (source) => {
      const name = source.split(sep).pop() ?? "";
      return !IGNORED_DIRECTORIES.has(name);
    },
  });
}

/** Restore a snapshot over the live project directory. */
export async function restoreSnapshot(
  snapshotDir: string,
  projectDir: string,
): Promise<void> {
  await rm(projectDir, { recursive: true, force: true });
  await mkdir(projectDir, { recursive: true });
  await cp(snapshotDir, projectDir, { recursive: true, force: true });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
