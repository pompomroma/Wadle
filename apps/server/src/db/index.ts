import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { env } from "../config/env.js";

export type RequestKind = "build" | "adjust" | "convert";
export type RequestStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";
export type CriterionStatus = "pending" | "pass" | "fail";
export type CriterionKind =
  | "build"
  | "run"
  | "http"
  | "file"
  | "test"
  | "smoke"
  | "manual";
export type ArtifactKind = "upload" | "product" | "conversion";

export interface WorkspaceRow {
  id: string;
  name: string;
  current_revision_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface RequestRow {
  id: string;
  workspace_id: string;
  seq: number;
  prompt: string;
  kind: RequestKind;
  target_format: string | null;
  status: RequestStatus;
  error: string | null;
  iterations: number;
  tokens_used: number;
  queued_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface RevisionRow {
  id: string;
  workspace_id: string;
  request_id: string | null;
  seq: number;
  summary: string;
  snapshot_dir: string;
  verified: number;
  created_at: number;
}

export interface ArtifactRow {
  id: string;
  workspace_id: string;
  request_id: string | null;
  revision_id: string | null;
  kind: ArtifactKind;
  filename: string;
  mime: string;
  size: number;
  path: string;
  meta: string | null;
  created_at: number;
}

export interface CriterionRow {
  id: string;
  request_id: string;
  ordinal: number;
  description: string;
  kind: CriterionKind;
  spec: string;
  status: CriterionStatus;
  detail: string | null;
  updated_at: number;
}

export interface EventRow {
  id: number;
  workspace_id: string;
  request_id: string | null;
  ts: number;
  level: "debug" | "info" | "warn" | "error";
  phase: string | null;
  message: string;
  data: string | null;
}

export interface PreviewRow {
  workspace_id: string;
  slug: string;
  port: number;
  command: string;
  cwd: string;
  status: "starting" | "running" | "stopped" | "failed";
  started_at: number;
}

let db: Database.Database | null = null;

/**
 * Isolate generated products from Wadle's own module system.
 *
 * Node resolves `"type"` by walking up from a script to the nearest
 * package.json. Because the data directory lives inside this repository, a
 * generated `server.js` would otherwise inherit Wadle's `"type": "module"` and
 * fail on `require()` — a confusing failure in code that is perfectly correct
 * on its own. Declaring CommonJS here restores Node's real default for a
 * directory with no package.json. A generated project that ships its own
 * package.json still wins, because the nearest one takes precedence.
 */
function ensureModuleBoundary(): void {
  const boundary = resolve(env.dataDir, "package.json");
  if (existsSync(boundary)) return;
  writeFileSync(
    boundary,
    `${JSON.stringify(
      {
        name: "wadle-workspace-root",
        private: true,
        type: "commonjs",
        _comment:
          "Written by Wadle. Stops generated products inheriting the repo's ESM setting; a product's own package.json overrides this.",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

export function getDb(): Database.Database {
  if (db) return db;
  mkdirSync(dirname(env.databaseFile), { recursive: true });
  mkdirSync(env.workspacesDir, { recursive: true });
  mkdirSync(env.artifactsDir, { recursive: true });
  ensureModuleBoundary();

  db = new Database(env.databaseFile);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const schema = readFileSync(
    resolve(import.meta.dirname, "schema.sql"),
    "utf8",
  );
  db.exec(schema);
  return db;
}

/** Test hook: run against an in-memory database. */
export function useInMemoryDb(): Database.Database {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync(resolve(import.meta.dirname, "schema.sql"), "utf8"));
  return db;
}

export function closeDb(): void {
  db?.close();
  db = null;
}
