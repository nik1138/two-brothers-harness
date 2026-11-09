/**
 * The cooperation state machine. Ports the original prototype's graph
 * (removed 2026-11-04; see git history) and PROTOCOL.md §5:
 *
 *     user task
 *        │
 *        ▼
 *     senior_open ── consult / delegation (read-only belt in consult mode)
 *        │
 *        ▼
 *     junior_answer ── proposal (read-only belt in consult mode) /
 *                      deliverable (mutating tool loop in work mode)
 *        │
 *        ▼
 *     senior_verify ── read-only tool slice (work mode + tools, bounded)
 *        │
 *        ▼
 *     senior_review ── accept | revise | reject (read-only belt in consult mode)
 *        │  revise ──► junior_revise ──► senior_review   (bounded by max_rounds)
 *        ▼
 *     senior_decide ── decision (plain call, no belt)
 *        │
 *        ▼
 *       END
 *
 * Every exchange is appended to the shared context as a protocol envelope, so
 * the event log stays byte-compatible with PROTOCOL.md. Tool evidence rides
 * inside payload fields (`verify: …` in review points, `tool: …` in
 * deliverable artifacts) — never as extra envelopes.
 *
 * Differences from the original prototype's graph, chosen as the simplest
 * faithful fetch-based equivalent (documented):
 * - The graph checkpointer/thread are replaced by a plain async node
 *   loop; `AbortSignal` replaces `threading.Event` cancellation and
 *   `ProviderAbortError` replaces `RunCancelled`.
 * - `respond_structured`'s `with_structured_output` path has no fetch-based
 *   equivalent here: every structured answer goes through the tolerant
 *   text pipeline (parse → sanitize), which is the Python fallback and the
 *   Stage 2 contract invariant.
 * - MCP/plugin tools do not enter through fixed parameters: the role-scoped
 *   `toolScopes` registry (shared / senior / junior) places them on the
 *   right belt; the legacy `tools`/`seniorTools` options still work and map
 *   to the junior / senior scopes respectively. MCP servers load via
 *   `mcp.ts` (`loadMcpTools`) and their `client` must stay alive for the run.
 * - A confined `Workspace` is wired via `HarnessOptions.workspace`: its
 *   `workspace_*` tools become the junior's tool set and the senior's verify
 *   slice falls out of the SENIOR_VERIFY_TOOL_NAMES filter (the analogue of
 *   Python's `CooperationGraph(workspace=...)`); approvals ride on the
 *   workspace's PermissionManager broker.
 * - Context compaction (`compaction.ts`, pi's algorithm ported per the
 *   design notes) runs between nodes when the rendered context passes
 *   `thresholdChars - reserveChars` (char mode), or
 *   `contextWindow - reserveTokens` estimated tokens when a context window is
 *   known (token mode), or once under `--compact`; the summary is produced by
 *   the senior's provider. A provider context overflow triggers one
 *   compact-and-retry of the same node (pi's recovery path); a second overflow
 *   surfaces. Python has no compaction — a documented TS-first feature
 *   (BACKLOG "Context compaction"); fail-soft by contract.
 * - Prompt sections are assembled here, not in `shared/prompts.json` (which
 *   stays byte-identical): the role's base text plus `## Available tools`
 *   (the belt the call actually offers, MCP namespacing already applied) and
 *   `## Using tools`. Every provider call appends a names-and-lengths
 *   `PromptAuditEntry` to `result.promptAudits` and emits the same entry as
 *   a `prompt_audit` runtime event.
 * - A workspace-bound harness (`options.workspace`) appends a bounded
 *   `## Workspace instructions` block LAST, built once in the constructor
 *   from root-level `AGENTS.md` / `CLAUDE.md` (`instructions.ts`). This is
 *   UNTRUSTED project guidance: it never overrides system/operator
 *   instructions, cannot grant permissions, never reads outside the root, is
 *   capped per file and in total, and is quote-neutralized so it cannot forge
 *   prompt section headings. No files means no block and byte-identical
 *   prompts; `projectInstructions: false` (or
 *   `TWO_BROTHERS_PROJECT_INSTRUCTIONS=off`) disables it.
 * - Both brothers may use READ-ONLY tools in consult-mode nodes ("senior and
 *   junior must use tools"): `senior_open` (consult), the junior proposal
 *   (`junior_answer` / `junior_revise`) and `senior_review` each run the
 *   shared bounded tool loop over the role's read-only belt before emitting
 *   the structured reply — only when the belt is non-empty AND that role's
 *   provider implements `chatWithTools`. The read-only belt is the role's
 *   normal belt minus the workspace mutations
 *   (`workspace_write_file` / `workspace_edit_file` /
 *   `workspace_delete_file` / `workspace_run_shell`) and minus the
 *   display-only plan tool, so a senior consult call can never mutate and a
 *   tool-less configuration keeps the exact pre-tools request path (`ask`:
 *   no tools on the wire, no extra provider calls, the same prompt
 *   sections). `senior_decide` deliberately stays a plain call: the review
 *   immediately before it already ran the read-only checks, and the final
 *   arbiter statement should read the transcript rather than re-run it.
 *   Work mode is unchanged: the delegation, the junior's mutating
 *   deliverable loop, the senior's approval-brokered verify slice
 *   (including its documented `workspace_run_shell` carve-out) and the
 *   review/decision calls keep their exact behavior.
 * - Reasoning (thinking) persistence is STREAMING-ONLY: when token streaming
 *   is active (`streamTokens` + a stream consumer) the harness wraps its
 *   per-call `onThinkingDelta` sink, buffers the deltas, and after the call
 *   emits ONE bounded, sanitized, ANSI-stripped `reasoning` runtime event
 *   (`{role, kind, text, truncated}`, capped at `REASONING_EVENT_MAX_CHARS` =
 *   10k with the shared head+tail truncation marker) through `emitRuntime`.
 *   `RunManager`'s sidecar persister then writes it to
 *   `sessions/runtime/*.events.jsonl` automatically, so the web app can
 *   replay it as a collapsed "Thinking · replayed" row on reload. No protocol
 *   envelope or session-JSONL change: the event is purely additive and
 *   consumers that do not know it ignore it. Without streaming the provider
 *   contract returns no reasoning text at all, so non-streaming runs emit
 *   nothing — the TUI keeps its live-only thinking (no replay).
 * - Anthropic extended thinking (`--thinking-budget`) is a provider-layer
 *   option: the Messages adapter adds `thinking: {type:"enabled",
 *   budget_tokens:N}` when configured and captures the signed thinking blocks
 *   from the response. The tool loop carries those blocks on the assistant
 *   `ChatMessage` it appends, and the same adapter echoes them verbatim on the
 *   next tool-loop request (the API rejects a loop whose signatures were
 *   dropped). Unset keeps the Anthropic request byte-identical, other adapters
 *   ignore the field, and the blocks never enter a protocol envelope.
 * - Structured-payload discipline (BACKLOG, fixes 1 + 2 + 3): every structured
 *   node reply is checked against the strict zod schema and gets exactly ONE
 *   repair re-ask when it fails. Before the repair runs, the relaxed strict
 *   parse accepts any JSON object in the raw reply (bare, fenced, surrounded
 *   by prose — no byte-stable reply markers required) that passes the same
 *   strict check, so a valid payload never takes a needless repair. The
 *   repair turn is appended to the shared context as a marked `message`
 *   envelope from "user"
 *   (`[[REPAIR_REQUEST]]` … `[[/REPAIR_REQUEST]]`, the compaction-summary
 *   convention) and the request resends the conversation OpenAI-style: the
 *   bad reply as an assistant turn, the repair instruction as a user turn.
 *   A still-bad reply falls back to the tolerant pipeline (sanitize +
 *   defaults + one warning) — the tolerant boundary never throws. Each
 *   role's kind-specific prompt assembly also appends one tiny fenced,
 *   strict-valid payload example per structured kind (never into
 *   `shared/prompts.json`).
 * - Plugin lifecycle hooks (`plugins.ts` `dispatchHook`) bracket the run —
 *   `session_start` with the session id and workspace, `session_end` with
 *   `completed` / `cancelled` / `failed` — and every tool execution:
 *   `before_tool_call` may rewrite `args` in place or deny (a deny emits a
 *   `blocked` completion and returns the denial text as the tool result),
 *   `after_tool_call` may rewrite `result` before it is compacted and
 *   reported. Dispatch is fail-soft; a broken hook never breaks a run.
 *   Discovered skills (`options.skills`) append a pi-style
 *   `## Available skills` section (shared + the role's own scope) plus one
 *   invocation line; a role with no skills keeps the pre-skills prompt bytes.
 *   A structured reply that answers with `<skill name="…">` gets the body
 *   delivered as a `<skill-loaded>` user `message` envelope (kimi-code's
 *   convention, `deliverSkillRequest`) — at most three per run, each name at
 *   most once, role-scoped, and never a throw.
 * - Mid-run operator steering (wave 23, pi's `steer` idea reimplemented): the
 *   optional `options.steering` drain callback is read at every state-machine
 *   node boundary (after `maybeCompact`, so the text is not folded into a
 *   summary produced by the same boundary) and at every tool-loop iteration.
 *   Each drained text is appended as an ORDINARY `message` envelope from
 *   "user" to "senior" — payload `{text}`, dense `seq`, session JSONL
 *   included — with {@link STEERING_PREFIX} in the payload text so the model
 *   can tell it from the task. In a tool loop the opening system+user pair is
 *   re-rendered from the shared context so the next request of the in-flight
 *   conversation carries the steer inside the canonical transcript; it is
 *   never a second consecutive user turn (Anthropic and Google reject
 *   non-alternating turns, and the tool conversation's own replacement must
 *   not lose its tool/assistant pairing). No protocol kind, field or
 *   session-format change; nothing is appended after cancellation and a broken
 *   callback is fail-soft (one warning in `result.warnings`).
 */
import { maxTokensForRole, thinkingBudgetForRole, type Config } from "./config.ts";
import { SharedContext, type ChatMessage } from "./context.ts";
import {
  compactContext,
  compactionTriggerChars,
  compactionTriggerTokens,
  compactionUnit,
  estimateTokens,
  isCompactionSummary,
  type CompactionSettings,
  type CompactionUnit,
} from "./compaction.ts";
import {
  buildRepairRequest,
  relaxedStrictPayload,
  strictPayloadIssues,
  STRUCTURED_PAYLOAD_KINDS,
  type PayloadIssueLike,
} from "./payloads.ts";
import { boundOutput, sanitizeOutput } from "./output.ts";
import { loadPrompts } from "./prompts.ts";
import { RepeatToolGuard, type RepeatToolGuardOptions } from "./repeatguard.ts";
import {
  dispatchHook,
  type HookRegistry,
  type HookRole,
} from "./plugins.ts";
import { nowIso, parseModelOutput, type Message } from "./protocol.ts";
import type { RoleEndpoint } from "./runtime.ts";
import type { HarnessResultSummary, StreamEvent, StreamToolStatus } from "./runstream.ts";
import { renderSkillsSection, type SkillCatalog, type SkillRole } from "./skills.ts";
import {
  WORKSPACE_INSTRUCTIONS_HEADING,
  loadWorkspaceInstructions,
  renderWorkspaceInstructions,
  type WorkspaceInstructionFile,
} from "./instructions.ts";
import type { Workspace } from "./workspace.ts";
import {
  AnthropicProvider,
  buildProvider,
  type ChatOptions,
  emptyUsage,
  GoogleProvider,
  mergeUsage,
  MockProvider,
  OpenAICompatibleProvider,
  ProviderAbortError,
  ProviderContextOverflowError,
  type Provider,
  resolveProviderKind,
  type Tool,
  type ToolChatResponse,
  type UsageTotals,
} from "./provider.ts";
import {
  APPROVAL_DENY_LIMIT,
  clipArgs,
  clipText,
  compactToolResult,
  normalizeApprovalTarget,
  toolEvidenceLine,
  MAX_EVIDENCE_ENTRIES,
  CLIP_EVIDENCE_CHARS,
  REASONING_EVENT_MAX_CHARS,
  type RuntimeEvent,
} from "./runevents.ts";
import {
  formatSpillRead,
  isSpilledText,
  SPILL_READ_TOOL_DESCRIPTION,
  SPILL_READ_TOOL_NAME,
  SPILL_READ_TOOL_PARAMETERS,
  SpillStore,
  spillInlineBudget,
  spillPreview,
  spillReadBudget,
  type SpillOptions,
} from "./spill.ts";
import {
  sanitizeTodos,
  summarizeTodos,
  todoResultText,
  TODO_TOOL_DESCRIPTION,
  TODO_TOOL_NAME,
  TODO_TOOL_PARAMETERS,
  type TodoItem,
} from "./todos.ts";

const FALLBACK_TEXT = "The model did not return a structured reply; using the text as is.";

const ALLOWED_KEYS: Record<string, string[]> = {
  consult: ["task", "ask", "expect", "deadline_hint"],
  proposal: ["title", "answer", "rationale", "risks", "confidence", "asks"],
  delegation: ["work", "acceptance", "return", "notes"],
  deliverable: ["result", "artifacts", "notes", "confidence"],
  review: ["verdict", "notes", "points"],
  decision: ["decision", "rationale", "confidence", "dissent", "accepted_proposals"],
  message: ["text"],
};

function asList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function asConfidence(value: unknown): number {
  const num = Number(value);
  if (Number.isNaN(num)) return 0.5;
  return Math.max(0, Math.min(1, num));
}

function taskOf(ctx: SharedContext): string {
  for (const event of ctx.events) {
    if (event.from === "user" && event.kind === "message") {
      return String(event.payload.text ?? "");
    }
  }
  return "";
}

export function sanitizePayload(
  kind: string,
  payload: Record<string, unknown> | null | undefined,
  text: string,
  task = "",
): Record<string, unknown> {
  const data: Record<string, unknown> =
    payload && typeof payload === "object" ? { ...payload } : {};
  const allowed = ALLOWED_KEYS[kind];
  if (allowed) {
    for (const key of Object.keys(data)) {
      if (!allowed.includes(key)) delete data[key];
    }
  }

  if (kind === "consult") {
    if (data.task === undefined) data.task = task;
    if (data.ask === undefined) data.ask = text.trim() || "Please give a proposal.";
    if (data.expect === undefined) data.expect = "proposal";
  } else if (kind === "proposal") {
    if (data.title === undefined) data.title = "Proposal";
    if (data.answer === undefined) data.answer = text.trim() || FALLBACK_TEXT;
    data.risks = asList(data.risks);
    data.asks = asList(data.asks);
    data.confidence = asConfidence(data.confidence);
  } else if (kind === "delegation") {
    if (data.work === undefined) data.work = task || text.trim();
    const acceptance = asList(data.acceptance);
    data.acceptance = acceptance.length === 0 ? ["done"] : acceptance;
    if (data.return === undefined) data.return = "deliverable";
  } else if (kind === "deliverable") {
    if (data.result === undefined) data.result = text.trim() || FALLBACK_TEXT;
    data.artifacts = asList(data.artifacts);
    data.confidence = asConfidence(data.confidence);
  } else if (kind === "review") {
    if (!["accept", "revise", "reject"].includes(String(data.verdict))) data.verdict = "accept";
    if (data.notes === undefined) data.notes = "";
    data.points = asList(data.points);
  } else if (kind === "decision") {
    if (data.decision === undefined) data.decision = text.trim() || FALLBACK_TEXT;
    if (data.rationale === undefined) data.rationale = "";
    data.confidence = asConfidence(data.confidence);
    if (data.dissent === undefined) data.dissent = null;
    data.accepted_proposals = asList(data.accepted_proposals);
  } else if (kind === "message") {
    if (data.text === undefined) data.text = text.trim();
  }
  return data;
}

/**
 * The strict payload check for one raw node reply, with the relaxed-parse
 * fallback (BACKLOG fix 2). Runs the tolerant parse and the strict zod check
 * first; only when issues remain does it scan the raw reply for a JSON object
 * candidate (every fenced block and every brace-delimited span, byte-stable
 * markers or not) that fully passes the SAME strict check — zod schema plus
 * protocol-required fields — and accepts the first such candidate. Returns
 * the payload to keep (the accepted candidate, else the tolerant parse's) and
 * the issues to feed back (null when the reply is acceptable).
 */
function strictReplyCheck(
  kind: string,
  reply: string,
): { payload: Record<string, unknown>; issues: PayloadIssueLike[] | null } {
  const parsed = parseModelOutput(reply, kind);
  const issues = strictPayloadIssues(kind, parsed.payload, parsed.parseFailed);
  if (issues === null) return { payload: parsed.payload, issues: null };
  const relaxed = relaxedStrictPayload(kind, reply);
  return relaxed !== null
    ? { payload: relaxed, issues: null }
    : { payload: parsed.payload, issues };
}

// ---------------------------------------------------------------------------
// state-machine constants (ported from graph.py — keep in sync)
// ---------------------------------------------------------------------------

/**
 * The senior verifies the junior's deliverable with a read-only slice of the
 * workspace: it may inspect files and run tests, but never write/edit/delete.
 * Shell commands still pass through the same permission checks (Stage 5).
 * This is the WORK-MODE verify slice; its documented approval-brokered
 * `workspace_run_shell` stays available there. The consult-mode read-only
 * belt filters {@link WORKSPACE_MUTATION_TOOL_NAMES} instead, so a consult
 * node never offers the senior any of them.
 */
export const SENIOR_VERIFY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "workspace_read_file",
  "workspace_list_dir",
  "workspace_search_text",
  "workspace_run_shell",
]);

/**
 * Workspace built-ins that change the workspace or run arbitrary commands.
 * The consult-mode read-only belt offers none of them to either brother; the
 * junior's work-mode deliverable belt keeps them (mutating work-mode
 * behavior is unchanged), and the senior's work-mode verify slice keeps its
 * documented `workspace_run_shell` carve-out.
 */
export const WORKSPACE_MUTATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  "workspace_write_file",
  "workspace_edit_file",
  "workspace_delete_file",
  "workspace_run_shell",
]);

/**
 * Prefix carried by an operator steering envelope's payload text (wave 23,
 * mid-run steering). A steer rides as an ORDINARY protocol `message` envelope
 * from `"user"` to `"senior"` — the initial-task shape — so protocol kinds,
 * payload fields and the session JSONL format are untouched. The prefix is
 * plain payload text, deliberately bounded (a short byte-stable marker) and
 * documented here so the model can tell an operator steer from the original
 * task: the task is rendered inside `[[TASK]]`, a steer appears in
 * "Context events:" as `[[OPERATOR STEER]] …`. Consumers that only read the
 * payload text see the marker verbatim; nothing parses it.
 */
export const STEERING_PREFIX = "[[OPERATOR STEER]] ";

/**
 * Hard bound on steer envelopes appended to one run's shared context. The
 * runtime queue is already capped (`STEER_QUEUE_MAX` pending); this second,
 * run-lifetime cap keeps a callback that keeps producing text from growing the
 * context without bound. Beyond it a drained text is dropped with one warning.
 */
export const MAX_STEERING_ENVELOPES_PER_RUN = 16;

/** Hard bound on the junior's tool-calling loop iterations. */
export const MAX_JUNIOR_TOOL_ITERATIONS = 8;
/** Hard bound on the senior's verification loop iterations. */
export const MAX_SENIOR_VERIFY_ITERATIONS = 6;
/**
 * Hard bound on a consult-mode node's read-only tool-calling loop (consult,
 * proposal and review grounding). Four rounds are enough for a
 * read-inspect-then-answer pass; an exhausted loop still goes through the
 * ordinary one-shot structured-payload repair, exactly like the work loops.
 */
export const MAX_CONSULT_TOOL_ITERATIONS = 4;

const VERIFY_INSTRUCTION =
  "\n\nBefore reviewing, verify the junior's deliverable yourself. Use the " +
  "read-only workspace tools to inspect the actual results and run_shell to " +
  "run the relevant checks, then state what you found.";

// ---------------------------------------------------------------------------
// assembled system-prompt sections (appended after the shared base prompt)
// ---------------------------------------------------------------------------

/**
 * Section names of the assembled system prompt, in append order. The base
 * section is the shared prompts.json text (kept byte-identical); the other
 * sections are assembled from the role's actual tool belt by
 * `assembleSystemPrompt` — never written into prompts.json.
 */
export const PROMPT_SECTION_BASE = "base";
export const PROMPT_SECTION_TOOLS = "Available tools";
export const PROMPT_SECTION_USING_TOOLS = "Using tools";
export const PROMPT_SECTION_SKILLS = "Available skills";
/**
 * Audit identifier for the workspace-instructions block. The prompt heading is
 * `## Workspace instructions`; the audit vocabulary uses the short stable
 * section name `instructions`.
 */
export const PROMPT_SECTION_INSTRUCTIONS = "instructions";

/** One-line tool description cap inside the `## Available tools` section. */
const PROMPT_TOOL_DESCRIPTION_CHARS = 160;

const USING_TOOLS_BODY = [
  "- Results must come from tool calls, not from memory or invention. When the work depends on files, directories, commands or other workspace state, call a tool and use what it returns.",
  "- On delegated work, do the work with your tools first and report afterwards. Never describe work you did not perform.",
  "- Report tool-grounded evidence in the deliverable — paths, commands and outcomes — so the senior can verify it.",
].join("\n");

/**
 * Appended to the junior's rendered transcript on the deliverable turn (work
 * mode). The transcript — including the `[[TASK]]` markers — stays
 * byte-stable; this rides after it, exactly like VERIFY_INSTRUCTION does for
 * the senior.
 */
export const DELEGATION_DIRECTIVE =
  "\n\nThe senior delegated this work to you. Perform it now with your tools: " +
  "inspect what you need, make the required changes, and run the checks the " +
  "acceptance criteria call for. Then reply with the deliverable JSON object " +
  "(result, artifacts, notes, confidence), with the tool evidence (paths, " +
  "commands, outcomes) in `artifacts`. Do not describe work you did not perform.";

/** One prompt line for a tool: `- name — one-line description`. */
function toolLine(tool: Tool): string {
  const description = clipText(tool.description ?? "", PROMPT_TOOL_DESCRIPTION_CHARS);
  return description ? `- ${tool.name} — ${description}` : `- ${tool.name}`;
}

/** De-duplicated belt (the tool loop's map keeps one definition per name). */
function uniqueBelt(tools: Tool[]): Tool[] {
  const seen = new Set<string>();
  const belt: Tool[] = [];
  for (const tool of tools) {
    if (seen.has(tool.name)) continue;
    seen.add(tool.name);
    belt.push(tool);
  }
  return belt;
}

/** Section names present in an assembled system prompt, in order. */
function sectionNames(system: string): string[] {
  const names = [PROMPT_SECTION_BASE];
  // Anchor each heading to a whole line. An instruction file's source text is
  // quote-prefixed, but this also keeps any inline mention (from a base prompt
  // or a future section) from forging an audit entry.
  const has = (name: string): boolean =>
    new RegExp(`^## ${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "m").test(system);
  if (has(PROMPT_SECTION_TOOLS)) names.push(PROMPT_SECTION_TOOLS);
  if (has(PROMPT_SECTION_USING_TOOLS)) names.push(PROMPT_SECTION_USING_TOOLS);
  if (has(PROMPT_SECTION_SKILLS)) names.push(PROMPT_SECTION_SKILLS);
  if (has(WORKSPACE_INSTRUCTIONS_HEADING)) names.push(PROMPT_SECTION_INSTRUCTIONS);
  return names;
}

/**
 * One tiny, strict-valid example payload per structured node kind (BACKLOG
 * "Structured-payload discipline", fix 3). Each entry is a real payload the
 * zod schema accepts — the tests validate every one — and stays at four or
 * five fields so it costs a few dozen tokens. The examples live in code only:
 * `shared/prompts.json` (both copies) stays byte-identical.
 */
export const PAYLOAD_EXAMPLES: Record<string, Record<string, unknown>> = {
  consult: { task: "…", ask: "…", expect: "proposal", deadline_hint: "today" },
  proposal: { title: "…", answer: "…", rationale: "…", risks: ["…"], confidence: 0.7 },
  delegation: { work: "…", acceptance: ["…"], return: "deliverable", notes: "" },
  deliverable: { result: "…", artifacts: ["path/to/artifact"], notes: "…", confidence: 0.8 },
  review: { verdict: "accept", notes: "…", points: ["…"] },
  decision: { decision: "…", rationale: "…", confidence: 0.7, dissent: null, accepted_proposals: ["…"] },
};

/**
 * The few-shot block appended after the tool sections of a kind-specific
 * system prompt, or "" for a kind without an example (`message`, `verify`).
 * It deliberately carries no `##` heading: the audit trail's section names
 * keep their stable `base` / `Available tools` / `Using tools` entries, and
 * the block is an inline format instruction rather than a prompt section.
 */
function payloadExampleBlock(kind: string): string {
  const example = PAYLOAD_EXAMPLES[kind];
  if (example === undefined) return "";
  return [
    "Reply with exactly one fenced json block of this shape, with your own values:",
    "",
    "```json",
    JSON.stringify(example),
    "```",
  ].join("\n");
}

export interface AssembledPrompt {
  text: string;
  /** Section names in append order (the base section first). */
  sections: string[];
}

/**
 * Optional extras for {@link assembleSystemPrompt}: the discovered skills, the
 * role the prompt is assembled for, and the already-rendered workspace
 * instructions block. The skills section is appended only when the role
 * actually has skills (`renderSkillsSection` returns null otherwise), and the
 * instructions block only when it is non-empty, so a harness with neither
 * produces exactly the pre-skills/pre-instructions prompt bytes.
 */
export interface PromptAssemblyOptions {
  skills?: SkillCatalog;
  role?: SkillRole;
  /** Rendered `## Workspace instructions` block; appended LAST. */
  instructions?: string;
}

/**
 * The one-line pointer that follows the `## Available skills` list. The body
 * stays out of the prompt (it is injected on demand via `renderSkillBody`);
 * this tells the model the invocation grammar.
 */
export const SKILLS_GUIDANCE =
  'To use a skill, reply with <skill name="skill-name"> and the skill\'s body will be provided.';

/**
 * The invocation grammar the guidance advertises: `<skill name="…">`, with an
 * optional closing slash and optional quotes. Case-insensitive, matching the
 * case-insensitive name lookup below. `g` so a reply may mention several
 * skills; `matchAll` clones the pattern and does not mutate `lastIndex`.
 */
const SKILL_REQUEST_RE = /<skill\s+name\s*=\s*["']?([a-z0-9_-]+)["']?\s*\/?\s*>/gi;

/**
 * Per-run cap on delivered skill bodies. Three is enough for a cooperation
 * cycle to pick up the common failure/coding/checklist skills; beyond that the
 * context cost outweighs the value, and a model looping on `<skill>` must not
 * be able to grow the transcript without bound.
 */
const MAX_SKILL_INJECTIONS = 3;

/**
 * The delivery block appended when the model asks for a skill: kimi-code's
 * `<skill-loaded name="…">body</skill-loaded>` convention. The body is the
 * skill's markdown alone — `skills.ts::renderSkillBody` wraps the SAME body in
 * `<skill name="…">`, so reusing it here would nest two wrappers; the
 * `skill-loaded` element is the one marker consumers and models see.
 */
function renderSkillLoaded(name: string, body: string): string {
  return `<skill-loaded name="${name}">\n${body}\n</skill-loaded>`;
}

/**
 * Append pi-style tool sections to a role's base system prompt. With an empty
 * belt the model is told so explicitly instead of being left to guess; with a
 * belt it gets the exact model-facing names (MCP namespacing already applied
 * by `mcp.ts`) plus the use-these-tools directive. `kind` (when given) is the
 * structured node kind the call answers and appends that kind's few-shot
 * payload example last, so the format sits closest to the reply.
 *
 * `options.skills` + `options.role` append the pi-style `## Available skills`
 * section (shared scope plus the role's own) and the invocation guidance line;
 * a role without skills gets neither the section nor the sections-list entry,
 * keeping the prompt byte-identical to the pre-skills assembly.
 *
 * `options.instructions` appends the rendered workspace-instructions block
 * after every other section (including the kind's payload example), so a
 * workspace with no instruction files leaves the prompt bytes unchanged.
 */
export function assembleSystemPrompt(
  base: string,
  tools: Tool[],
  kind?: string,
  options: PromptAssemblyOptions = {},
): AssembledPrompt {
  const belt = uniqueBelt(tools);
  const example = kind === undefined ? "" : payloadExampleBlock(kind);
  const parts = [base];
  const sections = [PROMPT_SECTION_BASE];
  if (belt.length === 0) {
    parts.push(`## ${PROMPT_SECTION_TOOLS}\n\nYou have no tools; answer from the transcript.`);
    sections.push(PROMPT_SECTION_TOOLS);
  } else {
    parts.push(`## ${PROMPT_SECTION_TOOLS}\n\n${belt.map(toolLine).join("\n")}`);
    parts.push(`## ${PROMPT_SECTION_USING_TOOLS}\n\n${USING_TOOLS_BODY}`);
    sections.push(PROMPT_SECTION_TOOLS, PROMPT_SECTION_USING_TOOLS);
  }
  const skills = options.skills;
  const role = options.role;
  if (skills !== undefined && role !== undefined) {
    const skillsSection = renderSkillsSection(skills, role);
    if (skillsSection !== null) {
      parts.push(skillsSection);
      parts.push(SKILLS_GUIDANCE);
      sections.push(PROMPT_SECTION_SKILLS);
    }
  }
  if (example) parts.push(example);
  if (options.instructions !== undefined && options.instructions !== "") {
    parts.push(options.instructions);
    sections.push(PROMPT_SECTION_INSTRUCTIONS);
  }
  return { text: parts.join("\n\n"), sections };
}

// ---------------------------------------------------------------------------
// same-session serialization (RunManager scheduling rule in runtime.py:
// same-session runs stay strictly serialized so envelope seq never corrupts)
// ---------------------------------------------------------------------------

const fileSessionTails = new Map<string, Promise<void>>();
const contextSessionTails = new WeakMap<SharedContext, Promise<void>>();

/**
 * Acquire the in-process mutex for `ctx`'s session: keyed by the session
 * file path when the context persists to one, otherwise by context identity.
 * Concurrent `run()` calls on the same session queue up (never interleave);
 * resolves to a function that releases the mutex.
 */
function acquireSession(ctx: SharedContext): Promise<() => void> {
  let get: () => Promise<void> | undefined;
  let set: (tail: Promise<void>) => void;
  if (ctx.store !== null) {
    const key = `file:${ctx.store.path}`;
    get = () => fileSessionTails.get(key);
    set = (tail) => {
      fileSessionTails.set(key, tail);
    };
  } else {
    get = () => contextSessionTails.get(ctx);
    set = (tail) => {
      contextSessionTails.set(ctx, tail);
    };
  }
  const prev = get() ?? Promise.resolve();
  let releaseFn!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });
  set(prev.then(() => current));
  return prev.then(() => releaseFn);
}

// ---------------------------------------------------------------------------
// harness options / result
// ---------------------------------------------------------------------------

/**
 * The three role scopes a tool can be assigned to (BACKLOG "Role-scoped
 * tool context"). `shared` tools are callable by both brothers; `senior` /
 * `junior` tools stay on that role's belt only.
 */
export type ToolRoleScope = "shared" | "senior" | "junior";

/**
 * Role-scoped tool registry. Belt composition (workspace built-ins aside):
 * the junior belt is `shared + junior`, the senior's verify slice is
 * `shared + senior` — the workspace's read-only filter
 * (`SENIOR_VERIFY_TOOL_NAMES`) still applies to the workspace built-ins at
 * verify time; explicitly scoped tools join unfiltered.
 */
export interface ToolScopes {
  /** Callable by both brothers (e.g. a shared memory tool). */
  shared?: Tool[];
  /** Senior-only: joins the verify slice unfiltered. */
  senior?: Tool[];
  /** Junior-only: joins the junior's delegation belt. */
  junior?: Tool[];
}

export interface HarnessOptions {
  /** Senior provider override (tests/custom wiring). */
  senior?: Provider;
  /** Junior provider override (tests/custom wiring). */
  junior?: Provider;
  /**
   * Per-role resolved endpoints (Stage 18): when a role's endpoint is given,
   * that role's provider is built from its own baseUrl/apiKey/model
   * (`providerFromEndpoint`); an endpoint with empty fields falls back per
   * field to the shared config. Roles without an endpoint keep today's
   * shared-config provider construction.
   */
  endpoints?: { senior?: RoleEndpoint; junior?: RoleEndpoint };
  /**
   * Role-scoped tool registry (BACKLOG "Role-scoped tool context"): `shared`
   * tools join both brothers' belts, `senior` tools join only the senior's
   * verify slice, `junior` tools join only the junior's delegation belt.
   * MCP servers load through `mcp.ts` and hand their per-role tool lists in
   * here (keeping the MCP client alive for the run is the caller's job).
   */
  toolScopes?: ToolScopes;
  /**
   * Back-compat shorthand for `toolScopes.junior`: the junior's full tool
   * set (workspace + plugins + MCP in Python). New code should prefer
   * `toolScopes`.
   */
  tools?: Tool[];
  /**
   * A confined workspace: its tools (`workspace_*`) become the junior's tool
   * set (prepended to the junior belt), with mutations gated by the
   * workspace's PermissionManager/approval broker. The senior automatically
   * gets the read-only verify slice via SENIOR_VERIFY_TOOL_NAMES.
   */
  workspace?: Workspace;
  /**
   * Root-level workspace instructions (`AGENTS.md`, then `CLAUDE.md`) appended
   * last to both roles' system prompts. Enabled by default for a
   * workspace-bound harness (`workspace` set); `false` disables it. An options
   * object overrides the candidate names and the per-file / aggregate
   * character caps. The files are read once in the constructor, only as
   * regular files directly under `workspace.root` (never symlinks or nested
   * paths); text is capped, de-duplicated and rendered as UNTRUSTED project
   * guidance — it never overrides the system/operator instructions or grants
   * permissions. No files means no prompt section and byte-identical prompts.
   */
  projectInstructions?: false | {
    /** Root-level file names in load order (default `AGENTS.md`, `CLAUDE.md`). */
    files?: readonly string[];
    /** Per-file character cap (default 16 Ki). */
    maxChars?: number;
    /** Aggregate character cap (default 32 Ki). */
    maxTotalChars?: number;
  };
  /**
   * Back-compat shorthand for `toolScopes.senior`: extra senior tools
   * joining the verify slice unfiltered — the analogue of Python's
   * `plugin_tools["senior"]` (operator-installed extensions).
   */
  seniorTools?: Tool[];
  /**
   * Context compaction (pi's algorithm ported in `compaction.ts`): when the
   * rendered context passes `thresholdChars - reserveChars` (char mode) or
   * `contextWindow - reserveTokens` estimated tokens (token mode, active when
   * `contextWindow` or `thresholdTokens` is set), an old prefix is summarized
   * by the configured provider (the senior's by default — the existing
   * `Provider` abstraction, never a second HTTP client) and replaced by a
   * marked summary event; `force` compacts once at the start (`--compact`).
   * A `ProviderContextOverflowError` from any provider call compacts once and
   * retries that call (overflow recovery works even without a threshold; a
   * known window sizes the recovery budgets in tokens). Fail-soft by contract:
   * a summarization failure logs a warning (`result.warnings`) and the run
   * continues with the full context.
   */
  compaction?: CompactionSettings;
  /**
   * Bounded tool-output spill: when set, a plain-text tool result longer than
   * `maxInlineChars` (default 20,000) is saved in full under `root` and the
   * model receives a bounded head/tail preview plus a
   * `[[SPILL id=… chars=…]]` marker and one `spill_read` instruction line.
   * `spill_read` joins both role belts and reads only validated spill ids,
   * never a path. A storage failure is
   * fail-soft: the result falls back to the existing clipping marker and the
   * run records one warning. Files persist until the operator removes `root`;
   * the harness does not delete them.
   */
  spill?: SpillOptions;
  /**
   * Advisory repeat-tool-call guard (`repeatguard.ts`): one instance per
   * tool-loop invocation counts consecutive calls with the same tool name and
   * canonically identical arguments, and appends a gentle reminder to the
   * MODEL-FACING tool result at the first threshold (default 3) and a detailed
   * one at later thresholds (5, 8). It never blocks a call; a new user message
   * (or the next node's loop) resets the chain. Enabled by default with the
   * defaults; `false` disables it. Runtime `tool_completed`/stream
   * `tool_result` records and protocol envelopes are unchanged.
   */
  repeatToolGuard?: RepeatToolGuardOptions | false;
  /** Overrides `cfg.maxRounds` for this harness instance. */
  maxRounds?: number;
  /**
   * Plugin lifecycle hooks (`plugins.ts`): `session_start` / `session_end`
   * around the run and `before_tool_call` / `after_tool_call` around every
   * tool execution. Dispatch is fail-soft (a throwing handler is recorded on
   * its plugin's diagnostics and never breaks the run); a `before_tool_call`
   * deny is monotonic and turns the call into a `blocked` tool result.
   */
  hooks?: HookRegistry;
  /**
   * Discovered skills (`skills.ts`). Each role's system prompt advertises the
   * `shared` skills plus its own scope; a role with no skills gets no section,
   * so the prompt bytes are unchanged when nothing is configured.
   */
  skills?: SkillCatalog;
  /** Cooperative cancellation: checked between model calls. */
  signal?: AbortSignal;
  /** Typed runtime-event hook (tool_started / tool_completed / prompt_audit). */
  onEvent?: (event: RuntimeEvent) => void;
  /**
   * Per-envelope hook (the Python graph's `on_event=`): called with every
   * protocol envelope appended during the run, including the initial user
   * message — the server's SSE bridge turns these into `envelope` events.
   */
  onEnvelope?: (message: Message) => void;
  /**
   * In-process run stream (`runstream.ts`, the `run --stream` NDJSON
   * channel): `run_status` started/terminal, one `envelope` per appended
   * envelope, `repair` per repair pass, `tool_call`/`tool_result` around
   * every tool execution, and a terminal `result` summary on completion.
   * Fail-soft: a throwing sink never breaks the run. This is additional to
   * (never a replacement for) `onEvent` / `onEnvelope` and the server's
   * `RuntimeEventStore` SSE path.
   */
  onStreamEvent?: (event: StreamEvent) => void;
  /**
   * Ask providers to stream their replies and emit one `token` stream event
   * per delta (`{type: "token", role, kind: "text" | "thinking", delta, at}`),
   * in arrival order: `kind: "text"` for visible reply text and
   * `kind: "thinking"` for the model's reasoning deltas. Thinking deltas are
   * observational — they never enter the reply, the protocol envelopes or the
   * usage counters. Only active together with `onStreamEvent` — with no
   * consumer the call is exactly the non-streaming request, so unset/default
   * behavior (and the bytes on the wire) stay byte-identical. Token events are
   * additive to the envelope records; the reply value, usage accounting,
   * repair pass and tool loop are unchanged, and a mid-stream failure follows
   * the normal retry rules (deltas already delivered stay delivered).
   */
  streamTokens?: boolean;
  /**
   * Mid-run operator steering (wave 23): a drain callback read at every
   * state-machine node boundary and at every tool-loop iteration. Each
   * returned text is appended to the shared context as an ordinary protocol
   * `message` envelope from "user" to "senior" — payload `{text}`, dense
   * `seq`, session JSONL included — prefixed with {@link STEERING_PREFIX}, so
   * the NEXT provider call sees it. The callback is expected to
   * return-and-clear (a drained queue); it is called at most once per
   * boundary, in order, and never after the run is cancelled/terminal. Fail
   * soft by contract: a throwing callback (or a malformed return) records one
   * warning and never breaks the run. No new protocol kind/field and no
   * session-format change; an SSE consumer sees the envelope only when the
   * harness actually appends it.
   */
  steering?: () => string[];
  /**
   * Per-attempt-timeout diagnostics (`provider.ts`): called at most once per
   * timed-out attempt that will be retried, never when the run is quiet.
   * Defaults to the provider's own sink (`console.error`), so warnings are
   * stderr-only and stdout stays pure in every output mode. The CLI passes
   * its `CliIO.error` through a three-per-run cap.
   */
  onProviderWarning?: (line: string) => void;
}

/**
 * One provider call's prompt/tool-belt audit record. Deliberately carries
 * names and lengths only — never prompt bodies, which may contain secrets.
 */
export interface PromptAuditEntry {
  role: "senior" | "junior";
  /**
   * The node kind the call answers: consult / delegation / proposal /
   * deliverable / verify / review / decision.
   */
  kind: string;
  /** Assembled system-prompt section names, in order. */
  sections: string[];
  /** Model-facing tool names offered on this call (MCP namespacing applied). */
  tools: string[];
  /**
   * Workspace instruction sources represented in this call's system prompt:
   * labels and included character counts only (never content). Absent when
   * the prompt carries no workspace-instructions section.
   */
  instructions?: Array<{ label: string; chars: number }>;
  /** Characters in the assembled system prompt. */
  systemChars: number;
  /** Characters in the rendered user message (the shared context). */
  userChars: number;
}

export interface HarnessResult {
  task: string;
  messages: Message[];
  decision: Record<string, unknown>;
  rounds: number;
  context: SharedContext;
  errors: string[];
  /**
   * Fail-soft warnings (never run errors; a run with warnings still exits 0):
   * compaction failures ("context compaction failed: …; continuing with the
   * full context") and a broken/malformed operator-steering callback
   * ("operator steering failed: …; continuing without it"). Dropped steer
   * envelopes at {@link MAX_STEERING_ENVELOPES_PER_RUN} warn the same way.
   */
  warnings: string[];
  /** True when the run was stopped by the operator mid-cycle. */
  cancelled: boolean;
  /** Merged token usage of both roles' providers (zeros when untracked). */
  usage: UsageTotals;
  /**
   * Per-provider-call prompt/tool-belt audit trail, in call order: assembled
   * section names, the belt offered, and both prompt lengths. Summarizer
   * (compaction) calls are not role prompt calls and stay out of the trail.
   */
  promptAudits: PromptAuditEntry[];
  /**
   * The run's latest plan/todo snapshot, when the model wrote one through the
   * built-in `todo_write` tool (whole-list replacement, last write wins).
   * Display state only: it never touches the workspace, the context or the
   * session JSONL; consumers that do not render a plan can ignore it.
   */
  todos?: TodoItem[];
}

interface CooperationState {
  task: string;
  mode: string;
  maxRounds: number;
  ctx: SharedContext;
  runEvents: Message[];
  rounds: number;
  lastVerdict: string;
  decision: Record<string, unknown>;
  errors: string[];
  verifyEvidence: string[];
  verifySummary: string;
  /** The `--compact` one-shot, consumed by the next maybeCompact. */
  compactNow: boolean;
  /** Per-provider-call prompt/tool-belt audit trail, in call order. */
  promptAudits: PromptAuditEntry[];
  /**
   * Denied `(action, target)` approval pairs and their denial counts. When a
   * pair reaches `APPROVAL_DENY_LIMIT` operator denials, further identical
   * requests are auto-denied without waking the broker (a stubborn model
   * cannot park the run in `waiting` forever).
   */
  approvalDenials: Map<string, number>;
  /**
   * Skill names whose bodies were delivered this run. Doubles as the
   * injection counter (`MAX_SKILL_INJECTIONS` cap) and the no-repeat guard —
   * a skill is delivered at most once per run.
   */
  injectedSkills: Set<string>;
  /**
   * The latest plan/todo snapshot written through the built-in `todo_write`
   * tool (whole-list replacement, last write wins). UI state only: never read
   * by the cooperation flow, never persisted in protocol envelopes.
   */
  todos: TodoItem[];
}

type NodeName =
  | "senior_open"
  | "junior_answer"
  | "senior_verify"
  | "senior_review"
  | "junior_revise"
  | "senior_decide";

type NodeResult = NodeName | "END";

function usageOf(provider: Provider): UsageTotals {
  const tracked = provider as Provider & { usageSnapshot?: () => UsageTotals };
  return typeof tracked.usageSnapshot === "function" ? tracked.usageSnapshot() : emptyUsage();
}

/**
 * Map a runtime `tool_completed` status onto the stream's three-way status.
 * Tools may report arbitrary strings through `compactToolResult`; only the
 * `blocked` (plugin deny) and `ok` cases are carried verbatim, everything
 * else is an error for a stream consumer.
 */
function streamToolStatus(status: string): StreamToolStatus {
  if (status === "ok") return "ok";
  if (status === "blocked") return "blocked";
  return "error";
}

/**
 * How many operator denials of one `(action, target)` pair are allowed before
 * identical repeat requests are auto-denied. Two denials means the third
 * identical request never wakes the broker (the operator already said no
 * twice; a model that keeps asking must not park the run in `waiting`).
 *
 * The canonical value lives in `src/runevents.ts` (the broker enforces it for
 * every approval path); re-exported here as the harness API. Two layers share
 * it and never double-count one request:
 * - `invokeTool` below caps the built-in workspace tools *before* the
 *   workspace `PermissionManager` reaches its broker, keeping the model-facing
 *   `status: "denied"` / `auto_denied: true` result shape;
 * - `RunApprovalBroker` caps every other consumer of the same broker
 *   (plugin/MCP-contributed approval paths and custom `PermissionManager`s)
 *   and emits the additive `approval_auto_denied` runtime event.
 * A workspace tool that trips the harness cap is auto-denied before the
 * broker sees the request, so the broker counter only ever records real
 * operator answers.
 */
export { APPROVAL_DENY_LIMIT };

/**
 * Workspace mutation tools that park on an operator approval, mapped to the
 * permission action `Workspace.authorize` requests and the short tool name
 * its result record carries. Only these are cap-tracked: the workspace is the
 * one path with a PermissionManager broker.
 */
const APPROVAL_TOOL_SPECS: Record<string, { action: string; record: string }> = {
  workspace_write_file: { action: "write", record: "write_file" },
  workspace_edit_file: { action: "edit", record: "edit_file" },
  workspace_delete_file: { action: "delete", record: "delete_file" },
  workspace_run_shell: { action: "shell", record: "run_shell" },
};

export interface ApprovalPair {
  /** Comparison key: `action\0normalized-target` (case-folded on Windows). */
  key: string;
  action: string;
  /** Short tool name the workspace result record uses (`write_file`, …). */
  record: string;
  /** Model-facing target (workspace-relative path, or "" for shell). */
  target: string;
  /** The shell command for `shell`, else "". */
  command: string;
}

/**
 * The cap-tracked pair for one tool call, or null for tools without approvals.
 * Mirrors `approvalPairKey`/`approvalMatchTarget` in `runevents.ts` (the
 * broker-level cap) so the same request shape is counted consistently: the
 * comparison target is normalized the same way (a shell request compares its
 * command) and the key is case-folded on Windows.
 */
export function approvalPair(
  toolName: string,
  args: Record<string, unknown>,
): ApprovalPair | null {
  const spec = APPROVAL_TOOL_SPECS[toolName];
  if (spec === undefined) return null;
  const command = spec.action === "shell" ? String(args.command ?? "").trim() : "";
  const target = spec.action === "shell" ? "" : normalizeApprovalTarget(String(args.path ?? ""));
  const keyTarget = spec.action === "shell" ? command : target;
  const key = `${spec.action}\u0000${process.platform === "win32" ? keyTarget.toLowerCase() : keyTarget}`;
  return { key, action: spec.action, record: spec.record, target, command };
}

/**
 * Build one role's provider from its resolved endpoint (Stage 18 per-role
 * endpoints): `mock` endpoints get a MockProvider, `openai` endpoints an
 * HTTP provider over the endpoint's own baseUrl/apiKey/model — the adapter
 * (openai-compatible/anthropic/google) comes from the endpoint's preset
 * `kind` when the connection resolved through a named preset, else from the
 * run-level config kinds (CLI/env). Empty endpoint fields fall back per
 * field to the shared `Config` — Python's `role_base_url or cfg.base_url`
 * semantics. Returns null when no endpoint is given (the caller then uses
 * the shared-config path).
 */
function providerFromEndpoint(
  cfg: Config,
  role: "senior" | "junior",
  endpoint: RoleEndpoint | undefined,
  onWarning?: (line: string) => void,
): Provider | null {
  if (endpoint === undefined) return null;
  const provider = endpoint.provider || cfg.provider;
  if (provider === "mock") return new MockProvider();
  if (provider === "openai") {
    // A preset kind is intrinsic to the preset URL (it wins); otherwise the
    // role/run-level chain applies. resolveProviderKind validates and throws
    // a clear error on unknown kinds before any endpoint is contacted.
    const kind = endpoint.kind
      ? resolveProviderKind({ kind: endpoint.kind, seniorKind: "", juniorKind: "" }, role)
      : resolveProviderKind(cfg, role);
    const config = {
      provider,
      baseUrl: endpoint.baseUrl || cfg.baseUrl,
      apiKey: endpoint.apiKey || cfg.apiKey,
      seniorModel: cfg.seniorModel,
      juniorModel: cfg.juniorModel,
      temperature: cfg.temperature,
      timeout: cfg.timeout,
      retries: cfg.retries,
      contextWindow: cfg.contextWindow,
      maxTokens: maxTokensForRole(cfg, role),
      thinkingBudgetTokens: thinkingBudgetForRole(cfg, role),
      model: endpoint.model || (role === "senior" ? cfg.seniorModel : cfg.juniorModel),
      ...(onWarning ? { onWarning } : {}),
    };
    if (kind === "anthropic") return new AnthropicProvider(config);
    if (kind === "google") return new GoogleProvider(config);
    return new OpenAICompatibleProvider(config);
  }
  throw new Error(`unknown provider: ${provider}`);
}

/**
 * Per-provider-call reasoning capture (streaming-only). `options` is exactly
 * the pre-capture `ChatOptions` when token streaming is off (undefined), so the
 * wire call is byte-identical; `finish()` then never emits. With streaming on,
 * `options` wraps the live thinking sink with a buffer and `finish()` emits the
 * call's ONE bounded, sanitized `reasoning` runtime event when any thinking
 * text arrived. `finish()` is called in the call site's `finally`, so a failed
 * or cancelled call still records the partial reasoning it streamed.
 */
interface ReasoningCapture {
  options: ChatOptions | undefined;
  finish(): void;
}

export class TwoBrothersHarness {
  readonly cfg: Config;
  readonly providers: Record<"senior" | "junior", Provider>;
  readonly options: HarnessOptions;
  private readonly prompts = loadPrompts();
  lastErrors: string[] = [];
  /** Set once a compaction attempt failed this run: never hammer a failing summarizer. */
  private compactionFailed = false;
  private compactionWarnings: string[] = [];
  /** Fail-soft tool-output spill warnings (folded into `result.warnings`). */
  private spillWarnings: string[] = [];
  /** Spill storage, or null when `options.spill` is unset (current clipping). */
  private readonly spillStore: SpillStore | null;
  /** Fail-soft operator-steering warnings (folded into `result.warnings`). */
  private steeringWarnings: string[] = [];
  /** Set once a steering callback failed this run: never call it again. */
  private steeringFailed = false;
  /** Steer envelopes appended this run (capped by MAX_STEERING_ENVELOPES_PER_RUN). */
  private steeringCount = 0;
  /** Rendered root-level workspace instructions ("" when none or disabled). */
  private readonly instructionBlock: string;
  /** Labels/included lengths for the prompt audit (never instruction bodies). */
  private readonly instructionAudit: Array<{ label: string; chars: number }>;
  /** Fail-soft workspace-instruction warnings (folded into `result.warnings`). */
  private readonly instructionWarnings: string[] = [];

  constructor(cfg: Config, options: HarnessOptions = {}) {
    this.cfg = cfg;
    this.options = options;
    this.spillStore = options.spill === undefined ? null : new SpillStore(options.spill.root);
    let instructionBlock = "";
    let instructionAudit: Array<{ label: string; chars: number }> = [];
    try {
      const loaded = this.readWorkspaceInstructions();
      instructionBlock = loaded.text;
      instructionAudit = loaded.summary;
    } catch (error) {
      this.instructionWarnings.push(
        `workspace instructions failed: ${error instanceof Error ? error.message : String(error)}; continuing without them`,
      );
    }
    this.instructionBlock = instructionBlock;
    this.instructionAudit = instructionAudit;
    const warn = options.onProviderWarning;
    this.providers = {
      senior:
        options.senior ??
        providerFromEndpoint(cfg, "senior", options.endpoints?.senior, warn) ??
        buildProvider(warn ? { ...cfg, onWarning: warn } : cfg, "senior"),
      junior:
        options.junior ??
        providerFromEndpoint(cfg, "junior", options.endpoints?.junior, warn) ??
        buildProvider(warn ? { ...cfg, onWarning: warn } : cfg, "junior"),
    };
  }

  /**
   * Load the root-level workspace instructions once (constructor time).
   * Default-off when there is no workspace or `projectInstructions: false`;
   * every failure is fail-soft and only adds a warning. Returns the rendered
   * block plus the names-and-lengths audit projection.
   */
  private readWorkspaceInstructions(): {
    text: string;
    summary: Array<{ label: string; chars: number }>;
  } {
    const root = this.options.workspace?.root;
    if (root === undefined || this.options.projectInstructions === false) {
      return { text: "", summary: [] };
    }
    const setting = this.options.projectInstructions ?? {};
    const files: WorkspaceInstructionFile[] = loadWorkspaceInstructions(root, {
      ...(setting.files !== undefined ? { files: setting.files } : {}),
      ...(setting.maxChars !== undefined ? { maxChars: setting.maxChars } : {}),
      ...(setting.maxTotalChars !== undefined ? { maxTotalChars: setting.maxTotalChars } : {}),
      onWarning: (message) => {
        this.instructionWarnings.push(message);
      },
    });
    return {
      text: renderWorkspaceInstructions(files),
      summary: files.map((file) => ({ label: file.label, chars: file.chars })),
    };
  }

  /**
   * The assembled system prompt for one role: the base prompt text plus the
   * role's tool sections. `tools` is the belt the call actually offers (empty
   * for a plain text-only call), so the `## Available tools` section always
   * matches what the request carries. `kind` is the structured node kind the
   * call answers; when given, its few-shot payload example is appended.
   */
  systemPrompt(role: string, tools: Tool[] = [], kind?: string): string {
    return this.assemblePrompt(role, tools, kind).text;
  }

  private assemblePrompt(role: string, tools: Tool[], kind?: string): AssembledPrompt {
    const base =
      role === "senior"
        ? this.cfg.seniorSystem || this.prompts.senior
        : this.cfg.juniorSystem || this.prompts.junior;
    return assembleSystemPrompt(base, tools, kind, {
      ...(this.options.skills !== undefined ? { skills: this.options.skills } : {}),
      role: role === "senior" ? "senior" : "junior",
      ...(this.instructionBlock !== "" ? { instructions: this.instructionBlock } : {}),
    });
  }

  // -- cancellation / events -------------------------------------------------

  private checkCancel(): void {
    if (this.options.signal?.aborted) {
      throw new ProviderAbortError();
    }
  }

  private emitRuntime(event: RuntimeEvent): void {
    this.options.onEvent?.(event);
  }

  /**
   * Publish one event on the in-process run stream (`run --stream`). Fail-soft
   * by contract: a throwing sink is swallowed, so a broken consumer never
   * changes the run's outcome. Independent of `emitRuntime`/`onEnvelope` and
   * of the server's SSE store.
   */
  private emitStream(event: StreamEvent): void {
    const sink = this.options.onStreamEvent;
    if (sink === undefined) return;
    try {
      sink(event);
    } catch {
      // a broken stream consumer never breaks a run
    }
  }

  /**
   * The per-call streaming options, defined only when token streaming is
   * requested AND a stream consumer exists. This is the single provider-call
   * seam: every plain (`chat`) and tool-loop (`chatWithTools`) role call —
   * including overflow retries and the repair re-ask — asks this for its
   * `ChatOptions`, so text AND thinking token events are uniformly additive
   * and a run without `streamTokens` passes `undefined` (the pre-streaming
   * call, unchanged). Both sinks are always provided together; which deltas
   * actually arrive is the provider/wire's business.
   */
  private streamOptions(role: "senior" | "junior"): ChatOptions | undefined {
    if (this.options.streamTokens !== true || this.options.onStreamEvent === undefined) {
      return undefined;
    }
    const token = (kind: "text" | "thinking", delta: string): void =>
      this.emitStream({ type: "token", role, kind, delta, at: nowIso() });
    return {
      onDelta: (delta: string) => token("text", delta),
      onThinkingDelta: (delta: string) => token("thinking", delta),
    };
  }

  /**
   * Wrap one provider call's thinking sink with a bounded capture (see
   * {@link ReasoningCapture}). The capture is active only on the same
   * streaming path as `streamOptions()`: a run without token streaming gets
   * `options: undefined`, so the call is byte-identical and no reasoning is
   * requested (the provider contract returns none there). `finish()` emits at
   * most ONE additive `reasoning` runtime event per call — sanitized with the
   * shared output sanitizer, bounded head+tail at
   * `REASONING_EVENT_MAX_CHARS`, and never a throw (persistence is not allowed
   * to break a run).
   */
  private reasoningCapture(role: "senior" | "junior", kind: string): ReasoningCapture {
    const options = this.streamOptions(role);
    if (options === undefined) return { options: undefined, finish: () => undefined };
    const chunks: string[] = [];
    const liveThinking = options.onThinkingDelta;
    return {
      options: {
        ...options,
        onThinkingDelta: (delta: string) => {
          chunks.push(delta);
          liveThinking?.(delta);
        },
      },
      finish: () => {
        try {
          if (chunks.length === 0) return;
          const text = sanitizeOutput(chunks.join(""));
          if (text.trim() === "") return;
          const bounded = boundOutput(text, REASONING_EVENT_MAX_CHARS);
          this.emitRuntime({
            type: "reasoning",
            role,
            kind,
            text: bounded.text,
            truncated: bounded.truncated,
          });
        } catch {
          // reasoning persistence is additive: a broken consumer never breaks a run
        }
      },
    };
  }

  /** The terminal `result` record's payload: a JSON-safe HarnessResult projection. */
  private streamSummary(result: HarnessResult, ctx: SharedContext): HarnessResultSummary {
    return {
      decision: result.decision,
      usage: result.usage,
      warnings: result.warnings.length,
      sessionFile: ctx.store !== null ? ctx.store.path : null,
    };
  }

  // -- usage -----------------------------------------------------------------

  /** Merged token usage of both roles' providers (zeros when untracked). */
  usageSnapshot(): UsageTotals {
    return mergeUsage(usageOf(this.providers.senior), usageOf(this.providers.junior));
  }

  // -- context helpers ---------------------------------------------------------

  private append(
    state: CooperationState,
    from: string,
    to: string,
    kind: string,
    payload: Record<string, unknown>,
  ): Message {
    const msg = state.ctx.makeAndAppend(from, to, kind, payload);
    this.publishEnvelope(state, msg);
    return msg;
  }

  /**
   * The single envelope publication path: record the envelope in the run's
   * event list, hand it to the Python-parity `onEnvelope` hook and emit it on
   * the in-process run stream. Used by every append site — node replies,
   * repair turns, the initial user task and the compaction summary — so a
   * stream consumer sees exactly the envelopes the result carries.
   */
  private publishEnvelope(state: CooperationState, message: Message): void {
    state.runEvents.push(message);
    this.options.onEnvelope?.(message);
    this.emitStream({ type: "envelope", envelope: message, at: nowIso() });
  }

  /**
   * Drain the operator-steering callback once and append one ordinary
   * `message` envelope per drained text (user → senior, payload `{text}` with
   * {@link STEERING_PREFIX} in front), so the next provider call sees it.
   *
   * Contract: at most one callback invocation per boundary (the callback is a
   * return-and-clear drain, preserving submission order); nothing is appended
   * after the run is cancelled (`signal` aborted) or when the run-lifetime cap
   * is reached; empty/non-string entries are ignored; a throwing callback or a
   * non-array return is fail-soft (one warning, never a run failure) and
   * disables further drains for the run — a permanently broken callback is not
   * hammered at every boundary. The appended texts are returned so a tool loop
   * can re-render its opening transcript; the shared context alone does not
   * reach the next request of an already-built tool conversation.
   */
  private drainSteering(state: CooperationState): string[] {
    const steering = this.options.steering;
    if (steering === undefined || this.steeringFailed) return [];
    if (this.options.signal?.aborted) return []; // a stopped run appends nothing
    if (this.steeringCount >= MAX_STEERING_ENVELOPES_PER_RUN) return [];
    let drained: unknown;
    try {
      drained = steering();
    } catch (err) {
      this.steeringFailed = true;
      this.steeringWarnings.push(
        `operator steering failed (${err instanceof Error ? err.message : String(err)}); continuing without it`,
      );
      return [];
    }
    if (!Array.isArray(drained)) {
      this.steeringFailed = true;
      this.steeringWarnings.push("operator steering failed (the callback did not return a list); continuing without it");
      return [];
    }
    const appended: string[] = [];
    // Normalize first so a drop count is exact: non-strings and blank texts
    // were never candidates and must not inflate the reported drop count.
    const texts: string[] = [];
    for (const raw of drained) {
      if (typeof raw !== "string") continue;
      const text = raw.trim();
      if (text !== "") texts.push(text);
    }
    for (const text of texts) {
      if (this.steeringCount >= MAX_STEERING_ENVELOPES_PER_RUN) {
        const dropped = texts.length - appended.length;
        this.steeringWarnings.push(
          `operator steering dropped: at most ${MAX_STEERING_ENVELOPES_PER_RUN} steer messages are applied per run`,
        );
        // Additive runtime event: the run's `public()` view aggregates it as
        // `steering_dropped`, so an HTTP client (and the SSE/sidecar consumer)
        // sees the leftover texts were discarded by the cap instead of only a
        // 200 acceptance. A drop is never silent.
        this.emitRuntime({
          type: "steering_dropped",
          dropped,
          applied: this.steeringCount,
          limit: MAX_STEERING_ENVELOPES_PER_RUN,
        });
        break;
      }
      const payload = STEERING_PREFIX + text;
      this.append(state, "user", "senior", "message", { text: payload });
      appended.push(payload);
      this.steeringCount += 1;
    }
    return appended;
  }

  /**
   * Record one provider call in the run's audit trail: section names, the
   * belt offered, and both prompt lengths. Called immediately before every
   * `chat`/`chatWithTools` call (overflow retries included), so the trail has
   * exactly one entry per provider request. Never records prompt bodies.
   * The same entry is emitted as a `prompt_audit` runtime event, so a live
   * consumer sees it before the call's tool/envelope events.
   */
  private auditPrompt(
    state: CooperationState,
    role: "senior" | "junior",
    kind: string,
    messages: ChatMessage[],
    tools: Tool[],
  ): void {
    const system = messages.find((message) => message.role === "system")?.content ?? "";
    const user = messages.find((message) => message.role === "user")?.content ?? "";
    const sections = sectionNames(system);
    const entry: PromptAuditEntry = {
      role,
      kind,
      sections,
      tools: uniqueBelt(tools).map((tool) => tool.name),
      ...(sections.includes(PROMPT_SECTION_INSTRUCTIONS) && this.instructionAudit.length > 0
        ? { instructions: this.instructionAudit.map((item) => ({ ...item })) }
        : {}),
      systemChars: system.length,
      userChars: user.length,
    };
    state.promptAudits.push(entry);
    this.emitRuntime({ type: "prompt_audit", ...entry });
  }

  /** Structured ask: tolerant parse → sanitize (the Python text fallback path). */
  private async ask(
    state: CooperationState,
    role: "senior" | "junior",
    responseKind: string,
  ): Promise<Record<string, unknown>> {
    const build = (): ChatMessage[] =>
      state.ctx.renderForRole(role, this.systemPrompt(role, [], responseKind));
    return this.askWithMessages(state, role, responseKind, build(), build);
  }

  private async askWithMessages(
    state: CooperationState,
    role: "senior" | "junior",
    responseKind: string,
    messages: ChatMessage[],
    rebuild?: () => ChatMessage[],
  ): Promise<Record<string, unknown>> {
    this.checkCancel();
    let text: string;
    // One reasoning record for this node call (streaming-only; a no-op when
    // token streaming is off or the call produced no thinking deltas).
    const capture = this.reasoningCapture(role, responseKind);
    try {
      this.auditPrompt(state, role, responseKind, messages, []);
      try {
        text = await this.providers[role].chat(messages, responseKind, this.options.signal, capture.options);
      } catch (err) {
        if (!(err instanceof ProviderContextOverflowError)) throw err;
        // pi's overflow recovery: compact once and retry the same node against
        // the compacted context. A second overflow surfaces to the caller.
        if (!(await this.compactAfterOverflow(state))) throw err;
        const retry = rebuild === undefined ? messages : rebuild();
        this.auditPrompt(state, role, responseKind, retry, []);
        text = await this.providers[role].chat(retry, responseKind, this.options.signal, capture.options);
      }
    } finally {
      capture.finish();
    }
    const reply = await this.structuredReply(
      state,
      role,
      responseKind,
      messages,
      text,
      this.lastErrors,
      rebuild,
    );
    return sanitizePayload(responseKind, reply.payload, reply.text, taskOf(state.ctx));
  }

  /**
   * Enforce the strict payload contract on one node reply, with at most ONE
   * repair re-ask. The tolerant parse runs first (it never throws); a reply
   * that fails the strict check — no JSON payload, a required field missing,
   * or a schema violation such as an out-of-enum verdict — gets one relaxed
   * strict-parse chance (BACKLOG fix 2): any JSON object deeper in the reply
   * (a later fenced block after a thinking block, a bare object surrounded by
   * prose with stray braces) that fully passes the same strict check is the
   * payload, so a valid bare/fenced JSON reply never takes a needless repair.
   * Only when no candidate passes does the repair turn get appended to the
   * shared context and re-sent OpenAI-style. If the repair cannot be attempted
   * (context overflow with nothing to compact) or its reply is still not
   * strict, the LAST reply goes to the caller and the tolerant pipeline
   * (sanitize + defaults) plus one warning records the degradation — exactly
   * the pre-repair behavior, never an exception.
   *
   * `warn` receives the run-scoped warning target (`lastErrors` for the plain
   * path, `state.errors` for the tool-loop deliverable — unchanged).
   */
  private async structuredReply(
    state: CooperationState,
    role: "senior" | "junior",
    kind: string,
    messages: ChatMessage[],
    text: string,
    warn: string[],
    rebuild?: () => ChatMessage[],
  ): Promise<{ text: string; payload: Record<string, unknown> }> {
    let reply = text;
    let parsed: Record<string, unknown>;
    let failed: boolean;
    if (STRUCTURED_PAYLOAD_KINDS.has(kind)) {
      let check = strictReplyCheck(kind, reply);
      let issues = check.issues;
      parsed = check.payload;
      if (issues !== null) {
        const request = buildRepairRequest(kind, issues);
        const repaired = await this.repairReply(state, role, kind, messages, reply, request, rebuild);
        if (repaired !== null) {
          reply = repaired;
          check = strictReplyCheck(kind, reply);
          parsed = check.payload;
          issues = check.issues;
        }
      }
      failed = issues !== null;
    } else {
      const initial = parseModelOutput(reply, kind);
      parsed = initial.payload;
      failed = initial.parseFailed;
    }
    if (failed) warn.push(`unstructured model reply for ${kind}`);
    // The payload is already parsed; delivery only enriches the shared context
    // for the turns that follow (the node's own append happens next).
    this.deliverSkillRequest(state, role, reply);
    return { text: reply, payload: parsed };
  }

  /**
   * Detect a `<skill name="…">` request in a node's raw reply and deliver ONE
   * skill body as a `message` envelope from "user" (kimi-code's convention:
   * the harness detects the request, the body arrives as a context event).
   *
   * Guards, all fail-soft — detection NEVER changes a node's outcome:
   * - at most `MAX_SKILL_INJECTIONS` bodies per run (`state.injectedSkills`);
   * - a name is delivered at most once per run (a repeat is skipped, and the
   *   scan continues so a later new name in the same reply still lands);
   * - only catalog skills visible to the acting role (`shared` or the role's
   *   own scope — the `renderSkillsSection` rule) are delivered; an unknown or
   *   out-of-scope name is silently ignored (no warning: a hallucinated or
   *   probing request is ordinary model noise, not a run degradation);
   * - never throws: the whole pass is wrapped, so a broken catalog entry or a
   *   throwing envelope consumer can not break the node.
   *
   * The envelope rides the normal append path (`this.append`), so it gets a
   * dense `seq`, persists to the session JSONL, fires `onEnvelope`, emits the
   * ordinary `envelope` stream event and renders inside "Context events:" —
   * no new stream or runtime event types.
   */
  private deliverSkillRequest(
    state: CooperationState,
    role: "senior" | "junior",
    reply: string,
  ): void {
    try {
      const catalog = this.options.skills;
      if (catalog === undefined || reply === "") return;
      if (state.injectedSkills.size >= MAX_SKILL_INJECTIONS) return;
      for (const match of reply.matchAll(SKILL_REQUEST_RE)) {
        const name = (match[1] ?? "").toLowerCase();
        if (name === "" || state.injectedSkills.has(name)) continue;
        const skill = catalog.skills.find((candidate) => candidate.name === name);
        if (skill === undefined) continue;
        if (skill.scope !== "shared" && skill.scope !== role) continue;
        this.append(state, "user", role, "message", {
          text: renderSkillLoaded(skill.name, skill.body),
        });
        state.injectedSkills.add(skill.name);
        return;
      }
    } catch {
      // skill delivery is advisory: a failure here never breaks a run
    }
  }

  /**
   * ONE repair attempt for a node: append the marked repair turn to the shared
   * context (a `message` envelope from "user", so every later render carries
   * it), then resend the conversation with the bad reply as an assistant turn
   * and the repair instruction as a user turn. The correction is a text
   * completion (`chat`) even for the tool-loop deliverable: the model is
   * reformatting a reply it already produced, so re-offering the belt would
   * only reopen the loop. Returns null when the repair call hit a context
   * overflow and no compaction could make room (tolerant fallback follows).
   */
  private async repairReply(
    state: CooperationState,
    role: "senior" | "junior",
    kind: string,
    messages: ChatMessage[],
    badReply: string,
    request: string,
    rebuild?: () => ChatMessage[],
  ): Promise<string | null> {
    this.emitStream({ type: "repair", role, kind, at: nowIso() });
    this.append(state, "user", role, "message", { text: request });
    const repaired: ChatMessage[] = [
      ...messages,
      { role: "assistant", content: badReply },
      { role: "user", content: request },
    ];
    // The repair re-ask streams too: token events are additive to `repair`
    // and to the repair envelope, and its thinking gets its own reasoning record.
    const capture = this.reasoningCapture(role, kind);
    try {
      this.auditPrompt(state, role, kind, repaired, []);
      try {
        return await this.providers[role].chat(repaired, kind, this.options.signal, capture.options);
      } catch (err) {
        if (!(err instanceof ProviderContextOverflowError)) throw err;
        if (!(await this.compactAfterOverflow(state))) return null;
        // the repair turn already rides in the shared context; rebuild from it
        const retry = rebuild === undefined ? repaired : rebuild();
        this.auditPrompt(state, role, kind, retry, []);
        return await this.providers[role].chat(retry, kind, this.options.signal, capture.options);
      }
    } finally {
      capture.finish();
    }
  }

  // -- context compaction ------------------------------------------------------

  /**
   * One compaction pass through the configured summarizer provider. Returns
   * whether the context changed and publishes the new summary envelope to the
   * run's event stream. Fail-soft by contract: a summarization failure records
   * a warning, disables further attempts this run, and leaves the context
   * un-compacted; only an operator stop (`ProviderAbortError`) propagates.
   */
  private async runCompaction(
    state: CooperationState,
    settings: CompactionSettings,
    trigger: "threshold" | "overflow" = "threshold",
    notice?: { unit: CompactionUnit; measured?: number; limit?: number },
  ): Promise<boolean> {
    const role = settings.summarizerRole ?? "senior";
    try {
      const changed = await compactContext(state.ctx, this.providers[role], settings, this.options.signal);
      if (changed) {
        const summary = state.ctx.events.find(isCompactionSummary);
        if (summary !== undefined) {
          this.publishEnvelope(state, summary);
        }
      }
      return changed;
    } catch (err) {
      if (err instanceof ProviderAbortError) throw err; // a stop must unwind, not retry
      this.compactionFailed = true;
      const outcome =
        trigger === "overflow"
          ? "surfacing the provider's context-overflow error"
          : "continuing with the full context";
      // Name the unit the trigger measured in, so a --verbose transcript says
      // whether the budget was chars or estimated tokens.
      const detail =
        notice === undefined
          ? ""
          : notice.measured !== undefined && notice.limit !== undefined
            ? ` (${notice.unit}: measured ${notice.measured} ${notice.unit}, trigger ${notice.limit} ${notice.unit})`
            : ` (${notice.unit})`;
      const message =
        `context compaction failed (${err instanceof Error ? err.message : String(err)}); ${outcome}${detail}`;
      this.compactionWarnings.push(message);
      settings.onWarning?.(message);
      return false;
    }
  }

  /**
   * The compaction settings in force: the caller's options plus the run-level
   * context window (`--context-window` / `TWO_BROTHERS_CONTEXT_WINDOW`) when
   * the options do not set one. A run-level window alone is enough to enable
   * token-mode accounting — the token auto trigger and token-sized overflow
   * recovery.
   */
  private compactionSettings(): CompactionSettings | undefined {
    const configured = this.options.compaction;
    const configuredWindow = configured?.contextWindow ?? 0;
    const window = configuredWindow > 0 ? configuredWindow : (this.cfg.contextWindow ?? 0);
    if (configured === undefined) return window > 0 ? { contextWindow: window } : undefined;
    if (configuredWindow > 0 || window <= 0) return configured;
    return { ...configured, contextWindow: window };
  }

  /**
   * Auto-compact when the rendered context reaches the active trigger —
   * `thresholdChars - reserveChars` chars in char mode,
   * `contextWindow - reserveTokens` (or `thresholdTokens - reserveTokens`)
   * estimated tokens in token mode — or once when `--compact` asked for it.
   * Runs between state-machine nodes, so the context the next model call sees
   * is already compacted. Fail-soft: a summarization failure records a
   * warning, disables further attempts this run, and leaves the context
   * un-compacted; only an operator stop (`ProviderAbortError`) propagates.
   */
  private async maybeCompact(state: CooperationState): Promise<void> {
    const settings = this.compactionSettings();
    if (settings === undefined || this.compactionFailed) return;
    const tokenTrigger = compactionTriggerTokens(settings);
    const charTrigger = compactionTriggerChars(settings);
    let notice: { unit: CompactionUnit; measured?: number; limit?: number } | undefined;
    if (tokenTrigger > 0) {
      const measured = estimateTokens(state.ctx.renderTranscript());
      notice = { unit: "tokens", measured, limit: tokenTrigger };
      if (!state.compactNow && measured < tokenTrigger) return;
    } else if (charTrigger > 0) {
      const measured = state.ctx.renderTranscript().length;
      notice = { unit: "chars", measured, limit: charTrigger };
      if (!state.compactNow && measured < charTrigger) return;
    } else {
      notice = { unit: compactionUnit(settings) };
      if (!state.compactNow) return;
    }
    state.compactNow = false;
    await this.runCompaction(state, settings, "threshold", notice);
  }

  /**
   * Recovery after a provider context overflow: compact with the configured
   * settings (default settings when auto compaction was not configured, so
   * overflow recovery still works), once per call site. A known context
   * window sizes the recovery budgets in tokens (`window - reserveTokens`);
   * without one the char defaults apply unchanged. Returns false when nothing
   * could be compacted, in which case the caller re-raises the provider's
   * overflow. A failed summarizer is fail-soft here too.
   */
  private async compactAfterOverflow(state: CooperationState): Promise<boolean> {
    if (this.compactionFailed) return false;
    const settings = this.compactionSettings() ?? {};
    return this.runCompaction(state, settings, "overflow", { unit: compactionUnit(settings) });
  }

  // -- tool helpers ------------------------------------------------------------

  /** True when this harness is configured with spill storage. */
  private spillReadOffered(): boolean {
    return this.spillStore !== null;
  }

  /**
   * Whether a belt carries a tool that can do real work (not the display-only
   * plan tool or the output-retrieval helper). Consult nodes use this to keep
   * their exact pre-tools request path when spill_read/todo_write are the only
   * entries; a real tool still opens the bounded loop.
   */
  private hasTaskTools(tools: readonly Tool[]): boolean {
    return tools.some(
      (tool) => tool.name !== TODO_TOOL_NAME && tool.name !== SPILL_READ_TOOL_NAME,
    );
  }

  /**
   * The built-in retrieval tool. It reads only the configured spill store:
   * the model supplies an id (validated against random hex by `SpillStore`),
   * never a path. Invalid/missing ids come back as a normal tool-error string,
   * never an exception into the loop.
   */
  private spillReadTool(): Tool {
    return {
      name: SPILL_READ_TOOL_NAME,
      description: SPILL_READ_TOOL_DESCRIPTION,
      parameters: SPILL_READ_TOOL_PARAMETERS,
      execute: async (args) => {
        const store = this.spillStore;
        if (store === null) return "spill_read error: spill storage is not configured";
        const id = typeof args.id === "string" ? args.id : String(args.id ?? "");
        const offset = Number(args.offset ?? 0);
        const rawMax = args.max_chars ?? args.maxChars;
        const maxChars = rawMax === undefined ? undefined : Number(rawMax);
        try {
          const chunk = await store.read(id, {
            offset: Number.isFinite(offset) ? offset : 0,
            ...(maxChars !== undefined && Number.isFinite(maxChars) ? { maxChars } : {}),
          });
          return formatSpillRead(
            chunk,
            spillReadBudget({ maxReadChars: this.options.spill?.maxReadChars }),
          );
        } catch (exc) {
          return `spill_read error: ${exc instanceof Error ? exc.message : String(exc)}`;
        }
      },
    };
  }

  /**
   * The junior's belt: the workspace's tool belt (when configured), plus the
   * `shared` and `junior` scopes of the role-scoped registry. The legacy
   * `options.tools` maps into the junior scope, so existing callers keep
   * their behavior (Python: the junior's `mcp_tools` + workspace tools). The
   * built-in plan tool joins last so existing tool order stays stable.
   */
  private toolSet(state: CooperationState): Tool[] {
    const scopes = this.options.toolScopes;
    return [
      ...(this.options.workspace?.asTools() ?? []),
      ...(scopes?.shared ?? []),
      ...(scopes?.junior ?? []),
      ...(this.options.tools ?? []),
      ...(this.spillReadOffered() ? [this.spillReadTool()] : []),
      this.todoWriteTool(state),
    ];
  }

  /**
   * The senior's belt (the read-only verify slice): the workspace built-ins
   * and the legacy `options.tools` filtered to `SENIOR_VERIFY_TOOL_NAMES`
   * (the pre-registry behavior, kept for back-compat), plus the `shared` and
   * `senior` scopes of the role-scoped registry and the legacy
   * `seniorTools` — all unfiltered, like Python's operator-installed senior
   * plugin tools — plus the built-in plan tool.
   */
  private verificationToolSet(state: CooperationState): Tool[] {
    const scopes = this.options.toolScopes;
    const verifyName = (tool: Tool): boolean => SENIOR_VERIFY_TOOL_NAMES.has(tool.name);
    return [
      ...(this.options.workspace?.asTools() ?? []).filter(verifyName),
      ...(scopes?.shared ?? []),
      ...(scopes?.senior ?? []),
      ...(this.options.tools ?? []).filter(verifyName),
      ...(this.options.seniorTools ?? []),
      ...(this.spillReadOffered() ? [this.spillReadTool()] : []),
      this.todoWriteTool(state),
    ];
  }

  /**
   * Whether a belt contains tools that justify running the senior verification
   * pass. The built-in plan tool is display state, not work to verify, so it
   * alone never enables the pass (tool-less work runs keep their old behavior)
   * while still joining the belt whenever the pass runs for real tools.
   */
  private hasVerifyTools(tools: readonly Tool[]): boolean {
    return this.hasTaskTools(tools);
  }

  /**
   * Whether a node may run a tool loop at all: a non-empty belt AND a provider
   * that implements `chatWithTools`. This is the single gate that keeps
   * tool-less configurations on the exact pre-tools request path.
   */
  private offersTools(role: "senior" | "junior", tools: readonly Tool[]): boolean {
    return tools.length > 0 && this.providers[role].chatWithTools !== undefined;
  }

  /**
   * The read-only belt a consult-mode node offers its role: the role's normal
   * belt minus the workspace mutations ({@link WORKSPACE_MUTATION_TOOL_NAMES})
   * and minus the display-only plan tool. The senior's source belt is its
   * verify slice, so `shared` / `senior` scoped tools and the legacy
   * `seniorTools` stay available; the junior's is its full belt, so the
   * `shared` / `junior` scopes and the legacy `tools` stay available while
   * every workspace mutation is filtered out.
   */
  private consultToolSet(state: CooperationState, role: "senior" | "junior"): Tool[] {
    const belt = role === "senior" ? this.verificationToolSet(state) : this.toolSet(state);
    return belt.filter(
      (tool) => tool.name !== TODO_TOOL_NAME && !WORKSPACE_MUTATION_TOOL_NAMES.has(tool.name),
    );
  }

  /**
   * The built-in plan tool (`todo_write`) both brothers receive: a whole-list
   * snapshot with no approval and no workspace access. Invalid arguments are
   * reported as a JSON error result (the tool never throws); a valid call
   * replaces the run's plan, emits exactly one additive `todo_updated` runtime
   * event for the UIs, and returns a compact text result.
   */
  private todoWriteTool(state: CooperationState): Tool {
    return {
      name: TODO_TOOL_NAME,
      description: TODO_TOOL_DESCRIPTION,
      parameters: TODO_TOOL_PARAMETERS,
      execute: (args) => {
        const raw = args.todos;
        if (!Array.isArray(raw)) {
          return JSON.stringify({
            tool: TODO_TOOL_NAME,
            status: "error",
            error: "todo_write: `todos` must be an array of {content, status} objects",
          });
        }
        const todos = sanitizeTodos(raw);
        if (raw.length > 0 && todos.length === 0) {
          return JSON.stringify({
            tool: TODO_TOOL_NAME,
            status: "error",
            error: "todo_write: no valid todo entries (each needs a non-empty content string)",
          });
        }
        state.todos = todos;
        this.emitRuntime({ type: "todo_updated", todos: todos.map((todo) => ({ ...todo })) });
        return todoResultText(todos);
      },
    };
  }

  /**
   * Bound one model-facing tool result through the optional spill store.
   * Small results pass through untouched. Over-budget plain text is saved in
   * full and replaced by a bounded preview + marker. Storage failure is
   * fail-soft: the existing clipping marker is used instead, and one warning
   * is recorded for `result.warnings`. `spill_read` output is never re-spilled
   * (it is already bounded), and an existing marker is not double-wrapped.
   */
  private async spillToolResult(
    state: CooperationState,
    toolName: string,
    callId: string | undefined,
    result: string,
  ): Promise<string> {
    const store = this.spillStore;
    const settings = this.options.spill;
    if (store === null || settings === undefined) return result;
    if (toolName === SPILL_READ_TOOL_NAME || isSpilledText(result)) return result;
    if (result.length <= spillInlineBudget(settings)) return result;
    try {
      const preview = await spillPreview(
        result,
        store,
        {
          session: this.sessionId(state.ctx),
          tool: toolName,
          ...(callId !== undefined ? { callId } : {}),
          label: "result",
        },
        {
          ...(settings.maxInlineChars !== undefined
            ? { maxInlineChars: settings.maxInlineChars }
            : {}),
          ...(settings.maxReadChars !== undefined ? { maxReadChars: settings.maxReadChars } : {}),
        },
      );
      return preview.text;
    } catch (exc) {
      const detail = exc instanceof Error ? exc.message : String(exc);
      this.spillWarnings.push(
        `tool output spill failed for ${toolName}: ${detail}; using the clipped output`,
      );
      return boundOutput(result, spillInlineBudget(settings)).text;
    }
  }

  /**
   * Run one tool call, emitting compact started/completed runtime events.
   *
   * Plugin hooks bracket the execution: `before_tool_call` runs first (it may
   * rewrite `args` in place — the rewritten arguments are what the tool and
   * the `tool_started` event carry — or deny the call, which emits a
   * `blocked` completion and returns the denial text as the tool result);
   * `after_tool_call` runs after the tool returned and may rewrite `result`
   * before it is compacted and reported. Both dispatches are fail-soft.
   *
   * Workspace mutations also carry the approval-deny repeat cap: once the
   * operator has denied the same `(action, target)` pair `APPROVAL_DENY_LIMIT`
   * times, the next identical call is auto-denied here, before the workspace
   * reaches its PermissionManager broker. The result reuses the workspace's
   * `status: "denied"` representation (plus `auto_denied: true` and an
   * explanatory error), so consumers need no new status.
   */
  private async invokeTool(
    state: CooperationState,
    tool: Tool,
    call: { id?: string; name: string; args: Record<string, unknown> },
    actor: string,
  ): Promise<string> {
    const role: HookRole = actor === "senior" ? "senior" : "junior";
    const args = { ...call.args };
    const callId = call.id;
    const argsText = JSON.stringify(clipArgs(args));
    // stream ordering: the attempt is reported before the hook can veto it,
    // mirroring `tool_started` on the runtime channel
    this.emitStream({
      type: "tool_call",
      role,
      tool: call.name,
      at: nowIso(),
      ...(callId !== undefined ? { callId } : {}),
      args: argsText,
    });
    const denial =
      this.options.hooks === undefined
        ? undefined
        : await this.beforeToolDenial(this.options.hooks, role, call.name, args);
    this.emitRuntime({ type: "tool_started", tool: call.name, args: clipArgs(args), actor });
    if (denial !== undefined) {
      this.emitRuntime({ type: "tool_completed", tool: call.name, status: "blocked", result: denial, actor });
      this.emitStream({ type: "tool_result", role, tool: call.name, status: "blocked", at: nowIso(), callId });
      return denial;
    }
    const pair = this.options.workspace === undefined ? null : approvalPair(call.name, args);
    if (pair !== null && (state.approvalDenials.get(pair.key) ?? 0) >= APPROVAL_DENY_LIMIT) {
      const denied: Record<string, unknown> = {
        tool: pair.record,
        status: "denied",
        auto_denied: true,
        error:
          `permission auto-denied: the operator already denied this ${pair.action} ` +
          `${APPROVAL_DENY_LIMIT} times; identical requests are no longer sent for approval`,
      };
      if (pair.action === "shell") denied.command = pair.command;
      else denied.path = pair.target;
      const text = JSON.stringify(denied);
      this.emitRuntime({
        type: "tool_completed",
        tool: call.name,
        status: "denied",
        result: compactToolResult(text),
        actor,
      });
      this.emitStream({
        type: "tool_result",
        role,
        tool: call.name,
        status: streamToolStatus("denied"),
        at: nowIso(),
        callId,
      });
      return text;
    }
    let result: string;
    let status = "ok";
    try {
      result = String(await tool.execute(args, this.options.signal));
    } catch (exc) {
      result = `tool error: ${exc instanceof Error ? exc.message : String(exc)}`;
      status = "error";
    }
    if (this.options.hooks !== undefined) {
      const event = { role, tool: call.name, args, result };
      await dispatchHook(this.options.hooks, "after_tool_call", event);
      result = event.result === undefined ? "" : String(event.result);
    }
    const compact = compactToolResult(result);
    if (compact !== null && typeof compact === "object" && !Array.isArray(compact)) {
      const record = compact as Record<string, unknown>;
      if (record.status) status = String(record.status);
    }
    if (pair !== null && status === "denied") {
      state.approvalDenials.set(pair.key, (state.approvalDenials.get(pair.key) ?? 0) + 1);
    }
    // The model-facing result is the bounded spill preview (or the original
    // text when small / spill disabled). The compact event copy stays small.
    const modelResult = await this.spillToolResult(state, call.name, callId, result);
    const compactModel = compactToolResult(modelResult);
    this.emitRuntime({
      type: "tool_completed",
      tool: call.name,
      status,
      result: compactModel,
      actor,
    });
    this.emitStream({
      type: "tool_result",
      role,
      tool: call.name,
      status: streamToolStatus(status),
      at: nowIso(),
      callId,
      result:
        typeof compactModel === "string" ? compactModel : JSON.stringify(compactModel),
    });
    return modelResult;
  }

  /**
   * The deny reason from a `before_tool_call` dispatch, if any. The event's
   * deny is already monotonic inside `dispatchHook`; this just reads it back.
   */
  private async beforeToolDenial(
    registry: HookRegistry,
    role: HookRole,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string | undefined> {
    const event = { role, tool: toolName, args };
    const outcome = await dispatchHook(registry, "before_tool_call", event);
    return outcome.deny;
  }

  /**
   * Bounded tool loop shared by the junior's deliverable, the senior's
   * verification and the consult-mode read-only nodes: model → tool calls →
   * tool results, at most `maxIterations` rounds. Evidence lines (clipped,
   * deduped) are collected for the payload. `rebuild` rebuilds the opening
   * system+transcript messages after an overflow compaction, so the retry does
   * not resend the oversized request. `auditKind` names the node in the prompt
   * audit trail; `wireKind` is the `responseKind` handed to the provider (the
   * work loops pass `"deliverable"`; the consult loops pass their own node
   * kind so mock/scripted providers can vary the reply shape).
   *
   * Returns the model's FINAL reply text (the response without tool calls),
   * the tool conversation built so far (the repair pass needs it), and the
   * evidence lines. Note the final reply used to be read off the last
   * conversation message — the last tool result, or the prompt itself — which
   * discarded the model's structured answer whenever a tool ran.
   */
  private async toolLoop(
    state: CooperationState,
    role: "senior" | "junior",
    auditKind: string,
    tools: Tool[],
    messages: ChatMessage[],
    maxIterations: number,
    rebuild: () => ChatMessage[],
    wireKind = "deliverable",
  ): Promise<{ evidence: string[]; text: string; messages: ChatMessage[] }> {
    const provider = this.providers[role];
    const chatWithTools = provider.chatWithTools?.bind(provider);
    if (!chatWithTools) {
      throw new Error(`provider for ${role} does not support tools`);
    }
    const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
    const evidence: string[] = [];
    // One advisory chain per tool loop: the next node (or a new user message
    // drained below) starts fresh, so repetition across nodes is never a loop.
    const repeatGuard =
      this.options.repeatToolGuard === false
        ? null
        : new RepeatToolGuard(this.options.repeatToolGuard ?? {});
    // The streaming seam as the plain path: each loop round is one provider
    // call, so it gets its own token sinks AND its own reasoning capture.
    const baseOptions = { responseKind: wireKind, signal: this.options.signal };
    let text = "";
    for (let i = 0; i < maxIterations; i++) {
      this.checkCancel();
      // Mid-run steering is also drained at every tool-loop iteration: a text
      // that arrived while this node works must reach the NEXT request of the
      // in-flight conversation. The opening system+user pair is RE-RENDERED
      // from the shared context (the drained steer now rides the transcript)
      // while the tool turns are preserved. Deliberately not a second user
      // turn: consecutive user roles are legal on the OpenAI wire but would be
      // a malformed request for Anthropic (alternating turns) and Google
      // (alternating contents), and the model reads the canonical rendered
      // transcript anyway — the same text every later node call sees.
      const steered = this.drainSteering(state);
      if (steered.length > 0) {
        repeatGuard?.reset();
        messages = [...rebuild(), ...messages.slice(2)];
      }
      let response: ToolChatResponse;
      const capture = this.reasoningCapture(role, auditKind);
      const callOptions =
        capture.options === undefined ? baseOptions : { ...baseOptions, ...capture.options };
      try {
        this.auditPrompt(state, role, auditKind, messages, tools);
        try {
          response = await chatWithTools(messages, tools, callOptions);
        } catch (err) {
          if (!(err instanceof ProviderContextOverflowError)) throw err;
          if (!(await this.compactAfterOverflow(state))) throw err;
          messages = rebuild();
          this.auditPrompt(state, role, auditKind, messages, tools);
          response = await chatWithTools(messages, tools, callOptions);
        }
      } finally {
        capture.finish();
      }
      if (response.toolCalls.length === 0) {
        text = response.content;
        break;
      }
      // Carry the adapter's signed extended-thinking blocks onto the assistant
      // turn so the NEXT tool-loop request can echo them verbatim (Anthropic
      // rejects a tool loop whose signed thinking was dropped). Only the
      // Anthropic adapter populates the field; every other adapter leaves it
      // undefined and its request bytes are unchanged. Internal only — never
      // rendered or persisted in the shared context/protocol.
      messages.push({
        role: "assistant",
        content: response.content,
        toolCalls: response.toolCalls,
        ...(response.thinkingBlocks !== undefined && response.thinkingBlocks.length > 0
          ? { thinkingBlocks: response.thinkingBlocks }
          : {}),
      });
      for (const call of response.toolCalls) {
        // Advisory guard: every ATTEMPT advances the chain, including an
        // unknown tool or a call the hook/approval path denies. The reminder
        // rides only the model-facing result below; runtime/stream records and
        // protocol envelopes keep the tool's own compact result.
        const observation = repeatGuard?.observe(call.name, call.args);
        const tool =
          toolMap.get(call.name) ??
          (call.name === SPILL_READ_TOOL_NAME && this.spillStore !== null
            ? this.spillReadTool()
            : undefined);
        let result: string;
        if (!tool) {
          result = `unknown tool: ${call.name}`;
          // a call the model invented is still an attempt: pair it on the stream
          this.emitStream({ type: "tool_call", role, tool: call.name, at: nowIso(), callId: call.id, args: JSON.stringify(clipArgs(call.args)) });
          this.emitRuntime({ type: "tool_completed", tool: call.name, status: "error", result, actor: role });
          this.emitStream({ type: "tool_result", role, tool: call.name, status: "error", at: nowIso(), callId: call.id, result });
        } else {
          result = await this.invokeTool(state, tool, call, role);
          const line = toolEvidenceLine(compactToolResult(result), call.name);
          if (!evidence.includes(line)) evidence.push(line);
        }
        const modelResult =
          observation?.reminder === undefined
            ? result
            : result === ""
              ? observation.reminder
              : `${result}\n\n${observation.reminder}`;
        messages.push({ role: "tool", content: modelResult, toolCallId: call.id });
      }
    }
    return { evidence, text, messages };
  }

  // -- consult-mode read-only tool nodes --------------------------------------

  /**
   * Answer one structured consult-mode node. With a non-empty read-only belt
   * and a tool-capable provider the model may call tools before emitting the
   * structured reply; otherwise this is exactly the pre-tools plain `ask`
   * path — no belt on the wire, no extra provider calls and the same
   * `## Available tools` ("You have no tools…") prompt section, so a
   * tool-less configuration sends byte-identical requests.
   */
  private async consultNode(
    state: CooperationState,
    role: "senior" | "junior",
    kind: string,
  ): Promise<Record<string, unknown>> {
    const tools = this.consultToolSet(state, role);
    // spill_read (and the display-only plan tool) alone do not justify a tool
    // loop: a tool-less consult run keeps its exact plain request path.
    if (!this.hasTaskTools(tools) || !this.offersTools(role, tools)) {
      return this.ask(state, role, kind);
    }
    return (await this.consultWithTools(state, role, kind, tools)).payload;
  }

  /**
   * The consult-mode tool loop: the shared bounded `toolLoop` over the role's
   * read-only belt, then that node's structured reply. The structured reply
   * keeps the ordinary ONE repair re-ask — the repair request resends the tool
   * conversation with the bad reply as an assistant turn, so a prose answer
   * after a tool round repairs exactly like the work-mode deliverable does.
   * Tool activity rides the existing runtime/stream events; no protocol
   * envelope, event type or prompt-file byte changes.
   */
  private async consultWithTools(
    state: CooperationState,
    role: "senior" | "junior",
    kind: string,
    tools: Tool[],
  ): Promise<{ payload: Record<string, unknown>; evidence: string[] }> {
    const build = (): ChatMessage[] =>
      state.ctx.renderForRole(role, this.systemPrompt(role, tools, kind));
    const { evidence, text, messages } = await this.toolLoop(
      state,
      role,
      kind,
      tools,
      build(),
      MAX_CONSULT_TOOL_ITERATIONS,
      build,
      kind,
    );
    const reply = await this.structuredReply(
      state,
      role,
      kind,
      messages,
      String(text),
      this.lastErrors,
    );
    return {
      payload: sanitizePayload(kind, reply.payload, reply.text, taskOf(state.ctx)),
      evidence,
    };
  }

  // -- nodes -----------------------------------------------------------------

  private async seniorOpen(state: CooperationState): Promise<NodeResult> {
    const kind = state.mode === "work" ? "delegation" : "consult";
    // Consult mode grounds the opening question with the senior's read-only
    // belt; the work-mode delegation stays a plain call (the junior's tool
    // loop does the work there, and mutating work-mode behavior is unchanged).
    const payload =
      kind === "delegation"
        ? await this.ask(state, "senior", kind)
        : await this.consultNode(state, "senior", kind);
    this.append(state, "senior", "junior", kind, payload);
    return "junior_answer";
  }

  private async juniorAnswer(state: CooperationState): Promise<NodeResult> {
    const last = state.ctx.events[state.ctx.events.length - 1];
    const kind = last.kind === "delegation" ? "deliverable" : "proposal";
    let payload: Record<string, unknown>;
    if (kind === "deliverable") {
      const tools = this.toolSet(state);
      if (tools.length > 0 && this.providers.junior.chatWithTools) {
        payload = await this.juniorWithTools(state, tools);
      } else {
        payload = await this.ask(state, "junior", kind);
      }
    } else {
      // consult-mode proposal: the junior's read-only belt grounds it
      payload = await this.consultNode(state, "junior", kind);
    }
    this.append(state, "junior", "senior", kind, payload);
    return this.routeAfterJunior(state);
  }

  /** Delegation executed with tools: a bounded tool-calling loop. */
  private async juniorWithTools(
    state: CooperationState,
    tools: Tool[],
  ): Promise<Record<string, unknown>> {
    const build = (): ChatMessage[] => [
      { role: "system", content: this.systemPrompt("junior", tools, "deliverable") },
      // the transcript render stays byte-stable; the delegation directive rides
      // after it in this request only (the VERIFY_INSTRUCTION pattern)
      { role: "user", content: state.ctx.renderTranscript() + DELEGATION_DIRECTIVE },
    ];
    const { evidence, text, messages } = await this.toolLoop(
      state,
      "junior",
      "deliverable",
      tools,
      build(),
      MAX_JUNIOR_TOOL_ITERATIONS,
      build,
    );
    const reply = await this.structuredReply(
      state,
      "junior",
      "deliverable",
      messages,
      String(text),
      state.errors,
    );
    const payload = sanitizePayload("deliverable", reply.payload, reply.text, taskOf(state.ctx));
    if (evidence.length > 0) {
      // clipped tool outcomes ride inside the deliverable so the senior
      // reviews actual evidence, not just the junior's claim
      payload.artifacts = [
        ...(asList(payload.artifacts)),
        ...evidence.slice(0, MAX_EVIDENCE_ENTRIES).map((line) => `tool: ${line}`),
      ];
    }
    return payload;
  }

  private routeAfterJunior(state: CooperationState): NodeResult {
    const last = state.ctx.events[state.ctx.events.length - 1];
    if (
      state.mode === "work" &&
      last.kind === "deliverable" &&
      this.hasVerifyTools(this.verificationToolSet(state)) &&
      this.providers.senior.chatWithTools !== undefined
    ) {
      return "senior_verify";
    }
    return "senior_review";
  }

  private async seniorVerify(state: CooperationState): Promise<NodeResult> {
    const tools = this.verificationToolSet(state);
    const build = (): ChatMessage[] => [
      { role: "system", content: this.systemPrompt("senior", tools) },
      { role: "user", content: state.ctx.renderTranscript() + VERIFY_INSTRUCTION },
    ];
    const { evidence, text } = await this.toolLoop(
      state,
      "senior",
      "verify",
      tools,
      build(),
      MAX_SENIOR_VERIFY_ITERATIONS,
      build,
    );
    state.verifyEvidence = evidence;
    state.verifySummary = text ? clipText(text, CLIP_EVIDENCE_CHARS) : "";
    return "senior_review";
  }

  private async seniorReview(state: CooperationState): Promise<NodeResult> {
    const evidence = state.verifyEvidence;
    const summary = state.verifySummary;
    let payload: Record<string, unknown>;
    // Consult-mode review grounds itself with the senior's read-only belt;
    // work mode keeps its post-deliverable verify-evidence path unchanged.
    let consultedEvidence: string[] = [];
    if (evidence.length > 0) {
      // the senior reviews with its own verification results in view; the
      // block augments only this request, not the shared transcript
      const block = ["", "Senior verification evidence (own workspace checks):"];
      block.push(...evidence.slice(0, MAX_EVIDENCE_ENTRIES).map((line) => `- ${line}`));
      if (summary) block.push(`Summary: ${summary}`);
      const build = (): ChatMessage[] => {
        const messages = state.ctx.renderForRole("senior", this.systemPrompt("senior", [], "review"));
        messages[messages.length - 1]!.content += block.join("\n");
        return messages;
      };
      payload = await this.askWithMessages(state, "senior", "review", build(), build);
    } else if (state.mode !== "work") {
      const tools = this.consultToolSet(state, "senior");
      if (this.hasTaskTools(tools) && this.offersTools("senior", tools)) {
        const grounded = await this.consultWithTools(state, "senior", "review", tools);
        payload = grounded.payload;
        consultedEvidence = grounded.evidence;
      } else {
        payload = await this.ask(state, "senior", "review");
      }
    } else {
      payload = await this.ask(state, "senior", "review");
    }
    const toolEvidence = evidence.length > 0 ? evidence : consultedEvidence;
    if (toolEvidence.length > 0) {
      // clipped tool lines ground the verdict in actual results
      payload.points = [
        ...(asList(payload.points)),
        ...toolEvidence.slice(0, MAX_EVIDENCE_ENTRIES).map((line) => `verify: ${line}`),
      ];
      const grounding =
        evidence.length > 0
          ? "Review grounded in senior verification of the workspace."
          : "Review grounded in the senior's own read-only tool checks.";
      payload.notes = `${String(payload.notes ?? "")} ${grounding}`.trim();
    }
    const verdict = String(payload.verdict ?? "accept");
    this.append(state, "senior", "junior", "review", payload);
    state.lastVerdict = verdict;
    state.verifyEvidence = [];
    state.verifySummary = "";
    return this.routeReview(state);
  }

  private async juniorRevise(state: CooperationState): Promise<NodeResult> {
    // A revision is the junior's proposal node: consult mode grounds it with
    // the read-only belt, work mode keeps the plain pre-tools call.
    const payload =
      state.mode === "work"
        ? await this.ask(state, "junior", "proposal")
        : await this.consultNode(state, "junior", "proposal");
    this.append(state, "junior", "senior", "proposal", payload);
    state.rounds += 1;
    return "senior_review";
  }

  private async seniorDecide(state: CooperationState): Promise<NodeResult> {
    // Deliberately lean: the review immediately before this node already ran
    // the read-only checks, and the arbiter's final statement reads the
    // transcript instead of re-running tools.
    const payload = await this.ask(state, "senior", "decision");
    this.append(state, "senior", "user", "decision", payload);
    state.decision = payload;
    return "END";
  }

  /**
   * A revise verdict at max_rounds ends the loop: rounds counts completed
   * revise iterations, so a route to "revise" happens only while
   * rounds < max_rounds; senior_decide sees the final verdict.
   */
  private routeReview(state: CooperationState): NodeResult {
    if (state.lastVerdict !== "accept" && state.rounds < state.maxRounds) {
      return "junior_revise";
    }
    return "senior_decide";
  }

  private readonly nodes: Record<NodeName, (state: CooperationState) => Promise<NodeResult>> = {
    senior_open: (state) => this.seniorOpen(state),
    junior_answer: (state) => this.juniorAnswer(state),
    senior_verify: (state) => this.seniorVerify(state),
    senior_review: (state) => this.seniorReview(state),
    junior_revise: (state) => this.juniorRevise(state),
    senior_decide: (state) => this.seniorDecide(state),
  };

  // -- public API --------------------------------------------------------------

  /** Opaque session identity for the lifecycle hooks (never a secret). */
  private sessionId(ctx: SharedContext): string {
    return ctx.store !== null ? ctx.store.path : "in-memory";
  }

  /**
   * Fire one session lifecycle hook, fail-soft. A throwing/rejecting handler
   * is recorded on its plugin's diagnostics inside `dispatchHook`; the run is
   * never affected.
   */
  private async sessionHook(
    name: "session_start" | "session_end",
    event: { session_id: string; workspace: string | null } | { session_id: string; status: string },
  ): Promise<void> {
    if (this.options.hooks === undefined) return;
    await dispatchHook(this.options.hooks, name, event as never);
  }

  /**
   * Run one cooperation cycle. `context` carries a resumed context; two
   * concurrent runs on the same session are serialized so envelope `seq`
   * stays dense (mirrors the RunManager's same-session rule in runtime.py).
   *
   * Plugin `session_start` / `session_end` hooks bracket the run;
   * `session_end` carries `completed`, `cancelled` (operator stop) or
   * `failed` (any other thrown error). The in-process stream
   * (`options.onStreamEvent`) mirrors the same lifecycle with `run_status`
   * and, on completion, one terminal `result` record.
   */
  async run(task: string, context?: SharedContext): Promise<HarnessResult> {
    this.checkCancel(); // stopped before the start: raise, write nothing
    this.compactionFailed = false;
    this.compactionWarnings = [];
    this.spillWarnings = [];
    this.steeringWarnings = [];
    this.steeringFailed = false;
    this.steeringCount = 0;
    const ctx = context ?? new SharedContext();
    const release = await acquireSession(ctx);
    const sessionId = this.sessionId(ctx);
    let status = "completed";
    const state: CooperationState = {
      task,
      mode: this.cfg.mode,
      maxRounds: this.options.maxRounds ?? this.cfg.maxRounds,
      ctx,
      runEvents: [],
      rounds: 0,
      lastVerdict: "accept",
      decision: {},
      errors: [],
      verifyEvidence: [],
      verifySummary: "",
      compactNow: this.options.compaction?.force === true,
      promptAudits: [],
      approvalDenials: new Map(),
      injectedSkills: new Set(),
      todos: [],
    };
    this.emitStream({ type: "run_status", status: "started", at: nowIso() });
    try {
      await this.sessionHook("session_start", {
        session_id: sessionId,
        workspace: this.options.workspace?.root ?? null,
      });
      if (
        !ctx.events.some(
          (e) =>
            e.from === "user" && e.kind === "message" && String(e.payload.text ?? "") === task,
        )
      ) {
        const msg = ctx.makeAndAppend("user", "senior", "message", { text: task });
        this.publishEnvelope(state, msg);
      }

      let node: NodeResult = "senior_open";
      while (node !== "END") {
        await this.maybeCompact(state);
        // Operator steering lands at the state-machine node boundary. Draining
        // AFTER maybeCompact keeps the just-drained text out of a summary this
        // boundary produces, so the next model call sees it verbatim; it is a
        // normal context envelope from here on. A stopped run drains nothing.
        this.drainSteering(state);
        node = await this.nodes[node](state);
      }

      const result: HarnessResult = {
        task,
        messages: state.runEvents,
        decision: state.decision,
        rounds: state.rounds,
        context: ctx,
        errors: [...state.errors, ...this.lastErrors],
        warnings: [
          ...this.compactionWarnings,
          ...this.steeringWarnings,
          ...this.spillWarnings,
          ...this.instructionWarnings,
        ],
        cancelled: false,
        usage: this.usageSnapshot(),
        promptAudits: state.promptAudits,
        ...(state.todos.length > 0
          ? { todos: state.todos.map((todo) => ({ ...todo })) }
          : {}),
      };
      this.emitStream({ type: "run_status", status: "completed", at: nowIso() });
      this.emitStream({ type: "result", result: this.streamSummary(result, ctx), at: nowIso() });
      return result;
    } catch (err) {
      if (err instanceof ProviderAbortError) {
        status = "cancelled";
        this.emitStream({ type: "run_status", status: "cancelled", at: nowIso() });
        // the store is the authoritative log; envelopes already appended
        // stay appended, and no further envelopes are produced
        return {
          task,
          messages: state.runEvents,
          decision: {},
          rounds: 0,
          context: ctx,
          errors: [...state.errors, "stopped by operator"],
          warnings: [
            ...this.compactionWarnings,
            ...this.steeringWarnings,
            ...this.spillWarnings,
            ...this.instructionWarnings,
          ],
          cancelled: true,
          usage: this.usageSnapshot(),
          promptAudits: state.promptAudits,
          ...(state.todos.length > 0
            ? { todos: state.todos.map((todo) => ({ ...todo })) }
            : {}),
        };
      }
      status = "failed";
      this.emitStream({ type: "run_status", status: "failed", at: nowIso() });
      throw err;
    } finally {
      await this.sessionHook("session_end", { session_id: sessionId, status });
      release();
    }
  }
}
