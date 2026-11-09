/**
 * Central permission decisions and the approval broker interface. Ports the
 * original prototype's permissions module (removed 2026-11-04; see git history).
 *
 * One place decides whether a workspace action may proceed. Read-only actions
 * (auto-allow per policy, OpenHarness-style) never reach the broker; mutating
 * actions and shell commands become an `ApprovalRequest` that the broker
 * resolves. If no broker is configured the request is denied (fail closed),
 * so an unattended run can never mutate the workspace silently.
 *
 * Approval modes (`ApprovalMode`) select a fixed, honest decision table:
 * `ask` (the default — reads free, everything mutating asks), `readonly`
 * (reads free, every mutation and shell denied without asking), `edits`
 * (reads/writes/edits free, deletes and shell ask) and `allow-all` (every
 * action runs without asking; explicit operator opt-in only). A mode never
 * bypasses workspace confinement or the sensitive-path refusal — those run in
 * `Workspace.resolve` before this module is consulted. A mode is set only by
 * the operator surface (CLI flag/env, `sessions/settings.json`, server
 * option); neither a model reply nor a tool call can change it.
 *
 * The broker interface is intentionally tiny and async-friendly so a UI can
 * pause a cooperation loop, surface the request to the operator, and resume
 * with their answer. DeepAgents-style decisions are accepted:
 * "approve"/"allow" → allow, "edit"/"ask" → ask again,
 * "reject"/"deny" → deny. A broker answer can only choose among those three
 * decisions; it can never widen the policy.
 */

/**
 * Workspace actions the permission layer knows about.
 * (const-object, not a TS enum — node strip-only mode must load this file.)
 */
export const Action = {
  READ: "read",
  WRITE: "write",
  EDIT: "edit",
  DELETE: "delete",
  SHELL: "shell",
} as const;
export type Action = (typeof Action)[keyof typeof Action];

export const READ_ONLY_ACTIONS: ReadonlySet<Action> = new Set<Action>([Action.READ]);

export const Decision = {
  ALLOW: "allow",
  DENY: "deny",
  ASK: "ask",
} as const;
export type Decision = (typeof Decision)[keyof typeof Decision];

// ---------------------------------------------------------------------------
// Approval modes (operator-selected policy)
// ---------------------------------------------------------------------------

/**
 * Honest ways to resolve a workspace action, ordered from the default to the
 * most permissive. `ask` is today's behavior and every unset/corrupt source
 * fails closed to it.
 * (const-object, not a TS enum — node strip-only mode must load this file.)
 */
export const ApprovalMode = {
  ASK: "ask",
  READONLY: "readonly",
  EDITS: "edits",
  ALLOW_ALL: "allow-all",
} as const;
export type ApprovalMode = (typeof ApprovalMode)[keyof typeof ApprovalMode];

/** Every mode in display order; the only values a strict source may persist. */
export const APPROVAL_MODES: readonly ApprovalMode[] = [
  ApprovalMode.ASK,
  ApprovalMode.READONLY,
  ApprovalMode.EDITS,
  ApprovalMode.ALLOW_ALL,
];

/** The fail-closed mode: also what an absent/corrupt stored policy reads as. */
export const DEFAULT_APPROVAL_MODE: ApprovalMode = ApprovalMode.ASK;

/**
 * Operator-facing description of one mode. `danger` is the destructive warning
 * a surface must show for a mode that weakens a guardrail (`allow-all`); it is
 * absent for every other mode.
 */
export interface ApprovalModeInfo {
  mode: ApprovalMode;
  label: string;
  /** One truthful sentence about the decision table this mode applies. */
  description: string;
  /** Explicit destructive warning; present only for `allow-all`. */
  danger?: string;
}

export const APPROVAL_MODE_INFO: Readonly<Record<ApprovalMode, ApprovalModeInfo>> = {
  [ApprovalMode.ASK]: {
    mode: ApprovalMode.ASK,
    label: "Ask",
    description:
      "Reads run freely. Writes, edits, deletes and shell commands wait for operator approval.",
  },
  [ApprovalMode.READONLY]: {
    mode: ApprovalMode.READONLY,
    label: "Read only",
    description:
      "Only reads run. Every write, edit, delete and shell command is denied without asking.",
  },
  [ApprovalMode.EDITS]: {
    mode: ApprovalMode.EDITS,
    label: "Edits",
    description:
      "Reads, writes and edits run freely. Deletes and shell commands wait for operator approval.",
  },
  [ApprovalMode.ALLOW_ALL]: {
    mode: ApprovalMode.ALLOW_ALL,
    label: "Allow all",
    description:
      "Everything runs without asking, including deletes and shell commands.",
    danger:
      "Use only in a workspace you trust: a mistaken model step becomes an irreversible change.",
  },
};

// ---------------------------------------------------------------------------
// Named permission presets (deepseek-harness style)
// ---------------------------------------------------------------------------

/**
 * The operator-facing names a surface offers as one Permissions selector.
 *
 * deepseek-harness bundles a sandbox mode and an approval policy into named
 * presets; Two Brothers has one effective enforcement knob (`approval_policy
 * .mode`), so a preset is a presentation alias for one mode. The persisted
 * wire contract is still the mode — presets never widen what a mode permits
 * and an older client/backend keeps working unchanged.
 *
 * `custom` is derived-only: a stored mode that matches no preset (a future
 * value, or a hand-built document) renders as custom and can never be
 * selected or persisted through this catalog.
 * (const-object, not a TS enum — node strip-only mode must load this file.)
 */
export const PermissionPreset = {
  READ_ONLY: "read-only",
  ASK: "ask",
  WORKSPACE_WRITE: "workspace-write",
  DANGER_FULL_ACCESS: "danger-full-access",
} as const;
export type PermissionPreset = (typeof PermissionPreset)[keyof typeof PermissionPreset];

/** Reserved presentation value for a stored mode that matches no preset. */
export const CUSTOM_PERMISSION_PRESET = "custom" as const;

/** Every selectable preset, ordered from the most restrictive to the most open. */
export const PERMISSION_PRESETS: readonly PermissionPreset[] = [
  PermissionPreset.READ_ONLY,
  PermissionPreset.ASK,
  PermissionPreset.WORKSPACE_WRITE,
  PermissionPreset.DANGER_FULL_ACCESS,
];

/** One preset's truthful presentation and the mode it selects. */
export interface PermissionPresetInfo {
  preset: PermissionPreset;
  /** The persisted `approval_policy.mode` this preset applies. */
  mode: ApprovalMode;
  label: string;
  /** One truthful sentence about what runs without asking. */
  description: string;
  /** Destructive warning; present only for the fully permissive preset. */
  danger?: string;
}

export const PERMISSION_PRESET_INFO: Readonly<Record<PermissionPreset, PermissionPresetInfo>> = {
  [PermissionPreset.READ_ONLY]: {
    preset: PermissionPreset.READ_ONLY,
    mode: ApprovalMode.READONLY,
    label: "Read only",
    description:
      "Reads run freely. Writes, edits, deletes and shell commands are denied without asking.",
  },
  [PermissionPreset.ASK]: {
    preset: PermissionPreset.ASK,
    mode: ApprovalMode.ASK,
    label: "Always ask",
    description:
      "Reads run freely. Writes, edits, deletes and shell commands ask before they run.",
  },
  [PermissionPreset.WORKSPACE_WRITE]: {
    preset: PermissionPreset.WORKSPACE_WRITE,
    mode: ApprovalMode.EDITS,
    label: "Workspace write",
    description:
      "Reads, writes and edits run freely inside the workspace. Deletes and shell commands ask before they run.",
  },
  [PermissionPreset.DANGER_FULL_ACCESS]: {
    preset: PermissionPreset.DANGER_FULL_ACCESS,
    mode: ApprovalMode.ALLOW_ALL,
    label: "Full access",
    description: "Everything runs without asking, including deletes and shell commands.",
    danger:
      "Use only in a workspace you trust: a mistaken model step becomes an irreversible change.",
  },
};

/**
 * Accepted spellings for `/permission <name>`, `--approval-mode`-adjacent
 * surfaces and old links. The four mode names remain aliases, so every value
 * that worked before this catalog existed keeps its exact meaning.
 */
const PERMISSION_PRESET_ALIASES: Readonly<Record<string, PermissionPreset>> = {
  "read-only": PermissionPreset.READ_ONLY,
  readonly: PermissionPreset.READ_ONLY,
  "readonly-mode": PermissionPreset.READ_ONLY,
  ask: PermissionPreset.ASK,
  "workspace-write": PermissionPreset.WORKSPACE_WRITE,
  "workspacewrite": PermissionPreset.WORKSPACE_WRITE,
  edits: PermissionPreset.WORKSPACE_WRITE,
  edit: PermissionPreset.WORKSPACE_WRITE,
  "workspace-edits": PermissionPreset.WORKSPACE_WRITE,
  "danger-full-access": PermissionPreset.DANGER_FULL_ACCESS,
  "full-access": PermissionPreset.DANGER_FULL_ACCESS,
  "fullaccess": PermissionPreset.DANGER_FULL_ACCESS,
  "allow-all": PermissionPreset.DANGER_FULL_ACCESS,
  allowall: PermissionPreset.DANGER_FULL_ACCESS,
};

/** Canonical comparison key for a preset/mode spelling. */
function presetKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
}

/**
 * Strict preset lookup for operator input: a preset id, the legacy mode name,
 * or a case/space-insensitive alias; `null` for anything else. `custom` is
 * deliberately not selectable.
 */
export function normalizePermissionPreset(value: unknown): PermissionPreset | null {
  if (typeof value !== "string") return null;
  const key = presetKey(value);
  // A plain-object bracket lookup would resolve inherited keys such as
  // "constructor" to Object.prototype and later crash PERMISSION_PRESET_INFO.
  return Object.prototype.hasOwnProperty.call(PERMISSION_PRESET_ALIASES, key)
    ? PERMISSION_PRESET_ALIASES[key]!
    : null;
}

export function isPermissionPreset(value: unknown): value is PermissionPreset {
  return normalizePermissionPreset(value) !== null;
}

/** The preset that presents one stored mode (every current mode maps). */
export function permissionPresetOf(mode: ApprovalMode): PermissionPresetInfo {
  const resolved = resolveApprovalMode(mode);
  for (const preset of PERMISSION_PRESETS) {
    const info = PERMISSION_PRESET_INFO[preset];
    if (info.mode === resolved) return info;
  }
  // Unreachable for the current enum; keeps a future mode fail-closed in the
  // presentation layer instead of inventing a permissive label.
  return PERMISSION_PRESET_INFO[PermissionPreset.ASK];
}

/** The preset id that presents one stored mode, or `custom` if none matches. */
export function currentPermissionPreset(
  mode: ApprovalMode,
): PermissionPreset | typeof CUSTOM_PERMISSION_PRESET {
  const normalized = normalizeApprovalMode(mode);
  if (normalized === null) return CUSTOM_PERMISSION_PRESET;
  for (const preset of PERMISSION_PRESETS) {
    if (PERMISSION_PRESET_INFO[preset].mode === normalized) return preset;
  }
  return CUSTOM_PERMISSION_PRESET;
}

/** Resolve a selectable preset to the mode it persists. */
export function permissionPresetMode(preset: PermissionPreset): ApprovalMode {
  return PERMISSION_PRESET_INFO[preset].mode;
}

/** The destructive warning for a preset, or null when it keeps asking. */
export function permissionPresetWarning(preset: PermissionPreset): string | null {
  const info = PERMISSION_PRESET_INFO[preset];
  return info.danger === undefined
    ? null
    : `permission preset "${info.preset}": ${info.description} ${info.danger}`;
}

/**
 * Strict mode normalization for untrusted sources (settings file, HTTP body,
 * CLI flag/env): trim surrounding whitespace, accept only the four exact
 * lowercase names, otherwise `null`. Callers decide whether a rejection is a
 * fail-closed fallback (`resolveApprovalMode`) or a 400/usage error.
 */
export function normalizeApprovalMode(value: unknown): ApprovalMode | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!(APPROVAL_MODES as readonly string[]).includes(text)) return null;
  return text as ApprovalMode;
}

/** Run-time guard for the strict enum. */
export function isApprovalMode(value: unknown): value is ApprovalMode {
  return normalizeApprovalMode(value) !== null;
}

/**
 * Fail-closed resolution: an unknown/absent value is `ask`, never a more
 * permissive mode.
 */
export function resolveApprovalMode(value: unknown = undefined): ApprovalMode {
  return normalizeApprovalMode(value) ?? DEFAULT_APPROVAL_MODE;
}

/**
 * The visible warning a surface prints/renders when a mode silently widens
 * what the model may do without asking; `null` for every mode that keeps the
 * operator in the loop. `allow-all` is the only such mode today.
 */
export function approvalModeWarning(mode: ApprovalMode): string | null {
  const info = APPROVAL_MODE_INFO[resolveApprovalMode(mode)];
  return info.danger === undefined
    ? null
    : `approval mode "${info.mode}": ${info.description} ${info.danger}`;
}

/** Cap on the rendered diff carried by one approval detail (head-preserving). */
export const APPROVAL_DETAIL_MAX_CHARS = 20_000;

/**
 * Additive typed preview of a mutating action, so a UI can show the operator
 * exactly what will change before they approve it. All fields are optional and
 * bounded: a request without a detail is exactly the previous shape.
 */
export interface ApprovalDetail {
  /** `write` / `edit` / `delete` / `shell` (the requested action). */
  kind: string;
  /** Unified diff of the change for write/edit/delete (bounded). */
  diff?: string;
  /** Diff line counts, when known. */
  addedLines?: number;
  removedLines?: number;
  /** Shell command to run (Action.SHELL). */
  command?: string;
  /** True when `diff` was clipped to the detail cap. */
  truncated?: boolean;
}

/** Everything an operator needs to approve or deny one action. */
export interface ApprovalRequest {
  /** Workspace action being requested. */
  action: Action;
  /** Workspace-relative path (or absolute command). */
  target?: string;
  /** Set for Action.SHELL. */
  command?: string;
  /** E.g. "matches sensitive file pattern .env". */
  reason?: string;
  /** Free-form extra context for the operator. */
  context?: Record<string, unknown>;
  /** Additive bounded preview (diff/command) for the operator UI. */
  detail?: ApprovalDetail;
}

/**
 * A broker answer may be a Decision enum member or a DeepAgents-style
 * string, sync or async; strings are normalised via `normalizeDecision`.
 */
export type BrokerAnswer = Decision | string | Promise<Decision | string>;

/** A plain callable broker (no `.approve` method needed). */
export type BrokerCallable = (request: ApprovalRequest) => BrokerAnswer;

/** Resolves approval requests; the only integration point a UI needs. */
export interface ApprovalBroker {
  approve(request: ApprovalRequest): BrokerAnswer;
}

/** Always answers with one fixed decision (useful for tests and CLIs). */
export class StaticBroker implements ApprovalBroker {
  readonly decision: Decision;

  constructor(decision: Decision = Decision.ALLOW) {
    this.decision = decision;
  }

  approve(_request: ApprovalRequest): Decision {
    return this.decision;
  }
}

/** Wraps any sync or async callable as an approval broker. */
export class CallbackBroker implements ApprovalBroker {
  private readonly callback: BrokerCallable;

  constructor(callback: BrokerCallable) {
    this.callback = callback;
  }

  async approve(request: ApprovalRequest): Promise<Decision> {
    return normalizeDecision(await this.callback(request));
  }
}

/** Map broker output (enum, DeepAgents-style string, or None) to a Decision. */
export function normalizeDecision(answer: Decision | string | null | undefined): Decision {
  if (answer === Decision.ALLOW || answer === Decision.DENY || answer === Decision.ASK) {
    return answer;
  }
  const text = String(answer ?? "").trim().toLowerCase();
  if (["allow", "approve", "approved", "yes", "true"].includes(text)) return Decision.ALLOW;
  if (["ask", "edit", "respond"].includes(text)) return Decision.ASK;
  return Decision.DENY;
}

/**
 * Decides which actions need operator approval: the mode's fixed decision
 * table (see `ApprovalMode`). The default mode reproduces the historical
 * behavior exactly (`autoAllowRead=true` → reads allowed, everything else
 * asks).
 *
 * The legacy boolean constructor (`new PermissionPolicy(false)`) keeps its
 * meaning — mode `ask` with reads asking too — so existing embedders that
 * disable read auto-allow are unaffected.
 */
export class PermissionPolicy {
  /** The mode whose decision table this policy applies. */
  readonly mode: ApprovalMode;
  /** Legacy read switch; every mode sets it true except the legacy boolean form. */
  readonly autoAllowRead: boolean;

  constructor(mode: ApprovalMode | boolean = DEFAULT_APPROVAL_MODE) {
    if (typeof mode === "boolean") {
      this.mode = DEFAULT_APPROVAL_MODE;
      this.autoAllowRead = mode;
    } else {
      this.mode = resolveApprovalMode(mode);
      this.autoAllowRead = true;
    }
  }

  decide(request: ApprovalRequest): Decision {
    if (this.mode === ApprovalMode.ALLOW_ALL) return Decision.ALLOW;
    const readOnly = READ_ONLY_ACTIONS.has(request.action);
    if (readOnly) return this.autoAllowRead ? Decision.ALLOW : Decision.ASK;
    // `readonly` denies mutations and shell deterministically: it never asks,
    // so a present broker cannot re-open what the mode closed.
    if (this.mode === ApprovalMode.READONLY) return Decision.DENY;
    if (
      this.mode === ApprovalMode.EDITS &&
      (request.action === Action.WRITE || request.action === Action.EDIT)
    ) {
      return Decision.ALLOW;
    }
    return Decision.ASK;
  }
}

/** Internal sentinel for denied actions; surfaced as a structured result. */
export class PermissionDenied extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionDenied";
  }
}

/**
 * Policy + broker: the single entry point workspace tools consult.
 * `check` returns a Decision; `require` raises PermissionDenied with a
 * human-readable reason so the workspace layer can convert a denial into a
 * structured result instead of an exception crossing the tool boundary.
 */
export class PermissionManager {
  readonly policy: PermissionPolicy;
  private readonly broker: ApprovalBroker | null;

  constructor(
    policy: PermissionPolicy | null = null,
    broker: ApprovalBroker | BrokerCallable | null = null,
  ) {
    this.policy = policy ?? new PermissionPolicy();
    if (broker === null || broker === undefined) {
      this.broker = null;
    } else if (typeof (broker as ApprovalBroker).approve === "function") {
      this.broker = broker as ApprovalBroker;
    } else {
      this.broker = new CallbackBroker(broker as BrokerCallable);
    }
  }

  async check(request: ApprovalRequest): Promise<Decision> {
    const decision = this.policy.decide(request);
    if (decision !== Decision.ASK) return decision;
    if (this.broker === null) return Decision.DENY;
    return normalizeDecision(await this.broker.approve(request));
  }

  /** Raise PermissionDenied unless the action is allowed. */
  async require(request: ApprovalRequest): Promise<void> {
    const decision = await this.check(request);
    if (decision !== Decision.ALLOW) {
      throw new PermissionDenied(
        `permission denied for ${request.action}` +
          (request.target ? ` on ${request.target}` : "") +
          (request.reason ? ` (${request.reason})` : ""),
      );
    }
  }
}
