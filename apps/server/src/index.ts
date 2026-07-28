import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { env, hasModelCredentials } from "./config/env.js";
import { MODEL_SPEC } from "./config/model.js";
import { closeDb, getDb } from "./db/index.js";
import { registerAuth, resolveAuth } from "./auth.js";
import { registerApi } from "./routes/api.js";
import { probeCapabilities } from "./sandbox/capabilities.js";
import * as preview from "./runtime/preview.js";
import * as queue from "./runtime/queue.js";
import { startTunnel, stopTunnel, tunnelModeFromEnv } from "./runtime/tunnel.js";

const WEB_DIST = resolve(env.root, "apps/web/dist");

async function main(): Promise<void> {
  getDb();

  const app = Fastify({
    logger: { level: process.env["LOG_LEVEL"] ?? "warn" },
    bodyLimit: 32 * 1024 * 1024,
  });

  await app.register(cors, { origin: true });
  await app.register(multipart, {
    limits: { fileSize: 512 * 1024 * 1024, files: 20 },
  });

  // Decide the access gate before anything is served. A tunnel or a
  // non-loopback bind forces a token, so there is no window in which this
  // instance is both reachable and open.
  const tunnelMode = tunnelModeFromEnv();
  const auth = resolveAuth({ tunnelEnabled: tunnelMode !== "none" });
  await registerAuth(app, auth);

  await registerApi(app);

  /**
   * Live product previews.
   *
   * A generated web app is served under /p/<slug>/ so it has a real,
   * shareable-looking URL rather than a bare port number. Requests are
   * forwarded to the sandboxed process actually running the product.
   */
  app.all("/p/:slug", async (request, reply) => reply.redirect(
    `/p/${(request.params as { slug: string }).slug}/`,
    308,
  ));

  app.all("/p/:slug/*", async (request, reply) => {
    const { slug } = request.params as { slug: string; "*": string };
    const target = preview.previewTargetForSlug(slug);
    if (!target) {
      return reply.status(404).type("text/html").send(
        `<!doctype html><meta charset="utf-8"><title>Preview not running</title>
         <body style="font:15px/1.6 system-ui;max-width:38rem;margin:4rem auto;padding:0 1rem">
         <h1>No preview is running here</h1>
         <p>Start the preview from the workspace to bring this product up.</p>`,
      );
    }

    const rest = (request.params as Record<string, string>)["*"] ?? "";
    const query = request.url.includes("?")
      ? request.url.slice(request.url.indexOf("?"))
      : "";
    const upstream = `http://127.0.0.1:${target.port}/${rest}${query}`;

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      if (key === "host" || key === "connection" || value === undefined) continue;
      headers[key] = Array.isArray(value) ? value.join(", ") : String(value);
    }

    try {
      const response = await fetch(upstream, {
        method: request.method,
        headers,
        body: proxyBody(request.method, request.body),
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });

      reply.status(response.status);
      response.headers.forEach((value, key) => {
        if (["content-encoding", "transfer-encoding", "connection"].includes(key)) {
          return;
        }
        reply.header(key, value);
      });
      return reply.send(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      return reply
        .status(502)
        .send({ error: `Preview is not responding: ${(error as Error).message}` });
    }
  });

  // The built web UI, when it exists. In development the Vite dev server
  // serves it instead and proxies /api here.
  if (existsSync(WEB_DIST)) {
    await app.register(fastifyStatic, { root: WEB_DIST, prefix: "/" });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/") || request.url.startsWith("/p/")) {
        return reply.status(404).send({ error: "Not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  const requeued = queue.resumeAfterRestart();
  if (requeued > 0) {
    app.log.warn(`Requeued ${requeued} request(s) interrupted by a restart.`);
  }

  await app.listen({ host: env.host, port: env.port });

  const tunnel = await startTunnel(tunnelMode, env.port);

  const capabilities = await probeCapabilities();
  const availableLanguages = capabilities.languages
    .filter((language) => language.available)
    .map((language) => language.label);

  const localBase = `http://${env.host === "0.0.0.0" ? "localhost" : env.host}:${env.port}`;
  const suffix = auth.required ? `/?t=${auth.token}` : "/";

  const lines = ["", "  Wadle is running.", ""];

  lines.push(`  Open      ${localBase}${suffix}`);
  if (tunnel.url) {
    lines.push(`  Public    ${tunnel.url}${suffix}`);
  }
  lines.push("");

  if (auth.required) {
    lines.push(
      `  Access    token required — ${auth.reason}`,
      `  Token     ${auth.token}`,
      `            stored in ${env.dataDir}/.auth-token`,
      "",
    );
  } else {
    lines.push(
      `  Access    open — ${auth.reason}`,
      `            binding to 0.0.0.0 or enabling a tunnel turns the token gate on automatically`,
      "",
    );
  }

  if (tunnel.error) {
    lines.push(`  Tunnel    ${tunnel.error}`, "");
  }

  lines.push(
    `  Model     ${MODEL_SPEC.displayName} (${env.llm.model})`,
    `  Endpoint  ${env.llm.baseUrl}`,
    `  Key       ${
      hasModelCredentials()
        ? "configured"
        : "MISSING — set NVIDIA_API_KEY in .env, or point LLM_BASE_URL at a local model"
    }`,
    `  Verifies  ${availableLanguages.join(", ") || "nothing — no language toolchains found"}`,
    `  Sandbox   network isolation ${capabilities.networkIsolation ? "available" : "unavailable (run in Docker for a real boundary)"}`,
    "",
    "  No credit system, no metering, no billing.",
    "",
  );

  process.stdout.write(lines.join("\n"));

  const shutdown = async (signal: string) => {
    app.log.warn(`${signal} received; shutting down.`);
    await stopTunnel();
    await preview.stopAllPreviews();
    await app.close();
    closeDb();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

/**
 * Re-serialise a parsed request body for forwarding upstream. Fastify has
 * already consumed and parsed the stream by this point, so the body is an
 * object for JSON requests and a string or buffer otherwise.
 */
function proxyBody(
  method: string,
  body: unknown,
): string | Uint8Array | undefined {
  if (method === "GET" || method === "HEAD") return undefined;
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (Buffer.isBuffer(body)) return new Uint8Array(body);
  return JSON.stringify(body);
}

main().catch((error) => {
  process.stderr.write(`Wadle failed to start: ${(error as Error).stack}\n`);
  process.exit(1);
});
