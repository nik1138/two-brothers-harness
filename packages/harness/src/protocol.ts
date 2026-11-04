/**
 * Message protocol: envelope, validation and model-output parsing.
 * Mirrors the original prototype's protocol module (removed 2026-11-04; see
 * git history) and PROTOCOL.md sections 3-4.
 */

export const ROLES = ["senior", "junior", "user"] as const;
export const ROLES_TO = ["senior", "junior", "user"] as const;
export const KINDS = [
  "consult",
  "proposal",
  "delegation",
  "deliverable",
  "review",
  "decision",
  "message",
] as const;

export const REQUIRED_PAYLOAD: Record<string, string[]> = {
  consult: ["task", "ask"],
  proposal: ["title", "answer"],
  delegation: ["work", "acceptance"],
  deliverable: ["result"],
  review: ["verdict"],
  decision: ["decision"],
  message: ["text"],
};

export const PAYLOAD_KEYS: Record<string, string[]> = {
  consult: ["task", "ask", "expect", "deadline_hint"],
  proposal: ["title", "answer", "rationale", "risks", "confidence", "asks"],
  delegation: ["work", "acceptance", "return", "notes"],
  deliverable: ["result", "artifacts", "notes", "confidence"],
  review: ["verdict", "notes", "points"],
  decision: ["decision", "rationale", "confidence", "dissent", "accepted_proposals"],
  message: ["text"],
};

const ENUM_CHECKS: Array<[string, string, readonly string[]]> = [
  ["consult", "expect", ["proposal", "review", "answer", "work"]],
  ["review", "verdict", ["accept", "revise", "reject"]],
  ["delegation", "return", ["deliverable", "proposal"]],
];

const FENCE_RE = /```(?:json|JSON)?\s*([\s\S]*?)\s*```/;

export interface Message {
  v: number;
  id: string;
  seq: number;
  ts: string;
  from: string;
  to: string;
  kind: string;
  payload: Record<string, unknown>;
}

export interface ParseResult {
  payload: Record<string, unknown>;
  parseFailed: boolean;
}

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

let idCounter = 0;

export function createMessage(
  seq: number | null,
  fromRole: string,
  toRole: string,
  kind: string,
  payload: Record<string, unknown> | string,
  msgId?: string,
): Message {
  idCounter += 1;
  const payloadObj =
    payload !== null && typeof payload === "object"
      ? payload
      : { text: String(payload) };
  return {
    v: 1,
    id: msgId ?? `msg-${Math.random().toString(16).slice(2, 10)}`,
    seq: seq ?? 0,
    ts: nowIso(),
    from: fromRole,
    to: toRole,
    kind,
    payload: payloadObj,
  };
}

export function validateMessage(msg: unknown): string[] {
  const errors: string[] = [];
  if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
    return ["message is not an object"];
  }
  const record = msg as Record<string, unknown>;

  for (const field of ["id", "seq", "ts", "from", "to", "kind", "payload"]) {
    if (!(field in record)) errors.push(`missing required field: ${field}`);
  }

  if ("from" in record && !ROLES.includes(record.from as (typeof ROLES)[number])) {
    errors.push(`invalid 'from': ${String(record.from)}`);
  }
  if ("to" in record && !ROLES_TO.includes(record.to as (typeof ROLES_TO)[number])) {
    errors.push(`invalid 'to': ${String(record.to)}`);
  }

  const kind = record.kind;
  if (!KINDS.includes(kind as (typeof KINDS)[number])) {
    errors.push(`invalid 'kind': ${String(kind)}`);
    return errors;
  }

  const payload = record.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    errors.push("payload must be an object");
    return errors;
  }
  const payloadRecord = payload as Record<string, unknown>;

  for (const key of REQUIRED_PAYLOAD[kind as string]) {
    const value = payloadRecord[key];
    if (value === undefined || value === null || value === "") {
      errors.push(`payload.${key} is required and must not be empty`);
    }
  }

  const allowed = PAYLOAD_KEYS[kind as string];
  for (const key of Object.keys(payloadRecord)) {
    if (!allowed.includes(key)) errors.push(`payload.${key} is not allowed for kind '${kind}'`);
  }

  for (const [kindName, key, allowedValues] of ENUM_CHECKS) {
    if (kindName === kind && key in payloadRecord) {
      if (!allowedValues.includes(String(payloadRecord[key]))) {
        errors.push(`payload.${key} must be one of ${allowedValues.join(", ")}`);
      }
    }
  }

  return errors;
}

export function payloadIsValid(kind: string, payload: unknown): boolean {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  return REQUIRED_PAYLOAD[kind].every((key) => record[key] !== undefined && record[key] !== null && record[key] !== "");
}

export function stripCodeFences(text: string): string {
  const match = FENCE_RE.exec(text);
  return match ? match[1].trim() : text.trim();
}

function extractJson(text: string): unknown {
  const cleaned = stripCodeFences(text);
  try {
    return JSON.parse(cleaned);
  } catch {
    // fall through to brace matching
  }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function parseModelOutput(text: string, expectedKind?: string): ParseResult {
  const obj = extractJson(text);
  if (obj === undefined || obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return { payload: { text }, parseFailed: true };
  }
  const payload = obj as Record<string, unknown>;
  if (expectedKind && REQUIRED_PAYLOAD[expectedKind]) {
    const missing = REQUIRED_PAYLOAD[expectedKind].filter(
      (key) => payload[key] === undefined || payload[key] === null || payload[key] === "",
    );
    if (missing.length > 0) {
      const fallback = { ...payload, text };
      return { payload: fallback, parseFailed: true };
    }
  }
  return { payload, parseFailed: false };
}
