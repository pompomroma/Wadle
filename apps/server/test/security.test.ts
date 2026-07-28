import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, before, describe, it } from "node:test";
import { cleanup, useTemporaryDataDir } from "./helpers/harness.js";

/**
 * Path-traversal defences.
 *
 * Both the model and uploaded archives supply file paths, so both are untrusted
 * input. A generated `"path": "../../etc/passwd"` or a zip entry escaping its
 * extraction root must be refused, not written.
 */

let dataDir: string;
let project: typeof import("../src/agent/project.js");
let archive: typeof import("../src/formats/archive.js");
let exec: typeof import("../src/sandbox/exec.js");
let workspacesDir: string;

before(async () => {
  dataDir = await useTemporaryDataDir();
  const [projectModule, archiveModule, execModule, envModule] = await Promise.all([
    import("../src/agent/project.js"),
    import("../src/formats/archive.js"),
    import("../src/sandbox/exec.js"),
    import("../src/config/env.js"),
  ]);
  project = projectModule;
  archive = archiveModule;
  exec = execModule;
  workspacesDir = envModule.env.workspacesDir;
  await mkdir(workspacesDir, { recursive: true });
});

after(async () => cleanup(dataDir));

describe("model-supplied file paths", () => {
  it("refuses paths that escape the project directory", async () => {
    const projectDir = join(workspacesDir, "ws_escape", "product");
    await mkdir(projectDir, { recursive: true });

    for (const candidate of [
      "../../etc/passwd",
      "../outside.txt",
      "/etc/passwd",
      "a/../../../../tmp/pwned",
      "..",
    ]) {
      assert.throws(
        () => project.resolveProjectPath(projectDir, candidate),
        /outside the project|Invalid file path|workspace root/,
        `'${candidate}' should have been refused`,
      );
    }
  });

  it("accepts ordinary nested paths", () => {
    const projectDir = join(workspacesDir, "ws_escape", "product");
    const resolved = project.resolveProjectPath(projectDir, "src/lib/util.ts");
    assert.ok(resolved.startsWith(projectDir));
    assert.ok(resolved.endsWith("src/lib/util.ts"));
  });

  it("reports rejected writes instead of silently skipping them", async () => {
    const projectDir = join(workspacesDir, "ws_reject", "product");
    await mkdir(projectDir, { recursive: true });

    const result = await project.applyFileOperations(projectDir, [
      { path: "good.txt", action: "write", contents: "kept" },
      { path: "../../escaped.txt", action: "write", contents: "should not exist" },
      { path: "no-contents.txt", action: "write" },
    ]);

    assert.deepEqual(result.written, ["good.txt"]);
    assert.equal(result.rejected.length, 2);
    assert.ok(result.rejected.some((r) => r.includes("escaped.txt")));
    assert.ok(result.rejected.some((r) => r.includes("no-contents.txt")));
    assert.equal(
      existsSync(join(workspacesDir, "ws_reject", "escaped.txt")),
      false,
      "the escaping write must not have landed anywhere",
    );
  });

  it("refuses to run a command outside the workspace root", () => {
    assert.throws(
      () => exec.assertInsideWorkspaceRoot("/etc"),
      /outside the workspace root/,
    );
    assert.doesNotThrow(() =>
      exec.assertInsideWorkspaceRoot(join(workspacesDir, "ws_ok", "product")),
    );
  });
});

describe("archive extraction", () => {
  it("refuses a zip entry that escapes the destination (zip slip)", async () => {
    const scratch = join(tmpdir(), `wadle-zipslip-${Date.now()}`);
    await mkdir(scratch, { recursive: true });
    const zipPath = join(scratch, "evil.zip");

    // yazl refuses to *build* a traversing entry, which is correct of it — so
    // the malicious archive is assembled byte by byte, exactly as a real
    // attacker's would be.
    await writeFile(zipPath, craftTraversingZip("../../escaped.txt", "owned"));

    const destination = join(scratch, "extract-here");
    await mkdir(destination, { recursive: true });

    // Two layers stop this: yauzl validates entry names itself, and `safeJoin`
    // re-checks the resolved path. Either rejection is acceptable — what must
    // never happen is the file landing outside the destination.
    await assert.rejects(
      () => archive.extractZip(zipPath, destination),
      /escapes the destination directory|invalid relative path/,
    );
    assert.equal(
      existsSync(join(scratch, "escaped.txt")),
      false,
      "the traversing entry must not have been written",
    );

    await rm(scratch, { recursive: true, force: true });
  });

  it("has its own entry-path guard, independent of the zip library's", () => {
    // yauzl rejects most traversing names before extraction reaches this, so
    // the guard is exercised directly rather than through a crafted archive —
    // testing it via yauzl would only prove yauzl works.
    const root = "/tmp/wadle-extract-root";
    for (const hostile of [
      "../escaped.txt",
      "../../escaped.txt",
      "..\\..\\escaped.txt",
      "nested/../../escaped.txt",
      "/absolute/escaped.txt".replace("/absolute", ".."),
    ]) {
      assert.throws(
        () => archive.safeJoin(root, hostile),
        /escapes the destination directory/,
        `'${hostile}' should have been refused`,
      );
    }

    // Leading slashes are stripped (archives often store them), and ordinary
    // nested paths still resolve inside the root.
    assert.equal(archive.safeJoin(root, "/readme.md"), `${root}/readme.md`);
    assert.equal(archive.safeJoin(root, "a/b/c.txt"), `${root}/a/b/c.txt`);
  });

  it("round-trips a real archive: unpack, edit, repack", async () => {
    const scratch = join(tmpdir(), `wadle-ziprt-${Date.now()}`);
    const source = join(scratch, "src");
    await mkdir(join(source, "nested"), { recursive: true });
    await writeFile(join(source, "readme.md"), "# original\n", "utf8");
    await writeFile(join(source, "nested", "data.json"), '{"value":1}\n', "utf8");

    const zipPath = join(scratch, "bundle.zip");
    const count = await archive.zipDirectory(source, zipPath);
    assert.equal(count, 2);

    const entries = await archive.listZip(zipPath);
    assert.deepEqual(
      entries.map((e) => e.path).sort(),
      ["nested/data.json", "readme.md"],
    );

    // Unpack, change something real, repack.
    const unpacked = join(scratch, "unpacked");
    await mkdir(unpacked, { recursive: true });
    await archive.extractZip(zipPath, unpacked);
    await writeFile(join(unpacked, "readme.md"), "# edited by wadle\n", "utf8");

    const repacked = join(scratch, "bundle2.zip");
    await archive.zipDirectory(unpacked, repacked);

    const verified = join(scratch, "verify");
    await mkdir(verified, { recursive: true });
    await archive.extractZip(repacked, verified);

    assert.equal(
      await readFile(join(verified, "readme.md"), "utf8"),
      "# edited by wadle\n",
      "the edit must survive the round-trip",
    );
    assert.equal(
      await readFile(join(verified, "nested", "data.json"), "utf8"),
      '{"value":1}\n',
      "untouched files must survive unchanged",
    );

    await rm(scratch, { recursive: true, force: true });
  });
});

/**
 * Assemble a minimal, structurally valid ZIP containing a single stored entry
 * whose name traverses out of the extraction root.
 */
function craftTraversingZip(entryName: string, contents: string): Buffer {
  const name = Buffer.from(entryName, "utf8");
  const data = Buffer.from(contents, "utf8");
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // local file header signature
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(0, 8); // method: stored
  local.writeUInt16LE(0, 10); // time
  local.writeUInt16LE(0, 12); // date
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); // central directory signature
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30); // extra
  central.writeUInt16LE(0, 32); // comment
  central.writeUInt16LE(0, 34); // disk
  central.writeUInt16LE(0, 36); // internal attrs
  central.writeUInt32LE(0, 38); // external attrs
  central.writeUInt32LE(0, 42); // offset of local header

  const centralSize = central.length + name.length;
  const centralOffset = local.length + name.length + data.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([local, name, data, central, name, eocd]);
}

function crc32(buffer: Buffer): number {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (~crc) >>> 0;
}

describe("sandbox environment", () => {
  it("does not leak host secrets into generated code", async () => {
    process.env["NVIDIA_API_KEY"] = "nvapi-should-never-be-visible";
    const projectDir = join(workspacesDir, "ws_env", "product");
    await mkdir(projectDir, { recursive: true });

    const result = await exec.run({
      cwd: projectDir,
      command: "env",
      shell: true,
      allowNetwork: false,
      timeoutMs: 15_000,
    });

    assert.equal(result.code, 0);
    assert.ok(
      !result.stdout.includes("nvapi-should-never-be-visible"),
      "the model credential must not be inherited by sandboxed processes",
    );
    assert.ok(
      !/NVIDIA_API_KEY/.test(result.stdout),
      "the credential variable must not be present at all",
    );
  });

  it("kills a command that exceeds its wall-clock timeout", async () => {
    const projectDir = join(workspacesDir, "ws_timeout", "product");
    await mkdir(projectDir, { recursive: true });

    const result = await exec.run({
      cwd: projectDir,
      command: "sleep 30",
      shell: true,
      allowNetwork: false,
      timeoutMs: 1500,
    });

    assert.equal(result.timedOut, true);
    assert.match(result.stderr, /wall-clock timeout/);
    assert.ok(result.durationMs < 12_000, "should not have waited the full 30s");
  });
});
