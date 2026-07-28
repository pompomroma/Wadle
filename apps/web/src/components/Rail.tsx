import { api, formatBytes, withToken } from "../api.js";
import type {
  Capability,
  Criterion,
  ModelInfo,
  RequestRow,
  WorkspaceDetail,
} from "../api.js";

function CapabilityRow({ capability }: { capability: Capability }) {
  return (
    <div className={`cap ${capability.available ? "on" : "off"}`}>
      <span className="mark">{capability.available ? "✔" : "✘"}</span>
      <span className="label">
        {capability.label}
        {!capability.available && (
          <>
            {" "}
            <span className="degraded">→ {capability.degradedTo}</span>
          </>
        )}
      </span>
    </div>
  );
}

function CriteriaCard({ request }: { request: RequestRow }) {
  const criteria: Criterion[] = request.criteria ?? [];
  if (criteria.length === 0) return null;

  const passed = criteria.filter((c) => c.status === "pass").length;

  return (
    <div className="card">
      <h3>
        Acceptance checks — {passed}/{criteria.length}
      </h3>
      {criteria.map((criterion) => (
        <div key={criterion.id} className={`criterion ${criterion.status}`}>
          <span className="mark">
            {criterion.status === "pass"
              ? "✔"
              : criterion.status === "fail"
                ? "✘"
                : "·"}
          </span>
          <div>
            <div>{criterion.description}</div>
            {criterion.status === "fail" && criterion.detail && (
              <div className="detail">{criterion.detail.slice(0, 300)}</div>
            )}
          </div>
        </div>
      ))}
      <div className="note">
        The build is not finished until every check passes. If they cannot all
        pass, nothing is delivered.
      </div>
    </div>
  );
}

export function Rail({
  model,
  detail,
  onRefresh,
  onError,
}: {
  model: ModelInfo | null;
  detail: WorkspaceDetail | null;
  onRefresh: () => void;
  onError: (message: string) => void;
}) {
  const latest = detail?.requests[detail.requests.length - 1] ?? null;

  const packageProduct = async () => {
    if (!detail) return;
    try {
      const result = await api.packageProduct(detail.workspace.id);
      window.location.href = withToken(result.downloadUrl);
      onRefresh();
    } catch (error) {
      onError((error as Error).message);
    }
  };

  const togglePreview = async () => {
    if (!detail) return;
    try {
      if (detail.preview?.status === "running") {
        await api.stopPreview(detail.workspace.id);
      } else {
        await api.startPreview(detail.workspace.id);
      }
      onRefresh();
    } catch (error) {
      onError((error as Error).message);
    }
  };

  return (
    <aside className="rail">
      {model && (
        <div className="card">
          <h3>Model</h3>
          <div className="kv">
            <span className="k">Name</span>
            <span className="v">{model.model.displayName}</span>
          </div>
          <div className="kv">
            <span className="k">Parameters</span>
            <span className="v">
              {model.model.totalParams} / {model.model.activeParams} active
            </span>
          </div>
          <div className="kv">
            <span className="k">Context</span>
            <span className="v">
              {model.model.contextWindow.toLocaleString()}
            </span>
          </div>
          <div className="kv">
            <span className="k">Perf tier</span>
            <span className="v">{model.model.performanceTops} TOPS</span>
          </div>
          <div className="note">{model.model.performanceTopsNote}</div>
          {!model.model.credentialsPresent && (
            <div className="banner error" style={{ marginTop: "0.6rem" }}>
              No API key configured. Set <code>NVIDIA_API_KEY</code> in{" "}
              <code>.env</code>, or point <code>LLM_BASE_URL</code> at a local
              model.
            </div>
          )}
        </div>
      )}

      {latest && <CriteriaCard request={latest} />}

      {detail?.manifest && (
        <div className="card">
          <h3>Product</h3>
          <div className="kv">
            <span className="k">Kind</span>
            <span className="v">{detail.manifest.kind}</span>
          </div>
          <div className="kv">
            <span className="k">Language</span>
            <span className="v">{detail.manifest.language}</span>
          </div>
          {detail.manifest.entrypoint && (
            <div className="kv">
              <span className="k">Entry</span>
              <span className="v">{detail.manifest.entrypoint}</span>
            </div>
          )}
          <div className="composer-actions">
            <button onClick={packageProduct}>Download .zip</button>
            {detail.manifest.port !== null && (
              <button onClick={togglePreview}>
                {detail.preview?.status === "running" ? "Stop" : "Start"} preview
              </button>
            )}
          </div>
          {detail.preview?.status === "running" && (
            <div style={{ marginTop: "0.55rem" }}>
              <a href={withToken(detail.preview.url)} target="_blank" rel="noreferrer">
                Open live product ↗
              </a>
              <div className="note">
                Serving on {detail.preview.url} — this is the link for a
                web-based product.
              </div>
            </div>
          )}
        </div>
      )}

      {detail && detail.artifacts.length > 0 && (
        <div className="card">
          <h3>Files</h3>
          {detail.artifacts.slice(0, 12).map((artifact) => (
            <div key={artifact.id} className="artifact-row">
              <span className="grow" title={artifact.filename}>
                {artifact.filename}
              </span>
              <span style={{ color: "var(--dim)", fontSize: "0.7rem" }}>
                {formatBytes(artifact.size)}
              </span>
              <a href={withToken(`/api/artifacts/${artifact.id}/download`)}>↓</a>
            </div>
          ))}
        </div>
      )}

      {detail && detail.revisions.length > 0 && (
        <div className="card">
          <h3>Revisions</h3>
          {detail.revisions.slice(0, 8).map((revision) => (
            <div key={revision.id} className="artifact-row">
              <span className="grow" title={revision.summary}>
                #{revision.seq} {revision.summary}
              </span>
              <button
                style={{ padding: "0.1rem 0.4rem", fontSize: "0.7rem" }}
                onClick={async () => {
                  try {
                    await api.restoreRevision(revision.id);
                    onRefresh();
                  } catch (error) {
                    onError((error as Error).message);
                  }
                }}
              >
                restore
              </button>
            </div>
          ))}
        </div>
      )}

      {model && (
        <>
          <div className="card">
            <h3>Can build &amp; verify here</h3>
            {model.capabilities.languages.map((capability) => (
              <CapabilityRow key={capability.id} capability={capability} />
            ))}
          </div>

          <div className="card">
            <h3>Binary targets</h3>
            {model.capabilities.binaryTargets.map((capability) => (
              <CapabilityRow key={capability.id} capability={capability} />
            ))}
            <div className="note">
              Compiled binaries you upload are inspected and patched, never
              decompiled back to source, and never executed.
            </div>
          </div>

          <div className="card">
            <h3>Limits</h3>
            <div className="cap on">
              <span className="mark">✔</span>
              <span className="label">{model.limits.credits}</span>
            </div>
            <div className="cap on">
              <span className="mark">✔</span>
              <span className="label">{model.limits.billing}</span>
            </div>
            <div className="note">{model.limits.upstream}</div>
          </div>
        </>
      )}
    </aside>
  );
}
