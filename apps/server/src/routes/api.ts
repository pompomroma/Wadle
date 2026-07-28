import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { nanoid } from "nanoid";
import { readManifest, restoreSnapshot } from "../agent/project.js";
import { env, hasModelCredentials } from "../config/env.js";
import { MODEL_SPEC, PERFORMANCE_TOPS } from "../config/model.js";
import * as store from "../db/store.js";
import { zipDirectory } from "../formats/archive.js";
import { conversionTargetsFor } from "../formats/convert.js";
import { inspectFile } from "../formats/inspect.js";
import { sniffFile } from "../formats/sniff.js";
import { toolboxCapabilities } from "../formats/toolbox.js";
import { probeCapabilities } from "../sandbox/capabilities.js";
import * as preview from "../runtime/preview.js";
import * as queue from "../runtime/queue.js";

const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

function requireWorkspace(id: string) {
  const workspace = store.getWorkspace(id);
  if (!workspace) {
    const error = new Error(`No workspace with id '${id}'.`) as Error & {
      statusCode?: number;
    };
    error.statusCode = 404;
    throw error;
  }
  return workspace;
}

export async function registerApi(app: FastifyInstance): Promise<void> {
  /* ----------------------------- meta ----------------------------- */

  app.get("/api/health", async () => ({ ok: true, uptime: process.uptime() }));

  app.get("/api/model", async () => {
    const [capabilities, toolbox] = await Promise.all([
      probeCapabilities(),
      toolboxCapabilities(),
    ]);
    return {
      model: {
        ...MODEL_SPEC,
        endpoint: env.llm.baseUrl,
        configuredModel: env.llm.model,
        credentialsPresent: hasModelCredentials(),
        /**
         * See config/model.ts — no TOPS figure is published for Claude Opus 5
         * or any language model, so this is a configured constant rather than a
         * derived one, and it is labelled as such in the UI.
         */
        performanceTops: PERFORMANCE_TOPS,
        performanceTopsNote:
          "Configured display value. TOPS is a hardware metric for accelerators; " +
          "no language model, including Claude Opus 5, publishes one. Set " +
          "PERFORMANCE_TOPS in apps/server/src/config/model.ts to change it.",
      },
      limits: {
        credits: "none — Wadle applies no quota, metering or paywall of its own",
        billing: "none — the app charges nothing for usage",
        upstream:
          "Rate limits, if any, come from the configured model provider. Point " +
          "LLM_BASE_URL at a local model for a path with no provider limits.",
        agent: env.agent,
      },
      capabilities,
      toolbox,
    };
  });

  /* -------------------------- workspaces -------------------------- */

  app.get("/api/workspaces", async () =>
    store.listWorkspaces().map((workspace) => ({
      ...workspace,
      running: queue.isRunning(workspace.id),
    })),
  );

  app.post<{ Body: { name?: string } }>("/api/workspaces", async (request) => {
    const workspace = store.createWorkspace(request.body?.name ?? "New workspace");
    store.appendEvent({
      workspaceId: workspace.id,
      phase: "queue",
      message: "Workspace created.",
    });
    return workspace;
  });

  app.get<{ Params: { id: string } }>(
    "/api/workspaces/:id",
    async (request) => {
      const workspace = requireWorkspace(request.params.id);
      const projectDir = store.workspaceDir(workspace.id);
      return {
        workspace,
        running: queue.isRunning(workspace.id),
        requests: store.listRequests(workspace.id).map((row) => ({
          ...row,
          criteria: store.listCriteria(row.id),
        })),
        revisions: store.listRevisions(workspace.id),
        artifacts: store.listArtifacts(workspace.id),
        manifest: await readManifest(projectDir),
        preview: preview.previewFor(workspace.id),
      };
    },
  );

  app.patch<{ Params: { id: string }; Body: { name: string } }>(
    "/api/workspaces/:id",
    async (request) => {
      requireWorkspace(request.params.id);
      store.renameWorkspace(request.params.id, request.body.name);
      return store.getWorkspace(request.params.id);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/workspaces/:id",
    async (request) => {
      requireWorkspace(request.params.id);
      queue.cancel(request.params.id);
      await preview.stopPreview(request.params.id);
      store.deleteWorkspace(request.params.id);
      return { deleted: true };
    },
  );

  /* --------------------------- requests --------------------------- */

  /**
   * Submit a request, optionally with files attached.
   *
   * Requests stack — posting while one is building queues the new one behind
   * it, and it will be applied to whatever the previous request produced.
   */
  app.post<{ Params: { id: string } }>(
    "/api/workspaces/:id/requests",
    async (request, reply) => {
      const workspace = requireWorkspace(request.params.id);

      let prompt = "";
      let kind: "build" | "adjust" | "convert" = "build";
      let targetFormat: string | null = null;
      const staged: Array<{ filename: string; path: string; size: number }> = [];

      const uploadDir = join(env.workspacesDir, workspace.id, "uploads");
      await mkdir(uploadDir, { recursive: true });

      for await (const part of request.parts()) {
        if (part.type === "file") {
          const safeName = basename(part.filename || `upload-${nanoid(6)}`);
          const target = join(uploadDir, `${nanoid(8)}-${safeName}`);
          await pipeline(part.file, (await import("node:fs")).createWriteStream(target));
          if (part.file.truncated) {
            return reply.status(413).send({
              error: `'${safeName}' exceeds the ${MAX_UPLOAD_BYTES / 1024 / 1024} MB upload limit.`,
            });
          }
          const info = await stat(target);
          staged.push({ filename: safeName, path: target, size: info.size });
        } else if (part.fieldname === "prompt") {
          prompt = String(part.value ?? "");
        } else if (part.fieldname === "kind") {
          const value = String(part.value ?? "");
          if (value === "build" || value === "adjust" || value === "convert") {
            kind = value;
          }
        } else if (part.fieldname === "targetFormat") {
          const value = String(part.value ?? "").trim();
          targetFormat = value || null;
        }
      }

      if (!prompt.trim() && kind !== "convert") {
        return reply.status(400).send({ error: "A request needs a prompt." });
      }

      // An existing product means this is an adjustment, whatever the client said.
      const manifest = await readManifest(store.workspaceDir(workspace.id));
      if (manifest && kind === "build") kind = "adjust";

      const created = store.createRequest({
        workspaceId: workspace.id,
        prompt: prompt.trim() || `Convert the attached file to ${targetFormat}`,
        kind,
        targetFormat,
      });

      for (const file of staged) {
        const info = await sniffFile(file.path).catch(() => null);
        store.createArtifact({
          workspaceId: workspace.id,
          requestId: created.id,
          kind: "upload",
          filename: file.filename,
          mime: info?.mime ?? "application/octet-stream",
          size: file.size,
          path: file.path,
          meta: info,
        });
      }

      const position = store
        .listRequests(workspace.id)
        .filter((row) => row.status === "queued").length;

      store.appendEvent({
        workspaceId: workspace.id,
        requestId: created.id,
        phase: "queue",
        message:
          position > 1
            ? `Queued behind ${position - 1} other request(s); it will be applied to whatever they produce.`
            : "Queued.",
      });

      queue.schedule(workspace.id);
      return reply.status(202).send({ request: created, queuePosition: position });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/workspaces/:id/cancel",
    async (request) => {
      requireWorkspace(request.params.id);
      return { cancelled: queue.cancel(request.params.id) };
    },
  );

  /* ---------------------------- events ---------------------------- */

  app.get<{ Params: { id: string }; Querystring: { since?: string } }>(
    "/api/workspaces/:id/events",
    async (request) => {
      requireWorkspace(request.params.id);
      const since = Number(request.query.since ?? 0);
      return store.listEvents(request.params.id, Number.isFinite(since) ? since : 0);
    },
  );

  /** Server-sent events: the live build log. */
  app.get<{ Params: { id: string }; Querystring: { since?: string } }>(
    "/api/workspaces/:id/stream",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = request.params as { id: string };
      requireWorkspace(params.id);

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      let cursor = Number((request.query as { since?: string }).since ?? 0);
      if (!Number.isFinite(cursor)) cursor = 0;
      let closed = false;

      const send = (event: string, data: unknown) => {
        if (closed) return;
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      const flush = () => {
        const events = store.listEvents(params.id, cursor);
        for (const item of events) {
          cursor = item.id;
          send("log", item);
        }
        const workspace = store.getWorkspace(params.id);
        if (workspace) {
          send("state", {
            running: queue.isRunning(params.id),
            requests: store.listRequests(params.id),
            currentRevisionId: workspace.current_revision_id,
          });
        }
      };

      flush();
      const timer = setInterval(flush, 700);
      const heartbeat = setInterval(() => {
        if (!closed) reply.raw.write(": keep-alive\n\n");
      }, 20_000);

      request.raw.on("close", () => {
        closed = true;
        clearInterval(timer);
        clearInterval(heartbeat);
      });

      return reply;
    },
  );

  /* --------------------------- artifacts --------------------------- */

  app.get<{ Params: { id: string } }>(
    "/api/artifacts/:id/download",
    async (request, reply) => {
      const artifact = store.getArtifact(request.params.id);
      if (!artifact) return reply.status(404).send({ error: "No such artifact." });
      const info = await stat(artifact.path).catch(() => null);
      if (!info) {
        return reply
          .status(410)
          .send({ error: "This artifact is no longer on disk." });
      }
      reply
        .header("Content-Type", artifact.mime)
        .header("Content-Length", String(info.size))
        .header(
          "Content-Disposition",
          `attachment; filename="${artifact.filename.replace(/"/g, "")}"`,
        );
      return reply.send(createReadStream(artifact.path));
    },
  );

  /** Package the current product as a downloadable zip. */
  app.get<{ Params: { id: string } }>(
    "/api/workspaces/:id/download",
    async (request, reply) => {
      const workspace = requireWorkspace(request.params.id);
      const projectDir = store.workspaceDir(workspace.id);
      const manifest = await readManifest(projectDir);
      if (!manifest) {
        return reply
          .status(409)
          .send({ error: "This workspace has no built product yet." });
      }

      await mkdir(env.artifactsDir, { recursive: true });
      const safeName = workspace.name.replace(/[^\w.-]+/g, "-").slice(0, 40) || "product";
      const outputPath = join(env.artifactsDir, `${safeName}-${nanoid(6)}.zip`);
      const fileCount = await zipDirectory(projectDir, outputPath);
      const info = await stat(outputPath);

      const artifact = store.createArtifact({
        workspaceId: workspace.id,
        revisionId: workspace.current_revision_id,
        kind: "product",
        filename: `${safeName}.zip`,
        mime: "application/zip",
        size: info.size,
        path: outputPath,
        meta: { fileCount, entrypoint: manifest.entrypoint },
      });

      return { artifact, downloadUrl: `/api/artifacts/${artifact.id}/download` };
    },
  );

  /* --------------------------- revisions --------------------------- */

  app.post<{ Params: { id: string } }>(
    "/api/revisions/:id/restore",
    async (request, reply) => {
      const revision = store.getRevision(request.params.id);
      if (!revision) return reply.status(404).send({ error: "No such revision." });
      if (queue.isRunning(revision.workspace_id)) {
        return reply.status(409).send({
          error: "A build is in progress in this workspace; cancel it before restoring.",
        });
      }
      await restoreSnapshot(
        revision.snapshot_dir,
        store.workspaceDir(revision.workspace_id),
      );
      store.setCurrentRevision(revision.workspace_id, revision.id);
      store.appendEvent({
        workspaceId: revision.workspace_id,
        phase: "queue",
        message: `Restored revision #${revision.seq}: ${revision.summary}`,
      });
      return { restored: revision.id };
    },
  );

  /* ---------------------------- preview ---------------------------- */

  app.post<{ Params: { id: string } }>(
    "/api/workspaces/:id/preview",
    async (request, reply) => {
      requireWorkspace(request.params.id);
      try {
        return await preview.startPreview(request.params.id);
      } catch (error) {
        return reply.status(409).send({ error: (error as Error).message });
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/workspaces/:id/preview",
    async (request) => {
      requireWorkspace(request.params.id);
      await preview.stopPreview(request.params.id);
      return { stopped: true };
    },
  );

  /* ---------------------------- inspect ---------------------------- */

  /** Inspect a file without starting a build — used by the upload preview. */
  app.post("/api/inspect", async (request, reply) => {
    const file = await request.file();
    if (!file) return reply.status(400).send({ error: "No file was uploaded." });

    await mkdir(env.artifactsDir, { recursive: true });
    const target = join(
      env.artifactsDir,
      `inspect-${nanoid(8)}${extname(file.filename || "")}`,
    );
    await writeFile(target, await file.toBuffer());

    try {
      const report = await inspectFile(target);
      return {
        ...report,
        filename: basename(file.filename || report.filename),
        conversionTargets: conversionTargetsFor(report.format),
      };
    } catch (error) {
      return reply.status(422).send({ error: (error as Error).message });
    }
  });
}
