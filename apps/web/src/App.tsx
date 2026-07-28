import { useCallback, useEffect, useRef, useState } from "react";
import { UnauthorizedError, api, streamWorkspace } from "./api.js";
import type { LogEvent, ModelInfo, Workspace, WorkspaceDetail } from "./api.js";
import { Composer } from "./components/Composer.js";
import { Rail } from "./components/Rail.js";

const MAX_LOG_LINES = 3000;

function EmptyState() {
  return (
    <div className="empty">
      <h3>Nothing built here yet</h3>
      <p>
        Describe what you want and Wadle builds it, runs it, tests it, and keeps
        repairing it until it actually works. If it can&apos;t get there, it
        tells you exactly which checks are failing and hands over nothing —
        rather than giving you something broken.
      </p>
      <p style={{ marginTop: "1rem", color: "var(--muted)" }}>Try:</p>
      <ul>
        <li>“A snake game I can play in the browser, with a score counter.”</li>
        <li>“A CLI that reads a CSV and prints per-column statistics.”</li>
        <li>Attach a <code>.zip</code> and ask for a change inside it.</li>
        <li>
          Attach a <code>.gba</code> ROM to read its header or generate a patch.
        </li>
        <li>
          Attach an <code>.ini</code> and convert it to <code>.json</code> —
          or to <code>.exe</code>, which builds a real program around it.
        </li>
      </ul>
    </div>
  );
}

export function App() {
  const [model, setModel] = useState<ModelInfo | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<WorkspaceDetail | null>(null);
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  const refreshWorkspaces = useCallback(async () => {
    try {
      const list = await api.listWorkspaces();
      setWorkspaces(list);
      setActiveId((current) => current ?? list[0]?.id ?? null);
      return list;
    } catch (cause) {
      setError(
        cause instanceof UnauthorizedError
          ? "This Wadle instance needs an access token. Open the link printed at startup, which includes ?t=<token>."
          : (cause as Error).message,
      );
      return [];
    }
  }, []);

  const refreshDetail = useCallback(async () => {
    if (!activeId) return;
    try {
      setDetail(await api.workspace(activeId));
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, [activeId]);

  useEffect(() => {
    api.model().then(setModel).catch(() => {});
    void refreshWorkspaces();
  }, [refreshWorkspaces]);

  useEffect(() => {
    if (!activeId) return;
    setLogs([]);
    void refreshDetail();

    let previousRunning: boolean | null = null;
    const unsubscribe = streamWorkspace(activeId, {
      onLog: (event) => {
        setLogs((current) => {
          const next = [...current, event];
          return next.length > MAX_LOG_LINES
            ? next.slice(next.length - MAX_LOG_LINES)
            : next;
        });
      },
      onState: (state) => {
        // Re-fetch the full detail whenever work starts or stops, so criteria,
        // artifacts and revisions stay in step with the log.
        if (previousRunning !== null && previousRunning !== state.running) {
          void refreshDetail();
          void refreshWorkspaces();
        }
        previousRunning = state.running;
      },
    });
    return unsubscribe;
  }, [activeId, refreshDetail, refreshWorkspaces]);

  // Keep the log pinned to the bottom unless the user has scrolled up to read.
  useEffect(() => {
    const element = logRef.current;
    if (element && pinnedToBottom.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [logs]);

  const createWorkspace = async () => {
    try {
      const workspace = await api.createWorkspace(
        `Workspace ${workspaces.length + 1}`,
      );
      await refreshWorkspaces();
      setActiveId(workspace.id);
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">
          <h1>Wadle</h1>
          <span>vibe build</span>
        </div>
        <p className="tagline">
          Describe it, attach files, get something that actually runs.
        </p>

        <div className="section-label">Session slots</div>
        {workspaces.map((workspace) => (
          <button
            key={workspace.id}
            className={`ws-item ${workspace.id === activeId ? "active" : ""}`}
            onClick={() => setActiveId(workspace.id)}
          >
            <span className="row">
              {workspace.running && <span className="pulse" />}
              <span className="name">{workspace.name}</span>
            </span>
          </button>
        ))}
        <button
          style={{ width: "100%", marginTop: "0.5rem" }}
          onClick={() => void createWorkspace()}
        >
          + New workspace
        </button>

        {detail && (
          <>
            <div className="section-label">History</div>
            {detail.requests
              .slice()
              .reverse()
              .slice(0, 12)
              .map((request) => (
                <div
                  key={request.id}
                  style={{
                    fontSize: "0.74rem",
                    padding: "0.3rem 0",
                    borderBottom: "1px solid rgba(42,50,61,.5)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      gap: "0.4rem",
                      alignItems: "center",
                    }}
                  >
                    <span className={`status-chip ${request.status}`}>
                      #{request.seq}
                    </span>
                    <span style={{ color: "var(--dim)" }}>
                      {request.status}
                      {request.iterations > 0 && ` · ${request.iterations} fixes`}
                    </span>
                  </div>
                  <div style={{ color: "var(--muted)", marginTop: "0.15rem" }}>
                    {request.prompt.slice(0, 90)}
                  </div>
                </div>
              ))}
          </>
        )}
      </nav>

      <main className="main">
        {error && (
          <div className="banner error" style={{ margin: "0.7rem 1.1rem 0" }}>
            {error}{" "}
            <button
              style={{ padding: "0 0.35rem", marginLeft: "0.4rem" }}
              onClick={() => setError(null)}
            >
              dismiss
            </button>
          </div>
        )}

        {detail ? (
          <Composer
            detail={detail}
            onSubmitted={() => {
              void refreshDetail();
              void refreshWorkspaces();
            }}
            onError={setError}
          />
        ) : (
          <div className="composer">
            <div className="composer-head">
              <h2>No workspace selected</h2>
            </div>
            <button className="primary" onClick={() => void createWorkspace()}>
              Create one
            </button>
          </div>
        )}

        <div
          className="log"
          ref={logRef}
          onScroll={(event) => {
            const element = event.currentTarget;
            pinnedToBottom.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 60;
          }}
        >
          {logs.length === 0 ? (
            <EmptyState />
          ) : (
            logs.map((event) => (
              <div
                key={event.id}
                className={`log-line ${event.level} phase-${event.phase ?? "none"}`}
              >
                <span className="phase">{event.phase ?? ""}</span>
                <span className="body">{event.message}</span>
              </div>
            ))
          )}
        </div>
      </main>

      <Rail
        model={model}
        detail={detail}
        onRefresh={() => {
          void refreshDetail();
          void refreshWorkspaces();
        }}
        onError={setError}
      />
    </div>
  );
}
