import { spawn, type ChildProcess } from "node:child_process";
import { hasBinary } from "../sandbox/exec.js";

/**
 * Optional public URL via Cloudflare Tunnel.
 *
 * Off unless WADLE_TUNNEL=cloudflare, because turning it on publishes a service
 * that runs model-generated code. When it is on, `auth.ts` forces the access
 * token gate — there is no configuration in which Wadle is both reachable from
 * the internet and unauthenticated.
 *
 * Quick tunnels need no Cloudflare account. They are ephemeral: the hostname
 * changes every restart, which is right for sharing a session and wrong for
 * anything permanent. For a stable address, deploy the container somewhere you
 * control and put a real hostname in front of it.
 */

export type TunnelMode = "none" | "cloudflare";

export interface TunnelState {
  mode: TunnelMode;
  url: string | null;
  /** Populated when the tunnel was requested but could not be established. */
  error: string | null;
}

const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

let child: ChildProcess | null = null;

export function tunnelModeFromEnv(): TunnelMode {
  const raw = (process.env["WADLE_TUNNEL"] ?? "none").trim().toLowerCase();
  if (raw === "cloudflare" || raw === "cloudflared" || raw === "1" || raw === "true") {
    return "cloudflare";
  }
  return "none";
}

export async function startTunnel(
  mode: TunnelMode,
  port: number,
): Promise<TunnelState> {
  if (mode === "none") return { mode, url: null, error: null };

  if (!(await hasBinary("cloudflared"))) {
    return {
      mode,
      url: null,
      error:
        "WADLE_TUNNEL is set but `cloudflared` is not on PATH. Install it from " +
        "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ " +
        "and start Wadle again. The server is running and reachable locally in the meantime.",
    };
  }

  return new Promise<TunnelState>((done) => {
    const process_ = spawn(
      "cloudflared",
      [
        "tunnel",
        "--no-autoupdate",
        "--url",
        `http://127.0.0.1:${port}`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    child = process_;

    let settled = false;
    let output = "";

    const finish = (state: TunnelState) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(state);
    };

    const scan = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const match = output.match(URL_PATTERN);
      if (match) finish({ mode, url: match[0], error: null });
    };

    // cloudflared prints the assigned hostname to stderr.
    process_.stdout.on("data", scan);
    process_.stderr.on("data", scan);

    process_.on("error", (error) => {
      finish({ mode, url: null, error: `Could not start cloudflared: ${error.message}` });
    });

    process_.on("exit", (code) => {
      finish({
        mode,
        url: null,
        error: `cloudflared exited with code ${code} before publishing a URL.\n${output.slice(-800)}`,
      });
    });

    const timer = setTimeout(() => {
      finish({
        mode,
        url: null,
        error: `cloudflared did not report a URL within 45 seconds.\n${output.slice(-800)}`,
      });
    }, 45_000);
  });
}

export async function stopTunnel(): Promise<void> {
  if (!child) return;
  const process_ = child;
  child = null;
  process_.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (!process_.killed) process_.kill("SIGKILL");
}
