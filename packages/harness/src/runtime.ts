/**
 * Stage 2 runtime: role settings and the background run manager. Ports the
 * original prototype's runtime (removed 2026-11-04; see git history).
 *
 * `RuntimeSettings` holds the per-role Senior/Junior provider/model/API-key
 * configuration the operator sets through the UI, overlaying an optional
 * `SettingsStore` (in-memory state is hydrated from the store on construction
 * and written through on `update()` — the TS analogue of the prototype's
 * server-side persistence snapshot). API keys live in memory only: `public()`
 * masks them behind `api_key_set`. Role fields keep the prototype's
 * settings.json field names
 * (`base_url`, `api_key`, `provider_ref`); the overlay target `Config` keeps
 * the TS camelCase names.
 *
 * `RunManager` executes cooperation runs on a **worker pool** (default 2
 * workers, `TWO_BROTHERS_WORKERS` / `workers` option): runs for *different*
 * sessions execute concurrently, while runs for the *same* session stay
 * strictly serialized — the session file is a shared context, so overlapping
 * runs on it would corrupt the envelope sequence (a protocol invariant; the
 * harness itself also holds a same-session mutex). A run submitted while the
 * pool is saturated stays observable in the `queued` state; there is no
 * rejection. Every run emits typed runtime events (`run_status` / `envelope` /
 * tool/approval events / `run_error` / `run_end`) carrying `run_id`/`at`; the
 * buffer is kept in memory so a dropped SSE connection can reconnect with
 * `?after=N`. `run_status` covers the approval park too: `waiting` when the
 * run parks on an operator approval, back to `running` once it resolves, so a
 * client watching the stream needs no separate poll for the parked state. An
 * optional `persist` hook (e.g. `RuntimeEventStore.asPersist()`) additionally
 * writes every event to a per-session sidecar file.
 *
 * Concurrency model: Python uses `workers` daemon threads fed from a dispatch
 * queue; here N persistent async worker loops pull from a promise queue — the
 * single-threaded event loop makes every state transition atomic, so no locks
 * are needed. Cancellation is an `AbortController` per run (the `AbortSignal`
 * replaces Python's `threading.Event`).
 */
import { randomUUID } from "node:crypto";

import type { Config } from "./config.ts";
import { emptyUsage, ProviderAbortError, type UsageTotals } from "./provider.ts";
import type { ApprovalBroker } from "./permissions.ts";
import type { RunApprovalBroker, RuntimeEvent } from "./runevents.ts";
import type { SettingsStore } from "./settings_store.ts";
import type { TokenStreamEvent } from "./runstream.ts";

export const ACTIVE_STATES: ReadonlySet<string> = new Set(["queued", "running", "waiting"]);
export const TERMINAL_STATES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);
const VALID_PROVIDERS: ReadonlySet<string> = new Set(["openai", "mock"]);

/**
 * Run statuses that accept mid-run operator steering (wave 23). Both are
 * honestly steerable: a `running` run drains at its next node boundary /
 * tool-loop iteration; a `waiting` run is parked on an operator approval and
 * drains at the next boundary after the approval resolves. `queued` runs have
 * not started the cooperation cycle (steering there would only pre-seed a run
 * the operator can still cancel) and `TERMINAL_STATES` are over — both are a
 * 409 on the HTTP route. Deliberately NOT `ACTIVE_STATES`: a queued run is
 * observable but not steerable.
 */
export const STEERABLE_STATES: ReadonlySet<string> = new Set(["running", "waiting"]);

/**
 * Largest single steering text accepted (characters, after trimming). Shared
 * with the HTTP route (`POST /api/runs/{run_id}/steer`) so a 400 there and a
 * rejected `RunRecord.steer` agree; deliberately small — a steer is an
 * operator aside, not a new task.
 */
export const STEER_TEXT_MAX_CHARS = 4000;

/**
 * Pending steering texts a run may hold before the operator gets a 409. The
 * harness drains the queue at least once per node boundary / tool-loop
 * iteration, so a full queue means the model call in flight is long; the
 * operator can retry after the next step.
 */
export const STEER_QUEUE_MAX = 8;

/**
 * One run's estimated USD cost (wave 24, web run-cost visibility). A run-level
 * projection only — `total` is the estimate for the run's MERGED usage, so it
 * is computed only when both roles resolve to the same priced model id; every
 * other run reports `null` rather than a fabricated split.
 */
export interface RunCost {
  currency: "USD";
  /** Estimated total in USD (input + output; cache subsets priced honestly). */
  total: number;
  /** The resolved price-table row the model id matched (e.g. `gpt-4o`). */
  model: string;
}

/** What a run job returns: decision + errors + optional usage totals + cost. */
export interface RunJobResult {
  cancelled?: boolean;
  decision?: Record<string, unknown>;
  errors?: string[];
  usage?: UsageTotals;
  /**
   * Additive per-run cost estimate, or `null` when it cannot be attributed
   * honestly (mixed models, unknown price row, mixed provider families with
   * cache counters). Absent behaves like `null`.
   */
  cost?: RunCost | null;
}

export type EnvelopeHook = (message: unknown) => void;
/** Ephemeral live-token listener (the server's SSE bridge); never persisted. */
export type LiveTokenListener = (event: TokenStreamEvent) => void;
/** Push one live token delta to a record's ephemeral listeners (fail-soft). */
export type LiveTokenHook = LiveTokenListener;
// The third argument is additive: a job that declares only `(signal, onEnvelope)`
// stays assignable (fewer parameters are allowed), so existing job builders and
// tests keep compiling unchanged. Only runs created with live tokens enabled
// have a record that fans the tokens out; for every other run `onToken` is a
// no-op at the record.
export type RunJob = (
  signal: AbortSignal,
  onEnvelope: EnvelopeHook,
  onToken: LiveTokenHook,
) => Promise<RunJobResult>;
export type PersistHook = (session: string, event: RuntimeEvent) => void;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function shortId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

// ---------------------------------------------------------------------------
// Role settings (API keys never leave the backend)
// ---------------------------------------------------------------------------

/** One role's effective settings; field names match settings.json. */
export interface RuntimeRoleSettings {
  provider: string;
  model: string;
  base_url: string;
  api_key: string;
  provider_ref: string;
}

function emptyRole(): RuntimeRoleSettings {
  return { provider: "", model: "", base_url: "", api_key: "", provider_ref: "" };
}

/** Operator-facing role view — no API key material, only whether one is set. */
export interface PublicRuntimeRoleSettings {
  provider: string | null;
  model: string | null;
  base_url: string | null;
  api_key_set: boolean;
  provider_ref: string | null;
}

export type PublicRuntimeSettings = Record<"senior" | "junior", PublicRuntimeRoleSettings>;
export type RuntimeSettingsSnapshot = Record<"senior" | "junior", RuntimeRoleSettings>;

const ROLE_FIELDS = ["provider", "model", "base_url", "api_key", "provider_ref"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Per-role endpoint resolution (Stage 18: python per-role parity)
// ---------------------------------------------------------------------------

/**
 * One role's effective connection settings: which provider implementation to
 * use and the endpoint/key/model it talks to. Empty fields mean "not set
 * here" — consumers fall back per field (the harness falls back to the
 * shared `Config` fields, mirroring Python's `role_base_url or cfg.base_url`).
 */
export interface RoleEndpoint {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /**
   * Wire flavor when the connection came from a named preset (the preset's
   * `kind`). Unset for env/manual-field sources — consumers fall back to the
   * run-level config kinds. Must follow the preset: a preset's base_url only
   * speaks its own wire format.
   */
  kind?: string;
}

/** Named provider preset shape the resolver needs (SettingsStore presets qualify). */
export interface EndpointPreset {
  name: string;
  base_url: string;
  api_key: string;
  /** Preset wire flavor (anthropic/google/openai-compatible); additive. */
  kind?: string;
}

/** Run-level fallbacks for the resolver (flags/env config, before role overlays). */
export interface RoleEndpointDefaults {
  /** Run-level provider (`openai`/`mock`); role settings override it per role. */
  provider?: string;
  seniorModel?: string;
  juniorModel?: string;
}

/** The resolver result: one effective endpoint per role + non-fatal warnings. */
export interface RoleEndpoints {
  senior: RoleEndpoint;
  junior: RoleEndpoint;
  /** Non-fatal problems (e.g. a dangling provider_ref) — warn, never fail. */
  warnings: string[];
}

const SHARED_ENV_PAIR: ReadonlyArray<readonly [string, string]> = [
  ["TWO_BROTHERS_BASE_URL", "TWO_BROTHERS_API_KEY"],
];

function roleEnvPair(role: "senior" | "junior"): readonly [string, string] {
  const prefix = role === "senior" ? "TWO_BROTHERS_SENIOR" : "TWO_BROTHERS_JUNIOR";
  return [`${prefix}_BASE_URL`, `${prefix}_API_KEY`];
}

/**
 * Resolve one role's effective `(baseUrl, apiKey)` pair; ports python
 * `server._resolve_role_endpoint` with the Stage 18 per-role env flags added
 * on top. Precedence per role: role env pair (all-or-nothing) > shared env
 * pair (all-or-nothing) > named preset (provider_ref) > role manual fields.
 * The env pairs are deliberately all-or-nothing: a preset's key must never be
 * sent to a base_url that came from a different source. A dangling
 * `provider_ref` warns and falls back to the role manual fields.
 */
function resolvePair(
  role: "senior" | "junior",
  snapshot: RuntimeSettingsSnapshot,
  presets: ReadonlyArray<EndpointPreset>,
  env: NodeJS.ProcessEnv,
  warnings: string[],
): [string, string, string?] {
  const roleEnv = roleEnvPair(role);
  const roleEnvBase = env[roleEnv[0]] ?? "";
  const roleEnvKey = env[roleEnv[1]] ?? "";
  if (roleEnvBase || roleEnvKey) return [roleEnvBase, roleEnvKey, undefined];
  const envBase = env[SHARED_ENV_PAIR[0][0]] ?? "";
  const envKey = env[SHARED_ENV_PAIR[0][1]] ?? "";
  if (envBase || envKey) return [envBase, envKey, undefined];
  const roleData = snapshot[role] ?? ({} as RuntimeRoleSettings);
  const ref = roleData.provider_ref ?? "";
  if (ref) {
    const preset = presets.find((p) => p.name === ref);
    if (preset) return [preset.base_url, preset.api_key, preset.kind];
    warnings.push(
      `provider_ref "${ref}" for the ${role} role has no matching preset; ` +
        "falling back to the role's manual fields",
    );
  }
  return [roleData.base_url ?? "", roleData.api_key ?? "", undefined];
}

/**
 * Effective per-role endpoints: env vars > named preset > role manual fields,
 * with run-level provider/model fallbacks. Pure and injectable — the caller
 * passes the settings snapshot, the decrypted presets, the env map and the
 * run-level defaults, so tests need no process mutation.
 *
 * Connection-field gap fill mirrors Python's shared-config fallback: Python
 * overlays each resolved role pair onto `cfg.base_url`/`cfg.api_key` (junior
 * last) and the responder falls back per field
 * (`role_base_url or cfg.base_url`), so a role with no resolved URL inherits
 * the other role's. Role provider/model fields are never borrowed across
 * roles; the provider is the run-level one unless the role sets its own (the
 * `roleProviders` switch mirrors Python's `apply(allow_provider=False)` when
 * a per-request provider override is in force).
 */
export function resolveRoleEndpoints(
  snapshot: RuntimeSettingsSnapshot,
  presets: ReadonlyArray<EndpointPreset>,
  env: NodeJS.ProcessEnv = process.env,
  defaults: RoleEndpointDefaults = {},
  roleProviders = true,
): RoleEndpoints {
  const warnings: string[] = [];
  const endpointFor = (role: "senior" | "junior"): RoleEndpoint => {
    const roleData = snapshot[role] ?? ({} as RuntimeRoleSettings);
    const [baseUrl, apiKey, kind] = resolvePair(role, snapshot, presets, env, warnings);
    const provider = (roleProviders ? roleData.provider : "") || defaults.provider || "";
    const model = roleData.model || (role === "senior" ? defaults.seniorModel : defaults.juniorModel) || "";
    return { provider, baseUrl, apiKey, model, ...(kind ? { kind } : {}) };
  };
  const senior = endpointFor("senior");
  const junior = endpointFor("junior");
  // Connection fields only — never provider/model (see docstring above).
  // The wire flavor follows a borrowed URL: a preset URL only speaks its
  // own kind, so kind pairs with the baseUrl it travels with — never
  // copied onto a role that kept its own connection.
  if (!senior.baseUrl) {
    senior.baseUrl = junior.baseUrl;
    if (!senior.kind) senior.kind = junior.kind;
  }
  if (!junior.baseUrl) {
    junior.baseUrl = senior.baseUrl;
    if (!junior.kind) junior.kind = senior.kind;
  }
  if (!senior.apiKey) senior.apiKey = junior.apiKey;
  if (!junior.apiKey) junior.apiKey = senior.apiKey;
  return { senior, junior, warnings };
}

/**
 * In-memory Senior/Junior model/provider settings over an optional
 * `SettingsStore`. Python keeps `RuntimeSettings` purely in memory and lets
 * the server persist a snapshot; folding the store in here keeps that
 * contract in one place (env-pinned stripping stays in `SettingsStore.write`).
 *
 * The shared plugin selection is deliberately **not** role settings: it
 * lives in the store's top-level `plugins` list and is held by the server
 * (`createServer`), which re-persists it explicitly. `update()` writes the
 * role snapshot with `plugins` omitted, which `SettingsStore.write` preserves
 * (and normalizes, migrating legacy per-role sections on save).
 */
export class RuntimeSettings {
  private senior: RuntimeRoleSettings = emptyRole();
  private junior: RuntimeRoleSettings = emptyRole();
  private readonly store: SettingsStore | null;

  constructor(store: SettingsStore | null = null) {
    this.store = store;
    if (store !== null) {
      const snapshot = store.read();
      for (const role of ["senior", "junior"] as const) {
        const saved = snapshot[role];
        if (saved === undefined) continue;
        for (const field of ROLE_FIELDS) {
          const value = saved[field];
          if (typeof value === "string" && value) this[role][field] = value;
        }
      }
    }
  }

  /** Operator-facing view — no API key material, only whether one is set. */
  public(): PublicRuntimeSettings {
    const view = (rs: RuntimeRoleSettings): PublicRuntimeRoleSettings => ({
      provider: rs.provider || null,
      model: rs.model || null,
      base_url: rs.base_url || null,
      api_key_set: Boolean(rs.api_key),
      provider_ref: rs.provider_ref || null,
    });
    return { senior: view(this.senior), junior: view(this.junior) };
  }

  /**
   * Full in-memory view **including api_key** — persistence input only;
   * never serialize this into an API response.
   */
  snapshot(): RuntimeSettingsSnapshot {
    const copy = (rs: RuntimeRoleSettings): RuntimeRoleSettings => ({ ...rs });
    return { senior: copy(this.senior), junior: copy(this.junior) };
  }

  /** Patch role fields; invalid providers are rejected; persists when backed. */
  update(data: unknown): PublicRuntimeSettings {
    if (isRecord(data)) {
      for (const role of ["senior", "junior"] as const) {
        const patch = data[role];
        if (!isRecord(patch)) continue;
        for (const field of ROLE_FIELDS) {
          const value = patch[field];
          if (value === undefined || value === null) continue;
          if (field === "provider" && !VALID_PROVIDERS.has(String(value))) {
            throw new Error(`invalid provider: ${String(value)} (use openai|mock)`);
          }
          this[role][field] = String(value);
        }
      }
    }
    this.store?.write(this.snapshot());
    return this.public();
  }

  /**
   * Overlay stored settings on a run config (unset fields keep their value):
   * models per role, provider per role (when `allowProvider`), and the
   * connection fields onto the shared ones — senior first, then junior,
   * matching Python's loop order. The server no longer uses the connection
   * overlay (Stage 18, design decision 4): effective per-role endpoints come
   * from `resolveRoleEndpoints` instead. Kept for legacy callers; the
   * shared-config fallback now lives in the resolver's cross-role gap fill.
   */
  apply(cfg: Config, allowProvider = true): Config {
    for (const role of ["senior", "junior"] as const) {
      const rs = this[role];
      if (rs.model) {
        if (role === "senior") cfg.seniorModel = rs.model;
        else cfg.juniorModel = rs.model;
      }
      if (rs.api_key) cfg.apiKey = rs.api_key;
      if (rs.base_url) cfg.baseUrl = rs.base_url;
      if (allowProvider && rs.provider) cfg.provider = rs.provider;
    }
    return cfg;
  }
}

// ---------------------------------------------------------------------------
// Background run manager
// ---------------------------------------------------------------------------

/** One submitted run; state is in-memory for the process lifetime. */
export class RunRecord {
  readonly runId: string;
  readonly session: string;
  readonly task: string;
  /**
   * Effective run mode (`consult`/`work`/`auto`), or "" when the submitter
   * supplied none and the config default could not be resolved.
   */
  readonly mode: string;
  created = nowSeconds();
  status = "queued";
  started = 0;
  finished = 0;
  error = "";
  decision: Record<string, unknown> | null = null;
  usage: UsageTotals = emptyUsage();
  /**
   * Additive run cost estimate (wave 24); `null` until the job reports one —
   * unknown stays unknown, never `$0`. Returned by `public()` on every record
   * so the web footer can render it or omit the segment honestly.
   */
  cost: RunCost | null = null;
  readonly events: RuntimeEvent[] = [];
  readonly controller = new AbortController();
  readonly done: Promise<boolean>;
  job: RunJob | null = null;
  /** Set by the submitter (the server's analogue); stop() denyAll()s it. */
  approvals: RunApprovalBroker | ApprovalBroker | null = null;
  /** Bounded pending operator steering texts, oldest first (in-memory only). */
  private readonly _steering: string[] = [];

  private _resolveDone!: (finished: boolean) => void;
  private _doneFlag = false;
  /**
   * Ephemeral live-token fan-out (SSE only). Never persisted: tokens bypass
   * `events`, the runtime sidecar and `public()`. Closed on `finish()`, so a
   * listener registered after the terminal state is never called.
   */
  private readonly _liveTokenListeners = new Set<LiveTokenListener>();
  private _liveTokensOpen: boolean;

  constructor(runId: string, session: string, task: string, mode = "", liveTokens = false) {
    this.runId = runId;
    this.session = session;
    this.task = task;
    this.mode = mode;
    this._liveTokensOpen = liveTokens;
    this.done = new Promise<boolean>((resolve) => {
      this._resolveDone = resolve;
    });
  }

  /** Signal observed by the job for cooperative cancellation. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /**
   * Subscribe to this run's live token deltas. Returns an idempotent
   * unsubscribe. Only runs submitted with live tokens enabled ever fan out;
   * a run without them (or one already terminal) returns a no-op unsubscribe
   * and never calls the listener. Multiple listeners are supported — the
   * server's SSE route is one per open connection.
   */
  onLiveToken(listener: LiveTokenListener): () => void {
    if (!this._liveTokensOpen) return () => {};
    this._liveTokenListeners.add(listener);
    return () => {
      this._liveTokenListeners.delete(listener);
    };
  }

  /**
   * Push one token to every live listener, fail-soft: a throwing listener is
   * isolated from the other listeners and from the run, and a listener added
   * or removed during the fan-out cannot corrupt the iteration. No-op once the
   * run is terminal (or when live tokens were never enabled).
   *
   * @internal Used by the RunManager job plumbing and the SSE bridge; tokens
   * are deliberately outside `events`/the sidecar.
   */
  emitLiveToken(event: TokenStreamEvent): void {
    if (!this._liveTokensOpen) return;
    for (const listener of [...this._liveTokenListeners]) {
      try {
        listener(event);
      } catch {
        // a broken SSE consumer never breaks the run
      }
    }
  }

  /** Drop every live listener; a terminal run accepts no token writes. */
  private _closeLiveTokens(): void {
    this._liveTokensOpen = false;
    this._liveTokenListeners.clear();
  }

  /** Terminal-state notification; resolves `true` once, like `threading.Event`. */
  finish(): void {
    if (this._doneFlag) return;
    // Terminal first: no token frame may follow run_end, and listeners are
    // dropped so a late token (or a late subscriber) is a no-op.
    this._closeLiveTokens();
    this._doneFlag = true;
    // Nothing will ever drain a terminal run's steering queue, so it must not
    // outlive the run: the texts are dropped with the record (a later `steer`
    // cannot revive them, and `public()` reports no pending text).
    this._steering.length = 0;
    this._resolveDone(true);
  }

  /** Synchronous terminal-state probe (the SSE endpoint's `done.is_set()`). */
  get isDone(): boolean {
    return this._doneFlag;
  }

  // -- mid-run operator steering (wave 23) ------------------------------------

  /** How many steer texts are waiting for the harness to pick up. */
  get pendingSteering(): number {
    return this._steering.length;
  }

  /**
   * Queue one operator steering text: trimmed, non-empty, at most
   * {@link STEER_TEXT_MAX_CHARS}, accepted only while the run is active (not
   * aborted, not terminal) and while the queue is below {@link STEER_QUEUE_MAX}.
   * Returns true when accepted. The harness drains it in submission order at
   * the next node boundary / tool-loop iteration (`drainSteering`); this method
   * never touches the context or the events — the envelope appears only when
   * the harness actually appends it. A stopped/finished run refuses here, so a
   * text can never be accepted into a queue nothing will drain.
   */
  steer(text: unknown): boolean {
    if (this._doneFlag || this.signal.aborted) return false;
    if (typeof text !== "string") return false;
    const trimmed = text.trim();
    if (trimmed === "" || trimmed.length > STEER_TEXT_MAX_CHARS) return false;
    if (this._steering.length >= STEER_QUEUE_MAX) return false;
    this._steering.push(trimmed);
    return true;
  }

  /**
   * Drain the pending steering texts in submission order (the
   * `HarnessOptions.steering` callback). Returns-and-clears, matching the
   * harness's drain-once contract. A terminal/cancelled run drains to an empty
   * list and drops whatever was still queued: nothing may be appended after
   * the cycle ended.
   */
  drainSteering(): string[] {
    if (this._doneFlag || this.signal.aborted) {
      this._steering.length = 0;
      return [];
    }
    return this._steering.splice(0, this._steering.length);
  }

  public(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      run_id: this.runId,
      session: this.session,
      task: this.task,
      mode: this.mode,
      status: this.status,
      created: this.created,
      started: this.started,
      finished: this.finished,
    };
    if (this.error) out.error = this.error;
    if (this.decision !== null) out.decision = this.decision;
    out.usage = { ...this.usage };
    // Additive run cost (wave 24): always present, honestly null when the run
    // is not attributable to one priced model (mirrors the CLI/TUI rule).
    out.cost = this.cost === null ? null : { ...this.cost };
    // Mid-run steering honesty (wave 23): a client polling the record learns
    // that texts were dropped at the per-run harness cap and how many are still
    // waiting — no extra route and no faked event. Both fields are additive and
    // only present when they carry information.
    let steeringDropped = 0;
    for (const event of this.events) {
      if (event.type === "steering_dropped") steeringDropped += event.dropped;
    }
    if (steeringDropped > 0) out.steering_dropped = steeringDropped;
    if (!this._doneFlag && this._steering.length > 0) out.steering_pending = this._steering.length;
    return out;
  }

  emit(event: RuntimeEvent): void {
    this.events.push(event);
  }
}

/** Minimal promise FIFO: workers block on `take()` until a record appears. */
class DispatchQueue {
  private readonly _items: RunRecord[] = [];
  private readonly _waiters: Array<(record: RunRecord) => void> = [];

  put(record: RunRecord): void {
    const waiter = this._waiters.shift();
    if (waiter !== undefined) waiter(record);
    else this._items.push(record);
  }

  take(): Promise<RunRecord> {
    const item = this._items.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise<RunRecord>((resolve) => {
      this._waiters.push(resolve);
    });
  }
}

/**
 * Why one steering attempt was rejected (the HTTP route maps these onto its
 * honest 400/404/409 contract):
 * - `unknown_run` — no such in-memory run (404);
 * - `not_active` — the run is queued or terminal, so no cooperation cycle can
 *   apply the text (409, with the run's real status);
 * - `queue_full` — {@link STEER_QUEUE_MAX} texts are already pending (409);
 * - `invalid_text` — empty/oversized/non-string text (400; the route rejects
 *   these before calling the manager, this is the defensive result).
 */
export type SteerRejection = "unknown_run" | "not_active" | "queue_full" | "invalid_text";

/** One `RunManager.steer` outcome: accepted (+ pending count) or a rejection. */
export interface SteerResult {
  accepted: boolean;
  /** The targeted record, or null for `unknown_run`. */
  record: RunRecord | null;
  /** Pending steering texts after this call (the accepted 200's `pending`). */
  pending: number;
  /** Set exactly when `accepted` is false. */
  reason?: SteerRejection;
}

/**
 * Worker-pool background runner; run state is in-memory for the process
 * lifetime (Python parity).
 *
 * Runs are dispatched to `workers` async worker loops. Two scheduling rules:
 * a run starts only when a worker slot is free *and* no other run for the
 * same session is in flight — same-session runs stay strictly serialized
 * because the session file is a shared context (envelope `seq` continuity is
 * a protocol invariant, and the harness holds its own same-session mutex as
 * a second line of defence). A run that cannot be dispatched yet stays in
 * `queued` state; there is no rejection.
 *
 * `persist(session, event)` — when given — writes every typed event to the
 * session's runtime sidecar (best effort; a failing sink never breaks a run).
 *
 * Live token deltas are a separate, deliberately EPHEMERAL channel: a run
 * submitted with `streamTokens` fans provider `token` stream events out to
 * `RunRecord.onLiveToken` subscribers (the server's SSE bridge), in memory
 * only. They never enter `record.events`, the sidecar, `public()` or the
 * replayable `?after` cursor, and the registry is closed at `finish()`.
 *
 * Mid-run operator steering is likewise in-memory only: `steer(runId, text)`
 * queues a bounded text on the run's `RunRecord`; the job's harness drains it
 * and appends an ordinary envelope (see `RunRecord.steer`/`drainSteering`).
 * The manager never emits an early event for a queued text.
 */
export class RunManager {
  private readonly _workers: number;
  private readonly _records = new Map<string, RunRecord>();
  private readonly _order: string[] = [];
  private readonly _pending: RunRecord[] = [];
  private readonly _activeSessions = new Set<string>();
  private _inflight = 0;
  private readonly _dispatch = new DispatchQueue();
  private _workerLoops = 0;
  private readonly _persist: PersistHook | null;

  constructor(options: { persist?: PersistHook; workers?: number } = {}) {
    const fromEnv = Number.parseInt(process.env.TWO_BROTHERS_WORKERS ?? "", 10);
    const configured = options.workers ?? (Number.isFinite(fromEnv) ? fromEnv : 2);
    // Python parity: max(1, int(workers)) — 0/negative clamp to 1
    this._workers = Number.isFinite(configured) ? Math.max(1, configured) : 2;
    this._persist = options.persist ?? null;
  }

  // -- submission / queries ---------------------------------------------------

  /**
   * Submit a background run. `options.streamTokens` opts this record into the
   * ephemeral live-token fan-out (`onLiveToken`/`emitLiveToken`); the job is
   * always handed an `onToken` hook, but a record without that flag silently
   * drops it, so only runs that asked for streaming reach SSE listeners.
   */
  submit(
    task: string,
    session: string,
    job: RunJob,
    mode = "",
    options: { streamTokens?: boolean } = {},
  ): RunRecord {
    const record = new RunRecord(
      shortId(),
      session,
      task,
      mode,
      options.streamTokens === true,
    );
    record.job = job;
    this._records.set(record.runId, record);
    this._order.push(record.runId);
    this._pending.push(record);
    this._emit(record, { type: "run_status", status: "queued" });
    this._pump();
    return record;
  }

  get(runId: string): RunRecord | null {
    return this._records.get(runId) ?? null;
  }

  /** Newest first, like Python's `reversed(self._order)`. */
  list(): Array<Record<string, unknown>> {
    const ordered = [...this._order].reverse();
    return ordered.map((runId) => this._records.get(runId) as RunRecord).map((r) => r.public());
  }

  /**
   * Request a cooperative stop; status flips to cancelled on unwind.
   * A stopped run must never leave a mutation parked mid-approval, so a
   * registered approval broker resolves every pending wait as *deny*.
   */
  stop(runId: string): RunRecord | null {
    const record = this._records.get(runId);
    if (record === undefined) return null;
    record.controller.abort();
    const broker = record.approvals as RunApprovalBroker | null;
    if (broker !== null && typeof (broker as RunApprovalBroker).denyAll === "function") {
      (broker as RunApprovalBroker).denyAll("cancelled");
    }
    if (record.status === "queued") {
      record.status = "cancelled";
      record.finished = nowSeconds();
      record.finish();
    }
    return record;
  }

  /**
   * Queue one operator steering text on an active run (the HTTP route and
   * tests share this). Accepted only for {@link STEERABLE_STATES} while the
   * record is neither done nor aborted — `stop()` (which leaves the status
   * `running` until the job unwinds) and a terminal `finish()` win the race, so
   * a POST after stop can never be a 200 for text nothing will drain. A
   * queued/terminal run is `not_active`. Text bounds and the pending cap live
   * on `RunRecord.steer`. No runtime event is emitted here: the client's 200 is
   * the acceptance, and SSE consumers see the envelope only once the harness
   * appends it.
   */
  steer(runId: string, text: unknown): SteerResult {
    const record = this._records.get(runId);
    if (record === undefined) {
      return { accepted: false, record: null, pending: 0, reason: "unknown_run" };
    }
    if (!STEERABLE_STATES.has(record.status) || record.isDone || record.signal.aborted) {
      return {
        accepted: false,
        record,
        pending: record.pendingSteering,
        reason: "not_active",
      };
    }
    if (!record.steer(text)) {
      return {
        accepted: false,
        record,
        pending: record.pendingSteering,
        reason: record.pendingSteering >= STEER_QUEUE_MAX ? "queue_full" : "invalid_text",
      };
    }
    return { accepted: true, record, pending: record.pendingSteering };
  }

  /** Test/CLI helper: block until the run reaches a terminal state. */
  async wait(runId: string, timeoutMs = 10000): Promise<boolean> {
    const record = this._records.get(runId);
    if (record === undefined) return false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        record.done,
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  // -- worker -----------------------------------------------------------------

  /** Start worker loops until the pool is at capacity (they never die). */
  private _ensureWorkers(): void {
    while (this._workerLoops < this._workers) {
      this._workerLoops += 1;
      void this._work();
    }
  }

  /**
   * Move dispatchable pending runs onto the pool. A run is dispatchable when
   * a worker slot is free and its session has no run currently in flight;
   * everything else waits in `queued` state. FIFO within those constraints.
   */
  private _pump(): void {
    while (this._inflight < this._workers) {
      const record = this._pending.find((r) => !this._activeSessions.has(r.session));
      if (record === undefined) break;
      this._pending.splice(this._pending.indexOf(record), 1);
      this._activeSessions.add(record.session);
      this._inflight += 1;
      this._dispatch.put(record);
    }
    this._ensureWorkers();
  }

  private async _work(): Promise<void> {
    // The loop body never rejects (run errors are captured into run_error
    // events by _runRecord), so the pool cannot silently drain.
    for (;;) {
      const record = await this._dispatch.take();
      try {
        if (record.status === "cancelled") {
          // stop() landed while the record sat on the dispatch queue
          this._emit(record, { type: "run_end", status: "cancelled", usage: { ...record.usage } });
        } else {
          await this._runRecord(record);
        }
      } finally {
        this._inflight -= 1;
        this._activeSessions.delete(record.session);
        this._pump();
      }
    }
  }

  private async _runRecord(record: RunRecord): Promise<void> {
    if (record.signal.aborted) {
      // a stop landed between dequeue and start — honor it instead of
      // clobbering the cancelled status with "running"
      record.status = "cancelled";
      this._emit(record, { type: "run_end", status: "cancelled", usage: { ...record.usage } });
      return;
    }
    record.status = "running";
    record.started = nowSeconds();
    this._emit(record, { type: "run_status", status: "running" });

    const onEnvelope: EnvelopeHook = (msg) => {
      if (isRecord(msg) && typeof msg.type === "string") {
        // already a typed runtime event (tool/approval); pass through, then
        // mirror the approval park on `run_status` (cause first, transition
        // second). An already-aborted wait resolves immediately, so it never
        // counts as a park and emits no `waiting`.
        const type = msg.type;
        this._emit(record, msg as unknown as RuntimeEvent);
        if (type === "approval_requested") {
          if (!record.signal.aborted && (record.status === "queued" || record.status === "running")) {
            this._setStatus(record, "waiting");
          }
        } else if (type === "approval_resolved" && record.status === "waiting") {
          // a stop resolves the park as deny; that unwind ends `cancelled` and
          // must not report a phantom return to `running`
          if (!record.signal.aborted) this._setStatus(record, "running");
        }
        return;
      }
      const envelope = isRecord(msg) ? msg : {};
      this._emit(record, {
        type: "envelope",
        seq: typeof envelope.seq === "number" ? envelope.seq : record.events.length,
        envelope: msg,
      });
    };

    const job = record.job;
    if (job === null) {
      record.status = "failed";
      record.error = "run has no job";
      record.finished = nowSeconds();
      this._emit(record, { type: "run_error", message: record.error });
      this._emit(record, { type: "run_end", status: record.status, usage: { ...record.usage } });
      record.finish();
      return;
    }

    let result: RunJobResult;
    try {
      // The token hook is always supplied; records not submitted with
      // `streamTokens` drop it (`emitLiveToken` is a no-op then), so a job can
      // forward unconditionally without deciding about streaming itself.
      result = await job(record.signal, onEnvelope, (event) => record.emitLiveToken(event));
    } catch (exc) {
      record.finished = nowSeconds();
      if (record.signal.aborted || exc instanceof ProviderAbortError) {
        // stop landed during an in-flight model call (or the harness bailed
        // on the abort): the call erroring out is a consequence of the stop,
        // not an independent failure — no run_error event (Python parity:
        // RunCancelled unwinds silently)
        record.status = "cancelled";
        if (!(exc instanceof ProviderAbortError)) record.error = String(exc);
      } else {
        record.status = "failed";
        record.error = String(exc);
        this._emit(record, { type: "run_error", message: String(exc) });
      }
      this._emit(record, { type: "run_end", status: record.status, usage: { ...record.usage } });
      record.finish();
      return;
    }

    record.finished = nowSeconds();
    if (result.cancelled || record.signal.aborted) {
      record.status = "cancelled";
    } else {
      record.status = "completed";
      record.decision = result.decision ?? {};
    }
    if (result.usage !== undefined && isRecord(result.usage)) {
      record.usage = { ...emptyUsage(), ...(result.usage as Partial<UsageTotals>) };
    }
    // Additive run cost (wave 24): the job computes it where the resolved
    // config/endpoints are in scope. A job that reports none leaves the record
    // honestly null; a terminal failed/cancelled unwind already stayed null.
    record.cost = result.cost ?? null;
    const end: RuntimeEvent = {
      type: "run_end",
      status: record.status,
      usage: { ...record.usage },
    };
    if (record.decision !== null) {
      (end as { decision?: Record<string, unknown> }).decision = record.decision;
    }
    this._emit(record, end);
    record.finish();
  }

  /** Flip the status and emit exactly one matching `run_status` event. */
  private _setStatus(record: RunRecord, status: string): void {
    if (record.status === status) return;
    record.status = status;
    this._emit(record, { type: "run_status", status });
  }

  private _emit(record: RunRecord, event: RuntimeEvent): void {
    const withMeta = event as RuntimeEvent & { run_id?: string; at?: number };
    if (withMeta.run_id === undefined) withMeta.run_id = record.runId;
    if (withMeta.at === undefined) withMeta.at = nowSeconds();
    record.emit(withMeta);
    if (this._persist !== null) {
      try {
        this._persist(record.session, withMeta);
      } catch {
        // the sidecar must never break a run
      }
    }
  }
}
