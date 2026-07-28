import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { env } from "./config/env.js";

/**
 * Access control.
 *
 * Wadle executes code written by a language model and serves the results. An
 * instance reachable from the network without a gate is an open remote-code-
 * execution endpoint, so the rule here is deliberately not "off by default":
 *
 *   • bound to loopback, no token configured → open, for local development
 *   • bound to anything else, or a tunnel is on → a token is REQUIRED, and one
 *     is generated automatically if you did not set one
 *
 * You cannot accidentally publish an unauthenticated instance. Setting
 * WADLE_AUTH_TOKEN turns the gate on everywhere, including locally.
 */

const TOKEN_FILE = resolve(env.dataDir, ".auth-token");

export interface AuthState {
  required: boolean;
  token: string;
  /** Why the gate is on or off, shown at startup. */
  reason: string;
}

export function isLoopbackHost(host: string): boolean {
  return (
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "::1" ||
    host.startsWith("127.")
  );
}

/** Read the persisted token, or mint and persist a new one. */
function loadOrCreateToken(): string {
  if (existsSync(TOKEN_FILE)) {
    const existing = readFileSync(TOKEN_FILE, "utf8").trim();
    if (existing.length >= 32) return existing;
  }
  const token = randomBytes(24).toString("base64url");
  mkdirSync(dirname(TOKEN_FILE), { recursive: true });
  writeFileSync(TOKEN_FILE, `${token}\n`, "utf8");
  try {
    chmodSync(TOKEN_FILE, 0o600);
  } catch {
    // Best effort; on some filesystems this is not supported.
  }
  return token;
}

/**
 * Decide whether this instance is gated.
 *
 * `host` and `configuredToken` are parameters rather than reads of
 * module-scoped state so the decision depends only on its inputs — the whole
 * point of this function is that it is auditable.
 */
export function resolveAuth(options: {
  tunnelEnabled: boolean;
  host?: string;
  configuredToken?: string;
}): AuthState {
  const host = options.host ?? env.host;
  const configured = (
    options.configuredToken ??
    process.env["WADLE_AUTH_TOKEN"] ??
    ""
  ).trim();
  const exposed = !isLoopbackHost(host) || options.tunnelEnabled;

  if (configured) {
    return {
      required: true,
      token: configured,
      reason: "WADLE_AUTH_TOKEN is set",
    };
  }

  if (exposed) {
    return {
      required: true,
      token: loadOrCreateToken(),
      reason: options.tunnelEnabled
        ? "a tunnel is enabled, so this instance is reachable from the internet"
        : `bound to ${host}, which is reachable beyond this machine`,
    };
  }

  return {
    required: false,
    token: "",
    reason: "bound to loopback with no token configured",
  };
}

/** Paths that stay open — they reveal nothing and are needed by health checks. */
const OPEN_PATHS = new Set(["/api/health"]);

function extractToken(request: FastifyRequest): string | null {
  const header = request.headers["authorization"];
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    return header.slice(7).trim();
  }

  const custom = request.headers["x-wadle-token"];
  if (typeof custom === "string" && custom) return custom.trim();

  // EventSource cannot set headers, and the shareable link needs to carry the
  // token, so a query parameter is supported too.
  const query = request.query as Record<string, unknown> | undefined;
  const fromQuery = query?.["t"];
  if (typeof fromQuery === "string" && fromQuery) return fromQuery.trim();

  return null;
}

function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, which is itself a leak, so
  // compare padded buffers of equal length.
  if (a.length !== b.length) {
    // Still do a comparison so the work is roughly constant regardless.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

export async function registerAuth(
  app: FastifyInstance,
  auth: AuthState,
): Promise<void> {
  if (!auth.required) return;

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const path = request.url.split("?")[0] ?? "";
    if (OPEN_PATHS.has(path)) return;

    // Static assets for the login-capable UI must load so the token in the
    // URL can be picked up by the front end.
    if (
      path === "/" ||
      path.startsWith("/assets/") ||
      path === "/favicon.ico" ||
      path === "/index.html"
    ) {
      return;
    }

    const provided = extractToken(request);
    if (provided && tokensMatch(provided, auth.token)) return;

    return reply.status(401).send({
      error:
        "This Wadle instance requires an access token. Append ?t=<token> to the " +
        "URL, or send it as an Authorization: Bearer header. The token is printed " +
        "at startup and stored in data/.auth-token.",
    });
  });
}
