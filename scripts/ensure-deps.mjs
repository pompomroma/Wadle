#!/usr/bin/env node
/**
 * Make sure dependencies are installed before anything tries to use them.
 *
 * Without this, `pnpm build` on a fresh clone fails with:
 *
 *     sh: 1: tsc: not found
 *     spawn ENOENT
 *
 * which says nothing about the actual problem. The tools are not missing from
 * the machine, they are missing from node_modules, because nothing has been
 * installed yet. This runs first and either fixes that or says plainly what to
 * run — the same principle as the preflight, applied one step earlier.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every workspace package that must have its dependencies linked. */
function workspacePaths() {
  const appsDir = join(ROOT, "apps");
  if (!existsSync(appsDir)) return [];
  return readdirSync(appsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(appsDir, entry.name))
    .filter((dir) => existsSync(join(dir, "package.json")));
}

const missing = [ROOT, ...workspacePaths()].filter(
  (dir) => !existsSync(join(dir, "node_modules")),
);

if (missing.length === 0) process.exit(0);

const relative = (dir) => (dir === ROOT ? "." : dir.slice(ROOT.length + 1));
const where = missing.map(relative).join(", ");

// CI should fail rather than quietly install something the lockfile did not
// pin, so the automatic path is for interactive use only.
const automatic =
  !process.env["CI"] &&
  !process.env["WADLE_NO_AUTO_INSTALL"] &&
  process.env["npm_config_frozen_lockfile"] !== "true";

if (!automatic) {
  process.stderr.write(
    `\n\x1b[1;31mDependencies are not installed\x1b[0m (missing node_modules in: ${where})\n\n` +
      `  Run this first:\n\n      pnpm install\n\n` +
      `  Or do both at once:\n\n      pnpm setup\n\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `\n\x1b[1mDependencies are not installed yet\x1b[0m (missing node_modules in: ${where}).\n` +
    `Installing them now — this happens once.\n\n`,
);

const install = spawnSync("pnpm", ["install"], { cwd: ROOT, stdio: "inherit" });

if (install.error?.code === "ENOENT") {
  process.stderr.write(
    `\n\x1b[1;31mpnpm is not installed\x1b[0m — it is what runs this workspace.\n\n` +
      `      corepack enable && corepack prepare pnpm@10 --activate\n\n`,
  );
  process.exit(1);
}

if (install.status !== 0) {
  process.stderr.write(
    `\n\x1b[1;31m'pnpm install' failed\x1b[0m (exit ${install.status}).\n` +
      `The output above says why; nothing further was attempted.\n\n`,
  );
  process.exit(install.status ?? 1);
}

const stillMissing = missing.filter((dir) => !existsSync(join(dir, "node_modules")));
if (stillMissing.length > 0) {
  process.stderr.write(
    `\n\x1b[1;31mInstall reported success but node_modules is still missing\x1b[0m ` +
      `in: ${stillMissing.map(relative).join(", ")}\n\n` +
      `  Check that pnpm-workspace.yaml lists these packages, then retry:\n\n` +
      `      pnpm install\n\n`,
  );
  process.exit(1);
}

process.stdout.write("\n\x1b[32mDependencies installed.\x1b[0m Continuing.\n\n");
