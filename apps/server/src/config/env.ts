import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Minimal .env loader. Deliberately dependency-free and non-destructive: a
 * variable already present in the real environment always wins, so container
 * and CI configuration override the file.
 */
/**
 * Turn the right-hand side of a `KEY=value` line into the value.
 *
 * Exported because getting this wrong is invisible and expensive: a credential
 * carrying a stray quote or a trailing comment is sent verbatim, and the
 * provider answers 403 — indistinguishable from a revoked key.
 */
export function parseEnvValue(raw: string): string {
  const value = raw.trim();
  const quoted =
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")));
  if (quoted) return value.slice(1, -1);
  // An unquoted trailing comment is not part of the value. A '#' with no
  // whitespace before it is kept, since it can occur inside a secret.
  return value.replace(/\s+#.*$/, "").trim();
}

function loadDotEnv(file: string): void {
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key in process.env) continue;
    process.env[key] = parseEnvValue(line.slice(eq + 1));
  }
}

const ROOT = resolve(import.meta.dirname, "../../../..");
loadDotEnv(resolve(ROOT, ".env"));

const num = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const bool = (key: string, fallback: boolean): boolean => {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
};

const dataDir = resolve(ROOT, process.env["DATA_DIR"] ?? "./data");

export const env = {
  root: ROOT,
  dataDir,
  workspacesDir: resolve(dataDir, "workspaces"),
  artifactsDir: resolve(dataDir, "artifacts"),
  databaseFile: resolve(dataDir, "wadle.db"),

  host: process.env["HOST"] ?? "127.0.0.1",
  port: num("PORT", 5174),

  previewPortMin: num("PREVIEW_PORT_MIN", 5200),
  previewPortMax: num("PREVIEW_PORT_MAX", 5299),

  llm: {
    baseUrl: (
      process.env["LLM_BASE_URL"] ?? "https://integrate.api.nvidia.com/v1"
    ).replace(/\/+$/, ""),
    model: process.env["LLM_MODEL"] ?? "nvidia/nemotron-3-ultra-550b-a55b",
    apiKey: process.env["LLM_API_KEY"] ?? process.env["NVIDIA_API_KEY"] ?? "",
  },

  agent: {
    maxIterations: num("AGENT_MAX_ITERATIONS", 200),
    wallClockMs: num("AGENT_WALL_CLOCK_MS", 7_200_000),
    tokenCeiling: num("AGENT_TOKEN_CEILING", 20_000_000),
  },

  sandbox: {
    timeoutMs: num("SANDBOX_TIMEOUT_MS", 180_000),
    maxMemoryMb: num("SANDBOX_MAX_MEMORY_MB", 2048),
    maxProcesses: num("SANDBOX_MAX_PROCESSES", 256),
    allowInstallNetwork: bool("SANDBOX_ALLOW_INSTALL_NETWORK", true),
  },
} as const;

/** True when a usable model credential is configured. */
export function hasModelCredentials(): boolean {
  return env.llm.apiKey.length > 0;
}
