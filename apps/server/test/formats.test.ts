import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, before, describe, it } from "node:test";
import { cleanup, useTemporaryDataDir } from "./helpers/harness.js";

let dataDir: string;
let scratch: string;
let data: typeof import("../src/formats/data.js");
let convert: typeof import("../src/formats/convert.js");
let sniff: typeof import("../src/formats/sniff.js");
let toolbox: typeof import("../src/formats/toolbox.js");

before(async () => {
  dataDir = await useTemporaryDataDir();
  scratch = join(tmpdir(), `wadle-formats-${Date.now()}`);
  await mkdir(scratch, { recursive: true });
  [data, convert, sniff, toolbox] = await Promise.all([
    import("../src/formats/data.js"),
    import("../src/formats/convert.js"),
    import("../src/formats/sniff.js"),
    import("../src/formats/toolbox.js"),
  ]);
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
  await cleanup(dataDir);
});

const SAMPLE_INI = `# app settings
[server]
host = 127.0.0.1
port = 8080
debug = true

[limits]
max_users = 500
`;

describe("structured data conversion", () => {
  it("round-trips INI → JSON → YAML → TOML → JSON without losing values", () => {
    const json = data.convertData(SAMPLE_INI, "ini", "json");
    const parsed = JSON.parse(json) as Record<string, Record<string, unknown>>;
    assert.equal(parsed["server"]?.["host"], "127.0.0.1");
    assert.equal(parsed["server"]?.["port"], 8080, "numbers should be coerced");
    assert.equal(parsed["server"]?.["debug"], true, "booleans should be coerced");
    assert.equal(parsed["limits"]?.["max_users"], 500);

    const yaml = data.convertData(json, "json", "yaml");
    const toml = data.convertData(yaml, "yaml", "toml");
    const back = JSON.parse(data.convertData(toml, "toml", "json")) as typeof parsed;

    assert.deepEqual(back, parsed, "the value graph must survive the full trip");
  });

  it("round-trips back to INI", () => {
    const json = data.convertData(SAMPLE_INI, "ini", "json");
    const ini = data.convertData(json, "json", "ini");
    const reparsed = JSON.parse(data.convertData(ini, "ini", "json"));
    assert.deepEqual(reparsed, JSON.parse(json));
  });

  it("raises rather than silently flattening what INI cannot express", () => {
    const nested = JSON.stringify({ a: { b: { c: 1 } } });
    assert.throws(
      () => data.convertData(nested, "json", "ini"),
      /one level of sections/,
      "deep nesting must be reported, not quietly dropped",
    );

    const withArray = JSON.stringify({ items: [1, 2, 3] });
    assert.throws(
      () => data.convertData(withArray, "json", "ini"),
      /no array syntax/,
    );
  });

  it("handles CSV with quoted fields, embedded commas and newlines", () => {
    const csv = 'name,note\n"Smith, John","line one\nline two"\nplain,ok\n';
    const rows = data.parseDelimited(csv, ",");
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.["name"], "Smith, John");
    assert.equal(rows[0]?.["note"], "line one\nline two");
    assert.equal(rows[1]?.["name"], "plain");

    // Re-serialising must round-trip through the parser.
    const again = data.parseDelimited(
      data.stringifyDelimited(rows, ","),
      ",",
    );
    assert.deepEqual(again, rows);
  });

  it("reports invalid input against the format it was told to parse", () => {
    assert.throws(
      () => data.convertData("{not json at all", "json", "yaml"),
      /not valid JSON/,
    );
  });
});

describe("the conversion router", () => {
  it("routes data → data mechanically", async () => {
    const info = sniff.sniffBuffer(Buffer.from(SAMPLE_INI), "app.ini");
    const route = convert.planConversion(info, "json");
    assert.equal(route.kind, "mechanical");
    assert.equal(route.kind === "mechanical" && route.via, "data");
  });

  it("routes .ini → .exe to the generative path, not a rename", async () => {
    const info = sniff.sniffBuffer(Buffer.from(SAMPLE_INI), "app.ini");
    const route = convert.planConversion(info, "exe");
    assert.equal(route.kind, "generative");
    assert.match(
      route.kind === "generative" ? route.description : "",
      /no byte-level conversion/i,
      "the user must be told plainly why this is not a byte conversion",
    );
    assert.match(
      route.kind === "generative" ? route.brief : "",
      /must run and produce real output/i,
    );
  });

  it("refuses to claim a compiled binary can become an unrelated format", async () => {
    const pe = Buffer.alloc(64);
    pe.write("MZ", 0);
    const info = sniff.sniffBuffer(pe, "game.exe");
    assert.equal(info.format, "pe");

    const route = convert.planConversion(info, "docx");
    assert.equal(route.kind, "refuse");
    assert.match(
      route.kind === "refuse" ? route.reason : "",
      /cannot be decompiled back into editable source/i,
    );
  });

  it("actually performs a mechanical conversion on disk", async () => {
    const source = join(scratch, "settings.ini");
    await writeFile(source, SAMPLE_INI, "utf8");

    const outcome = await convert.runMechanicalConversion(source, "yaml", scratch);
    const produced = await readFile(outcome.outputPath, "utf8");

    assert.match(produced, /host: 127\.0\.0\.1/);
    assert.match(produced, /max_users: 500/);
    assert.notEqual(
      produced,
      SAMPLE_INI,
      "the output must be genuinely converted, not the input copied",
    );
  });
});

describe("format sniffing", () => {
  it("identifies by content, not by extension", () => {
    // A zip archive that lies about being an executable.
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    const info = sniff.sniffBuffer(zip, "totally-an.exe");
    assert.equal(info.format, "zip", "content must win over the extension");
    assert.equal(info.tier, "round-trip");
  });

  it("recognises a GBA ROM by its Nintendo logo, not its name", () => {
    const rom = Buffer.alloc(256);
    Buffer.from([0x24, 0xff, 0xae, 0x51, 0x69, 0x9a]).copy(rom, 4);
    const info = sniff.sniffBuffer(rom, "mystery.bin");
    assert.equal(info.format, "gba");
    assert.equal(info.tier, "inspect-patch");
  });

  it("admits when it does not recognise a binary", () => {
    const noise = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x99, 0x00]);
    const info = sniff.sniffBuffer(noise, "unknown.dat");
    assert.equal(info.format, "binary");
    assert.equal(info.tier, "inspect-only");
    assert.match(info.capability, /will not\s+claim to modify/i);
  });
});

describe("the binary toolbox bridge", () => {
  it("reports its real capabilities", async () => {
    const capabilities = await toolbox.toolboxCapabilities();
    assert.ok(!("available" in capabilities), "python3 should be reachable");
    if ("available" in capabilities) return;
    assert.match(capabilities.python, /^3\./);
    assert.equal(capabilities.formats["gba"]?.["patchHeader"], true);
    assert.equal(capabilities.formats["patches"]?.["bps"], true);
  });

  it("returns a structured failure for a file that is not a PE", async () => {
    const notAnExe = join(scratch, "not-an.exe");
    await writeFile(notAnExe, "just some text", "utf8");

    const result = await toolbox.callToolbox("pe.inspect", { path: notAnExe });
    assert.equal(result.ok, false);
    assert.match(
      result.ok === false ? result.error : "",
      /Not a PE file/,
      "a handling failure must be reported, not thrown as a crash",
    );
  });

  it("patches a real GBA header end to end and keeps the checksum valid", async () => {
    // Build a genuine ROM with the fixture generator the Python tests use.
    const romPath = join(scratch, "test.gba");
    const build = await toolbox.callToolbox("gba.header", { path: romPath });
    assert.equal(build.ok, false, "the ROM does not exist yet");

    const rom = Buffer.alloc(0x8000);
    rom.writeUInt32LE(0xea00002e, 0);
    Buffer.from([0x24, 0xff, 0xae, 0x51, 0x69, 0x9a]).copy(rom, 4);
    Buffer.from("WADLETEST\0\0\0", "ascii").copy(rom, 0xa0);
    Buffer.from("AWDE", "ascii").copy(rom, 0xac);
    Buffer.from("01", "ascii").copy(rom, 0xb0);
    rom[0xb2] = 0x96;
    let sum = 0;
    for (let i = 0xa0; i < 0xbd; i += 1) sum = (sum - (rom[i] ?? 0)) & 0xff;
    rom[0xbd] = (sum - 0x19) & 0xff;
    await writeFile(romPath, rom);

    const before = await toolbox.callToolbox<{
      title: string;
      headerChecksumValid: boolean;
    }>("gba.header", { path: romPath });
    assert.equal(before.ok, true);
    assert.equal(before.ok && before.title, "WADLETEST");
    assert.equal(before.ok && before.headerChecksumValid, true);

    const patchedPath = join(scratch, "patched.gba");
    const patched = await toolbox.callToolbox("gba.patchHeader", {
      path: romPath,
      out: patchedPath,
      title: "WADLEHACK",
      version: 7,
    });
    assert.equal(patched.ok, true);

    const after = await toolbox.callToolbox<{
      title: string;
      version: number;
      headerChecksumValid: boolean;
    }>("gba.header", { path: patchedPath });
    assert.equal(after.ok && after.title, "WADLEHACK");
    assert.equal(after.ok && after.version, 7);
    assert.equal(
      after.ok && after.headerChecksumValid,
      true,
      "the complement check must be recomputed so the ROM still boots",
    );
  });

  it("creates and applies a patch that reproduces the modified ROM exactly", async () => {
    const original = join(scratch, "test.gba");
    const modified = join(scratch, "patched.gba");
    const patchFile = join(scratch, "change.bps");
    const rebuilt = join(scratch, "rebuilt.gba");

    const created = await toolbox.callToolbox<{ size: number }>("patch.create", {
      original,
      modified,
      out: patchFile,
      format: "bps",
    });
    assert.equal(created.ok, true);

    const applied = await toolbox.callToolbox("patch.apply", {
      original,
      patch: patchFile,
      out: rebuilt,
    });
    assert.equal(applied.ok, true);

    const [expected, actual] = await Promise.all([
      readFile(modified),
      readFile(rebuilt),
    ]);
    assert.deepEqual(actual, expected, "the patch must reproduce the ROM byte for byte");
  });
});
