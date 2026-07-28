import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Point Wadle's data directory at a throwaway location *before* any app module
 * is imported. `config/env.ts` resolves DATA_DIR once at module load, so every
 * test file must call this at the top and then use dynamic imports.
 */
export async function useTemporaryDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wadle-test-"));
  process.env["DATA_DIR"] = dir;
  // Keep tests fast and hermetic.
  process.env["SANDBOX_TIMEOUT_MS"] = "60000";
  process.env["AGENT_MAX_ITERATIONS"] = "6";
  process.env["AGENT_WALL_CLOCK_MS"] = "180000";
  return dir;
}

export async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

/** A scripted model backend: returns canned responses in order. */
export function scriptedBackend(responses: string[]) {
  let index = 0;
  const calls: Array<{ prompt: string }> = [];
  return {
    backend: {
      name: "scripted",
      model: "scripted-test-model",
      async complete(request: { messages: Array<{ content: string }> }) {
        const last = request.messages[request.messages.length - 1];
        calls.push({ prompt: last?.content ?? "" });
        const text = responses[Math.min(index, responses.length - 1)];
        index += 1;
        if (text === undefined) throw new Error("scripted backend exhausted");
        return {
          text,
          usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
          model: "scripted-test-model",
          durationMs: 1,
        };
      },
    },
    calls,
    callCount: () => index,
  };
}
