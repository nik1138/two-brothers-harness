/**
 * CLI terminal styling tests: `src/clistyle.ts` and the printers that take
 * its optional `CliStyle`.
 *
 * The lane pins the TTY-gated color matrix (depth × NO_COLOR × FORCE_COLOR ×
 * TERM=dumb × not-TTY), the identity behavior of `plainCliStyle`, and the
 * byte-identity invariant for every printer: stripping the SGR sequences from
 * a colored rendering reproduces the plain rendering exactly. Hermetic — no
 * subprocess, no TTY required.
 *
 * Run with: node tests/run-all.ts (or node --test tests/)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  FALLBACK_TERMINAL_WIDTH,
  plainCliStyle,
  resolveCliStyle,
  terminalWidth,
  type CliStyle,
} from "../src/clistyle.ts";
import {
  renderBriefUsage,
  renderCommandHelp,
  renderFullHelp,
  renderMainHelp,
} from "../src/clihelp.ts";
import { costLine, renderMessages, usageLine } from "../src/cli.ts";
import { formatDoctorReport } from "../src/doctor.ts";
import { resolveConfig } from "../src/config.ts";
import { createTheme, RESET, type ThemeToken } from "../src/tui/theme.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const ESC = "\x1b";

/** Strip every SGR sequence (the only escape kind the theme emits). */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** A 16-color style resolved exactly like the TTY path (depth 4 = 16 colors). */
function ansi16Style(): CliStyle {
  return resolveCliStyle({ depth: 4, env: {} });
}

/** A deterministic truecolor style. */
function truecolorStyle(mode: "dark" | "light" = "dark"): CliStyle {
  return resolveCliStyle({ depth: 24, env: {}, mode });
}

function expectedAnsi16(token: ThemeToken, text: string): string {
  return createTheme("ansi16").paint(token, text);
}

function expectedTruecolor(mode: "dark" | "light", token: ThemeToken, text: string): string {
  return createTheme(mode).paint(token, text);
}

// ---------------------------------------------------------------------------
// resolver matrix
// ---------------------------------------------------------------------------

test("resolveCliStyle: depth 0/1 is plain, 2/4/8 is ansi16, 24 is truecolor", () => {
  for (const depth of [0, 1, Number.NaN, -1]) {
    const style = resolveCliStyle({ depth, env: {} });
    assert.equal(style.color, false, `depth ${depth}`);
    assert.equal(style.paint("accent", "x"), "x", `depth ${depth}`);
    assert.equal(style.bold("x"), "x", `depth ${depth}`);
  }
  for (const depth of [2, 4, 8]) {
    const style = resolveCliStyle({ depth, env: {} });
    assert.equal(style.color, true, `depth ${depth}`);
    assert.equal(style.paint("accent", "x"), expectedAnsi16("accent", "x"), `depth ${depth}`);
    assert.equal(style.paint("error", "x"), expectedAnsi16("error", "x"), `depth ${depth}`);
  }
  const truecolor = resolveCliStyle({ depth: 24, env: {} });
  assert.equal(truecolor.color, true);
  assert.equal(truecolor.paint("accent", "x"), expectedTruecolor("dark", "accent", "x"));
});

test("resolveCliStyle: NO_COLOR (non-empty) and TERM=dumb force plain", () => {
  for (const env of [{ NO_COLOR: "1" }, { NO_COLOR: "yes" }, { TERM: "dumb" }]) {
    const style = resolveCliStyle({ depth: 24, env });
    assert.equal(style.color, false, JSON.stringify(env));
    assert.equal(style.paint("accent", "x"), "x", JSON.stringify(env));
  }
  // an empty NO_COLOR is not a request for no color (no-color.org)
  assert.equal(resolveCliStyle({ depth: 24, env: { NO_COLOR: "" } }).color, true);
});

test("resolveCliStyle: FORCE_COLOR forces color and wins over NO_COLOR", () => {
  for (const value of ["1", "true"]) {
    const style = resolveCliStyle({ depth: 1, env: { FORCE_COLOR: value } });
    assert.equal(style.color, true, value);
    assert.equal(style.paint("accent", "x"), expectedAnsi16("accent", "x"), value);
  }
  assert.equal(
    resolveCliStyle({ depth: 1, env: { FORCE_COLOR: "2" } }).paint("accent", "x"),
    expectedAnsi16("accent", "x"),
  );
  assert.equal(
    resolveCliStyle({ depth: 1, env: { FORCE_COLOR: "3" } }).paint("accent", "x"),
    expectedTruecolor("dark", "accent", "x"),
  );
  // wins over NO_COLOR and TERM=dumb
  assert.equal(
    resolveCliStyle({ depth: 1, env: { FORCE_COLOR: "1", NO_COLOR: "1" } }).color,
    true,
  );
  assert.equal(
    resolveCliStyle({ depth: 1, env: { FORCE_COLOR: "1", TERM: "dumb" } }).color,
    true,
  );
});

test("resolveCliStyle: FORCE_COLOR=0/false stays plain even on a truecolor TTY", () => {
  for (const value of ["0", "false", "FALSE", " 0 "]) {
    const style = resolveCliStyle({ depth: 24, env: { FORCE_COLOR: value } });
    assert.equal(style.color, false, JSON.stringify(value));
    assert.equal(style.paint("error", "x"), "x", JSON.stringify(value));
  }
});

test("resolveCliStyle: default (no depth) is plain when stdout is not a TTY", (t) => {
  if (process.stdout.isTTY === true) {
    t.skip("stdout is a TTY here; the piped default cannot be exercised");
    return;
  }
  const style = resolveCliStyle({ env: {} });
  assert.equal(style.color, false);
  assert.equal(style.paint("accent", "x"), "x");
});

test("resolveCliStyle: TWO_BROTHERS_THEME selects the palette (capability capped)", () => {
  const dark = resolveCliStyle({ depth: 24, env: {} });
  const light = resolveCliStyle({ depth: 24, env: { TWO_BROTHERS_THEME: "light" } });
  const ansi = resolveCliStyle({ depth: 24, env: { TWO_BROTHERS_THEME: "ansi16" } });
  const lightFgbg = resolveCliStyle({ depth: 24, env: { COLORFGBG: "0;15" } });
  assert.equal(dark.paint("accent", "x"), expectedTruecolor("dark", "accent", "x"));
  assert.equal(light.paint("accent", "x"), expectedTruecolor("light", "accent", "x"));
  assert.equal(lightFgbg.paint("accent", "x"), expectedTruecolor("light", "accent", "x"));
  assert.equal(ansi.paint("accent", "x"), expectedAnsi16("accent", "x"));
  // below truecolor the terminal can only render the 16-color palette
  assert.equal(
    resolveCliStyle({ depth: 8, env: { TWO_BROTHERS_THEME: "light" } }).paint("accent", "x"),
    expectedAnsi16("accent", "x"),
  );
  // an explicit mode is a palette choice, not a capability override
  assert.equal(
    resolveCliStyle({ depth: 8, env: {}, mode: "light" }).paint("accent", "x"),
    expectedAnsi16("accent", "x"),
  );
  assert.equal(
    resolveCliStyle({ depth: 24, env: {}, mode: "ansi16" }).paint("accent", "x"),
    expectedAnsi16("accent", "x"),
  );
});

test("plainCliStyle is the identity style", () => {
  assert.equal(plainCliStyle, plainCliStyle);
  assert.equal(plainCliStyle.color, false);
  const tokens: ThemeToken[] = [
    "accent",
    "strong",
    "muted",
    "dim",
    "user",
    "senior",
    "junior",
    "decision",
    "dissent",
    "error",
    "warning",
    "success",
  ];
  for (const token of tokens) {
    assert.equal(plainCliStyle.paint(token, "text"), "text", token);
    assert.equal(plainCliStyle.paint(token, ""), "", token);
  }
  assert.equal(plainCliStyle.bold("text"), "text");
  assert.equal(plainCliStyle.dim("text"), "text");
});

test("resolveCliStyle: positioned like plainCliStyle, colored output strips back", () => {
  for (const style of [ansi16Style(), truecolorStyle(), truecolorStyle("light")]) {
    assert.equal(style.color, true);
    assert.equal(stripAnsi(style.paint("accent", "flag")), "flag");
    assert.equal(stripAnsi(style.bold("bold")), "bold");
    assert.equal(stripAnsi(style.dim("dim")), "dim");
    assert.ok(style.paint("accent", "x").includes(ESC));
    assert.ok(style.paint("accent", "x").endsWith(RESET));
  }
});

// ---------------------------------------------------------------------------
// terminalWidth
// ---------------------------------------------------------------------------

test("terminalWidth: explicit columns, a sane floor, and the 96 fallback", () => {
  assert.equal(terminalWidth(120), 120);
  assert.equal(terminalWidth(96), 96);
  assert.equal(terminalWidth(10), FALLBACK_TERMINAL_WIDTH);
  assert.equal(terminalWidth(Number.NaN), FALLBACK_TERMINAL_WIDTH);
  assert.equal(terminalWidth(0), FALLBACK_TERMINAL_WIDTH);
});

test("terminalWidth: stdout columns are ignored when stdout is not a TTY", (t) => {
  if (process.stdout.isTTY === true) {
    t.skip("stdout is a TTY here; the piped case cannot be exercised");
    return;
  }
  const stdout = process.stdout as unknown as { columns?: number };
  const original = stdout.columns;
  try {
    Object.defineProperty(process.stdout, "columns", { value: 160, configurable: true });
    assert.equal(terminalWidth(), FALLBACK_TERMINAL_WIDTH);
  } finally {
    if (original === undefined) {
      delete (stdout as { columns?: number }).columns;
    } else {
      Object.defineProperty(process.stdout, "columns", { value: original, configurable: true });
    }
  }
});

// ---------------------------------------------------------------------------
// printer byte-identity: stripAnsi(colored) === plain
// ---------------------------------------------------------------------------

test("clihelp: every renderer strips back to its plain bytes", () => {
  const style = ansi16Style();
  const commands = ["run", "chat", "tui", "serve", "sessions", "doctor", "help"] as const;
  const pairs: Array<[string, string]> = [
    ["main help", renderMainHelp()],
    ["full help", renderFullHelp()],
    ["brief usage", renderBriefUsage()],
    ...commands.map((command): [string, string] => [
      `command help ${command}`,
      renderCommandHelp(command),
    ]),
  ];
  const coloredPairs: Array<[string, string]> = [
    ["main help", renderMainHelp(style)],
    ["full help", renderFullHelp(style)],
    ["brief usage", renderBriefUsage(style)],
    ...commands.map((command): [string, string] => [
      `command help ${command}`,
      renderCommandHelp(command, style),
    ]),
  ];
  for (let index = 0; index < pairs.length; index++) {
    const [label, plain] = pairs[index];
    const [, colored] = coloredPairs[index];
    assert.equal(stripAnsi(colored), plain, label);
    assert.ok(colored.includes(ESC), `${label} is painted`);
    assert.ok(!plain.includes(ESC), `${label} stays plain by default`);
  }
  // the expected semantic tokens are actually used
  assert.ok(renderMainHelp(style).includes(expectedAnsi16("strong", "Commands:")));
  assert.ok(renderMainHelp(style).includes(expectedAnsi16("accent", "two-brothers run")));
  assert.ok(renderCommandHelp("run", style).includes(expectedAnsi16("strong", "Usage:")));
  assert.ok(renderCommandHelp("run", style).includes(expectedAnsi16("strong", "Flags:")));
  assert.ok(renderCommandHelp("run", style).includes(expectedAnsi16("dim", "<openai|mock>")));
});

const doctorReport = {
  ok: false,
  checks: [
    { id: "engine", label: "Node engine", status: "pass" as const, detail: "v22.19.0" },
    { id: "settings", label: "Settings file", status: "warn" as const, detail: "missing" },
    { id: "roles", label: "Role configuration", status: "fail" as const, detail: "no base URL" },
    { id: "endpoint", label: "Provider endpoint", status: "skip" as const, detail: "mock" },
  ],
};

test("doctor: report lines paint status tags by severity and strip back", () => {
  const style = ansi16Style();
  const plain = formatDoctorReport(doctorReport);
  const colored = formatDoctorReport(doctorReport, style);
  assert.equal(colored.length, plain.length);
  for (let index = 0; index < plain.length; index++) {
    assert.equal(stripAnsi(colored[index]), plain[index], `line ${index}`);
  }
  assert.ok(colored[0].includes(expectedAnsi16("success", "pass")));
  assert.ok(colored[0].includes(expectedAnsi16("strong", "Node engine")));
  assert.ok(colored[1].includes(expectedAnsi16("warning", "warn")));
  assert.ok(colored[2].includes(expectedAnsi16("error", "fail")));
  assert.ok(colored[3].includes(expectedAnsi16("dim", "skip")));
});

const transcript: Array<Record<string, any>> = [
  { from: "user", to: "senior", kind: "message", payload: { text: "hello" } },
  {
    from: "senior",
    to: "junior",
    kind: "consult",
    payload: { ask: "why", expect: "proposal" },
  },
  {
    from: "junior",
    to: "senior",
    kind: "proposal",
    payload: { title: "Plan", answer: "Do it", risks: ["risk"], confidence: 0.7 },
  },
  {
    from: "senior",
    to: "user",
    kind: "decision",
    payload: {
      decision: "go",
      rationale: "because",
      confidence: 0.8,
      dissent: "no",
      accepted_proposals: ["Plan"],
    },
  },
];

test("cli transcript: role headers, kinds, keys and values paint and strip back", () => {
  const style = ansi16Style();
  const plain = renderMessages(transcript, false);
  const colored = renderMessages(transcript, false, style);
  assert.equal(stripAnsi(colored), plain);
  assert.ok(!plain.includes(ESC));
  assert.equal(plain.split("\n")[0], "[user]      hello");
  assert.ok(colored.includes(expectedAnsi16("user", "user")));
  assert.ok(colored.includes(expectedAnsi16("senior", "senior")));
  assert.ok(colored.includes(expectedAnsi16("junior", "junior")));
  assert.ok(colored.includes(createTheme("ansi16").dim("decision:")));
  assert.ok(colored.includes(expectedAnsi16("decision", "go")));
  assert.ok(colored.includes(expectedAnsi16("dissent", "no")));
  assert.ok(colored.includes(expectedAnsi16("warning", "risk")));
});

test("cli footers: usageLine and costLine paint and strip back", () => {
  const style = ansi16Style();
  const usage = { input_tokens: 4000, output_tokens: 2000, cached_tokens: 1000, model_calls: 4 };
  const plainUsage = usageLine(usage);
  const coloredUsage = usageLine(usage, style);
  assert.equal(plainUsage, "tokens: 4000/2000 (cache 25%, 4 model calls)");
  assert.equal(stripAnsi(coloredUsage), plainUsage);
  assert.ok(coloredUsage.includes(expectedAnsi16("muted", "tokens:")));

  const cfg = resolveConfig({
    provider: "mock",
    seniorModel: "gpt-4o",
    juniorModel: "gpt-4o",
  });
  const plainCost = costLine(cfg, { input_tokens: 4000, output_tokens: 2000 });
  const coloredCost = costLine(cfg, { input_tokens: 4000, output_tokens: 2000 }, style);
  assert.equal(plainCost, "cost: $0.0300 (in 4000 / out 2000 tokens)");
  assert.equal(stripAnsi(coloredCost as string), plainCost);
  assert.ok((coloredCost as string).includes(expectedAnsi16("strong", "$0.0300")));
});

test("clistyle.ts spells no escape sequence: the TUI theme owns the ANSI vocabulary", () => {
  const source = readFileSync(new URL("../src/clistyle.ts", import.meta.url), "utf8");
  assert.ok(!/\\x1b|\\u001b|\\u001B/.test(source), "clistyle.ts must not spell ANSI");
  assert.match(source, /tui\/theme\.ts/, "clistyle.ts reuses the theme layer");
  assert.ok(!/from "zod"|from "@earendil/.test(source), "clistyle.ts adds no dependency");
});
