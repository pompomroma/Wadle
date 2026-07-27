export type Role = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: Role;
  content: string;
  name?: string;
  tool_call_id?: string;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  /** Sampling profile name, or explicit overrides. */
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  /** Ask the backend to constrain output to a JSON object. */
  json?: boolean;
  /** Abort in-flight generation. */
  signal?: AbortSignal;
  /** Called with each token as it streams; enables live UI output. */
  onToken?: (chunk: string) => void;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface CompletionResult {
  text: string;
  usage: TokenUsage;
  model: string;
  /** Wall-clock duration of the call in milliseconds. */
  durationMs: number;
}

export interface LLMBackend {
  readonly name: string;
  readonly model: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export class LLMError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "LLMError";
  }
}
