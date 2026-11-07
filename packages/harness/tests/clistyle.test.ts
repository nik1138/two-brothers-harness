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
  helpColumns,
  renderBriefUsage,
  renderCommandHelp,
  renderFullHelp,
  renderMainHelp,
} from "../src/clihelp.ts";
import {
  RULE_MAX_WIDTH,
  createLiveTranscript,
  humanFooter,
  renderActivityLine,
  renderEnvelopeBlock,
  renderLabeledRule,
  ruleWidth,
} from "../src/clilayout.ts";
import { costLine, renderMessages, usageLine } from "../src/cli.ts";
import { formatDoctorReport } from "../src/doctor.ts";
import { resolveConfig } from "../src/config.ts";
import { displayWidth } from "../src/tui/text.ts";
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

// ---------------------------------------------------------------------------
// human text layout: block separation, decision rule, Markdown bodies, footer
// ---------------------------------------------------------------------------

/** A transcript whose prose bodies carry Markdown, inline markers and a fence. */
const markdownTranscript: Array<Record<string, any>> = [
  { from: "user", to: "senior", kind: "message", payload: { text: "do the thing" } },
  {
    from: "junior",
    to: "senior",
    kind: "proposal",
    payload: {
      title: "Plan",
      answer:
        "## Sub head\n\n**bold** and `code` and *italic*\n\n- item one\n- item two",
      confidence: 0.5,
    },
  },
  {
    from: "senior",
    to: "junior",
    kind: "review",
    payload: { verdict: "accept", notes: "All **good**.\n\n```ts\nconst x = 1;\n```" },
  },
  {
    from: "senior",
    to: "user",
    kind: "decision",
    payload: { decision: "go **now**", rationale: "because `why`", confidence: 0.9, dissent: null },
  },
];

test("cli layout: envelopes are blank-line separated and the decision is ruled off", () => {
  const plain = renderMessages(transcript, false, plainCliStyle, FALLBACK_TERMINAL_WIDTH);
  const lines = plain.split("\n");
  assert.equal(lines[0], "[user]      hello");
  // exactly one blank line between consecutive envelope blocks
  assert.match(plain, /\n\n\[senior -> junior\] consult\n/);
  assert.match(plain, /\n\n\[junior -> senior\] proposal\n/);
  assert.ok(!plain.includes(ESC));

  const ruleIndex = lines.findIndex((line) => line.startsWith("── decision ─"));
  assert.ok(ruleIndex >= 0, "the decision rule is missing");
  assert.equal(lines[ruleIndex + 1], "[senior -> user] decision");
  assert.equal(displayWidth(lines[ruleIndex] as string), RULE_MAX_WIDTH);
  assert.equal(lines.filter((line) => line.startsWith("── decision")).length, 1);

  // the rule is width-capped to the calling width as well
  const narrow = renderMessages(transcript, false, plainCliStyle, 40);
  const narrowRule = narrow
    .split("\n")
    .find((line) => line.startsWith("── decision")) as string;
  assert.equal(displayWidth(narrowRule), 40);
});

test("cli layout: model Markdown bodies render width-safe and strip back", () => {
  const width = 60;
  const plain = renderMessages(markdownTranscript, false, plainCliStyle, width);
  const colored = renderMessages(markdownTranscript, false, ansi16Style(), width);
  assert.equal(stripAnsi(colored), plain);
  assert.ok(!plain.includes(ESC));
  for (const line of plain.split("\n")) {
    assert.ok(displayWidth(line) <= width, `line over ${width}: ${JSON.stringify(line)}`);
  }
  // block structure and inline markers render (markers are structure, not text)
  assert.match(plain, /^    answer: ## Sub head$/m);
  assert.ok(plain.includes("bold and code and italic"), plain);
  assert.ok(plain.includes("- item one"), plain);
  assert.ok(plain.includes("┌─ ts"), plain);
  assert.ok(plain.includes("const x = 1;"), plain);
  assert.ok(plain.includes("└─"), plain);
  // continuation rows hang under the body column (4 indent + key + space)
  assert.match(plain, /\n {12}bold and code and italic/);

  // the inline emphasis is painted through the theme's emphasis vocabulary
  const theme = createTheme("ansi16");
  assert.ok(colored.includes(theme.paintEmphasis("junior", "bold", "bold")));
  assert.ok(colored.includes(theme.paintEmphasis("junior", "code", "code")));
  assert.ok(colored.includes(theme.paintEmphasis("strong", undefined, "Sub head")));
  assert.ok(colored.includes(theme.paintEmphasis("success", undefined, "accept")));
});

test("cli layout: model control bytes and ANSI never reach the output", () => {
  const hostile: Array<Record<string, any>> = [
    { from: "user", to: "senior", kind: "message", payload: { text: "task\u0007" } },
    {
      from: "junior",
      to: "senior",
      kind: "proposal",
      payload: {
        title: "\u001b[31mred\u001b[0m\u0007 title",
        answer: "\u001b[2Jcleared\u0000zero",
        risks: ["\u001b[31mrisk\u001b[0m"],
      },
    },
  ];
  const plain = renderMessages(hostile, false, plainCliStyle, FALLBACK_TERMINAL_WIDTH);
  const colored = renderMessages(hostile, false, ansi16Style(), FALLBACK_TERMINAL_WIDTH);
  assert.equal(stripAnsi(colored), plain);
  assert.ok(!plain.includes(ESC), "a model ANSI sequence leaked into the transcript");
  assert.ok(
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(plain),
    "a model control byte leaked into the transcript",
  );
  assert.ok(plain.includes("red title"), plain);
  assert.ok(plain.includes("clearedzero"), plain);
  assert.ok(plain.includes("- risk"), plain);
});

test("cli layout: the compact human footer appears only when usage data exists", () => {
  const usage = { input_tokens: 4000, output_tokens: 2000, cached_tokens: 1000, model_calls: 4 };
  assert.equal(
    humanFooter(usage, 0.03, plainCliStyle, FALLBACK_TERMINAL_WIDTH),
    "tokens 4000 in / 2000 out · cache 25% · 4 calls · cost $0.0300",
  );
  assert.equal(
    humanFooter(
      { input_tokens: 40, output_tokens: 20, model_calls: 4 },
      null,
      plainCliStyle,
      FALLBACK_TERMINAL_WIDTH,
    ),
    "tokens 40 in / 20 out · 4 calls",
  );
  assert.equal(
    humanFooter({ model_calls: 1 }, null, plainCliStyle, FALLBACK_TERMINAL_WIDTH),
    "tokens 0 in / 0 out · 1 call",
  );
  assert.equal(humanFooter({}, null, plainCliStyle, FALLBACK_TERMINAL_WIDTH), null);

  const style = ansi16Style();
  const colored = humanFooter(usage, 0.03, style, FALLBACK_TERMINAL_WIDTH) as string;
  assert.equal(stripAnsi(colored), humanFooter(usage, 0.03, plainCliStyle, FALLBACK_TERMINAL_WIDTH));
  assert.ok(colored.includes(expectedAnsi16("muted", "tokens")));
  assert.ok(colored.includes(expectedAnsi16("strong", "$0.0300")));

  // width-capped: a narrow terminal shortens instead of overflowing
  const narrow = humanFooter(usage, 3.5, plainCliStyle, 30) as string;
  assert.ok(displayWidth(narrow) <= 30, narrow);
  assert.ok(narrow.endsWith("…"), narrow);
});

test("cli layout: ruleWidth caps at both the width and the maximum rule", () => {
  assert.equal(ruleWidth(FALLBACK_TERMINAL_WIDTH), RULE_MAX_WIDTH);
  assert.equal(ruleWidth(200), RULE_MAX_WIDTH);
  assert.equal(ruleWidth(40), 40);
  assert.equal(ruleWidth(Number.NaN), 1);
  const plain = renderLabeledRule("decision", FALLBACK_TERMINAL_WIDTH);
  assert.equal(displayWidth(plain), RULE_MAX_WIDTH);
  assert.ok(plain.startsWith("── decision ─"));
});

test("clilayout.ts spells no escape sequence and reuses the pure renderers", () => {
  const source = readFileSync(new URL("../src/clilayout.ts", import.meta.url), "utf8");
  assert.ok(!/\\x1b|\\u001b|\\u001B/.test(source), "clilayout.ts must not spell ANSI");
  assert.match(source, /tui\/markdownstyle\.ts/, "Markdown comes from the one pure renderer");
  assert.match(source, /tui\/text\.ts/, "sanitizing/width comes from the shared text helpers");
  assert.match(source, /paintEmphasis/, "spans are painted through CliStyle");
  assert.ok(!/from "zod"|from "@earendil/.test(source), "clilayout.ts adds no dependency");
});

// ---------------------------------------------------------------------------
// responsive help columns
// ---------------------------------------------------------------------------

/** The plain help lines belonging to one command's `Flags:` block. */
function flagBlockLines(command: string, width: number): string[] {
  const text = renderCommandHelp(command, plainCliStyle, width);
  const start = text.indexOf("Flags:");
  const end = text.indexOf("Examples:");
  assert.ok(start >= 0 && end > start, "help block missing Flags/Examples");
  return text.slice(start, end).split("\n");
}

test("clihelp: generated help columns scale with the terminal width", () => {
  const legacy = helpColumns(FALLBACK_TERMINAL_WIDTH);
  assert.deepEqual(legacy, { command: 40, flag: 40, variable: 48 });
  assert.deepEqual(helpColumns(Number.NaN), legacy);
  const wide = helpColumns(160);
  assert.ok(wide.command > legacy.command, `wide command column ${wide.command}`);
  const narrow = helpColumns(60);
  assert.ok(narrow.command < legacy.command, `narrow command column ${narrow.command}`);
  assert.ok(narrow.flag < legacy.flag, `narrow flag column ${narrow.flag}`);

  // a wide TTY puts a long command and its summary on one aligned row...
  const sessionsWide = renderMainHelp(plainCliStyle, 160)
    .split("\n")
    .find((line) => line.includes("two-brothers sessions")) as string;
  assert.ok(
    sessionsWide.includes("list, read, search and export stored sessions"),
    sessionsWide,
  );
  // ...while the 96-column fallback keeps the historical two-line layout
  const sessionsFallback = renderMainHelp(plainCliStyle, FALLBACK_TERMINAL_WIDTH)
    .split("\n")
    .find((line) => line.includes("two-brothers sessions")) as string;
  assert.ok(
    !sessionsFallback.includes("list, read, search and export stored sessions"),
    sessionsFallback,
  );

  // painted renderers still strip back to the plain bytes at every width
  for (const width of [60, FALLBACK_TERMINAL_WIDTH, 160]) {
    assert.equal(
      stripAnsi(renderMainHelp(ansi16Style(), width)),
      renderMainHelp(plainCliStyle, width),
      `main help width ${width}`,
    );
    assert.equal(
      stripAnsi(renderCommandHelp("run", ansi16Style(), width)),
      renderCommandHelp("run", plainCliStyle, width),
      `run help width ${width}`,
    );
  }

  // a narrow flag column keeps every flag row inside the terminal
  for (const line of flagBlockLines("run", 60)) {
    assert.ok(displayWidth(line) <= 60, `flag line over 60: ${JSON.stringify(line)}`);
  }
});

// ---------------------------------------------------------------------------
// live transcript: per-envelope renderer, activity rows, one footer
// ---------------------------------------------------------------------------

test("cli layout: the per-envelope renderer is the whole-transcript block", () => {
  for (const message of transcript) {
    assert.equal(
      renderEnvelopeBlock(message, false, plainCliStyle, FALLBACK_TERMINAL_WIDTH).join("\n"),
      renderMessages([message], false, plainCliStyle, FALLBACK_TERMINAL_WIDTH),
    );
  }
  // verbose adds the payload JSON row to the same block
  const verboseBlock = renderEnvelopeBlock(
    transcript[1],
    true,
    plainCliStyle,
    FALLBACK_TERMINAL_WIDTH,
  );
  assert.equal(verboseBlock.length, 4, verboseBlock.join("\n"));
  assert.match(verboseBlock[1] as string, /^ {4}\{/);
});

test("cli layout: activity rows are dim, width-capped and sanitized", () => {
  const plain = renderActivityLine("senior consulting…", plainCliStyle, FALLBACK_TERMINAL_WIDTH);
  assert.equal(plain, "· senior consulting…");
  assert.equal(renderActivityLine("", plainCliStyle, FALLBACK_TERMINAL_WIDTH), "");
  assert.equal(renderActivityLine("   ", plainCliStyle, FALLBACK_TERMINAL_WIDTH), "");

  const colored = renderActivityLine("senior consulting…", ansi16Style(), FALLBACK_TERMINAL_WIDTH);
  assert.equal(stripAnsi(colored), plain);
  assert.equal(colored, createTheme("ansi16").dim("· senior consulting…"));

  // a model/tool-supplied control sequence can never reach the terminal
  const hostile = renderActivityLine("senior\u001b[31m consulting\u0007", plainCliStyle, 96);
  assert.equal(hostile, "· senior consulting", JSON.stringify(hostile));

  // narrow widths shorten with the shared ellipsis instead of overflowing
  const long = renderActivityLine("x".repeat(200), plainCliStyle, 40);
  assert.ok(displayWidth(long) <= 40, `${displayWidth(long)} > 40`);
  assert.ok(long.endsWith("…"), long);
});

/** Collect one live transcript's sink calls with a fixed event script. */
function collectLive(style: CliStyle, width: number): string[] {
  const lines: string[] = [];
  const live = createLiveTranscript({ log: (line) => lines.push(line) }, { style, width });
  live.envelope(transcript[0] as Record<string, any>);
  live.activity("senior consulting…");
  live.envelope(transcript[1] as Record<string, any>);
  live.activity("tool workspace_read_file…"); // no such tool in this fixture: row only
  live.envelope(transcript[2] as Record<string, any>);
  live.envelope(transcript[3] as Record<string, any>);
  live.foot("tokens 40 in / 20 out · 4 calls");
  return lines;
}

test("cli layout: the live transcript writes blocks immediately and foots once", () => {
  const lines: string[] = [];
  const live = createLiveTranscript(
    { log: (line) => lines.push(line) },
    { style: plainCliStyle, width: FALLBACK_TERMINAL_WIDTH },
  );
  live.envelope(transcript[0] as Record<string, any>);
  assert.deepEqual(lines, ["[user]      hello"], "first block is written by the envelope call");
  assert.equal(live.envelopes, 1);
  assert.equal(live.activities, 0);

  live.activity("senior consulting…");
  assert.deepEqual(lines.slice(1), ["· senior consulting…"]);
  assert.equal(live.activities, 1);

  live.envelope(transcript[1] as Record<string, any>);
  assert.equal(lines[2], "", "a later block is preceded by one blank row");
  assert.match(lines[3] as string, /^\[senior -> junior\] consult/);
  assert.equal(live.envelopes, 2);

  // an empty activity row is a no-op; the footer prints exactly once
  live.activity("");
  assert.equal(live.activities, 1);
  live.foot("tokens 40 in / 20 out · 4 calls");
  live.foot("tokens 999 in / 999 out · 9 calls");
  assert.deepEqual(lines.slice(-2), ["", "tokens 40 in / 20 out · 4 calls"]);
  assert.equal(lines.filter((line) => line.startsWith("tokens ")).length, 1);
});

test("cli layout: live transcript bytes equal the finished render minus activity", () => {
  const width = FALLBACK_TERMINAL_WIDTH;
  const liveText = collectLive(plainCliStyle, width).join("\n");
  const expected = renderMessages(
    transcript as Array<Record<string, any>>,
    false,
    plainCliStyle,
    width,
  );
  const footer = "tokens 40 in / 20 out · 4 calls";
  const withoutActivity = liveText
    .split("\n")
    .filter((row) => !row.startsWith("· "))
    .join("\n");
  assert.equal(withoutActivity, `${expected}\n\n${footer}`);
  // the live transcript is still width-safe row by row
  for (const row of liveText.split("\n")) {
    assert.ok(displayWidth(row) <= width, `${JSON.stringify(row)} > ${width}`);
  }
});

test("cli layout: a colored live transcript strips back to the plain one", () => {
  const plain = collectLive(plainCliStyle, FALLBACK_TERMINAL_WIDTH).join("\n");
  const coloredLines = collectLive(ansi16Style(), FALLBACK_TERMINAL_WIDTH);
  const colored = coloredLines.join("\n");
  assert.ok(colored.includes(ESC), "activity/blocks must paint when color is on");
  assert.equal(stripAnsi(colored), plain);
  assert.equal(coloredLines.length, collectLive(plainCliStyle, FALLBACK_TERMINAL_WIDTH).length);
});
