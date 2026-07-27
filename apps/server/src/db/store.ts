import { nanoid } from "nanoid";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { env } from "../config/env.js";
import {
  getDb,
  type ArtifactKind,
  type ArtifactRow,
  type CriterionKind,
  type CriterionRow,
  type CriterionStatus,
  type EventRow,
  type PreviewRow,
  type RequestKind,
  type RequestRow,
  type RequestStatus,
  type RevisionRow,
  type WorkspaceRow,
} from "./index.js";

const now = () => Date.now();
const id = (prefix: string) => `${prefix}_${nanoid(16)}`;

/* ------------------------------------------------------------------ *
 * Workspaces
 * ------------------------------------------------------------------ */

export function createWorkspace(name: string): WorkspaceRow {
  const row: WorkspaceRow = {
    id: id("ws"),
    name: name.trim() || "Untitled workspace",
    current_revision_id: null,
    created_at: now(),
    updated_at: now(),
  };
  getDb()
    .prepare(
      `INSERT INTO workspace (id, name, current_revision_id, created_at, updated_at)
       VALUES (@id, @name, @current_revision_id, @created_at, @updated_at)`,
    )
    .run(row);
  mkdirSync(workspaceDir(row.id), { recursive: true });
  return row;
}

export function listWorkspaces(): WorkspaceRow[] {
  return getDb()
    .prepare(`SELECT * FROM workspace ORDER BY updated_at DESC`)
    .all() as WorkspaceRow[];
}

export function getWorkspace(workspaceId: string): WorkspaceRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM workspace WHERE id = ?`)
    .get(workspaceId) as WorkspaceRow | undefined;
}

export function renameWorkspace(workspaceId: string, name: string): void {
  getDb()
    .prepare(`UPDATE workspace SET name = ?, updated_at = ? WHERE id = ?`)
    .run(name, now(), workspaceId);
}

export function deleteWorkspace(workspaceId: string): void {
  getDb().prepare(`DELETE FROM workspace WHERE id = ?`).run(workspaceId);
}

export function touchWorkspace(workspaceId: string): void {
  getDb()
    .prepare(`UPDATE workspace SET updated_at = ? WHERE id = ?`)
    .run(now(), workspaceId);
}

/** Live working tree for a workspace — where the product actually lives. */
export function workspaceDir(workspaceId: string): string {
  return join(env.workspacesDir, workspaceId, "product");
}

/** Where uploaded inputs for a workspace are staged. */
export function workspaceInputDir(workspaceId: string): string {
  return join(env.workspacesDir, workspaceId, "input");
}

/* ------------------------------------------------------------------ *
 * Requests
 * ------------------------------------------------------------------ */

export function createRequest(input: {
  workspaceId: string;
  prompt: string;
  kind: RequestKind;
  targetFormat?: string | null;
}): RequestRow {
  const db = getDb();
  const next = db
    .prepare(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM request WHERE workspace_id = ?`,
    )
    .get(input.workspaceId) as { seq: number };

  const row: RequestRow = {
    id: id("req"),
    workspace_id: input.workspaceId,
    seq: next.seq,
    prompt: input.prompt,
    kind: input.kind,
    target_format: input.targetFormat ?? null,
    status: "queued",
    error: null,
    iterations: 0,
    tokens_used: 0,
    queued_at: now(),
    started_at: null,
    finished_at: null,
  };

  db.prepare(
    `INSERT INTO request (id, workspace_id, seq, prompt, kind, target_format,
                          status, error, iterations, tokens_used, queued_at,
                          started_at, finished_at)
     VALUES (@id, @workspace_id, @seq, @prompt, @kind, @target_format,
             @status, @error, @iterations, @tokens_used, @queued_at,
             @started_at, @finished_at)`,
  ).run(row);
  touchWorkspace(input.workspaceId);
  return row;
}

export function getRequest(requestId: string): RequestRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM request WHERE id = ?`)
    .get(requestId) as RequestRow | undefined;
}

export function listRequests(workspaceId: string): RequestRow[] {
  return getDb()
    .prepare(`SELECT * FROM request WHERE workspace_id = ? ORDER BY seq ASC`)
    .all(workspaceId) as RequestRow[];
}

/**
 * Next queued request for a workspace. Requests stack: the user can enqueue
 * several adjustments while one is building, and each runs against the product
 * state the previous one produced.
 */
export function nextQueuedRequest(workspaceId: string): RequestRow | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM request
        WHERE workspace_id = ? AND status = 'queued'
        ORDER BY seq ASC LIMIT 1`,
    )
    .get(workspaceId) as RequestRow | undefined;
}

/** Workspaces that have queued work and nothing currently running. */
export function workspacesWithPendingWork(): string[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT workspace_id FROM request
        WHERE status = 'queued'
          AND workspace_id NOT IN (
            SELECT workspace_id FROM request WHERE status = 'running'
          )`,
    )
    .all() as Array<{ workspace_id: string }>;
  return rows.map((r) => r.workspace_id);
}

export function updateRequest(
  requestId: string,
  patch: Partial<
    Pick<
      RequestRow,
      | "status"
      | "error"
      | "iterations"
      | "tokens_used"
      | "started_at"
      | "finished_at"
    >
  >,
): void {
  const keys = Object.keys(patch) as Array<keyof typeof patch>;
  if (keys.length === 0) return;
  const assignments = keys.map((k) => `${k} = @${k}`).join(", ");
  getDb()
    .prepare(`UPDATE request SET ${assignments} WHERE id = @id`)
    .run({ ...patch, id: requestId });
}

export function setRequestStatus(
  requestId: string,
  status: RequestStatus,
  error?: string | null,
): void {
  const patch: Parameters<typeof updateRequest>[1] = { status };
  if (error !== undefined) patch.error = error;
  if (status === "running") patch.started_at = now();
  if (status === "succeeded" || status === "failed" || status === "cancelled") {
    patch.finished_at = now();
  }
  updateRequest(requestId, patch);
}

/** Recover from a crash: anything left 'running' at boot never finished. */
export function requeueOrphanedRequests(): number {
  const result = getDb()
    .prepare(
      `UPDATE request SET status = 'queued', started_at = NULL
        WHERE status = 'running'`,
    )
    .run();
  return result.changes;
}

/* ------------------------------------------------------------------ *
 * Revisions
 * ------------------------------------------------------------------ */

export function createRevision(input: {
  workspaceId: string;
  requestId: string | null;
  summary: string;
  snapshotDir: string;
  verified: boolean;
}): RevisionRow {
  const db = getDb();
  const next = db
    .prepare(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM revision WHERE workspace_id = ?`,
    )
    .get(input.workspaceId) as { seq: number };

  const row: RevisionRow = {
    id: id("rev"),
    workspace_id: input.workspaceId,
    request_id: input.requestId,
    seq: next.seq,
    summary: input.summary,
    snapshot_dir: input.snapshotDir,
    verified: input.verified ? 1 : 0,
    created_at: now(),
  };

  db.prepare(
    `INSERT INTO revision (id, workspace_id, request_id, seq, summary,
                           snapshot_dir, verified, created_at)
     VALUES (@id, @workspace_id, @request_id, @seq, @summary,
             @snapshot_dir, @verified, @created_at)`,
  ).run(row);

  db.prepare(
    `UPDATE workspace SET current_revision_id = ?, updated_at = ? WHERE id = ?`,
  ).run(row.id, now(), input.workspaceId);

  return row;
}

export function listRevisions(workspaceId: string): RevisionRow[] {
  return getDb()
    .prepare(`SELECT * FROM revision WHERE workspace_id = ? ORDER BY seq DESC`)
    .all(workspaceId) as RevisionRow[];
}

export function getRevision(revisionId: string): RevisionRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM revision WHERE id = ?`)
    .get(revisionId) as RevisionRow | undefined;
}

export function setCurrentRevision(
  workspaceId: string,
  revisionId: string,
): void {
  getDb()
    .prepare(
      `UPDATE workspace SET current_revision_id = ?, updated_at = ? WHERE id = ?`,
    )
    .run(revisionId, now(), workspaceId);
}

/* ------------------------------------------------------------------ *
 * Artifacts
 * ------------------------------------------------------------------ */

export function createArtifact(input: {
  workspaceId: string;
  requestId?: string | null;
  revisionId?: string | null;
  kind: ArtifactKind;
  filename: string;
  mime: string;
  size: number;
  path: string;
  meta?: unknown;
}): ArtifactRow {
  const row: ArtifactRow = {
    id: id("art"),
    workspace_id: input.workspaceId,
    request_id: input.requestId ?? null,
    revision_id: input.revisionId ?? null,
    kind: input.kind,
    filename: input.filename,
    mime: input.mime,
    size: input.size,
    path: input.path,
    meta: input.meta === undefined ? null : JSON.stringify(input.meta),
    created_at: now(),
  };
  getDb()
    .prepare(
      `INSERT INTO artifact (id, workspace_id, request_id, revision_id, kind,
                             filename, mime, size, path, meta, created_at)
       VALUES (@id, @workspace_id, @request_id, @revision_id, @kind,
               @filename, @mime, @size, @path, @meta, @created_at)`,
    )
    .run(row);
  return row;
}

export function getArtifact(artifactId: string): ArtifactRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM artifact WHERE id = ?`)
    .get(artifactId) as ArtifactRow | undefined;
}

export function listArtifacts(workspaceId: string): ArtifactRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM artifact WHERE workspace_id = ? ORDER BY created_at DESC`,
    )
    .all(workspaceId) as ArtifactRow[];
}

export function listRequestUploads(requestId: string): ArtifactRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM artifact WHERE request_id = ? AND kind = 'upload'
        ORDER BY created_at ASC`,
    )
    .all(requestId) as ArtifactRow[];
}

/* ------------------------------------------------------------------ *
 * Acceptance criteria
 * ------------------------------------------------------------------ */

export function replaceCriteria(
  requestId: string,
  criteria: Array<{
    description: string;
    kind: CriterionKind;
    spec: unknown;
  }>,
): CriterionRow[] {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO criterion (id, request_id, ordinal, description, kind, spec,
                            status, detail, updated_at)
     VALUES (@id, @request_id, @ordinal, @description, @kind, @spec,
             @status, @detail, @updated_at)`,
  );

  const rows: CriterionRow[] = criteria.map((criterion, index) => ({
    id: id("crit"),
    request_id: requestId,
    ordinal: index,
    description: criterion.description,
    kind: criterion.kind,
    spec: JSON.stringify(criterion.spec ?? {}),
    status: "pending" as CriterionStatus,
    detail: null,
    updated_at: now(),
  }));

  db.transaction(() => {
    db.prepare(`DELETE FROM criterion WHERE request_id = ?`).run(requestId);
    for (const row of rows) insert.run(row);
  })();

  return rows;
}

export function listCriteria(requestId: string): CriterionRow[] {
  return getDb()
    .prepare(`SELECT * FROM criterion WHERE request_id = ? ORDER BY ordinal ASC`)
    .all(requestId) as CriterionRow[];
}

export function setCriterionResult(
  criterionId: string,
  status: CriterionStatus,
  detail: string | null,
): void {
  getDb()
    .prepare(
      `UPDATE criterion SET status = ?, detail = ?, updated_at = ? WHERE id = ?`,
    )
    .run(status, detail?.slice(0, 8000) ?? null, now(), criterionId);
}

export function allCriteriaPass(requestId: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) AS passed
         FROM criterion WHERE request_id = ?`,
    )
    .get(requestId) as { total: number; passed: number | null };
  return row.total > 0 && (row.passed ?? 0) === row.total;
}

/* ------------------------------------------------------------------ *
 * Events (build log / SSE feed)
 * ------------------------------------------------------------------ */

export function appendEvent(input: {
  workspaceId: string;
  requestId?: string | null;
  level?: EventRow["level"];
  phase?: string | null;
  message: string;
  data?: unknown;
}): EventRow {
  const row = {
    workspace_id: input.workspaceId,
    request_id: input.requestId ?? null,
    ts: now(),
    level: input.level ?? "info",
    phase: input.phase ?? null,
    message: input.message,
    data: input.data === undefined ? null : JSON.stringify(input.data),
  };
  const result = getDb()
    .prepare(
      `INSERT INTO event (workspace_id, request_id, ts, level, phase, message, data)
       VALUES (@workspace_id, @request_id, @ts, @level, @phase, @message, @data)`,
    )
    .run(row);
  return { id: Number(result.lastInsertRowid), ...row } as EventRow;
}

export function listEvents(workspaceId: string, sinceId = 0): EventRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM event WHERE workspace_id = ? AND id > ?
        ORDER BY id ASC LIMIT 2000`,
    )
    .all(workspaceId, sinceId) as EventRow[];
}

/* ------------------------------------------------------------------ *
 * Previews
 * ------------------------------------------------------------------ */

export function upsertPreview(row: PreviewRow): void {
  getDb()
    .prepare(
      `INSERT INTO preview (workspace_id, slug, port, command, cwd, status, started_at)
       VALUES (@workspace_id, @slug, @port, @command, @cwd, @status, @started_at)
       ON CONFLICT(workspace_id) DO UPDATE SET
         slug = excluded.slug, port = excluded.port, command = excluded.command,
         cwd = excluded.cwd, status = excluded.status,
         started_at = excluded.started_at`,
    )
    .run(row);
}

export function getPreview(workspaceId: string): PreviewRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM preview WHERE workspace_id = ?`)
    .get(workspaceId) as PreviewRow | undefined;
}

export function getPreviewBySlug(slug: string): PreviewRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM preview WHERE slug = ?`)
    .get(slug) as PreviewRow | undefined;
}

export function listPreviews(): PreviewRow[] {
  return getDb().prepare(`SELECT * FROM preview`).all() as PreviewRow[];
}

export function deletePreview(workspaceId: string): void {
  getDb().prepare(`DELETE FROM preview WHERE workspace_id = ?`).run(workspaceId);
}
