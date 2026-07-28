import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { cleanup, useTemporaryDataDir } from "./helpers/harness.js";

/**
 * Stacked adjustments.
 *
 * A user can queue several changes while the first is still building. They must
 * run in order, each applied on top of what the previous one produced, and each
 * must leave a restorable revision behind.
 */

let dataDir: string;
let store: typeof import("../src/db/store.js");
let queue: typeof import("../src/runtime/queue.js");
let setBackend: typeof import("../src/llm/index.js").setBackend;

before(async () => {
  dataDir = await useTemporaryDataDir();
  const [storeModule, queueModule, llmModule] = await Promise.all([
    import("../src/db/store.js"),
    import("../src/runtime/queue.js"),
    import("../src/llm/index.js"),
  ]);
  store = storeModule;
  queue = queueModule;
  setBackend = llmModule.setBackend;
});

after(async () => {
  setBackend(null);
  await cleanup(dataDir);
});

/**
 * A backend that answers by prompt shape rather than call order, so it survives
 * however many spec/generate rounds the queue happens to make.
 *
 * Each generation rewrites main.js to print one more line than the last, which
 * makes "did every stacked adjustment land, in order?" checkable from the
 * product's actual output.
 */
function stackingBackend() {
  const lines: string[] = [];
  return {
    name: "stacking-fixture",
    model: "fixture",
    async complete(request: { messages: Array<{ content: string }> }) {
      const prompt = request.messages[request.messages.length - 1]?.content ?? "";

      if (prompt.includes("Extract acceptance criteria")) {
        return respond(
          JSON.stringify({
            productKind: "cli",
            language: "javascript",
            summary: "Prints one line per applied change",
            criteria: [
              {
                description: "Running the program prints every applied change",
                kind: "run",
                spec: { expectExitCode: 0 },
              },
            ],
          }),
        );
      }

      // A generation or an adjustment: append a line and rewrite the file.
      const match = prompt.match(/User request marker: (change-\d+)/);
      lines.push(match?.[1] ?? `change-${lines.length + 1}`);
      const body = lines.map((line) => `console.log(${JSON.stringify(line)});`).join("\n");

      return respond(
        JSON.stringify({
          summary: `Applied ${lines[lines.length - 1]}`,
          kind: "cli",
          language: "javascript",
          files: [{ path: "main.js", action: "write", contents: `${body}\n` }],
          commands: { install: "", build: "", start: "node main.js", test: "" },
          port: null,
          entrypoint: "main.js",
        }),
      );
    },
  };

  function respond(text: string) {
    return {
      text,
      usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
      model: "fixture",
      durationMs: 1,
    };
  }
}

function waitForIdle(workspaceId: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((done, failed) => {
    const tick = () => {
      const pending = store
        .listRequests(workspaceId)
        .filter((r) => r.status === "queued" || r.status === "running");
      if (pending.length === 0 && !queue.isRunning(workspaceId)) {
        done();
        return;
      }
      if (Date.now() > deadline) {
        failed(new Error(`queue did not drain: ${pending.length} still pending`));
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}

describe("stacked requests", () => {
  it("runs three queued adjustments in order, each on the previous result", async () => {
    setBackend(stackingBackend() as never);

    const workspace = store.createWorkspace("Stacking");

    // Enqueue all three up front — this is the "stack while it builds" case.
    for (let i = 1; i <= 3; i += 1) {
      store.createRequest({
        workspaceId: workspace.id,
        prompt: `Add another line. User request marker: change-${i}`,
        kind: i === 1 ? "build" : "adjust",
      });
    }

    const queued = store.listRequests(workspace.id);
    assert.equal(queued.length, 3);
    assert.deepEqual(
      queued.map((r) => r.seq),
      [1, 2, 3],
      "requests must be sequenced in submission order",
    );

    queue.schedule(workspace.id);
    await waitForIdle(workspace.id);

    const finished = store.listRequests(workspace.id);
    for (const request of finished) {
      assert.equal(
        request.status,
        "succeeded",
        `request #${request.seq} failed: ${request.error}`,
      );
    }

    // Each request must have produced its own verified revision, in order.
    const revisions = store.listRevisions(workspace.id);
    assert.equal(revisions.length, 3, "one revision per delivered request");
    assert.deepEqual(
      revisions.map((r) => r.seq).sort((a, b) => a - b),
      [1, 2, 3],
    );
    assert.ok(revisions.every((r) => r.verified === 1));

    // The final product must contain all three changes — proving each
    // adjustment was applied on top of the previous one rather than replacing it.
    const projectDir = store.workspaceDir(workspace.id);
    const source = await readFile(join(projectDir, "main.js"), "utf8");
    for (const marker of ["change-1", "change-2", "change-3"]) {
      assert.match(source, new RegExp(marker), `${marker} is missing from the product`);
    }
    assert.ok(
      source.indexOf("change-1") < source.indexOf("change-2") &&
        source.indexOf("change-2") < source.indexOf("change-3"),
      "changes must have been applied in submission order",
    );

    // The workspace should point at the newest revision.
    const refreshed = store.getWorkspace(workspace.id);
    const newest = revisions.find((r) => r.seq === 3);
    assert.equal(refreshed?.current_revision_id, newest?.id);
  });

  it("restores an earlier revision on request", async () => {
    const workspace = store.listWorkspaces()[0];
    assert.ok(workspace);

    const revisions = store.listRevisions(workspace.id);
    const first = revisions.find((r) => r.seq === 1);
    assert.ok(first, "revision #1 should exist");

    const { restoreSnapshot } = await import("../src/agent/project.js");
    await restoreSnapshot(first.snapshot_dir, store.workspaceDir(workspace.id));
    store.setCurrentRevision(workspace.id, first.id);

    const source = await readFile(
      join(store.workspaceDir(workspace.id), "main.js"),
      "utf8",
    );
    assert.match(source, /change-1/);
    assert.doesNotMatch(
      source,
      /change-2/,
      "restoring revision #1 must roll back the later adjustments",
    );
  });
});
