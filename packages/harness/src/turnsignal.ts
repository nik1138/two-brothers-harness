/**
 * Per-turn cooperative cancellation for a CLI `run` / `chat` turn.
 *
 * A turn owns an `AbortController`; the handlers installed here translate the
 * first process signal (SIGINT, SIGTERM, and SIGHUP on POSIX) into one
 * cooperative abort, and a second signal into an immediate conventional exit.
 * The caller then waits for the turn to settle with a bounded budget sized
 * from `SHELL_DRAIN_BUDGET_MS`, so a Ctrl+C can never kill the process while a
 * `run_shell` child tree is still being killed/drained.
 *
 * This module is deliberately dependency-free and side-effect-free: it never
 * touches `process` unless the caller leaves `emitter` out, and it never calls
 * `process.exit` itself. Tests drive a fake emitter; the CLI injects the real
 * process.
 */
import { SHELL_DRAIN_BUDGET_MS } from "./shell.ts";

/** Signals a CLI turn reacts to. SIGHUP is POSIX-only. */
export type TurnSignalName = "SIGINT" | "SIGTERM" | "SIGHUP";

/**
 * How long the CLI waits for a cancelled turn to unwind before it stops
 * waiting. `run_shell` kills the child tree and then drains for up to
 * {@link SHELL_DRAIN_BUDGET_MS}; the margin keeps the wait above that bound.
 */
export const TURN_CANCEL_BUDGET_MS = SHELL_DRAIN_BUDGET_MS + 1_000;

/** Conventional 128 + signal-number exit codes. */
export const TURN_SIGNAL_EXIT_CODES: Readonly<Record<TurnSignalName, number>> = Object.freeze({
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
});

/**
 * The signals handled on `platform` — SIGHUP only on POSIX. Windows can emit
 * SIGHUP when the console closes, but force-terminates the process about 10 s
 * later; it is deliberately omitted rather than claiming a cleanup window we
 * cannot guarantee.
 */
export function turnSignalsForPlatform(platform: string = process.platform): TurnSignalName[] {
  return platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
}

/** The conventional exit code for one cancellation signal. */
export function turnSignalExitCode(signal: TurnSignalName): number {
  return TURN_SIGNAL_EXIT_CODES[signal];
}

/**
 * The one bounded stderr notice printed on the first signal. Plain text (no
 * ANSI), one line, and it names how to leave immediately if the signal is
 * repeated.
 */
export function turnCancelNotice(signal: TurnSignalName): string {
  const repeat = signal === "SIGINT" ? "press Ctrl+C again" : `send ${signal} again`;
  return `[two-brothers] ${signal} received — cancelling the active turn (${repeat} to exit immediately)`;
}

/** The small part of an EventEmitter the handler installer needs. */
export interface TurnSignalEmitter {
  on(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
}

export interface TurnSignalHandlerOptions {
  /** Signal source; defaults to the real process. */
  emitter?: TurnSignalEmitter;
  /** Platform string; defaults to `process.platform`. Injectable for tests. */
  platform?: string;
  /**
   * Extra SIGINT-only sources installed alongside the process handlers. The
   * chat REPL passes its readline interface here: while a turn is active,
   * readline consumes a terminal Ctrl+C itself, so the process signal would
   * never fire. The listener is removed when the turn settles, so an idle
   * REPL keeps readline's prior Ctrl+C behavior.
   */
  sigintEmitters?: TurnSignalEmitter[];
  /** First signal: cooperatively cancel the active turn. */
  onCancel: (signal: TurnSignalName) => void;
  /** Second signal: exit immediately with the conventional code. */
  onForceExit: (code: number, signal: TurnSignalName) => void;
  /** First signal notice (stderr in the CLI); optional for embedders/tests. */
  onNotice?: (line: string, signal: TurnSignalName) => void;
}

export interface TurnSignalHandlers {
  /** The signal that cancelled this turn, or `null` while it is healthy. */
  readonly cancelledBy: TurnSignalName | null;
  /** True after the first signal. */
  readonly cancelled: boolean;
  /** True after a second signal asked for an immediate exit. */
  readonly forced: boolean;
  /** Remove every listener. Idempotent; safe on every exit path. */
  dispose(): void;
}

/**
 * Install the turn's signal handlers. The first handled signal cancels, a
 * later one forces an exit; the caller owns `dispose()`.
 */
export function installTurnSignalHandlers(
  options: TurnSignalHandlerOptions,
): TurnSignalHandlers {
  const root = options.emitter ?? (process as unknown as TurnSignalEmitter);
  const platform = options.platform ?? process.platform;
  const registered: Array<{
    target: TurnSignalEmitter;
    event: TurnSignalName;
    listener: () => void;
  }> = [];
  let cancelledBy: TurnSignalName | null = null;
  let forced = false;
  let disposed = false;

  const handle = (signal: TurnSignalName): void => {
    if (disposed || forced) return;
    if (cancelledBy !== null) {
      forced = true;
      options.onForceExit(turnSignalExitCode(signal), signal);
      return;
    }
    cancelledBy = signal;
    try {
      options.onNotice?.(turnCancelNotice(signal), signal);
    } catch {
      // a broken sink must never block cancellation
    }
    try {
      options.onCancel(signal);
    } catch {
      // cancellation is best effort; the bounded wait still bounds the turn
    }
  };

  const register = (target: TurnSignalEmitter, event: TurnSignalName): void => {
    const listener = (): void => handle(event);
    target.on(event, listener);
    registered.push({ target, event, listener });
  };

  for (const signal of turnSignalsForPlatform(platform)) register(root, signal);
  // Extra sources carry Ctrl+C only (the chat REPL's readline interface).
  for (const target of options.sigintEmitters ?? []) register(target, "SIGINT");

  return {
    get cancelledBy(): TurnSignalName | null {
      return cancelledBy;
    },
    get cancelled(): boolean {
      return cancelledBy !== null;
    },
    get forced(): boolean {
      return forced;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const entry of registered.splice(0)) {
        try {
          entry.target.off(entry.event, entry.listener);
        } catch {
          // removing a listener from an already-closed stream is harmless
        }
      }
    },
  };
}

/** Outcome of a turn that was raced against its cancellation. */
export type TurnWaitOutcome<T> =
  | { status: "settled"; value: T }
  | { status: "rejected"; error: unknown }
  | { status: "timeout" };

const CANCELLED = null;

/**
 * Await a turn's promise. Until a cancellation arrives the wait is unbounded
 * (a normal long run must finish); once it does, the remaining unwind is
 * capped at `budgetMs` so shutdown never hangs. A timeout does not cancel or
 * kill anything — the caller decides how to report it.
 */
export function waitForTurnOutcome<T>(
  work: Promise<T>,
  cancellation: Promise<unknown>,
  budgetMs: number = TURN_CANCEL_BUDGET_MS,
): Promise<TurnWaitOutcome<T>> {
  const settled: Promise<TurnWaitOutcome<T>> = work.then(
    (value) => ({ status: "settled", value }),
    (error) => ({ status: "rejected", error }),
  );
  const cancelled = cancellation.then(() => CANCELLED);
  return Promise.race([settled, cancelled]).then((first) => {
    if (first !== CANCELLED) return first;
    return settleWithin(settled, budgetMs);
  });
}

function settleWithin<T>(
  work: Promise<TurnWaitOutcome<T>>,
  budgetMs: number,
): Promise<TurnWaitOutcome<T>> {
  return new Promise<TurnWaitOutcome<T>>((resolve) => {
    let done = false;
    const finish = (outcome: TurnWaitOutcome<T>): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ status: "timeout" }), Math.max(0, budgetMs));
    work.then(finish, (error) => finish({ status: "rejected", error }));
  });
}
