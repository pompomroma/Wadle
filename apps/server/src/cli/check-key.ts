/**
 * Diagnose the model backend credential.
 *
 * "HTTP 403 Authorization failed" has several distinct causes and the build
 * loop cannot tell them apart from inside a request: the key may be absent,
 * malformed, revoked, or perfectly valid but without access to the model being
 * asked for. Each needs a different fix, so this makes one cheap call and says
 * which one it is.
 *
 *   pnpm check-key
 */
import { env } from "../config/env.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";

const out = (line = "") => process.stdout.write(`${line}\n`);
const good = (m: string) => out(`  ${GREEN}✔${RESET} ${m}`);
const bad = (m: string) => out(`  ${RED}✘${RESET} ${m}`);
const warn = (m: string) => out(`  ${YELLOW}~${RESET} ${m}`);
const fix = (m: string) => out(`      ${DIM}${m}${RESET}`);

/** Show enough of a key to compare against the provider's dashboard, no more. */
function redact(key: string): string {
  if (key.length <= 12) return `${key.slice(0, 3)}…`;
  return `${key.slice(0, 8)}…${key.slice(-4)} (${key.length} chars)`;
}

/**
 * Problems visible without a network call. Each of these produces a provider
 * rejection that looks exactly like a revoked key.
 */
function inspectShape(key: string): string[] {
  const problems: string[] = [];
  if (/\s/.test(key)) {
    problems.push(
      "contains whitespace — a trailing comment or a line break in .env would do this",
    );
  }
  if (/^["']|["']$/.test(key)) {
    problems.push("starts or ends with a quote — the quotes are part of the value");
  }
  if (key !== key.trim()) problems.push("has leading or trailing spaces");
  if (/^(nvapi-)?(your|xxx|placeholder|changeme)/i.test(key)) {
    problems.push("looks like the placeholder from .env.example, not a real key");
  }
  return problems;
}

async function main(): Promise<number> {
  const { baseUrl, model, apiKey } = env.llm;
  const isNvidia = /nvidia\.com/i.test(baseUrl);
  const isLocal = /localhost|127\.0\.0\.1|host\.docker\.internal|0\.0\.0\.0/.test(baseUrl);

  out();
  out(`${BOLD}Wadle credential check${RESET}`);
  out();
  out(`  Endpoint   ${baseUrl}`);
  out(`  Model      ${model}`);
  out();

  // --- 1. is there a credential at all -------------------------------------
  if (!apiKey) {
    if (isLocal) {
      good("no key set, and the endpoint is local — most local servers need none");
    } else {
      bad("no credential set");
      fix("Put your key in NVIDIA_API_KEY in .env, or export it:");
      fix("  export NVIDIA_API_KEY=nvapi-…");
      fix("Get one at https://build.nvidia.com");
      out();
      return 1;
    }
  } else {
    const problems = inspectShape(apiKey);
    if (problems.length > 0) {
      bad(`the credential is malformed: ${problems.join("; ")}`);
      fix(`Value read: ${redact(apiKey)}`);
      fix("Fix the line in .env — no quotes, no trailing comment:");
      fix("  NVIDIA_API_KEY=nvapi-xxxxxxxx");
      out();
      return 1;
    }
    good(`credential present — ${redact(apiKey)}`);
    if (isNvidia && !apiKey.startsWith("nvapi-")) {
      warn("NVIDIA keys normally begin with 'nvapi-'; this one does not");
      fix("If you meant a different provider, set LLM_BASE_URL to match.");
    }
  }

  // --- 2. does the provider accept it --------------------------------------
  const url = `${baseUrl}/models`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    bad(`could not reach ${url}`);
    fix(reason);
    fix(
      isLocal
        ? "Is the local model server running? e.g. `ollama serve`"
        : "Check your network, proxy, or firewall — this is not a credential problem.",
    );
    out();
    return 1;
  }

  const body = await response.text();

  if (response.status === 401 || response.status === 403) {
    bad(`the provider rejected the credential (HTTP ${response.status})`);
    out();
    out(`  ${DIM}${body.slice(0, 300).trim()}${RESET}`);
    out();
    out(`  ${BOLD}This key is not valid for this endpoint.${RESET} Most likely:`);
    out();
    out("    1. It was revoked. Providers scan public sources and disable keys");
    out("       that appear in them — a key pasted into a chat, an issue or a");
    out("       commit is treated as compromised and switched off.");
    out("    2. It was copied incompletely, or belongs to a different account.");
    out("    3. The account has no entitlement to this endpoint.");
    out();
    fix("Issue a new key at https://build.nvidia.com and replace NVIDIA_API_KEY in .env.");
    fix("Deleting a leaked key from a file does not un-leak it — it must be replaced.");
    out();
    out(`  ${BOLD}A path that needs no provider key at all:${RESET}`);
    fix("ollama serve && ollama pull qwen2.5-coder:32b");
    fix("then in .env:");
    fix("  LLM_BASE_URL=http://localhost:11434/v1");
    fix("  LLM_MODEL=qwen2.5-coder:32b");
    out();
    return 1;
  }

  if (!response.ok) {
    bad(`the provider answered HTTP ${response.status}`);
    fix(body.slice(0, 300).trim());
    out();
    return 1;
  }

  good(`the provider accepted the credential (HTTP ${response.status})`);

  // --- 3. is the configured model actually available -----------------------
  let ids: string[] = [];
  try {
    const parsed: unknown = JSON.parse(body);
    const data = (parsed as { data?: unknown }).data;
    if (Array.isArray(data)) {
      ids = data
        .map((entry) => (entry as { id?: unknown }).id)
        .filter((id): id is string => typeof id === "string");
    }
  } catch {
    warn("the model list could not be parsed, so the model name was not checked");
    out();
    return 0;
  }

  if (ids.length === 0) {
    warn("the endpoint returned no model list, so the model name was not checked");
    out();
    return 0;
  }

  if (ids.includes(model)) {
    good(`'${model}' is available on this endpoint`);
    out();
    out(`  ${GREEN}${BOLD}Ready.${RESET} The credential works and the model is reachable.`);
    out();
    return 0;
  }

  bad(`'${model}' is NOT offered by this endpoint`);
  out();
  const needle = model.split("/").pop()?.split("-")[0]?.toLowerCase() ?? "";
  const near = ids.filter((id) => needle && id.toLowerCase().includes(needle));
  const shown = (near.length > 0 ? near : ids).slice(0, 12);
  out(`  ${near.length > 0 ? "Similar models available:" : "Available models include:"}`);
  for (const id of shown) out(`      ${id}`);
  if (ids.length > shown.length) out(`      ${DIM}…and ${ids.length - shown.length} more${RESET}`);
  out();
  fix("Set LLM_MODEL in .env to one of the ids above.");
  out();
  out(
    `  ${DIM}Note: a valid key with no access to a model can also surface as 403` +
      ` on a request,\n  which is why this check separates the two.${RESET}`,
  );
  out();
  return 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`check-key failed: ${String(error)}\n`);
    process.exit(1);
  },
);
