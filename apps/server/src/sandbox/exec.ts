import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { env } from "../config/env.js";

export interface RunOptions {
  /** Working directory. Must be inside the workspace root. */
  cwd: string;
  /** Command and arguments. Not passed through a shell unless `shell` is set. */
  command: string;
  args?: string[];
  /** Run via `bash -lc`. Needed for pipelines and shell builtins. */
  shell?: boolean;
  timeoutMs?: number;
  maxMemoryMb?: number;
  /** Extra environment on top of the minimal base. */
  env?: Record<string, string>;
  /** Data written to stdin, then closed. */
  stdin?: string;
  /**
   * Whether this command is permitted outbound network access. Only dependency
   * installs should set this; generated product code runs without it.
   */
  allowNetwork?: boolean;
  signal?: AbortSignal;
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  /** True when the command could not be found at all. */
  notFound: boolean;
}

const MAX_CAPTURE = 256 * 1024; // 256 KiB per stream, then truncate.

/** Cached probe: can we drop network access via an unprivileged user namespace? */
let networkIsolation: "unshare" | "none" | null = null;

export async function detectNetworkIsolation(): Promise<"unshare" | "none"> {
  if (networkIsolation) return networkIsolation;
  const probe = await new Promise<boolean>((done) => {
    const child = spawn("unshare", ["-rn", "true"], { stdio: "ignore" });
    child.on("error", () => done(false));
    child.on("exit", (code) => done(code === 0));
  });
  networkIsolation = probe ? "unshare" : "none";
  return networkIsolation;
}

/**
 * Run a command under resource limits inside a workspace.
 *
 * Layers, outermost first:
 *   1. The container, when Wadle runs via docker compose — the real boundary.
 *   2. Path confinement: cwd must resolve inside the workspace root.
 *   3. A minimal environment — the host's variables (including API keys) are
 *      never inherited by generated code.
 *   4. `ulimit` caps on address space, file size, and process count.
 *   5. Optional network namespace isolation, when the kernel allows it
 *      unprivileged.
 *   6. Wall-clock timeout with process-group kill, so orphans cannot survive.
 */
export async function run(options: RunOptions): Promise<RunResult> {
  const cwd = resolve(options.cwd);
  assertInsideWorkspaceRoot(cwd);
  if (!existsSync(cwd)) {
    throw new Error(`Sandbox working directory does not exist: ${cwd}`);
  }

  const timeoutMs = options.timeoutMs ?? env.sandbox.timeoutMs;
  const memoryMb = options.maxMemoryMb ?? env.sandbox.maxMemoryMb;
  const allowNetwork = options.allowNetwork ?? false;

  const inner = options.shell
    ? options.command
    : [options.command, ...(options.args ?? [])].map(shellQuote).join(" ");

  // ulimit -v is address space in KiB; -u caps processes; -f caps file size.
  const limited = [
    `ulimit -v ${memoryMb * 1024} 2>/dev/null || true`,
    `ulimit -u ${env.sandbox.maxProcesses} 2>/dev/null || true`,
    `ulimit -f ${2 * 1024 * 1024} 2>/dev/null || true`,
    inner,
  ].join("\n");

  let file = "bash";
  let argv = ["-c", limited];

  if (!allowNetwork && (await detectNetworkIsolation()) === "unshare") {
    file = "unshare";
    argv = ["-rn", "bash", "-c", limited];
  }

  const started = Date.now();
  const child = spawn(file, argv, {
    cwd,
    env: baseEnvironment(options.env),
    detached: true, // own process group, so we can kill the whole tree
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let notFound = false;

  const capture = (
    stream: "stdout" | "stderr",
    chunk: Buffer,
    sink: (value: string) => void,
  ) => {
    const text = chunk.toString("utf8");
    options.onOutput?.(stream, text);
    sink(text);
  };

  child.stdout.on("data", (chunk: Buffer) =>
    capture("stdout", chunk, (text) => {
      if (stdout.length < MAX_CAPTURE) stdout += text;
    }),
  );
  child.stderr.on("data", (chunk: Buffer) =>
    capture("stderr", chunk, (text) => {
      if (stderr.length < MAX_CAPTURE) stderr += text;
    }),
  );

  if (options.stdin !== undefined) {
    child.stdin.end(options.stdin);
  } else {
    child.stdin.end();
  }

  const killTree = (sig: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, sig);
    } catch {
      /* already gone */
    }
  };

  const timer = setTimeout(() => {
    timedOut = true;
    killTree("SIGTERM");
    // Escalate if it ignores SIGTERM.
    setTimeout(() => killTree("SIGKILL"), 5000).unref();
  }, timeoutMs);

  const onAbort = () => killTree("SIGKILL");
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const outcome = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((done) => {
    child.on("error", (error) => {
      notFound = (error as NodeJS.ErrnoException).code === "ENOENT";
      stderr += `\n${error.message}`;
      done({ code: null, signal: null });
    });
    child.on("close", (code, signal) => done({ code, signal }));
  });

  clearTimeout(timer);
  options.signal?.removeEventListener("abort", onAbort);

  // bash reports "command not found" as exit 127.
  if (outcome.code === 127) notFound = true;

  return {
    code: outcome.code,
    signal: outcome.signal,
    stdout: truncate(stdout),
    stderr: truncate(
      timedOut
        ? `${stderr}\n[wadle] killed after ${timeoutMs}ms wall-clock timeout`
        : stderr,
    ),
    durationMs: Date.now() - started,
    timedOut,
    notFound,
  };
}

/**
 * A deliberately small environment. The host's variables — including
 * NVIDIA_API_KEY — are never handed to generated or uploaded code.
 */
function baseEnvironment(extra?: Record<string, string>): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env["HOME"] ?? "/tmp",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TERM: "dumb",
    CI: "1",
    npm_config_fund: "false",
    npm_config_audit: "false",
    npm_config_update_notifier: "false",
    // Reuse the preinstalled browser instead of downloading one.
    PLAYWRIGHT_BROWSERS_PATH: process.env["PLAYWRIGHT_BROWSERS_PATH"] ?? "",
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    ...extra,
  };
}

/** Reject any path that escapes the workspace root. */
export function assertInsideWorkspaceRoot(candidate: string): void {
  const root = resolve(env.workspacesDir);
  const target = resolve(candidate);
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `Refusing to operate outside the workspace root: ${target} is not under ${root}`,
    );
  }
}

function truncate(value: string): string {
  if (value.length <= MAX_CAPTURE) return value;
  return `${value.slice(0, MAX_CAPTURE)}\n…[truncated ${value.length - MAX_CAPTURE} bytes]`;
}

function shellQuote(value: string): string {
  if (/^[\w@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface ServiceHandle {
  pid: number | undefined;
  /** Everything the process has written so far, both streams interleaved. */
  output(): string;
  exited(): boolean;
  exitCode(): number | null;
  stop(): Promise<void>;
}

/**
 * Start a long-running process (a dev server, a game host) and return a handle.
 *
 * Unlike `run`, this does not wait for exit — the caller probes the service,
 * then stops it. The process gets its own group so `stop` reliably takes down
 * child processes too, which matters because most dev servers spawn workers.
 */
export function startService(options: {
  cwd: string;
  command: string;
  env?: Record<string, string>;
  maxMemoryMb?: number;
}): ServiceHandle {
  const cwd = resolve(options.cwd);
  assertInsideWorkspaceRoot(cwd);

  const memoryMb = options.maxMemoryMb ?? env.sandbox.maxMemoryMb;
  const script = [
    `ulimit -v ${memoryMb * 1024} 2>/dev/null || true`,
    `ulimit -u ${env.sandbox.maxProcesses} 2>/dev/null || true`,
    options.command,
  ].join("\n");

  const child = spawn("bash", ["-c", script], {
    cwd,
    env: baseEnvironment(options.env),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let buffer = "";
  let done = false;
  let code: number | null = null;

  const append = (chunk: Buffer) => {
    if (buffer.length < MAX_CAPTURE) buffer += chunk.toString("utf8");
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("exit", (exitCode) => {
    done = true;
    code = exitCode;
  });
  child.on("error", (error) => {
    done = true;
    buffer += `\n${error.message}`;
  });

  return {
    pid: child.pid,
    output: () => truncate(buffer),
    exited: () => done,
    exitCode: () => code,
    stop: async () => {
      if (done || !child.pid) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
      // Give it a moment to shut down cleanly, then insist.
      await new Promise((r) => setTimeout(r, 400));
      if (!done && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    },
  };
}

/** Is a binary on PATH? Used to report degraded capability tiers honestly. */
export async function hasBinary(name: string): Promise<boolean> {
  return new Promise((done) => {
    const child = spawn("bash", ["-lc", `command -v ${shellQuote(name)}`], {
      stdio: "ignore",
    });
    child.on("error", () => done(false));
    child.on("exit", (code) => done(code === 0));
  });
}
