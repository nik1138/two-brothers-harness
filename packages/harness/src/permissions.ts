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
 * The broker interface is intentionally tiny and async-friendly so a UI can
 * pause a cooperation loop, surface the request to the operator, and resume
 * with their answer. DeepAgents-style decisions are accepted:
 * "approve"/"allow" → allow, "edit"/"ask" → ask again,
 * "reject"/"deny" → deny.
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

/** Decides which actions need operator approval. */
export class PermissionPolicy {
  readonly autoAllowRead: boolean;

  constructor(autoAllowRead = true) {
    this.autoAllowRead = autoAllowRead;
  }

  decide(request: ApprovalRequest): Decision {
    if (READ_ONLY_ACTIONS.has(request.action) && this.autoAllowRead) {
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
