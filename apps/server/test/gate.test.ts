import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { cleanup, useTemporaryDataDir } from "./helpers/harness.js";

/**
 * The anti-"does nothing" gate.
 *
 * This is the check the entire product promise rests on: a build that compiles
 * cleanly and then does nothing at runtime must be REJECTED, not delivered.
 * These tests run real programs — no model, no mocks of the thing under test.
 */

let dataDir: string;
let verify: typeof import("../src/agent/verify.js").verify;
let workspacesDir: string;

before(async () => {
  dataDir = await useTemporaryDataDir();
  const [verifyModule, envModule] = await Promise.all([
    import("../src/agent/verify.js"),
    import("../src/config/env.js"),
  ]);
  verify = verifyModule.verify;
  workspacesDir = envModule.env.workspacesDir;
  await mkdir(workspacesDir, { recursive: true });
});

after(async () => cleanup(dataDir));

let counter = 0;
async function project(files: Record<string, string>): Promise<string> {
  counter += 1;
  const dir = join(workspacesDir, `ws_gate_${counter}`, "product");
  await mkdir(dir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    const target = join(dir, name);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
  return dir;
}

const NO_CRITERIA: never[] = [];

describe("the does-something gate", () => {
  it("REJECTS a CLI that builds fine but prints nothing", async () => {
    const dir = await project({
      "main.js": "process.exit(0);\n",
    });

    const result = await verify({
      projectDir: dir,
      manifest: {
        kind: "cli",
        language: "javascript",
        commands: { install: "", build: "", start: "node main.js", test: "" },
        port: null,
        entrypoint: "main.js",
        summary: "does nothing",
      },
      criteria: NO_CRITERIA,
    });

    assert.equal(result.passed, false, "a silent no-op must not pass");
    const gate = result.criteria.find((c) => c.id === "gate:does-something");
    assert.ok(gate, "the gate must always be evaluated");
    assert.equal(gate.status, "fail");
    assert.match(gate.detail, /no output at all/i);
  });

  it("ACCEPTS a CLI that actually produces output", async () => {
    const dir = await project({
      "main.js": "console.log('computed 6 x 7 =', 6 * 7);\n",
    });

    const result = await verify({
      projectDir: dir,
      manifest: {
        kind: "cli",
        language: "javascript",
        commands: { install: "", build: "", start: "node main.js", test: "" },
        port: null,
        entrypoint: "main.js",
        summary: "prints a result",
      },
      criteria: NO_CRITERIA,
    });

    const gate = result.criteria.find((c) => c.id === "gate:does-something");
    assert.equal(gate?.status, "pass", gate?.detail);
    assert.equal(result.passed, true);
  });

  it("REJECTS a CLI that exits non-zero", async () => {
    const dir = await project({
      "main.js": "console.log('starting');\nprocess.exit(3);\n",
    });

    const result = await verify({
      projectDir: dir,
      manifest: {
        kind: "cli",
        language: "javascript",
        commands: { install: "", build: "", start: "node main.js", test: "" },
        port: null,
        entrypoint: "main.js",
        summary: "crashes",
      },
      criteria: NO_CRITERIA,
    });

    assert.equal(result.passed, false);
    const gate = result.criteria.find((c) => c.id === "gate:does-something");
    assert.match(gate?.detail ?? "", /exited 3/);
  });

  it("REJECTS a web server that starts but serves an empty page", async () => {
    const dir = await project({
      "server.js": `
const http = require("node:http");
http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<html><body></body></html>");
}).listen(process.env.PORT || 3000, "127.0.0.1");
`,
    });

    const result = await verify({
      projectDir: dir,
      manifest: {
        kind: "web",
        language: "javascript",
        commands: { install: "", build: "", start: "node server.js", test: "" },
        port: 5411,
        entrypoint: "server.js",
        summary: "empty page",
      },
      criteria: NO_CRITERIA,
    });

    assert.equal(result.passed, false, "an empty page is not a working product");
    const gate = result.criteria.find((c) => c.id === "gate:does-something");
    assert.equal(gate?.status, "fail");
  });

  it("ACCEPTS a web server that serves real content", async () => {
    const dir = await project({
      "server.js": `
const http = require("node:http");
http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(\`<!doctype html><html><body>
    <h1>Task list</h1>
    <ul><li>Write the server</li><li>Serve real content</li></ul>
    <button id="add">Add task</button>
  </body></html>\`);
}).listen(process.env.PORT || 3000, "127.0.0.1");
`,
    });

    const result = await verify({
      projectDir: dir,
      manifest: {
        kind: "web",
        language: "javascript",
        commands: { install: "", build: "", start: "node server.js", test: "" },
        port: 5412,
        entrypoint: "server.js",
        summary: "real page",
      },
      criteria: NO_CRITERIA,
    });

    const gate = result.criteria.find((c) => c.id === "gate:does-something");
    assert.equal(gate?.status, "pass", gate?.detail);
    assert.equal(result.passed, true);
    assert.ok(
      result.evidence.some((line) => /GET \/ responded 200/.test(line)),
      "evidence should record the real HTTP response",
    );
  });

  it("REJECTS a web server that never binds its port", async () => {
    const dir = await project({
      "server.js": "console.log('I am not a server');\n",
    });

    const result = await verify({
      projectDir: dir,
      manifest: {
        kind: "web",
        language: "javascript",
        commands: { install: "", build: "", start: "node server.js", test: "" },
        port: 5413,
        entrypoint: "server.js",
        summary: "never listens",
      },
      criteria: NO_CRITERIA,
    });

    assert.equal(result.passed, false);
    assert.match(result.failureReport, /port 5413|exited before/i);
  });

  it("REJECTS a build that fails, without ever running the product", async () => {
    const dir = await project({ "main.js": "console.log('unreachable');\n" });

    const result = await verify({
      projectDir: dir,
      manifest: {
        kind: "cli",
        language: "javascript",
        commands: {
          install: "",
          build: "node -e \"process.exit(1)\"",
          start: "node main.js",
          test: "",
        },
        port: null,
        entrypoint: "main.js",
        summary: "broken build",
      },
      criteria: NO_CRITERIA,
    });

    assert.equal(result.passed, false);
    assert.match(result.failureReport, /Step 'build' failed/);
    assert.ok(
      !result.steps.some((step) => step.name === "run"),
      "a failed build must short-circuit before running",
    );
  });
});
