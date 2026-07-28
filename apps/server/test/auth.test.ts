import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { cleanup, useTemporaryDataDir } from "./helpers/harness.js";

/**
 * The access gate.
 *
 * Wadle executes model-generated code, so the invariant under test is that an
 * instance which is reachable beyond the local machine is never also open.
 * A regression here turns Wadle into an unauthenticated remote-code-execution
 * endpoint, so it is checked rather than assumed.
 */

let dataDir: string;

let auth: typeof import("../src/auth.js");

before(async () => {
  dataDir = await useTemporaryDataDir();
  auth = await import("../src/auth.js");
});

after(async () => {
  delete process.env["WADLE_AUTH_TOKEN"];
  process.env["HOST"] = "127.0.0.1";
  await cleanup(dataDir);
});

describe("access gate", () => {
  it("is open on loopback with no token configured", () => {
    const state = auth.resolveAuth({
      tunnelEnabled: false,
      host: "127.0.0.1",
      configuredToken: "",
    });
    assert.equal(state.required, false);
    assert.match(state.reason, /loopback/);
  });

  it("REQUIRES a token when bound to a non-loopback address", () => {
    const state = auth.resolveAuth({
      tunnelEnabled: false,
      host: "0.0.0.0",
      configuredToken: "",
    });
    assert.equal(
      state.required,
      true,
      "binding publicly must never leave the instance open",
    );
    assert.ok(state.token.length >= 24, "a usable token must be generated");
    assert.match(state.reason, /reachable beyond this machine/);

    for (const host of ["192.168.1.10", "10.0.0.5", "0.0.0.0", "wadle.example.com"]) {
      assert.equal(
        auth.resolveAuth({ tunnelEnabled: false, host, configuredToken: "" })
          .required,
        true,
        `${host} must be gated`,
      );
    }
  });

  it("REQUIRES a token whenever a tunnel is enabled, even on loopback", () => {
    const state = auth.resolveAuth({
      tunnelEnabled: true,
      host: "127.0.0.1",
      configuredToken: "",
    });
    assert.equal(
      state.required,
      true,
      "a tunnel publishes the instance, so the gate must be on",
    );
    assert.match(state.reason, /tunnel/);
  });

  it("honours an explicitly configured token even on loopback", () => {
    const state = auth.resolveAuth({
      tunnelEnabled: false,
      host: "127.0.0.1",
      configuredToken: "explicitly-chosen-token-value",
    });
    assert.equal(state.required, true);
    assert.equal(state.token, "explicitly-chosen-token-value");
  });

  it("stays gated on a reachable instance unless the override is explicit", () => {
    // Without the override, exposure always gates.
    assert.equal(
      auth.resolveAuth({
        tunnelEnabled: true,
        host: "127.0.0.1",
        configuredToken: "",
        allowOpen: false,
      }).required,
      true,
    );
  });

  it("allows the gate to be switched off deliberately, and flags it", () => {
    const state = auth.resolveAuth({
      tunnelEnabled: true,
      host: "0.0.0.0",
      configuredToken: "",
      allowOpen: true,
    });
    assert.equal(state.required, false, "the operator opted out explicitly");
    assert.equal(
      state.overridden,
      true,
      "the override must be flagged so startup can shout about it",
    );
    assert.match(state.reason, /deliberately off/);
  });

  it("keeps an explicitly configured token even when the override is set", () => {
    const state = auth.resolveAuth({
      tunnelEnabled: true,
      host: "0.0.0.0",
      configuredToken: "a-real-token",
      allowOpen: true,
    });
    assert.equal(
      state.required,
      true,
      "setting a token is a clearer signal than the override, so it wins",
    );
    assert.equal(state.token, "a-real-token");
  });

  it("never opens a loopback-only instance via the override", () => {
    const state = auth.resolveAuth({
      tunnelEnabled: false,
      host: "127.0.0.1",
      configuredToken: "",
      allowOpen: true,
    });
    assert.equal(state.required, false);
    assert.notEqual(
      state.overridden,
      true,
      "loopback was already open; this is not an override of anything",
    );
  });

  it("classifies loopback addresses correctly", () => {
    for (const host of ["127.0.0.1", "localhost", "::1", "127.0.0.53"]) {
      assert.equal(auth.isLoopbackHost(host), true, `${host} is loopback`);
    }
    for (const host of ["0.0.0.0", "192.168.1.10", "10.0.0.5", "example.com"]) {
      assert.equal(auth.isLoopbackHost(host), false, `${host} is not loopback`);
    }
  });
});
