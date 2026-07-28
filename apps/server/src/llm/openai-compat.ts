import type {
  ChatMessage,
  CompletionRequest,
  CompletionResult,
  LLMBackend,
  TokenUsage,
} from "./types.js";
import { LLMError } from "./types.js";

export interface BackendOptions {
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  maxOutputTokens: number;
  /** Retry attempts for 429 / 5xx / network faults. */
  maxRetries?: number;
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

/**
 * Client for any OpenAI-compatible `/chat/completions` endpoint.
 *
 * This covers both supported backends with one implementation:
 *   • NVIDIA NIM  (https://integrate.api.nvidia.com/v1) hosting Nemotron 3 Ultra
 *   • Any local server — Ollama, llama.cpp, vLLM — for a zero-cost path
 *
 * Always streams. Long code generations otherwise sit on an idle socket long
 * enough for proxies to drop the connection, and streaming is what feeds the
 * live build log in the UI.
 */
export class OpenAICompatBackend implements LLMBackend {
  readonly name: string;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly maxOutputTokens: number;
  private readonly maxRetries: number;

  constructor(options: BackendOptions) {
    this.name = options.name;
    this.model = options.model;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.maxOutputTokens = options.maxOutputTokens;
    this.maxRetries = options.maxRetries ?? 4;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const started = Date.now();
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const result = await this.attempt(request);
        return { ...result, durationMs: Date.now() - started };
      } catch (error) {
        lastError = error;
        const retryable = error instanceof LLMError && error.retryable;
        if (!retryable || attempt === this.maxRetries) break;
        // Exponential backoff with jitter: 1s, 2s, 4s, 8s (±25%).
        const base = 1000 * 2 ** attempt;
        const delay = base * (0.75 + Math.random() * 0.5);
        await sleep(delay, request.signal);
      }
    }
    throw lastError;
  }

  private async attempt(
    request: CompletionRequest,
  ): Promise<Omit<CompletionResult, "durationMs">> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: request.messages.map(toWireMessage),
      stream: true,
      stream_options: { include_usage: true },
      temperature: request.temperature ?? 0.1,
      top_p: request.topP ?? 0.9,
      max_tokens: request.maxTokens ?? this.maxOutputTokens,
    };
    if (request.json) body["response_format"] = { type: "json_object" };

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: request.signal ?? null,
      });
    } catch (cause) {
      // DNS failures, TLS errors, refused connections — worth retrying.
      throw new LLMError(
        `Could not reach ${this.baseUrl}: ${(cause as Error).message}`,
        undefined,
        true,
      );
    }

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "");
      throw new LLMError(
        describeHttpFailure(response.status, detail, this.baseUrl),
        response.status,
        RETRYABLE_STATUS.has(response.status),
      );
    }

    return this.readStream(response.body, request.onToken);
  }

  private async readStream(
    body: ReadableStream<Uint8Array>,
    onToken?: (chunk: string) => void,
  ): Promise<Omit<CompletionResult, "durationMs">> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parts: string[] = [];
    let usage: TokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    let buffer = "";

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line.
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");

          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (payload === "" || payload === "[DONE]") continue;

            let event: StreamChunk;
            try {
              event = JSON.parse(payload) as StreamChunk;
            } catch {
              continue; // A partial frame; the next read completes it.
            }

            const delta = event.choices?.[0]?.delta?.content;
            if (delta) {
              parts.push(delta);
              onToken?.(delta);
            }
            if (event.usage) {
              usage = {
                promptTokens: event.usage.prompt_tokens ?? 0,
                completionTokens: event.usage.completion_tokens ?? 0,
                totalTokens: event.usage.total_tokens ?? 0,
              };
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const text = parts.join("");
    if (text.trim() === "") {
      throw new LLMError(
        "Model returned an empty response — retrying.",
        undefined,
        true,
      );
    }
    return { text, usage, model: this.model };
  }
}

interface StreamChunk {
  choices?: Array<{ delta?: { content?: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

function toWireMessage(message: ChatMessage): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    role: message.role,
    content: message.content,
  };
  if (message.name) wire["name"] = message.name;
  if (message.tool_call_id) wire["tool_call_id"] = message.tool_call_id;
  return wire;
}

/** Turn provider error codes into something a user can act on. */
function describeHttpFailure(
  status: number,
  detail: string,
  baseUrl: string,
): string {
  const trimmed = detail.slice(0, 400);
  switch (status) {
    case 401:
    case 403:
      // 403 covers a revoked key, a malformed one, and a valid key with no
      // entitlement to this model — different fixes, and a request cannot tell
      // them apart. `pnpm check-key` makes one call that can.
      return `Model backend rejected the credential (HTTP ${status}). Run 'pnpm check-key' — it distinguishes a revoked key from a malformed one from a model your account cannot reach, and prints the fix for whichever it is. A key that was ever pasted into a chat or committed is treated as compromised by the provider and must be replaced, not just removed. ${trimmed}`;
    case 404:
      return `Model not found at ${baseUrl} (HTTP 404). Check LLM_MODEL. ${trimmed}`;
    case 429:
      return `Rate limited by the model backend (HTTP 429). Wadle adds no quotas of its own — this limit comes from the provider. Set LLM_BASE_URL to a local model for an unlimited path. ${trimmed}`;
    default:
      return `Model backend error (HTTP ${status}). ${trimmed}`;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
