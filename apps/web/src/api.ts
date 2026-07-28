export interface Workspace {
  id: string;
  name: string;
  current_revision_id: string | null;
  created_at: number;
  updated_at: number;
  running?: boolean;
}

export interface Criterion {
  id: string;
  request_id: string;
  ordinal: number;
  description: string;
  kind: string;
  status: "pending" | "pass" | "fail";
  detail: string | null;
}

export interface RequestRow {
  id: string;
  workspace_id: string;
  seq: number;
  prompt: string;
  kind: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  error: string | null;
  iterations: number;
  queued_at: number;
  criteria?: Criterion[];
}

export interface Revision {
  id: string;
  seq: number;
  summary: string;
  verified: number;
  created_at: number;
}

export interface Artifact {
  id: string;
  kind: string;
  filename: string;
  mime: string;
  size: number;
  created_at: number;
}

export interface Manifest {
  kind: string;
  language: string;
  commands: { install: string; build: string; start: string; test: string };
  port: number | null;
  entrypoint: string;
  summary: string;
}

export interface PreviewInfo {
  slug: string;
  port: number;
  url: string;
  status: string;
  message?: string;
}

export interface WorkspaceDetail {
  workspace: Workspace;
  running: boolean;
  requests: RequestRow[];
  revisions: Revision[];
  artifacts: Artifact[];
  manifest: Manifest | null;
  preview: PreviewInfo | null;
}

export interface LogEvent {
  id: number;
  ts: number;
  level: "debug" | "info" | "warn" | "error";
  phase: string | null;
  message: string;
  data: string | null;
}

export interface Capability {
  id: string;
  label: string;
  available: boolean;
  degradedTo: string;
}

export interface ModelInfo {
  model: {
    displayName: string;
    modelId: string;
    architecture: string;
    totalParams: string;
    activeParams: string;
    contextWindow: number;
    endpoint: string;
    credentialsPresent: boolean;
    performanceTops: number;
    performanceTopsNote: string;
  };
  limits: {
    credits: string;
    billing: string;
    upstream: string;
    agent: { maxIterations: number; wallClockMs: number; tokenCeiling: number };
  };
  capabilities: {
    languages: Capability[];
    binaryTargets: Capability[];
    conversion: Capability[];
    networkIsolation: boolean;
  };
}

export interface InspectionReport {
  filename: string;
  size: number;
  format: {
    format: string;
    family: string;
    tier: string;
    capability: string;
  };
  detail: Record<string, unknown> | null;
  conversionTargets: string[];
  summary: string;
}

/**
 * Access token handling.
 *
 * A protected instance is opened with `?t=<token>`. The token is moved into
 * sessionStorage and stripped from the address bar on first load, so it stops
 * being copied around in URLs and does not end up in browser history or in a
 * screenshot of the tab.
 */
const TOKEN_KEY = "wadle.token";

function captureTokenFromUrl(): void {
  const url = new URL(window.location.href);
  const token = url.searchParams.get("t");
  if (!token) return;
  sessionStorage.setItem(TOKEN_KEY, token);
  url.searchParams.delete("t");
  window.history.replaceState({}, "", url.pathname + url.search + url.hash);
}

captureTokenFromUrl();

export function authToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

/** Append the token to a URL — for EventSource and links, which cannot use headers. */
export function withToken(path: string): string {
  const token = authToken();
  if (!token) return path;
  return `${path}${path.includes("?") ? "&" : "?"}t=${encodeURIComponent(token)}`;
}

export class UnauthorizedError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = authToken();
  const headers = new Headers(init?.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);

  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { error?: string }
      | null;
    const message =
      body?.error ?? `${response.status} ${response.statusText}`;
    if (response.status === 401) throw new UnauthorizedError(message);
    throw new Error(message);
  }
  return (await response.json()) as T;
}

export const api = {
  model: () => request<ModelInfo>("/api/model"),

  listWorkspaces: () => request<Workspace[]>("/api/workspaces"),

  createWorkspace: (name: string) =>
    request<Workspace>("/api/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }),

  workspace: (id: string) => request<WorkspaceDetail>(`/api/workspaces/${id}`),

  renameWorkspace: (id: string, name: string) =>
    request<Workspace>(`/api/workspaces/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }),

  deleteWorkspace: (id: string) =>
    request<{ deleted: boolean }>(`/api/workspaces/${id}`, { method: "DELETE" }),

  submit: (
    id: string,
    input: { prompt: string; files: File[]; targetFormat?: string },
  ) => {
    const form = new FormData();
    form.set("prompt", input.prompt);
    form.set("kind", input.targetFormat ? "convert" : "build");
    if (input.targetFormat) form.set("targetFormat", input.targetFormat);
    for (const file of input.files) form.append("files", file);
    return request<{ request: RequestRow; queuePosition: number }>(
      `/api/workspaces/${id}/requests`,
      { method: "POST", body: form },
    );
  },

  cancel: (id: string) =>
    request<{ cancelled: boolean }>(`/api/workspaces/${id}/cancel`, {
      method: "POST",
    }),

  inspect: (file: File) => {
    const form = new FormData();
    form.set("file", file);
    return request<InspectionReport>("/api/inspect", {
      method: "POST",
      body: form,
    });
  },

  packageProduct: (id: string) =>
    request<{ artifact: Artifact; downloadUrl: string }>(
      `/api/workspaces/${id}/download`,
    ),

  startPreview: (id: string) =>
    request<PreviewInfo>(`/api/workspaces/${id}/preview`, { method: "POST" }),

  stopPreview: (id: string) =>
    request<{ stopped: boolean }>(`/api/workspaces/${id}/preview`, {
      method: "DELETE",
    }),

  restoreRevision: (revisionId: string) =>
    request<{ restored: string }>(`/api/revisions/${revisionId}/restore`, {
      method: "POST",
    }),
};

/** Subscribe to the live build log. Returns an unsubscribe function. */
export function streamWorkspace(
  id: string,
  handlers: {
    onLog: (event: LogEvent) => void;
    onState: (state: { running: boolean; requests: RequestRow[] }) => void;
  },
): () => void {
  // EventSource cannot set headers, so the token rides in the query string.
  const source = new EventSource(withToken(`/api/workspaces/${id}/stream`));
  source.addEventListener("log", (event) => {
    handlers.onLog(JSON.parse((event as MessageEvent).data) as LogEvent);
  });
  source.addEventListener("state", (event) => {
    handlers.onState(
      JSON.parse((event as MessageEvent).data) as {
        running: boolean;
        requests: RequestRow[];
      },
    );
  });
  return () => source.close();
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
