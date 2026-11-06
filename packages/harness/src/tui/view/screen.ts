import type { EditorState } from "../editor.ts";
import type { TuiModel } from "../model.ts";
import { blankRow, composeScreen, fitStyled } from "../screen.ts";
import { plainTheme, type Theme } from "../theme.ts";
import { composerView, type ComposerView } from "./composer.ts";
import {
  sidePanelLayout,
  sidePanelView,
  type SidePanelLayout,
  type SidePanelState,
} from "./sidepanel.ts";
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
  /**
   * Inline `/` command and `@skill:` mention picker rows rendered above the
   * composer (the inline footer slot family of the find bar). Omitted (or
   * empty) frames are byte-identical to the plain layout.
   */
  mentionPicker?: readonly string[];
  /**
   * Inline find-bar rows rendered between the composer and the status bar
   * (Ctrl+F). Omitted (or empty) frames are byte-identical to the plain layout.
   */
  findBar?: readonly string[];
  /** Block id of the active find match, marked in the transcript gutter. */
  findBlockId?: string;
  toasts?: readonly Toast[];
  spinnerTick?: number;
  reducedMotion?: boolean;
  welcomeExamples?: readonly string[];
  /**
   * Right-hand status panel content. When omitted the frame is byte-identical
   * to the pre-panel layout; when present the panel appears only where
   * `sidePanelLayout` allows it (wide + tall + enabled + no overlay).
   */
  sidePanel?: SidePanelState;
  /** The registry toggle's choice; `false` hides the panel at every size. */
  sidePanelEnabled?: boolean;
}

/** The panel slice of one frame, exposed for tests and embedding. */
export interface ScreenSidePanel {
  layout: SidePanelLayout;
  lines: string[];
}

export interface ScreenView {
  lines: string[];
  composer: ComposerView;
  transcript: TranscriptView | null;
  statusLines: string[];
  /** The panel as rendered for this frame; null when no content was passed. */
  sidePanel: ScreenSidePanel | null;
}

/**
 * Compose welcome/transcript, an optional inline mention picker, the composer,
 * an optional inline find bar, the two-line status and one overlay layer.
 *
 * The side panel (when the layout allows it) shares only the transcript body
 * row: the transcript is composed at `layout.transcriptWidth` and each body
 * row is the transcript row plus the panel row, so the two widths add up to
 * the terminal width exactly. The picker, composer, find bar and status bar
 * are rendered at the full width and never move; a full-screen overlay
 * suppresses the panel for that frame.
 */
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
  const mentionPicker = options.mentionPicker ?? [];
  const findBar = options.findBar ?? [];
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
  const bodyHeight = Math.max(
    0,
    height - composer.lines.length - mentionPicker.length - findBar.length - statusLines.length,
  );

  const panelState = options.sidePanel;
  const layout =
    panelState === undefined
      ? null
      : sidePanelLayout(width, height, {
          enabled: options.sidePanelEnabled,
          overlayOpen: options.overlay !== undefined,
        });
  const panelOpen = layout !== null && layout.visible && panelState !== undefined;
  const transcriptWidth = layout !== null && panelOpen ? layout.transcriptWidth : width;

  const empty = options.model.blocks.length === 0 && options.model.liveThinking === undefined;
  const transcript = empty ? null : transcriptView(options.model, {
    width: transcriptWidth,
    height: bodyHeight,
    theme,
    scroll: options.scroll,
    expandedTools: options.expandedTools,
    ...(options.findBlockId !== undefined ? { activeBlockId: options.findBlockId } : {}),
  });
  let body = transcript?.lines ?? renderWelcome({
    width: transcriptWidth,
    cwd: status.cwd ?? "",
    sessionName: status.sessionName,
    mode: status.mode,
    seniorModel: status.seniorModel,
    juniorModel: status.juniorModel,
    examples: options.welcomeExamples,
    theme,
  });

  const panelLines =
    layout !== null && panelOpen && panelState !== undefined
      ? sidePanelView(panelState, { width: layout.panelWidth, height: bodyHeight, theme })
      : [];
  const sidePanel: ScreenSidePanel | null =
    layout === null ? null : { layout, lines: panelLines };
  if (panelOpen && layout !== null) {
    const joined: string[] = [];
    for (let index = 0; index < bodyHeight; index += 1) {
      const left = fitStyled(body[index] ?? "", transcriptWidth);
      joined.push(left + (panelLines[index] ?? blankRow(layout.panelWidth)));
    }
    body = joined;
  }

  const toastRows = options.overlay === undefined && options.toasts !== undefined && options.toasts.length > 0
    ? renderToasts(options.toasts, { width: Math.min(width, 64), theme })
    : undefined;
  const overlay = options.overlay ?? toastRows;
  const lines = composeScreen({
    width,
    height,
    body,
    footer: [...mentionPicker, ...composer.lines, ...findBar, ...statusLines],
    overlay,
    overlayAlign: options.overlay === undefined ? "top" : "center",
    bodyAnchor: empty ? "top" : "bottom",
  });
  return { lines, composer, transcript, statusLines, sidePanel };
}

export function renderScreen(options: ScreenOptions): string[] {
  return screenView(options).lines;
}
