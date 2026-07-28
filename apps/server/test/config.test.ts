import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEnvValue } from "../src/config/env.js";

/**
 * .env value parsing.
 *
 * A credential is the one setting where a parsing mistake is both silent and
 * expensive. If a stray quote or a trailing comment survives into the value it
 * is sent in the Authorization header verbatim, and the provider answers 403 —
 * which reads exactly like a revoked key and sends you looking in the wrong
 * place. Each case here is a line someone plausibly writes by hand.
 */
describe(".env value parsing", () => {
  it("reads a plain value", () => {
    assert.equal(parseEnvValue("nvapi-abc123"), "nvapi-abc123");
  });

  it("strips an unquoted trailing comment", () => {
    assert.equal(parseEnvValue("nvapi-abc123  # my key"), "nvapi-abc123");
    assert.equal(parseEnvValue("nvapi-abc123\t# work account"), "nvapi-abc123");
  });

  it("keeps a '#' that is part of the value", () => {
    // No whitespace before it, so it is a character in the secret, not a comment.
    assert.equal(parseEnvValue("p4ss#word"), "p4ss#word");
    assert.equal(parseEnvValue("nvapi-ab#cd"), "nvapi-ab#cd");
  });

  it("removes surrounding quotes without eating the contents", () => {
    assert.equal(parseEnvValue('"nvapi-abc123"'), "nvapi-abc123");
    assert.equal(parseEnvValue("'nvapi-abc123'"), "nvapi-abc123");
  });

  it("keeps a '#' inside a quoted value", () => {
    assert.equal(parseEnvValue('"nvapi-abc # still mine"'), "nvapi-abc # still mine");
  });

  it("trims surrounding whitespace", () => {
    assert.equal(parseEnvValue("   nvapi-abc123   "), "nvapi-abc123");
  });

  it("survives CRLF line endings", () => {
    // Windows editors are a common source of an invisible trailing \r.
    assert.equal(parseEnvValue("nvapi-abc123\r"), "nvapi-abc123");
  });

  it("does not mangle a URL containing a fragment", () => {
    assert.equal(
      parseEnvValue("http://localhost:11434/v1#local"),
      "http://localhost:11434/v1#local",
    );
  });

  it("returns empty for an empty assignment", () => {
    assert.equal(parseEnvValue(""), "");
    assert.equal(parseEnvValue("   "), "");
  });

  it("does not treat a lone quote as a quoted value", () => {
    assert.equal(parseEnvValue('"'), '"');
  });
});
