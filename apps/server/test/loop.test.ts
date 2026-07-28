import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { cleanup, scriptedBackend, useTemporaryDataDir } from "./helpers/harness.js";

/**
 * The build → verify → diagnose → repair loop.
 *
 * The model is scripted so the test is deterministic, but everything else is
 * real: files are written to disk, the product is actually executed, and the
 * loop's decision to continue or stop comes from observed runtime behaviour.
 *
 * The first generation deliberately produces a program that builds cleanly and
 * prints nothing — the exact "product that does nothing" failure the user said
 * must never be delivered. The loop must catch it and repair it.
 */

let dataDir: string;
let store: typeof import("../src/db/store.js");
let runRequest: typeof import("../src/agent/loop.js").runRequest;
let setBackend: typeof import("../src/llm/index.js").setBackend;

before(async () => {
  dataDir = await useTemporaryDataDir();
  const [storeModule, loopModule, llmModule] = await Promise.all([
    import("../src/db/store.js"),
    import("../src/agent/loop.js"),
    import("../src/llm/index.js"),
  ]);
  store = storeModule;
  runRequest = loopModule.runRequest;
  setBackend = llmModule.setBackend;
});

after(async () => {
  setBackend(null);
  await cleanup(dataDir);
});

const SPEC = JSON.stringify({
  productKind: "cli",
  language: "javascript",
  summary: "Print the first 10 Fibonacci numbers",
  criteria: [
    {
      description: "Running the program prints the Fibonacci sequence",
      kind: "run",
      spec: { expectExitCode: 0, stdoutContains: "34" },
    },
    {
      description: "The program does something observable when run",
      kind: "smoke",
      spec: {},
    },
  ],
});

/** Builds fine, runs fine, exits 0 — and prints absolutely nothing. */
const GENERATION_THAT_DOES_NOTHING = JSON.stringify({
  summary: "Fibonacci printer",
  kind: "cli",
  language: "javascript",
  files: [
    {
      path: "main.js",
      action: "write",
      contents:
        "function fib(n) {\n" +
        "  const out = [0, 1];\n" +
        "  while (out.length < n) out.push(out[out.length - 1] + out[out.length - 2]);\n" +
        "  return out.slice(0, n);\n" +
        "}\n" +
        "\n" +
        "// Computes the answer and then never shows it to anyone.\n" +
        "fib(10);\n",
    },
  ],
  commands: { install: "", build: "", start: "node main.js", test: "" },
  port: null,
  entrypoint: "main.js",
});

const REPAIR = JSON.stringify({
  diagnosis:
    "fib(10) was computed but never printed, so the program produced no output.",
  files: [
    {
      path: "main.js",
      action: "write",
      contents:
        "function fib(n) {\n" +
        "  const out = [0, 1];\n" +
        "  while (out.length < n) out.push(out[out.length - 1] + out[out.length - 2]);\n" +
        "  return out.slice(0, n);\n" +
        "}\n" +
        "\n" +
        "console.log(fib(10).join(', '));\n",
    },
  ],
  commands: {},
});

describe("the build loop", () => {
  it("catches a product that does nothing and repairs it to one that works", async () => {
    const { backend, callCount } = scriptedBackend([
      SPEC,
      GENERATION_THAT_DOES_NOTHING,
      REPAIR,
    ]);
    setBackend(backend as never);

    const workspace = store.createWorkspace("Fibonacci");
    const request = store.createRequest({
      workspaceId: workspace.id,
      prompt: "Print the first 10 Fibonacci numbers",
      kind: "build",
    });

    const outcome = await runRequest(request);

    assert.equal(
      outcome.status,
      "succeeded",
      `loop should converge; reason: ${outcome.reason ?? "none"}`,
    );
    assert.equal(
      outcome.iterations,
      1,
      "exactly one repair iteration should have been needed",
    );
    assert.equal(callCount(), 3, "spec, generate, then one diagnose call");

    // The delivered product must be the repaired one, and it must really work.
    const projectDir = store.workspaceDir(workspace.id);
    const source = await readFile(join(projectDir, "main.js"), "utf8");
    assert.match(source, /console\.log/, "the repair should have been applied");

    // Every criterion recorded in the database must be passing.
    const criteria = store.listCriteria(request.id);
    assert.ok(criteria.length >= 2);
    for (const criterion of criteria) {
      assert.equal(
        criterion.status,
        "pass",
        `criterion still failing: ${criterion.description} — ${criterion.detail}`,
      );
    }

    // A verified revision must exist and be the workspace's current state.
    assert.ok(outcome.revisionId, "a revision should have been created");
    const revisions = store.listRevisions(workspace.id);
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0]?.verified, 1);
    const snapshot = await readFile(
      join(revisions[0]!.snapshot_dir, "main.js"),
      "utf8",
    );
    assert.match(snapshot, /console\.log/, "the snapshot should hold the working code");
  });

  it("delivers nothing when the budget runs out with checks still failing", async () => {
    // Every repair returns the same broken code, so the loop can never converge.
    const { backend } = scriptedBackend([
      SPEC,
      GENERATION_THAT_DOES_NOTHING,
      JSON.stringify({
        diagnosis: "Trying the same thing again.",
        files: [
          {
            path: "main.js",
            action: "write",
            contents: "// still prints nothing\n",
          },
        ],
        commands: {},
      }),
    ]);
    setBackend(backend as never);

    const workspace = store.createWorkspace("Never converges");
    const request = store.createRequest({
      workspaceId: workspace.id,
      prompt: "Print the first 10 Fibonacci numbers",
      kind: "build",
    });

    const outcome = await runRequest(request);

    assert.equal(outcome.status, "failed", "an unfixable build must not report success");
    assert.ok(
      outcome.reason?.includes("repair iterations"),
      `expected a budget-exhaustion reason, got: ${outcome.reason}`,
    );
    assert.ok(
      (outcome.unmetCriteria?.length ?? 0) > 0,
      "the caller must be told exactly which checks are still failing",
    );
    assert.equal(
      outcome.revisionId,
      null,
      "no revision may be created for a product that does not work",
    );
    assert.equal(
      store.listRevisions(workspace.id).length,
      0,
      "a broken product must never be delivered as a revision",
    );
  });
});
