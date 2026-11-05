import type { KeyLike } from "../keymap.ts";
import { boxContentWidth, renderBox, wrapDisplay } from "../screen.ts";
import { plainTheme, type Theme, type ThemeToken } from "../theme.ts";

export interface DialogAction {
  id: string;
  label: string;
  disabled?: boolean;
  tone?: ThemeToken;
}

export interface DialogState {
  title: string;
  message: string;
  details?: string;
  showDetails?: boolean;
  actions: readonly DialogAction[];
  selected: number;
  tone?: ThemeToken;
}

export interface DialogRenderOptions {
  width: number;
  height?: number;
  maxWidth?: number;
  theme?: Theme;
}

export interface DialogView {
  lines: string[];
  selectedRow: number;
}

export type DialogKeyAction = "none" | "move" | "close" | "accept" | "blocked" | "details";

export interface DialogKeyResult {
  state: DialogState;
  action: DialogKeyAction;
  actionId?: string;
}

export function createDialog(input: Omit<DialogState, "selected"> & { selected?: number }): DialogState {
  const max = Math.max(0, input.actions.length - 1);
  return { ...input, selected: Math.min(Math.max(0, Math.floor(input.selected ?? 0)), max) };
}

export function moveDialogSelection(state: DialogState, delta: number): DialogState {
  if (state.actions.length === 0) return { ...state, selected: 0 };
  const count = state.actions.length;
  const selected = ((state.selected + Math.floor(delta)) % count + count) % count;
  return { ...state, selected };
}

/** Fold common dialog keys without touching application focus or state. */
export function handleDialogKey(state: DialogState, key: KeyLike): DialogKeyResult {
  const name = key.name.toLowerCase();
  if (name === "escape" || name === "esc") return { state, action: "close" };
  if (name === "tab" || name === "right" || name === "down") {
    return { state: moveDialogSelection(state, key.shift === true ? -1 : 1), action: "move" };
  }
  if (name === "left" || name === "up") {
    return { state: moveDialogSelection(state, -1), action: "move" };
  }
  if (name === "d" && state.details !== undefined) {
    return { state: { ...state, showDetails: state.showDetails !== true }, action: "details" };
  }
  if (name === "return" || name === "enter") {
    const selected = state.actions[state.selected];
    if (selected === undefined) return { state, action: "none" };
    if (selected.disabled === true) return { state, action: "blocked", actionId: selected.id };
    return { state, action: "accept", actionId: selected.id };
  }
  return { state, action: "none" };
}

/** Render a message, optional full details and explicit actions in a box. */
export function dialogView(state: DialogState, options: DialogRenderOptions): DialogView {
  const availableWidth = Math.max(0, Math.floor(options.width));
  if (availableWidth === 0 || options.height === 0) return { lines: [], selectedRow: -1 };
  const width = Math.min(availableWidth, Math.max(4, Math.floor(options.maxWidth ?? 72)));
  const height = options.height === undefined ? undefined : Math.max(0, Math.floor(options.height));
  const theme = options.theme ?? plainTheme;
  const tone = state.tone ?? "border";
  const contentWidth = Math.max(1, boxContentWidth(width));
  const messageRows = wrapDisplay(state.message, contentWidth).map((row) => theme.paint(tone === "border" ? "text" : tone, row));
  if (state.details !== undefined && state.details !== "") {
    messageRows.push(theme.paint("dim", state.showDetails === true ? "Details:" : "Press d for details."));
    if (state.showDetails === true) {
      for (const row of wrapDisplay(state.details, contentWidth)) messageRows.push(theme.paint("dim", row));
    }
  }
  const actionRows = state.actions.map((action, index) => {
    const marker = index === state.selected ? "›" : " ";
    const disabled = action.disabled === true ? " (unavailable)" : "";
    const text = `${marker} [ ${action.label}${disabled} ]`;
    return theme.paint(action.tone ?? (index === state.selected ? "focus" : "text"), text);
  });

  let body = [...messageRows, ...(messageRows.length > 0 && actionRows.length > 0 ? [""] : []), ...actionRows];
  let selectedRow = -1;
  if (height !== undefined) {
    const capacity = Math.max(0, height - 2);
    if (body.length > capacity) {
      const actionCount = Math.min(actionRows.length, capacity);
      const actionStart = Math.min(
        Math.max(0, state.selected - Math.floor(actionCount / 2)),
        Math.max(0, actionRows.length - actionCount),
      );
      const keptActions = actionRows.slice(actionStart, actionStart + actionCount);
      const remaining = Math.max(0, capacity - keptActions.length);
      body = [...messageRows.slice(0, remaining), ...keptActions];
    }
    while (body.length < capacity) body.push("");
  }
  if (actionRows.length > 0) {
    const selectedAction = actionRows[state.selected];
    selectedRow = selectedAction === undefined ? -1 : body.indexOf(selectedAction) + 1;
  }
  const lines = renderBox(body, { width, title: state.title, tone, theme });
  if (height !== undefined) {
    lines.splice(height);
    while (lines.length < height) lines.push("");
  }
  return { lines, selectedRow };
}

export function renderDialog(state: DialogState, options: DialogRenderOptions): string[] {
  return dialogView(state, options).lines;
}

export interface ErrorDialogOptions extends DialogRenderOptions {
  title?: string;
  retryable?: boolean;
}

/** Convert an unknown thrown value to an actionable, sanitized error dialog. */
export function renderErrorDialog(error: unknown, options: ErrorDialogOptions): string[] {
  const message = error instanceof Error ? error.message : String(error);
  const details = error instanceof Error && error.stack !== undefined ? error.stack : undefined;
  const actions: DialogAction[] = [
    ...(options.retryable === true ? [{ id: "retry", label: "Retry", tone: "warning" as const }] : []),
    { id: "close", label: "Close" },
  ];
  return renderDialog(createDialog({
    title: options.title ?? "ERROR",
    message,
    ...(details !== undefined ? { details } : {}),
    actions,
    tone: "error",
  }), options);
}
