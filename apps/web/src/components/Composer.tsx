import { useCallback, useRef, useState } from "react";
import { api, formatBytes } from "../api.js";
import type { InspectionReport, WorkspaceDetail } from "../api.js";

interface Attachment {
  file: File;
  report: InspectionReport | null;
  error: string | null;
  inspecting: boolean;
}

export function Composer({
  detail,
  onSubmitted,
  onError,
}: {
  detail: WorkspaceDetail;
  onSubmitted: () => void;
  onError: (message: string) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [targetFormat, setTargetFormat] = useState("");
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const isAdjustment = detail.manifest !== null;

  /**
   * Inspect each file the moment it is attached, so the user learns what Wadle
   * can actually do with it *before* committing to a build — rather than
   * discovering the limits at the end of a long run.
   */
  const addFiles = useCallback(
    (files: File[]) => {
      const pending: Attachment[] = files.map((file) => ({
        file,
        report: null,
        error: null,
        inspecting: true,
      }));
      setAttachments((current) => [...current, ...pending]);

      for (const entry of pending) {
        api
          .inspect(entry.file)
          .then((report) => {
            setAttachments((current) =>
              current.map((item) =>
                item.file === entry.file
                  ? { ...item, report, inspecting: false }
                  : item,
              ),
            );
          })
          .catch((error: Error) => {
            setAttachments((current) =>
              current.map((item) =>
                item.file === entry.file
                  ? { ...item, error: error.message, inspecting: false }
                  : item,
              ),
            );
          });
      }
    },
    [],
  );

  const submit = async () => {
    if (!prompt.trim() && !targetFormat) return;
    setSubmitting(true);
    try {
      await api.submit(detail.workspace.id, {
        prompt: prompt.trim(),
        files: attachments.map((item) => item.file),
        ...(targetFormat ? { targetFormat } : {}),
      });
      setPrompt("");
      setAttachments([]);
      setTargetFormat("");
      onSubmitted();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const queued = detail.requests.filter(
    (request) => request.status === "queued",
  ).length;

  const conversionTargets =
    attachments[0]?.report?.conversionTargets ?? [];

  return (
    <div className="composer">
      <div className="composer-head">
        <h2>{detail.workspace.name}</h2>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          {detail.running && <span className="status-chip running">building</span>}
          {queued > 0 && (
            <span className="status-chip">
              {queued} queued
            </span>
          )}
          {detail.running && (
            <button
              className="danger"
              onClick={() =>
                api.cancel(detail.workspace.id).then(onSubmitted).catch(() => {})
              }
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      <textarea
        rows={3}
        value={prompt}
        placeholder={
          isAdjustment
            ? "Describe an adjustment. It will be applied to the current product — stack as many as you like, they run in order."
            : "Describe what to build. Attach files to modify or convert them."
        }
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            void submit();
          }
        }}
      />

      <div
        className={`dropzone ${dragging ? "over" : ""}`}
        onClick={() => fileInput.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          addFiles([...event.dataTransfer.files]);
        }}
      >
        Drop files here, or click to choose — .zip, .exe, .gba, source, configs,
        documents, images.
      </div>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          addFiles([...(event.target.files ?? [])]);
          event.target.value = "";
        }}
      />

      {attachments.map((attachment, index) => (
        <div className="attachment" key={`${attachment.file.name}-${index}`}>
          <div className="grow">
            <div>
              <code>{attachment.file.name}</code>{" "}
              <span style={{ color: "var(--dim)", fontSize: "0.72rem" }}>
                {formatBytes(attachment.file.size)}
              </span>
            </div>
            {attachment.inspecting && (
              <div className="summary">Inspecting…</div>
            )}
            {attachment.error && (
              <div className="summary" style={{ color: "var(--fail)" }}>
                {attachment.error}
              </div>
            )}
            {attachment.report && (
              <div className="summary">{attachment.report.summary}</div>
            )}
          </div>
          {attachment.report && (
            <span className={`tier ${attachment.report.format.tier}`}>
              {attachment.report.format.tier}
            </span>
          )}
          <button
            style={{ padding: "0.1rem 0.4rem", fontSize: "0.72rem" }}
            onClick={() =>
              setAttachments((current) =>
                current.filter((_, i) => i !== index),
              )
            }
          >
            ✕
          </button>
        </div>
      ))}

      <div className="composer-actions">
        <button
          className="primary"
          disabled={submitting || (!prompt.trim() && !targetFormat)}
          onClick={() => void submit()}
        >
          {detail.running
            ? "Queue behind current build"
            : isAdjustment
              ? "Apply adjustment"
              : "Build it"}
        </button>

        {conversionTargets.length > 0 && (
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.35rem",
              fontSize: "0.78rem",
              color: "var(--muted)",
            }}
          >
            convert to
            <select
              value={targetFormat}
              onChange={(event) => setTargetFormat(event.target.value)}
              style={{
                font: "inherit",
                background: "var(--bg)",
                color: "var(--text)",
                border: "1px solid var(--border)",
                borderRadius: "5px",
                padding: "0.25rem 0.4rem",
              }}
            >
              <option value="">—</option>
              {conversionTargets.map((format) => (
                <option key={format} value={format}>
                  .{format}
                </option>
              ))}
            </select>
          </label>
        )}

        <span className="hint">⌘/Ctrl + Enter</span>
      </div>
    </div>
  );
}
