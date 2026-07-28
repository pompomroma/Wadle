#!/usr/bin/env node
/**
 * Put a model key into .env, without going near git.
 *
 * The failure this exists to prevent: editing .env.example and committing it.
 * That file is a tracked template and is never read as configuration — the app
 * loads .env only — so it publishes the credential and fixes nothing. The
 * secret scanner and the pre-commit hook both refuse it, which is correct but
 * arrives after the effort has been spent.
 *
 *   pnpm set-key nvapi-xxxxxxxx
 *   pnpm set-key --local        # point at a local model instead, no key at all
 */
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV = resolve(ROOT, ".env");
const EXAMPLE = resolve(ROOT, ".env.example");

const RESET = "\x1b[0m", BOLD = "\x1b[1m", RED = "\x1b[31m";
const GREEN = "\x1b[32m", DIM = "\x1b[2m";
const die = (msg) => {
  process.stderr.write(`\n  ${RED}${msg}${RESET}\n\n`);
  process.exit(1);
};

const args = process.argv.slice(2);
const local = args.includes("--local");
const key = args.find((a) => !a.startsWith("--"));

if (!local && !key) {
  process.stdout.write(
    `\n${BOLD}Usage${RESET}\n\n` +
      `  pnpm set-key <your-key>     write a provider key into .env\n` +
      `  pnpm set-key --local        use a local model instead (no key needed)\n\n` +
      `${DIM}Writes .env, which is gitignored. Never edit .env.example — it is a\n` +
      `tracked template and is not read as configuration.${RESET}\n\n`,
  );
  process.exit(1);
}

// --- refuse to help leak anything -------------------------------------------
// .env must be ignored by git. If someone has forced it into the index, writing
// a live key into it stages that key for commit.
try {
  const tracked = execFileSync("git", ["ls-files", "--error-unmatch", ".env"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "ignore"],
  })
    .toString()
    .trim();
  if (tracked) {
    die(
      `.env is tracked by git — refusing to write a credential into it.\n` +
        `  Untrack it first:  git rm --cached .env`,
    );
  }
} catch {
  // Not tracked (or not a git repo). Both are fine.
}

if (key && /^nvapi-(your|xxx)/i.test(key)) {
  die(`That is the placeholder from .env.example, not a key.`);
}
if (key && /\s/.test(key)) {
  die(`That key contains whitespace — check you copied it whole, with no comment.`);
}

// --- build the new .env ------------------------------------------------------
let switchedBack = "";
let contents = "";
if (existsSync(ENV)) contents = readFileSync(ENV, "utf8");
else if (existsSync(EXAMPLE)) contents = readFileSync(EXAMPLE, "utf8");

/**
 * Replace an active assignment, or append one.
 *
 * Only uncommented lines are matched. .env.example documents alternatives as
 * indented comments (`#    LLM_MODEL=qwen2.5-coder:32b`), and a pattern loose
 * enough to match those rewrites the example instead of the real setting,
 * leaving two assignments of the same name in the file.
 */
const setting = (body, name, value) => {
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^${name}=.*$`, "m");
  return pattern.test(body) ? body.replace(pattern, line) : `${body.trimEnd()}\n${line}\n`;
};

if (local) {
  contents = setting(contents, "LLM_BASE_URL", "http://localhost:11434/v1");
  contents = setting(contents, "LLM_MODEL", "qwen2.5-coder:32b");
  contents = setting(contents, "LLM_API_KEY", "ollama");
  contents = setting(contents, "NVIDIA_API_KEY", "");
} else {
  contents = setting(contents, "NVIDIA_API_KEY", key);
  // If the file is still pointed at a local model — because --local ran
  // earlier — a provider key would be set and never used. Point it back, and
  // say so, rather than leaving a key that silently has no effect.
  const current = contents.match(/^LLM_BASE_URL=(.*)$/m)?.[1]?.trim() ?? "";
  const wasLocal = /localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal/.test(current);
  if (!current || wasLocal) {
    contents = setting(contents, "LLM_BASE_URL", "https://integrate.api.nvidia.com/v1");
    contents = setting(contents, "LLM_MODEL", "nvidia/nemotron-3-ultra-550b-a55b");
    if (/^LLM_API_KEY=ollama\s*$/m.test(contents)) {
      contents = setting(contents, "LLM_API_KEY", "");
    }
    if (wasLocal) switchedBack = current;
  }
}

writeFileSync(ENV, contents, { mode: 0o600 });
try {
  chmodSync(ENV, 0o600);
} catch {
  // Best effort: some filesystems (and Windows) do not support this.
}

const shown = local
  ? "a local model at http://localhost:11434/v1"
  : `${key.slice(0, 8)}…${key.slice(-4)}`;

process.stdout.write(
  `\n  ${GREEN}✔${RESET} .env updated — ${shown}\n` +
    (switchedBack
      ? `     ${DIM}endpoint moved off ${switchedBack} back to NVIDIA, so the key is used${RESET}\n`
      : "") +
    `     ${DIM}.env is gitignored and was not staged, committed or pushed.${RESET}\n\n` +
    `  Check it works:  ${BOLD}pnpm check-key${RESET}\n\n`,
);
