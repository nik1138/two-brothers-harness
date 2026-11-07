/**
 * Pure `/provider` connect surface for the TUI.
 *
 * The TUI has no text composer inside modal dialogs, so this view owns a tiny
 * keyboard-first form: pick a role, then either a named provider preset (seed
 * or stored override) with one of its model ids, or a manual connection
 * (Base URL / model / API key). The API key is the only secret: its editor
 * buffer lives in this state while the operator types it and is rendered as
 * bullets, never as text; the committed value is handed to the app, which is
 * the only caller of the atomic settings-store save.
 *
 * Everything here is deterministic, terminal-free and width-safe: rows are
 * built through `renderBox`/`clipDisplay`, list content is windowed to the
 * requested height, and `plainTheme` output is plain text. The view returns
 * intents; it never writes settings and never resolves a provider itself.
 */
import {
  createEditor,
  graphemeCount,
  handleEditorKey,
  type EditorState,
} from "../editor.ts";
import type { KeyLike } from "../keymap.ts";
import { hintSegments, TUI_COMMANDS } from "../keymap.ts";
import type {
  ProviderConnectRequest,
  ProviderPresetChoice,
  ProviderRoleSummary,
} from "../providers.ts";
import {
  boxContentWidth,
  clipDisplay,
  fitStyled,
  renderBox,
} from "../screen.ts";
import { plainTheme, type Theme, type ThemeToken } from "../theme.ts";

/** The two role summaries and the preset table the dialog offers. */
export interface ProviderConnectData {
  roles: readonly ProviderRoleSummary[];
  presets: readonly ProviderPresetChoice[];
}

/** Which screen of the connect flow is open. */
export type ProviderConnectStage = "roles" | "presets" | "presetModel" | "manual";

/** One manually typed field. */
export type ProviderManualField = "baseUrl" | "model" | "apiKey";

/** Committed manual-connection values (the API key is memory-only). */
export interface ProviderManualDraft {
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** Immutable state of the connect flow. */
export interface ProviderConnectState {
  stage: ProviderConnectStage;
  role: "senior" | "junior";
  /** Highlighted row/field within the current stage. */
  selected: number;
  /** Preset chosen for the model stage (absent outside it). */
  presetName?: string;
  /** Manual form values (API key is never rendered, only masked). */
  manual: ProviderManualDraft;
  /** Field being edited right now (`null` while browsing). */
  editing: ProviderManualField | null;
  /** Single-line editor for the field being edited. */
  editor: EditorState;
  /** Real save/validation error from the app (kept until the next action). */
  error: string | null;
}

/** Intents the app acts on (the view never persists anything). */
export type ProviderConnectAction =
  | { type: "none" }
  | { type: "close" }
  | { type: "save"; request: ProviderConnectRequest };

/** Options for {@link providerConnectView}. */
export interface ProviderConnectViewOptions {
  width: number;
  height?: number;
  theme?: Theme;
}

/** One rendered frame. */
export interface ProviderConnectView {
  lines: string[];
  selectedRow: number;
}

const FIELD_LABELS: Record<ProviderManualField, string> = {
  baseUrl: "Base URL",
  model: "Model",
  apiKey: "API key",
};

const FIELD_ORDER: readonly ProviderManualField[] = ["baseUrl", "model", "apiKey"];

/** A fresh roles-stage state, optionally seeded with a role. */
export function createProviderConnectState(
  role: "senior" | "junior" = "senior",
): ProviderConnectState {
  return {
    stage: "roles",
    role,
    selected: role === "junior" ? 1 : 0,
    manual: { baseUrl: "", model: "", apiKey: "" },
    editing: null,
    editor: createEditor(),
    error: null,
  };
}

function roleSummary(
  data: ProviderConnectData,
  role: "senior" | "junior",
): ProviderRoleSummary | undefined {
  return data.roles.find((summary) => summary.role === role);
}

function currentPreset(
  data: ProviderConnectData,
  state: ProviderConnectState,
): ProviderPresetChoice | undefined {
  if (state.presetName === undefined) return undefined;
  return data.presets.find((preset) => preset.name === state.presetName);
}

/** Rows in the "choose a model" stage, including the keep-current shortcut. */
type PresetModelRow =
  | { kind: "keep" }
  | { kind: "model"; model: string }
  | { kind: "type" }
  | { kind: "back" };

function presetModelRows(
  data: ProviderConnectData,
  state: ProviderConnectState,
): PresetModelRow[] {
  const preset = currentPreset(data, state);
  const summary = roleSummary(data, state.role);
  const rows: PresetModelRow[] = [];
  if (summary !== undefined && summary.model.trim() !== "") rows.push({ kind: "keep" });
  for (const model of preset?.models ?? []) rows.push({ kind: "model", model });
  rows.push({ kind: "type" });
  rows.push({ kind: "back" });
  return rows;
}

/** Total selectable rows for the current stage. */
export function providerConnectRowCount(
  state: ProviderConnectState,
  data: ProviderConnectData,
): number {
  switch (state.stage) {
    case "roles":
      return 3; // Senior / Junior / Close
    case "presets":
      return data.presets.length + 2; // presets / Manual / Back
    case "presetModel":
      return presetModelRows(data, state).length;
    case "manual":
      return FIELD_ORDER.length + 2; // fields / Connect / Back
    default:
      return 0;
  }
}

function moveSelection(
  state: ProviderConnectState,
  delta: number,
  count: number,
): ProviderConnectState {
  if (count <= 0) return { ...state, selected: 0 };
  const current = Math.min(Math.max(0, Math.floor(state.selected)), count - 1);
  const selected = ((current + Math.floor(delta)) % count + count) % count;
  return { ...state, selected };
}

function sanitizeFieldInput(editor: EditorState, maxChars = 2048): EditorState {
  const text = editor.text.replace(/\r?\n/g, " ");
  const capped = text.length > maxChars ? text.slice(0, maxChars) : text;
  return { ...editor, text: capped, cursor: Math.min(editor.cursor, graphemeCount(capped)) };
}

function editorText(state: ProviderConnectState): string {
  return sanitizeFieldInput(state.editor).text;
}

function rolesStageSelection(state: ProviderConnectState): number {
  if (state.role === "junior") return 1;
  return state.selected === 1 ? 1 : 0;
}

/** Enter the presets stage for the chosen role. */
export function openProviderPresets(
  state: ProviderConnectState,
  role: "senior" | "junior",
): ProviderConnectState {
  return {
    ...state,
    stage: "presets",
    role,
    selected: 0,
    presetName: undefined,
    editing: null,
    editor: createEditor(),
    manual: { baseUrl: "", model: "", apiKey: "" },
    error: null,
  };
}

/** Enter the manual form, prefilled with the role's effective connection. */
export function openManualProviderForm(
  state: ProviderConnectState,
  data: ProviderConnectData,
): ProviderConnectState {
  const summary = roleSummary(data, state.role);
  return {
    ...state,
    stage: "manual",
    selected: 0,
    presetName: undefined,
    editing: null,
    editor: createEditor(),
    manual: {
      baseUrl: summary?.baseUrl ?? "",
      model: summary?.model ?? "",
      apiKey: "",
    },
    error: null,
  };
}

function backToPresets(state: ProviderConnectState, data: ProviderConnectData): ProviderConnectState {
  const presetName = state.presetName;
  const index = presetName === undefined
    ? data.presets.length + 1
    : Math.max(0, data.presets.findIndex((preset) => preset.name === presetName));
  return {
    ...state,
    stage: "presets",
    selected: index,
    presetName: undefined,
    editing: null,
    editor: createEditor(),
    error: null,
  };
}

function modelStage(state: ProviderConnectState, presetName: string): ProviderConnectState {
  return {
    ...state,
    stage: "presetModel",
    presetName,
    selected: 0,
    editing: null,
    editor: createEditor(),
    error: null,
  };
}

/** Start editing one manual field (no-op while another field is being edited). */
export function beginProviderFieldEdit(
  state: ProviderConnectState,
  _data: ProviderConnectData,
): ProviderConnectState {
  if (state.editing !== null) return state;
  const field = FIELD_ORDER[state.selected];
  if (field === undefined) return state;
  const prefill = field === "apiKey" ? "" : state.manual[field];
  return {
    ...state,
    editing: field,
    editor: createEditor(prefill, { maxChars: 2048 }),
    error: null,
  };
}

/**
 * Fold one keypress into the connect flow.
 *
 * While a field is being edited the editor owns the keyboard (printable text,
 * Backspace, Left/Right/Home/End; Enter commits, Esc cancels). Up/Down are
 * ignored there so the editor's prompt history can never recall a submitted
 * task into a provider field (and a secret can never round-trip through it).
 */
export function providerConnectKey(
  state: ProviderConnectState,
  data: ProviderConnectData,
  key: KeyLike,
): { state: ProviderConnectState; action: ProviderConnectAction } {
  const name = (key.name ?? "").toLowerCase();
  if (state.editing !== null) return handleFieldEditKey(state, data, key);
  if (name === "escape" || name === "esc") {
    if (state.stage === "roles") return { state, action: { type: "close" } };
    if (state.stage === "presets") {
      return {
        state: { ...state, stage: "roles", selected: rolesStageSelection(state), error: null },
        action: { type: "none" },
      };
    }
    return { state: backToPresets(state, data), action: { type: "none" } };
  }
  if (name === "up" || name === "down") {
    const count = providerConnectRowCount(state, data);
    return { state: moveSelection(state, name === "up" ? -1 : 1, count), action: { type: "none" } };
  }
  if (name !== "return" && name !== "enter" && name !== " ") {
    return { state, action: { type: "none" } };
  }
  if (state.stage === "roles") {
    if (state.selected === 0 || state.selected === 1) {
      const role = state.selected === 1 ? "junior" : "senior";
      return { state: openProviderPresets(state, role), action: { type: "none" } };
    }
    return { state, action: { type: "close" } };
  }
  if (state.stage === "presets") {
    if (state.selected < data.presets.length) {
      const preset = data.presets[state.selected];
      if (preset === undefined) return { state, action: { type: "none" } };
      return { state: modelStage(state, preset.name), action: { type: "none" } };
    }
    if (state.selected === data.presets.length) {
      return { state: openManualProviderForm(state, data), action: { type: "none" } };
    }
    return {
      state: { ...state, stage: "roles", selected: rolesStageSelection(state), error: null },
      action: { type: "none" },
    };
  }
  if (state.stage === "presetModel") {
    const rows = presetModelRows(data, state);
    const row = rows[state.selected];
    const presetName = state.presetName;
    if (row === undefined || presetName === undefined) return { state, action: { type: "none" } };
    if (row.kind === "back") return { state: backToPresets(state, data), action: { type: "none" } };
    if (row.kind === "keep") {
      const current = roleSummary(data, state.role)?.model.trim() ?? "";
      if (current === "") return { state, action: { type: "none" } };
      return {
        state,
        action: { type: "save", request: { role: state.role, preset: { name: presetName, model: current } } },
      };
    }
    if (row.kind === "model") {
      return {
        state,
        action: {
          type: "save",
          request: { role: state.role, preset: { name: presetName, model: row.model } },
        },
      };
    }
    return {
      state: { ...state, editing: "model", editor: createEditor("", { maxChars: 512 }), error: null },
      action: { type: "none" },
    };
  }
  // manual stage
  if (state.selected < FIELD_ORDER.length) {
    return { state: beginProviderFieldEdit(state, data), action: { type: "none" } };
  }
  if (state.selected === FIELD_ORDER.length) {
    const request: ProviderConnectRequest = {
      role: state.role,
      manual: {
        provider: "openai",
        baseUrl: state.manual.baseUrl,
        model: state.manual.model,
        ...(state.manual.apiKey !== "" ? { apiKey: state.manual.apiKey } : {}),
      },
    };
    return { state: { ...state, error: null }, action: { type: "save", request } };
  }
  return { state: backToPresets(state, data), action: { type: "none" } };
}

function handleFieldEditKey(
  state: ProviderConnectState,
  _data: ProviderConnectData,
  key: KeyLike,
): { state: ProviderConnectState; action: ProviderConnectAction } {
  const name = (key.name ?? "").toLowerCase();
  if (name === "escape" || name === "esc" || (key.ctrl === true && name === "c")) {
    return {
      state: { ...state, editing: null, editor: createEditor(), error: null },
      action: { type: "none" },
    };
  }
  if (name === "return" || name === "enter") {
    const field = state.editing;
    if (field === null) return { state, action: { type: "none" } };
    if (state.stage === "presetModel") {
      const presetName = state.presetName;
      const model = editorText(state).trim();
      if (presetName === undefined || model === "") {
        return { state: { ...state, error: "Model must not be empty." }, action: { type: "none" } };
      }
      return {
        state,
        action: { type: "save", request: { role: state.role, preset: { name: presetName, model } } },
      };
    }
    const value = editorText(state).trim();
    const manual: ProviderManualDraft = { ...state.manual, [field]: value };
    const selected = field === "apiKey" ? FIELD_ORDER.length : FIELD_ORDER.indexOf(field);
    return {
      state: { ...state, manual, editing: null, editor: createEditor(), selected, error: null },
      action: { type: "none" },
    };
  }
  if (name === "up" || name === "down") return { state, action: { type: "none" } };
  if (name === "paste") {
    const result = handleEditorKey(
      state.editor,
      { name: "paste", raw: key.raw ?? "" },
      { maxChars: 2048 },
    );
    return {
      state: { ...state, editor: sanitizeFieldInput(result.state) },
      action: { type: "none" },
    };
  }
  const result = handleEditorKey(
    state.editor,
    {
      name: key.name ?? "",
      ctrl: key.ctrl === true,
      shift: key.shift === true,
      alt: key.alt === true,
      raw: key.raw ?? "",
    },
    { maxChars: 2048 },
  );
  if (result.action === "cancel") {
    return {
      state: { ...state, editing: null, editor: createEditor(), error: null },
      action: { type: "none" },
    };
  }
  return { state: { ...state, editor: sanitizeFieldInput(result.state) }, action: { type: "none" } };
}

/** Set a real save/validation error on the open form (the app owns the save). */
export function setProviderConnectError(
  state: ProviderConnectState,
  error: string | null,
): ProviderConnectState {
  return { ...state, error };
}

// --------------------------------------------------------------------------- //
// rendering
// --------------------------------------------------------------------------- //

function themed(theme: Theme, token: ThemeToken, text: string): string {
  return theme.paint(token, text);
}

function apiKeyLine(summary: ProviderRoleSummary | undefined): string {
  return `API key: ${summary?.apiKeySet === true ? "set" : "not set"}`;
}

function roleHeaderRows(
  summary: ProviderRoleSummary | undefined,
  width: number,
  theme: Theme,
): string[] {
  if (summary === undefined) return [];
  return [
    themed(theme, "accent", clipDisplay(`${summary.label.toUpperCase()} · ${summary.provider}`, width)),
    themed(
      theme,
      "muted",
      clipDisplay(`  model   ${summary.model || "(no model)"} · ${summary.kind}`, width),
    ),
    themed(
      theme,
      "muted",
      clipDisplay(`  base    ${summary.baseUrl || "(no base URL)"}`, width),
    ),
    themed(
      theme,
      summary.pinned.length > 0 ? "warning" : "muted",
      clipDisplay(
        `  ${apiKeyLine(summary)}` +
          (summary.providerRef !== "" ? ` · preset ${summary.providerRef}` : "") +
          (summary.pinned.length > 0 ? ` · pinned: ${summary.pinned.join(", ")}` : ""),
        width,
      ),
    ),
  ];
}

function maskedSecret(count: number): string {
  return "•".repeat(Math.min(Math.max(0, count), 40));
}

function windowStart(total: number, selected: number, capacity: number): number {
  if (capacity <= 0 || total <= capacity) return 0;
  return Math.min(Math.max(0, selected - Math.floor(capacity / 2)), total - capacity);
}

function listRows(
  labels: readonly string[],
  selected: number,
  width: number,
  theme: Theme,
  capacity: number,
): { rows: string[]; start: number } {
  if (labels.length === 0) return { rows: [], start: 0 };
  const size = Math.max(1, capacity);
  const start = windowStart(labels.length, selected, size);
  const rows: string[] = [];
  for (let index = start; index < Math.min(labels.length, start + size); index += 1) {
    const isSelected = index === selected;
    const marker = isSelected ? "› " : "  ";
    rows.push(
      themed(
        theme,
        isSelected ? "focus" : "text",
        clipDisplay(`${marker}${labels[index] ?? ""}`, width),
      ),
    );
  }
  return { rows, start };
}

function manualFieldRows(
  state: ProviderConnectState,
  width: number,
  theme: Theme,
  capacity: number,
): { rows: string[]; start: number } {
  const labels: string[] = FIELD_ORDER.map((field) => FIELD_LABELS[field]);
  labels.push("Connect", "Back");
  const start = windowStart(labels.length, state.selected, capacity);
  const rows: string[] = [];
  for (let index = start; index < Math.min(labels.length, start + Math.max(1, capacity)); index += 1) {
    const isSelected = index === state.selected;
    const marker = isSelected ? "› " : "  ";
    let line: string;
    if (index < FIELD_ORDER.length) {
      const field = FIELD_ORDER[index] ?? "baseUrl";
      const label = FIELD_LABELS[field];
      let value: string;
      if (state.editing === field) {
        const text = editorText(state);
        value = field === "apiKey"
          ? text === ""
            ? "(typing — hidden)"
            : maskedSecret(graphemeCount(text))
          : text === ""
            ? "(empty)"
            : text;
      } else if (field === "apiKey") {
        value = state.manual.apiKey !== ""
          ? "typed (hidden — replaces the stored key)"
          : "blank keeps the saved key";
      } else {
        value = state.manual[field] === "" ? "(empty)" : state.manual[field];
      }
      line = `${marker}${label.padEnd(9)}${value}`;
    } else if (index === FIELD_ORDER.length) {
      line = `${marker}[ Connect ]`;
    } else {
      line = `${marker}[ Back ]`;
    }
    rows.push(themed(theme, isSelected ? "focus" : "text", clipDisplay(line, width)));
  }
  return { rows, start };
}

function presetLabel(preset: ProviderPresetChoice): string {
  const models = preset.models.length;
  return (
    `${preset.name} · ${preset.kind} · ${preset.baseUrl} · ${models} model${
      models === 1 ? "" : "s"
    } · key ${preset.apiKeySet ? "set" : "not set"}`
  );
}

function stageTitle(state: ProviderConnectState): string {
  switch (state.stage) {
    case "roles":
      return "PROVIDER SETTINGS";
    case "presets":
      return `${state.role.toUpperCase()} PROVIDER`;
    case "presetModel":
      return `${state.role.toUpperCase()} MODEL`;
    default:
      return `${state.role.toUpperCase()} MANUAL CONNECTION`;
  }
}

function footerHints(state: ProviderConnectState): string {
  if (state.editing !== null) return "enter accept · esc cancel";
  if (state.stage === "manual") {
    return state.selected < FIELD_ORDER.length
      ? "enter edit · ↑↓ move · esc back"
      : "enter select · ↑↓ move · esc back";
  }
  return hintSegments(TUI_COMMANDS, [
    { id: "list-move", label: "move" },
    { id: "list-accept", label: "select" },
    { id: "list-close", label: "close" },
  ]);
}

/**
 * Render one frame into a bordered box. The box is width-bounded by the caller's
 * terminal width and the list body is windowed to `height`, so a long preset
 * table never pushes the selection or footer off screen.
 */
export function providerConnectView(
  state: ProviderConnectState,
  data: ProviderConnectData,
  options: ProviderConnectViewOptions,
): ProviderConnectView {
  const width = Math.max(0, Math.floor(options.width));
  if (width === 0) return { lines: [], selectedRow: -1 };
  const theme = options.theme ?? plainTheme;
  const height = options.height === undefined ? undefined : Math.max(0, Math.floor(options.height));
  const contentWidth = Math.max(1, boxContentWidth(width));
  const summary = roleSummary(data, state.role);
  const header: string[] = [];
  if (state.stage === "roles") {
    for (const role of data.roles) header.push(...roleHeaderRows(role, contentWidth, theme));
    header.push("");
  } else {
    header.push(...roleHeaderRows(summary, contentWidth, theme));
    header.push("");
  }
  if (state.stage === "presetModel" && state.editing === "model") {
    header.push(
      themed(
        theme,
        "accent",
        clipDisplay(`model: ${editorText(state) || "(empty)"}`, contentWidth),
      ),
    );
  }
  const errorRows =
    state.error !== null
      ? [themed(theme, "warning", clipDisplay(`error: ${state.error}`, contentWidth))]
      : [];
  const reserved = header.length + errorRows.length + 3;
  const capacity = Math.max(3, (height ?? 24) - reserved);

  let body: string[] = [];
  let start = 0;
  if (state.stage === "roles") {
    const labels = ["Connect Senior…", "Connect Junior…", "Close"];
    const listed = listRows(labels, state.selected, contentWidth, theme, labels.length);
    body = listed.rows;
    start = listed.start;
  } else if (state.stage === "presets") {
    const labels = [...data.presets.map(presetLabel), "Manual connection…", "Back"];
    const listed = listRows(labels, state.selected, contentWidth, theme, capacity);
    body = listed.rows;
    start = listed.start;
  } else if (state.stage === "presetModel") {
    const rows = presetModelRows(data, state);
    const labels = rows.map((row) => {
      if (row.kind === "keep") return `keep current (${summary?.model ?? ""})`;
      if (row.kind === "model") return row.model;
      if (row.kind === "type") return "type a model id…";
      return "Back";
    });
    const listed = listRows(labels, state.selected, contentWidth, theme, capacity);
    body = listed.rows;
    start = listed.start;
  } else {
    const listed = manualFieldRows(state, contentWidth, theme, capacity);
    body = listed.rows;
    start = listed.start;
  }

  const footer = themed(theme, "dim", clipDisplay(footerHints(state), contentWidth));
  const content = [...header, ...body, ...errorRows, footer];
  while (height !== undefined && content.length < Math.max(0, height - 2)) content.push("");
  // `renderBox` clips and ellipsizes the title to its own budget (inner - 3);
  // the caller passes the raw stage title and cannot widen the top border.
  const lines = renderBox(content, { width, title: stageTitle(state), theme });
  if (height !== undefined) {
    lines.splice(height);
    while (lines.length < height) lines.push(fitStyled("", width));
  }
  const selectedRow = body.length === 0 ? -1 : header.length + (state.selected - start) + 1;
  return { lines, selectedRow: Math.min(selectedRow, lines.length - 1) };
}

/** Convenience wrapper for callers that only need the rows. */
export function providerConnectLines(
  state: ProviderConnectState,
  data: ProviderConnectData,
  options: ProviderConnectViewOptions,
): string[] {
  return providerConnectView(state, data, options).lines;
}
