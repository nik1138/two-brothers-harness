/**
 * HTTP server + SSE for the web viewer. Ports the original prototype's HTTP
 * server (removed 2026-11-04; see git history; product-shell module 3) so the
 * Vue app in `web/` runs against this server unchanged.
 *
 * Framework: plain `node:http` (recorded in docs/history/ts-rewrite-plan.md).
 * Every route is a static prefix plus at most one path parameter, SSE is a raw
 * response stream, and JSON bodies are ~15 lines — less total code than
 * pulling in a web framework, and the runtime dependency list stays at zero
 * new deps.
 *
 * Contract notes (see the Python module docstring for the endpoint list):
 * - Error bodies are FastAPI-shaped: `{"detail": "..."}` with 400/404/405/
 *   409 statuses; invalid JSON bodies map to 400 "invalid request body"
 *   (the `RequestValidationError` handler).
 * - Background runs execute on the `RunManager` worker pool; the per-run
 *   `RunApprovalBroker` is reachable through the run record, so the approval
 *   endpoints resolve a mutation parked mid-run.
 * - `POST /api/runs/{run_id}/approvals/{approval_id}` accepts an additive
 *   `scope`: `"once"` (default) or `"session"` (strict string enum; anything
 *   else is a 400, and `scope: "session"` with `allow: false` is a 400 — a
 *   session deny does not exist). A session-scope allow persists FIRST in the
 *   `SettingsStore` `approvals` section (keyed by session file; a write failure
 *   is a 500 and nothing is allowed), then records the pair on the run's
 *   broker, so identical requests resolve ALLOW without parking the run
 *   (additive `approval_auto_allowed` runtime event instead of
 *   `approval_requested`). The response echoes the APPLIED `scope`; a client
 *   that omits it keeps the one-shot behavior. Runs seed their broker from the
 *   persisted list for their session (at submit and again at start, so queued
 *   runs see allows granted meanwhile); deleting a session clears its stored
 *   allows. Responses stay secret-free (pair keys are action + target only).
 * - `POST /api/runs` accepts an additive optional `stream_tokens` (strict
 *   boolean, default `false`; non-boolean is a 400). With it, provider
 *   thinking/text deltas are forwarded to the run's in-memory live-token
 *   listeners; `GET /api/runs/{run_id}/events` writes them as NAMED SSE frames
 *   — `event: token` + `data: {"type":"token","run_id","role","kind",
 *   "delta","at"}` (`at` in epoch seconds, like every typed event) — deliberately
 *   with NO `id:` line, so the `?after`
 *   typed-event replay cursor, the existing `id:`-tagged frames, heartbeats
 *   and the `run_end` close semantics are byte-unchanged. Tokens are
 *   ephemeral: never persisted to the runtime sidecar, never replayed, and
 *   only delivered to connections open while the run is producing them.
 * - `POST /api/runs/{run_id}/steer` (wave 23) accepts `{text}` for an ACTIVE
 *   run (status running, or waiting on an approval — the text is applied at
 *   the next node boundary / tool-loop iteration, after the approval
 *   resolves). The text is trimmed, must be non-empty and at most
 *   `STEER_TEXT_MAX_CHARS` (400 otherwise; a non-string `text` is the standard
 *   invalid-body 400). An unknown run is 404; a queued/terminal run or a full
 *   pending queue (8) is an honest 409. Accepted: 200
 *   `{run_id, status, pending}`. No event is emitted on acceptance: the text
 *   rides a normal user->senior `message` envelope when the harness appends it,
 *   so SSE consumers see it exactly once, in order, with its dense `seq`.
 * - A run record carries the requested `mode` (the config default when the
 *   request omits it), so a client can retry a failed run with its exact mode.
 * - Run records are in-memory; when a run id is unknown after a backend
 *   restart, `GET /api/runs/{id}` rebuilds a minimal record from the
 *   per-session runtime sidecar (terminal `run_end` + `run_error`). `task`
 *   and `mode` are not part of the event stream and come back as "".
 * - Settings/preset persistence goes through `RuntimeSettings`/`SettingsStore`
 *   (`public()` masking, env-pinned `TWO_BROTHERS_*` fields stripped before
 *   disk writes). Effective endpoint precedence per role: role env pair >
 *   shared env pair (both all-or-nothing) > named preset > role manual
 *   fields; per-role providers are built from the resolved endpoints (Stage
 *   18 — python per-role parity), with the shared config as the per-field
 *   fallback. A dangling `provider_ref` warns and falls back to the role's
 *   manual fields (tolerant boundary, never fails the run).
 * - Provider presets carry an additive `kind` (default "openai-compatible")
 *   and a manual `models` list; key material is never echoed back. The
 *   curated seed table (`presets.ts`) is always present, with stored presets
 *   of the same name layered on top; seed keys resolve through their
 *   `api_key_env` variable at use time and only `api_key_set` leaves the
 *   server. `GET /api/providers` additively reports, per row, `seed` (the name
 *   exists in the built-in seed table, case-insensitive) and `customized` (a
 *   stored preset with that name exists — a PUT-created seed override or a
 *   POST-created custom provider), so clients can tell an untouched seed from
 *   an edited one from a custom entry. `POST /api/providers/{name}/reset`
 *   removes a seed's stored override (including legacy case-variant
 *   duplicates), preserves role references, and returns the pristine public
 *   seed; unknown names are 404, custom providers are 400, and an untouched
 *   seed is 409. DELETE keeps its existing removal/ref-clearing behavior.
 * - `POST /api/providers/{name}/discover` probes the CURRENT DRAFT endpoint
 *   (additive `base_url`, `kind`, optional one-shot `api_key` body fields)
 *   through `provider.listModels` and returns the model ids it reports. It
 *   never persists or applies anything, never stores or echoes the typed key,
 *   and resolves the preset's stored/env-backed key server-side only when the
 *   probed base URL matches the preset's own endpoint (trimmed, trailing
 *   slashes ignored): probing a different endpoint with a saved secret and no
 *   typed key is a 400 ("a typed API key is required when probing a different
 *   base URL") instead of sending that secret elsewhere. Only OpenAI-compatible
 *   endpoints expose a `/models` listing: any other wire kind is an honest
 *   400, an unknown provider (seeds included) a 404, an upstream failure a
 *   502, and an empty list a valid 200 (a catalog is never erased by
 *   discovery). Discovery is explicitly separate from `PUT` (Apply); the
 *   offline CLI equivalent is `two-brothers models --base-url <url>`.
 * - `GET /api/plugins` lists the plugins discovered by the PluginManager
 *   (`src/plugins.ts`, the plugins.py port) plus load errors, and additively
 *   `diagnostics` (load-time notes plus the last run's binding notes) when
 *   non-empty. The shared enable/disable list rides `PUT /api/settings`
 *   under `plugins` (one list for both brothers — owner decision 2026-11-03;
 *   the legacy per-role object is still accepted and merged; entries may be
 *   `{path, options}` and are handed to `setSettings` before the reload).
 *   Plugin tools route by their declared scope (`shared` / `senior` /
 *   `junior`) into the run's `toolScopes`, and every run receives the
 *   plugin hook registry.
 * - `GET /api/skills` lists discovered skills (name, description, scope,
 *   tools, file) with discovery diagnostics — metadata only, never bodies.
 * - `GET /api/commands` lists discovered slash commands (name, description,
 *   argumentHint, optional mode, file) with the same kind of diagnostics —
 *   metadata only, never the template bodies. Additively it carries the
 *   first-party catalogue in `baseCommands` (`basecommands.ts`: name, aliases,
 *   description, argumentHint, kind, action?, requiresArguments, priority —
 *   always present, bodies never); a base `prompt` command expands exactly like
 *   a discovered one on run submission (a discovered same-name template wins),
 *   and a base `action` command submitted as a task is a 400 telling the
 *   operator to perform it from the surface.
 * - `POST /api/sessions/{name}/compact` manually summarises the older context
 *   of one session (`compaction.ts::compactContext`) through the same provider
 *   construction a run uses, rewriting the session JSONL in place (dense
 *   `seq`, unchanged shape) so a reload shows the summary. The session is
 *   RESERVED synchronously for the whole summarizer call (`state.compactions`,
 *   released in `finally`): a concurrent compaction is a 409 ("another
 *   compaction is already running for this session") and run admission
 *   (`POST /api/runs` / `POST /api/run`) for that session is a 409 ("a
 *   compaction is in progress for this session; retry in a moment") BEFORE any
 *   session/run is created, so the rewrite can never drop a concurrently
 *   admitted run's envelopes. Manual budgets come from
 *   `ServerOptions.compaction` when set, else the merged run-level
 *   configuration: the resolved config's non-zero compaction fields
 *   (`--compact-*` / `--context-window` through the config factory) per field,
 *   then the persisted `compaction` section of `settings/settings.json`. A
 *   client disconnect aborts the summarizer; a corrupt/unreadable
 *   JSONL is a stable 422 ("session file cannot be read; it may be corrupt",
 *   no path leaked). Statuses: 404 unknown session, 409 live run or reserved
 *   session, 200 `{compacted: true, before_events, after_events}` or — honestly,
 *   not an error — `{compacted: false, reason: "nothing to compact"}`, and 502
 *   when the summarizer/provider fails (nothing is written in that case).
 * - `POST /api/sessions/{name}/fork` (wave 23) copies a session prefix into a
 *   NEW session file (`src/sessionfork.ts`): body `{seq?: integer, name?:
 *   string}`, `seq` defaults to the whole session; the copied file is a
 *   byte-exact prefix (dense `seq` stays dense) plus a local `.meta.json`
 *   `parent: {name, seq}` lineage link and a `<source title> (fork)` title.
 *   201 `{name, title, events, forked_from: {name, seq}}`; 400 invalid
 *   seq/name, 404 unknown source, 409 target name taken or the session is
 *   busy (live run/manual compaction), 422 corrupt source, 500 unwritable
 *   sessions directory (a failed metadata write rolls the JSONL back). The
 *   source file is never modified.
 * - `POST /api/sessions/{name}/rewind` (wave 23) drops the last N operator
 *   turns (`src/sessionrewind.ts`): body `{turns}`, a strict integer 1..100.
 *   200 reports the honest cut — `{name, rewritten, kept, removed, turns,
 *   requested_turns, stopped_at_compaction, stops_before, reason}`; a cut that
 *   removes nothing is not an error (`rewritten: false`, file untouched, a
 *   `reason` explains why). 400 non-integer/out-of-range depth, 404 unknown
 *   session, 409 live run/manual compaction, 422 corrupt session, 500 a
 *   failed rewrite. The kept prefix keeps its dense `seq`, so resume works.
 * - `GET|POST|DELETE /api/sessions/{name}/undo/{run_id}` (wave 23) expose the
 *   run-scoped workspace edit undo store (`src/workspacehistory.ts`), which is
 *   a persisted side artifact under `<sessions>/undo` and therefore survives a
 *   backend restart. GET previews every recorded file against the LIVE
 *   workspace (`applicable` / `created` / `deleted` / `changed-since` /
 *   `skipped` / `missing` + counts + `workspace_root`); POST applies the
 *   reversible entries (re-classified immediately before each file) and returns
 *   `{applied, refused, failed, files, counts}`; DELETE discards the record.
 *   404 unknown session/record, 409 while a run for that id is still active in
 *   memory or the record itself is unusable (corrupt/oversized/unsupported
 *   version/its workspace is no longer registered), 422 unexpected store IO.
 *   A workspace-bound run captures its pre/post images and closes the capture
 *   in the run's `finally`; a capture failure is one diagnostic and never
 *   changes the run or its result.
 * - `GET /api/search?q=<query>&limit=<n>` full-text searches every session
 *   document (`src/sessionsearch.ts`, newest session first) and returns the
 *   bounded `SessionSearchResult` hit list. A trimmed query shorter than
 *   `SEARCH_MIN_QUERY_CHARS` is a 400 ("query must be at least 2 characters")
 *   and `limit` is clamped to 1..100 (default 20). Corrupt session files are
 *   skipped by `loadSessionDocs`, never fatal. `GET
 *   /api/sessions/{name}/export?format=markdown|json|html` renders one
 *   session as a downloadable attachment (`Content-Disposition`; markdown and
 *   json bodies are byte-identical to the pre-wave-23 exporter, `html` is ONE
 *   self-contained page from `sessionToHtmlString` with inlined CSS, escaped
 *   payloads and no scripts/links); an unknown format is a 400, a
 *   missing/`..`-unsafe name is a 404/400, and a HEAD request returns the same
 *   headers without a body.
 * - Each run merges the plugin-contributed MCP servers under the configured
 *   `mcpConfig` file (`mergeMcpConfig`: a configured entry wins a name
 *   collision, then the first plugin), connects them, folds the per-role
 *   tool buckets into the run's `toolScopes`, and closes the MCP client
 *   after `harness.run` settles. A missing configured file warns and keeps
 *   the plugin servers.
 * - Static serving: the built app is served at `/` with an SPA fallback,
 *   `/assets` mounted like FastAPI's StaticFiles. Lookup order (computed from
 *   this module, never cwd): the packaged `<package>/web` copy that
 *   `scripts/sync-web.mjs` places in the npm tarball, then the repo layout
 *   `<repo>/web/dist`. Overridable via `webDist`.
 * - `GET /api/workspaces` lists operator-registered workspaces in their
 *   operator-set order; `POST /api/workspaces` registers one (201),
 *   `PATCH /api/workspaces/{id}` renames one (200 with the updated object:
 *   a missing or blank name is a 400 "name must not be empty", a
 *   non-string name the generic 400 "invalid request body", an unknown id
 *   a 404, and a name over 120 characters is capped rather than rejected —
 *   the route echoes the stored, trimmed/capped name),
 *   and `PUT /api/workspaces/order` takes `{"ids": [...]}`, which must be
 *   an exact permutation of the registered ids, and returns
 *   `{"workspaces": [...]}` in the new order (400 naming the non-array,
 *   duplicate, unknown or missing ids; no partial reorder on error).
 *   `DELETE /api/workspaces/{id}` is unchanged.
 * - `GET /api/workspaces/{id}/files?q=<query>&limit=<n>` lists/ranks the files
 *   of one registered workspace for the composer `@` picker: a bounded,
 *   fail-soft index (`workspacefiles.ts`), `limit` clamped to 1..200 (default
 *   50), response `{workspace_id, files: [{path, size, mtime}], truncated,
 *   total}` where `truncated` reports a clipped walk or page and `total`
 *   counts matches before the page; an unknown id is a 404.
 * - `POST /api/runs` and the legacy `POST /api/run` prepare the operator
 *   submission (`mentions.ts`): a known leading `/name` expands its slash
 *   command template — a discovered template first, then a base `prompt`
 *   command — and may override the run mode for that run only; a base `action`
 *   command is a 400, and an unknown `/name` is submitted verbatim. `@skill:<name>`
 *   attaches a shared skill body (3 max; role-scoped skills are refused), and
 *   `@<path>` attaches a workspace file read read-only through
 *   `Workspace.read_file` (5 max, 20 000 chars each, 100 000 total;
 *   absolute/`..`/sensitive/missing/binary paths are 400s). Rendered
 *   `<skill-loaded>`/`<file>` blocks are appended to the shared context before
 *   the task, so they persist in the session JSONL; preparation errors are
 *   400s raised before any session or run exists.
 * - Local-request guards (SECURITY.md: local single-user, loopback only):
 *   while every binding is loopback, requests with a non-loopback `Host`
 *   (DNS-rebinding defense) and state-changing requests with a non-local
 *   browser `Origin` (cross-site write defense) are refused with 403.
 *   Binding a routable address (`--host 0.0.0.0` etc.) opts out with a
 *   startup warning — that deployment is outside the intended threat model.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  compactionFieldsForServe,
  compactionSettingsView,
  resolveConfig,
  RunConfigError,
  serveCompactionSettings,
  validateRunConfig,
  type Config,
} from "./config.ts";
import {
  baseCommandMetadata,
  baseCommandUsage,
  expandBaseCommand,
  findBaseCommand,
  type BaseCommand,
} from "./basecommands.ts";
import { compactContext, type CompactionSettings } from "./compaction.ts";
import { discoverCommands, expandCommand, matchCommand, type CommandCatalog } from "./commands.ts";
import { SharedContext } from "./context.ts";
import { estimateRunCostFromUsage } from "./cost.ts";
import { TwoBrothersHarness, type HarnessResult, type ToolScopes } from "./harness.ts";
import {
  loadMcpToolSpecs,
  loadMcpTools,
  mergeMcpConfig,
  type McpConfigFileShape,
  type McpToolSet,
} from "./mcp.ts";
import { deriveTitle, SessionMetadataStore } from "./metadata.ts";
import { SessionLayout } from "./sessionlayout.ts";
import {
  MENTION_MAX_FILES,
  MENTION_MAX_FILE_CHARS,
  MENTION_MAX_SKILLS,
  MENTION_MAX_TOTAL_CHARS,
  normalizeMentionPath,
  parseMentions,
  renderFileBlock,
  renderSkillLoadedBlock,
} from "./mentions.ts";
import {
  APPROVAL_MODES,
  normalizeApprovalMode,
  PermissionManager,
  PermissionPolicy,
  resolveApprovalMode,
  Decision,
  type ApprovalMode,
} from "./permissions.ts";
import {
  PluginManager,
  type HookRegistry,
  type PluginBindings,
  type PluginDiagnosticEntry,
} from "./plugins.ts";
import {
  isSeedPresetName,
  mergeSeedPresets,
  presetApiKey,
  presetById,
  type Preset,
} from "./presets.ts";
import {
  emptyUsage,
  isProviderKind,
  listModels,
  PROVIDER_KIND_HINT,
  roleProviderKind,
  type Provider,
  type RemoteModel,
  type UsageTotals,
} from "./provider.ts";
import { restoreContext, SessionError, SessionStore } from "./session.ts";
import { forkSession, SessionForkError } from "./sessionfork.ts";
import {
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SEARCH_MIN_QUERY_CHARS,
  exportSessionFileName,
  loadSessionDocs,
  searchSessions,
  sessionToHtmlString,
  sessionToJsonString,
  sessionToMarkdown,
  type SessionSearchDoc,
} from "./sessionsearch.ts";
import { computeRewindCut, rewindSession, validateRewindTurns } from "./sessionrewind.ts";
import {
  PROVIDER_KIND_DEFAULT,
  SettingsSchemaVersionError,
  SettingsStore,
  strictCompactionSettings,
  type PersistedCompactionSettings,
  type PluginSelection,
  type ProviderPreset,
} from "./settings_store.ts";
import { discoverSkills, type SkillCatalog } from "./skills.ts";
import { SpillStore } from "./spill.ts";
import { RunApprovalBroker, RuntimeEventStore } from "./runevents.ts";
import {
  ACTIVE_STATES,
  STEERABLE_STATES,
  STEER_TEXT_MAX_CHARS,
  TERMINAL_STATES,
  presetContextWindow,
  resolveRoleEndpoints,
  RunManager,
  RuntimeSettings,
  type LiveTokenHook,
  type PublicRuntimeSettings,
  type RoleEndpoints,
  type RunCost,
  type RunJob,
  type RunRecord,
} from "./runtime.ts";
import { repeatToolGuardFromEnv } from "./repeatguard.ts";
import { projectInstructionsFromEnv } from "./instructions.ts";
import type { StreamEvent, TokenStreamEvent } from "./runstream.ts";
import {
  Workspace,
  WorkspaceError,
  WorkspaceRegistry,
  type RegisteredWorkspace,
} from "./workspace.ts";
import {
  applyUndo,
  beginUndoCapture,
  collectOrphanBlobs,
  discardUndo,
  loadUndoRecord,
  previewUndo,
  WorkspaceUndoError,
  type WorkspaceUndoCapture,
  type WorkspaceUndoRecord,
  type WorkspaceUndoStatus,
} from "./workspacehistory.ts";
import {
  indexWorkspaceFiles,
  searchWorkspaceFiles,
  type WorkspaceFileEntry,
} from "./workspacefiles.ts";

const MODES = new Set(["consult", "work", "auto"]);
const PROVIDERS = new Set(["openai", "mock"]);
const ROLES = ["senior", "junior"] as const;
const FS_BROWSE_LIMIT = 500;
/** `GET /api/workspaces/{id}/files` page size: default and hard ceiling. */
const FILE_SEARCH_DEFAULT_LIMIT = 50;
const FILE_SEARCH_MAX_LIMIT = 200;
const BODY_LIMIT_BYTES = 1_000_000;
const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "X-Accel-Buffering": "no",
} as const;

/** FastAPI-style HTTP error: `{"detail": ...}` with a status code. */
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(detail);
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorDetail(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/**
 * Estimate one run's USD cost from its merged usage, or `null` when the run
 * cannot be attributed honestly. The same-model/same-family policy lives in
 * `cost.ts::estimateRunCostFromUsage`, shared with the CLI and TUI so the three
 * surfaces can never disagree about a cached run; the returned `model` is the
 * price-table row the id resolved to (e.g. `gpt-4o-2024-08-06` → `gpt-4o`).
 */
function estimateRecordCost(
  cfg: Config,
  endpoints: RoleEndpoints | undefined,
  usage: UsageTotals | undefined,
): RunCost | null {
  if (usage === undefined) return null;
  const estimate = estimateRunCostFromUsage({
    seniorModel: endpoints?.senior.model || cfg.seniorModel || "",
    juniorModel: endpoints?.junior.model || cfg.juniorModel || "",
    seniorFamily: roleProviderKind(cfg, endpoints?.senior, "senior"),
    juniorFamily: roleProviderKind(cfg, endpoints?.junior, "junior"),
    usage,
  });
  if (estimate === null) return null;
  return { currency: "USD", total: estimate.totalCost, model: estimate.model };
}

/**
 * One NAMED SSE frame for a live thinking/text token
 * (`GET /api/runs/{run_id}/events`). Deliberately has no `id:` line: named
 * token frames are ephemeral side-channel data, so the EventSource
 * last-event-id / `?after` replay cursor keeps counting only the persisted
 * typed runtime events. `kind` is always present (`"text"` for anything the
 * producer did not explicitly tag as reasoning).
 */
function tokenSseFrame(runId: string, event: TokenStreamEvent): string {
  // Every typed runtime event on this stream carries epoch seconds, so the
  // named token frame does too (the harness token event's `at` is ISO-8601;
  // convert, falling back to the write time if it were ever malformed).
  const parsedAt = Date.parse(event.at);
  const at = Number.isFinite(parsedAt)
    ? Math.floor(parsedAt / 1000)
    : Math.floor(Date.now() / 1000);
  const payload = {
    type: "token",
    run_id: runId,
    role: event.role,
    kind: event.kind === "thinking" ? "thinking" : "text",
    delta: event.delta,
    at,
  };
  return `event: token\ndata: ${JSON.stringify(payload)}\n\n`;
}

// ---------------------------------------------------------------------------
// Local-request guards (see SECURITY.md: local single-user, loopback only)
// ---------------------------------------------------------------------------

/**
 * A bind address or Host/Origin hostname is "local" when it is loopback:
 * `localhost`, any `*.localhost` name (RFC 6761), `::1`, or an IPv4 address
 * in 127.0.0.0/8. Everything else (machine IPs, `0.0.0.0`, public names) is
 * not.
 */
function isLocalHostName(host: string): boolean {
  const name = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  if (name === "::1" || name === "::ffff:127.0.0.1") return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
  if (ipv4) return Number(ipv4[1]) === 127;
  return false;
}

/** The hostname part of a `Host` header (port stripped, brackets handled). */
function hostHeaderName(hostHeader: string): string {
  const trimmed = hostHeader.trim();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end === -1 ? trimmed : trimmed.slice(1, end);
  }
  const idx = trimmed.lastIndexOf(":");
  if (idx !== -1 && /^\d+$/.test(trimmed.slice(idx + 1))) return trimmed.slice(0, idx);
  return trimmed;
}

// ---------------------------------------------------------------------------
// Request models (pydantic parity: wrong types -> 400 "invalid request body")
// ---------------------------------------------------------------------------

interface RunRequestData {
  task: string;
  mode?: string;
  session?: string;
  provider?: string;
  workspace_id?: string;
  /**
   * Additive `POST /api/runs` option: stream provider thinking/text deltas as
   * ephemeral namespaced SSE frames (`event: token`). Strictly boolean when
   * present; default false (no token frames, wire behavior unchanged).
   */
  stream_tokens?: boolean;
}

function invalidBody(): HttpError {
  return new HttpError(400, "invalid request body");
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw invalidBody();
  return value;
}

function parseRunRequest(body: unknown): RunRequestData {
  if (!isRecord(body) || typeof body.task !== "string") throw invalidBody();
  const req: RunRequestData = { task: body.task };
  req.mode = optionalString(body, "mode");
  req.session = optionalString(body, "session");
  req.provider = optionalString(body, "provider");
  req.workspace_id = optionalString(body, "workspace_id");
  return req;
}

function parseRunRequestStrict(body: unknown): RunRequestData {
  const req = parseRunRequest(body);
  const task = req.task.trim();
  if (!task) throw new HttpError(400, "task must not be empty");
  req.task = task;
  if (req.mode !== undefined && !MODES.has(req.mode)) {
    throw new HttpError(400, "invalid mode");
  }
  if (req.provider !== undefined && !PROVIDERS.has(req.provider)) {
    throw new HttpError(400, "invalid provider");
  }
  // `stream_tokens` is an additive background-run option (the sync /api/run
  // route has no SSE and ignores it). Absent = default false; anything other
  // than a boolean (null included) is the generic 400.
  const raw = body as Record<string, unknown>;
  if (raw.stream_tokens !== undefined) {
    if (typeof raw.stream_tokens !== "boolean") throw invalidBody();
    req.stream_tokens = raw.stream_tokens;
  }
  return req;
}

/**
 * Tolerant at the boundary: keep unique, non-empty entries, drop the rest.
 * Entries are plugin names/paths or `{path, options}` objects (per-plugin
 * settings); a malformed object is dropped rather than failing the save.
 */
function uniquePluginNames(items: unknown[]): PluginSelection {
  const out: PluginSelection = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item === "string") {
      const name = item.trim();
      if (name && !seen.has(name)) {
        seen.add(name);
        out.push(name);
      }
      continue;
    }
    if (!isRecord(item)) continue;
    const entryPath = typeof item.path === "string" ? item.path.trim() : "";
    if (!entryPath || seen.has(entryPath)) continue;
    seen.add(entryPath);
    out.push(
      isRecord(item.options) ? { path: entryPath, options: { ...item.options } } : { path: entryPath },
    );
  }
  return out;
}

/**
 * The `PUT /api/settings` plugin selection. The current shape is one shared
 * list (bare names or `{path, options}` entries); the legacy per-role object
 * (`{senior: [...], junior: [...]}`) is still accepted and merged into that
 * list (dedup, order preserved) so an older operator script or cached web
 * client keeps working.
 */
function cleanPluginSelection(value: unknown): PluginSelection {
  if (Array.isArray(value)) return uniquePluginNames(value);
  if (isRecord(value)) {
    const merged: unknown[] = [];
    for (const role of ROLES) {
      if (!(role in value)) continue;
      const list = value[role];
      if (!Array.isArray(list)) {
        throw new HttpError(400, "plugins.<role> must be a list of plugin names");
      }
      merged.push(...list);
    }
    return uniquePluginNames(merged);
  }
  throw new HttpError(400, "plugins must be a list of plugin names");
}

/** Dedupe key of a selection entry (the plugin name or path). */
function pluginEntryName(entry: string | { path: string }): string {
  return typeof entry === "string" ? entry : entry.path;
}

/** Merge names into `target` in order, dropping duplicates. */
function addPluginNames(target: PluginSelection, names: string[]): void {
  const seen = new Set(target.map(pluginEntryName));
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    target.push(name);
  }
}

// ---------------------------------------------------------------------------
// Session naming + env helpers (python server.py parity)
// ---------------------------------------------------------------------------

/**
 * Filesystem-safe, collision-free session name. Second-precision stamps
 * alone silently overwrite a session created within the same second, so the
 * readable `YYYY-MM-DDTHH-MM-SS` prefix carries a millisecond part and a
 * random suffix. Ports `server._new_session_name`.
 */
export function newSessionName(now: Date = new Date()): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T` +
    `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const millis = pad(now.getMilliseconds(), 3);
  const suffix = randomBytes(3).toString("hex");
  return `${stamp}-${millis}-${suffix}.jsonl`;
}

/**
 * Deprecated env aliases for the shared plugin selection (comma-separated).
 * `TWO_BROTHERS_PLUGINS_SENIOR` / `_JUNIOR` are kept so existing operator
 * scripts keep working; they now merge into the one shared list instead of
 * scoping a role. They are an overlay only — never persisted.
 */
function envPluginNames(): string[] {
  const out: string[] = [];
  for (const envName of [
    "TWO_BROTHERS_PLUGINS_SENIOR",
    "TWO_BROTHERS_PLUGINS_JUNIOR",
  ]) {
    const raw = process.env[envName];
    if (!raw) continue;
    for (const part of raw.split(",")) {
      const name = part.trim();
      if (name && !out.includes(name)) out.push(name);
    }
  }
  return out;
}

/**
 * Overlay `TWO_BROTHERS_*` env vars on persisted settings (env wins). With
 * `persist` false (a future-version settings.json) the overlay stays
 * in-memory: reads/runs keep working and only writes are refused.
 */
function applyEnvOverrides(settings: RuntimeSettings, persist = true): void {
  const patch: Record<string, Record<string, string>> = {};
  const provider = process.env.TWO_BROTHERS_PROVIDER;
  if (provider === "openai" || provider === "mock") {
    for (const role of ROLES) (patch[role] ??= {}).provider = provider;
  }
  for (const [envName, field] of [
    ["TWO_BROTHERS_BASE_URL", "base_url"],
    ["TWO_BROTHERS_API_KEY", "api_key"],
  ] as const) {
    const raw = process.env[envName];
    if (raw) for (const role of ROLES) (patch[role] ??= {})[field] = raw;
  }
  // Stage 18 per-role env pairs (the new CLI flags' env equivalents).
  for (const role of ROLES) {
    const prefix = role === "senior" ? "TWO_BROTHERS_SENIOR" : "TWO_BROTHERS_JUNIOR";
    for (const [envName, field] of [
      [`${prefix}_BASE_URL`, "base_url"],
      [`${prefix}_API_KEY`, "api_key"],
    ] as const) {
      const raw = process.env[envName];
      if (raw) (patch[role] ??= {})[field] = raw;
    }
  }
  const seniorModel = process.env.TWO_BROTHERS_SENIOR_MODEL;
  if (seniorModel) (patch.senior ??= {}).model = seniorModel;
  const juniorModel = process.env.TWO_BROTHERS_JUNIOR_MODEL;
  if (juniorModel) (patch.junior ??= {}).model = juniorModel;
  if (Object.keys(patch).length === 0) return;
  if (persist) settings.update(patch);
  else settings.applyInMemory(patch);
}

/** Public preset view — key material is never echoed back. */
function publicProvider(preset: {
  name: string;
  base_url: string;
  api_key: string;
  kind: string;
  models: string[];
  context_window?: number;
}): {
  name: string;
  base_url: string;
  api_key_set: boolean;
  kind: string;
  models: string[];
  context_window?: number;
} {
  return {
    name: preset.name,
    base_url: preset.base_url,
    api_key_set: Boolean(preset.api_key),
    kind: preset.kind || PROVIDER_KIND_DEFAULT,
    models: [...preset.models],
    // Additive: omitted when unknown (0/absent), so presets that never set a
    // window stay byte-compatible with the pre-wave-26 response.
    ...(typeof preset.context_window === "number" &&
    Number.isSafeInteger(preset.context_window) &&
    preset.context_window > 0
      ? { context_window: preset.context_window }
      : {}),
  };
}

/**
 * Public view of a merged preset. `presetApiKey` resolves a seed's
 * `api_key_env` at use time, so `api_key_set` reflects an env-backed key
 * without the value ever leaving the server.
 */
function publicPreset(preset: Preset): ReturnType<typeof publicProvider> {
  return publicProvider({
    name: preset.name,
    base_url: preset.base_url,
    api_key: presetApiKey(preset),
    kind: preset.kind,
    models: preset.models,
    context_window: preset.context_window,
  });
}

/**
 * Default skill roots, shared by run assembly and `GET /api/skills`:
 * `TWO_BROTHERS_SKILLS_DIR` (one or more roots separated by the OS path-list
 * separator — `;` on Windows, `:` elsewhere), then `<cwd>/skills`, then
 * `~/.two-brothers/skills`. A missing root is not an error (`discoverSkills`
 * reports only real problems).
 */
function defaultSkillsRoots(): string[] {
  const roots: string[] = [];
  const raw = process.env.TWO_BROTHERS_SKILLS_DIR;
  if (raw) {
    for (const part of raw.split(path.delimiter)) {
      const dir = part.trim();
      if (dir) roots.push(dir);
    }
  }
  roots.push(
    path.join(process.cwd(), "skills"),
    path.join(os.homedir(), ".two-brothers", "skills"),
  );
  return roots;
}

/**
 * Default slash-command roots, shared by `GET /api/commands`:
 * `TWO_BROTHERS_COMMANDS_DIR` (OS path-list separated), then
 * `<cwd>/commands`, then `~/.two-brothers/commands` — the same convention as
 * the skill roots. A missing root is not an error.
 */
function defaultCommandsRoots(): string[] {
  const roots: string[] = [];
  const raw = process.env.TWO_BROTHERS_COMMANDS_DIR;
  if (raw) {
    for (const part of raw.split(path.delimiter)) {
      const dir = part.trim();
      if (dir) roots.push(dir);
    }
  }
  roots.push(
    path.join(process.cwd(), "commands"),
    path.join(os.homedir(), ".two-brothers", "commands"),
  );
  return roots;
}

/** Tolerant at the boundary: keep unique non-empty strings, drop the rest. */
function cleanModelList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalidBody();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const name = item.trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * Strict provider-preset `context_window` from a request body.
 *
 * Returns `undefined` when the field is absent/null (leave the stored value
 * unchanged), `0` when it is present as 0 (explicitly clear -> unknown), and
 * the positive value otherwise. A negative, float, string, boolean or
 * non-safe-integer value is a 400 — the preset window is operator data, never
 * model output, so unlike the settings-file reader this path never silently
 * coerces. `0` and absent are equivalent downstream (unknown).
 */
function providerContextWindowPatch(body: Record<string, unknown>): number | undefined {
  if (!("context_window" in body)) return undefined;
  const value = body.context_window;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new HttpError(400, "context_window must be an integer >= 0 (0 = unknown)");
  }
  return value;
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export interface ServerOptions {
  /** Run-config factory (Python parity: a fresh config per run). */
  configFactory?: () => Config;
  /** Session file directory (default: `<cwd>/sessions`). */
  sessionsDir?: string;
  /**
   * Local plugin directory scanned by the PluginManager (default: `<repo
   * root>/plugins` — the prototype's default plugin dir; a
   * missing directory means no plugins).
   */
  pluginsDir?: string;
  /**
   * Skill roots scanned by `discoverSkills` (default:
   * `TWO_BROTHERS_SKILLS_DIR`, then `<cwd>/skills`, then
   * `~/.two-brothers/skills`). A missing root is not an error.
   */
  skillsDirs?: string[];
  /**
   * Slash-command roots scanned by `discoverCommands` (default:
   * `TWO_BROTHERS_COMMANDS_DIR`, then `<cwd>/commands`, then
   * `~/.two-brothers/commands`). Metadata serves at `GET /api/commands`.
   */
  commandsDirs?: string[];
  /**
   * `--mcp-config` JSON file. Its servers are the base of every run's MCP
   * set; plugin-contributed servers merge underneath it (configured wins),
   * and a missing file warns without dropping the plugin servers.
   */
  mcpConfig?: string;
  /**
   * Compaction settings for web runs (auto-compact threshold, keep-recent
   * budget, force). When set, wins wholesale over the resolved config and the
   * persisted `compaction` setting; unset = merge the config factory's
   * non-zero compaction fields per field with the persisted section, so the
   * serve `--compact*` flags/env vars pin their fields while everything else
   * can come from Settings → Advanced (zero config = no auto compaction, the
   * CLI default).
   */
  compaction?: CompactionSettings;
  /** Worker-pool size (default: `TWO_BROTHERS_WORKERS` or 2). */
  workers?: number;
  /**
   * Built web app to serve at `/` (default: the packaged `<package>/web`
   * copy, else the repo's `web/dist`, when either exists; pass `null` to
   * disable static serving).
   */
  webDist?: string | null;
  /** Test hook: provider overrides wired into every run (like Python's
   *  `mock.patch` on `build_responder`). */
  providerOverrides?: { senior?: Provider; junior?: Provider };
  /**
   * Pinned approval mode for every run this server starts (the `serve`
   * `--approval-mode` flag / `TWO_BROTHERS_APPROVAL_MODE` env). Takes
   * precedence over the persisted `approval_policy` setting and is never
   * written to settings.json. Absent = the persisted mode (fail-closed
   * `ask`). Operators change the persisted mode through `PUT /api/settings`.
   */
  approvalPolicy?: ApprovalMode;
  /**
   * Opt-in startup retention for `<sessionsDir>/spill`: when set to a positive
   * number of days, the server prunes valid spill files strictly older than
   * that age once at startup (it already holds the writer lock). Absent means
   * no automatic deletion. A prune failure is logged and never fails startup.
   */
  spillRetentionDays?: number;
}

export interface ServerState {
  sessionsDir: string;
  configFactory: () => Config;
  workspaces: WorkspaceRegistry;
  metadata: SessionMetadataStore;
  settings: RuntimeSettings;
  settingsStore: SettingsStore;
  runtimeEvents: RuntimeEventStore;
  runs: RunManager;
  plugins: PluginManager;
  /** Resolves once the startup plugin load finishes (fail-soft by design). */
  pluginsReady: Promise<void>;
  /**
   * Effective shared plugin selection: the saved list (bare names or
   * `{path, options}` entries) plus the deprecated per-role env aliases
   * (both brothers receive every plugin tool).
   */
  pluginSelection: PluginSelection;
  /**
   * Diagnostics of the last run's plugin binding pass (`bindingsFor`):
   * deprecations, rejected options and failed hooks, as `plugin: message`.
   * Surfaced additively by `GET /api/plugins` when non-empty.
   */
  pluginDiagnostics: string[];
  /** `--mcp-config` file merged under the plugin MCP servers on every run. */
  mcpConfig?: string;
  /**
   * Exact session file names with a manual compaction in flight: the
   * serialization guard shared by the compact route (which reserves/releases)
   * and run admission (which refuses while reserved). Ephemeral, in-memory
   * only — never persisted.
   */
  compactions: Set<string>;
  /**
   * Pinned approval mode from `ServerOptions` (a serve CLI flag/env choice),
   * or null when runs follow the persisted `approval_policy` setting. The pin
   * is never persisted; `GET /api/settings` reports it as `pinned`.
   */
  approvalPolicyOverride: ApprovalMode | null;
}

export interface ServerHandle {
  state: ServerState;
  handler: http.RequestListener;
  /** Listen on host/port (port 0 = ephemeral); resolves with the server. */
  listen(host?: string, port?: number): Promise<http.Server>;
  /** End all SSE connections and close every started server. */
  close(): Promise<void>;
}

/** Sentinel: the handler fully managed the response (SSE / static files). */
const HANDLED = Symbol("handled");

/** Explicit non-200 JSON response (201/202 creations and acceptances). */
class Respond {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    this.status = status;
    this.body = body;
  }
}

interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  /** Parsed JSON object body; non-objects and bad JSON -> 400. */
  json(): Promise<Record<string, unknown>>;
}

type RouteHandler = (ctx: Ctx) => unknown | Promise<unknown>;

interface Route {
  method: string;
  regex: RegExp;
  keys: string[];
  handler: RouteHandler;
}

function compileRoute(method: string, pattern: string, handler: RouteHandler): Route {
  const keys: string[] = [];
  const parts = pattern.split("/").filter((part) => part.length > 0);
  const regex =
    "^/" +
    parts
      .map((part) => {
        if (part.startsWith("{") && part.endsWith("}")) {
          keys.push(part.slice(1, -1));
          return "([^/]+)";
        }
        return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("/") +
    "/?$";
  return { method, regex: new RegExp(regex), keys, handler };
}

/**
 * Resolve the default built-web-app directory from this module's location
 * (never cwd). The packaged `<package>/web` copy wins — it is what
 * `scripts/sync-web.mjs` puts in the npm tarball — then the repo layout
 * `<repo>/web/dist` for dev checkouts. Returns `null` when neither has an
 * `index.html`.
 */
export function resolveDefaultWebDist(moduleUrl: string | URL = import.meta.url): string | null {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  const packageDir = path.resolve(moduleDir, "..");
  const candidates = [
    path.join(packageDir, "web"),
    path.resolve(packageDir, "..", "..", "web", "dist"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "index.html"))) return candidate;
  }
  return null;
}

export function createServer(options: ServerOptions = {}): ServerHandle {
  const sessionsDir = options.sessionsDir
    ? path.resolve(options.sessionsDir)
    : path.join(process.cwd(), "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });

  const settingsStore = new SettingsStore(path.join(sessionsDir, "settings.json"));
  const settings = new RuntimeSettings(settingsStore);
  // The constructor already hydrated the saved roles. Re-save them only when
  // this release may write the document: a future-version settings.json is
  // read-only, and serve must still start so GET /api/settings can report its
  // schema state (every write route then answers 409).
  const settingsWritable = settingsStore.schemaState().writable;
  if (settingsWritable) {
    for (const role of ROLES) {
      const saved = settingsStore.read()[role];
      if (saved) settings.update({ [role]: saved });
    }
  }
  // Environment beats the persisted file where set — effective precedence
  // for the run config is: per-run flags > TWO_BROTHERS_* env vars >
  // persisted settings > defaults. (Persisted writes strip env-pinned
  // fields, so this overlay never reaches settings.json.)
  applyEnvOverrides(settings, settingsWritable);

  // Operator approval mode: a serve CLI flag/env pin (never persisted) beats
  // the persisted `approval_policy` setting, which fails closed to `ask` when
  // missing or corrupt. Read per run so a settings save applies to the next
  // run without a restart.
  const approvalPolicyOverride: ApprovalMode | null =
    options.approvalPolicy === undefined ? null : resolveApprovalMode(options.approvalPolicy);
  const effectiveApprovalPolicy = (): ApprovalMode =>
    approvalPolicyOverride ?? settingsStore.readApprovalPolicy();
  const approvalPolicyView = (): { mode: ApprovalMode; pinned: boolean } => ({
    mode: effectiveApprovalPolicy(),
    pinned: approvalPolicyOverride !== null,
  });

  const layout = new SessionLayout(sessionsDir);
  // One writer per store: serve and the migration command share this lock, so
  // a live run can never keep appending to a file that is being moved.
  const releaseWriterLock = layout.acquireWriterLock("serve");
  // Opt-in spill retention (default off): the server already owns the writer
  // lock, so prune valid <sessionsDir>/spill artifacts older than the
  // configured age once at startup. Fail-soft: a broken store logs one line
  // and startup continues; no other session data is touched.
  const spillRoot = path.join(sessionsDir, "spill");
  if (options.spillRetentionDays !== undefined) {
    const days = options.spillRetentionDays;
    if (typeof days === "number" && Number.isFinite(days) && days > 0) {
      try {
        const result = new SpillStore(spillRoot).prune({ olderThanMs: days * 86_400_000 });
        const failure = result.failed > 0 ? `; ${result.failed} failed` : "";
        console.log(
          `[two-brothers] spill retention: removed ${result.removed} of ` +
            `${result.filesBefore} file(s) older than ${days} day(s) ` +
            `(${result.bytes} bytes) from ${spillRoot}; ${result.kept} kept${failure}`,
        );
        for (const line of result.errors) {
          console.warn(`[two-brothers] spill retention: ${line}`);
        }
      } catch (exc) {
        console.warn(
          `[two-brothers] spill retention skipped: ${exc instanceof Error ? exc.message : String(exc)}`,
        );
      }
    } else {
      console.warn(
        `[two-brothers] spill retention ignored: expected a positive number of days, ` +
          `got ${String(days)}`,
      );
    }
  }
  const runtimeEvents = new RuntimeEventStore(path.join(sessionsDir, "runtime"), layout);
  // Run-scoped workspace edit undo (wave 23): one persisted, content-addressed
  // store for every workspace-bound run. It is a session side artifact (never
  // a protocol/session record); the store creates its directories lazily.
  const undoRoot = path.join(sessionsDir, "undo");
  const runs = new RunManager({ persist: runtimeEvents.asPersist(), workers: options.workers });
  const providerOverrides = options.providerOverrides ?? null;

  // Shared plugin selection (owner decision 2026-11-03): one list, both
  // brothers. `readPlugins()` merges any legacy per-role section on disk and
  // preserves `{path, options}` entries; the deprecated per-role env vars
  // stay accepted as additive aliases and are never persisted, so removing
  // them reveals the saved list again.
  let savedPluginSelection: PluginSelection = settingsStore.readPlugins();
  const pluginSelection: PluginSelection = [...savedPluginSelection];
  addPluginNames(pluginSelection, envPluginNames());

  // Local plugin system (plugins.py port): discovered once here and reloaded
  // after every settings change carrying a `plugins` section; a broken
  // plugin logs a warning and is skipped — never breaks startup. The
  // selection doubles as the load-time settings source for per-plugin options.
  const plugins = new PluginManager(options.pluginsDir, pluginSelection);
  const pluginsReady = plugins.reload();

  // Skill discovery is re-run on demand (a run, `GET /api/skills`), so a new
  // `SKILL.md` needs no server restart. Missing roots are skipped silently by
  // `discoverSkills`; the catalog is fail-soft either way.
  const skillsDirs = options.skillsDirs ?? defaultSkillsRoots();
  const skillCatalog = (): SkillCatalog => discoverSkills(skillsDirs);

  // Slash-command discovery is on demand too (`GET /api/commands`), so a new
  // `<name>.md` needs no server restart. A missing root is skipped silently.
  const commandsDirs = options.commandsDirs ?? defaultCommandsRoots();
  const commandCatalog = (): CommandCatalog => discoverCommands(commandsDirs);

  const state: ServerState = {
    sessionsDir,
    configFactory: options.configFactory ?? (() => resolveConfig()),
    workspaces: new WorkspaceRegistry(path.join(sessionsDir, "workspaces.json")),
    metadata: new SessionMetadataStore(sessionsDir, layout),
    settings,
    settingsStore,
    runtimeEvents,
    runs,
    plugins,
    pluginsReady,
    pluginSelection,
    pluginDiagnostics: [],
    mcpConfig: options.mcpConfig,
    compactions: new Set<string>(),
    approvalPolicyOverride,
  };

  // -- helpers ---------------------------------------------------------------

  /**
   * Refuse a settings write before any in-memory mutation when the document
   * was written by a newer release. All settings write routes map the typed
   * error to HTTP 409; reads keep working.
   */
  function requireWritableSettings(): void {
    const schema = state.settingsStore.schemaState();
    if (!schema.writable && schema.version !== null) {
      throw new SettingsSchemaVersionError(schema.version);
    }
  }

  /**
   * Additive `compaction` view for `GET/PUT /api/settings` (wave 25): each
   * budget reports its stored section value, the value a serve run would use
   * after the flag/env > persisted merge, and where that value came from
   * (`flag`, `persisted`, `options`, `absent`). Read-only — a GET never
   * writes. A custom config factory is invoked exactly like a run would.
   */
  function compactionView() {
    const persisted = state.settingsStore.readCompaction();
    // An explicit ServerOptions pin is wholesale: the config factory cannot
    // change it, so do not invoke a possibly-wrong factory at all.
    if (options.compaction !== undefined) {
      return compactionSettingsView({} as Config, persisted, options.compaction);
    }
    const presetWindow = presetWindowForRun();
    let cfg: Config;
    try {
      cfg = state.configFactory();
    } catch {
      // A throwing custom config factory must never turn a settings read into
      // a 500 (and must never hide an already-persisted PUT). Fall back to the
      // persisted layer plus the preset fallback; no field then claims a
      // flag/env pin.
      return compactionSettingsView({} as Config, persisted, undefined, presetWindow);
    }
    return compactionSettingsView(cfg, persisted, undefined, presetWindow);
  }

  function materializeStore(name: string, projectPath?: string | null): SessionStore {
    // `path.basename` flattening: never allow path traversal out of the root.
    const target = layout.materialize(path.basename(name), projectPath);
    return new SessionStore(target.sessionPath);
  }

  /**
   * Read-only store handle. Never creates a session directory: an unknown name
   * yields a handle whose path does not exist, so the caller's `exists()`/404
   * path stays side-effect free.
   */
  function storeFor(name: string): SessionStore {
    const location = layout.resolve(path.basename(name));
    return new SessionStore(
      location === null
        ? path.join(sessionsDir, path.basename(name))
        : location.sessionPath,
    );
  }

  function sessionName(raw: string | null | undefined): string {
    if (raw === "." || raw === "..") throw new HttpError(400, "invalid session name");
    const name = raw ? path.basename(raw) : newSessionName();
    if (name === "." || name === ".." || name === "") {
      throw new HttpError(400, "invalid session name");
    }
    return name.endsWith(".jsonl") ? name : `${name}.jsonl`;
  }

  /**
   * Validate a name that must already denote a session file: basename-
   * flattened (never a path) and ending in `.jsonl`, so the session endpoints
   * cannot touch the settings/provider JSON or the registry file living next
   * to the sessions. `sessionName()` above appends the extension for run
   * submissions; these handlers require it to be present instead.
   */
  function sessionFileName(raw: string): string {
    const name = path.basename(raw);
    if (name === "." || name === ".." || name === "" || !name.endsWith(".jsonl")) {
      throw new HttpError(400, "invalid session name");
    }
    return name;
  }

  function listSessions(workspaceId: string | null): Array<Record<string, unknown>> {
    const items: Array<Record<string, unknown>> = [];
    for (const location of layout.list()) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(location.sessionPath);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      const item = state.metadata.attach(location.name, {
        size: stat.size,
        mtime: Math.floor(stat.mtimeMs / 1000),
      });
      if (workspaceId && item.workspace_id !== workspaceId) continue;
      items.push(item);
    }
    items.sort((a, b) => Number(b.mtime) - Number(a.mtime));
    return items;
  }

  function buildCfg(req: RunRequestData, warn = true): { cfg: Config; endpoints: RoleEndpoints } {
    const cfg = state.configFactory();
    // Run-level provider (flags/env) before role settings overlay it —
    // it is the fallback for roles that do not set their own provider.
    const baseProvider = req.provider ?? cfg.provider;
    const snapshot = state.settings.snapshot();
    // Role settings overlay models (always) and provider (unless a
    // per-request provider override is in force) — connection fields are
    // deliberately NOT overlaid onto the shared cfg anymore (Stage 18
    // design decision 4; that collapse was the defect: junior won).
    for (const role of ROLES) {
      const rs = snapshot[role];
      if (rs.model) {
        if (role === "senior") cfg.seniorModel = rs.model;
        else cfg.juniorModel = rs.model;
      }
      if (req.provider === undefined && rs.provider) cfg.provider = rs.provider;
    }
    if (req.mode !== undefined) {
      if (!MODES.has(req.mode)) throw new HttpError(400, "invalid mode");
      cfg.mode = req.mode as Config["mode"];
    }
    if (req.provider !== undefined) {
      if (!PROVIDERS.has(req.provider)) throw new HttpError(400, "invalid provider");
      cfg.provider = req.provider;
    }
    // Stage 18: resolve each role's effective endpoint (role env pair >
    // shared env pair > named preset > role manual fields) and hand the
    // per-role endpoints to the harness. Connection fields gap-fill across
    // roles inside the resolver (Python's shared-config fallback), so a role
    // without its own resolved URL inherits the other role's; provider and
    // model are never borrowed across roles. The shared cfg fields remain
    // only as the per-field fallback inside the harness/validation.
    // Presets are the seeded table with stored presets layered on top; each
    // key is resolved through `presetApiKey` so an env-backed seed works.
    const endpoints = resolveRoleEndpoints(
      snapshot,
      resolvablePresets(),
      process.env,
      { provider: baseProvider, seniorModel: cfg.seniorModel, juniorModel: cfg.juniorModel },
      req.provider === undefined,
    );
    for (const warning of endpoints.warnings) {
      if (warn) console.warn(`[two-brothers] ${warning}`);
    }
    return { cfg, endpoints };
  }

  /**
   * The persisted run-level compaction budgets, read on every use so a
   * Settings → Advanced save applies to the next run or manual compaction
   * without a server restart (same rule as the approval policy). Missing or
   * corrupt reads as absent — the store's fail-closed direction.
   */
  function persistedCompaction(): PersistedCompactionSettings {
    return state.settingsStore.readCompaction();
  }

  /**
   * Compaction settings for a manual `POST /api/sessions/{name}/compact`.
   *
   * Precedence: an explicit `ServerOptions.compaction` wins (with the run-level
   * context window filling in when the options do not set one — flag/env first,
   * then the persisted section); otherwise the merged flag/env > persisted
   * fields apply (`compactionFieldsForServe`, so `serve` flags and the saved
   * section are both honoured, with the resolved preset window as the last
   * context-window fallback); only `force` is dropped, because the request
   * always asks for exactly one compaction. With nothing configured the derived
   * settings equal the honest `compaction.ts` defaults, so an explicit
   * `/compact` on a long session stays meaningful even when auto compaction is
   * off.
   */
  function manualCompactionSettings(cfg: Config, presetWindow = 0): CompactionSettings {
    const persisted = persistedCompaction();
    const configured = options.compaction;
    if (configured === undefined) {
      const settings = { ...compactionFieldsForServe(cfg, persisted, undefined, presetWindow) };
      delete settings.force;
      return settings;
    }
    const configuredWindow = configured.contextWindow ?? 0;
    const window =
      configuredWindow > 0
        ? configuredWindow
        : (compactionFieldsForServe(cfg, persisted, undefined, presetWindow).contextWindow ?? 0);
    if (configuredWindow > 0 || window <= 0) return configured;
    return { ...configured, contextWindow: window };
  }

  /**
   * Reject run admission while a manual compaction owns the target session.
   * Thrown before any session file or run record is created, so the
   * compaction's JSONL rewrite can never drop a concurrently admitted run's
   * envelopes. Checked synchronously right before the mutation, so there is no
   * window for the reservation to appear afterwards.
   */
  function assertNotCompacting(name: string): void {
    if (state.compactions.has(name)) {
      throw new HttpError(409, "a compaction is in progress for this session; retry in a moment");
    }
  }

  /**
   * Fork and rewind read/rewrite one session file, so they must not race a live
   * run (which appends to, and compaction may rewrite, the same file) or a
   * manual compaction that owns it. This is the compact route's guard without
   * the reservation: both operations complete synchronously after the check, so
   * no run can be admitted between the check and the file work. The action
   * wording keeps the 409 honest per route.
   */
  function assertSessionQuiescent(name: string, action: "fork" | "rewind"): void {
    const live = state.runs.list().some(
      (record) => record.session === name && ACTIVE_STATES.has(String(record.status)),
    );
    if (live) {
      throw new HttpError(
        409,
        `a run is active for this session; stop it before ${action === "fork" ? "forking" : "rewinding"} it`,
      );
    }
    if (state.compactions.has(name)) {
      throw new HttpError(409, "a compaction is in progress for this session; retry in a moment");
    }
  }

  /** HTTP status for a typed fork failure (never a generic 500 for user input). */
  function forkErrorStatus(error: SessionForkError): number {
    switch (error.code) {
      case "source-missing":
        return 404;
      case "invalid-name":
      case "invalid-seq":
        return 400;
      case "name-taken":
        return 409;
      case "source-unreadable":
        return 422;
      default:
        // write-failed: the session directory is not writable, not a request
        // problem, and the fork rollback already removed any partial file.
        return 500;
    }
  }

  /**
   * Cheap file identity for the rewind rewrite CAS: size + mtime (ns) + inode
   * wherever the platform reports one. `null` when the file cannot be stat'ed
   * (which the rewind route reports as a changed-session 409).
   */
  function sessionFileSignature(filePath: string): string | null {
    try {
      const stat = fs.statSync(filePath);
      return `${stat.size}:${stat.mtimeMs}:${String(stat.ino ?? 0)}`;
    } catch {
      return null;
    }
  }

  /**
   * The registered workspace whose canonical path equals an undo record's
   * recorded root. Undo records are restart-resilient, so the workspace is
   * resolved through the live registry on every request; a record whose
   * workspace is no longer registered (moved, removed, or produced by another
   * checkout) is an honest 409 instead of silently restoring into a directory
   * the operator no longer selected.
   */
  function undoWorkspaceRoot(recorded: string): string {
    for (const workspace of state.workspaces.list()) {
      let real: string;
      try {
        real = fs.realpathSync(workspace.path);
      } catch {
        continue; // a registered path that vanished cannot match the record
      }
      const same =
        process.platform === "win32"
          ? real.toLowerCase() === recorded.toLowerCase()
          : real === recorded;
      if (same) return real;
    }
    throw new WorkspaceUndoError(
      "workspace_mismatch",
      `undo record belongs to workspace ${recorded}, which is not registered`,
    );
  }

  /**
   * Map a workspace-undo store failure onto the routes' honest contract:
   * unknown/invalid records are 404, unusable records (corrupt, oversized,
   * unsupported version, no longer registered workspace) 409, and unexpected
   * store IO 422. A non-store exception is a 422 with a generic detail — the
   * store is a local side artifact, never a request-shape problem.
   */
  function undoHttpError(exc: unknown): HttpError {
    if (exc instanceof HttpError) return exc;
    if (exc instanceof WorkspaceUndoError) {
      switch (exc.code) {
        case "invalid_run_id":
        case "unknown_record":
          return new HttpError(404, "not found");
        case "corrupt_record":
        case "unsupported_version":
        case "oversized_record":
        case "workspace_mismatch":
          return new HttpError(409, exc.message);
        default:
          return new HttpError(422, exc.message);
      }
    }
    return new HttpError(422, `undo store error: ${errorDetail(exc)}`);
  }

  /**
   * Shared admission + guard pass for the undo routes: session exists (the
   * caller checked), the record loads from disk (restart-resilient), a record
   * that names its session matches the URL, the run is not active in memory
   * (previewing/applying while it can still mutate would be misleading — the
   * decision applies to preview AND apply), and its recorded workspace is
   * still registered. Returns the canonical workspace root preview/apply re-
   * validate against.
   */
  function openUndoRequest(name: string, runId: string): {
    record: WorkspaceUndoRecord;
    workspaceRoot: string;
  } {
    let record: WorkspaceUndoRecord;
    try {
      record = loadUndoRecord(undoRoot, runId);
    } catch (exc) {
      throw undoHttpError(exc);
    }
    if (record.session !== undefined && record.session !== name) {
      throw new HttpError(404, "not found");
    }
    const live = state.runs.get(runId);
    if (live !== null && ACTIVE_STATES.has(live.status)) {
      throw new HttpError(
        409,
        `the run is still ${live.status}; stop it before previewing or applying undo`,
      );
    }
    let workspaceRoot: string;
    try {
      workspaceRoot = undoWorkspaceRoot(record.workspace_root);
    } catch (exc) {
      throw undoHttpError(exc);
    }
    return { record, workspaceRoot };
  }

  /**
   * Build the summarizer provider for a manual compaction through the exact
   * provider construction a run uses (per-role resolved endpoints / presets +
   * the server's test provider overrides) so the endpoint never grows a second
   * HTTP client path. A construction failure is a 502: the operator cannot fix
   * a provider from the request body.
   */
  function summarizerProvider(
    cfg: Config,
    endpoints: RoleEndpoints,
    role: "senior" | "junior",
  ): Provider {
    try {
      const harness = new TwoBrothersHarness(cfg, {
        endpoints,
        ...(providerOverrides?.senior ? { senior: providerOverrides.senior } : {}),
        ...(providerOverrides?.junior ? { junior: providerOverrides.junior } : {}),
      });
      return role === "senior" ? harness.providers.senior : harness.providers.junior;
    } catch (exc) {
      throw new HttpError(502, `cannot build the summarizer provider: ${errorDetail(exc)}`);
    }
  }

  /**
   * The seeded preset table with the stored presets layered on top: a stored
   * preset whose name matches a seed replaces it (user edits win), a stored
   * preset with no key of its own keeps the seed's `api_key_env` so editing a
   * seed's models does not silently drop its env-backed key.
   */
  function mergedPresets(): Preset[] {
    return mergeSeedPresets(state.settingsStore.readProviders()).map((preset) => {
      if (preset.api_key || preset.api_key_env) return preset;
      const seed = presetById(preset.name);
      return seed?.api_key_env ? { ...preset, api_key_env: seed.api_key_env } : preset;
    });
  }

  /** Merged presets with each key resolved for the endpoint resolver. */
  function resolvablePresets(): Array<{
    name: string;
    base_url: string;
    api_key: string;
    kind: string;
    context_window?: number;
  }> {
    return mergedPresets().map((preset) => ({
      name: preset.name,
      base_url: preset.base_url,
      api_key: presetApiKey(preset),
      kind: preset.kind,
      ...(typeof preset.context_window === "number" &&
      Number.isSafeInteger(preset.context_window) &&
      preset.context_window > 0
        ? { context_window: preset.context_window }
        : {}),
    }));
  }

  /**
   * The preset-derived context window a run would inherit: resolved from each
   * role's named preset (`provider_ref`), smaller of the two when both declare
   * one. This mirrors the run path exactly — same snapshot, same merged
   * presets, same env — so the settings view can report the `preset` source
   * honestly. Env/manual-field connections never contribute a window.
   */
  function presetWindowForRun(): number {
    try {
      return presetContextWindow(
        resolveRoleEndpoints(state.settings.snapshot(), resolvablePresets(), process.env, {}),
      );
    } catch {
      return 0;
    }
  }

  /**
   * Mode the submitted run record carries: the request's mode, else the
   * config default the job will run with. A failing config factory is not
   * fatal here — the job surfaces it as the run error.
   */
  function effectiveMode(req: RunRequestData): string {
    if (req.mode !== undefined) return req.mode;
    try {
      return state.configFactory().mode;
    } catch {
      return "";
    }
  }

  /**
   * Rebuild a minimal run record from the runtime sidecar when the in-memory
   * record is gone (backend restart). Every manager event is persisted with
   * its `run_id`, so the terminal `run_end` (plus the preceding `run_error`)
   * reconstructs status/error/usage/timestamps without a second store.
   * `task` and `mode` are not in the event stream and stay "". The record is
   * marked `rebuilt: true` (additive; live in-memory records omit the field)
   * so the UI can explain the blank fields instead of guessing. Returns null
   * when no sidecar holds a terminal run with that id.
   *
   * `cost` is not an event field either: it is RECOMPUTED here from the
   * persisted `run_end` usage and the models the CURRENT config resolves to
   * (same rule as the live run job). A settings/model change between the run
   * and this read can therefore change the estimate, and an unpriceable or
   * now-mixed-model config honestly reports `null`. The usage counters
   * themselves are never rewritten.
   */
  function recoverRun(runId: string): Record<string, unknown> | null {
    const found = state.runtimeEvents.findRun(runId);
    if (found === null) return null;
    const reversed = [...found.events].reverse();
    const end = reversed.find((event) => event.type === "run_end");
    if (end === undefined || typeof end.status !== "string") return null;
    if (!TERMINAL_STATES.has(end.status)) return null;
    const error = reversed.find((event) => event.type === "run_error");
    const queued = found.events.find(
      (event) => event.type === "run_status" && event.status === "queued",
    );
    const running = found.events.find(
      (event) => event.type === "run_status" && event.status === "running",
    );
    const record: Record<string, unknown> = {
      run_id: runId,
      session: found.session,
      task: "",
      mode: "",
      rebuilt: true,
      status: end.status,
      created: typeof queued?.at === "number" ? queued.at : 0,
      started: typeof running?.at === "number" ? running.at : 0,
      finished: typeof end.at === "number" ? end.at : 0,
    };
    if (error !== undefined && typeof error.message === "string" && error.message) {
      record.error = error.message;
    }
    if (isRecord(end.decision)) record.decision = end.decision;
    const usage = isRecord(end.usage) ? { ...emptyUsage(), ...end.usage } : { ...emptyUsage() };
    record.usage = usage;
    // Recompute (never persist) the cost: the event stream stays free of a
    // derived field, and the current config is the only model source after a
    // restart. A failing config factory keeps the record usable with a null
    // estimate rather than turning the read into a 500.
    try {
      const { cfg, endpoints } = buildCfg({ task: "" }, false);
      record.cost = estimateRecordCost(cfg, endpoints, usage);
    } catch {
      record.cost = null;
    }
    return record;
  }

  async function executeRun(
    task: string,
    name: string,
    cfg: Config,
    signal?: AbortSignal,
    onEnvelope?: (message: unknown) => void,
    workspace?: Workspace,
    endpoints?: RoleEndpoints,
    injections?: string[],
    onToken?: LiveTokenHook,
    steering?: () => string[],
    runIdOf?: () => string | null,
    projectPath?: string | null,
  ): Promise<HarnessResult> {
    const store = materializeStore(name, projectPath ?? workspace?.root ?? null);
    const context = store.exists() ? restoreContext(store) : new SharedContext(store);
    // Tool-output spill lives beside the session files (the same root the
    // optional startup retention pass inspects).
    // Fail fast on an unusable model config before touching the network;
    // with per-role endpoints each role is checked against its own
    // effective settings and the message names the misconfigured role.
    validateRunConfig(cfg, endpoints);
    // Plugin contributions bind per run (plugins.py parity): tools only for
    // workspace-bound runs, through the same approval broker as the built-in
    // tools; hooks are collected for every run. Tools are routed by their
    // declared scope (`shared` / `senior` / `junior`) — a legacy positional
    // role keeps the tool shared (owner decision 2026-11-03) — so the
    // senior's verify slice and the junior's belt each get their own set.
    // Fail-soft: a broken binding pass never blocks the run.
    let toolScopes: ToolScopes | undefined;
    let hooks: HookRegistry | undefined;
    let bindings: PluginBindings | null = null;
    try {
      await state.pluginsReady;
      bindings = await state.plugins.bindingsFor(state.pluginSelection, workspace ?? null);
      hooks = bindings.hooks;
      state.pluginDiagnostics = bindings.diagnostics.map(
        (entry: PluginDiagnosticEntry) => `${entry.plugin}: ${entry.message}`,
      );
      if (workspace) toolScopes = mergeScopeBuckets(toolScopes, bindings.toolsByScope);
    } catch (exc) {
      console.warn(`[two-brothers] plugin binding failed: ${errorDetail(exc)}`);
    }
    // MCP after the binding pass and before the harness: the configured
    // `mcpConfig` file is the base (a missing file warns and keeps the
    // plugin servers), plugin declarations merge underneath it (configured
    // wins a name collision), and the per-role buckets join the run scopes.
    let mcp: McpToolSet | null = null;
    const pluginServers = bindings?.mcpServers ?? [];
    if (state.mcpConfig !== undefined || pluginServers.length > 0) {
      let base: McpConfigFileShape | null = null;
      if (state.mcpConfig !== undefined) {
        try {
          base = { mcpServers: loadMcpToolSpecs(state.mcpConfig) };
        } catch (exc) {
          console.warn(`[two-brothers] MCP config: ${errorDetail(exc)}`);
        }
      }
      const merged = mergeMcpConfig(base, pluginServers);
      for (const line of merged.diagnostics) console.warn(`[two-brothers] ${line}`);
      try {
        // The harness always has a spill store on the server, so MCP hands it
        // the full sanitized text; the harness saves/spills above its budget.
        mcp = await loadMcpTools(merged.config, { deferOutputBounds: true });
        for (const err of mcp.errors) console.warn(`[two-brothers] ${err}`);
        toolScopes = mergeScopeBuckets(toolScopes, {
          shared: mcp.sharedTools,
          senior: mcp.seniorTools,
          junior: mcp.juniorTools,
        });
      } catch (exc) {
        console.warn(`[two-brothers] MCP: ${errorDetail(exc)}`);
      }
    }
    // Run-scoped workspace edit undo (wave 23): a workspace-bound run captures
    // the exact pre/post bytes of every write/edit/delete under
    // `<sessions>/undo`, so the operator can preview/apply/discard it later.
    // Fail-soft by contract: a capture that cannot start is ONE diagnostic and
    // the run proceeds normally; the recorder itself is bounded (2 MiB per
    // side, 64 entries, 8 MiB per run) and never throws into the tool path.
    const undoRunId = runIdOf?.() ?? null;
    let undoCapture: WorkspaceUndoCapture | null = null;
    if (workspace !== undefined && undoRunId !== null) {
      try {
        undoCapture = beginUndoCapture(undoRoot, undoRunId, workspace.root, {
          session: name,
          // Close-time retention must never remove a record another live run
          // still owns (queued/running/waiting): the callback is read at close.
          activeRuns: () =>
            state.runs
              .list()
              .filter((run) => ACTIVE_STATES.has(String(run.status)))
              .map((run) => String(run.run_id)),
        });
        workspace.setMutationRecorder(undoCapture.recorder, (line) =>
          console.warn(`[two-brothers] ${line}`),
        );
      } catch (exc) {
        console.warn(`[two-brothers] undo capture disabled: ${errorDetail(exc)}`);
        undoCapture = null;
      }
    }
    // Config-derived, persisted and preset-derived auto-compaction (waves
    // 25/26): `serve` accepts the same `--compact*` / `--context-window` flags
    // and env vars as `run`/`chat`, Settings → Advanced persists the remaining
    // budgets in the `compaction` section, and the roles' named presets supply
    // a fallback context window. Per field the explicit flag/env config wins,
    // then the saved value, then (context window only) the smaller resolved
    // preset window; an explicit `ServerOptions.compaction` still wins
    // wholesale, and zero config everywhere keeps the options object
    // byte-identical.
    const compaction = serveCompactionSettings(
      cfg,
      persistedCompaction(),
      options.compaction,
      presetContextWindow(endpoints),
    );
    // Advisory repeat guard: default on for every web run; the same
    // `TWO_BROTHERS_REPEAT_GUARD=off` escape hatch as the CLI disables it.
    const repeatToolGuard = repeatToolGuardFromEnv();
    // Root-level workspace instructions are on by default for a bound workspace;
    // `TWO_BROTHERS_PROJECT_INSTRUCTIONS=off` disables them for this process.
    const projectInstructions = projectInstructionsFromEnv();
    const harness = new TwoBrothersHarness(cfg, {
      workspace,
      signal,
      onEvent: onEnvelope,
      onEnvelope: onEnvelope ? (msg) => onEnvelope(msg) : undefined,
      senior: providerOverrides?.senior,
      junior: providerOverrides?.junior,
      endpoints,
      skills: skillCatalog(),
      ...(compaction ? { compaction } : {}),
      ...(repeatToolGuard !== undefined ? { repeatToolGuard } : {}),
      ...(projectInstructions !== undefined ? { projectInstructions } : {}),
      spill: { root: spillRoot },
      ...(toolScopes ? { toolScopes } : {}),
      ...(hooks ? { hooks } : {}),
      // Mid-run operator steering (wave 23): the run job hands the record's
      // bounded queue drain here, so a `POST /api/runs/{run_id}/steer` text is
      // appended as a normal user->senior `message` envelope at the next node
      // boundary / tool-loop iteration. Never an early/faked event.
      ...(steering ? { steering } : {}),
      // Live thinking/text deltas are only requested when the caller supplied
      // a token sink (the server does that solely for background runs with
      // `stream_tokens: true`): the harness requires both options together,
      // and every `token` stream event is forwarded to the record's ephemeral
      // SSE listeners. No sink = byte-identical non-streaming provider calls.
      ...(onToken !== undefined
        ? {
            streamTokens: true,
            onStreamEvent: (event: StreamEvent): void => {
              if (event.type === "token") onToken(event);
            },
          }
        : {}),
    });
    // Operator mention injections (`@skill:` / `@file`) are context messages
    // in their own right: append them BEFORE the task envelope — `harness.run`
    // appends the task itself — so the persisted transcript order is
    // [skill/file blocks…, task]. The context store persists them in the
    // session JSONL; the run-stream hook (when present) mirrors them like any
    // other published envelope, so a live SSE follower sees them too.
    for (const block of injections ?? []) {
      const message = context.makeAndAppend("user", "senior", "message", { text: block });
      onEnvelope?.(message);
    }
    try {
      return await harness.run(task, context);
    } finally {
      // The run is over: stop accepting undo records (idempotent, never throws,
      // and salvages a record whose last per-mutation write failed).
      undoCapture?.close();
      // connections stay open for the whole run; closed once it settles
      await mcp?.client.close();
    }
  }

  /**
   * Fold one binding pass's scope buckets into the run's `toolScopes`
   * registry (plugin tools, then the MCP buckets). Empty buckets are dropped
   * so the harness keeps its "no scopes configured" defaults.
   */
  function mergeScopeBuckets(
    scopes: ToolScopes | undefined,
    buckets: PluginBindings["toolsByScope"],
  ): ToolScopes | undefined {
    const merged: ToolScopes = {};
    for (const scope of ["shared", "senior", "junior"] as const) {
      const list = [...(scopes?.[scope] ?? []), ...buckets[scope]];
      if (list.length > 0) merged[scope] = list;
    }
    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  function buildRunJob(
    task: string,
    name: string,
    req: RunRequestData,
    broker: RunApprovalBroker,
    injections: string[] = [],
    steering?: () => string[],
    runIdOf?: () => string | null,
  ): RunJob {
    // The config is built inside the job so a run picks up settings current
    // at start time; the broker binds the per-run emit hook and cancel
    // signal once the worker starts it.
    return async (signal, onEnvelope, onToken) => {
      const { cfg, endpoints } = buildCfg(req);
      // A queued run may start after the operator granted a session allow to an
      // earlier run on the same session: refresh the broker from the store.
      broker.seedSessionAllows(state.settingsStore.readSessionApprovals(name));
      broker.attach(onEnvelope, signal);
      let workspace: Workspace | undefined;
      if (req.workspace_id) {
        const registered = state.workspaces.get(req.workspace_id);
        if (registered === null) {
          throw new WorkspaceError(`unknown workspace_id: ${req.workspace_id}`);
        }
        workspace = new Workspace(
          registered.path,
          new PermissionManager(new PermissionPolicy(effectiveApprovalPolicy()), broker),
        );
      }
      const result = await executeRun(
        task,
        name,
        cfg,
        signal,
        onEnvelope,
        workspace,
        endpoints,
        injections,
        // Only a streaming submission forwards the record's token hook; every
        // other run leaves the harness on its non-streaming provider path.
        req.stream_tokens === true ? onToken : undefined,
        steering,
        runIdOf,
      );
      return {
        cancelled: result.cancelled,
        decision: result.decision,
        errors: result.errors,
        usage: result.usage,
        // Additive run cost (wave 24): computed here, where the resolved
        // config + per-role endpoints are in scope. `null` is honest.
        cost: estimateRecordCost(cfg, endpoints, result.usage),
      };
    };
  }

  function ensureWorkspace(workspaceId: string | undefined): void {
    if (workspaceId && state.workspaces.get(workspaceId) === null) {
      throw new HttpError(400, "unknown workspace_id");
    }
  }

  /**
   * The workspace a session is linked to through its metadata sidecar.
   *
   * A session created under a workspace keeps that link, and the web composer
   * treats it as the session's context (file picker, status seats). Run
   * submissions used to rely solely on the request's `workspace_id`, so a
   * later run on a linked session that omitted it (the composer sends `null`
   * when the sidebar filter is "all") silently lost the workspace tools and
   * refused `@file` mentions. `POST /api/runs` now falls back to this link;
   * an explicit request value still wins. Returns null for an unlinked or
   * unreadable sidecar.
   */
  function linkedSessionWorkspace(name: string): string | null {
    const meta = state.metadata.get(name);
    if (meta === null) return null;
    const value = meta.workspace_id;
    if (typeof value !== "string") return null;
    const id = value.trim();
    return id === "" ? null : id;
  }

  function userMessageEvent(text: string): Array<Record<string, unknown>> {
    return [{ from: "user", kind: "message", payload: { text } }];
  }

  /** One prepared operator submission: the task plus its mention injections. */
  interface PreparedSubmission {
    /** The task as submitted (a known slash command is expanded). */
    task: string;
    /** Command `mode`: overrides the request/cooperation mode for this run only. */
    modeOverride?: "consult" | "work";
    /** Rendered `<skill-loaded>`/`<file>` blocks, in injection order. */
    injections: string[];
  }

  /**
   * The 400 for submitting a built-in *action* command as a task. Actions are
   * performed by a surface (the web composer, the TUI, the CLI), never expanded
   * into a prompt: this route cannot do anything meaningful with one, so it
   * says what to do instead rather than submitting an empty turn.
   */
  function actionCommandError(command: BaseCommand): HttpError {
    if (command.action === "compact") {
      return new HttpError(
        400,
        "/compact is a built-in action, not a task: compact this session from the " +
          "composer/TUI (POST /api/sessions/{name}/compact) instead.",
      );
    }
    return new HttpError(
      400,
      `/${command.name} is a built-in action, not a task: perform it in the composer/TUI instead.`,
    );
  }

  /**
   * Prepare one operator submission, shared by `POST /api/runs` and the legacy
   * `POST /api/run`.
   *
   * 1. A leading `/name` resolves in this order: a discovered `<name>.md`
   *    template first (an operator override keeps priority), then the
   *    first-party base catalogue. A prompt command — discovered or base —
   *    expands its template (`matchCommand` + `expandCommand` /
   *    `expandBaseCommand`) and may override the run mode; an action base
   *    command is a 400 (a surface performs it), and an unknown slash name is
   *    submitted verbatim, so tasks may legitimately start with `/`
   *    (`/usr/bin/...`).
   * 2. `@skill:<name>` mentions attach the skill body: only `shared` skills may
   *    be operator mentions; count/unknown/role-scope problems are 400s.
   * 3. `@<path>` file mentions require the operator's workspace; paths are
   *    normalised, `..` segments and absolute paths are refused, and content is
   *    read through `Workspace.read_file` (read-only, confined, sensitive files
   *    refused) with the standard truncation marker; count/read/total-size
   *    problems are 400s.
   *
   * Injections are skills first (mention order), then files (mention order),
   * deduped by name/normalised path; the token text stays in `task` for
   * traceability. Every error is thrown BEFORE the caller creates a session or
   * a run, so a bad submission leaves nothing half-created.
   */
  async function prepareSubmission(req: RunRequestData): Promise<PreparedSubmission> {
    let task = req.task;
    let modeOverride: "consult" | "work" | undefined;

    const invocation = matchCommand(task);
    if (invocation !== null) {
      const command = commandCatalog().commands.find((entry) => entry.name === invocation.name);
      if (command !== undefined) {
        // A discovered `<name>.md` always wins over a same-named base command.
        task = expandCommand(command, invocation.args);
        if (command.mode !== undefined) modeOverride = command.mode;
      } else {
        const base = findBaseCommand(invocation.name);
        if (base !== undefined) {
          if (base.kind === "action") throw actionCommandError(base);
          try {
            task = expandBaseCommand(base, invocation.args);
          } catch {
            // `requiresArguments` (or a malformed catalogue entry): a usage 400.
            throw new HttpError(400, `usage: ${baseCommandUsage(base)}`);
          }
          if (base.mode !== undefined) modeOverride = base.mode;
        }
      }
    }
    // An empty command template must not become an empty task envelope.
    if (!task.trim()) throw new HttpError(400, "task must not be empty");

    const mentions = parseMentions(task);
    const injections: string[] = [];

    // -- skills: shared operator mentions only ---------------------------------
    if (mentions.skills.length > MENTION_MAX_SKILLS) {
      throw new HttpError(
        400,
        `too many skill mentions: ${mentions.skills.length} (max ${MENTION_MAX_SKILLS})`,
      );
    }
    if (mentions.skills.length > 0) {
      const skills = skillCatalog().skills;
      for (const name of mentions.skills) {
        const skill = skills.find((entry) => entry.name === name);
        if (skill === undefined) throw new HttpError(400, `unknown skill: ${name}`);
        if (skill.scope !== "shared") {
          throw new HttpError(
            400,
            `role-scoped skills cannot be operator mentions: ${name} (scope: ${skill.scope})`,
          );
        }
        injections.push(renderSkillLoadedBlock(skill.name, skill.body));
      }
    }

    // -- files: workspace-confined reads ---------------------------------------
    if (mentions.files.length > MENTION_MAX_FILES) {
      throw new HttpError(
        400,
        `too many file mentions: ${mentions.files.length} (max ${MENTION_MAX_FILES})`,
      );
    }
    if (mentions.files.length > 0) {
      if (!req.workspace_id) throw new HttpError(400, "file mentions require a workspace");
      const registered = state.workspaces.get(req.workspace_id);
      if (registered === null) throw new HttpError(400, "unknown workspace_id");
      let workspace: Workspace;
      try {
        workspace = new Workspace(registered.path);
      } catch (exc) {
        if (exc instanceof WorkspaceError) {
          throw new HttpError(400, `cannot attach file mentions: ${exc.message}`);
        }
        throw exc;
      }
      const seen = new Set<string>();
      for (const raw of mentions.files) {
        const rel = normalizeMentionPath(raw);
        if (rel === "") throw new HttpError(400, `cannot attach file "@${raw}": invalid path`);
        // `Workspace.resolve` confines too, but refuse the classic escapes up
        // front so the detail names the operator's token deterministically.
        if (path.isAbsolute(rel) || rel.startsWith("/") || /^[A-Za-z]:[\\/]/.test(rel)) {
          throw new HttpError(
            400,
            `cannot attach file "@${raw}": absolute paths are not allowed: ${rel}`,
          );
        }
        if (rel.split("/").includes("..")) {
          throw new HttpError(
            400,
            `cannot attach file "@${raw}": path escapes the workspace: ${rel}`,
          );
        }
        if (seen.has(rel)) continue; // `@a/x` and `@./a/x` attach once
        seen.add(rel);
        // read_file is read-only (auto-allowed) and reports WorkspaceErrors as
        // a status instead of throwing; those become 400s with the detail.
        const read = await workspace.read_file(rel, MENTION_MAX_FILE_CHARS);
        if (read.status !== "ok" || typeof read.content !== "string") {
          const detail = typeof read.error === "string" ? read.error : "cannot read file";
          throw new HttpError(400, `cannot attach file "@${raw}": ${detail}`);
        }
        if (read.content.includes("\u0000")) {
          throw new HttpError(400, `cannot attach file "@${raw}": not a text file`);
        }
        injections.push(renderFileBlock(rel, read.content, { truncated: read.truncated === true }));
      }
    }

    // The cap bounds exactly what is injected: every rendered block (per-file
    // reads are already capped with the truncation marker).
    const attached = injections.reduce((sum, block) => sum + block.length, 0);
    if (attached > MENTION_MAX_TOTAL_CHARS) {
      throw new HttpError(
        400,
        `attached mention content exceeds the ${MENTION_MAX_TOTAL_CHARS}-character limit: ` +
          `${attached} characters`,
      );
    }
    return { task, modeOverride, injections };
  }

  /**
   * `GET /api/workspaces/{id}/files` limit: an integer clamped to 1..200 and
   * defaulting to 50 when absent or non-numeric (same parsing style as
   * `searchLimit`).
   */
  function fileSearchLimit(raw: string | null): number {
    const parsed = raw === null || raw.trim() === "" ? Number.NaN : Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return FILE_SEARCH_DEFAULT_LIMIT;
    return Math.min(FILE_SEARCH_MAX_LIMIT, Math.max(1, parsed));
  }

  /**
   * Matching-entry count before the page limit. `searchWorkspaceFiles` ranks
   * exact basename > basename prefix > basename substring > full-path
   * substring; every basename tier is also a full-path substring, so a
   * path-substring count is exactly its match set (a blank query matches all).
   */
  function countWorkspaceFileMatches(
    files: readonly WorkspaceFileEntry[],
    query: string,
  ): number {
    if (query === "") return files.length;
    const needle = query.toLowerCase();
    let total = 0;
    for (const file of files) {
      if (file.path.replace(/\\/g, "/").toLowerCase().includes(needle)) total += 1;
    }
    return total;
  }

  /**
   * One session as an export document (`src/sessionsearch.ts` shape): envelopes
   * from the durable store, the sidecar title when present (derived title
   * otherwise, the same fallback `loadSessionDocs` uses), workspace link and
   * mtime in Unix seconds for the export header. A missing file is a 404.
   */
  function sessionExportDoc(name: string): SessionSearchDoc {
    const store = storeFor(name);
    if (!store.exists()) throw new HttpError(404, "not found");
    const events = store.load();
    const stem = name.replace(/\.jsonl$/, "");
    const meta = state.metadata.get(name);
    const metaTitle = meta !== null && typeof meta.title === "string" ? meta.title.trim() : "";
    const workspaceId =
      meta !== null && typeof meta.workspace_id === "string" && meta.workspace_id
        ? meta.workspace_id
        : null;
    let updated: number | null = null;
    try {
      updated = Math.floor(fs.statSync(store.path).mtimeMs / 1000);
    } catch {
      updated = null;
    }
    return {
      name,
      title: metaTitle || deriveTitle(events as unknown as Array<Record<string, any>>, stem),
      events,
      workspace_id: workspaceId,
      updated,
    };
  }

  /**
   * `GET /api/search` limit param: an integer clamped to `1..SEARCH_MAX_LIMIT`,
   * defaulting to `SEARCH_DEFAULT_LIMIT` when absent or non-numeric.
   */
  function searchLimit(raw: string | null): number {
    const parsed = raw === null || raw.trim() === "" ? Number.NaN : Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return SEARCH_DEFAULT_LIMIT;
    return Math.min(SEARCH_MAX_LIMIT, Math.max(1, parsed));
  }

  // -- routes: Stage 1 (session files + synchronous run) ---------------------

  const routes: Route[] = [];

  routes.push(
    compileRoute("GET", "/api/sessions", (ctx) => {
      const workspaceId = ctx.query.get("workspace_id");
      return listSessions(workspaceId && workspaceId.trim() ? workspaceId : null);
    }),
  );

  routes.push(
    compileRoute("GET", "/api/sessions/{name}", (ctx) => {
      const name = sessionFileName(ctx.params.name);
      const store = storeFor(name);
      if (!store.exists()) throw new HttpError(404, "not found");
      const detail: Record<string, unknown> = {
        name,
        events: store.load(),
      };
      const meta = state.metadata.get(name);
      if (meta !== null) {
        const stem = name.replace(/\.jsonl$/, "");
        detail.title = typeof meta.title === "string" ? meta.title : stem;
        if (typeof meta.workspace_id === "string" && meta.workspace_id) {
          detail.workspace_id = meta.workspace_id;
        }
      }
      return detail;
    }),
  );

  routes.push(
    compileRoute("GET", "/api/sessions/{name}/events", (ctx) => {
      const name = sessionFileName(ctx.params.name);
      return {
        name,
        events: state.runtimeEvents.load(name),
      };
    }),
  );

  // -- routes: session search + export (src/sessionsearch.ts) -----------------

  routes.push(
    compileRoute("GET", "/api/search", (ctx) => {
      const query = (ctx.query.get("q") ?? "").trim();
      if (query.length < SEARCH_MIN_QUERY_CHARS) {
        throw new HttpError(400, "query must be at least 2 characters");
      }
      // `loadSessionDocs` is fail-soft: a missing sessions dir yields an empty
      // corpus and a corrupt session file is skipped with a count.
      const loaded = loadSessionDocs(sessionsDir);
      return searchSessions(loaded.docs, query, {
        limit: searchLimit(ctx.query.get("limit")),
      });
    }),
  );

  // GET serves the export body; HEAD returns the same status/type/disposition
  // headers without a body (one handler serves both methods).
  for (const method of ["GET", "HEAD"] as const) {
    routes.push(
      compileRoute(method, "/api/sessions/{name}/export", (ctx) => {
        const name = sessionFileName(ctx.params.name);
        const requestedFormat = (ctx.query.get("format") ?? "markdown").trim().toLowerCase();
        if (
          requestedFormat !== "markdown" &&
          requestedFormat !== "json" &&
          requestedFormat !== "html"
        ) {
          throw new HttpError(400, "format must be markdown, json or html");
        }
        const format: "markdown" | "json" | "html" = requestedFormat;
        const doc = sessionExportDoc(name);
        // markdown/json stay byte-identical to the pre-wave-23 exporter; html
        // only adds a third self-contained rendering of the same document.
        const body =
          format === "markdown"
            ? sessionToMarkdown(doc)
            : format === "json"
              ? sessionToJsonString(doc)
              : sessionToHtmlString(doc);
        const contentType =
          format === "markdown"
            ? "text/markdown; charset=utf-8"
            : format === "json"
              ? "application/json; charset=utf-8"
              : "text/html; charset=utf-8";
        ctx.res.writeHead(200, {
          "Content-Type": contentType,
          "Content-Disposition": `attachment; filename="${exportSessionFileName(name, format)}"`,
          "Content-Length": Buffer.byteLength(body, "utf-8"),
        });
        ctx.res.end(ctx.req.method === "HEAD" ? undefined : body);
        return HANDLED;
      }),
    );
  }

  routes.push(
    compileRoute("POST", "/api/run", async (ctx) => {
      const req = parseRunRequest(await ctx.json());
      const rawTask = req.task.trim();
      if (!rawTask) throw new HttpError(400, "task must not be empty");
      const name = sessionName(req.session);
      // Same linked-workspace rule as POST /api/runs: an omitted workspace_id
      // inherits the session's metadata link, while an explicit value wins.
      // The effective request stays in scope for preparation, execution, the
      // metadata write and the session store/materialization path (which reads
      // the workspace link after the session-dirs layout merge).
      const linked = req.workspace_id === undefined ? linkedSessionWorkspace(name) : null;
      const baseReq: RunRequestData = {
        ...req,
        task: rawTask,
        ...(linked === null ? {} : { workspace_id: linked }),
      };
      ensureWorkspace(baseReq.workspace_id);
      // Same preparation as POST /api/runs (slash expansion + mention
      // injection); the sync route runs the expanded task while the metadata
      // title keeps the operator's raw text.
      const prepared = await prepareSubmission(baseReq);
      const runReq: RunRequestData =
        prepared.modeOverride === undefined
          ? baseReq
          : { ...baseReq, mode: prepared.modeOverride };
      const cfg = buildCfg(runReq);
      // The sync route has no approval channel, so a workspace is built from
      // the effective id and the effective approval policy (reads auto-allow;
      // modes that still ask have no broker and fail closed). This is the
      // workspace the harness offers as its read/write tool belt.
      let workspace: Workspace | undefined;
      if (runReq.workspace_id) {
        const registered = state.workspaces.get(runReq.workspace_id);
        if (registered === null) throw new HttpError(400, "unknown workspace_id");
        workspace = new Workspace(
          registered.path,
          new PermissionManager(new PermissionPolicy(effectiveApprovalPolicy())),
        );
      }
      // A manual compaction owns this session right now: refuse before the run
      // context is opened or any envelope is appended.
      assertNotCompacting(name);
      let result;
      try {
        result = await executeRun(
          prepared.task,
          name,
          cfg.cfg,
          undefined,
          undefined,
          workspace,
          cfg.endpoints,
          prepared.injections,
          undefined,
          undefined,
          undefined,
          runReq.workspace_id
            ? (state.workspaces.get(runReq.workspace_id)?.path ?? null)
            : null,
        );
      } catch (exc) {
        if (exc instanceof RunConfigError) throw new HttpError(400, exc.message);
        throw exc;
      }
      state.metadata.ensure(name, {
        workspaceId: runReq.workspace_id,
        events: userMessageEvent(rawTask),
      });
      return {
        session: name,
        events: result.messages,
        decision: result.decision,
        errors: result.errors,
      };
    }),
  );

  routes.push(
    compileRoute("GET", "/api/stream", (ctx) => {
      const session = ctx.query.get("session");
      if (!session) throw new HttpError(400, "invalid request body");
      const store = storeFor(sessionFileName(session));
      if (!store.exists()) throw new HttpError(404, "not found");
      ctx.res.writeHead(200, SSE_HEADERS);
      let sent = 0;
      let closed = false;
      ctx.req.on("close", () => {
        closed = true;
        ctx.res.end();
      });
      const replay = (): void => {
        let events: unknown[] = [];
        try {
          events = store.exists() ? store.load() : [];
        } catch {
          events = []; // mid-write line; retry next tick
        }
        for (const event of events.slice(sent)) {
          sent += 1;
          ctx.res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      };
      replay();
      const timer = setInterval(() => {
        if (closed) {
          clearInterval(timer);
          return;
        }
        replay();
        ctx.res.write(": keepalive\n\n");
      }, 500);
      return HANDLED;
    }),
  );

  // -- routes: workspaces ------------------------------------------------------

  routes.push(
    compileRoute("GET", "/api/workspaces", () => {
      return state.workspaces.list();
    }),
  );

  routes.push(
    compileRoute("GET", "/api/workspaces/{id}/files", (ctx) => {
      const registered = state.workspaces.get(ctx.params.id);
      if (registered === null) throw new HttpError(404, "not found");
      const query = (ctx.query.get("q") ?? "").trim();
      const limit = fileSearchLimit(ctx.query.get("limit"));
      // Fail-soft bounded walk: a missing/unreadable workspace directory is an
      // empty index, never an error. `searchWorkspaceFiles` ranks basename
      // tiers first, then the full path; `total` counts matches before the page.
      const index = indexWorkspaceFiles(registered.path);
      const files = searchWorkspaceFiles(index.files, query, { limit });
      const total = countWorkspaceFileMatches(index.files, query);
      return {
        workspace_id: registered.id,
        files,
        truncated: index.truncated || files.length < total,
        total,
      };
    }),
  );

  routes.push(
    compileRoute("POST", "/api/workspaces", async (ctx) => {
      const body = await ctx.json();
      const pathname = optionalString(body, "path");
      if (pathname === undefined) throw invalidBody();
      const name = optionalString(body, "name");
      let created: RegisteredWorkspace;
      try {
        created = state.workspaces.add(pathname, name);
      } catch (exc) {
        if (exc instanceof WorkspaceError) throw new HttpError(400, exc.message);
        throw exc;
      }
      return new Respond(201, created);
    }),
  );

  routes.push(
    compileRoute("PUT", "/api/workspaces/order", async (ctx) => {
      const body = await ctx.json();
      const ids = body.ids;
      if (!Array.isArray(ids)) throw new HttpError(400, "ids must be an array");
      if (ids.some((id) => typeof id !== "string")) {
        throw new HttpError(400, "ids must be an array of strings");
      }
      let ordered: RegisteredWorkspace[];
      try {
        ordered = state.workspaces.reorder(ids as string[]);
      } catch (exc) {
        if (exc instanceof WorkspaceError) throw new HttpError(400, exc.message);
        throw exc;
      }
      return { workspaces: ordered };
    }),
  );

  routes.push(
    compileRoute("PATCH", "/api/workspaces/{id}", async (ctx) => {
      // 404 first (house style, like PATCH /api/sessions/{name}): a rename
      // target that no longer exists is "not found" regardless of the body.
      if (!state.workspaces.get(ctx.params.id)) throw new HttpError(404, "not found");
      const body = await ctx.json();
      const name = optionalString(body, "name");
      if (name === undefined || !name.trim()) {
        throw new HttpError(400, "name must not be empty");
      }
      // The registry trims and caps the name (120 chars); a long name is
      // stored truncated and the stored value comes back in the 200 body.
      try {
        return state.workspaces.rename(ctx.params.id, name);
      } catch (exc) {
        if (exc instanceof WorkspaceError) throw new HttpError(400, exc.message);
        throw exc;
      }
    }),
  );

  routes.push(
    compileRoute("DELETE", "/api/workspaces/{id}", (ctx) => {
      if (!state.workspaces.remove(ctx.params.id)) throw new HttpError(404, "not found");
      return { removed: ctx.params.id };
    }),
  );

  // -- routes: session metadata ------------------------------------------------

  routes.push(
    compileRoute("POST", "/api/sessions", async (ctx) => {
      const body = await ctx.json();
      const title = optionalString(body, "title");
      const workspaceId = optionalString(body, "workspace_id");
      if (workspaceId) ensureWorkspace(workspaceId);
      const name = newSessionName();
      const projectPath = workspaceId
        ? (state.workspaces.get(workspaceId)?.path ?? null)
        : null;
      const store = materializeStore(name, projectPath);
      fs.writeFileSync(store.path, "");
      const meta = state.metadata.save(name, {
        title,
        workspaceId,
        events: userMessageEvent(title ?? ""),
      });
      return new Respond(201, { name, ...meta });
    }),
  );

  routes.push(
    compileRoute("PATCH", "/api/sessions/{name}", async (ctx) => {
      const name = sessionFileName(ctx.params.name);
      const store = storeFor(name);
      if (!store.exists()) throw new HttpError(404, "not found");
      const body = await ctx.json();
      const title = optionalString(body, "title");
      if (title === undefined || !title.trim()) {
        throw new HttpError(400, "title must not be empty");
      }
      const meta = state.metadata.save(name, { title });
      return { name, ...meta };
    }),
  );

  /**
   * Fork by copy (wave 23): `{seq?, name?}` writes a NEW session file holding
   * the source's first `seq` envelopes (default: all). Only a quiescent
   * session can be forked (same live-run/manual-compaction guard as
   * `/compact`), so the copied prefix is stable. A typed `SessionForkError`
   * maps to its honest status; the source is never modified and `forkSession`
   * rolls the new JSONL back on a metadata write failure.
   */
  routes.push(
    compileRoute("POST", "/api/sessions/{name}/fork", async (ctx) => {
      const name = sessionFileName(ctx.params.name);
      const store = storeFor(name);
      if (!store.exists()) throw new HttpError(404, "not found");
      const body = await ctx.json();
      assertSessionQuiescent(name, "fork");
      const forkOptions = {
        ...(body.seq === undefined ? {} : { atSeq: body.seq as number }),
        ...(body.name === undefined ? {} : { name: body.name as string }),
      };
      let result;
      try {
        result = forkSession(sessionsDir, name, forkOptions);
      } catch (exc) {
        if (exc instanceof SessionForkError) {
          throw new HttpError(forkErrorStatus(exc), exc.message);
        }
        throw exc;
      }
      return new Respond(201, result);
    }),
  );

  routes.push(
    compileRoute("POST", "/api/sessions/{name}/compact", async (ctx) => {
      const name = sessionFileName(ctx.params.name);
      const store = storeFor(name);
      if (!store.exists()) throw new HttpError(404, "not found");
      // Keep the initial state check: a queued/running/waiting run owns the
      // context and would append to (or rewrite) the same session file.
      const live = state.runs.list().some(
        (record) => record.session === name && ACTIVE_STATES.has(String(record.status)),
      );
      if (live) {
        throw new HttpError(409, "a run is active for this session; stop it before compacting");
      }
      // Serialize against run admission and other compactions: reserve the
      // session SYNCHRONOUSLY (no await since the check above) before the first
      // async step. Run admission reads the same set, so no run can be accepted
      // between this check and the JSONL rewrite below; the reservation is
      // released in the `finally` on every path.
      if (state.compactions.has(name)) {
        throw new HttpError(409, "another compaction is already running for this session");
      }
      // A client disconnect aborts the summarizer. The response's `close` fires
      // only once the response completes or the connection drops; the listener
      // is removed in the `finally` before the handler returns, so a normal
      // completion never aborts an already-finished compaction.
      const abort = new AbortController();
      const onResponseClose = (): void => {
        abort.abort();
      };
      state.compactions.add(name);
      try {
        ctx.res.once("close", onResponseClose);
        // Load exactly like a resumed run, then summarise through the same
        // provider construction a run uses. `compactContext` rewrites the store
        // only when it actually compacted (temp file + rename, dense `seq`, JSONL
        // shape untouched), so any failure leaves the session byte-identical.
        // A corrupt/unreadable JSONL is a stable 4xx with no path leaked.
        let context: SharedContext;
        try {
          context = restoreContext(store);
        } catch {
          throw new HttpError(422, "session file cannot be read; it may be corrupt");
        }
        let settings: CompactionSettings;
        let provider: Provider;
        try {
          const { cfg, endpoints } = buildCfg({ task: "compact" });
          settings = manualCompactionSettings(cfg, presetContextWindow(endpoints));
          provider = summarizerProvider(cfg, endpoints, settings.summarizerRole ?? "senior");
        } catch (exc) {
          if (exc instanceof HttpError) throw exc;
          throw new HttpError(502, errorDetail(exc));
        }
        const before = context.events.length;
        let compacted: boolean;
        try {
          compacted = await compactContext(context, provider, settings, abort.signal);
        } catch (exc) {
          // An operator disconnect is not a provider failure. The client is
          // gone, so the status is only for logs/tests; the reservation still
          // releases through the `finally`.
          if (abort.signal.aborted) {
            throw new HttpError(499, "compaction aborted by the client");
          }
          throw new HttpError(502, errorDetail(exc));
        }
        if (!compacted) return { compacted: false, reason: "nothing to compact" };
        return { compacted: true, before_events: before, after_events: context.events.length };
      } finally {
        ctx.res.off("close", onResponseClose);
        state.compactions.delete(name);
      }
    }),
  );

  /**
   * Rewind (wave 23): drop the last `turns` operator turns (`{turns}` strict
   * 1..100) from one quiescent session. Only a session with no queued/running/
   * waiting run and no manual compaction is rewound, and the write takes the
   * same `state.compactions` reservation the compact route uses, so run
   * admission and the rewrite cannot interleave. A size+mtime+inode CAS is
   * taken around the read: a file that changed between the load and the rewrite
   * (a second `serve`/CLI sharing the directory) is an honest 409 "session
   * changed; retry" and nothing is written. The helper's rewrite is atomic
   * (temp + rename) and keeps the kept prefix's dense `seq`, so resume works;
   * a cut that removes nothing is a 200 with `rewritten: false` and an honest
   * `reason`. A successful rewrite also clears the session's runtime-event
   * sidecar (`state.runtimeEvents.delete`): tool/approval history for the
   * removed runs is gone, while the transcript (the kept envelopes) remains;
   * the response says whether the sidecar was cleared. A corrupt file is 422
   * before any rewrite and a failed rewrite is 500.
   */
  routes.push(
    compileRoute("POST", "/api/sessions/{name}/rewind", async (ctx) => {
      const name = sessionFileName(ctx.params.name);
      const store = storeFor(name);
      if (!store.exists()) throw new HttpError(404, "not found");
      // Capture the file identity BEFORE the body upload: a session rewritten
      // by another process while the request was in flight is stale, even if
      // it settles before our synchronous read below.
      const initialSignature = sessionFileSignature(store.path);
      const body = await ctx.json();
      const parsed = validateRewindTurns(body.turns);
      if (!parsed.ok) throw new HttpError(400, parsed.error);
      assertSessionQuiescent(name, "rewind");
      // Serialize the synchronous read+rewrite against run admission and other
      // session mutations exactly like the compact route (released in finally).
      if (state.compactions.has(name)) {
        throw new HttpError(409, "a compaction is in progress for this session; retry in a moment");
      }
      state.compactions.add(name);
      try {
        const before = sessionFileSignature(store.path);
        if (initialSignature === null || before !== initialSignature) {
          throw new HttpError(409, "session changed while rewinding; retry");
        }
        let events;
        try {
          events = store.loadStrict();
        } catch {
          throw new HttpError(422, "session file cannot be read; it may be corrupt");
        }
        // Read-side CAS: compute the planned cut, then re-stat. A mismatch
        // means another process touched the file between our load and the
        // helper's reload below; refuse instead of rewriting a stale read.
        computeRewindCut(events, parsed.turns);
        const after = sessionFileSignature(store.path);
        if (before === null || after !== before) {
          throw new HttpError(409, "session changed while rewinding; retry");
        }
        let result;
        try {
          result = rewindSession(store, parsed.turns);
        } catch (exc) {
          if (exc instanceof SessionError) {
            throw new HttpError(500, "cannot rewrite the session file");
          }
          throw exc;
        }
        // The transcript rewrite and the sidecar clear are one operator action:
        // stale runtime evidence for removed runs must not survive it. A clear
        // failure is disclosed in the response instead of pretending success.
        let runtimeEventsCleared = false;
        let runtimeEventsClearError: string | null = null;
        if (result.rewritten) {
          try {
            runtimeEventsCleared = state.runtimeEvents.delete(name);
          } catch (exc) {
            runtimeEventsClearError = errorDetail(exc);
          }
        }
        const cut = result.cut;
        return {
          name,
          rewritten: result.rewritten,
          kept: cut.keptCount,
          removed: cut.removedCount,
          turns: cut.turns,
          requested_turns: cut.requestedTurns,
          stopped_at_compaction: cut.stoppedAtCompaction,
          stops_before: cut.stopsBefore,
          reason: cut.reason,
          runtime_events_cleared: runtimeEventsCleared,
          ...(runtimeEventsClearError === null
            ? {}
            : { runtime_events_clear_error: runtimeEventsClearError }),
        };
      } finally {
        state.compactions.delete(name);
      }
    }),
  );

  routes.push(
    compileRoute("DELETE", "/api/sessions/{name}", async (ctx) => {
      // Deleting a session clears its persisted approvals; refuse up front on
      // a future-version settings document instead of stopping runs first.
      requireWritableSettings();
      const safe = sessionFileName(ctx.params.name);
      const store = storeFor(safe);
      let isFile = false;
      try {
        isFile = fs.statSync(store.path).isFile();
      } catch {
        isFile = false;
      }
      if (!isFile) throw new HttpError(404, "not found");
      // A live run keeps its SessionStore handle and would re-append the next
      // envelope, resurrecting the file — stop it and let it unwind first.
      const activeFor = (): Array<Record<string, unknown>> =>
        state.runs.list().filter(
          (record) =>
            record.session === safe &&
            typeof record.status === "string" &&
            ACTIVE_STATES.has(record.status),
        );
      for (const record of activeFor()) state.runs.stop(String(record.run_id));
      const deadline = Date.now() + 2500;
      while (activeFor().length > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      // Persisted session allows must not outlive the session they were
      // granted for. Clear them before the file disappears: a failed write
      // leaves the session in place rather than a deleted session whose auto-
      // allows could apply again if the name were reused.
      try {
        state.settingsStore.clearSessionApprovals(safe);
      } catch (exc) {
        if (exc instanceof SettingsSchemaVersionError) throw exc;
        throw new HttpError(500, `could not clear the session approvals: ${errorDetail(exc)}`);
      }
      fs.unlinkSync(store.path);
      state.metadata.delete(safe);
      state.runtimeEvents.delete(safe);
      // A directory-layout session owns its directory; remove it when empty so
      // the name is fully released. `resolveForWrite` also finds the now-empty
      // directory after the artifacts were unlinked.
      const location = layout.resolveForWrite(safe);
      if (location?.dir) {
        try {
          fs.rmdirSync(location.dir);
        } catch {
          // not empty (unexpected extra file) or already gone
        }
      }
      return { deleted: safe };
    }),
  );

  // -- routes: settings ----------------------------------------------------------

  routes.push(
    compileRoute("GET", "/api/settings", () => {
      // plugin names only — nothing secret leaves the backend. The additive
      // `approval_policy` section reports the effective mode and whether a
      // serve flag/env pin overrides the persisted one; `compaction` reports
      // each budget's stored/effective value and its source.
      return {
        ...state.settings.public(),
        plugins: [...state.pluginSelection],
        approval_policy: approvalPolicyView(),
        compaction: compactionView(),
        // Additive schema state: a legacy file reports version null, a current
        // one 1, and a document from a newer release keeps reads working while
        // writable is false (writes then answer 409).
        schema: state.settingsStore.schemaState(),
      };
    }),
  );

  routes.push(
    compileRoute("PUT", "/api/settings", async (ctx) => {
      requireWritableSettings();
      const body = await ctx.json();
      // Validate everything before mutating: a 400 must not leave a
      // half-applied update behind (the TS RuntimeSettings persists on
      // update, Python persisted only at the end of the handler). Refs may
      // point at a stored preset or a seeded one (seeds are always known).
      const knownPresets = new Set(mergedPresets().map((p) => p.name));
      for (const role of ROLES) {
        const patch = body[role];
        if (!isRecord(patch)) continue;
        const ref = patch.provider_ref;
        if (typeof ref === "string" && ref && !knownPresets.has(ref)) {
          throw new HttpError(400, `unknown provider preset: ${ref}`);
        }
      }
      let pluginsPatch: PluginSelection | null = null;
      if (body.plugins !== undefined && body.plugins !== null) {
        // shared list (current) or legacy per-role object (merged); may 400
        pluginsPatch = cleanPluginSelection(body.plugins);
      }
      // Additive approval policy section: strict enum, validated before any
      // mutation. Absent leaves the persisted mode untouched. Both fields are
      // required: an unknown mode is a 400, never a silently weaker mode.
      let approvalPatch: ApprovalMode | null = null;
      if (body.approval_policy !== undefined) {
        if (!isRecord(body.approval_policy)) {
          throw new HttpError(400, "approval_policy must be an object with a mode");
        }
        const mode = normalizeApprovalMode(body.approval_policy.mode);
        if (mode === null) {
          throw new HttpError(
            400,
            `invalid approval mode: ${String(body.approval_policy.mode)} ` +
              `(use ${APPROVAL_MODES.join("|")})`,
          );
        }
        approvalPatch = mode;
      }
      // Additive run-level compaction section: strict integer budgets >= 0,
      // validated before any mutation. An absent section leaves the stored
      // budgets untouched; a present one replaces them wholesale.
      let compactionPatch: PersistedCompactionSettings | null = null;
      if (body.compaction !== undefined) {
        try {
          compactionPatch = strictCompactionSettings(body.compaction);
        } catch (exc) {
          throw new HttpError(400, errorDetail(exc));
        }
      }
      let updated: PublicRuntimeSettings;
      try {
        updated = state.settings.update(body);
      } catch (exc) {
        if (exc instanceof SettingsSchemaVersionError) throw exc;
        throw new HttpError(400, errorDetail(exc));
      }
      if (pluginsPatch !== null) {
        // Saves replace the stored list; the deprecated per-role env aliases
        // are an overlay on top and stay out of the file, like other
        // `TWO_BROTHERS_*` env values.
        savedPluginSelection = [...pluginsPatch];
        const effective = [...savedPluginSelection];
        addPluginNames(effective, envPluginNames());
        state.pluginSelection = effective;
        // Per-plugin options travel inside `{path, options}` entries: hand
        // the new selection to the manager before the (re)import so load-time
        // options apply, then (re)import per design (serialized with the
        // startup load by the manager's reload chain).
        state.plugins.setSettings(effective);
        await state.plugins.reload();
      }
      // Persist the plugin selection; role settings were already persisted by
      // RuntimeSettings.update (env-pinned fields stripped by the store).
      // Writing the list shape also drops any legacy per-role keys on disk.
      state.settingsStore.write(state.settings.snapshot(), savedPluginSelection);
      if (approvalPatch !== null) {
        // Persist AFTER the role/plugin save: that write preserves an existing
        // `approval_policy` section, and the policy write then reads it back
        // so every other section survives. A failed write is a 500 (the
        // response never claims a mode settings.json does not carry).
        try {
          state.settingsStore.writeApprovalPolicy(approvalPatch);
        } catch (exc) {
          if (exc instanceof SettingsSchemaVersionError) throw exc;
          throw new HttpError(500, `could not persist the approval policy: ${errorDetail(exc)}`);
        }
      }
      if (compactionPatch !== null) {
        // Same after-the-save rule for the compaction budgets: the store write
        // above preserves the section and this strict write replaces it. A
        // failed write is a 500 (the response never claims budgets the file
        // does not carry).
        try {
          state.settingsStore.writeCompaction(compactionPatch);
        } catch (exc) {
          if (exc instanceof SettingsSchemaVersionError) throw exc;
          throw new HttpError(500, `could not persist the compaction settings: ${errorDetail(exc)}`);
        }
      }
      return {
        ...updated,
        plugins: [...state.pluginSelection],
        approval_policy: approvalPolicyView(),
        compaction: compactionView(),
      };
    }),
  );

  routes.push(
    compileRoute("GET", "/api/plugins", async () => {
      await state.pluginsReady;
      const view = state.plugins.describe();
      // Additive diagnostics: load-time notes (deprecations, rejected
      // options) plus the last run's binding notes. Omitted when empty, so
      // the shipped `{plugins, errors}` fields stay byte-compatible.
      const diagnostics = [
        ...state.plugins.diagnostics.map((entry) => `${entry.plugin}: ${entry.message}`),
        ...state.pluginDiagnostics,
      ];
      return diagnostics.length > 0 ? { ...view, diagnostics } : view;
    }),
  );

  // -- routes: skills -------------------------------------------------------------

  routes.push(
    compileRoute("GET", "/api/skills", () => {
      // Metadata only — the skill bodies stay out of the response; they are
      // injected on demand (`renderSkillBody`) and never echoed wholesale.
      const catalog = skillCatalog();
      return {
        skills: catalog.skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          scope: skill.scope,
          tools: [...skill.tools],
          file: skill.file,
        })),
        diagnostics: [...catalog.diagnostics],
      };
    }),
  );

  // -- routes: slash commands -----------------------------------------------------

  routes.push(
    compileRoute("GET", "/api/commands", () => {
      // Metadata only — the template bodies stay out of the response; the
      // REPL expands one on demand (`expandCommand`). `baseCommands` is the
      // additive first-party catalogue (also present with no command roots):
      // prompt commands expand on submission, action commands are performed by
      // a surface and are a 400 when submitted as a task.
      const catalog = commandCatalog();
      return {
        commands: catalog.commands.map((command) => ({
          name: command.name,
          description: command.description,
          argumentHint: command.argumentHint,
          ...(command.mode ? { mode: command.mode } : {}),
          file: command.file,
        })),
        baseCommands: baseCommandMetadata(),
        diagnostics: [...catalog.diagnostics],
      };
    }),
  );

  // -- routes: provider presets (Stage 17) ----------------------------------------

  routes.push(
    compileRoute("GET", "/api/providers", () => {
      // Seeds first (display order), stored presets layered on top by name.
      // Additive `seed`/`customized` flags (old clients ignore them) let a
      // master-detail UI distinguish the four row states:
      // - seed: the name exists in the built-in seed table (case-insensitive,
      //   the same lookup `presetById`/`mergeSeedPresets` use);
      // - customized: a stored preset with that name exists — a PUT-created
      //   override of a seed, or a POST-created custom provider.
      const storedNames = new Set(
        state.settingsStore
          .readProviders()
          .map((preset) => preset.name.trim().toLowerCase()),
      );
      return {
        providers: mergedPresets().map((preset) => ({
          ...publicPreset(preset),
          seed: isSeedPresetName(preset.name),
          customized: storedNames.has(preset.name.trim().toLowerCase()),
        })),
      };
    }),
  );

  routes.push(
    compileRoute("POST", "/api/providers", async (ctx) => {
      requireWritableSettings();
      const body = await ctx.json();
      if (typeof body.name !== "string" || typeof body.base_url !== "string") throw invalidBody();
      const name = body.name.trim();
      const baseUrl = body.base_url.trim();
      if (!name || !baseUrl) {
        throw new HttpError(400, "name and base_url must not be empty");
      }
      const apiKey = optionalString(body, "api_key");
      const kind = optionalString(body, "kind") ?? PROVIDER_KIND_DEFAULT;
      const models = cleanModelList(body.models);
      const contextWindow = providerContextWindowPatch(body);
      const presets = state.settingsStore.readProviders();
      // Duplicates against the merged view: a seeded name is customized with
      // PUT (which materializes a stored override), not created twice.
      if (mergedPresets().some((p) => p.name.toLowerCase() === name.toLowerCase())) {
        throw new HttpError(409, `provider already exists: ${name}`);
      }
      presets.push({
        name,
        base_url: baseUrl,
        api_key: apiKey ?? "",
        kind,
        models,
        ...(contextWindow !== undefined && contextWindow > 0 ? { context_window: contextWindow } : {}),
      });
      state.settingsStore.write(state.settings.snapshot(), undefined, presets);
      return new Respond(201, { provider: publicProvider(presets[presets.length - 1]) });
    }),
  );

  routes.push(
    compileRoute("PUT", "/api/providers/{name}", async (ctx) => {
      requireWritableSettings();
      const body = await ctx.json();
      const presets = state.settingsStore.readProviders();
      let index = presets.findIndex(
        (p) => p.name.toLowerCase() === ctx.params.name.toLowerCase(),
      );
      if (index === -1) {
        // A seed is a read-only default: editing one materializes a stored
        // override from the seed, so later reads merge it back in place. The
        // seed's literal key is empty; an env-backed seed keeps working
        // because `mergedPresets` re-attaches its `api_key_env` while the
        // stored override carries no key of its own.
        const seed = mergedPresets().find(
          (p) => p.name.toLowerCase() === ctx.params.name.toLowerCase(),
        );
        if (seed === undefined) throw new HttpError(404, "not found");
        presets.push({
          name: seed.name,
          base_url: seed.base_url,
          api_key: seed.api_key,
          kind: seed.kind,
          models: [...seed.models],
          ...(typeof seed.context_window === "number" && seed.context_window > 0
            ? { context_window: seed.context_window }
            : {}),
        });
        index = presets.length - 1;
      }
      if ("base_url" in body && body.base_url !== undefined && body.base_url !== null) {
        if (typeof body.base_url !== "string") throw invalidBody();
        const baseUrl = body.base_url.trim();
        if (!baseUrl) throw new HttpError(400, "base_url must not be empty");
        presets[index].base_url = baseUrl;
      }
      const apiKey = optionalString(body, "api_key");
      if (apiKey) {
        // omitted or empty keeps the stored key — responses never echo key
        // material, so the form cannot resend it
        presets[index].api_key = apiKey;
      }
      if ("kind" in body && body.kind !== undefined && body.kind !== null) {
        if (typeof body.kind !== "string") throw invalidBody();
        presets[index].kind = body.kind || PROVIDER_KIND_DEFAULT;
      }
      if ("models" in body && body.models !== undefined && body.models !== null) {
        presets[index].models = cleanModelList(body.models);
      }
      const contextWindow = providerContextWindowPatch(body);
      if (contextWindow !== undefined) {
        // 0 clears the preset window (unknown); a positive value overrides it.
        if (contextWindow > 0) presets[index].context_window = contextWindow;
        else delete presets[index].context_window;
      }
      state.settingsStore.write(state.settings.snapshot(), undefined, presets);
      // The response mirrors GET's merged view: a seed override keeps its
      // seed's env-backed key status (never the key itself).
      const savedName = presets[index].name.toLowerCase();
      const merged = mergedPresets().find((p) => p.name.toLowerCase() === savedName);
      return { provider: merged !== undefined ? publicPreset(merged) : publicProvider(presets[index]) };
    }),
  );

  routes.push(
    compileRoute("POST", "/api/providers/{name}/reset", (ctx) => {
      requireWritableSettings();
      const seed = presetById(ctx.params.name);
      const presets = state.settingsStore.readProviders();
      if (seed === undefined) {
        if (presets.some((p) => p.name.toLowerCase() === ctx.params.name.toLowerCase())) {
          throw new HttpError(400, `only built-in provider presets can be reset: ${ctx.params.name}`);
        }
        throw new HttpError(404, "not found");
      }
      const folded = seed.name.toLowerCase();
      const remaining = presets.filter((preset) => preset.name.toLowerCase() !== folded);
      if (remaining.length === presets.length) {
        throw new HttpError(409, `provider is not customized: ${seed.name}`);
      }
      // Reset only the stored override. Role provider_ref values, plugins and
      // unrelated stored providers stay intact; the canonical seed is never
      // persisted and returns to its stable position in the merged view.
      state.settingsStore.write(state.settings.snapshot(), undefined, remaining);
      return {
        provider: {
          ...publicPreset(seed),
          seed: true,
          customized: false,
        },
      };
    }),
  );

  routes.push(
    compileRoute("DELETE", "/api/providers/{name}", (ctx) => {
      requireWritableSettings();
      const presets = state.settingsStore.readProviders();
      const remaining = presets.filter((p) => p.name.toLowerCase() !== ctx.params.name.toLowerCase());
      if (remaining.length === presets.length) throw new HttpError(404, "not found");
      // No dangling refs: roles pointing at the deleted preset are cleared
      // in memory and persisted.
      for (const role of ROLES) {
        const snapshot = state.settings.snapshot();
        if ((snapshot[role].provider_ref ?? "").toLowerCase() === ctx.params.name.toLowerCase()) {
          state.settings.update({ [role]: { provider_ref: "" } });
        }
      }
      state.settingsStore.write(state.settings.snapshot(), undefined, remaining);
      return { removed: ctx.params.name };
    }),
  );

  routes.push(
    compileRoute("POST", "/api/providers/{name}/discover", async (ctx) => {
      // Manual, explicit discovery probe — deliberately separate from Apply
      // (`PUT /api/providers/{name}`): it writes nothing (no settings.json, no
      // run state), so a failed or unwanted probe cannot corrupt the catalog.
      // The body is the CURRENT unsaved draft, so the operator can probe a
      // typed base URL / kind before saving. The merge reads seeds too, so a
      // built-in preset works without being customized first (case-insensitive,
      // like every other provider route).
      const body = await ctx.json();
      const wanted = ctx.params.name.trim().toLowerCase();
      const preset = mergedPresets().find(
        (entry) => entry.name.trim().toLowerCase() === wanted,
      );
      if (preset === undefined) throw new HttpError(404, "not found");
      const draftBaseUrl = optionalString(body, "base_url");
      const baseUrl = (draftBaseUrl ?? preset.base_url).trim();
      if (!baseUrl) throw new HttpError(400, "base_url must not be empty");
      if (!/^https?:\/\//i.test(baseUrl)) {
        throw new HttpError(400, "base_url must start with http:// or https://");
      }
      const draftKind = optionalString(body, "kind");
      const kind = (draftKind ?? "").trim() || preset.kind || PROVIDER_KIND_DEFAULT;
      if (!isProviderKind(kind)) {
        throw new HttpError(400, `unknown provider kind: ${kind} (use ${PROVIDER_KIND_HINT})`);
      }
      if (kind !== PROVIDER_KIND_DEFAULT) {
        // Honest about the wire families: only the OpenAI-compatible adapter
        // speaks `GET {base}/models`; the native Messages / Generative
        // Language APIs are not probed through their own listing shapes here.
        throw new HttpError(
          400,
          `model discovery is not supported for the ${kind} provider kind (use ${PROVIDER_KIND_HINT}); list models by hand or use two-brothers models with an OpenAI-compatible endpoint`,
        );
      }
      // Secret handling: a typed key is an explicit one-shot override that may
      // point anywhere; the preset's stored/env-backed key is only attached when
      // the probed endpoint IS that preset's own endpoint (trimmed, trailing
      // slashes ignored). A different endpoint with a saved secret and no typed
      // key is refused before any request — the secret must never be sent
      // elsewhere. Keyless presets (local endpoints) still probe their draft
      // URL unauthenticated. Either way the key never leaves as a value,
      // `listModels` only puts it in a request header, and neither this response
      // nor an error message echoes it.
      const typedApiKey = optionalString(body, "api_key")?.trim();
      const storedApiKey = presetApiKey(preset);
      const sameEndpoint =
        baseUrl.replace(/\/+$/, "") === preset.base_url.trim().replace(/\/+$/, "");
      if (!typedApiKey && !sameEndpoint && storedApiKey) {
        throw new HttpError(
          400,
          "a typed API key is required when probing a different base URL",
        );
      }
      const probeKey = typedApiKey ? typedApiKey : sameEndpoint ? storedApiKey : "";
      let models: RemoteModel[];
      try {
        models = await listModels(baseUrl, { apiKey: probeKey || undefined });
      } catch (exc) {
        throw new HttpError(502, `model discovery failed: ${errorDetail(exc)}`);
      }
      // Empty is a valid answer (`models: []`); the client must not erase a
      // catalog on it. `base_url`/`kind` are additive echoes so a client can
      // show what was actually probed.
      return { models, base_url: baseUrl, kind };
    }),
  );

  // -- routes: folder explorer (Stage 17) ------------------------------------------

  function driveRoots(): Array<{ name: string; path: string }> {
    // Mounted Windows drive letters as browse entries (empty elsewhere).
    const roots: Array<{ name: string; path: string }> = [];
    for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      const drive = `${letter}:\\`;
      if (fs.existsSync(drive)) roots.push({ name: drive, path: drive });
    }
    return roots;
  }

  routes.push(
    compileRoute("GET", "/api/fs/browse", (ctx) => {
      const raw = ctx.query.get("path") ?? "";
      let target: string;
      if (!raw) {
        if (process.platform === "win32") {
          return { path: "", parent: null, entries: driveRoots(), truncated: false };
        }
        target = process.cwd();
      } else {
        target = path.resolve(raw);
      }
      let isDir = false;
      try {
        isDir = fs.statSync(target).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) throw new HttpError(400, "not a directory");
      let children: fs.Dirent[];
      try {
        children = fs.readdirSync(target, { withFileTypes: true });
      } catch {
        // vanished (or denied) between the is_dir check and the listing
        if (!fs.existsSync(target)) throw new HttpError(400, "not a directory");
        children = [];
      }
      const dirs: string[] = [];
      for (const child of children) {
        try {
          if (child.isDirectory()) dirs.push(child.name);
        } catch {
          // unreadable entry — skip silently
        }
      }
      dirs.sort((a, b) => {
        const la = a.toLowerCase();
        const lb = b.toLowerCase();
        return la < lb ? -1 : la > lb ? 1 : 0;
      });
      const truncated = dirs.length > FS_BROWSE_LIMIT;
      const page = truncated ? dirs.slice(0, FS_BROWSE_LIMIT) : dirs;
      const parent = path.dirname(target);
      return {
        path: target,
        parent: parent === target ? null : parent,
        entries: page.map((name) => ({ name, path: path.join(target, name) })),
        truncated,
      };
    }),
  );

  // -- routes: background runs ------------------------------------------------------

  routes.push(
    compileRoute("POST", "/api/runs", async (ctx) => {
      const req = parseRunRequestStrict(await ctx.json());
      // A session created under a workspace keeps that link for its runs: the
      // request may omit `workspace_id` (the web composer sends null when its
      // sidebar filter is "all"), and without this fallback the run receives
      // no workspace tools and refuses `@file` mentions. An explicit value
      // still wins; either way the id must name a registered workspace.
      const name = sessionName(req.session);
      const linked = req.workspace_id === undefined ? linkedSessionWorkspace(name) : null;
      const baseReq: RunRequestData =
        linked === null ? req : { ...req, workspace_id: linked };
      ensureWorkspace(baseReq.workspace_id);
      // Prepare before creating anything: a slash/mention error must leave no
      // session and no run behind. A command `mode` overrides the request mode
      // for this run only (the persisted metadata title keeps the raw text).
      const prepared = await prepareSubmission(baseReq);
      const runReq: RunRequestData =
        prepared.modeOverride === undefined
          ? baseReq
          : { ...baseReq, mode: prepared.modeOverride };
      // The final, synchronous admission gate: a manual compaction must never
      // overlap a run submission (its JSONL rewrite would drop this run's
      // envelopes). Checked right before the run record exists — nothing has
      // been created for this request yet.
      assertNotCompacting(name);
      const broker = new RunApprovalBroker();
      // Seed the persisted "always allow for this session" pairs before the run
      // can reach a workspace tool; the job re-reads at start so a queued run
      // also sees allows granted while it waited.
      broker.seedSessionAllows(state.settingsStore.readSessionApprovals(name));
      // Materialize the session's directory before the run manager persists its
      // first runtime event, so every sidecar lands inside the project dir.
      materializeStore(
        name,
        baseReq.workspace_id
          ? (state.workspaces.get(baseReq.workspace_id)?.path ?? null)
          : null,
      );
      // The steering drain reads the run record that `submit` creates; the
      // back-reference is assigned synchronously before the worker can start
      // the job (dispatch resolves in a later microtask), so the closure is
      // never called with a null record. The undo capture uses the same
      // back-reference for its run id.
      let record: RunRecord | null = null;
      record = state.runs.submit(
        prepared.task,
        name,
        buildRunJob(
          prepared.task,
          name,
          runReq,
          broker,
          prepared.injections,
          () => record?.drainSteering() ?? [],
          () => record?.runId ?? null,
        ),
        effectiveMode(runReq),
        { streamTokens: req.stream_tokens === true },
      );
      record.approvals = broker;
      state.metadata.ensure(name, {
        workspaceId: baseReq.workspace_id,
        events: userMessageEvent(req.task),
      });
      return new Respond(202, { run_id: record.runId, session: name, status: record.status });
    }),
  );

  routes.push(
    compileRoute("GET", "/api/runs", (ctx) => {
      const session = ctx.query.get("session");
      const records = state.runs.list();
      // empty string (client sent `?session=`) means "all runs"
      if (!session) return records;
      return records.filter((r) => r.session === session);
    }),
  );

  routes.push(
    compileRoute("GET", "/api/runs/{run_id}", (ctx) => {
      const record = state.runs.get(ctx.params.run_id);
      if (record !== null) return record.public();
      // unknown to the in-memory pool: a backend restart may have dropped the
      // record, so fall back to the durable runtime sidecar
      const recovered = recoverRun(ctx.params.run_id);
      if (recovered === null) throw new HttpError(404, "not found");
      return recovered;
    }),
  );

  routes.push(
    compileRoute("POST", "/api/runs/{run_id}/stop", (ctx) => {
      const record = state.runs.stop(ctx.params.run_id);
      if (record === null) throw new HttpError(404, "not found");
      return { run_id: record.runId, status: record.status };
    }),
  );

  /**
   * Mid-run operator steering (wave 23): queue one text on an ACTIVE run
   * (running, or waiting on an approval — applied at the next node boundary /
   * tool-loop iteration after it resolves). The route validates the text and
   * maps the manager's outcome onto the fixed contract:
   * 200 `{run_id, status, pending}` when accepted; 400 for a non-string body
   * (invalid request body), empty text or text over `STEER_TEXT_MAX_CHARS`;
   * 404 for an unknown run; 409 when the run is queued/terminal or the pending
   * queue is full. The acceptance is the only immediate feedback — no SSE event
   * is faked here; consumers see the familiar `envelope` frame only when the
   * harness actually appends it.
   */
  routes.push(
    compileRoute("POST", "/api/runs/{run_id}/steer", async (ctx) => {
      const body = await ctx.json();
      if (typeof body.text !== "string") throw invalidBody();
      const text = body.text.trim();
      if (!text) throw new HttpError(400, "text must not be empty");
      if (text.length > STEER_TEXT_MAX_CHARS) {
        throw new HttpError(400, `text is too long (max ${STEER_TEXT_MAX_CHARS} chars)`);
      }
      const result = state.runs.steer(ctx.params.run_id, text);
      if (!result.accepted) {
        const record = result.record;
        if (result.reason === "unknown_run" || record === null) {
          throw new HttpError(404, "not found");
        }
        if (result.reason === "queue_full") {
          throw new HttpError(
            409,
            `steering queue is full (${result.pending} pending); retry after the run's next step`,
          );
        }
        if (result.reason === "invalid_text") throw new HttpError(400, "invalid steering text");
        // not_active: the run exists but has no cooperation cycle to steer —
        // say the real status instead of a generic "conflict".
        throw new HttpError(
          409,
          `run is ${record.status}; steering applies only to a running or approval-parked run`,
        );
      }
      const accepted = result.record;
      if (accepted === null) throw new HttpError(404, "not found");
      return { run_id: accepted.runId, status: accepted.status, pending: result.pending };
    }),
  );

  /**
   * Run-scoped workspace edit undo (wave 23): preview/apply/discard the file
   * mutations one workspace-bound run made. The store is persisted under
   * `<sessions>/undo`, so these routes are restart-resilient; the guards are
   * shared with `openUndoRequest` (unknown/invalid 404, unusable record or
   * active in-memory run 409, unexpected store IO 422) and the workspace root
   * is matched against the LIVE registry on every request (a record whose
   * workspace is no longer registered is an honest 409, never a blind restore).
   * Apply re-classifies each file immediately before touching it, so a file
   * changed after the preview is refused per file, never overwritten.
   */
  routes.push(
    compileRoute("GET", "/api/sessions/{name}/undo/{run_id}", (ctx) => {
      const name = sessionFileName(ctx.params.name);
      if (!storeFor(name).exists()) throw new HttpError(404, "not found");
      const { workspaceRoot } = openUndoRequest(name, ctx.params.run_id);
      let preview;
      try {
        preview = previewUndo(undoRoot, ctx.params.run_id, workspaceRoot);
      } catch (exc) {
        throw undoHttpError(exc);
      }
      return {
        session: name,
        run_id: ctx.params.run_id,
        statuses: preview.entries,
        counts: preview.counts,
        workspace_root: preview.workspace_root,
        created_at: preview.created_at,
        ...(preview.omitted !== undefined ? { omitted: preview.omitted } : {}),
      };
    }),
  );

  routes.push(
    compileRoute("POST", "/api/sessions/{name}/undo/{run_id}", (ctx) => {
      const name = sessionFileName(ctx.params.name);
      if (!storeFor(name).exists()) throw new HttpError(404, "not found");
      const { workspaceRoot } = openUndoRequest(name, ctx.params.run_id);
      let result;
      try {
        result = applyUndo(undoRoot, ctx.params.run_id, workspaceRoot);
      } catch (exc) {
        throw undoHttpError(exc);
      }
      const statusCount = (status: WorkspaceUndoStatus): number =>
        result.entries.filter((entry) => entry.preview_status === status).length;
      return {
        session: name,
        run_id: ctx.params.run_id,
        workspace_root: workspaceRoot,
        applied: result.applied,
        refused: result.refused,
        failed: result.failed,
        files: result.entries,
        counts: {
          applicable: statusCount("applicable"),
          created: statusCount("created"),
          deleted: statusCount("deleted"),
          changed_since: statusCount("changed-since"),
          skipped: statusCount("skipped"),
          missing: statusCount("missing"),
          total: result.entries.length,
        },
        ...(result.omitted !== undefined ? { omitted: result.omitted } : {}),
      };
    }),
  );

  routes.push(
    compileRoute("DELETE", "/api/sessions/{name}/undo/{run_id}", (ctx) => {
      const name = sessionFileName(ctx.params.name);
      if (!storeFor(name).exists()) throw new HttpError(404, "not found");
      // The record is read first so a URL that names another session's run id
      // is a 404 (same rule as preview/apply), never a cross-session delete.
      let record: WorkspaceUndoRecord;
      try {
        record = loadUndoRecord(undoRoot, ctx.params.run_id);
      } catch (exc) {
        throw undoHttpError(exc);
      }
      if (record.session !== undefined && record.session !== name) {
        throw new HttpError(404, "not found");
      }
      // Same active-run guard as preview/apply: a live run will keep mutating
      // files, and its capture still references the blobs this discard would
      // collect. Refuse instead of destroying undo state mid-run.
      const live = state.runs.get(ctx.params.run_id);
      if (live !== null && ACTIVE_STATES.has(live.status)) {
        throw new HttpError(
          409,
          `the run is still ${live.status}; stop it before discarding undo`,
        );
      }
      let removed: boolean;
      try {
        removed = discardUndo(undoRoot, ctx.params.run_id);
      } catch (exc) {
        throw undoHttpError(exc);
      }
      if (!removed) throw new HttpError(404, "not found");
      // Content-addressed blobs are shared store state: after the last record
      // reference is gone, collect the ones nothing retained points at. A
      // collection failure is disclosed additively and never fails the discard.
      const gc = collectOrphanBlobs(undoRoot);
      return {
        discarded: true,
        session: name,
        run_id: ctx.params.run_id,
        ...(gc.removed.length > 0 ? { blobs_removed: gc.removed.length } : {}),
        ...(gc.diagnostics.length > 0 ? { gc_diagnostics: gc.diagnostics } : {}),
      };
    }),
  );

  routes.push(
    compileRoute("GET", "/api/runs/{run_id}/approvals", (ctx) => {
      const record = state.runs.get(ctx.params.run_id);
      if (record === null) throw new HttpError(404, "not found");
      const broker = record.approvals as RunApprovalBroker | null;
      const pending =
        broker !== null && typeof broker.pending === "function" ? broker.pending() : [];
      return { run_id: record.runId, pending };
    }),
  );

  routes.push(
    compileRoute("POST", "/api/runs/{run_id}/approvals/{approval_id}", async (ctx) => {
      const body = await ctx.json();
      let allow = true; // pydantic default
      if (body.allow !== undefined && body.allow !== null) {
        if (typeof body.allow !== "boolean") throw invalidBody();
        allow = body.allow;
      }
      // Additive approval scope (strict string enum): "once" keeps the old
      // behavior for clients that omit it; "session" additionally persists the
      // pair so identical requests in this session auto-allow.
      let scope: "once" | "session" = "once";
      if (body.scope !== undefined && body.scope !== null) {
        if (body.scope !== "once" && body.scope !== "session") throw invalidBody();
        scope = body.scope;
      }
      if (scope === "session" && !allow) {
        throw new HttpError(400, "scope session requires allow");
      }
      const record = state.runs.get(ctx.params.run_id);
      if (record === null || record.approvals === null) throw new HttpError(404, "not found");
      const broker = record.approvals as RunApprovalBroker;
      if (scope === "session") {
        requireWritableSettings();
        if (
          typeof broker.sessionPairKey !== "function" ||
          typeof broker.allowForSession !== "function"
        ) {
          throw new HttpError(400, "session-scope approvals are not supported for this run");
        }
        // The pair must belong to a real pending request: an unknown or
        // already-answered id is a 404 and persists nothing.
        const pairKey = broker.sessionPairKey(ctx.params.approval_id);
        if (pairKey === null) {
          throw new HttpError(404, "unknown or already resolved approval");
        }
        // Persist FIRST. A failed settings write is a 500 and leaves the
        // request unanswered — never an in-memory auto-allow the operator
        // cannot see in settings.json.
        try {
          const stored = state.settingsStore.addSessionApproval(record.session, pairKey);
          if (!stored.includes(pairKey)) {
            // A pair that cannot be stored (e.g. an over-long shell command)
            // must not report a session scope the settings file does not carry;
            // the approval stays pending and the operator can answer once.
            throw new Error("the approval target cannot be stored for this session");
          }
        } catch (exc) {
          if (exc instanceof SettingsSchemaVersionError) throw exc;
          throw new HttpError(500, `could not persist the session approval: ${errorDetail(exc)}`);
        }
        const decision = broker.allowForSession(ctx.params.approval_id);
        if (decision === null) {
          throw new HttpError(404, "unknown or already resolved approval");
        }
        return { approval_id: ctx.params.approval_id, decision, scope: "session" };
      }
      const decision = broker.respond(
        ctx.params.approval_id,
        allow ? Decision.ALLOW : Decision.DENY,
      );
      if (decision === null) {
        throw new HttpError(404, "unknown or already resolved approval");
      }
      return { approval_id: ctx.params.approval_id, decision, scope: "once" };
    }),
  );

  routes.push(
    compileRoute("GET", "/api/runs/{run_id}/events", (ctx) => {
      const record = state.runs.get(ctx.params.run_id);
      if (record === null) throw new HttpError(404, "not found");
      let after = 0;
      const rawAfter = ctx.query.get("after");
      if (rawAfter !== null && rawAfter !== "") {
        after = Number.parseInt(rawAfter, 10);
        if (!Number.isFinite(after) || after < 0) throw invalidBody();
      }
      let sent = after;
      let closed = false;
      let unsubscribeTokens: (() => void) | null = null;
      ctx.req.on("close", () => {
        closed = true;
        unsubscribeTokens?.();
        ctx.res.end();
      });
      ctx.res.writeHead(200, SSE_HEADERS);
      // Live thinking/text deltas are ephemeral NAMED frames written straight
      // from the record's in-memory fan-out: no `id:` line, so the `?after`
      // cursor and the EventSource last-event-id stay on persisted typed
      // events. The record drops every listener at its terminal state; the
      // route also unsubscribes on request close and when the replay loop
      // ends. A token can never be written after `run_end` or a closed
      // response (both guarded here, and `finish()` closes the registry first).
      unsubscribeTokens = record.onLiveToken((event) => {
        if (closed || ctx.res.writableEnded) return;
        try {
          ctx.res.write(tokenSseFrame(record.runId, event));
        } catch {
          // the response was torn down between the guard and the write
        }
      });
      // The loop replays the buffered tail, keeps the connection alive with
      // comment frames, and closes once run_end has been delivered (the
      // client may reconnect with ?after=N).
      void (async () => {
        try {
          while (!closed) {
            while (sent < record.events.length) {
              sent += 1;
              ctx.res.write(`id: ${sent}\ndata: ${JSON.stringify(record.events[sent - 1])}\n\n`);
            }
            if (record.isDone && sent >= record.events.length) break;
            ctx.res.write(": keepalive\n\n");
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        } finally {
          unsubscribeTokens?.();
          ctx.res.end();
        }
      })().catch(() => {
        unsubscribeTokens?.();
        ctx.res.end();
      });
      return HANDLED;
    }),
  );

  // -- static web viewer (web/dist), if built --------------------------------------

  const webDistOption = options.webDist === undefined ? resolveDefaultWebDist() : options.webDist;
  const webDist = webDistOption !== null && fs.existsSync(webDistOption) ? webDistOption : null;

  const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".map": "application/json",
    ".txt": "text/plain; charset=utf-8",
  };

  function serveStaticFile(res: http.ServerResponse, filePath: string): boolean {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return false;
    }
    if (!stat.isFile()) return false;
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": stat.size,
    });
    fs.createReadStream(filePath).pipe(res);
    return true;
  }

  function handleStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): boolean {
    if (webDist === null || req.method !== "GET") return false;
    const index = path.join(webDist, "index.html");
    if (!fs.existsSync(index)) return false;
    if (pathname === "/") {
      serveStaticFile(res, index);
      return true;
    }
    const candidate = path.join(webDist, pathname.replace(/^\/+/, ""));
    if (pathname.startsWith("/assets/")) {
      if (serveStaticFile(res, candidate)) return true;
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ detail: "Not Found" }));
      return true;
    }
    if (serveStaticFile(res, candidate)) return true;
    // SPA fallback
    serveStaticFile(res, index);
    return true;
  }

  // -- dispatch --------------------------------------------------------------------

  const sseResponses = new Set<http.ServerResponse>();

  function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body === undefined ? null : body);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(payload);
  }

  function writeError(res: http.ServerResponse, exc: unknown): void {
    if (res.headersSent) {
      res.end();
      return;
    }
    // The client disconnected before the handler settled (e.g. an aborted
    // compaction): there is nobody to write to, and writing to a destroyed
    // response would turn the original error into a second failure.
    if (res.writableEnded || res.destroyed) return;
    if (exc instanceof HttpError) {
      writeJson(res, exc.status, { detail: exc.message });
      return;
    }
    if (exc instanceof WorkspaceError) {
      writeJson(res, 400, { detail: exc.message });
      return;
    }
    // A settings document written by a newer release is read-only for this
    // release: settings write routes answer 409, never a generic 500.
    if (exc instanceof SettingsSchemaVersionError) {
      writeJson(res, 409, { detail: exc.message });
      return;
    }
    writeJson(res, 500, { detail: errorDetail(exc) });
  }

  async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > BODY_LIMIT_BYTES) throw invalidBody();
      chunks.push(buf);
    }
    if (chunks.length === 0) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    } catch {
      throw invalidBody();
    }
    if (!isRecord(parsed)) throw invalidBody();
    return parsed;
  }

  const handler: http.RequestListener = (req, res) => {
    void (async () => {
      let pathname: string;
      let query: URLSearchParams;
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        pathname = url.pathname;
        query = url.searchParams;
      } catch {
        writeJson(res, 400, { detail: "invalid request body" });
        return;
      }
      const method = req.method ?? "GET";
      // Local-request guards (only while every binding is loopback — the
      // operator binding a routable address opts into that exposure, see
      // SECURITY.md):
      // - Host: rebinding an attacker-controlled DNS name to 127.0.0.1 makes
      //   the browser send a foreign Host header; refuse it, so the API is
      //   only reachable under a loopback name.
      // - Origin: a malicious page cannot read responses (no CORS headers),
      //   but simple cross-site requests would still execute state changes;
      //   refuse any non-local browser origin on state-changing methods.
      if (localBindingsOnly()) {
        const hostHeader = req.headers.host;
        if (hostHeader !== undefined && !isLocalHostName(hostHeaderName(hostHeader))) {
          writeJson(res, 403, { detail: "forbidden" });
          return;
        }
        if (method !== "GET" && method !== "HEAD") {
          const origin = req.headers.origin;
          if (origin !== undefined) {
            let originHost = "";
            try {
              originHost = new URL(origin).hostname;
            } catch {
              originHost = "";
            }
            if (!isLocalHostName(originHost)) {
              writeJson(res, 403, { detail: "forbidden" });
              return;
            }
          }
        }
      }
      let pathMatched = false;
      for (const route of routes) {
        const match = route.regex.exec(pathname);
        if (match === null) continue;
        pathMatched = true;
        if (route.method !== method) continue;
        const params: Record<string, string> = {};
        try {
          route.keys.forEach((key, i) => {
            params[key] = decodeURIComponent(match[i + 1]);
          });
        } catch {
          writeJson(res, 400, { detail: "invalid request body" });
          return;
        }
        const ctx: Ctx = { req, res, params, query, json: () => readBody(req) };
        if (route.regex.source.startsWith("^/api/runs/") || pathname === "/api/stream") {
          sseResponses.add(res);
          res.on("close", () => sseResponses.delete(res));
        }
        try {
          const out = await route.handler(ctx);
          if (out === HANDLED) return;
          if (out instanceof Respond) {
            writeJson(res, out.status, out.body);
            return;
          }
          writeJson(res, 200, out);
          return;
        } catch (exc) {
          writeError(res, exc);
          return;
        }
      }
      if (pathMatched) {
        writeJson(res, 405, { detail: "Method Not Allowed" });
        return;
      }
      if (pathname.startsWith("/api/")) {
        writeJson(res, 404, { detail: "Not Found" });
        return;
      }
      if (handleStatic(req, res, pathname)) return;
      writeJson(res, 404, { detail: "Not Found" });
    })().catch((exc) => writeError(res, exc));
  };

  // -- lifecycle -------------------------------------------------------------------

  const servers = new Set<http.Server>();
  // Every address this handle has been bound to (listen() records each one).
  // The local-request guards apply only while all of them are loopback.
  const boundHosts = new Set<string>();

  function localBindingsOnly(): boolean {
    if (boundHosts.size === 0) return true;
    for (const host of boundHosts) {
      if (!isLocalHostName(host)) return false;
    }
    return true;
  }

  return {
    state,
    handler,
    listen(host = "127.0.0.1", port = 0): Promise<http.Server> {
      boundHosts.add(host);
      if (!isLocalHostName(host)) {
        console.warn(
          `[two-brothers] serving on non-loopback address ${host} — the server has ` +
            "no authentication; exposing it beyond this machine is untrusted exposure " +
            "(see SECURITY.md).",
        );
      }
      const server = http.createServer(handler);
      servers.add(server);
      server.on("close", () => servers.delete(server));
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve(server));
      });
    },
    async close(): Promise<void> {
      for (const res of sseResponses) {
        try {
          res.end();
        } catch {
          // already closed
        }
      }
      await Promise.all(
        [...servers].map(
          (server) =>
            new Promise<void>((resolve) => {
              const done = (): void => resolve();
              server.closeAllConnections?.();
              server.close(done);
              // guard: if close stalls (a connection ignored closeAll), resolve anyway
              setTimeout(done, 2000).unref?.();
            }),
        ),
      );
      try {
        releaseWriterLock();
      } catch {
        // release is best-effort; a stale lock is reclaimed by pid liveness
      }
    },
  };
}
