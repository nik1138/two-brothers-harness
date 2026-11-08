/**
 * Model providers. Mirrors the original prototype's provider module (removed
 * 2026-11-04; see git history) and PROTOCOL.md §11.
 *
 * Wire families are selected per role by `ProviderKind` (default
 * "openai-compatible"): `OpenAICompatibleProvider` speaks `/chat/completions`,
 * `AnthropicProvider` the Messages API and `GoogleProvider` Gemini's
 * `:generateContent`. All three extend `BaseHttpProvider`, which owns the
 * retry loop, so the harness sees one `Provider` interface (chat +
 * chatWithTools) and one `UsageTracker` regardless of family.
 *
 * Retries are owned by this module (there is no SDK to delegate to):
 * `BaseHttpProvider.complete` runs an explicit loop — at most
 * `retries + 1` attempts, exponential backoff between them
 * (`backoffDelays`: base 2 s, factor 2, capped at 30 s), each attempt bounded
 * by `Config.timeout` on the client. A run-level `AbortSignal` aborts the loop
 * between attempts and the in-flight fetch, so a stopped run never sleeps
 * through a full backoff.
 *
 * Failures are classified by an ordered registry ported from pi-ai's
 * `utils/{retry,provider-retry,overflow}.ts` (MIT): 408/409/429/5xx,
 * transport failures and provider-requested retries are retried, while other
 * 4xx, quota/billing exhaustion, provider-specific rejection types
 * (Anthropic `authentication_error`, Google `PERMISSION_DENIED`, …) and
 * context overflow fail fast instead of burning the retry budget. A
 * `Retry-After` header on a retryable response replaces that attempt's fixed
 * backoff (seconds or HTTP-date, capped at 120 s), and context-overflow
 * payloads raise `ProviderContextOverflowError` so callers can compact the
 * context rather than retry the same request.
 *
 * Every provider carries a `UsageTracker` recording per-call token usage; the
 * cooperation state machine (`harness.ts`) aggregates the roles' snapshots
 * with `mergeUsage` onto the run result.
 *
 * Tool support: `chatWithTools` sends JSON-schema tool definitions in each
 * family's wire shape (`tools`/`tool_calls`, `tools`/`tool_use` blocks,
 * `functionDeclarations`/`functionCall` parts); plain `chat` stays text-only
 * and back-compatible. Providers that never call tools may omit it — the
 * harness then skips the tool loop, mirroring the original prototype's
 * tool-capable-responder check.
 *
 * Token streaming is observational and opt-in: a call that passes
 * `ChatOptions.onDelta` (visible text) and/or `ChatOptions.onThinkingDelta`
 * (reasoning/thinking) asks its adapter for the provider's SSE stream
 * (OpenAI-compatible `stream: true`, Anthropic `stream: true`, Gemini
 * `:streamGenerateContent?alt=sse`) and reports every delta as it arrives,
 * tagged `"text"` or `"thinking"`. The resolved value is the complete reply —
 * assembled from the text deltas into the same shape the non-streaming path
 * parses — so callers, usage accounting and the retry loop are unchanged.
 * Thinking deltas are kept OUT of the reply content: they accumulate in
 * `StreamState.thinking` for observers only and never reach `streamResult`,
 * usage accounting or the returned string. The per-attempt `AbortController`
 * timeout bounds the WHOLE stream, so a stalled stream is a retryable
 * `ProviderTimeoutError`; a mid-stream transport failure is classified by the
 * same registry as any other transport error. Deltas already delivered stay
 * delivered (a retry re-requests the whole reply); streaming never changes
 * what the attempt eventually returns.
 *
 * Non-SSE fallback: some OpenAI-compatible endpoints (including the repo's
 * scripted browser-E2E server) ignore `stream: true` and answer with a normal
 * JSON completion. A streamed attempt whose response is not an SSE stream
 * (content-type missing or not `text/event-stream`) is parsed as that normal
 * JSON completion for that attempt — no deltas are emitted, streaming stays
 * observational — and a response that advertises SSE but is a plain JSON
 * object (never a frame) is recovered the same way. A successful SSE stream
 * and every non-streaming request stay byte-identical.
 */
import type { ChatMessage, ToolCall } from "./context.ts";
import { extractTask } from "./context.ts";

export type { ToolCall } from "./context.ts";

export interface Provider {
  /**
   * Plain completion. `options.onDelta` opts this call into wire streaming
   * (see the module doc); with no callback the request is byte-identical to
   * the pre-streaming path.
   */
  chat(
    messages: ChatMessage[],
    responseKind?: string,
    signal?: AbortSignal,
    options?: ChatOptions,
  ): Promise<string>;
  /**
   * Tool-calling completion. Optional so plain text-only providers stay
   * valid: the harness falls back to `chat()` when this is absent (mirrors
   * the original prototype, which only loops tools for tool-capable
   * responders).
   */
  chatWithTools?(
    messages: ChatMessage[],
    tools: Tool[],
    options?: ToolChatOptions,
  ): Promise<ToolChatResponse>;
}

/** A tool the model may call: JSON-schema description + local execution. */
export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for the arguments (OpenAI `function.parameters`). */
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, signal?: AbortSignal): string | Promise<string>;
}

/**
 * One signed Anthropic extended-thinking block captured from a response.
 *
 * The Messages API returns thinking blocks as
 * `{type: "thinking", thinking, signature}` (and, when the provider redacts
 * reasoning, `{type: "redacted_thinking", data}`); a tool loop must echo them
 * back verbatim on the assistant turn or the API rejects the request. `text`
 * never becomes reply content; `signature` is opaque replay metadata.
 */
export interface ThinkingBlock {
  /** Reasoning text (`thinking` blocks); "" for a redacted block. */
  text: string;
  /** Signature from `signature_delta`; required to echo the block back. */
  signature: string;
  /** Encrypted payload of a `redacted_thinking` block, echoed as `data`. */
  redacted?: string;
}

/** One completion: either plain text, structured tool calls, or both. */
export interface ToolChatResponse {
  content: string;
  toolCalls: ToolCall[];
  /**
   * Signed extended-thinking blocks this response carried, in arrival order.
   * Only the Anthropic adapter populates it (and only when the request enabled
   * thinking); the harness copies them onto the assistant `ChatMessage` and
   * the adapter echoes them on the next tool-loop request. Other adapters and
   * callers that do not know the field ignore it.
   */
  thinkingBlocks?: ThinkingBlock[];
}

/**
 * The two kinds of streamed delta: visible reply text and the model's
 * reasoning/thinking. Observers receive both; only `text` ever contributes to
 * the resolved reply.
 */
export type ChatDeltaKind = "text" | "thinking";

/**
 * Per-call streaming options. When `onDelta` and/or `onThinkingDelta` is set
 * the adapter asks the provider for its SSE stream and calls the sinks once
 * for delta, in arrival order: `onDelta` for visible reply text,
 * `onThinkingDelta` for reasoning/thinking deltas. Both callbacks are
 * observational: a throwing sink is ignored, the resolved value is the
 * complete reply, token usage is recorded exactly as in the non-streaming
 * path, and thinking deltas never appear in the reply content. An endpoint
 * that ignores the stream request answers with a normal JSON completion; it is
 * parsed as such and no deltas are emitted (see the module header).
 */
export interface ChatOptions {
  onDelta?: (delta: string) => void;
  onThinkingDelta?: (delta: string) => void;
}

export interface ToolChatOptions extends ChatOptions {
  /** Mirrors `chat`'s responseKind so mock/scripted providers can vary output. */
  responseKind?: string;
  signal?: AbortSignal;
}

/** Tool definitions in the OpenAI request body. */
function toolDefinitions(tools: Tool[]): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

/** Conversation messages in the OpenAI wire shape. */
function toWireMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === "assistant") {
      const out: Record<string, unknown> = { role: "assistant", content: message.content };
      if (message.toolCalls && message.toolCalls.length > 0) {
        out.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
        }));
      }
      return out;
    }
    if (message.role === "tool") {
      return { role: "tool", tool_call_id: message.toolCallId ?? "", content: message.content };
    }
    return { role: message.role, content: message.content };
  });
}

interface WireToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

/** Parse the OpenAI `tool_calls` field; malformed argument JSON yields `{}`. */
function parseToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: ToolCall[] = [];
  for (const item of raw as WireToolCall[]) {
    if (item === null || typeof item !== "object") continue;
    let args: Record<string, unknown> = {};
    if (typeof item.function?.arguments === "string" && item.function.arguments) {
      try {
        const parsed: unknown = JSON.parse(item.function.arguments);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        args = {};
      }
    }
    calls.push({ id: String(item.id ?? `call-${calls.length + 1}`), name: String(item.function?.name ?? ""), args });
  }
  return calls;
}

/**
 * Wire family behind an `openai` provider. `openai-compatible` is the default
 * and covers the `/chat/completions` shape; `anthropic` and `google` are the
 * native Messages / Generative Language adapters below.
 */
export type ProviderKind = "openai-compatible" | "anthropic" | "google";

export const PROVIDER_KINDS: readonly ProviderKind[] = [
  "openai-compatible",
  "anthropic",
  "google",
];

export const DEFAULT_PROVIDER_KIND: ProviderKind = "openai-compatible";

/** `openai-compatible|anthropic|google` — the accepted values, for messages. */
export const PROVIDER_KIND_HINT = PROVIDER_KINDS.join("|");

export function isProviderKind(value: string): value is ProviderKind {
  return (PROVIDER_KINDS as readonly string[]).includes(value);
}

export interface ProviderConfig {
  provider: string;
  /** Run-level wire family for `openai` roles; default "openai-compatible". */
  kind?: string;
  /** Per-role wire family overrides (`--senior-kind` / `--junior-kind`). */
  seniorKind?: string;
  juniorKind?: string;
  baseUrl: string;
  apiKey: string;
  seniorModel: string;
  juniorModel: string;
  /** Explicit model override (per-role endpoint resolution). */
  model?: string;
  temperature: number;
  timeout: number;
  retries?: number;
  /**
   * Output-token cap. Anthropic requires `max_tokens`, so its adapter falls
   * back to `DEFAULT_MAX_OUTPUT_TOKENS`; Google sends `maxOutputTokens` only
   * when this is set.
   */
  maxTokens?: number;
  /**
   * Anthropic extended-thinking budget in tokens (`--thinking-budget`). When
   * set, the Messages adapter adds
   * `thinking: {type: "enabled", budget_tokens: N}` to every request and
   * captures the signed thinking blocks so tool loops can echo them back
   * verbatim. ONLY the Anthropic adapter reads it: other adapters ignore the
   * field and their request bytes stay exactly as before. Unset keeps today's
   * request (no `thinking` field at all). Must be at least
   * {@link ANTHROPIC_MIN_THINKING_BUDGET}; when it does not fit under the
   * effective `max_tokens` the adapter raises that cap with one honest warning.
   */
  thinkingBudgetTokens?: number;
  /**
   * The provider's context window in tokens. Adapters ignore it on the wire —
   * it feeds compaction budgets only (`CompactionSettings.contextWindow`).
   */
  contextWindow?: number;
  /**
   * Where per-attempt-timeout diagnostics go (`[warn] provider attempt timed
   * out …; retrying … — consider --timeout for slow models`). Defaults to
   * `console.error`: warnings are stderr-only, so stdout stays pure for
   * `--mode json` / `--json` consumers. The provider emits at most
   * `MAX_TIMEOUT_WARNINGS` per instance (one provider instance = one role in
   * one run); a caller with a run-wide budget may cap the sink further.
   */
  onWarning?: (line: string) => void;
}

/**
 * The provider family one role talks to: role kind > run-level kind >
 * "openai-compatible". An unknown value throws before any endpoint is
 * contacted — a typo must fail fast, not fall back silently.
 */
export function resolveProviderKind(
  cfg: Pick<ProviderConfig, "kind" | "seniorKind" | "juniorKind">,
  role: string,
): ProviderKind {
  const roleValue =
    (role === "senior" ? cfg.seniorKind : role === "junior" ? cfg.juniorKind : "") || "";
  const value = (roleValue || cfg.kind || DEFAULT_PROVIDER_KIND).trim();
  if (!isProviderKind(value)) {
    throw new Error(`unknown provider kind: ${value || "(empty)"} (use ${PROVIDER_KIND_HINT})`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// usage tracking (UsageTracker / extract_usage / merge_usage in Python)
// ---------------------------------------------------------------------------

export const USAGE_KEYS = ["model_calls", "input_tokens", "output_tokens", "cached_tokens"] as const;

export interface UsageTotals {
  model_calls: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
}

/** The zero usage aggregate: `{model_calls, input_tokens, output_tokens, cached_tokens}`. */
export function emptyUsage(): UsageTotals {
  return { model_calls: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0 };
}

function coerceInt(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : 0;
}

/**
 * Token usage of one chat-completion response JSON: input/output/cached
 * (0 when absent). Cached prompt tokens are read the way the original
 * prototype does — `usage.prompt_tokens_details.cached_tokens` (OpenAI style)
 * — falling back to `usage.prompt_cache_hit_tokens` (DeepSeek style), which
 * the prototype surfaces through its provider SDK's `cache_read` mapping.
 */
export function extractUsage(data: unknown): Omit<UsageTotals, "model_calls"> {
  const usage =
    data && typeof data === "object"
      ? ((data as Record<string, unknown>).usage as Record<string, unknown> | undefined)
      : undefined;
  const raw = usage && typeof usage === "object" ? usage : {};
  const details =
    raw.prompt_tokens_details && typeof raw.prompt_tokens_details === "object"
      ? (raw.prompt_tokens_details as Record<string, unknown>)
      : {};
  const cached = coerceInt(details.cached_tokens) || coerceInt(raw.prompt_cache_hit_tokens);
  return {
    input_tokens: coerceInt(raw.prompt_tokens),
    output_tokens: coerceInt(raw.completion_tokens),
    cached_tokens: cached,
  };
}

/** Sum usage dicts (e.g. the senior's and junior's snapshots) into one. */
export function mergeUsage(...usages: Array<Partial<UsageTotals> | null | undefined>): UsageTotals {
  const total = emptyUsage();
  for (const usage of usages) {
    for (const key of USAGE_KEYS) {
      total[key] += coerceInt(usage?.[key]);
    }
  }
  return total;
}

/** Accumulates per-call token usage across a run. */
export class UsageTracker {
  private totals = emptyUsage();

  record(inputTokens = 0, outputTokens = 0, cachedTokens = 0): void {
    this.totals.model_calls += 1;
    this.totals.input_tokens += coerceInt(inputTokens);
    this.totals.output_tokens += coerceInt(outputTokens);
    this.totals.cached_tokens += coerceInt(cachedTokens);
  }

  /** Record one call's usage straight from an OpenAI-compatible response JSON. */
  recordResponse(data: unknown): void {
    const { input_tokens, output_tokens, cached_tokens } = extractUsage(data);
    this.record(input_tokens, output_tokens, cached_tokens);
  }

  snapshot(): UsageTotals {
    return { ...this.totals };
  }
}

// deterministic offline usage reported by MockProvider per call
// (mirrors MOCK_USAGE = (10, 5, 0) in responders.py)
const MOCK_USAGE: readonly [number, number, number] = [10, 5, 0];

// ---------------------------------------------------------------------------
// retry / cancellation
// ---------------------------------------------------------------------------

export const BACKOFF_BASE_SECONDS = 2.0;
export const BACKOFF_CAP_SECONDS = 30.0;

/**
 * Waits before retry attempts 1..N: base, base*2, ... capped at `cap`.
 *
 * `backoffDelays(6)` → `[2, 4, 8, 16, 30, 30]` (7 attempts total);
 * `backoffDelays(0)` → `[]` (a single attempt, no waiting). Pure
 * function — the retry loop's only timing input, so tests stay fast.
 */
export function backoffDelays(
  retries: number,
  base = BACKOFF_BASE_SECONDS,
  cap = BACKOFF_CAP_SECONDS,
): number[] {
  return Array.from({ length: Math.max(0, retries) }, (_, i) => Math.min(base * 2 ** i, cap));
}

// ---------------------------------------------------------------------------
// retry policy inputs: overflow, Retry-After, error classification
// (ported from pi-ai's utils/overflow.ts, utils/provider-retry.ts and
// utils/retry.ts — MIT)
// ---------------------------------------------------------------------------

/** Longest provider-requested delay honored from a `Retry-After` header (seconds). */
export const RETRY_AFTER_CAP_SECONDS = 120;

/**
 * Parse a `Retry-After` header (delta-seconds or HTTP-date) into seconds,
 * clamped to `[0, RETRY_AFTER_CAP_SECONDS]`. `undefined` for absent, empty
 * or unparseable values, so the caller keeps its own backoff.
 */
export function parseRetryAfterSeconds(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (value === null || value === undefined) return undefined;
  const text = value.trim();
  if (text === "") return undefined;
  const seconds = Number(text);
  const delay = Number.isFinite(seconds) ? seconds : (Date.parse(text) - now) / 1000;
  if (!Number.isFinite(delay)) return undefined;
  return Math.min(Math.max(delay, 0), RETRY_AFTER_CAP_SECONDS);
}

/**
 * Error text meaning "the input exceeded the model's context window". Covers
 * the OpenAI-compatible shapes this client targets (`context_length_exceeded`,
 * "maximum context length", "exceeds the context window") plus the common
 * provider spellings pi-ai recognizes.
 */
const OVERFLOW_PATTERNS: readonly RegExp[] = [
  /prompt (?:is )?too long/i,
  /prompt exceeds max length/i,
  /request_too_large/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i,
  /context window exceeded/i,
  /input token count.*exceeds the maximum/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i,
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i,
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i,
  /exceeds the limit of \d+/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /too large for model with \d+ maximum context length/i,
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i,
  /model_context_window_exceeded/i,
  /prompt too long; exceeded (?:max )?context length/i,
  /range of input length should be/i,
  /context[_ ]length[_ ]exceeded/i,
  /too many tokens/i,
  /token limit exceeded/i,
  /^(?:[\w -]+ API error \(413\):|413(?:\s|:|$))/i,
];

/** Throttling lookalikes that mention tokens without being overflow. */
const NON_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /^(?:Throttling error|Service unavailable):/i,
  /rate limit/i,
  /too many requests/i,
];

/** True when provider error text describes a context-window overflow. */
export function isContextOverflowMessage(message: string): boolean {
  if (!message) return false;
  if (NON_OVERFLOW_PATTERNS.some((pattern) => pattern.test(message))) return false;
  return OVERFLOW_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * True when a failed response is a context-window/request-size overflow:
 * an HTTP 413 (request too large by definition) or an overflow-shaped body.
 */
export function isContextOverflowError(status: number | undefined, message: string): boolean {
  if (status === 413 && !NON_OVERFLOW_PATTERNS.some((pattern) => pattern.test(message))) {
    return true;
  }
  return isContextOverflowMessage(message);
}

function providerErrorPattern(patterns: readonly string[]): RegExp {
  return new RegExp(patterns.join("|"), "i");
}

/**
 * Quota/billing/plan exhaustion sent as 429 or an error code: retrying only
 * hammers the account, and these limits reset after hours, not seconds.
 */
const NON_RETRYABLE_PROVIDER_LIMIT_PATTERN = providerErrorPattern([
  "GoUsageLimitError",
  "FreeUsageLimitError",
  "Monthly usage limit reached",
  "available balance",
  "insufficient_quota",
  "out of budget",
  "quota exceeded",
  "billing",
  "subscription_sharing_usage_limit_exceeded",
  "subscription_sharing_workplace_individual_usage_limit_exceeded",
  '"code"\\s*:\\s*"?1308(?![0-9])',
]);

/**
 * Provider-specific transient error types, matched on the label the native
 * adapters put in front of the provider's own message (`Anthropic API error
 * 529 (overloaded_error): …`, `Google API error 400 (INTERNAL): …`). A
 * body-level verdict wins over an unusual HTTP status, e.g. a proxy that
 * relays an upstream outage as 400.
 */
const PROVIDER_TRANSIENT_ERROR_PATTERN = new RegExp(
  [
    "Anthropic API error \\d+ \\((?:overloaded_error|rate_limit_error|api_error)\\)",
    "Google API error \\d+ \\((?:RESOURCE_EXHAUSTED|UNAVAILABLE|INTERNAL|DEADLINE_EXCEEDED|ABORTED|UNKNOWN)\\)",
  ].join("|"),
  "i",
);

/** Provider-specific rejection types: a resend cannot fix the request. */
const PROVIDER_REJECTED_ERROR_PATTERN = new RegExp(
  [
    "Anthropic API error \\d+ \\((?:authentication_error|permission_error|not_found_error|invalid_request_error|billing_error)\\)",
    "Google API error \\d+ \\((?:INVALID_ARGUMENT|FAILED_PRECONDITION|PERMISSION_DENIED|UNAUTHENTICATED|NOT_FOUND|ALREADY_EXISTS|OUT_OF_RANGE|CANCELLED)\\)",
  ].join("|"),
  "i",
);

/** Transient provider or transport wording that is worth another attempt. */
const RETRYABLE_TRANSPORT_PATTERN = providerErrorPattern([
  "overloaded",
  "server_busy",
  "servers are currently busy",
  "currently experiencing high demand",
  "model is at capacity",
  "rate.?limit",
  "too many requests",
  "service.?(?:is.?)?(?:temporarily.?)?unavailable",
  "server.?error",
  "internal.?error",
  "provider.?returned.?(?:an.?)?error",
  "exceeded request buffer limit while retrying upstream",
  "unable to forward upstream",
  "upstream.?request.?failed",
  "upstream.?connect",
  "upstream_stream_read_error",
  "stream was interrupted",
  "stream disconnected before completion",
  "ended without",
  "http/?2 stream failed",
  "http2 request did not get a response",
  "network.?error",
  "connection.?error",
  "connection.?refused",
  "connection.?lost",
  "other side closed",
  "socket hang up",
  "socket connection was closed",
  "reset before headers",
  "fetch failed",
  "request to \\S+ failed, reason:",
  "getaddrinfo",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "timed? out",
  "timeout",
  "terminated",
  "websocket.?closed",
  "websocket.?error",
  "pending stream has been canceled",
  "retry delay",
  "you can retry your request",
  "try your request again",
  "please retry your request",
  "ResourceExhausted",
  "subscription_sharing_usage_unavailable",
  "subscription_sharing_user_unavailable",
]);

/** Raised when the run's cancel signal fires; never retried, never swallowed. */
export class ProviderAbortError extends Error {
  constructor(message = "run cancelled") {
    super(message);
    this.name = "AbortError";
  }
}

/**
 * One attempt exceeded `ProviderConfig.timeout`. Retryable (like a transport
 * failure); the retry loop warns once per such attempt through `onWarning`,
 * because a small timeout is the usual cause of a slow-model failure.
 */
export class ProviderTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderTimeoutError";
  }
}

/** Timeout-retry warnings a single provider instance may emit (`--timeout` hint). */
export const MAX_TIMEOUT_WARNINGS = 3;

/** HTTP failure from the endpoint; `retryable`/`reason` pin the classification. */
export class ProviderHttpError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  /** Stable label from `PROVIDER_ERROR_REGISTRY` (e.g. "client-error"). */
  readonly reason: string;
  /** Provider-requested delay from `Retry-After`, already capped; else undefined. */
  readonly retryAfterSeconds?: number;

  constructor(
    status: number,
    message: string,
    retryable: boolean,
    reason?: string,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ProviderHttpError";
    this.status = status;
    this.retryable = retryable;
    this.reason = reason ?? (retryable ? "http-retryable" : "http-fatal");
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * The request exceeded the model's context window. Never retried: callers
 * should compact the context and run again, not resend the same request.
 */
export class ProviderContextOverflowError extends ProviderHttpError {
  constructor(status: number, message: string) {
    super(status, message, false, "context-overflow");
    this.name = "ProviderContextOverflowError";
  }
}

export type ProviderErrorKind = "retryable" | "fatal";

/** Inputs a classification rule may inspect. */
export interface ProviderErrorContext {
  /** HTTP status, when the failure came from a response. */
  status?: number;
  /** Provider/transport error text (response body included). */
  message: string;
  /** Response headers, when available (`x-should-retry` override). */
  headers?: Headers;
}

/** One ordered entry of the provider error registry. */
export interface ProviderErrorRule {
  readonly kind: ProviderErrorKind;
  /** Stable label, surfaced as `ProviderErrorClassification.reason`. */
  readonly reason: string;
  matches(context: ProviderErrorContext): boolean;
}

export interface ProviderErrorClassification {
  /** Whether the retry loop may attempt the call again. */
  readonly retryable: boolean;
  readonly reason: string;
}

/**
 * Ordered retry classification. First match wins: explicit provider guidance,
 * overflow, then quota/billing exhaustion (fatal), provider-specific error
 * types from the native adapters, HTTP statuses, then transport wording.
 * Unrecognized failures are fatal so a deterministic error fails fast instead
 * of burning the retry budget.
 */
export const PROVIDER_ERROR_REGISTRY: readonly ProviderErrorRule[] = [
  {
    kind: "retryable",
    reason: "provider-requested-retry",
    matches: ({ headers }) => headers?.get("x-should-retry") === "true",
  },
  {
    kind: "fatal",
    reason: "provider-requested-fail",
    matches: ({ headers }) => headers?.get("x-should-retry") === "false",
  },
  {
    kind: "fatal",
    reason: "context-overflow",
    matches: ({ status, message }) => isContextOverflowError(status, message),
  },
  {
    kind: "fatal",
    reason: "provider-limit",
    matches: ({ message }) => NON_RETRYABLE_PROVIDER_LIMIT_PATTERN.test(message),
  },
  {
    kind: "retryable",
    reason: "provider-transient",
    matches: ({ message }) => PROVIDER_TRANSIENT_ERROR_PATTERN.test(message),
  },
  {
    kind: "fatal",
    reason: "provider-rejected",
    matches: ({ message }) => PROVIDER_REJECTED_ERROR_PATTERN.test(message),
  },
  { kind: "retryable", reason: "request-timeout", matches: ({ status }) => status === 408 },
  { kind: "retryable", reason: "conflict", matches: ({ status }) => status === 409 },
  { kind: "retryable", reason: "rate-limit", matches: ({ status }) => status === 429 },
  {
    kind: "retryable",
    reason: "server-error",
    matches: ({ status }) => status !== undefined && status >= 500,
  },
  {
    kind: "fatal",
    reason: "client-error",
    matches: ({ status }) => status !== undefined && status >= 400 && status < 500,
  },
  {
    kind: "retryable",
    reason: "transport",
    matches: ({ message }) => RETRYABLE_TRANSPORT_PATTERN.test(message),
  },
  { kind: "fatal", reason: "unclassified", matches: () => true },
];

/** Classify a failure context through the ordered registry. */
export function classifyProviderErrorContext(
  context: ProviderErrorContext,
): ProviderErrorClassification {
  for (const rule of PROVIDER_ERROR_REGISTRY) {
    if (rule.matches(context)) {
      return { retryable: rule.kind === "retryable", reason: rule.reason };
    }
  }
  return { retryable: false, reason: "unclassified" };
}

/**
 * Classify any thrown failure. Aborts are never retried; HTTP errors carry
 * the verdict computed when the response arrived; other errors are matched
 * by message (transport wording is retryable, everything else is fatal).
 */
export function classifyProviderError(error: unknown): ProviderErrorClassification {
  if (error instanceof ProviderAbortError) return { retryable: false, reason: "aborted" };
  if (error instanceof ProviderHttpError) {
    return { retryable: error.retryable, reason: error.reason };
  }
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return classifyProviderErrorContext({ message });
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------------
// model discovery (`two-brothers models`)
// ---------------------------------------------------------------------------

/** Default timeout for the `GET /models` discovery request. */
export const MODELS_TIMEOUT_SECONDS = 10;

/** One model an endpoint reports: `id` plus the optional owner label. */
export interface RemoteModel {
  id: string;
  owned_by?: string;
}

export interface ListModelsOptions {
  /** Bearer token for endpoints that require one (never logged). */
  apiKey?: string;
  /** Request timeout in seconds (default `MODELS_TIMEOUT_SECONDS`). */
  timeoutSeconds?: number;
  fetchImpl?: FetchLike;
}

/** Unwrap the transport error's `cause` (Node reports `fetch failed` + cause). */
function describeFetchError(exc: unknown): string {
  if (!(exc instanceof Error)) return String(exc);
  const cause = (exc as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message) return `${exc.message} (${cause.message})`;
  const code = (cause as { code?: unknown } | undefined)?.code;
  if (typeof code === "string" && code) return `${exc.message} (${code})`;
  return exc.message;
}

/** Tolerant read of a models payload: array, `{data: [...]}` or `{models: [...]}`. */
function modelEntries(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (isRecord(payload)) {
    for (const key of ["data", "models"]) {
      const value = payload[key];
      if (Array.isArray(value)) return value;
    }
  }
  return null;
}

function entryModel(raw: unknown): RemoteModel | null {
  if (typeof raw === "string" && raw.trim()) return { id: raw.trim() };
  if (!isRecord(raw)) return null;
  const rawId = raw.id ?? raw.name;
  if (typeof rawId !== "string" || !rawId.trim()) return null;
  const id = rawId.trim().replace(/^models\//, "");
  const owner = raw.owned_by ?? raw.ownedBy;
  return typeof owner === "string" && owner.trim()
    ? { id, owned_by: owner.trim() }
    : { id };
}

/**
 * List the models an OpenAI-compatible endpoint reports (`GET {base}/models`),
 * optionally with a Bearer token. One bounded ~10 s request — no retry loop
 * (discovery is an explicit operator command and should fail fast). Errors
 * carry a clean message the CLI prints verbatim: an unreachable host, a
 * timeout, a non-2xx response or an unrecognized payload.
 */
export async function listModels(
  baseUrl: string,
  options: ListModelsOptions = {},
): Promise<RemoteModel[]> {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (!base) throw new Error("base url is required");
  const url = `${base}/models`;
  const timeout = options.timeoutSeconds ?? MODELS_TIMEOUT_SECONDS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout * 1000);
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
    let response: Response;
    try {
      response = await fetchImpl(url, { method: "GET", headers, signal: controller.signal });
    } catch (exc) {
      if (controller.signal.aborted) {
        throw new Error(`request to ${url} timed out after ${timeout}s`);
      }
      throw new Error(`cannot reach ${url}: ${describeFetchError(exc)}`);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const body = detail.trim().slice(0, 300) || response.statusText || "(no body)";
      throw new Error(`HTTP ${response.status} from ${url}: ${body}`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`unexpected response from ${url}: not JSON`);
    }
    const entries = modelEntries(payload);
    if (entries === null) {
      throw new Error(
        `unexpected response from ${url}: expected an array or a {data: [...]} object`,
      );
    }
    const models: RemoteModel[] = [];
    for (const entry of entries) {
      const model = entryModel(entry);
      if (model) models.push(model);
    }
    return models;
  } finally {
    clearTimeout(timer);
  }
}

export interface Sleeper {
  (seconds: number): Promise<void>;
}

const defaultSleeper: Sleeper = (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

interface ChatCompletionJson {
  choices?: Array<{ message?: { content?: string | null; tool_calls?: unknown } }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Constructor config for the fetch-based providers: `model` is required here. */
export interface ModelProviderConfig extends ProviderConfig {
  model: string;
  backoffBase?: number;
  backoffCap?: number;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  sleeper?: Sleeper;
}

/** One provider error body normalized for the retry registry. */
export interface ProviderErrorDetail {
  /** Message surfaced on the thrown error, provider text included. */
  message: string;
  /** Set when the adapter recognizes a context-window overflow. */
  overflow?: boolean;
}

/**
 * One Server-Sent Events frame: the `event:` name (Anthropic sends one) and
 * the joined `data:` payload. A frame without `data` is still handed to the
 * adapter when it named an event.
 */
export interface SseFrame {
  event?: string;
  data: string;
}

/**
 * Per-attempt accumulator for a streamed completion. The base owns `text`
 * (every visible text delta the adapter emits lands here in arrival order) and
 * `thinking` (reasoning deltas, kept separate and never returned as reply
 * content); adapters extend the shape with their own usage/tool-call state and
 * cast inside the `streamEvent`/`streamResult` hooks.
 */
export interface StreamState {
  /** Concatenated visible text deltas, in arrival order. */
  text: string;
  /**
   * Concatenated reasoning/thinking deltas, in arrival order. Observational
   * only: `streamResult` never includes this, so the resolved reply matches
   * what a non-streaming call would return.
   */
  thinking: string;
}

/** The earliest blank-line frame boundary, or null while a frame is incomplete. */
function nextSseBoundary(buffer: string): { start: number; end: number } | null {
  let found: { start: number; end: number } | null = null;
  for (const separator of ["\r\n\r\n", "\n\n", "\r\r"]) {
    const at = buffer.indexOf(separator);
    if (at >= 0 && (found === null || at < found.start)) {
      found = { start: at, end: at + separator.length };
    }
  }
  return found;
}

/**
 * Parse one raw SSE frame block (`field: value` lines, `:` comments, blank
 * lines already stripped). Null when the block carries neither data nor an
 * event name — e.g. a keep-alive comment.
 */
function parseSseFrame(block: string): SseFrame | null {
  const data: string[] = [];
  let event: string | undefined;
  for (const line of block.split(/\r\n|\n|\r/)) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon >= 0 ? line.slice(0, colon) : line;
    let value = colon >= 0 ? line.slice(colon + 1) : "";
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0 && event === undefined) return null;
  return { event, data: data.join("\n") };
}

/**
 * Cap on the as-yet unframed text buffered for the JSON-completion fallback.
 * A response that advertises SSE but never sends a frame only needs its body
 * kept while there is no frame yet; anything larger than this (a pathological
 * endless non-frame stream) keeps the historical empty-stream behavior rather
 * than growing without bound.
 */
const MAX_JSON_FALLBACK_CHARS = 1_000_000;

/**
 * Shared HTTP plumbing for the fetch-based providers: the owned retry loop
 * (at most `retries + 1` attempts, exponential backoff, abortable between
 * attempts and inside the in-flight request, `Retry-After` honored), the
 * per-attempt timeout and error classification through
 * `PROVIDER_ERROR_REGISTRY`. Subclasses supply only the wire mapping (URL,
 * headers, body, response parsing, usage extraction and provider-specific
 * error-body normalization), so every family shares the same retry semantics
 * and `UsageTracker`.
 *
 * Streaming rides the same attempt: `attempt` requests the adapter's stream
 * URL/body when a delta sink is present, consumes SSE frames until the adapter
 * (or `[DONE]`) completes the stream, and hands the adapter's
 * non-streaming-shaped result to the unchanged `chat`/`chatWithTools` parsing.
 * The attempt timer is only cleared after the stream ends, so the timeout
 * bounds the whole response. An endpoint that ignores the stream request and
 * answers with a normal JSON completion is accepted via the non-SSE fallback
 * (`readJsonCompletion` / the EOF check in `consumeStream`): same result shape,
 * no deltas, same retry/error classification.
 */
export abstract class BaseHttpProvider implements Provider {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly temperature: number;
  readonly timeout: number;
  readonly retries: number;
  readonly backoffBase: number;
  readonly backoffCap: number;
  readonly usage = new UsageTracker();
  /** Output-token cap (`--max-tokens`); undefined keeps the provider default. */
  readonly maxTokens?: number;

  private readonly runSignal?: AbortSignal;
  private readonly fetchImpl: FetchLike;
  private readonly sleeper: Sleeper;
  /** Per-instance diagnostics sink (subclasses may use it for their own warns). */
  protected readonly onWarning: (line: string) => void;
  private timeoutWarnings = 0;

  constructor(cfg: ModelProviderConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
    this.apiKey = cfg.apiKey ?? "";
    this.model = cfg.model;
    this.temperature = cfg.temperature;
    this.timeout = cfg.timeout;
    this.retries = Math.max(0, Math.trunc(cfg.retries ?? 6));
    this.backoffBase = cfg.backoffBase ?? BACKOFF_BASE_SECONDS;
    this.backoffCap = cfg.backoffCap ?? BACKOFF_CAP_SECONDS;
    this.maxTokens =
      cfg.maxTokens !== undefined && Number.isFinite(cfg.maxTokens) && cfg.maxTokens > 0
        ? Math.trunc(cfg.maxTokens)
        : undefined;
    this.runSignal = cfg.signal;
    this.fetchImpl = cfg.fetchImpl ?? ((url, init) => fetch(url, init));
    this.sleeper = cfg.sleeper ?? defaultSleeper;
    this.onWarning = cfg.onWarning ?? ((line) => console.error(line));
  }

  /** The run's usage so far; merge with other roles' snapshots for a run total. */
  usageSnapshot(): UsageTotals {
    return this.usage.snapshot();
  }

  abstract chat(messages: ChatMessage[], responseKind?: string, signal?: AbortSignal): Promise<string>;

  abstract chatWithTools(
    messages: ChatMessage[],
    tools: Tool[],
    options?: ToolChatOptions,
  ): Promise<ToolChatResponse>;

  /** The completion endpoint for this provider family. */
  protected abstract requestUrl(): string;

  /** Request headers, auth included. */
  protected abstract requestHeaders(): Record<string, string>;

  /** The request body for one completion attempt. */
  protected abstract requestBody(
    messages: ChatMessage[],
    tools: Tool[] | undefined,
  ): Record<string, unknown>;

  /** Record one successful response's token usage. */
  protected abstract recordUsage(data: unknown): void;

  /**
   * Normalize a failed response into the text the registry classifies. The
   * default is the OpenAI-compatible wording; adapter subclasses add their
   * provider's error type/status and detect overflow from the raw body.
   */
  protected describeError(status: number, detail: string, statusText: string): ProviderErrorDetail {
    const message = `HTTP ${status} from ${this.requestUrl()}: ${detail || statusText}`;
    return { message, overflow: isContextOverflowError(status, message) };
  }

  /**
   * URL for a streamed attempt. Google overrides it with
   * `:streamGenerateContent?alt=sse`; the other families stream from their
   * normal completion endpoint.
   */
  protected streamUrl(): string {
    return this.requestUrl();
  }

  /**
   * Extra request-body fields for a streamed attempt: `stream: true` (plus
   * OpenAI's `stream_options.include_usage` so the final chunk carries usage).
   */
  protected streamBodyExtras(): Record<string, unknown> {
    return {};
  }

  /** A fresh accumulator for one streamed attempt (adapter-owned shape). */
  protected newStreamState(): StreamState {
    return { text: "", thinking: "" };
  }

  /**
   * Consume one SSE frame into `state`, delivering deltas through `emit`:
   * `emit(delta)` for visible text (the default kind), `emit(delta,
   * "thinking")` for reasoning. Returns true when the adapter knows the stream
   * is complete.
   */
  protected streamEvent(
    _state: StreamState,
    _frame: SseFrame,
    _emit: (delta: string, kind?: ChatDeltaKind) => void,
  ): boolean {
    return false;
  }

  /**
   * The response JSON assembled from one stream, shaped exactly like the
   * non-streaming response so `chat`/`chatWithTools`/`recordUsage` stay
   * unchanged.
   */
  protected streamResult(_state: StreamState): unknown {
    throw new Error(`streaming is not supported by ${this.requestUrl()}`);
  }

  private checkAbort(signal?: AbortSignal): void {
    if (signal?.aborted || this.runSignal?.aborted) {
      throw new ProviderAbortError();
    }
  }

  /** Sleep `delay` seconds, waking promptly when the run is stopped. */
  private async wait(delay: number, signal?: AbortSignal): Promise<void> {
    let remaining = delay;
    while (remaining > 0) {
      this.checkAbort(signal);
      const step = Math.min(remaining, 0.05);
      await this.sleeper(step);
      remaining -= step;
    }
  }

  /**
   * The owned retry loop shared by `chat` and `chatWithTools`: at most
   * `retries + 1` attempts, exponential backoff between them, abortable
   * between attempts and inside the in-flight request. Fatal failures throw
   * immediately; a retryable `ProviderHttpError` carrying a `Retry-After`
   * delay waits that long instead of the scheduled backoff. Either streaming
   * sink (`onDelta` text / `onThinkingDelta` reasoning) opts the attempt into
   * streaming; each attempt re-sends the full request, so no streaming state
   * survives a retry.
   */
  protected async complete(
    messages: ChatMessage[],
    tools: Tool[] | undefined,
    signal?: AbortSignal,
    options?: ChatOptions,
  ): Promise<unknown> {
    const delays = backoffDelays(this.retries, this.backoffBase, this.backoffCap);
    let attempt = 0;
    while (true) {
      this.checkAbort(signal);
      try {
        const data = await this.attempt(messages, tools, signal, options);
        this.recordUsage(data);
        return data;
      } catch (err) {
        if (err instanceof ProviderAbortError) throw err; // a stop must unwind, not retry
        if (!classifyProviderError(err).retryable) throw err; // fatal: fail fast with its message
        if (attempt >= delays.length) throw err;
        if (err instanceof ProviderTimeoutError) this.warnTimeout(attempt);
        const retryAfter = err instanceof ProviderHttpError ? err.retryAfterSeconds : undefined;
        await this.wait(retryAfter ?? delays[attempt], signal);
        attempt += 1;
      }
    }
  }

  /**
   * One stderr diagnostic per timed-out attempt that will be retried, capped
   * at `MAX_TIMEOUT_WARNINGS` per instance so a stubbornly slow endpoint
   * cannot flood the log. `attempt` is the zero-based index of the failure,
   * so the next try is `attempt + 2` of `retries + 1`.
   */
  private warnTimeout(attempt: number): void {
    if (this.timeoutWarnings >= MAX_TIMEOUT_WARNINGS) return;
    this.timeoutWarnings += 1;
    this.onWarning(
      `[warn] provider attempt timed out after ${this.timeout}s; ` +
        `retrying (attempt ${attempt + 2}/${this.retries + 1}) — ` +
        "consider --timeout for slow models",
    );
  }

  /**
   * True when a response advertises a Server-Sent Events stream. The parser is
   * chosen from this header: an SSE body must be consumed incrementally (deltas
   * are the point), so the streaming path never pre-reads it.
   */
  private isEventStream(response: Response): boolean {
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    return contentType.includes("text/event-stream");
  }

  /**
   * Non-streaming fallback for a streamed attempt whose endpoint ignored
   * `stream: true` and answered with a normal JSON completion (the repo's
   * scripted browser-E2E server and some OpenAI-compatible gateways do).
   * Returns the parsed body exactly as the non-streaming path would (the
   * adapter then parses it normally) and emits no deltas: streaming is
   * observational. A body that is not valid JSON fails loudly — the existing
   * retry/error classification decides what happens next — instead of silently
   * degrading to an empty reply.
   */
  private async readJsonCompletion(response: Response): Promise<unknown> {
    const text = await response.text();
    const parsed = parseJson(text);
    if (parsed === undefined) {
      const preview = text.replace(/\s+/g, " ").trim().slice(0, 200);
      throw new Error(
        `non-SSE response from ${this.requestUrl()} is not a JSON completion: ${preview}`,
      );
    }
    return parsed;
  }

  /**
   * Consume a successful streaming response: split SSE frames, hand each to
   * the adapter, stop at `[DONE]` or when the adapter reports completion, and
   * return the adapter's non-streaming-shaped result. Runs INSIDE the attempt
   * timer, so the per-attempt timeout bounds the whole stream — a stalled
   * stream aborts the controller and surfaces as a retryable timeout.
   *
   * Two sinks can be active: text deltas accumulate in `state.text` and go to
   * `onDelta`; thinking deltas accumulate in `state.thinking` (never in the
   * result) and go to `onThinkingDelta`. A missing sink simply skips delivery;
   * a throwing sink is swallowed: streaming is observational.
   *
   * Non-SSE fallback: when the response advertises SSE but the body is a plain
   * JSON completion (never an SSE frame — some gateways mislabel it), the
   * buffered body is parsed and returned like a non-streaming response. An
   * empty or non-JSON no-frame stream keeps the historical empty result; a
   * normal SSE stream (frames seen) is untouched.
   */
  private async consumeStream(response: Response, options?: ChatOptions): Promise<unknown> {
    const body = response.body;
    if (body === null) {
      throw new Error(`stream from ${this.streamUrl()} carried no body`);
    }
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const state = this.newStreamState();
    const onText = options?.onDelta;
    const onThinking = options?.onThinkingDelta;
    const emit = (delta: string, kind: ChatDeltaKind = "text"): void => {
      if (!delta) return;
      if (kind === "thinking") state.thinking += delta;
      else state.text += delta;
      const sink = kind === "thinking" ? onThinking : onText;
      if (sink === undefined) return;
      try {
        sink(delta);
      } catch {
        // a broken delta consumer never breaks the completion
      }
    };
    let finished = false;
    /** SSE frames handed to the adapter so far (DONE excluded). */
    let framesSeen = 0;
    /** Body text seen before the first frame, for the JSON fallback; bounded. */
    let unframed = "";
    let unframedOverflow = false;
    const rememberUnframed = (chunk: string): void => {
      if (framesSeen > 0 || chunk === "") return;
      if (unframed.length + chunk.length > MAX_JSON_FALLBACK_CHARS) {
        unframedOverflow = true;
        return;
      }
      unframed += chunk;
    };
    const dispatch = (block: string): void => {
      if (finished) return;
      const frame = parseSseFrame(block);
      if (frame === null) return;
      if (frame.data.trim() === "[DONE]") {
        finished = true;
        return;
      }
      framesSeen += 1;
      finished = this.streamEvent(state, frame, emit);
    };
    try {
      let buffer = "";
      while (!finished) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;
        rememberUnframed(chunk);
        let boundary = nextSseBoundary(buffer);
        while (boundary !== null && !finished) {
          const block = buffer.slice(0, boundary.start);
          buffer = buffer.slice(boundary.end);
          dispatch(block);
          boundary = nextSseBoundary(buffer);
        }
      }
      const tail = decoder.decode();
      buffer += tail;
      rememberUnframed(tail);
      if (!finished && buffer.trim() !== "") dispatch(buffer);
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    // A response that advertised SSE but carried a plain JSON completion never
    // produced a frame; recover it as a non-streaming response. Empty/garbage
    // no-frame streams keep the historical (empty) result.
    if (!finished && framesSeen === 0 && !unframedOverflow) {
      const parsed = parseJson(unframed.trim());
      if (parsed !== undefined) return parsed;
    }
    return this.streamResult(state);
  }

  /** One bounded HTTP attempt; rejects with ProviderHttpError / ProviderAbortError / timeouts. */
  private async attempt(
    messages: ChatMessage[],
    tools: Tool[] | undefined,
    signal?: AbortSignal,
    options?: ChatOptions,
  ): Promise<unknown> {
    const streaming = options?.onDelta !== undefined || options?.onThinkingDelta !== undefined;
    const url = streaming ? this.streamUrl() : this.requestUrl();
    const controller = new AbortController();
    const cancel = (): void => controller.abort();
    if (signal?.aborted || this.runSignal?.aborted) cancel();
    signal?.addEventListener("abort", cancel, { once: true });
    this.runSignal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, this.timeout * 1000);
    const headers = this.requestHeaders();
    const body = this.requestBody(messages, tools);
    if (streaming) {
      headers.Accept = "text/event-stream";
      Object.assign(body, this.streamBodyExtras());
    }
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        const { message, overflow } = this.describeError(
          response.status,
          detail,
          response.statusText,
        );
        if (overflow) throw new ProviderContextOverflowError(response.status, message);
        const { retryable, reason } = classifyProviderErrorContext({
          status: response.status,
          message,
          headers: response.headers,
        });
        throw new ProviderHttpError(
          response.status,
          message,
          retryable,
          reason,
          retryable ? parseRetryAfterSeconds(response.headers.get("retry-after")) : undefined,
        );
      }
      if (!streaming) return (await response.json()) as unknown;
      // Streaming requested but the endpoint answered with a normal JSON
      // completion (content-type not SSE): accept it like the non-streaming
      // path for this attempt, emitting no deltas. The fixture/server E2E
      // compatibility fallback — see the class/module docs.
      if (!this.isEventStream(response)) return await this.readJsonCompletion(response);
      return await this.consumeStream(response, options);
    } catch (err) {
      if (signal?.aborted || this.runSignal?.aborted) {
        throw new ProviderAbortError();
      }
      if (controller.signal.aborted) {
        throw new ProviderTimeoutError(`request to ${url} timed out after ${this.timeout}s`);
      }
      // A dropped/broken stream is a transport failure: wrap it with the
      // underlying cause so the registry's transport rules classify it.
      if (streaming && !(err instanceof ProviderHttpError)) {
        throw new Error(`stream from ${url} failed: ${describeFetchError(err)}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      this.runSignal?.removeEventListener("abort", cancel);
    }
  }
}

/** Per-attempt OpenAI stream accumulator: usage chunk + tool-call fragments. */
interface OpenAIStreamState extends StreamState {
  /** Latest `usage` object seen on a chunk (the final one under include_usage). */
  usage?: unknown;
  /** Tool-call fragments keyed by `choices[0].delta.tool_calls[].index`. */
  toolCalls: Map<number, { id: string; name: string; arguments: string }>;
}

/**
 * OpenAI-compatible chat provider over raw `fetch` — no SDK, so attempts and
 * backoff are owned by `BaseHttpProvider`. Retryable failures:
 * connection/transport errors, per-attempt timeouts, HTTP 408/409/429 and 5xx;
 * other 4xx, quota/billing exhaustion and context overflow fail fast (mirrors
 * `build_responder`'s fail-fast validation spirit — retrying a 401 seven times
 * would only hammer a misconfigured endpoint). A retryable response's
 * `Retry-After` header replaces that attempt's fixed backoff.
 *
 * Streaming: `stream: true` plus `stream_options.include_usage: true`;
 * `choices[0].delta.content` is emitted as visible text,
 * `delta.reasoning_content`/`delta.reasoning` go to the thinking sink (never
 * into the reply), `data: [DONE]` ends the stream, and the final chunk's
 * `usage` populates the same counters as the non-streaming path. Tool-call
 * fragments are reassembled by `index`.
 */
export class OpenAICompatibleProvider extends BaseHttpProvider {
  async chat(
    messages: ChatMessage[],
    _responseKind = "message",
    signal?: AbortSignal,
    options?: ChatOptions,
  ): Promise<string> {
    const data = await this.complete(messages, undefined, signal, options);
    const content = (data as ChatCompletionJson).choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error(
        `unexpected response shape from ${this.requestUrl()}: ${JSON.stringify(data)}`,
      );
    }
    return content;
  }

  async chatWithTools(
    messages: ChatMessage[],
    tools: Tool[],
    options: ToolChatOptions = {},
  ): Promise<ToolChatResponse> {
    const data = await this.complete(messages, tools, options.signal, options);
    const message = (data as ChatCompletionJson).choices?.[0]?.message;
    const content = message?.content;
    return {
      content: typeof content === "string" ? content : "",
      toolCalls: parseToolCalls((message as Record<string, unknown> | undefined)?.tool_calls),
    };
  }

  protected requestUrl(): string {
    return `${this.baseUrl}/chat/completions`;
  }

  protected requestHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  protected requestBody(
    messages: ChatMessage[],
    tools: Tool[] | undefined,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toWireMessages(messages),
      temperature: this.temperature,
    };
    // Only when configured: the OpenAI default stays the endpoint's own.
    if (this.maxTokens !== undefined) body.max_tokens = this.maxTokens;
    if (tools && tools.length > 0) body.tools = toolDefinitions(tools);
    return body;
  }

  protected recordUsage(data: unknown): void {
    this.usage.recordResponse(data);
  }

  protected override streamBodyExtras(): Record<string, unknown> {
    // include_usage asks for a final chunk with the same usage object the
    // non-streaming response carries.
    return { stream: true, stream_options: { include_usage: true } };
  }

  protected override newStreamState(): OpenAIStreamState {
    return { text: "", thinking: "", toolCalls: new Map() };
  }

  protected override streamEvent(
    state: StreamState,
    frame: SseFrame,
    emit: (delta: string, kind?: ChatDeltaKind) => void,
  ): boolean {
    const stream = state as OpenAIStreamState;
    const parsed = parseJson(frame.data);
    if (!isRecord(parsed)) return false;
    if (isRecord(parsed.usage)) stream.usage = parsed.usage;
    const choice = Array.isArray(parsed.choices) && isRecord(parsed.choices[0])
      ? parsed.choices[0]
      : undefined;
    const delta = choice !== undefined && isRecord(choice.delta) ? choice.delta : undefined;
    if (delta === undefined) return false;
    if (typeof delta.content === "string" && delta.content) emit(delta.content);
    // Reasoning models expose the model's thinking on a side channel: DeepSeek
    // and compatible servers use `reasoning_content`, others use `reasoning`.
    // Both stay out of `content`/`streamResult` — thinking is observational.
    for (const field of ["reasoning_content", "reasoning"] as const) {
      const reasoning = delta[field];
      if (typeof reasoning === "string" && reasoning) emit(reasoning, "thinking");
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const raw of delta.tool_calls) {
        if (!isRecord(raw)) continue;
        const index = coerceInt(raw.index ?? 0);
        const entry = stream.toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
        if (typeof raw.id === "string" && raw.id) entry.id = raw.id;
        const fn = isRecord(raw.function) ? raw.function : {};
        // OpenAI sends the full name in the first fragment; keep the first.
        if (typeof fn.name === "string" && fn.name && !entry.name) entry.name = fn.name;
        if (typeof fn.arguments === "string") entry.arguments += fn.arguments;
        stream.toolCalls.set(index, entry);
      }
    }
    return false;
  }

  protected override streamResult(state: StreamState): unknown {
    const stream = state as OpenAIStreamState;
    const calls = [...stream.toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call], index) => ({
        id: call.id || `call-${index + 1}`,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      }));
    const message: Record<string, unknown> = { content: stream.text };
    if (calls.length > 0) message.tool_calls = calls;
    const data: Record<string, unknown> = { choices: [{ message }] };
    if (stream.usage !== undefined) data.usage = stream.usage;
    return data;
  }
}

// ---------------------------------------------------------------------------
// Anthropic Messages API adapter (reference: pi-ai's anthropic-messages)
// ---------------------------------------------------------------------------

export const ANTHROPIC_VERSION = "2023-06-01";

/** Anthropic requires `max_tokens`; this is the cap when none is configured. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/**
 * Smallest `budget_tokens` the Messages API accepts for extended thinking; a
 * smaller configured budget is a configuration error, never silently raised.
 */
export const ANTHROPIC_MIN_THINKING_BUDGET = 1024;

/**
 * Output room the adapter keeps ABOVE an extended-thinking budget when the
 * configured `max_tokens` does not fit it. The API requires
 * `max_tokens > budget_tokens`, so the adapter raises its request cap to
 * `budget + headroom` and warns once (an operator's cap that already leaves
 * room — including a deliberately larger one — is sent untouched).
 */
export const ANTHROPIC_THINKING_MAX_TOKENS_HEADROOM = 1024;

const API_VERSION_SEGMENT = /\/v\d+(?:(?:alpha|beta)\d*)?$/i;

/**
 * `baseUrl` plus a version segment when the caller did not already include
 * one: `https://api.anthropic.com` → `/v1/messages`, while an explicit
 * `…/v1` (or `…/v1beta`) base is used as-is.
 */
function versionedApiUrl(baseUrl: string, version: string, path: string): string {
  return `${baseUrl}${API_VERSION_SEGMENT.test(baseUrl) ? "" : `/${version}`}${path}`;
}

interface AnthropicContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  signature?: string;
  data?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

/**
 * Our chat messages in the Messages API shape. The system prompt becomes the
 * top-level `system` string (all system messages merged, so it never rides in
 * `messages`), assistant `toolCalls` become `tool_use` blocks and tool results
 * become `tool_result` blocks answering the preceding `tool_use` turn.
 *
 * Extended thinking: an assistant turn's captured `thinkingBlocks` are echoed
 * back FIRST, verbatim (`{type: "thinking", thinking, signature}` or
 * `{type: "redacted_thinking", data}`), before the text and `tool_use` blocks —
 * the Messages API rejects a tool loop whose signed blocks were dropped or
 * altered. The blocks are replayed exactly as received (never re-sanitized or
 * trimmed) and other adapters never look at them.
 */
function anthropicMessages(messages: ChatMessage[]): {
  system: string;
  messages: Array<Record<string, unknown>>;
} {
  const systemParts: string[] = [];
  const wire: Array<Record<string, unknown>> = [];
  let lastWasToolResult = false;

  for (const message of messages) {
    if (message.role === "system") {
      if (message.content) systemParts.push(message.content);
      continue;
    }
    if (message.role === "assistant") {
      const blocks: Array<Record<string, unknown>> = [];
      for (const thinking of message.thinkingBlocks ?? []) {
        if (thinking.redacted !== undefined) {
          blocks.push({ type: "redacted_thinking", data: thinking.redacted });
        } else {
          blocks.push({
            type: "thinking",
            thinking: thinking.text,
            signature: thinking.signature,
          });
        }
      }
      if (message.content) blocks.push({ type: "text", text: message.content });
      for (const call of message.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.args ?? {} });
      }
      if (blocks.length === 0) continue;
      wire.push({ role: "assistant", content: blocks });
      lastWasToolResult = false;
      continue;
    }
    if (message.role === "tool") {
      const block = {
        type: "tool_result",
        tool_use_id: message.toolCallId ?? "",
        content: message.content,
      };
      // Several results answering one tool_use turn stay one user message.
      if (lastWasToolResult) {
        (wire[wire.length - 1].content as Array<Record<string, unknown>>).push(block);
      } else {
        wire.push({ role: "user", content: [block] });
      }
      lastWasToolResult = true;
      continue;
    }
    wire.push({ role: "user", content: [{ type: "text", text: message.content }] });
    lastWasToolResult = false;
  }

  return { system: systemParts.join("\n\n"), messages: wire };
}

/** `Tool` definitions in the Messages API shape (`input_schema`). */
function anthropicToolDefinitions(tools: Tool[]): unknown[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

function anthropicCompletion(data: unknown, url: string): ToolChatResponse {
  const blocks = (data as { content?: unknown } | null)?.content;
  if (!Array.isArray(blocks)) {
    throw new Error(`unexpected response shape from ${url}: ${JSON.stringify(data)}`);
  }
  const texts: string[] = [];
  const toolCalls: ToolCall[] = [];
  const thinkingBlocks: ThinkingBlock[] = [];
  for (const raw of blocks) {
    if (!isRecord(raw)) continue;
    const block = raw as AnthropicContentBlock;
    if (block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    } else if (block.type === "tool_use") {
      const args = isRecord(block.input) ? block.input : {};
      toolCalls.push({
        id: String(block.id ?? `call-${toolCalls.length + 1}`),
        name: String(block.name ?? ""),
        args,
      });
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      // Signed reasoning replay metadata, never part of the reply content.
      thinkingBlocks.push({ text: block.thinking, signature: String(block.signature ?? "") });
    } else if (block.type === "redacted_thinking" && typeof block.data === "string") {
      thinkingBlocks.push({ text: "", signature: "", redacted: block.data });
    }
  }
  return thinkingBlocks.length > 0
    ? { content: texts.join(""), toolCalls, thinkingBlocks }
    : { content: texts.join(""), toolCalls };
}

/**
 * Anthropic usage → our counters. `input_tokens` counts only uncached prompt
 * tokens (cache reads come back separately in `cache_read_input_tokens`);
 * `cache_creation_input_tokens` is a cache write, not a hit, so it is not
 * reported as cached.
 */
function anthropicUsage(data: unknown): Omit<UsageTotals, "model_calls"> {
  const usage = isRecord(data) && isRecord(data.usage) ? data.usage : {};
  return {
    input_tokens: coerceInt(usage.input_tokens),
    output_tokens: coerceInt(usage.output_tokens),
    cached_tokens: coerceInt(usage.cache_read_input_tokens),
  };
}

/**
 * One Anthropic content block being assembled from the stream. `thinking`
 * blocks hold extended-reasoning text: it is reported through the thinking
 * sink and never appears in the returned content text, while its signature is
 * kept for verbatim replay on the next tool-loop request.
 */
interface AnthropicStreamBlock {
  type: "text" | "tool_use" | "thinking";
  text: string;
  /** Accumulated `input_json_delta.partial_json` fragments (tool_use only). */
  json: string;
  id: string;
  name: string;
  /** Accumulated `signature_delta.signature` (thinking blocks only). */
  signature: string;
  /** Encrypted payload of a `redacted_thinking` start block, when present. */
  redacted: string;
}

/** Per-attempt Anthropic stream accumulator. */
interface AnthropicStreamState extends StreamState {
  /** Merged `usage` objects from message_start + message_delta. */
  usage: Record<string, unknown>;
  /** Content blocks keyed by `index`. */
  blocks: Map<number, AnthropicStreamBlock>;
}

/**
 * Anthropic Messages API provider over raw `fetch`. Errors carry the
 * provider's `error.type` label so the registry can classify body-level
 * verdicts (`overloaded_error` retryable, `authentication_error` fatal) even
 * when a proxy reports an unexpected HTTP status.
 *
 * Streaming: `stream: true`; `content_block_delta` text deltas are emitted as
 * they arrive (`thinking_delta` blocks go to the thinking sink and never into
 * the returned content), `message_delta.usage.output_tokens` completes the
 * usage `message_start` began, `message_stop` ends the stream. `tool_use`
 * blocks reassemble from `content_block_start` + `input_json_delta` fragments,
 * and extended-thinking blocks keep their `signature_delta` so the harness can
 * echo them verbatim on the next tool-loop request.
 *
 * Extended thinking (`ProviderConfig.thinkingBudgetTokens`): the request gains
 * `thinking: {type: "enabled", budget_tokens: N}`. The Messages API requires
 * `max_tokens > budget_tokens`; when the configured cap does not leave room the
 * adapter raises the request cap to `budget + ANTHROPIC_THINKING_MAX_TOKENS_HEADROOM`
 * and warns once (an explicit larger cap is sent untouched). The API also
 * rejects temperature/top_p while thinking is enabled, so `temperature` is
 * omitted on those requests (its default 1 applies). Unset keeps the request
 * byte-identical to the pre-thinking adapter, and no other adapter reads the
 * field.
 */
export class AnthropicProvider extends BaseHttpProvider {
  readonly maxTokens: number;
  /** Effective extended-thinking budget; undefined = thinking not requested. */
  readonly thinkingBudgetTokens?: number;
  private thinkingCapWarned = false;

  constructor(cfg: ModelProviderConfig) {
    super(cfg);
    this.maxTokens = Math.max(1, Math.trunc(cfg.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS));
    const requested = cfg.thinkingBudgetTokens;
    const normalized =
      requested !== undefined && Number.isFinite(requested) && requested > 0
        ? Math.trunc(requested)
        : undefined;
    if (normalized !== undefined && normalized < ANTHROPIC_MIN_THINKING_BUDGET) {
      throw new Error(
        `thinking budget ${normalized} is below the Anthropic minimum ` +
          `${ANTHROPIC_MIN_THINKING_BUDGET} tokens (--thinking-budget <n>)`,
      );
    }
    this.thinkingBudgetTokens = normalized;
  }

  /**
   * The `max_tokens` the next request sends. With extended thinking enabled the
   * API requires `max_tokens > budget_tokens`: a cap that does not leave room is
   * raised to `budget + headroom` and reported once through the provider's
   * warning sink (honest, not silent); a suitable cap is sent untouched.
   */
  private requestMaxTokens(): number {
    const budget = this.thinkingBudgetTokens;
    if (budget === undefined || budget < this.maxTokens) return this.maxTokens;
    const raised = budget + ANTHROPIC_THINKING_MAX_TOKENS_HEADROOM;
    if (!this.thinkingCapWarned) {
      this.thinkingCapWarned = true;
      this.onWarning(
        `[warn] thinking budget ${budget} needs max_tokens greater than it; ` +
          `sending max_tokens ${raised} (raise --max-tokens to choose the cap)`,
      );
    }
    return raised;
  }

  async chat(
    messages: ChatMessage[],
    _responseKind = "message",
    signal?: AbortSignal,
    options?: ChatOptions,
  ): Promise<string> {
    const data = await this.complete(messages, undefined, signal, options);
    return anthropicCompletion(data, this.requestUrl()).content;
  }

  async chatWithTools(
    messages: ChatMessage[],
    tools: Tool[],
    options: ToolChatOptions = {},
  ): Promise<ToolChatResponse> {
    const data = await this.complete(messages, tools, options.signal, options);
    return anthropicCompletion(data, this.requestUrl());
  }

  protected requestUrl(): string {
    return versionedApiUrl(this.baseUrl, "v1", "/messages");
  }

  protected override streamBodyExtras(): Record<string, unknown> {
    return { stream: true };
  }

  protected override newStreamState(): AnthropicStreamState {
    return { text: "", thinking: "", usage: {}, blocks: new Map() };
  }

  protected override streamEvent(
    state: StreamState,
    frame: SseFrame,
    emit: (delta: string, kind?: ChatDeltaKind) => void,
  ): boolean {
    const stream = state as AnthropicStreamState;
    const parsed = parseJson(frame.data);
    if (!isRecord(parsed)) return false;
    const type = typeof parsed.type === "string" ? parsed.type : frame.event;
    if (type === "error") {
      const error = isRecord(parsed.error) ? parsed.error : {};
      const label = typeof error.type === "string" ? error.type : "stream_error";
      const text = typeof error.message === "string" ? error.message : frame.data;
      // Registry wording ("overloaded", "rate limit", …) classifies this.
      throw new Error(`Anthropic stream error (${label}): ${text}`);
    }
    if (type === "message_start") {
      const message = isRecord(parsed.message) ? parsed.message : {};
      if (isRecord(message.usage)) Object.assign(stream.usage, message.usage);
      return false;
    }
    if (type === "content_block_start") {
      const index = coerceInt(parsed.index);
      const block = isRecord(parsed.content_block) ? parsed.content_block : {};
      // `thinking` blocks carry extended reasoning: they start no reply text
      // and are only reported through thinking_delta below, while their
      // signature is kept for verbatim replay.
      const blockType =
        block.type === "tool_use"
          ? "tool_use"
          : block.type === "thinking" || block.type === "redacted_thinking"
            ? "thinking"
            : "text";
      const started: AnthropicStreamBlock = {
        type: blockType,
        text:
          typeof block.text === "string"
            ? block.text
            : typeof block.thinking === "string"
              ? block.thinking
              : "",
        json: "",
        id: typeof block.id === "string" ? block.id : "",
        name: typeof block.name === "string" ? block.name : "",
        signature: typeof block.signature === "string" ? block.signature : "",
        // A redacted block arrives whole at start: its encrypted payload is
        // opaque and must be echoed back verbatim, never parsed.
        redacted:
          block.type === "redacted_thinking" && typeof block.data === "string"
            ? block.data
            : "",
      };
      if (started.type === "text" && started.text) emit(started.text);
      stream.blocks.set(index, started);
      return false;
    }
    if (type === "content_block_delta") {
      const index = coerceInt(parsed.index);
      const delta = isRecord(parsed.delta) ? parsed.delta : {};
      const block = stream.blocks.get(index) ?? {
        type: "text" as const,
        text: "",
        json: "",
        id: "",
        name: "",
        signature: "",
        redacted: "",
      };
      if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        block.type = "thinking";
        // Thinking is reported to the thinking sink only; its text is ALSO
        // accumulated on the block so `streamResult` can hand the signed block
        // to `anthropicCompletion` for tool-loop passback. It never joins the
        // returned reply content.
        if (delta.thinking) {
          block.text += delta.thinking;
          emit(delta.thinking, "thinking");
        }
      } else if (delta.type === "signature_delta" && typeof delta.signature === "string") {
        // Opaque replay metadata: accumulated (never emitted as text) so the
        // next tool-loop request can echo the signed block verbatim.
        block.type = "thinking";
        block.signature += delta.signature;
      } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        block.json += delta.partial_json;
      } else if (typeof delta.text === "string") {
        block.type = "text";
        block.text += delta.text;
        emit(delta.text);
      }
      stream.blocks.set(index, block);
      return false;
    }
    if (type === "message_delta") {
      if (isRecord(parsed.usage)) Object.assign(stream.usage, parsed.usage);
      return false;
    }
    return type === "message_stop";
  }

  protected override streamResult(state: StreamState): unknown {
    const stream = state as AnthropicStreamState;
    const content: Array<Record<string, unknown>> = [];
    for (const [, block] of [...stream.blocks.entries()].sort(([a], [b]) => a - b)) {
      if (block.type === "tool_use") {
        const parsed = parseJson(block.json);
        content.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: isRecord(parsed) ? parsed : {},
        });
      } else if (block.type === "thinking") {
        // Signed reasoning: its text never joins the reply, but the assembled
        // response carries it in the same shape the non-streaming API uses, so
        // `anthropicCompletion` exposes the block for tool-loop passback.
        if (block.redacted) {
          content.push({ type: "redacted_thinking", data: block.redacted });
        } else if (block.text || block.signature) {
          content.push({
            type: "thinking",
            thinking: block.text,
            signature: block.signature,
          });
        }
      } else if (block.text) {
        content.push({ type: "text", text: block.text });
      }
    }
    if (content.length === 0 && stream.text) content.push({ type: "text", text: stream.text });
    return { content, usage: stream.usage };
  }

  protected requestHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": ANTHROPIC_VERSION,
    };
    if (this.apiKey) headers["x-api-key"] = this.apiKey;
    return headers;
  }

  protected requestBody(
    messages: ChatMessage[],
    tools: Tool[] | undefined,
  ): Record<string, unknown> {
    const { system, messages: wire } = anthropicMessages(messages);
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.requestMaxTokens(),
      messages: wire,
    };
    if (system) body.system = system;
    // Extended thinking: the Messages API does not accept temperature/top_p
    // when thinking is enabled (its default temperature 1 applies), so the
    // field is omitted then. Without thinking this is exactly the pre-thinking
    // request body.
    if (this.thinkingBudgetTokens === undefined && Number.isFinite(this.temperature)) {
      body.temperature = this.temperature;
    }
    if (tools && tools.length > 0) body.tools = anthropicToolDefinitions(tools);
    if (this.thinkingBudgetTokens !== undefined) {
      // Extended thinking: the only wire difference the option adds. Absent =
      // the exact pre-thinking request (no `thinking` field).
      body.thinking = { type: "enabled", budget_tokens: this.thinkingBudgetTokens };
    }
    return body;
  }

  protected recordUsage(data: unknown): void {
    const usage = anthropicUsage(data);
    this.usage.record(usage.input_tokens, usage.output_tokens, usage.cached_tokens);
  }

  protected describeError(status: number, detail: string, statusText: string): ProviderErrorDetail {
    const parsed = parseJson(detail);
    const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : undefined;
    const type = typeof error?.type === "string" ? error.type : "";
    const text =
      typeof error?.message === "string" && error.message ? error.message : detail || statusText;
    const message = `Anthropic API error ${status}${type ? ` (${type})` : ""}: ${text}`;
    const overflow =
      type === "request_too_large" ||
      type === "context_length_exceeded" ||
      isContextOverflowError(status, text) ||
      isContextOverflowMessage(detail);
    return { message, overflow };
  }
}

// ---------------------------------------------------------------------------
// Google Gemini (Generative Language) adapter (reference: pi-ai's google-shared)
// ---------------------------------------------------------------------------

interface GooglePart {
  text?: string;
  thought?: boolean;
  functionCall?: { id?: string; name?: string; args?: unknown };
}

/**
 * Our chat messages in Gemini `contents` shape. System messages merge into
 * `systemInstruction`; assistant turns become `role: "model"` with
 * `functionCall` parts; tool results become `functionResponse` parts in a
 * user turn (named after the call they answer, recovered from the preceding
 * assistant turn since our transcript only carries the call id).
 */
function googleContents(messages: ChatMessage[]): {
  system: string;
  contents: Array<Record<string, unknown>>;
} {
  const systemParts: string[] = [];
  const contents: Array<Record<string, unknown>> = [];
  const toolNames = new Map<string, string>();

  for (const message of messages) {
    if (message.role === "system") {
      if (message.content) systemParts.push(message.content);
      continue;
    }
    if (message.role === "assistant") {
      const parts: Array<Record<string, unknown>> = [];
      if (message.content) parts.push({ text: message.content });
      for (const call of message.toolCalls ?? []) {
        toolNames.set(call.id, call.name);
        parts.push({ functionCall: { name: call.name, args: call.args ?? {} } });
      }
      if (parts.length > 0) contents.push({ role: "model", parts });
      continue;
    }
    if (message.role === "tool") {
      const part = {
        functionResponse: {
          name: toolNames.get(message.toolCallId ?? "") ?? "",
          response: { output: message.content },
        },
      };
      const last = contents[contents.length - 1];
      const lastParts = Array.isArray(last?.parts)
        ? (last.parts as Array<Record<string, unknown>>)
        : undefined;
      if (last?.role === "user" && lastParts?.some((p) => isRecord(p.functionResponse))) {
        lastParts.push(part);
      } else {
        contents.push({ role: "user", parts: [part] });
      }
      continue;
    }
    contents.push({ role: "user", parts: [{ text: message.content }] });
  }

  return { system: systemParts.join("\n\n"), contents };
}

/** `Tool` definitions as Gemini `functionDeclarations`. */
function googleToolDefinitions(tools: Tool[]): unknown[] {
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    },
  ];
}

function googleCompletion(data: unknown, url: string): ToolChatResponse {
  const candidates = (data as { candidates?: unknown } | null)?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error(`unexpected response shape from ${url}: ${JSON.stringify(data)}`);
  }
  const parts = (candidates[0] as { content?: { parts?: unknown } } | null)?.content?.parts;
  if (!Array.isArray(parts)) {
    throw new Error(`unexpected response shape from ${url}: ${JSON.stringify(data)}`);
  }
  const texts: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const raw of parts) {
    if (!isRecord(raw)) continue;
    const part = raw as GooglePart;
    // `thought` parts are the model's reasoning, not visible reply text.
    if (typeof part.text === "string" && part.thought !== true) texts.push(part.text);
    const call = part.functionCall;
    if (isRecord(call)) {
      const args = isRecord(call.args) ? call.args : {};
      toolCalls.push({
        id: String(call.id ?? `call-${toolCalls.length + 1}`),
        name: String(call.name ?? ""),
        args,
      });
    }
  }
  return { content: texts.join(""), toolCalls };
}

/**
 * Gemini usage → our counters. `promptTokenCount` includes cached content, so
 * the cached count is subtracted to keep `input_tokens` uncached (as in
 * pi-ai); thought tokens count as output.
 */
function googleUsage(data: unknown): Omit<UsageTotals, "model_calls"> {
  const meta = isRecord(data) && isRecord(data.usageMetadata) ? data.usageMetadata : {};
  const cached = coerceInt(meta.cachedContentTokenCount);
  return {
    input_tokens: Math.max(0, coerceInt(meta.promptTokenCount) - cached),
    output_tokens: coerceInt(meta.candidatesTokenCount) + coerceInt(meta.thoughtsTokenCount),
    cached_tokens: cached,
  };
}

/** Per-attempt Gemini stream accumulator. */
interface GoogleStreamState extends StreamState {
  /** Latest `usageMetadata` chunk (Gemini sends cumulative counts). */
  usageMetadata?: unknown;
  toolCalls: ToolCall[];
}

/**
 * Google Gemini API provider over raw `fetch`. The model name may be bare
 * (`gemini-2.5-pro`) or prefixed with `models/`. Errors carry `error.status`
 * (`RESOURCE_EXHAUSTED`, `INVALID_ARGUMENT`, …) so the registry can map
 * body-level verdicts, and `MAX_TOKENS` / token-count bodies are treated as
 * context overflow.
 *
 * Streaming switches the method to `:streamGenerateContent?alt=sse` (auth
 * stays the `x-goog-api-key` header, so no `key=` query is needed): each
 * chunk's non-thought `parts[].text` is emitted as visible text while
 * `thought: true` parts go to the thinking sink (never into the reply),
 * `usageMetadata` is taken from the latest chunk, and the last chunk's
 * `finishReason` is informational only — the HTTP stream's end terminates it.
 */
export class GoogleProvider extends BaseHttpProvider {
  readonly maxTokens?: number;

  constructor(cfg: ModelProviderConfig) {
    super(cfg);
    this.maxTokens =
      cfg.maxTokens !== undefined && cfg.maxTokens > 0 ? Math.trunc(cfg.maxTokens) : undefined;
  }

  async chat(
    messages: ChatMessage[],
    _responseKind = "message",
    signal?: AbortSignal,
    options?: ChatOptions,
  ): Promise<string> {
    const data = await this.complete(messages, undefined, signal, options);
    return googleCompletion(data, this.requestUrl()).content;
  }

  async chatWithTools(
    messages: ChatMessage[],
    tools: Tool[],
    options: ToolChatOptions = {},
  ): Promise<ToolChatResponse> {
    const data = await this.complete(messages, tools, options.signal, options);
    return googleCompletion(data, this.requestUrl());
  }

  protected requestUrl(): string {
    const model = this.model.replace(/^models\//, "");
    return versionedApiUrl(
      this.baseUrl,
      "v1beta",
      `/models/${encodeURIComponent(model)}:generateContent`,
    );
  }

  protected override streamUrl(): string {
    const model = this.model.replace(/^models\//, "");
    return versionedApiUrl(
      this.baseUrl,
      "v1beta",
      `/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
    );
  }

  protected override newStreamState(): GoogleStreamState {
    return { text: "", thinking: "", toolCalls: [] };
  }

  protected override streamEvent(
    state: StreamState,
    frame: SseFrame,
    emit: (delta: string, kind?: ChatDeltaKind) => void,
  ): boolean {
    const stream = state as GoogleStreamState;
    const parsed = parseJson(frame.data);
    if (!isRecord(parsed)) return false;
    if (isRecord(parsed.usageMetadata)) stream.usageMetadata = parsed.usageMetadata;
    const candidates = parsed.candidates;
    if (!Array.isArray(candidates) || !isRecord(candidates[0])) return false;
    const content = candidates[0].content;
    const parts = isRecord(content) ? content.parts : undefined;
    if (!Array.isArray(parts)) return false;
    for (const raw of parts) {
      if (!isRecord(raw)) continue;
      const part = raw as GooglePart;
      if (typeof part.text === "string" && part.text) {
        // `thought: true` parts are the model's reasoning: reported to the
        // thinking sink and never visible reply text.
        if (part.thought === true) emit(part.text, "thinking");
        else emit(part.text);
      }
      if (isRecord(part.functionCall)) {
        stream.toolCalls.push({
          id: String(part.functionCall.id ?? `call-${stream.toolCalls.length + 1}`),
          name: String(part.functionCall.name ?? ""),
          args: isRecord(part.functionCall.args) ? part.functionCall.args : {},
        });
      }
    }
    return false;
  }

  protected override streamResult(state: StreamState): unknown {
    const stream = state as GoogleStreamState;
    const parts: Array<Record<string, unknown>> = [];
    if (stream.text) parts.push({ text: stream.text });
    for (const call of stream.toolCalls) {
      parts.push({ functionCall: { name: call.name, args: call.args } });
    }
    const data: Record<string, unknown> = { candidates: [{ content: { parts } }] };
    if (stream.usageMetadata !== undefined) data.usageMetadata = stream.usageMetadata;
    return data;
  }

  protected requestHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers["x-goog-api-key"] = this.apiKey;
    return headers;
  }

  protected requestBody(
    messages: ChatMessage[],
    tools: Tool[] | undefined,
  ): Record<string, unknown> {
    const { system, contents } = googleContents(messages);
    const body: Record<string, unknown> = { contents };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    const generationConfig: Record<string, unknown> = {};
    if (Number.isFinite(this.temperature)) generationConfig.temperature = this.temperature;
    if (this.maxTokens !== undefined) generationConfig.maxOutputTokens = this.maxTokens;
    if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;
    if (tools && tools.length > 0) body.tools = googleToolDefinitions(tools);
    return body;
  }

  protected recordUsage(data: unknown): void {
    const usage = googleUsage(data);
    this.usage.record(usage.input_tokens, usage.output_tokens, usage.cached_tokens);
  }

  protected describeError(status: number, detail: string, statusText: string): ProviderErrorDetail {
    const parsed = parseJson(detail);
    const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : undefined;
    const code = typeof error?.status === "string" ? error.status : "";
    const text =
      typeof error?.message === "string" && error.message ? error.message : detail || statusText;
    const message = `Google API error ${status}${code ? ` (${code})` : ""}: ${text}`;
    const overflow =
      isContextOverflowError(status, text) ||
      /exceeds the maximum number of tokens/i.test(text) ||
      /\bMAX_TOKENS\b/.test(detail);
    return { message, overflow };
  }
}

function clip(text: string, limit = 120): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= limit ? collapsed : collapsed.slice(0, limit - 1) + "…";
}

/**
 * One scripted step for MockProvider's tool-calling mode: either a tool call
 * the model "makes" or a plain-text reply. Steps are consumed in order by
 * `chatWithTools`; when the script runs out the mock answers with its
 * deterministic payload (like `chat`). Mirrors the scripted fake chat models
 * the Python graph tests use, so work-mode tool loops are testable offline.
 */
export type MockScriptStep =
  | { tool: string; args: Record<string, unknown> }
  | { text: string };

/** Chunk size MockProvider uses to fake a token stream (no wire involved). */
export const MOCK_DELTA_CHARS = 24;

/**
 * Deterministic fake reasoning text. MockProvider streams this through
 * `ChatOptions.onThinkingDelta` (chunked like `MOCK_DELTA_CHARS`) before its
 * visible reply, when a thinking sink is present. It is never part of the
 * returned reply/payload.
 */
export const MOCK_REASONING =
  "Think it through: read the request, pick the structured reply shape and keep the answer grounded.";

/** Deliver `text` as fixed-size deltas when a sink is present; else a no-op. */
export function emitMockDeltas(text: string, onDelta?: (delta: string) => void): void {
  if (onDelta === undefined) return;
  for (let at = 0; at < text.length; at += MOCK_DELTA_CHARS) {
    onDelta(text.slice(at, at + MOCK_DELTA_CHARS));
  }
}

/**
 * Deliver the deterministic mock reasoning as thinking deltas, when a
 * thinking sink is present. Like `emitMockDeltas`, a call without the sink is
 * a no-op, so the pre-thinking MockProvider behavior is byte-identical.
 */
export function emitMockThinking(onThinkingDelta?: (delta: string) => void): void {
  if (onThinkingDelta === undefined) return;
  for (let at = 0; at < MOCK_REASONING.length; at += MOCK_DELTA_CHARS) {
    onThinkingDelta(MOCK_REASONING.slice(at, at + MOCK_DELTA_CHARS));
  }
}

export class MockProvider implements Provider {
  readonly usage = new UsageTracker();
  private readonly steps: MockScriptStep[];
  private stepCounter = 0;

  constructor(steps: MockScriptStep[] = []) {
    this.steps = [...steps];
  }

  /** The run's usage so far; merge with other roles' snapshots for a run total. */
  usageSnapshot(): UsageTotals {
    return this.usage.snapshot();
  }

  async chat(
    messages: ChatMessage[],
    responseKind = "message",
    _signal?: AbortSignal,
    options?: ChatOptions,
  ): Promise<string> {
    this.usage.record(...MOCK_USAGE);
    const text = messages.length > 0 ? String(messages[messages.length - 1].content ?? "") : "";
    const payload = this.buildPayload(text, responseKind || "message");
    // Deterministic fake reasoning first (only when a thinking sink is set),
    // then the visible reply deltas — the pre-thinking behavior without a sink.
    emitMockThinking(options?.onThinkingDelta);
    emitMockDeltas(payload, options?.onDelta);
    return payload;
  }

  async chatWithTools(
    messages: ChatMessage[],
    _tools: Tool[],
    options: ToolChatOptions = {},
  ): Promise<ToolChatResponse> {
    this.usage.record(...MOCK_USAGE);
    // Every scripted completion reasons first, including a tool-call step, so
    // a streamed tool loop carries thinking deltas before the call/text.
    emitMockThinking(options.onThinkingDelta);
    const step = this.steps.shift();
    if (step && "tool" in step) {
      this.stepCounter += 1;
      return {
        content: "",
        toolCalls: [{ id: `call-${this.stepCounter}`, name: step.tool, args: step.args }],
      };
    }
    if (step) {
      emitMockDeltas(step.text, options.onDelta);
      return { content: step.text, toolCalls: [] };
    }
    const text = messages.length > 0 ? String(messages[messages.length - 1].content ?? "") : "";
    const payload = this.buildPayload(text, options.responseKind || "message");
    emitMockDeltas(payload, options.onDelta);
    return { content: payload, toolCalls: [] };
  }

  private buildPayload(text: string, kind: string): string {
    const task = extractTask(text);
    const quoted = task ? clip(task) : "(no task)";

    let payload: Record<string, unknown>;
    if (kind === "consult") {
      payload = {
        task: quoted,
        ask: `What is the best way to solve the task: «${quoted}»?`,
        expect: "proposal",
        deadline_hint: "within the day",
      };
    } else if (kind === "delegation") {
      payload = {
        work: `Do part of the task: «${quoted}»`,
        acceptance: ["done", "checked against the criteria"],
        return: "deliverable",
        notes: "",
      };
    } else if (kind === "proposal") {
      payload = {
        title: `Plan for «${quoted}»`,
        answer: `For the task «${quoted}» I propose a step-by-step plan: first clarify the goals, then choose the approach, then implement and verify.`,
        rationale: "A step-by-step approach reduces risk and gives checkpoints.",
        risks: ["Incomplete requirements", "Shifting priorities"],
        confidence: 0.7,
        asks: ["Can we clarify the priorities?", "Are additional resources needed?"],
      };
    } else if (kind === "deliverable") {
      payload = {
        result: `Part of the task «${quoted}» is done: a prototype is written and a test is added.`,
        artifacts: ["proto.py", "test_proto.py"],
        notes: "Checked against the senior's criteria.",
        confidence: 0.8,
      };
    } else if (kind === "review") {
      const verdict = this.reviewVerdict(text);
      payload = {
        verdict,
        notes:
          verdict === "accept"
            ? "The proposal meets the criteria."
            : "Needs rework: add clarifications and a check.",
        points: verdict === "accept" ? [] : ["Collapse the details"],
      };
    } else if (kind === "decision") {
      payload = {
        decision: `Final decision on «${quoted}»: accept the junior's proposal with amendments, execute step by step and verify each step.`,
        rationale: "The senior took the junior's advice on step-by-step execution into account and checked it against the criteria.",
        confidence: 0.82,
        dissent: null,
        accepted_proposals: [`Plan for «${quoted}»`],
      };
    } else {
      payload = { text: quoted };
    }

    return JSON.stringify(payload);
  }

  private reviewVerdict(transcript: string): "accept" | "revise" {
    for (const needle of [
      '"verdict": "revise"',
      '"verdict":"revise"',
      '"verdict": "reject"',
      '"verdict":"reject"',
    ]) {
      if (transcript.includes(needle)) return "revise";
    }
    return "accept";
  }
}

export function buildProvider(cfg: ProviderConfig, role: string): Provider {
  if (cfg.provider === "mock") return new MockProvider();
  if (cfg.provider === "openai") {
    const model = cfg.model ?? (role === "senior" ? cfg.seniorModel : cfg.juniorModel);
    const common: ModelProviderConfig = { ...cfg, model, retries: cfg.retries ?? 6 };
    const kind = resolveProviderKind(cfg, role);
    if (kind === "anthropic") return new AnthropicProvider(common);
    if (kind === "google") return new GoogleProvider(common);
    if (kind === "openai-compatible") return new OpenAICompatibleProvider(common);
    throw new Error(`unknown provider kind: ${kind} (use ${PROVIDER_KIND_HINT})`);
  }
  throw new Error(`unknown provider: ${cfg.provider}`);
}
