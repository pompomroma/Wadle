import { Socket } from "node:net";
import { readManifest } from "../agent/project.js";
import { env } from "../config/env.js";
import * as store from "../db/store.js";
import { startService, type ServiceHandle } from "../sandbox/exec.js";

/**
 * Live preview servers for web products.
 *
 * When a workspace produces something that serves HTTP, it gets a real,
 * clickable URL — that is what "send the link of the product" means for a
 * web-based build. The process runs under the same sandbox limits as
 * verification, on a port from a dedicated range.
 */
const services = new Map<string, ServiceHandle>();

export interface PreviewInfo {
  slug: string;
  port: number;
  url: string;
  status: "running" | "stopped" | "failed" | "starting";
  message?: string;
}

function slugFor(workspaceId: string): string {
  return workspaceId.replace(/^ws_/, "").slice(0, 12).toLowerCase();
}

async function portIsFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = new Socket();
    socket.setTimeout(300);
    socket.once("connect", () => {
      socket.destroy();
      done(false);
    });
    socket.once("error", () => {
      socket.destroy();
      done(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      done(true);
    });
    socket.connect(port, "127.0.0.1");
  });
}

async function allocatePort(): Promise<number> {
  const taken = new Set(store.listPreviews().map((preview) => preview.port));
  for (let port = env.previewPortMin; port <= env.previewPortMax; port += 1) {
    if (taken.has(port)) continue;
    if (await portIsFree(port)) return port;
  }
  throw new Error(
    `No free preview ports in ${env.previewPortMin}-${env.previewPortMax}. Stop an existing preview first.`,
  );
}

function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((done) => {
    const attempt = () => {
      if (Date.now() > deadline) {
        done(false);
        return;
      }
      const socket = new Socket();
      socket.setTimeout(1000);
      socket.once("connect", () => {
        socket.destroy();
        done(true);
      });
      socket.once("error", () => {
        socket.destroy();
        setTimeout(attempt, 300);
      });
      socket.once("timeout", () => {
        socket.destroy();
        setTimeout(attempt, 300);
      });
      socket.connect(port, "127.0.0.1");
    };
    attempt();
  });
}

/** Start (or restart) the preview for a workspace's current product. */
export async function startPreview(workspaceId: string): Promise<PreviewInfo> {
  await stopPreview(workspaceId);

  const projectDir = store.workspaceDir(workspaceId);
  const manifest = await readManifest(projectDir);
  if (!manifest) {
    throw new Error(
      "This workspace has no built product yet, so there is nothing to preview.",
    );
  }
  if (!manifest.port) {
    throw new Error(
      `This product is a ${manifest.kind}, not a web service — it is delivered as a downloadable file rather than a link.`,
    );
  }
  if (!manifest.commands.start) {
    throw new Error("The product has no start command recorded.");
  }

  const port = await allocatePort();
  const slug = slugFor(workspaceId);

  const service = startService({
    cwd: projectDir,
    command: manifest.commands.start,
    env: { PORT: String(port), HOST: "127.0.0.1" },
  });
  services.set(workspaceId, service);

  store.upsertPreview({
    workspace_id: workspaceId,
    slug,
    port,
    command: manifest.commands.start,
    cwd: projectDir,
    status: "starting",
    started_at: Date.now(),
  });

  const ready = await waitForPort(port, 30_000);
  if (!ready) {
    const output = service.output();
    await service.stop();
    services.delete(workspaceId);
    store.upsertPreview({
      workspace_id: workspaceId,
      slug,
      port,
      command: manifest.commands.start,
      cwd: projectDir,
      status: "failed",
      started_at: Date.now(),
    });
    throw new Error(
      `The product did not start listening on port ${port} within 30s.\n${output.slice(-1500)}`,
    );
  }

  store.upsertPreview({
    workspace_id: workspaceId,
    slug,
    port,
    command: manifest.commands.start,
    cwd: projectDir,
    status: "running",
    started_at: Date.now(),
  });

  return {
    slug,
    port,
    url: `/p/${slug}/`,
    status: "running",
  };
}

export async function stopPreview(workspaceId: string): Promise<void> {
  const service = services.get(workspaceId);
  if (service) {
    await service.stop();
    services.delete(workspaceId);
  }
  const existing = store.getPreview(workspaceId);
  if (existing) {
    store.upsertPreview({ ...existing, status: "stopped" });
  }
}

export function previewFor(workspaceId: string): PreviewInfo | null {
  const row = store.getPreview(workspaceId);
  if (!row) return null;
  const live = services.get(workspaceId);
  const status = live && !live.exited() ? row.status : "stopped";
  return {
    slug: row.slug,
    port: row.port,
    url: `/p/${row.slug}/`,
    status: status as PreviewInfo["status"],
    ...(live?.exited() ? { message: live.output().slice(-1000) } : {}),
  };
}

export function previewTargetForSlug(slug: string): { port: number } | null {
  const row = store.getPreviewBySlug(slug);
  if (!row || row.status !== "running") return null;
  return { port: row.port };
}

/** Shut every preview down — called on server exit so nothing is orphaned. */
export async function stopAllPreviews(): Promise<void> {
  await Promise.all([...services.keys()].map((id) => stopPreview(id)));
}
