#!/usr/bin/env node
/**
 * Block credential-shaped strings from entering the repository.
 *
 * This exists because the NVIDIA key for this project was once pasted in
 * plaintext into a chat. Keys leak through copy-paste, not through malice, and
 * the only reliable defence is a check that runs before every commit.
 *
 *   node scripts/scan-secrets.mjs             # scan tracked files
 *   node scripts/scan-secrets.mjs --staged    # scan what is about to be committed
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const PATTERNS = [
  { name: "NVIDIA API key", regex: /\bnvapi-[A-Za-z0-9_-]{20,}/ },
  { name: "OpenAI-style key", regex: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: "Anthropic key", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "AWS access key id", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub token", regex: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { name: "Google API key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "Slack token", regex: /\bxox[abprs]-[0-9A-Za-z-]{10,}/ },
  { name: "private key block", regex: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
];

/**
 * Placeholders that are supposed to be in the repo. Kept deliberately narrow —
 * a broad allowlist defeats the point of the scanner.
 */
const ALLOWED = [
  /nvapi-your-key-here/,
  /sk-ant-[A-Za-z0-9]*your/i,
  /\bnvapi-\[A-Za-z0-9_-\]/, // the regex literals in this file
  /nvapi-should-never-be-visible/, // the sandbox-leak test fixture
];

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz",
  ".tar", ".exe", ".dll", ".so", ".gba", ".nes", ".wasm", ".woff", ".woff2",
  ".ttf", ".mp3", ".mp4", ".pyc",
]);

const staged = process.argv.includes("--staged");

function listFiles() {
  const args = staged
    ? ["diff", "--cached", "--name-only", "--diff-filter=ACM"]
    : ["ls-files"];
  return execFileSync("git", args, { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function isScannable(file) {
  const dot = file.lastIndexOf(".");
  const extension = dot === -1 ? "" : file.slice(dot).toLowerCase();
  if (BINARY_EXTENSIONS.has(extension)) return false;
  if (file.includes("node_modules/") || file.includes("pnpm-lock.yaml")) return false;
  try {
    // Skip anything large enough to be a build artifact.
    if (statSync(file).size > 2 * 1024 * 1024) return false;
  } catch {
    return false;
  }
  return true;
}

const findings = [];

for (const file of listFiles()) {
  if (!isScannable(file)) continue;

  let contents;
  try {
    contents = readFileSync(file, "utf8");
  } catch {
    continue;
  }

  contents.split("\n").forEach((line, index) => {
    if (ALLOWED.some((pattern) => pattern.test(line))) return;
    for (const { name, regex } of PATTERNS) {
      const match = line.match(regex);
      if (!match) continue;
      findings.push({
        file,
        line: index + 1,
        name,
        // Never echo the full secret — enough to locate it, not to use it.
        excerpt: `${match[0].slice(0, 10)}…${match[0].slice(-4)}`,
      });
    }
  });
}

if (findings.length === 0) {
  process.stdout.write(
    `No credential-shaped strings found in ${staged ? "staged changes" : "tracked files"}.\n`,
  );
  process.exit(0);
}

process.stderr.write("\nRefusing to proceed — credential-shaped strings found:\n\n");
for (const finding of findings) {
  process.stderr.write(`  ${finding.file}:${finding.line}  ${finding.name}  ${finding.excerpt}\n`);
}
process.stderr.write(
  "\nMove the value into .env (gitignored) and reference it via process.env.\n" +
    "If the key was ever committed or pasted anywhere, rotate it — removing the\n" +
    "line does not un-leak it.\n\n",
);
process.exit(1);
