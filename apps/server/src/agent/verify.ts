import { readFile, stat } from "node:fs/promises";
import { Socket } from "node:net";
import { join } from "node:path";
import { env } from "../config/env.js";
import type { CriterionRow } from "../db/index.js";
import { run, startService, type ServiceHandle } from "../sandbox/exec.js";
import { resolveProjectPath, type ProjectManifest } from "./project.js";

export interface StepResult {
  name: string;
  command: string;
  code: number | null;
  ok: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  skipped?: string;
}

export interface CriterionResult {
  id: string;
  description: string;
  status: "pass" | "fail";
  detail: string;
}

export interface VerificationResult {
  passed: boolean;
  steps: StepResult[];
  criteria: CriterionResult[];
  /** Runtime evidence the product actually did something. */
  evidence: string[];
  /** Compact failure description fed straight back to the model. */
  failureReport: string;
}

interface CriterionSpec {
  expectExitCode?: number;
  stdoutContains?: string;
  stdoutMatches?: string;
  path?: string;
  minBytes?: number;
  contains?: string;
  status?: number;
  bodyContains?: string;
}

/**
 * Build, run and check the product.
 *
 * This is the gate the whole system turns on. A build that compiles but does
 * nothing at runtime must FAIL here — that is the single most common way
 * generated software is wrong, and the reason the loop exists at all.
 */
export async function verify(options: {
  projectDir: string;
  manifest: ProjectManifest;
  criteria: CriterionRow[];
  onLog?: (line: string) => void;
  signal?: AbortSignal;
}): Promise<VerificationResult> {
  const { projectDir, manifest, criteria } = options;
  const log = options.onLog ?? (() => {});
  const steps: StepResult[] = [];
  const evidence: string[] = [];

  // ---- 1. Install dependencies (the only step allowed network access) ----
  if (manifest.commands.install) {
    const step = await runStep({
      name: "install",
      command: manifest.commands.install,
      projectDir,
      allowNetwork: env.sandbox.allowInstallNetwork,
      timeoutMs: 300_000,
      log,
      signal: options.signal,
    });
    steps.push(step);
    if (!step.ok) {
      return fail(steps, criteria, evidence, "Dependency installation failed.");
    }
  }

  // ---- 2. Build ----
  if (manifest.commands.build) {
    const step = await runStep({
      name: "build",
      command: manifest.commands.build,
      projectDir,
      allowNetwork: false,
      timeoutMs: 300_000,
      log,
      signal: options.signal,
    });
    steps.push(step);
    if (!step.ok) {
      return fail(steps, criteria, evidence, "Build failed.");
    }
  }

  // ---- 3. Runtime probe: does it actually do anything? ----
  let runtime: RuntimeProbe;
  if (manifest.port) {
    runtime = await probeHttpService(projectDir, manifest, log, options.signal);
  } else {
    runtime = await probeCommand(projectDir, manifest, log, options.signal);
  }
  steps.push(runtime.step);
  evidence.push(...runtime.evidence);

  // ---- 4. Tests ----
  if (manifest.commands.test) {
    const step = await runStep({
      name: "test",
      command: manifest.commands.test,
      projectDir,
      allowNetwork: false,
      timeoutMs: 300_000,
      log,
      signal: options.signal,
    });
    steps.push(step);
  }

  // ---- 5. Acceptance criteria ----
  const results: CriterionResult[] = [];
  for (const criterion of criteria) {
    results.push(
      await checkCriterion(criterion, {
        projectDir,
        steps,
        runtime,
        manifest,
      }),
    );
  }

  // ---- 6. The anti-"does nothing" gate ----
  const gate = evaluateDoesSomethingGate(runtime, manifest);
  results.push(gate);

  const passed = results.every((result) => result.status === "pass");
  return {
    passed,
    steps,
    criteria: results,
    evidence,
    failureReport: passed ? "" : describeFailures(steps, results),
  };
}

/* ------------------------------------------------------------------ *
 * Runtime probes
 * ------------------------------------------------------------------ */

interface RuntimeProbe {
  step: StepResult;
  evidence: string[];
  /** For HTTP products: responses collected during the probe. */
  httpResponses: Map<string, { status: number; body: string }>;
  stdout: string;
  exitCode: number | null;
  started: boolean;
}

async function probeCommand(
  projectDir: string,
  manifest: ProjectManifest,
  log: (line: string) => void,
  signal?: AbortSignal,
): Promise<RuntimeProbe> {
  if (!manifest.commands.start) {
    return {
      step: {
        name: "run",
        command: "(none)",
        code: null,
        ok: false,
        stdout: "",
        stderr: "No start command was provided, so the product cannot be run.",
        durationMs: 0,
      },
      evidence: [],
      httpResponses: new Map(),
      stdout: "",
      exitCode: null,
      started: false,
    };
  }

  const step = await runStep({
    name: "run",
    command: manifest.commands.start,
    projectDir,
    allowNetwork: false,
    timeoutMs: 60_000,
    log,
    signal,
  });

  const evidence: string[] = [];
  const output = `${step.stdout}${step.stderr}`.trim();
  if (output) {
    evidence.push(
      `Produced ${output.length} characters of output when run.`,
    );
  }

  return {
    step,
    evidence,
    httpResponses: new Map(),
    stdout: step.stdout,
    exitCode: step.code,
    started: step.code !== null,
  };
}

async function probeHttpService(
  projectDir: string,
  manifest: ProjectManifest,
  log: (line: string) => void,
  signal?: AbortSignal,
): Promise<RuntimeProbe> {
  const port = manifest.port ?? 0;
  const started = Date.now();
  let service: ServiceHandle | null = null;
  const responses = new Map<string, { status: number; body: string }>();
  const evidence: string[] = [];

  try {
    log(`[run] starting service: ${manifest.commands.start}`);
    service = startService({
      cwd: projectDir,
      command: manifest.commands.start,
      env: { PORT: String(port), HOST: "127.0.0.1" },
    });

    const ready = await waitForPort(port, 30_000, () => service?.exited() ?? false);
    if (!ready) {
      const output = service.output();
      return {
        step: {
          name: "run",
          command: manifest.commands.start,
          code: service.exitCode(),
          ok: false,
          stdout: output,
          stderr: service.exited()
            ? `The service exited before it began listening on port ${port}.`
            : `Nothing was listening on port ${port} after 30 seconds.`,
          durationMs: Date.now() - started,
        },
        evidence,
        httpResponses: responses,
        stdout: output,
        exitCode: service.exitCode(),
        started: false,
      };
    }

    evidence.push(`Service came up and accepted connections on port ${port}.`);

    const root = await fetchPath(port, "/");
    responses.set("/", root);
    evidence.push(
      `GET / responded ${root.status} with a ${root.body.length}-byte body.`,
    );

    return {
      step: {
        name: "run",
        command: manifest.commands.start,
        code: 0,
        ok: true,
        stdout: service.output(),
        stderr: "",
        durationMs: Date.now() - started,
      },
      evidence,
      httpResponses: responses,
      stdout: service.output(),
      exitCode: null,
      started: true,
    };
  } finally {
    await service?.stop();
  }
}

/** Fetch a path from the product under test, tolerating non-2xx. */
async function fetchPath(
  port: number,
  path: string,
): Promise<{ status: number; body: string }> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      signal: AbortSignal.timeout(15_000),
      redirect: "follow",
    });
    const body = await response.text();
    return { status: response.status, body: body.slice(0, 200_000) };
  } catch (error) {
    return { status: 0, body: `request failed: ${(error as Error).message}` };
  }
}

function waitForPort(
  port: number,
  timeoutMs: number,
  hasExited: () => boolean,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((done) => {
    const attempt = () => {
      if (hasExited()) {
        done(false);
        return;
      }
      if (Date.now() > deadline) {
        done(false);
        return;
      }
      // Probe by connecting, never by binding — binding would steal the port
      // out from under the service we are waiting for.
      const client = new Socket();
      client.setTimeout(1000);
      client.once("connect", () => {
        client.destroy();
        done(true);
      });
      client.once("error", () => {
        client.destroy();
        setTimeout(attempt, 300);
      });
      client.once("timeout", () => {
        client.destroy();
        setTimeout(attempt, 300);
      });
      client.connect(port, "127.0.0.1");
    };
    attempt();
  });
}

/* ------------------------------------------------------------------ *
 * Criteria and the gate
 * ------------------------------------------------------------------ */

async function checkCriterion(
  criterion: CriterionRow,
  context: {
    projectDir: string;
    steps: StepResult[];
    runtime: RuntimeProbe;
    manifest: ProjectManifest;
  },
): Promise<CriterionResult> {
  let spec: CriterionSpec = {};
  try {
    spec = JSON.parse(criterion.spec) as CriterionSpec;
  } catch {
    /* an unparseable spec is treated as an empty one */
  }

  const pass = (detail: string): CriterionResult => ({
    id: criterion.id,
    description: criterion.description,
    status: "pass",
    detail,
  });
  const failed = (detail: string): CriterionResult => ({
    id: criterion.id,
    description: criterion.description,
    status: "fail",
    detail,
  });

  const stepNamed = (name: string) =>
    context.steps.find((step) => step.name === name);

  switch (criterion.kind) {
    case "build": {
      const step = stepNamed("build");
      if (!step) return pass("No build step is required for this project.");
      return step.ok
        ? pass(`Build exited 0 in ${step.durationMs}ms.`)
        : failed(`Build exited ${step.code}. ${lastLines(step.stderr || step.stdout)}`);
    }

    case "test": {
      const step = stepNamed("test");
      if (!step) return failed("No test command was defined, so tests cannot pass.");
      return step.ok
        ? pass(`Tests exited 0 in ${step.durationMs}ms.`)
        : failed(`Tests exited ${step.code}. ${lastLines(step.stderr || step.stdout)}`);
    }

    case "run": {
      const { runtime } = context;
      if (!runtime.started && runtime.step.code !== 0) {
        return failed(
          `The product did not run successfully. ${lastLines(runtime.step.stderr)}`,
        );
      }
      const expected = spec.expectExitCode ?? 0;
      if (runtime.exitCode !== null && runtime.exitCode !== expected) {
        return failed(
          `Expected exit code ${expected}, got ${runtime.exitCode}. ${lastLines(runtime.step.stderr)}`,
        );
      }
      if (spec.stdoutContains && !runtime.stdout.includes(spec.stdoutContains)) {
        return failed(
          `Output did not contain "${spec.stdoutContains}". Actual output: ${lastLines(runtime.stdout)}`,
        );
      }
      if (spec.stdoutMatches) {
        try {
          if (!new RegExp(spec.stdoutMatches).test(runtime.stdout)) {
            return failed(
              `Output did not match /${spec.stdoutMatches}/. Actual output: ${lastLines(runtime.stdout)}`,
            );
          }
        } catch {
          return pass("Criterion regex was invalid; treated as satisfied.");
        }
      }
      return pass("Ran successfully with the expected output.");
    }

    case "http": {
      const path = spec.path ?? "/";
      let response = context.runtime.httpResponses.get(path);
      if (!response) {
        return failed(
          context.runtime.started
            ? `No response was captured for ${path}.`
            : "The service never started, so no HTTP check could run.",
        );
      }
      const expectedStatus = spec.status ?? 200;
      if (response.status !== expectedStatus) {
        return failed(
          `GET ${path} returned ${response.status}, expected ${expectedStatus}.`,
        );
      }
      if (spec.bodyContains && !response.body.includes(spec.bodyContains)) {
        return failed(
          `GET ${path} responded ${response.status} but the body did not contain "${spec.bodyContains}".`,
        );
      }
      return pass(`GET ${path} → ${response.status}, ${response.body.length} bytes.`);
    }

    case "file": {
      if (!spec.path) return pass("No file path was specified.");
      let target: string;
      try {
        target = resolveProjectPath(context.projectDir, spec.path);
      } catch (error) {
        return failed((error as Error).message);
      }
      const info = await stat(target).catch(() => null);
      if (!info) return failed(`Expected file '${spec.path}' was not produced.`);
      if (spec.minBytes && info.size < spec.minBytes) {
        return failed(
          `'${spec.path}' exists but is only ${info.size} bytes; at least ${spec.minBytes} were expected.`,
        );
      }
      if (spec.contains) {
        const text = await readFile(target, "utf8").catch(() => "");
        if (!text.includes(spec.contains)) {
          return failed(`'${spec.path}' does not contain "${spec.contains}".`);
        }
      }
      return pass(`'${spec.path}' exists (${info.size} bytes).`);
    }

    case "smoke":
    case "manual":
    default: {
      const gate = evaluateDoesSomethingGate(context.runtime, context.manifest);
      return gate.status === "pass"
        ? pass(gate.detail)
        : failed(gate.detail);
    }
  }
}

/**
 * The anti-"does nothing" gate.
 *
 * A product that builds cleanly and then does nothing at runtime is the classic
 * failure mode of generated software, and it is exactly what the user said must
 * never be delivered. This check is applied on every verification pass in
 * addition to whatever criteria were extracted.
 */
function evaluateDoesSomethingGate(
  runtime: RuntimeProbe,
  manifest: ProjectManifest | null,
): CriterionResult {
  const base = {
    id: "gate:does-something",
    description:
      "The product visibly does something when run — it is not a stub that starts and exits.",
  };

  // Anything that failed to run at all fails here, whatever it printed on the
  // way down. A "server" that logs a line and exits has produced output but has
  // not produced a working product.
  if (!runtime.step.ok) {
    const exit =
      runtime.step.code === null
        ? "did not run"
        : `exited ${runtime.step.code}`;
    return {
      ...base,
      status: "fail",
      detail: `The product ${exit}. ${lastLines(
        runtime.step.stderr || runtime.step.stdout,
      )}`,
    };
  }

  const root = runtime.httpResponses.get("/");

  // A product declared as an HTTP service must actually have served something.
  if (manifest?.port && !root) {
    return {
      ...base,
      status: "fail",
      detail:
        `This product is meant to serve HTTP on port ${manifest.port}, but no response ` +
        `was ever captured from it.`,
    };
  }

  // HTTP products: a served page must have real content.
  if (root) {
    if (root.status === 0) {
      return { ...base, status: "fail", detail: root.body };
    }
    if (root.status >= 500) {
      return {
        ...base,
        status: "fail",
        detail: `The service responded ${root.status} on / — it started but is erroring.`,
      };
    }
    const body = root.body.trim();
    if (body.length < 80) {
      return {
        ...base,
        status: "fail",
        detail:
          `GET / returned only ${body.length} bytes. A product that serves an essentially ` +
          `empty page does not satisfy the request.`,
      };
    }
    const looksEmpty =
      /<body[^>]*>\s*<\/body>/i.test(body) ||
      (/<html/i.test(body) && !/<(div|canvas|main|section|h1|p|button|form|svg|table|ul|img|script)/i.test(body));
    if (looksEmpty) {
      return {
        ...base,
        status: "fail",
        detail:
          "GET / returned an HTML document with no meaningful content in the body.",
      };
    }
    return {
      ...base,
      status: "pass",
      detail: `Served a ${body.length}-byte response with real content on /.`,
    };
  }

  // CLI and binary products: exit cleanly and produce output, or write a file.
  if (runtime.exitCode !== null && runtime.exitCode !== 0) {
    return {
      ...base,
      status: "fail",
      detail: `The product exited ${runtime.exitCode}. ${lastLines(runtime.step.stderr)}`,
    };
  }

  const output = `${runtime.step.stdout}${runtime.step.stderr}`.trim();
  if (output.length === 0) {
    const producesFiles = manifest?.kind === "library";
    if (producesFiles) {
      return {
        ...base,
        status: "pass",
        detail: "Library build succeeded; no runtime output is expected.",
      };
    }
    return {
      ...base,
      status: "fail",
      detail:
        "The product ran and exited 0 but produced no output at all. A program that " +
        "does nothing observable does not satisfy the request — it must print results, " +
        "serve a response, or write a file.",
    };
  }

  return {
    ...base,
    status: "pass",
    detail: `Ran and produced ${output.length} characters of output.`,
  };
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

async function runStep(options: {
  name: string;
  command: string;
  projectDir: string;
  allowNetwork: boolean;
  timeoutMs: number;
  log: (line: string) => void;
  signal?: AbortSignal;
}): Promise<StepResult> {
  options.log(`[${options.name}] ${options.command}`);
  const result = await run({
    cwd: options.projectDir,
    command: options.command,
    shell: true,
    allowNetwork: options.allowNetwork,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    onOutput: (_stream, chunk) => {
      const trimmed = chunk.trimEnd();
      if (trimmed) options.log(`[${options.name}] ${trimmed}`);
    },
  });
  return {
    name: options.name,
    command: options.command,
    code: result.code,
    ok: result.code === 0,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
  };
}

function fail(
  steps: StepResult[],
  criteria: CriterionRow[],
  evidence: string[],
  reason: string,
): VerificationResult {
  const results: CriterionResult[] = criteria.map((criterion) => ({
    id: criterion.id,
    description: criterion.description,
    status: "fail" as const,
    detail: reason,
  }));
  return {
    passed: false,
    steps,
    criteria: results,
    evidence,
    failureReport: describeFailures(steps, results),
  };
}

function describeFailures(
  steps: StepResult[],
  criteria: CriterionResult[],
): string {
  const parts: string[] = [];

  for (const step of steps) {
    if (step.ok) continue;
    parts.push(
      `### Step '${step.name}' failed (exit ${step.code})\n` +
        `Command: ${step.command}\n\n` +
        `stdout:\n${lastLines(step.stdout, 60)}\n\n` +
        `stderr:\n${lastLines(step.stderr, 60)}`,
    );
  }

  const failedCriteria = criteria.filter((c) => c.status === "fail");
  if (failedCriteria.length > 0) {
    parts.push(
      `### Acceptance criteria not met (${failedCriteria.length} of ${criteria.length})\n` +
        failedCriteria
          .map((c) => `- ${c.description}\n  → ${c.detail}`)
          .join("\n"),
    );
  }

  return parts.join("\n\n");
}

function lastLines(text: string, count = 40): string {
  if (!text) return "(no output)";
  const lines = text.trimEnd().split("\n");
  const slice = lines.slice(-count).join("\n");
  return slice.length > 6000 ? `…${slice.slice(-6000)}` : slice;
}

export { join };
