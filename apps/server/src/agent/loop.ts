import { copyFile, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { env } from "../config/env.js";
import type { CriterionKind, CriterionRow, RequestRow } from "../db/index.js";
import * as store from "../db/store.js";
import { inspectFile } from "../formats/inspect.js";
import { planConversion } from "../formats/convert.js";
import { sniffFile } from "../formats/sniff.js";
import { ask, askJson } from "../llm/index.js";
import { probeCapabilities } from "../sandbox/capabilities.js";
import {
  DIAGNOSE_SYSTEM,
  ENGINEER_SYSTEM,
  SPEC_SYSTEM,
  buildConversionBrief,
  buildDiagnosePrompt,
  buildGeneratePrompt,
  buildSpecPrompt,
} from "./prompts.js";
import {
  EMPTY_COMMANDS,
  applyFileOperations,
  describeProject,
  mergeCommands,
  readManifest,
  readRelevantSources,
  snapshotProject,
  writeManifest,
  type FileOperation,
  type ProjectCommands,
  type ProjectManifest,
} from "./project.js";
import { verify, type VerificationResult } from "./verify.js";

interface SpecResponse {
  productKind: string;
  language: string;
  summary: string;
  criteria: Array<{
    description: string;
    kind: CriterionKind;
    spec: Record<string, unknown>;
  }>;
}

interface GenerateResponse {
  summary: string;
  kind: string;
  language: string;
  files: FileOperation[];
  commands: Partial<ProjectCommands>;
  port: number | null;
  entrypoint: string;
}

interface DiagnoseResponse {
  diagnosis: string;
  files: FileOperation[];
  commands?: Partial<ProjectCommands>;
}

export interface LoopOutcome {
  status: "succeeded" | "failed";
  revisionId: string | null;
  iterations: number;
  tokensUsed: number;
  manifest: ProjectManifest | null;
  verification: VerificationResult | null;
  /** Present when the loop stopped without a working product. */
  unmetCriteria?: string[];
  reason?: string;
}

/**
 * Run one request to completion.
 *
 * The loop is gated on *verified execution*: it exits successfully only when
 * the product has been built, run, and observed to satisfy every acceptance
 * criterion including the "does something" gate. If the budget runs out first,
 * it reports exactly what is still failing and delivers nothing — a broken
 * product is never handed over as if it worked.
 */
export async function runRequest(
  request: RequestRow,
  options: { signal?: AbortSignal } = {},
): Promise<LoopOutcome> {
  const workspaceId = request.workspace_id;
  const projectDir = store.workspaceDir(workspaceId);
  const inputDir = store.workspaceInputDir(workspaceId);
  await mkdir(projectDir, { recursive: true });
  await mkdir(inputDir, { recursive: true });

  const startedAt = Date.now();
  const tokenSink = { value: 0 };
  let iterations = 0;

  const emit = (
    message: string,
    phase: string,
    level: "debug" | "info" | "warn" | "error" = "info",
    data?: unknown,
  ) => {
    store.appendEvent({
      workspaceId,
      requestId: request.id,
      level,
      phase,
      message,
      data,
    });
  };

  const budgetExceeded = (): string | null => {
    if (iterations >= env.agent.maxIterations) {
      return `Reached the configured ceiling of ${env.agent.maxIterations} repair iterations.`;
    }
    if (Date.now() - startedAt > env.agent.wallClockMs) {
      return `Reached the configured wall-clock ceiling of ${Math.round(env.agent.wallClockMs / 60000)} minutes.`;
    }
    if (tokenSink.value > env.agent.tokenCeiling) {
      return `Reached the configured token ceiling of ${env.agent.tokenCeiling.toLocaleString()}.`;
    }
    return null;
  };

  // ---------------------------------------------------------------- setup
  const capabilityReport = await probeCapabilities();
  const capabilitySummary = describeCapabilities(capabilityReport);

  const uploads = store.listRequestUploads(request.id);
  const attachmentSummaries: string[] = [];
  for (const upload of uploads) {
    const staged = join(inputDir, upload.filename);
    await copyFile(upload.path, staged).catch(() => {});
    try {
      const report = await inspectFile(staged);
      attachmentSummaries.push(
        `- **${report.filename}** (${report.format.format}, ${report.size} bytes)\n` +
          `  Available handling: ${report.summary}` +
          (report.detail
            ? `\n  Structure: ${JSON.stringify(report.detail).slice(0, 1200)}`
            : ""),
      );
    } catch (error) {
      attachmentSummaries.push(
        `- **${upload.filename}** — could not be inspected: ${(error as Error).message}`,
      );
    }
  }

  let effectivePrompt = request.prompt;
  if (request.kind === "convert" && request.target_format && uploads[0]) {
    const staged = join(inputDir, uploads[0].filename);
    const info = await sniffFile(staged);
    const route = planConversion(info, request.target_format);
    if (route.kind === "refuse") {
      emit(route.reason, "spec", "error");
      return {
        status: "failed",
        revisionId: null,
        iterations: 0,
        tokensUsed: 0,
        manifest: null,
        verification: null,
        reason: route.reason,
      };
    }
    if (route.kind === "generative") {
      emit(route.description, "spec", "warn");
      effectivePrompt = `${buildConversionBrief(info.format, request.target_format, route.brief)}\n\nUser's own words: ${request.prompt}`;
    }
  }

  const existingManifest = await readManifest(projectDir);
  const isAdjustment = existingManifest !== null;
  const projectTree = await describeProject(projectDir);

  // ------------------------------------------------------- 1. spec extraction
  emit("Extracting machine-checkable acceptance criteria…", "spec");
  let spec: SpecResponse;
  try {
    spec = await askJson<SpecResponse>(
      buildSpecPrompt({
        request: effectivePrompt,
        attachments: attachmentSummaries.join("\n"),
        existingProject: projectTree,
        capabilities: capabilitySummary,
      }),
      {
        system: SPEC_SYSTEM,
        profile: "precise",
        signal: options.signal,
        onUsage: countTokens(tokenSink),
      },
    );
  } catch (error) {
    const reason = `Could not derive acceptance criteria: ${(error as Error).message}`;
    emit(reason, "spec", "error");
    return {
      status: "failed",
      revisionId: null,
      iterations: 0,
      tokensUsed: tokenSink.value,
      manifest: null,
      verification: null,
      reason,
    };
  }

  const criteria = normaliseCriteria(spec);
  store.replaceCriteria(request.id, criteria);
  emit(
    `${criteria.length} acceptance criteria extracted. The build is not finished until every one passes.`,
    "spec",
    "info",
    { criteria: criteria.map((c) => c.description) },
  );

  const criteriaText = criteria
    .map((c, i) => `${i + 1}. [${c.kind}] ${c.description} — spec: ${JSON.stringify(c.spec)}`)
    .join("\n");

  // ---------------------------------------------------------- 2. generation
  emit(
    isAdjustment ? "Applying the adjustment…" : "Generating the project…",
    "generate",
  );

  let generated: GenerateResponse;
  try {
    generated = await askJson<GenerateResponse>(
      buildGeneratePrompt({
        request: effectivePrompt,
        criteria: criteriaText,
        attachments: attachmentSummaries.join("\n"),
        existingFiles: projectTree,
        capabilities: capabilitySummary,
        isAdjustment,
      }),
      {
        system: ENGINEER_SYSTEM,
        profile: isAdjustment ? "precise" : "creative",
        maxTokens: 32_000,
        signal: options.signal,
        onUsage: countTokens(tokenSink),
      },
    );
  } catch (error) {
    const reason = `Generation failed: ${(error as Error).message}`;
    emit(reason, "generate", "error");
    return {
      status: "failed",
      revisionId: null,
      iterations: 0,
      tokensUsed: tokenSink.value,
      manifest: null,
      verification: null,
      reason,
    };
  }

  const applied = await applyFileOperations(projectDir, generated.files ?? []);
  emit(
    `Wrote ${applied.written.length} files${applied.deleted.length ? `, deleted ${applied.deleted.length}` : ""}.`,
    "generate",
    "info",
    { written: applied.written, deleted: applied.deleted },
  );
  for (const rejection of applied.rejected) {
    emit(`Rejected a file operation — ${rejection}`, "generate", "warn");
  }

  let manifest: ProjectManifest = {
    kind: generated.kind || existingManifest?.kind || "cli",
    language: generated.language || existingManifest?.language || "unknown",
    commands: mergeCommands(
      existingManifest?.commands ?? EMPTY_COMMANDS,
      generated.commands,
    ),
    port: generated.port ?? existingManifest?.port ?? null,
    entrypoint: generated.entrypoint || existingManifest?.entrypoint || "",
    summary: generated.summary || request.prompt.slice(0, 200),
  };
  await writeManifest(projectDir, manifest);

  // -------------------------------------------- 3-5. verify / diagnose / repair
  const attemptHistory: string[] = [];
  let verification: VerificationResult | null = null;

  for (;;) {
    const exhausted = budgetExceeded();
    if (exhausted) {
      const unmet = (verification?.criteria ?? [])
        .filter((c) => c.status === "fail")
        .map((c) => `${c.description} → ${c.detail}`);
      emit(
        `Stopping without delivering: ${exhausted} The product is not being handed over because it does not yet pass every check.`,
        "verify",
        "error",
        { unmetCriteria: unmet },
      );
      return {
        status: "failed",
        revisionId: null,
        iterations,
        tokensUsed: tokenSink.value,
        manifest,
        verification,
        unmetCriteria: unmet,
        reason: exhausted,
      };
    }

    emit(
      iterations === 0
        ? "Building and running the product…"
        : `Re-verifying after repair ${iterations}…`,
      "verify",
    );

    verification = await verify({
      projectDir,
      manifest,
      criteria: store.listCriteria(request.id),
      onLog: (line) => emit(line, "verify", "debug"),
      signal: options.signal,
    });

    for (const result of verification.criteria) {
      if (result.id.startsWith("gate:")) continue;
      store.setCriterionResult(result.id, result.status, result.detail);
    }

    const passedCount = verification.criteria.filter((c) => c.status === "pass").length;
    emit(
      `${passedCount}/${verification.criteria.length} checks passed.`,
      "verify",
      verification.passed ? "info" : "warn",
      {
        criteria: verification.criteria.map((c) => ({
          description: c.description,
          status: c.status,
          detail: c.detail,
        })),
        evidence: verification.evidence,
      },
    );

    if (verification.passed) break;

    iterations += 1;
    store.updateRequest(request.id, { iterations, tokens_used: tokenSink.value });

    emit(
      `Diagnosing failure ${iterations}…`,
      "diagnose",
      "warn",
    );

    const hints = extractPathHints(verification.failureReport);
    let repair: DiagnoseResponse;
    try {
      repair = await askJson<DiagnoseResponse>(
        buildDiagnosePrompt({
          request: effectivePrompt,
          failures: verification.failureReport,
          projectFiles: await describeProject(projectDir),
          relevantSources: await readRelevantSources(projectDir, hints),
          iteration: iterations,
          previousAttempts: attemptHistory.slice(-5).join("\n"),
        }),
        {
          system: DIAGNOSE_SYSTEM,
          profile: "precise",
          maxTokens: 32_000,
          signal: options.signal,
          onUsage: countTokens(tokenSink),
        },
      );
    } catch (error) {
      emit(
        `The model could not produce a repair this round: ${(error as Error).message}. Retrying.`,
        "diagnose",
        "warn",
      );
      continue;
    }

    attemptHistory.push(`Iteration ${iterations}: ${repair.diagnosis}`);
    emit(repair.diagnosis, "diagnose", "info");

    const repairApplied = await applyFileOperations(projectDir, repair.files ?? []);
    emit(
      `Applied repair to ${repairApplied.written.length} files.`,
      "diagnose",
      "info",
      { written: repairApplied.written },
    );

    if (repair.commands) {
      manifest = {
        ...manifest,
        commands: mergeCommands(manifest.commands, repair.commands),
      };
      await writeManifest(projectDir, manifest);
    }

    if (repairApplied.written.length === 0 && repairApplied.deleted.length === 0) {
      emit(
        "The repair changed nothing. Re-running verification to confirm before trying a different approach.",
        "diagnose",
        "warn",
      );
    }
  }

  // ------------------------------------------------------------ 6. delivery
  emit("All checks passed. Snapshotting this revision…", "deliver");

  const revision = store.createRevision({
    workspaceId,
    requestId: request.id,
    summary: manifest.summary,
    snapshotDir: "",
    verified: true,
  });
  const snapshotDir = join(
    env.workspacesDir,
    workspaceId,
    "revisions",
    revision.id,
  );
  await snapshotProject(projectDir, snapshotDir);
  store.setRevisionSnapshot(revision.id, snapshotDir);

  store.updateRequest(request.id, { iterations, tokens_used: tokenSink.value });

  emit(
    `Delivered: ${manifest.summary}`,
    "deliver",
    "info",
    { evidence: verification?.evidence ?? [] },
  );

  return {
    status: "succeeded",
    revisionId: revision.id,
    iterations,
    tokensUsed: tokenSink.value,
    manifest,
    verification,
  };
}

/** Accumulate token spend so the budget ceiling is enforced on real usage. */
function countTokens(sink: { value: number }) {
  return (usage: { totalTokens: number }) => {
    sink.value += usage.totalTokens;
  };
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const VALID_KINDS: CriterionKind[] = [
  "build",
  "run",
  "http",
  "file",
  "test",
  "smoke",
  "manual",
];

function normaliseCriteria(
  spec: SpecResponse,
): Array<{ description: string; kind: CriterionKind; spec: unknown }> {
  const raw = Array.isArray(spec.criteria) ? spec.criteria : [];
  const criteria = raw
    .filter((entry) => typeof entry?.description === "string")
    .slice(0, 12)
    .map((entry) => ({
      description: entry.description,
      kind: VALID_KINDS.includes(entry.kind) ? entry.kind : ("smoke" as CriterionKind),
      spec: entry.spec ?? {},
    }));

  // Always guarantee a runtime check, even if the model omitted one.
  if (!criteria.some((c) => c.kind === "smoke")) {
    criteria.push({
      description:
        "The product visibly does something when run, rather than starting and exiting silently.",
      kind: "smoke",
      spec: {},
    });
  }
  return criteria;
}

function extractPathHints(report: string): string[] {
  const hints = new Set<string>();
  // Paths appear in compiler and runtime errors in a few common shapes.
  const patterns = [
    /(?:^|\s|\()([\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|c|h|cpp|java|rb|php|json|toml|yaml|yml))(?::\d+)?/g,
  ];
  for (const pattern of patterns) {
    for (const match of report.matchAll(pattern)) {
      const path = match[1];
      if (path && !path.includes("node_modules")) {
        hints.add(basename(path));
        hints.add(path.replace(/^\.\//, ""));
      }
    }
  }
  return [...hints].slice(0, 12);
}

function describeCapabilities(report: {
  languages: Array<{ label: string; available: boolean; degradedTo: string }>;
  binaryTargets: Array<{ label: string; available: boolean; degradedTo: string }>;
  conversion: Array<{ label: string; available: boolean }>;
}): string {
  const line = (
    entry: { label: string; available: boolean; degradedTo?: string },
  ) =>
    entry.available
      ? `  - ${entry.label}: available`
      : `  - ${entry.label}: NOT available${entry.degradedTo ? ` (falls back to: ${entry.degradedTo})` : ""}`;

  return [
    "Languages that can be built, run and tested here:",
    ...report.languages.map(line),
    "",
    "Binary targets:",
    ...report.binaryTargets.map(line),
    "",
    "Conversion tooling:",
    ...report.conversion.map(line),
    "",
    "Do not choose a language or target marked NOT available — the build will fail verification.",
  ].join("\n");
}

