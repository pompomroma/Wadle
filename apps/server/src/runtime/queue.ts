import { runRequest, type LoopOutcome } from "../agent/loop.js";
import * as store from "../db/store.js";

/**
 * Per-workspace serial job runner.
 *
 * Requests stack: a user can queue several adjustments while the first is still
 * building. Within a workspace they run strictly in order, because each one is
 * applied to the product state the previous one produced — running them
 * concurrently would mean two passes editing the same files. Different
 * workspaces run in parallel.
 */
const running = new Map<string, AbortController>();
const listeners = new Set<(workspaceId: string) => void>();

export function onQueueChange(listener: (workspaceId: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(workspaceId: string): void {
  for (const listener of listeners) listener(workspaceId);
}

export function isRunning(workspaceId: string): boolean {
  return running.has(workspaceId);
}

export function cancel(workspaceId: string): boolean {
  const controller = running.get(workspaceId);
  if (!controller) return false;
  controller.abort();
  return true;
}

/** Kick the runner for a workspace. Safe to call repeatedly. */
export function schedule(workspaceId: string): void {
  if (running.has(workspaceId)) return;
  const next = store.nextQueuedRequest(workspaceId);
  if (!next) return;

  const controller = new AbortController();
  running.set(workspaceId, controller);

  void drain(workspaceId, controller).finally(() => {
    running.delete(workspaceId);
    notify(workspaceId);
    // Anything queued while this was running gets picked up immediately.
    if (store.nextQueuedRequest(workspaceId)) schedule(workspaceId);
  });
}

async function drain(
  workspaceId: string,
  controller: AbortController,
): Promise<void> {
  for (;;) {
    if (controller.signal.aborted) return;
    const request = store.nextQueuedRequest(workspaceId);
    if (!request) return;

    store.setRequestStatus(request.id, "running");
    notify(workspaceId);
    store.appendEvent({
      workspaceId,
      requestId: request.id,
      phase: "queue",
      message: `Started request #${request.seq}: ${request.prompt.slice(0, 160)}`,
    });

    let outcome: LoopOutcome;
    try {
      outcome = await runRequest(request, { signal: controller.signal });
    } catch (error) {
      const message =
        controller.signal.aborted
          ? "Cancelled by the user."
          : `Unexpected failure: ${(error as Error).message}`;
      store.setRequestStatus(
        request.id,
        controller.signal.aborted ? "cancelled" : "failed",
        message,
      );
      store.appendEvent({
        workspaceId,
        requestId: request.id,
        level: "error",
        phase: "queue",
        message,
      });
      notify(workspaceId);
      continue;
    }

    if (outcome.status === "succeeded") {
      store.setRequestStatus(request.id, "succeeded", null);
      store.appendEvent({
        workspaceId,
        requestId: request.id,
        phase: "queue",
        message: `Request #${request.seq} delivered after ${outcome.iterations} repair ${
          outcome.iterations === 1 ? "iteration" : "iterations"
        }.`,
      });
    } else {
      // A failed request does NOT hand over a product. The workspace keeps the
      // last verified revision so queued adjustments still have solid ground.
      const detail = [outcome.reason, ...(outcome.unmetCriteria ?? [])]
        .filter(Boolean)
        .join("\n");
      store.setRequestStatus(request.id, "failed", detail);
      store.appendEvent({
        workspaceId,
        requestId: request.id,
        level: "error",
        phase: "queue",
        message: `Request #${request.seq} did not reach a working product. Nothing was delivered.`,
        data: { reason: outcome.reason, unmetCriteria: outcome.unmetCriteria },
      });
    }
    notify(workspaceId);
  }
}

/**
 * Restart work that was interrupted by a restart. Requests left `running` in
 * the database never finished, so they go back on the queue rather than sitting
 * in a state nothing will ever advance.
 */
export function resumeAfterRestart(): number {
  const requeued = store.requeueOrphanedRequests();
  for (const workspaceId of store.workspacesWithPendingWork()) {
    schedule(workspaceId);
  }
  return requeued;
}
