-- Wadle persistence. One SQLite file, no daemon.
-- A workspace owns one evolving product; every request appends a revision.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workspace (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  current_revision_id TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

-- Queued work. Multiple adjustments may stack on one workspace; they run in
-- `seq` order and each sees the product state the previous one left behind.
CREATE TABLE IF NOT EXISTS request (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  prompt        TEXT NOT NULL,
  kind          TEXT NOT NULL,     -- build | adjust | convert
  target_format TEXT,              -- convert requests only
  status        TEXT NOT NULL,     -- queued | running | succeeded | failed | cancelled
  error         TEXT,
  iterations    INTEGER NOT NULL DEFAULT 0,
  tokens_used   INTEGER NOT NULL DEFAULT 0,
  queued_at     INTEGER NOT NULL,
  started_at    INTEGER,
  finished_at   INTEGER
);
CREATE INDEX IF NOT EXISTS request_workspace_idx ON request(workspace_id, seq);
CREATE INDEX IF NOT EXISTS request_status_idx    ON request(status);

-- A restorable snapshot of the product after a request completed.
CREATE TABLE IF NOT EXISTS revision (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  request_id   TEXT REFERENCES request(id) ON DELETE SET NULL,
  seq          INTEGER NOT NULL,
  summary      TEXT NOT NULL DEFAULT '',
  snapshot_dir TEXT NOT NULL,
  verified     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS revision_workspace_idx ON revision(workspace_id, seq);

-- Uploads in, products out.
CREATE TABLE IF NOT EXISTS artifact (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  request_id   TEXT REFERENCES request(id) ON DELETE SET NULL,
  revision_id  TEXT REFERENCES revision(id) ON DELETE SET NULL,
  kind         TEXT NOT NULL,   -- upload | product | conversion
  filename     TEXT NOT NULL,
  mime         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  path         TEXT NOT NULL,
  meta         TEXT,            -- JSON: format inspection report
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS artifact_workspace_idx ON artifact(workspace_id);
CREATE INDEX IF NOT EXISTS artifact_request_idx   ON artifact(request_id);

-- Machine-checkable acceptance criteria extracted from the request. The build
-- loop does not finish until every row here is 'pass'.
CREATE TABLE IF NOT EXISTS criterion (
  id          TEXT PRIMARY KEY,
  request_id  TEXT NOT NULL REFERENCES request(id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL,
  description TEXT NOT NULL,
  kind        TEXT NOT NULL,   -- build | run | http | file | test | smoke | manual
  spec        TEXT NOT NULL,   -- JSON describing how to check it
  status      TEXT NOT NULL,   -- pending | pass | fail
  detail      TEXT,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS criterion_request_idx ON criterion(request_id, ordinal);

-- Append-only log; also the SSE feed for the live build view.
CREATE TABLE IF NOT EXISTS event (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  request_id   TEXT,
  ts           INTEGER NOT NULL,
  level        TEXT NOT NULL,   -- debug | info | warn | error
  phase        TEXT,            -- spec | plan | generate | verify | diagnose | deliver
  message      TEXT NOT NULL,
  data         TEXT             -- JSON
);
CREATE INDEX IF NOT EXISTS event_workspace_idx ON event(workspace_id, id);

-- Running preview servers for web products.
CREATE TABLE IF NOT EXISTS preview (
  workspace_id TEXT PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
  slug         TEXT NOT NULL UNIQUE,
  port         INTEGER NOT NULL,
  command      TEXT NOT NULL,
  cwd          TEXT NOT NULL,
  status       TEXT NOT NULL,   -- starting | running | stopped | failed
  started_at   INTEGER NOT NULL
);
