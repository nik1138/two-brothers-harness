import type { EditorState } from "../editor.ts";
import type { TuiModel } from "../model.ts";
import { composeScreen } from "../screen.ts";
import { plainTheme, type Theme } from "../theme.ts";
import { composerView, type ComposerView } from "./composer.ts";
import { spinnerFrame } from "./spinner.ts";
import { renderStatusBar, type StatusBarState } from "./statusbar.ts";
import { renderToasts, type Toast } from "./toast.ts";
import {
  transcriptView,
  type TranscriptScroll,
  type TranscriptView,
} from "./transcript.ts";
import { renderWelcome } from "./welcome.ts";

export interface ScreenOptions {
  width: number;
  height: number;
  model: TuiModel;
  editor: EditorState;
  status: StatusBarState;
  theme?: Theme;
  scroll?: TranscriptScroll;
  expandedTools?: boolean;
  composerMaxRows?: number;
  overlay?: readonly string[];
  toasts?: readonly Toast[];
  spinnerTick?: number;
  reducedMotion?: boolean;
  welcomeExamples?: readonly string[];
}

export interface ScreenView {
  lines: string[];
  composer: ComposerView;
  transcript: TranscriptView | null;
  statusLines: string[];
}

/** Compose welcome/transcript, composer, two-line status and one overlay layer. */
export function screenView(options: ScreenOptions): ScreenView {
  const width = Math.max(0, Math.floor(options.width));
  const height = Math.max(0, Math.floor(options.height));
  const theme = options.theme ?? plainTheme;
  const status = options.status;
  const activity = status.running === true && options.spinnerTick !== undefined
    ? `${spinnerFrame(options.spinnerTick, options.reducedMotion !== true)} ${status.activity?.trim() || "working"}`
    : status.activity;
  const statusState: StatusBarState = {
    ...status,
    ...(activity !== undefined ? { activity } : {}),
  };
  const statusLines = renderStatusBar(statusState, { width, theme });
  const composer = composerView({
    width,
    editor: options.editor,
    mode: status.mode,
    seniorModel: status.seniorModel,
    juniorModel: status.juniorModel,
    running: status.running,
    maxRows: options.composerMaxRows,
    theme,
  });
  const bodyHeight = Math.max(0, height - composer.lines.length - statusLines.length);
  const empty = options.model.blocks.length === 0;
  const transcript = empty ? null : transcriptView(options.model, {
    width,
    height: bodyHeight,
    theme,
    scroll: options.scroll,
    expandedTools: options.expandedTools,
  });
  const body = transcript?.lines ?? renderWelcome({
    width,
    cwd: status.cwd ?? "",
    sessionName: status.sessionName,
    mode: status.mode,
    seniorModel: status.seniorModel,
    juniorModel: status.juniorModel,
    examples: options.welcomeExamples,
    theme,
  });
  const toastRows = options.overlay === undefined && options.toasts !== undefined && options.toasts.length > 0
    ? renderToasts(options.toasts, { width: Math.min(width, 64), theme })
    : undefined;
  const overlay = options.overlay ?? toastRows;
  const lines = composeScreen({
    width,
    height,
    body,
    footer: [...composer.lines, ...statusLines],
    overlay,
    overlayAlign: options.overlay === undefined ? "top" : "center",
    bodyAnchor: empty ? "top" : "bottom",
  });
  return { lines, composer, transcript, statusLines };
}

export function renderScreen(options: ScreenOptions): string[] {
  return screenView(options).lines;
}
