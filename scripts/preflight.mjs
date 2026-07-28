#!/usr/bin/env node
/**
 * Check prerequisites before anything slow or confusing happens.
 *
 * Every failure here is one that would otherwise surface later as a stack
 * trace with no obvious cause — a Node version too old for the syntax used, a
 * missing .env, a port already taken. Each check says what to run to fix it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const warnings = [];

const ok = (message) => process.stdout.write(`  \x1b[32m✔\x1b[0m ${message}\n`);
const bad = (message, fix) => {
  process.stdout.write(`  \x1b[31m✘\x1b[0m ${message}\n`);
  problems.push({ message, fix });
};
const warn = (message, fix) => {
  process.stdout.write(`  \x1b[33m~\x1b[0m ${message}\n`);
  warnings.push({ message, fix });
};

process.stdout.write("\n\x1b[1mWadle preflight\x1b[0m\n\n");

// --- Node ------------------------------------------------------------------
const major = Number(process.versions.node.split(".")[0]);
if (major >= 22) {
  ok(`Node ${process.versions.node}`);
} else {
  bad(
    `Node ${process.versions.node} is too old — Wadle needs 22 or newer`,
    "Install Node 22+: https://nodejs.org  (or `nvm install 22 && nvm use 22`)",
  );
}

// --- pnpm ------------------------------------------------------------------
try {
  const version = execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim();
  const pnpmMajor = Number(version.split(".")[0]);
  if (pnpmMajor >= 9) ok(`pnpm ${version}`);
  else
    bad(
      `pnpm ${version} is too old — Wadle needs 9 or newer`,
      "corepack enable && corepack prepare pnpm@10 --activate",
    );
} catch {
  bad("pnpm is not installed", "corepack enable && corepack prepare pnpm@10 --activate");
}

// --- dependencies ----------------------------------------------------------
if (existsSync(resolve(ROOT, "node_modules"))) {
  ok("dependencies installed");
} else {
  bad("dependencies are not installed", "pnpm install");
}

// --- Python (binary toolbox) ----------------------------------------------
try {
  const version = execFileSync("python3", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  ok(version.replace("Python", "Python").concat("  (binary inspection)"));
} catch {
  warn(
    "python3 not found — .exe/.gba inspection and patching will be unavailable",
    "Install Python 3.11+, or run via `docker compose up`",
  );
}

// --- configuration ---------------------------------------------------------
const envFile = resolve(ROOT, ".env");
if (!existsSync(envFile)) {
  bad(".env is missing", "cp .env.example .env   # then add your model key");
} else {
  const contents = readFileSync(envFile, "utf8");
  const key = contents.match(/^NVIDIA_API_KEY=(.*)$/m)?.[1]?.trim() ?? "";
  const baseUrl = contents.match(/^LLM_BASE_URL=(.*)$/m)?.[1]?.trim() ?? "";
  const local = /localhost|127\.0\.0\.1|host\.docker\.internal/.test(baseUrl);

  if (local) {
    ok(`.env points at a local model (${baseUrl})`);
  } else if (!key || key === "nvapi-your-key-here") {
    bad(
      ".env has no model key — builds will fail at the first model call",
      "Put your key in NVIDIA_API_KEY in .env (get one at https://build.nvidia.com),\n" +
        "     or set LLM_BASE_URL to a local model such as http://localhost:11434/v1",
    );
  } else if (!key.startsWith("nvapi-")) {
    warn(
      "NVIDIA_API_KEY does not look like an NVIDIA key (expected an nvapi- prefix)",
      "Double-check the value, or set LLM_BASE_URL if you meant a different provider",
    );
  } else {
    ok(".env has a model key");
  }
}

// --- port ------------------------------------------------------------------
const port = Number(process.env.PORT ?? 5174);
const portFree = await new Promise((done) => {
  const socket = createConnection({ port, host: "127.0.0.1" });
  socket.setTimeout(800);
  socket.once("connect", () => {
    socket.destroy();
    done(false);
  });
  socket.once("error", () => {
    socket.destroy();
    done(true);
  });
  socket.once("timeout", () => {
    socket.destroy();
    done(true);
  });
});
if (portFree) ok(`port ${port} is free`);
else
  bad(
    `port ${port} is already in use`,
    `Stop whatever is using it, or start Wadle on another port: PORT=5180 pnpm start`,
  );

// --- optional: tunnel ------------------------------------------------------
const wantsTunnel = /^(cloudflare|cloudflared|1|true)$/i.test(
  process.env.WADLE_TUNNEL ?? "",
);
if (wantsTunnel) {
  try {
    execFileSync("cloudflared", ["--version"], { stdio: "ignore" });
    ok("cloudflared found — a public URL will be published at startup");
  } catch {
    warn(
      "WADLE_TUNNEL is set but cloudflared is not installed — no public URL will be created",
      "Install it: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n" +
        "     macOS: brew install cloudflared    Debian/Ubuntu: see the link above",
    );
  }
}

// --- report ----------------------------------------------------------------
process.stdout.write("\n");

if (warnings.length > 0) {
  process.stdout.write("\x1b[1mWarnings\x1b[0m — Wadle will run, with less capability:\n\n");
  for (const { message, fix } of warnings) {
    process.stdout.write(`  ${message}\n     ${fix}\n\n`);
  }
}

if (problems.length === 0) {
  process.stdout.write("\x1b[32mReady.\x1b[0m Start it with: pnpm start\n\n");
  process.exit(0);
}

process.stdout.write("\x1b[1;31mNot ready yet.\x1b[0m Fix these first:\n\n");
for (const { message, fix } of problems) {
  process.stdout.write(`  \x1b[31m${message}\x1b[0m\n     ${fix}\n\n`);
}
process.exit(1);
