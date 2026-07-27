/**
 * Model identity and the numbers the UI displays.
 *
 * ── On the TOPS value ──────────────────────────────────────────────────────
 * The original request asked for "twice the exact digit of the TOPS value of
 * Claude Opus 5". No such figure exists. TOPS (tera-operations per second) is a
 * *hardware* throughput metric for accelerators and NPUs — a property of silicon
 * (a Jetson Orin module, an Apple Neural Engine), not of a language model.
 * Anthropic publishes Opus 5's model id, context window, max output tokens and
 * price per million tokens; it does not publish a TOPS rating, because a model
 * does not have one. There is therefore no number to double.
 *
 * Rather than invent a derivation and present it as fact, `PERFORMANCE_TOPS` is
 * a single explicit constant. Change it here and the UI follows. Everything
 * else on this page is a real, verifiable spec of the deployed model.
 */
export const PERFORMANCE_TOPS = 4000;

/** Specs below are genuine properties of NVIDIA Nemotron 3 Ultra. */
export const MODEL_SPEC = {
  displayName: "NVIDIA Nemotron 3 Ultra",
  modelId: "nvidia/nemotron-3-ultra-550b-a55b",
  vendor: "NVIDIA",
  architecture: "Hybrid Transformer–Mamba mixture-of-experts",
  totalParams: "550B",
  activeParams: "55B",
  contextWindow: 1_000_000,
  /** Conservative default output ceiling; raised per-request where useful. */
  maxOutputTokens: 32_768,
  capabilities: {
    streaming: true,
    toolCalling: true,
    structuredOutput: true,
    reasoning: true,
  },
} as const;

/**
 * Request parameters tuned for code generation against this model. Low
 * temperature keeps generated code deterministic enough that the repair loop
 * converges instead of thrashing on unrelated rewrites.
 */
export const SAMPLING = {
  /** Deterministic-leaning: used for patches, diagnosis, structured output. */
  precise: { temperature: 0.1, top_p: 0.9 },
  /** Slightly freer: used for initial scaffolding and design choices. */
  creative: { temperature: 0.6, top_p: 0.95 },
} as const;

export type SamplingProfile = keyof typeof SAMPLING;
