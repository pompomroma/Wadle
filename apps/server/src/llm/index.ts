import { env } from "../config/env.js";
import { MODEL_SPEC, SAMPLING, type SamplingProfile } from "../config/model.js";
import { OpenAICompatBackend } from "./openai-compat.js";
import type {
  ChatMessage,
  CompletionResult,
  LLMBackend,
  TokenUsage,
} from "./types.js";

export * from "./types.js";
export { OpenAICompatBackend } from "./openai-compat.js";

let backend: LLMBackend | null = null;

/**
 * The active model backend. Defaults to NVIDIA NIM running Nemotron 3 Ultra;
 * pointing `LLM_BASE_URL` at any OpenAI-compatible server (Ollama, llama.cpp,
 * vLLM) switches to a local, zero-cost model with no other change.
 */
export function getBackend(): LLMBackend {
  if (backend) return backend;
  const isNim = env.llm.baseUrl.includes("api.nvidia.com");
  backend = new OpenAICompatBackend({
    name: isNim ? "nvidia-nim" : "openai-compatible",
    baseUrl: env.llm.baseUrl,
    model: env.llm.model,
    apiKey: env.llm.apiKey,
    maxOutputTokens: MODEL_SPEC.maxOutputTokens,
  });
  return backend;
}

/** Swap the backend — used by tests to inject recorded fixtures. */
export function setBackend(next: LLMBackend | null): void {
  backend = next;
}

export interface AskOptions {
  system?: string;
  profile?: SamplingProfile;
  maxTokens?: number;
  json?: boolean;
  signal?: AbortSignal;
  onToken?: (chunk: string) => void;
  /** Called for every underlying call, including JSON repair retries. */
  onUsage?: (usage: TokenUsage) => void;
}

/** Single-shot completion with a system prompt. */
export async function ask(
  prompt: string | ChatMessage[],
  options: AskOptions = {},
): Promise<CompletionResult> {
  const sampling = SAMPLING[options.profile ?? "precise"];
  const messages: ChatMessage[] = [];
  if (options.system) messages.push({ role: "system", content: options.system });
  if (typeof prompt === "string") {
    messages.push({ role: "user", content: prompt });
  } else {
    messages.push(...prompt);
  }

  const result = await getBackend().complete({
    messages,
    temperature: sampling.temperature,
    topP: sampling.top_p,
    maxTokens: options.maxTokens,
    json: options.json,
    signal: options.signal,
    onToken: options.onToken,
  });
  options.onUsage?.(result.usage);
  return result;
}

/**
 * Completion that must yield JSON. Models routinely wrap JSON in prose or
 * markdown fences even under `response_format`, so the payload is extracted
 * rather than assumed, and a parse failure is retried once with the parser
 * error fed back — which is far cheaper than failing the whole build step.
 */
export async function askJson<T>(
  prompt: string,
  options: AskOptions = {},
): Promise<T> {
  const first = await ask(prompt, { ...options, json: true });
  try {
    return extractJson<T>(first.text);
  } catch (error) {
    const repair = await ask(
      [
        { role: "user", content: prompt },
        { role: "assistant", content: first.text },
        {
          role: "user",
          content:
            `That response could not be parsed as JSON: ${(error as Error).message}\n` +
            `Reply with the corrected JSON value and nothing else — no prose, no markdown fences.`,
        },
      ],
      { ...options, json: true },
    );
    return extractJson<T>(repair.text);
  }
}

/** Pull a JSON value out of a response that may be fenced or prose-wrapped. */
export function extractJson<T>(text: string): T {
  const trimmed = text.trim();

  const candidates: string[] = [trimmed];

  const fence = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n?```/);
  if (fence?.[1]) candidates.push(fence[1].trim());

  for (const [open, close] of [
    ["{", "}"],
    ["[", "]"],
  ] as const) {
    const start = trimmed.indexOf(open);
    const end = trimmed.lastIndexOf(close);
    if (start !== -1 && end > start) {
      candidates.push(trimmed.slice(start, end + 1));
    }
  }

  let lastError = "no candidate found";
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate) as T;
    } catch (error) {
      lastError = (error as Error).message;
    }
  }
  throw new Error(`Response was not valid JSON (${lastError})`);
}
