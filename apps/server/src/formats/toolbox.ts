import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { env } from "../config/env.js";

const TOOLBOX = resolve(env.root, "toolbox", "toolbox.py");

export type ToolboxCommand =
  | "capabilities"
  | "pe.inspect"
  | "pe.patch"
  | "pe.strings"
  | "gba.header"
  | "gba.patchHeader"
  | "gba.exportTiles"
  | "patch.create"
  | "patch.apply"
  | "patch.describe"
  | "image.convert"
  | "image.inspect";

export type ToolboxResult<T> =
  | ({ ok: true } & T)
  | { ok: false; error: string; traceback?: string };

/**
 * Call the Python binary toolbox.
 *
 * It runs out-of-process on purpose: a malformed or hostile binary can only
 * take down the toolbox, never the server. The toolbox always exits 0 and
 * reports failure in its JSON, so a non-zero exit here means the toolbox
 * itself broke — which is worth surfacing differently from "this file cannot
 * be handled".
 */
export function callToolbox<T = Record<string, unknown>>(
  command: ToolboxCommand,
  payload: Record<string, unknown> = {},
  timeoutMs = 120_000,
): Promise<ToolboxResult<T>> {
  return new Promise((done) => {
    const child = spawn("python3", [TOOLBOX, command], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: ToolboxResult<T>) => {
      if (settled) return;
      settled = true;
      done(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        ok: false,
        error: `Toolbox command '${command}' timed out after ${timeoutMs}ms.`,
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      finish({
        ok: false,
        error:
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? "python3 was not found on PATH, so binary inspection is unavailable. Install Python 3.11+ or run Wadle via docker compose."
            : `Could not start the toolbox: ${error.message}`,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (!stdout.trim()) {
        finish({
          ok: false,
          error: `Toolbox produced no output (exit ${code}). ${stderr.slice(0, 500)}`,
        });
        return;
      }
      try {
        finish(JSON.parse(stdout) as ToolboxResult<T>);
      } catch {
        finish({
          ok: false,
          error: `Toolbox returned unparseable output: ${stdout.slice(0, 500)}`,
        });
      }
    });

    child.stdin.end(JSON.stringify(payload));
  });
}

/** Throwing wrapper for callers that treat a handling failure as an error. */
export async function toolbox<T = Record<string, unknown>>(
  command: ToolboxCommand,
  payload: Record<string, unknown> = {},
): Promise<T> {
  const result = await callToolbox<T>(command, payload);
  if (!result.ok) throw new Error(result.error);
  const { ok: _ok, ...rest } = result;
  return rest as T;
}

export interface ToolboxCapabilities {
  python: string;
  pillow: boolean;
  formats: Record<string, Record<string, boolean>>;
}

let capabilityCache: ToolboxCapabilities | null = null;

export async function toolboxCapabilities(): Promise<
  ToolboxCapabilities | { available: false; reason: string }
> {
  if (capabilityCache) return capabilityCache;
  const result = await callToolbox<ToolboxCapabilities>("capabilities", {}, 15_000);
  if (!result.ok) return { available: false, reason: result.error };
  const { ok: _ok, ...rest } = result;
  capabilityCache = rest as ToolboxCapabilities;
  return capabilityCache;
}
