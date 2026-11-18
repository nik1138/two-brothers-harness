/**
 * TUI MCP visibility: the pure status derivation (`src/tui/mcpstatus.ts`),
 * the footer chip in the status bar, and the side panel's per-server rows.
 * Hermetic and offline: the fixtures are plain structural stand-ins for the
 * `McpToolSet` contract (no transports, no network).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MCP_ERROR_PREFIX,
  mcpServerLine,
  mcpStatusChip,
  mcpStatusFromToolSet,
  parseMcpErrorLine,
  type McpToolSetLike,
} from "../src/tui/mcpstatus.ts";
import { stripAnsi } from "../src/tui/screen.ts";
import { createTheme } from "../src/tui/theme.ts";
import {
  sidePanelEntries,
  sidePanelRows,
  type SidePanelState,
} from "../src/tui/view/sidepanel.ts";
import { renderStatusBar, statusBarSegments } from "../src/tui/view/statusbar.ts";

function toolSet(partial: Partial<McpToolSetLike> & Pick<McpToolSetLike, "client">): McpToolSetLike {
  return { tools: [], errors: [], ...partial };
}

test("mcpstatus: parseMcpErrorLine splits the stable prefix", () => {
  assert.deepEqual(parseMcpErrorLine("MCP server 'fs': spawn failed"), {
    name: "fs",
    error: "spawn failed",
  });
  assert.deepEqual(parseMcpErrorLine(`${MCP_ERROR_PREFIX}web': timed out`), {
    name: "web",
    error: "timed out",
  });
  // Detail-empty lines still parse; foreign lines do not.
  assert.deepEqual(parseMcpErrorLine("MCP server 'x':"), { name: "x", error: "" });
  assert.equal(parseMcpErrorLine("plugins: boom"), null);
  assert.equal(parseMcpErrorLine("MCP server '': empty name"), null);
  assert.equal(parseMcpErrorLine("not an error line at all"), null);
});

test("mcpstatus: derives connected/failed/toolCount per server", () => {
  const snapshot = mcpStatusFromToolSet(
    toolSet({
      client: { servers: ["alpha", "beta"] },
      tools: [
        { server: "alpha" },
        { server: "alpha" },
        { server: "beta" },
      ],
      errors: ["MCP server 'beta': transport closed"],
    }),
    "2026-11-18T00:00:00.000Z",
  );
  assert.deepEqual(snapshot, {
    at: "2026-11-18T00:00:00.000Z",
    servers: [
      { name: "alpha", status: "connected", toolCount: 2 },
      { name: "beta", status: "failed", error: "transport closed", toolCount: 1 },
    ],
  });
});

test("mcpstatus: failed-only tool set still lists the failed servers", () => {
  const snapshot = mcpStatusFromToolSet(
    toolSet({
      client: { servers: [] },
      errors: ["MCP server 'gone': executable not found"],
    }),
  );
  assert.deepEqual(snapshot?.servers, [
    { name: "gone", status: "failed", error: "executable not found", toolCount: 0 },
  ]);
});

test("mcpstatus: a server in both servers and errors counts once, as failed", () => {
  const snapshot = mcpStatusFromToolSet(
    toolSet({
      client: { servers: ["flaky"] },
      tools: [{ server: "flaky" }],
      errors: ["MCP server 'flaky': tools listing timed out"],
    }),
  );
  assert.equal(snapshot?.servers.length, 1);
  assert.equal(snapshot?.servers[0]?.status, "failed");
});

test("mcpstatus: null tool set stays null (not configured)", () => {
  assert.equal(mcpStatusFromToolSet(null), null);
});

test("mcpstatus: zero-server snapshot is distinct from not-configured", () => {
  const snapshot = mcpStatusFromToolSet(toolSet({ client: { servers: [] } }));
  assert.equal(snapshot?.servers.length, 0);
  assert.equal(mcpStatusChip(snapshot), null, "zero servers → no chip");
  assert.equal(mcpStatusChip(null), null, "not configured → no chip");
});

test("mcpstatus: chip text all-connected vs failed", () => {
  const allFine = mcpStatusFromToolSet(toolSet({ client: { servers: ["a", "b", "c"] } }));
  assert.deepEqual(mcpStatusChip(allFine), { text: "3 MCP", failed: false });
  const oneFailed = mcpStatusFromToolSet(
    toolSet({
      client: { servers: ["a", "b"] },
      errors: ["MCP server 'b': refused"],
    }),
  );
  assert.deepEqual(mcpStatusChip(oneFailed), { text: "1 MCP failed", failed: true });
});

test("mcpstatus: mcpServerLine formats both statuses", () => {
  assert.equal(
    mcpServerLine({ name: "fs", status: "connected", toolCount: 3 }),
    "fs connected (3 tools)",
  );
  assert.equal(
    mcpServerLine({ name: "fs", status: "connected", toolCount: 1 }),
    "fs connected (1 tool)",
  );
  assert.equal(
    mcpServerLine({ name: "fs", status: "failed", error: "boom", toolCount: 0 }),
    "fs failed — boom",
  );
  assert.equal(mcpServerLine({ name: "fs", status: "failed", toolCount: 0 }), "fs failed");
});

// ------------------------------------------------------------------------- //
// footer chip through the real status-bar render path
// ------------------------------------------------------------------------- //

test("status bar: all-connected renders a dim `{n} MCP` chip", () => {
  const theme = createTheme("dark");
  const rows = renderStatusBar(
    { mode: "consult", seniorModel: "s", juniorModel: "j", mcp: { total: 2, failed: 0 } },
    { width: 80, theme },
  );
  const first = stripAnsi(rows[0] ?? "");
  assert.match(first, /\b2 MCP\b/);
  assert.ok(
    !(rows[0] ?? "").includes(theme.paint("error", "2 MCP")),
    "no error tone when fine",
  );
});

test("status bar: a failure renders a red `{n} MCP failed` chip", () => {
  const theme = createTheme("dark");
  const state = { mode: "consult", seniorModel: "s", juniorModel: "j", mcp: { total: 3, failed: 1 } };
  const withChip = renderStatusBar(state, { width: 80, theme })[0] ?? "";
  const withoutChip = renderStatusBar(
    { mode: "consult", seniorModel: "s", juniorModel: "j" },
    { width: 80, theme },
  )[0] ?? "";
  assert.match(stripAnsi(withChip), /\b1 MCP failed\b/);
  assert.ok(withChip.includes(theme.paint("error", "1 MCP failed")), "chip painted error-red");
  assert.ok(
    !stripAnsi(withoutChip).includes("MCP"),
    "zero configured servers renders no chip at all",
  );
});

test("status bar: the chip sits after mode and before the role segments", () => {
  const [first] = statusBarSegments({
    mode: "work",
    seniorModel: "s",
    juniorModel: "j",
    mcp: { total: 4, failed: 2 },
  });
  const texts = first.map((segment) => segment.text);
  assert.deepEqual(texts, ["work", "2 MCP failed", "SENIOR s", "JUNIOR j"]);
});

test("status bar: 80-column frame still fits with the chip", () => {
  const theme = createTheme("dark");
  const rows = renderStatusBar(
    {
      mode: "consult",
      seniorModel: "senior-model",
      juniorModel: "junior-model",
      sessionName: "demo",
      mcp: { total: 2, failed: 1 },
      hints: "palette",
    },
    { width: 80, theme },
  );
  assert.equal(rows.length, 2);
  for (const row of rows) assert.ok(stripAnsi(row).length <= 80, `fits: ${stripAnsi(row)}`);
});

// ------------------------------------------------------------------------- //
// side panel per-server rows
// ------------------------------------------------------------------------- //

function panelValues(state: SidePanelState, width = 60): Map<string, string> {
  const rows = sidePanelRows(state, width);
  const values = new Map<string, string>();
  for (const row of rows) {
    const plain = stripAnsi(row);
    const match = /^([A-Z][A-Z ]*)\s+(.*)$/u.exec(plain);
    if (match !== null) values.set(match[1]!.trim(), match[2]!.trim());
  }
  return values;
}

test("side panel: mixed status fixture renders one row per server", () => {
  const state: SidePanelState = {
    mode: "consult",
    mcpServers: [
      { name: "alpha", status: "connected", toolCount: 2 },
      { name: "beta", status: "failed", error: "transport closed", toolCount: 0 },
    ],
  };
  const entries = sidePanelEntries(state);
  const detail = entries.filter((entry) => entry.label === "" && entry.value.includes("MCP") === false && /alpha|beta/.test(entry.value));
  assert.deepEqual(
    detail.map((entry) => `${entry.tone}:${entry.value}`),
    ["dim:alpha connected (2 tools)", "error:beta failed — transport closed"],
  );
});

test("side panel: failed server row is painted in the error tone", () => {
  const theme = createTheme("dark");
  const rows = sidePanelRows(
    {
      mode: "consult",
      mcpServers: [{ name: "beta", status: "failed", error: "transport closed", toolCount: 0 }],
    },
    60,
    theme,
  );
  const failedRow = rows.find((row) => stripAnsi(row).includes("beta failed"));
  assert.ok(failedRow !== undefined);
  assert.ok(failedRow.includes(theme.paint("error", "")), "row uses the error token");
});

test("side panel: without mcpServers the MCP row stays the historical summary", () => {
  const values = panelValues({ mode: "consult", discovery: { mcp: {} } });
  assert.equal(values.get("MCP"), "none configured");
  const rows = sidePanelRows({ mode: "consult", discovery: { mcp: {} } }, 60);
  assert.ok(
    rows.every((row) => !stripAnsi(row).includes("connected")),
    "no per-server rows leak into the historical document",
  );
});

test("side panel: per-server rows survive 80x24 rendering", () => {
  const theme = createTheme("dark");
  const rows = sidePanelRows(
    {
      mode: "consult",
      mcpServers: [
        { name: "alpha", status: "connected", toolCount: 2 },
        { name: "beta", status: "failed", error: "boom", toolCount: 0 },
      ],
    },
    30,
    theme,
  );
  for (const row of rows) assert.ok(stripAnsi(row).length <= 30);
  assert.ok(stripAnsi(rows.join("\n")).includes("beta failed"));
});
