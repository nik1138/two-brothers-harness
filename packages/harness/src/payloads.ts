/**
 * Zod payload schemas per protocol kind.
 * Mirrors the original prototype's payload models (removed 2026-11-04; see
 * git history) for consumers
 * that want strict shape validation — e.g. API boundaries and the future
 * structured-output contract.
 *
 * This is ADDITIVE to the tolerant pipeline: `parseModelOutput` /
 * `validateMessage` / `sanitizePayload` remain the authority at the model
 * boundary (PROTOCOL.md §11). These schemas are strict instead: unknown keys
 * are stripped (pydantic `extra="ignore"`), missing keys get the same
 * defaults as the Python models, and confidence must be within [0, 1]
 * (clamping of out-of-range values stays a `sanitizePayload` concern).
 * `relaxedStrictPayload` below additionally lets the strict check accept a
 * JSON object found anywhere in a raw reply (bare, fenced, prose-wrapped)
 * when it passes the same strict validation — extraction is relaxed, the
 * validation bar is not.
 *
 * Note: the delegation wire key is `return` (PROTOCOL.md section 4); the
 * Python model names the field `return_kind` with a `return` alias, in TS
 * the schema simply uses the wire key.
 */
import { z } from "zod";
import { REQUIRED_PAYLOAD } from "./protocol.ts";

export const consultPayloadSchema = z.object({
  task: z.string().default(""),
  ask: z.string().default(""),
  expect: z.enum(["proposal", "review", "answer", "work"]).default("proposal"),
  deadline_hint: z.string().nullable().optional(),
});

export const proposalPayloadSchema = z.object({
  title: z.string().default(""),
  answer: z.string().default(""),
  rationale: z.string().default(""),
  risks: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
  asks: z.array(z.string()).default([]),
});

export const delegationPayloadSchema = z.object({
  work: z.string().default(""),
  acceptance: z.array(z.string()).default([]),
  return: z.enum(["deliverable", "proposal"]).default("deliverable"),
  notes: z.string().default(""),
});

export const deliverablePayloadSchema = z.object({
  result: z.string().default(""),
  artifacts: z.array(z.string()).default([]),
  notes: z.string().default(""),
  confidence: z.number().min(0).max(1).default(0.5),
});

export const reviewPayloadSchema = z.object({
  verdict: z.enum(["accept", "revise", "reject"]),
  notes: z.string().default(""),
  points: z.array(z.string()).default([]),
});

export const decisionPayloadSchema = z.object({
  decision: z.string().default(""),
  rationale: z.string().default(""),
  confidence: z.number().min(0).max(1).default(0.7),
  dissent: z.string().nullable().optional(),
  accepted_proposals: z.array(z.string()).default([]),
});

export const messagePayloadSchema = z.object({
  text: z.string().default(""),
});

/**
 * The auto-mode routing pre-decision (code-only kind; NEVER a protocol
 * envelope). Unlike the protocol schemas it carries NO defaults: both fields
 * are required, so a prose/empty reply fails the strict check and takes the
 * one repair re-ask, then the fail-closed consult degradation. `reason` is
 * clipped/flattened by the harness (`ROUTE_REASON_CHARS`), not here.
 */
export const routePayloadSchema = z.object({
  route: z.enum(["solo", "consult", "work"]),
  reason: z.string().min(1),
});

export const PAYLOAD_SCHEMAS: Record<string, z.ZodTypeAny> = {
  consult: consultPayloadSchema,
  proposal: proposalPayloadSchema,
  delegation: delegationPayloadSchema,
  deliverable: deliverablePayloadSchema,
  review: reviewPayloadSchema,
  decision: decisionPayloadSchema,
  message: messagePayloadSchema,
  route: routePayloadSchema,
};

export type ConsultPayload = z.infer<typeof consultPayloadSchema>;
export type ProposalPayload = z.infer<typeof proposalPayloadSchema>;
export type DelegationPayload = z.infer<typeof delegationPayloadSchema>;
export type DeliverablePayload = z.infer<typeof deliverablePayloadSchema>;
export type ReviewPayload = z.infer<typeof reviewPayloadSchema>;
export type DecisionPayload = z.infer<typeof decisionPayloadSchema>;
export type MessagePayload = z.infer<typeof messagePayloadSchema>;
export type RoutePayload = z.infer<typeof routePayloadSchema>;

export type PayloadParseResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; issues: z.core.$ZodIssue[] };

/**
 * Strictly validate a payload against the schema for `kind`.
 *
 * Unlike `sanitizePayload` nothing is coerced beyond the schema's own
 * defaults; a payload the tolerant pipeline would fix (e.g. confidence "9")
 * is reported as invalid here. Unknown kinds fail with a single issue.
 */
export function parsePayload(kind: string, data: unknown): PayloadParseResult {
  const schema = PAYLOAD_SCHEMAS[kind];
  if (!schema) {
    return {
      ok: false,
      issues: [{ message: `unknown payload kind: ${kind}` } as z.core.$ZodIssue],
    };
  }
  const result = schema.safeParse(data);
  if (result.success) return { ok: true, data: result.data as Record<string, unknown> };
  return { ok: false, issues: result.error.issues };
}

// ---------------------------------------------------------------------------
// repair pass (BACKLOG "Structured-payload discipline", fix 1)
// ---------------------------------------------------------------------------

/**
 * The kinds that travel as structured node payloads — the six protocol kinds
 * a model is asked to emit, plus the code-only `route` pre-decision (auto
 * mode; never appended as an envelope, so `protocol.ts` stays untouched).
 * `message` is the free-text kind and is never repaired. Kept in sync with
 * {@link PAYLOAD_SCHEMAS}.
 */
export const STRUCTURED_PAYLOAD_KINDS: ReadonlySet<string> = new Set([
  "consult",
  "proposal",
  "delegation",
  "deliverable",
  "review",
  "decision",
  "route",
]);

/**
 * The marked repair turn appended to the shared context. Kept byte-stable:
 * like `[[TASK]]`/`[[/TASK]]` and the compaction-summary marker, it is a
 * user-visible string sent to models inside the "Context events:" transcript
 * section. The envelope is a regular `message` from "user" (the
 * harness-injected context role), so the protocol and session JSONL shapes
 * are untouched.
 */
export const REPAIR_REQUEST_PREFIX = "[[REPAIR_REQUEST]]";
export const REPAIR_REQUEST_SUFFIX = "[[/REPAIR_REQUEST]]";

/** Total character budget for the issue list inside one repair request. */
export const REPAIR_ISSUE_CHARS = 500;

/**
 * The structural part of a zod issue the repair request needs. `zod` issues
 * are assignable as-is; the harness also synthesizes them for required fields
 * the schemas would otherwise default away.
 */
export interface PayloadIssueLike {
  readonly code?: string;
  readonly path?: ReadonlyArray<PropertyKey>;
  readonly message: string;
}

/** The schema keys that are missing or empty in `data` (protocol-required). */
export function missingRequiredIssues(kind: string, data: unknown): PayloadIssueLike[] {
  const required = REQUIRED_PAYLOAD[kind] ?? [];
  const record =
    data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  return required
    .filter((key) => record[key] === undefined || record[key] === null || record[key] === "")
    .map((key) => ({ code: "custom", path: [key], message: "Required" }));
}

/**
 * Strictness check for a node reply that already went through the tolerant
 * parser. Returns null when the reply is acceptable, else the issues to feed
 * back. `tolerantFailed` carries `parseModelOutput`'s "required keys missing /
 * no JSON object" verdict — necessary because the zod schemas fill defaults,
 * so a raw-prose reply would otherwise validate as an all-empty payload.
 */
export function strictPayloadIssues(
  kind: string,
  payload: Record<string, unknown>,
  tolerantFailed = false,
): PayloadIssueLike[] | null {
  const strict = parsePayload(kind, payload);
  if (!tolerantFailed) return strict.ok ? null : strict.issues;
  const strictIssues = strict.ok ? [] : strict.issues;
  const covered = new Set(strictIssues.map((issue) => String(issue.path?.[0] ?? "")));
  const issues = [
    ...missingRequiredIssues(kind, payload).filter(
      (issue) => !covered.has(String(issue.path?.[0] ?? "")),
    ),
    ...strictIssues,
  ];
  return issues.length > 0 ? issues : null;
}

// ---------------------------------------------------------------------------
// relaxed strict parse (BACKLOG "Structured-payload discipline", fix 2)
// ---------------------------------------------------------------------------

/**
 * A fence line and its body: ``` optionally followed by a language word, then
 * anything up to the closing fence. Bodies that are not JSON (a
 * thinking/scratch block, a malformed payload) are skipped by the caller, so
 * the language match stays permissive on purpose.
 */
const FENCED_BLOCK_RE = /```[^\n]*\n?([\s\S]*?)```/g;

/** Parse one JSON document; yields plain objects only (never arrays/null). */
function parseObjectCandidate(raw: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // not a JSON object — skip this candidate
  }
  return undefined;
}

/**
 * Every `{…}` span in `text`, in order of appearance, string- and
 * escape-aware so braces and quotes inside JSON strings do not confuse the
 * depth walk (prose quotes can still mislead it — a missed candidate only
 * means the repair pass runs, never a wrong payload, because every candidate
 * is validated before acceptance).
 */
function* braceDelimitedObjects(text: string): Generator<Record<string, unknown>> {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const slice = text.slice(start, i + 1);
        start = -1;
        const candidate = parseObjectCandidate(slice);
        if (candidate !== undefined) yield candidate;
      }
    }
  }
}

/**
 * JSON object candidates in a raw model reply, most likely first: the whole
 * trimmed text (a bare JSON document), then each fenced block in order (so a
 * thinking/scratch block before the payload does not shadow it), then each
 * brace-delimited span (so prose with stray braces around a bare object still
 * yields it). Every candidate is validated by the caller before acceptance;
 * non-JSON candidates are simply skipped.
 */
function* jsonObjectCandidates(text: string): Generator<Record<string, unknown>> {
  const trimmed = text.trim();
  if (trimmed) {
    let whole: unknown;
    let wholeParsed = false;
    try {
      whole = JSON.parse(trimmed);
      wholeParsed = true;
    } catch {
      // not a bare JSON document — try the relaxed shapes below
    }
    if (wholeParsed) {
      // the reply IS one JSON document: when it is not an object (an array, a
      // string, a number) its inner spans are not a payload candidate either
      if (whole !== null && typeof whole === "object" && !Array.isArray(whole)) {
        yield whole as Record<string, unknown>;
      }
      return;
    }
  }
  for (const match of text.matchAll(FENCED_BLOCK_RE)) {
    const body = (match[1] ?? "").trim();
    if (body === "") continue;
    const fenced = parseObjectCandidate(body);
    if (fenced !== undefined) yield fenced;
  }
  yield* braceDelimitedObjects(text);
}

/**
 * Relaxed strict parse: find a JSON object in a raw model reply that fully
 * passes the strict payload check — without requiring the byte-stable reply
 * shapes the tolerant parser's extraction handles on its own. Every candidate
 * (bare document, fenced block, brace-delimited span, markers or not) must
 * satisfy the SAME bar as a directly parsed reply: the zod schema AND the
 * protocol-required fields present and non-empty (`tolerantFailed: true`
 * semantics, so a candidate the schemas would default away is not silently
 * accepted). Returns the first fully valid candidate, else null — the caller
 * then keeps the ordinary strict issues and the repair pass runs.
 *
 * Only the structured node kinds are eligible; `message` is free-text and
 * never strict-checked.
 */
export function relaxedStrictPayload(kind: string, text: string): Record<string, unknown> | null {
  if (!STRUCTURED_PAYLOAD_KINDS.has(kind)) return null;
  for (const candidate of jsonObjectCandidates(text)) {
    if (strictPayloadIssues(kind, candidate, true) === null) return candidate;
  }
  return null;
}

/** `path: message; …`, clipped to `limit` characters (explicit ellipsis). */
export function formatPayloadIssues(
  issues: readonly PayloadIssueLike[],
  limit = REPAIR_ISSUE_CHARS,
): string {
  const parts: string[] = [];
  let used = 0;
  for (const issue of issues) {
    const location =
      issue.path !== undefined && issue.path.length > 0
        ? issue.path.map((segment) => String(segment)).join(".")
        : "(root)";
    const line = `${location}: ${issue.message}`;
    const separator = parts.length === 0 ? 0 : 2; // "; "
    if (used + separator + line.length > limit) {
      const room = limit - used - separator;
      if (room > 1) parts.push(line.slice(0, room - 1) + "…");
      break;
    }
    parts.push(line);
    used += separator + line.length;
  }
  return parts.join("; ");
}

/**
 * One compact, machine-readable repair request: the strict issues (paths +
 * messages, clipped) and the instruction to re-emit a single fenced json
 * block. It is appended to the conversation as a user turn and to the shared
 * context as a marked `message` envelope.
 */
export function buildRepairRequest(kind: string, issues: readonly PayloadIssueLike[]): string {
  return [
    REPAIR_REQUEST_PREFIX,
    `Your previous reply did not match the required ${kind} payload schema.`,
    `Issues: ${formatPayloadIssues(issues)}`,
    `Reply again with the complete ${kind} payload as a single fenced \`\`\`json block and nothing else.`,
    REPAIR_REQUEST_SUFFIX,
  ].join("\n");
}
