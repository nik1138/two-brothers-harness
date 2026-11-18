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
import {
  boxContentWidth,
  clipDisplay,
  renderBox,
  sanitizeDisplayText,
  textWidth,
  wrapDisplay,
} from "../screen.ts";
import { plainTheme, type Theme, type ThemeToken } from "../theme.ts";

/** One option of a structured operator question (the ask_user contract). */
export interface ApprovalQuestionOption {
  label: string;
  description?: string;
  intent?: string;
}

/**
 * Structured operator question riding a parked approval request (additive):
 * when present (with `kind: "question"`), the panel renders the question
 * mode instead of the allow/allow-session/deny decisions.
 */
export interface ApprovalQuestion {
  header?: string;
  text: string;
  /** 2..6 options, in display order. */
  options: ApprovalQuestionOption[];
  /** Multi-select: number keys toggle, Enter confirms the checked set. */
  multi_select?: boolean;
}

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
  /**
   * Additive ask_user kind: `"question"` renders the structured question
   * mode; absent (or `"approval"`) renders the historical approval panel
   * byte-identically.
   */
  kind?: "approval" | "question";
  /** The structured question (present iff `kind === "question"`). */
  question?: ApprovalQuestion;
  /**
   * Additive helper identity: set only when an isolated subagent's tool call
   * parked this request. Display only — the decision keys, hints and the
   * session-allow pair are unchanged, so a brother's own approval renders
   * byte-identically when the fields are absent.
   */
  subagentId?: string;
  subagentLabel?: string;
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
  /**
   * Question mode only: the multi-select checkbox state, parallel to
   * `item.question.options`. Absent for approvals and single-select
   * questions (nothing to toggle), so historical state stays byte-identical.
   */
  checked?: boolean[];
}

/**
 * The structured question an item parks, or null when the panel is in the
 * historical approval mode. A question needs at least two options to render
 * (the ask_user contract bounds it to 2..6); anything else falls back to the
 * approval shape so the panel never renders an empty choice list.
 */
export function approvalItemQuestion(item: ApprovalPanelItem): ApprovalQuestion | null {
  if (item.kind !== "question" || item.question === undefined) return null;
  if (!Array.isArray(item.question.options) || item.question.options.length < 2) return null;
  return item.question;
}

/** Intents the app acts on; the view never resolves a broker itself. */
export type ApprovalKeyAction =
  | "none"
  | "move"
  | "allow"
  | "allow-session"
  | "deny"
  | "preview"
  | "toggle"
  | "answer";

/** Result of folding one keypress into the panel. */
export interface ApprovalKeyResult {
  state: ApprovalPanelState;
  action: ApprovalKeyAction;
  /**
   * `action: "answer"` only: the selected option labels to post (exactly one
   * for a single-select question; the checked set, possibly empty, for
   * multi-select — the app decides whether an empty answer is refused).
   */
  labels?: string[];
}

/** Clamp a decision index into the three-choice range. */
function clampChoice(value: number): number {
  if (!Number.isFinite(value)) return APPROVAL_ALLOW_ONCE;
  return Math.min(APPROVAL_CHOICES.length - 1, Math.max(0, Math.floor(value)));
}

/** Open the panel for one request, highlighting "Allow once" (approvals) or
 * the first option (questions). Multi-select questions start all-unchecked. */
export function createApprovalPanelState(item: ApprovalPanelItem): ApprovalPanelState {
  const question = approvalItemQuestion(item);
  if (question !== null && question.multi_select === true) {
    return { item, selected: 0, checked: question.options.map(() => false) };
  }
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
 * Fold one keypress into a question-mode panel. Number keys 1..9 choose
 * (single-select, immediate answer — the approval-panel idiom) or toggle the
 * checkbox (multi-select); Up/Down and Enter/Esc ride the registry's
 * `approval` scope exactly like the approval decisions, so the footer hints
 * and the behavior cannot disagree. Allow/allow-session/preview chords have
 * no question meaning and fold to "none".
 */
function questionPanelKey(
  commands: readonly TuiCommand[],
  state: ApprovalPanelState,
  key: KeyLike,
  question: ApprovalQuestion,
): ApprovalKeyResult {
  if (
    key.ctrl !== true &&
    key.alt !== true &&
    typeof key.name === "string" &&
    /^[1-9]$/.test(key.name)
  ) {
    const index = Number(key.name) - 1;
    if (index >= question.options.length) return { state, action: "none" };
    const option = question.options[index];
    if (option === undefined) return { state, action: "none" };
    if (question.multi_select === true) {
      const checked = state.checked !== undefined ? [...state.checked] : question.options.map(() => false);
      checked[index] = !checked[index];
      return { state: { ...state, checked }, action: "toggle" };
    }
    return { state, action: "answer", labels: [option.label] };
  }
  const match = resolveKey(commands, key, "approval");
  if (match === null) return { state, action: "none" };
  switch (match.command.id) {
    case "approval-move": {
      const count = question.options.length;
      const delta = match.chord.name.toLowerCase() === "up" ? -1 : 1;
      const selected = (((state.selected + delta) % count) + count) % count;
      return { state: { ...state, selected }, action: "move" };
    }
    case "approval-accept": {
      if (question.multi_select === true) {
        const checked = state.checked ?? question.options.map(() => false);
        const labels = question.options
          .filter((_, index) => checked[index] === true)
          .map((option) => option.label);
        return { state, action: "answer", labels };
      }
      const index = Math.min(question.options.length - 1, Math.max(0, Math.floor(state.selected)));
      const option = question.options[index];
      if (option === undefined) return { state, action: "none" };
      return { state, action: "answer", labels: [option.label] };
    }
    case "approval-deny":
      // Esc (and the deny chord) decline — the core maps it to "operator
      // declined to answer" through the existing deny body.
      return { state, action: "deny" };
    default:
      return { state, action: "none" };
  }
}

/**
 * Fold one keypress into the panel. Keys come from the registry's `approval`
 * scope (including Escape = deny), so the panel footer hints and the behavior
 * cannot disagree. Number/mnemonic decisions are answered immediately;
 * Up/Down move the highlight and Enter answers with it. A structured question
 * (`kind: "question"`) folds through {@link questionPanelKey} instead; an item
 * without one keeps the historical approval behavior byte-for-byte.
 */
export function approvalPanelKey(
  commands: readonly TuiCommand[],
  state: ApprovalPanelState,
  key: KeyLike,
): ApprovalKeyResult {
  const question = approvalItemQuestion(state.item);
  if (question !== null) return questionPanelKey(commands, state, key, question);
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
  /** Registry commands whose effective chords drive the hint row (default `TUI_COMMANDS`). */
  commands?: readonly TuiCommand[];
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
 * The question panel's key-hint row, derived from the registry exactly like
 * the approval footer: move/confirm/decline (single-select labels the confirm
 * chord "choose", multi-select "confirm").
 */
export function questionPanelHints(
  commands: readonly TuiCommand[] = TUI_COMMANDS,
  question?: ApprovalQuestion,
): string {
  const hints: { id: string; label: string }[] = [
    { id: "approval-move", label: "move" },
    {
      id: "approval-accept",
      label: question !== undefined && question.multi_select === true ? "confirm" : "choose",
    },
    { id: "approval-deny", label: "decline" },
  ];
  return hintSegments(commands, hints);
}

/** Rows of wrapped question text kept before clipping. */
const MAX_QUESTION_TEXT_ROWS = 4;

/**
 * One question option row, width-safe at `contentWidth`: the marker and the
 * numbered label (`1) label`), the dimmed ` — description` and the dimmed
 * `[intent]` tag. Overflow truncates the description first, then the label
 * (the ask_user fit rule), each with an honest ellipsis.
 */
function questionOptionRow(
  index: number,
  option: ApprovalQuestionOption,
  selected: boolean,
  checked: boolean | undefined,
  multi: boolean,
  contentWidth: number,
  theme: Theme,
): string {
  const marker = selected ? "› " : "  ";
  const box = multi ? (checked === true ? "[x] " : "[ ] ") : "";
  const lead = `${marker}${box}${index + 1}) `;
  const budget = Math.max(0, contentWidth - textWidth(lead));
  let label = sanitizeDisplayText(option.label);
  let desc = option.description !== undefined && option.description !== "" ? ` — ${option.description}` : "";
  let intent = option.intent !== undefined && option.intent !== "" ? ` [${option.intent}]` : "";
  if (textWidth(label) + textWidth(desc) + textWidth(intent) > budget) {
    // Truncate the description first, then the label.
    const descBudget = budget - textWidth(label) - textWidth(intent);
    desc = descBudget >= 4 ? clipDisplay(desc, descBudget) : "";
    if (textWidth(label) + textWidth(desc) + textWidth(intent) > budget) {
      const labelBudget = budget - textWidth(desc) - textWidth(intent);
      label = labelBudget >= 2 ? clipDisplay(label, labelBudget) : clipDisplay(label, budget);
      if (textWidth(label) + textWidth(desc) + textWidth(intent) > budget) {
        intent = intent === "" ? "" : clipDisplay(intent, Math.max(1, budget - textWidth(label) - textWidth(desc)));
      }
    }
  }
  const tone: ThemeToken = selected ? "focus" : "text";
  let row = theme.paint(tone, `${lead}${label}`);
  if (desc !== "") row += theme.paint("dim", desc);
  if (intent !== "") row += theme.paint("dim", intent);
  return row;
}

/**
 * Render the docked panel in question mode as a full-width box.
 *
 * Layout: the optional header (bold), the bounded wrapped question text, the
 * numbered option rows (`1) label — description [intent]`, description and
 * intent dimmed), a confirm row for multi-select, the registry key hints and
 * the honest pause note. Single-select answers on the number key immediately
 * (no confirm row); multi-select toggles checkboxes and confirms with Enter.
 */
function questionPanelView(
  state: ApprovalPanelState,
  options: ApprovalPanelRenderOptions,
  question: ApprovalQuestion,
): ApprovalPanelView {
  const width = Number.isFinite(options.width) ? Math.max(0, Math.floor(options.width)) : 0;
  const theme = options.theme ?? plainTheme;
  if (width === 0) return { lines: [], selectedRow: -1 };
  const contentWidth = Math.max(1, boxContentWidth(width));
  const rows: string[] = [];
  const pushWrapped = (text: string, tone: ThemeToken, maxRows: number): void => {
    const wrapped = clipRows(wrapDisplay(sanitizeDisplayText(text), contentWidth), maxRows);
    for (const row of wrapped) rows.push(row === "" ? "" : theme.paint(tone, row));
  };

  if (question.header !== undefined && question.header !== "") {
    pushWrapped(question.header, "strong", MAX_TARGET_ROWS);
  }
  pushWrapped(question.text, "text", MAX_QUESTION_TEXT_ROWS);

  const helperLabel =
    state.item.subagentLabel !== undefined && state.item.subagentLabel !== ""
      ? state.item.subagentLabel
      : state.item.subagentId !== undefined && state.item.subagentId !== ""
        ? state.item.subagentId
        : "";
  if (helperLabel !== "") {
    rows.push(theme.paint("dim", `helper: ${sanitizeDisplayText(helperLabel)}`));
  }

  rows.push("");
  const multi = question.multi_select === true;
  const selected = Math.min(question.options.length - 1, Math.max(0, Math.floor(state.selected)));
  let selectedRow = -1;
  question.options.forEach((option, index) => {
    if (index === selected) selectedRow = rows.length;
    rows.push(
      questionOptionRow(index, option, index === selected, state.checked?.[index], multi, contentWidth, theme),
    );
  });
  if (multi) {
    const checkedCount = question.options.filter((_, index) => state.checked?.[index] === true).length;
    const confirm = theme.paint("focus", "› ") + theme.paint("text", "Confirm");
    rows.push(
      confirm +
        (checkedCount > 0
          ? theme.paint("dim", ` (${checkedCount} selected)`)
          : theme.paint("dim", " — select at least one option")),
    );
  }
  rows.push("");
  for (const row of wrapDisplay(questionPanelHints(options.commands ?? TUI_COMMANDS, question), contentWidth)) {
    rows.push(theme.paint("dim", row));
  }
  for (const row of wrapDisplay(
    multi
      ? "Number keys toggle options · Enter confirms the selection · Esc declines." +
          " The composer is paused until you answer."
      : "Press a number to answer · Up/Down move and Enter chooses · Esc declines." +
          " The composer is paused until you answer.",
    contentWidth,
  )) {
    rows.push(theme.paint("muted", row));
  }

  const lines = renderBox(rows, { width, title: "OPERATOR QUESTION", tone: "accent", theme });
  return {
    lines,
    selectedRow: selectedRow >= 0 && selectedRow + 2 <= lines.length ? selectedRow + 1 : -1,
  };
}

/**
 * Render the docked approval panel as a full-width box.
 *
 * Layout: action/target/command/reason, the bounded diff summary, the three
 * numbered decisions (highlighted row marked), the registry key hints and the
 * honest session-scope note ("for this TUI session only"). A structured
 * question (`kind: "question"`) renders the question mode instead; an item
 * without one keeps the historical approval rendering byte-identical. A zero
 * width renders nothing; the box helpers keep every row width-safe, including
 * CJK and emoji content.
 */
export function approvalPanelView(
  state: ApprovalPanelState,
  options: ApprovalPanelRenderOptions,
): ApprovalPanelView {
  const width = Number.isFinite(options.width) ? Math.max(0, Math.floor(options.width)) : 0;
  const theme = options.theme ?? plainTheme;
  if (width === 0) return { lines: [], selectedRow: -1 };
  const question = approvalItemQuestion(state.item);
  if (question !== null) return questionPanelView(state, options, question);
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
  // Helper identity, whenever a child parked the request: the operator must be
  // able to tell who asked. A brother's own approval carries no such fields and
  // renders exactly as before.
  const helperLabel =
    item.subagentLabel !== undefined && item.subagentLabel !== ""
      ? item.subagentLabel
      : item.subagentId !== undefined && item.subagentId !== ""
        ? item.subagentId
        : "";
  if (helperLabel !== "") {
    rows.push(theme.paint("dim", `helper: ${sanitizeDisplayText(helperLabel)}`));
  }
  const summary = detailSummary(item);
  if (summary !== "") rows.push(theme.paint("dim", summary));

  rows.push("");
  const selected = selectedApprovalChoice(state);
  rows.push(choiceRow(0, selected === APPROVAL_ALLOW_ONCE, theme));
  rows.push(choiceRow(1, selected === APPROVAL_ALLOW_SESSION, theme));
  rows.push(choiceRow(2, selected === APPROVAL_DENY, theme));
  rows.push("");
  for (const row of wrapDisplay(approvalPanelHints(options.commands ?? TUI_COMMANDS, item), contentWidth)) {
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
