/**
 * Pure docked approval panel for the TUI.
 *
 * When a workspace-bound run parks on an operator approval, the composer is
 * replaced by this panel: the request's action/target/command/reason, a
 * one-line diff summary, and the numbered decisions — 1 Allow once,
 * 2 Always allow this session, 3 Deny — with the answer keys derived from the
 * single keymap registry (`approval` scope). The panel never answers anything
 * by itself: it returns intents, and the app is the only caller of the
 * `RunApprovalBroker` (`respond` / `allowForSession`).
 *
 * Rendering is width-safe (every row is exactly `width` cells), theme-token
 * only (no raw SGR here; `plainTheme` output is plain text), and bounded: a
 * long reason/command/diff summary wraps to at most a few rows so the choice
 * rows and key hints stay on screen at small terminal heights.
 *
 * Provenance: the panel shape (typed detail blocks, numbered decisions, key
 * hints, diff/command preview) is adapted from kimi-code's MIT TUI approval
 * panel (research/vendor/kimi-code) — translated onto this theme/keymap
 * architecture; no upstream code was copied.
 */
import type { ApprovalDetail } from "../../permissions.ts";
import {
  hintSegments,
  resolveKey,
  TUI_COMMANDS,
  type KeyLike,
  type TuiCommand,
} from "../keymap.ts";
import { boxContentWidth, renderBox, sanitizeDisplayText, wrapDisplay } from "../screen.ts";
import { plainTheme, type Theme, type ThemeToken } from "../theme.ts";

/** One parked approval as the panel renders it (a bounded operator view). */
export interface ApprovalPanelItem {
  /** Broker approval id used to answer the request. */
  approvalId: string;
  /** Workspace action (`write`, `edit`, `delete`, `shell`). */
  action: string;
  /** Workspace-relative target path (absent for shell). */
  target?: string;
  /** Shell command (Action.SHELL only). */
  command?: string;
  /** Why the action needs approval (sensitive-path note, etc.). */
  reason?: string;
  /** Additive bounded preview populated by `workspace.ts`. */
  detail?: ApprovalDetail;
}

/** The three operator decisions, in display/selection order. */
export const APPROVAL_CHOICES = [
  "Allow once",
  "Always allow this session",
  "Deny",
] as const;

/** Selected row index into `APPROVAL_CHOICES`. */
export const APPROVAL_ALLOW_ONCE = 0;
export const APPROVAL_ALLOW_SESSION = 1;
export const APPROVAL_DENY = 2;

/** Immutable panel state: the request plus the highlighted decision. */
export interface ApprovalPanelState {
  item: ApprovalPanelItem;
  selected: number;
}

/** Intents the app acts on; the view never resolves a broker itself. */
export type ApprovalKeyAction =
  | "none"
  | "move"
  | "allow"
  | "allow-session"
  | "deny"
  | "preview";

/** Result of folding one keypress into the panel. */
export interface ApprovalKeyResult {
  state: ApprovalPanelState;
  action: ApprovalKeyAction;
}

/** Clamp a decision index into the three-choice range. */
function clampChoice(value: number): number {
  if (!Number.isFinite(value)) return APPROVAL_ALLOW_ONCE;
  return Math.min(APPROVAL_CHOICES.length - 1, Math.max(0, Math.floor(value)));
}

/** Open the panel for one request, highlighting "Allow once". */
export function createApprovalPanelState(item: ApprovalPanelItem): ApprovalPanelState {
  return { item, selected: APPROVAL_ALLOW_ONCE };
}

/** Move the highlighted decision with wrap-around. */
export function moveApprovalChoice(state: ApprovalPanelState, delta: number): ApprovalPanelState {
  const count = APPROVAL_CHOICES.length;
  const base = clampChoice(state.selected);
  const selected = (((base + Math.floor(delta)) % count) + count) % count;
  return { ...state, selected };
}

/** The highlighted decision's index. */
export function selectedApprovalChoice(state: ApprovalPanelState): number {
  return clampChoice(state.selected);
}

/** True when `Ctrl+E` has something to show for this request. */
export function approvalHasPreview(item: ApprovalPanelItem): boolean {
  return (item.detail?.diff ?? "") !== "" || (item.detail?.command ?? item.command ?? "") !== "";
}

/**
 * Fold one keypress into the panel. Keys come from the registry's `approval`
 * scope (including Escape = deny), so the panel footer hints and the behavior
 * cannot disagree. Number/mnemonic decisions are answered immediately;
 * Up/Down move the highlight and Enter answers with it.
 */
export function approvalPanelKey(
  commands: readonly TuiCommand[],
  state: ApprovalPanelState,
  key: KeyLike,
): ApprovalKeyResult {
  const match = resolveKey(commands, key, "approval");
  if (match === null) return { state, action: "none" };
  switch (match.command.id) {
    case "approval-move": {
      const delta = match.chord.name.toLowerCase() === "up" ? -1 : 1;
      return { state: moveApprovalChoice(state, delta), action: "move" };
    }
    case "approval-accept": {
      const selected = selectedApprovalChoice(state);
      if (selected === APPROVAL_ALLOW_SESSION) return { state, action: "allow-session" };
      if (selected === APPROVAL_DENY) return { state, action: "deny" };
      return { state, action: "allow" };
    }
    case "approval-allow":
      return { state, action: "allow" };
    case "approval-allow-session":
      return { state, action: "allow-session" };
    case "approval-deny":
      return { state, action: "deny" };
    case "approval-preview":
      return { state, action: approvalHasPreview(state.item) ? "preview" : "none" };
    default:
      return { state, action: "none" };
  }
}

/** Render options for the docked panel. */
export interface ApprovalPanelRenderOptions {
  /** Terminal width; every row is exactly this many cells. */
  width: number;
  theme?: Theme;
}

/** The rendered docked panel. */
export interface ApprovalPanelView {
  lines: string[];
  /** Line index (within `lines`) of the highlighted decision row. */
  selectedRow: number;
}

/** Rows of wrapped reason/command text kept before clipping. */
const MAX_DETAIL_ROWS = 3;
/** Rows of wrapped path text kept before clipping. */
const MAX_TARGET_ROWS = 2;

/** Return `rows` clipped to `max`, with an honest ellipsis on the last kept row. */
function clipRows(rows: string[], max: number): string[] {
  if (max <= 0) return [];
  if (rows.length <= max) return rows;
  const kept = rows.slice(0, max);
  const last = kept[kept.length - 1] ?? "";
  kept[kept.length - 1] = `${last}…`;
  return kept;
}

function detailSummary(item: ApprovalPanelItem): string {
  const detail = item.detail;
  if (detail === undefined) return "";
  if (detail.kind === "shell" || (detail.command ?? "") !== "") {
    return "command preview";
  }
  const added = detail.addedLines ?? 0;
  const removed = detail.removedLines ?? 0;
  const parts = [`diff +${added}/-${removed} lines`];
  if (detail.truncated === true) parts.push("diff preview clipped");
  return parts.join(" · ");
}

function choiceRow(
  index: number,
  selected: boolean,
  theme: Theme,
): string {
  const marker = selected ? "› " : "  ";
  const label = `[${index + 1}] ${APPROVAL_CHOICES[index]}`;
  const tone: ThemeToken =
    selected ? (index === APPROVAL_DENY ? "error" : "focus") : "text";
  return theme.paint(tone, `${marker}${label}`);
}

/**
 * The panel's key-hint row, derived from the registry exactly like every
 * other view footer (`APPROVAL ...` never spells a shortcut itself).
 */
export function approvalPanelHints(
  commands: readonly TuiCommand[] = TUI_COMMANDS,
  item?: ApprovalPanelItem,
): string {
  const hints: { id: string; label: string }[] = [
    { id: "approval-move", label: "move" },
    { id: "approval-accept", label: "choose" },
    { id: "approval-allow", label: "allow once" },
    { id: "approval-allow-session", label: "allow session" },
    { id: "approval-deny", label: "deny" },
  ];
  if (item !== undefined && approvalHasPreview(item)) {
    hints.push({ id: "approval-preview", label: "preview" });
  }
  return hintSegments(commands, hints);
}

/**
 * Render the docked approval panel as a full-width box.
 *
 * Layout: action/target/command/reason, the bounded diff summary, the three
 * numbered decisions (highlighted row marked), the registry key hints and the
 * honest session-scope note ("for this TUI session only"). A zero width
 * renders nothing; the box helpers keep every row width-safe, including CJK
 * and emoji content.
 */
export function approvalPanelView(
  state: ApprovalPanelState,
  options: ApprovalPanelRenderOptions,
): ApprovalPanelView {
  const width = Number.isFinite(options.width) ? Math.max(0, Math.floor(options.width)) : 0;
  const theme = options.theme ?? plainTheme;
  if (width === 0) return { lines: [], selectedRow: -1 };
  const item = state.item;
  const contentWidth = Math.max(1, boxContentWidth(width));
  const rows: string[] = [];
  const pushWrapped = (
    text: string,
    tone: ThemeToken,
    maxRows: number,
    prefix = "",
  ): void => {
    const wrapped = clipRows(wrapDisplay(prefix + sanitizeDisplayText(text), contentWidth), maxRows);
    for (const row of wrapped) rows.push(row === "" ? "" : theme.paint(tone, row));
  };

  // Action and target first: they are the "what" of the decision.
  const target = item.target !== undefined && item.target !== "" ? ` · ${item.target}` : "";
  pushWrapped(`${item.action}${target}`, "strong", MAX_TARGET_ROWS);
  if (item.command !== undefined && item.command !== "") {
    pushWrapped(`$ ${item.command}`, "accent", MAX_DETAIL_ROWS);
  }
  if (item.reason !== undefined && item.reason !== "") {
    pushWrapped(item.reason, "muted", MAX_DETAIL_ROWS);
  }
  const summary = detailSummary(item);
  if (summary !== "") rows.push(theme.paint("dim", summary));

  rows.push("");
  const selected = selectedApprovalChoice(state);
  rows.push(choiceRow(0, selected === APPROVAL_ALLOW_ONCE, theme));
  rows.push(choiceRow(1, selected === APPROVAL_ALLOW_SESSION, theme));
  rows.push(choiceRow(2, selected === APPROVAL_DENY, theme));
  rows.push("");
  for (const row of wrapDisplay(approvalPanelHints(TUI_COMMANDS, item), contentWidth)) {
    rows.push(theme.paint("dim", row));
  }
  for (const row of wrapDisplay(
    "Always allow is remembered for this TUI session only (not saved to settings)." +
      " The composer is paused until you answer.",
    contentWidth,
  )) {
    rows.push(theme.paint("muted", row));
  }

  const title = `APPROVAL REQUIRED · ${item.action}`.toUpperCase();
  const lines = renderBox(rows, { width, title, tone: "warning", theme });
  const selectedRow = rows.indexOf(choiceRow(selected, true, theme)) + 2;
  return {
    lines,
    selectedRow: selectedRow > 1 && selectedRow <= lines.length ? selectedRow - 1 : -1,
  };
}

/** Convenience wrapper returning only the rendered rows. */
export function renderApprovalPanel(
  state: ApprovalPanelState,
  options: ApprovalPanelRenderOptions,
): string[] {
  return approvalPanelView(state, options).lines;
}

/** Full-screen preview content for the pending request. */
export interface ApprovalPreview {
  title: string;
  message: string;
  details: string;
}

/**
 * The full-screen (`Ctrl+E`) preview as dialog content: the bounded unified
 * diff for write/edit/delete, or the shell command, plus the request header.
 * `null` when the request carries nothing previewable (the caller then keeps
 * the approval parked and reports the no-op honestly).
 */
export function approvalPreview(item: ApprovalPanelItem): ApprovalPreview | null {
  const detail = item.detail;
  const command = item.command !== undefined && item.command !== ""
    ? item.command
    : (detail?.command ?? "");
  const diff = detail?.diff ?? "";
  const heading =
    item.target !== undefined && item.target !== ""
      ? `${item.action} ${item.target}`
      : `${item.action}${command !== "" ? `: ${command}` : ""}`;
  if (diff !== "") {
    const clipped = detail?.truncated === true ? "\n[diff preview clipped]" : "";
    return {
      title: "APPROVAL PREVIEW",
      message: heading,
      details: `${diff}${clipped}`,
    };
  }
  if (command !== "") {
    return { title: "APPROVAL PREVIEW", message: heading, details: `$ ${command}` };
  }
  return null;
}
