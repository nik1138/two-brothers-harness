import { hintSegments, TUI_COMMANDS, type TuiCommand } from "../keymap.ts";
import {
  boxContentWidth,
  centerStyled,
  renderBox,
  wrapDisplay,
} from "../screen.ts";
import { plainTheme, type Theme, type ThemeToken } from "../theme.ts";

export interface WelcomeOptions {
  width: number;
  cwd: string;
  sessionName?: string;
  mode?: string;
  seniorModel?: string;
  juniorModel?: string;
  examples?: readonly string[];
  theme?: Theme;
  /** Registry commands whose effective chords drive the hints (default `TUI_COMMANDS`). */
  commands?: readonly TuiCommand[];
}

const DEFAULT_EXAMPLES = [
  "Review this workspace and suggest a safe first change.",
  "Explain the failing test and propose a fix.",
  "Plan a small refactor, then delegate the implementation.",
] as const;

function configured(value: string | undefined): { text: string; tone: ThemeToken } {
  const model = value?.trim() ?? "";
  return model === ""
    ? { text: "(not configured)", tone: "warning" }
    : { text: model, tone: "text" };
}

function wrappedRows(
  rows: string[],
  text: string,
  width: number,
  theme: Theme,
  tone: ThemeToken = "text",
): void {
  for (const row of wrapDisplay(text, width)) rows.push(theme.paint(tone, row));
}

/** Render the empty-session onboarding block without reading process state. */
export function renderWelcome(options: WelcomeOptions): string[] {
  const width = Math.max(0, Math.floor(options.width));
  if (width === 0) return [];
  const theme = options.theme ?? plainTheme;
  const outerWidth = Math.min(width, 88);
  const contentWidth = Math.max(1, boxContentWidth(outerWidth));
  const rows: string[] = [];

  rows.push(theme.paint("strong", "Two Brothers"));
  wrappedRows(rows, "Two models. One shared context. One final decision.", contentWidth, theme, "muted");
  rows.push("");
  wrappedRows(rows, `WORKSPACE  ${options.cwd || "(current directory)"}`, contentWidth, theme, "dim");
  wrappedRows(rows, `SESSION    ${options.sessionName?.trim() || "in-memory"}`, contentWidth, theme, "dim");
  wrappedRows(rows, `MODE       ${options.mode?.trim() || "consult"}`, contentWidth, theme, "accent");

  const senior = configured(options.seniorModel);
  const junior = configured(options.juniorModel);
  wrappedRows(rows, `SENIOR     ${senior.text}`, contentWidth, theme, senior.tone);
  wrappedRows(rows, `JUNIOR     ${junior.text}`, contentWidth, theme, junior.tone);
  if (senior.tone === "warning" || junior.tone === "warning") {
    wrappedRows(rows, "Configure both roles with /settings before starting a run.", contentWidth, theme, "warning");
  }

  rows.push("");
  rows.push(theme.paint("strong", "Get started"));
  wrappedRows(rows, "Type a task below.", contentWidth, theme);
  const commands = options.commands ?? TUI_COMMANDS;
  const editHints = hintSegments(commands, [
    { id: "submit", label: "send" },
    { id: "newline", label: "newline" },
  ]);
  const appHints = hintSegments(commands, [
    { id: "palette", label: "commands" },
    { id: "help", label: "help" },
  ]);
  wrappedRows(rows, `${editHints} · ${appHints} · /mode changes cooperation.`, contentWidth, theme, "muted");

  const examples = options.examples ?? DEFAULT_EXAMPLES;
  if (examples.length > 0) {
    rows.push("");
    rows.push(theme.paint("strong", "Try an example"));
    for (const example of examples) {
      wrappedRows(rows, `› ${example}`, contentWidth, theme, "accent");
    }
  }

  return renderBox(rows, {
    width: outerWidth,
    title: "WELCOME",
    theme,
    tone: "border",
  }).map((row) => centerStyled(row, width));
}
