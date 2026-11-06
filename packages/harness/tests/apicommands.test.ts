/**
 * `GET /api/commands`: slash-command metadata only (never template bodies),
 * plus per-mode fields and discovery diagnostics, and the additive first-party
 * `baseCommands` catalogue (`src/basecommands.ts`). In-process server, temp
 * commands directory, mock provider config — fully hermetic.
 *
 * Run with: node --test tests/apicommands.test.ts
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { baseCommandMetadata } from "../src/basecommands.ts";
import { resolveConfig } from "../src/config.ts";
import { createServer } from "../src/server.ts";

function tmpdir(prefix: string): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    root,
    cleanup: () => {
      for (let attempt = 0; ; attempt++) {
        try {
          fs.rmSync(root, { recursive: true, force: true });
          return;
        } catch (exc) {
          if (attempt >= 4) throw exc;
          const deadline = Date.now() + 50 * (attempt + 1);
          while (Date.now() < deadline) {
            // busy-wait: cleanup runs synchronously inside test teardowns
          }
        }
      }
    },
  };
}

test("GET /api/commands lists metadata without bodies and carries mode fields", async () => {
  const sessions = tmpdir("tb-api-commands-sessions-");
  const commands = tmpdir("tb-api-commands-root-");
  const summarize = path.join(commands.root, "summarize.md");
  const plain = path.join(commands.root, "plain.md");
  fs.writeFileSync(
    summarize,
    [
      "---",
      "description: Summarize a document",
      "argument-hint: <path>",
      "mode: work",
      "---",
      "Summarize $ARGUMENTS. SECRET-TEMPLATE-BODY",
      "",
    ].join("\n"),
    "utf-8",
  );
  fs.writeFileSync(
    plain,
    ["---", "description: Plain task.", "---", "Do the plain thing.", ""].join("\n"),
    "utf-8",
  );

  const handle = createServer({
    configFactory: () => resolveConfig({ provider: "mock", mode: "consult" }),
    sessionsDir: sessions.root,
    webDist: null,
    pluginsDir: path.join(sessions.root, "missing-plugins"),
    commandsDirs: [commands.root],
  });
  const server = await handle.listen("127.0.0.1", 0);
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/commands`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      commands: Array<Record<string, unknown>>;
      baseCommands: Array<Record<string, unknown>>;
      diagnostics: string[];
    };

    assert.deepEqual(body.commands, [
      {
        name: "plain",
        description: "Plain task.",
        argumentHint: "",
        file: plain,
      },
      {
        name: "summarize",
        description: "Summarize a document",
        argumentHint: "<path>",
        mode: "work",
        file: summarize,
      },
    ]);
    // a command without a mode has no `mode` key at all; one with it carries it
    assert.ok(!("mode" in body.commands[0]));
    assert.equal(body.commands[1].mode, "work");
    // metadata only: templates never leave the server
    assert.ok(Array.isArray(body.diagnostics));
    assert.ok(!JSON.stringify(body).includes("SECRET-TEMPLATE-BODY"));
    assert.ok(!JSON.stringify(body).includes("Summarize $ARGUMENTS"));
    // the additive first-party catalogue is always present, discovered or not
    assert.deepEqual(body.baseCommands, baseCommandMetadata());
  } finally {
    await handle.close();
    sessions.cleanup();
    commands.cleanup();
  }
});

test("GET /api/commands: baseCommands metadata-only catalogue without command roots", async () => {
  const sessions = tmpdir("tb-api-base-sessions-");
  // No command root at all: discovered list is empty, base list is not.
  const handle = createServer({
    configFactory: () => resolveConfig({ provider: "mock", mode: "consult" }),
    sessionsDir: sessions.root,
    webDist: null,
    pluginsDir: path.join(sessions.root, "missing-plugins"),
    commandsDirs: [],
  });
  const server = await handle.listen("127.0.0.1", 0);
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/commands`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      commands: Array<Record<string, unknown>>;
      baseCommands: Array<Record<string, unknown>>;
      diagnostics: string[];
    };

    assert.deepEqual(body.commands, []);
    assert.deepEqual(body.diagnostics, []);
    assert.deepEqual(body.baseCommands, baseCommandMetadata());

    // Sorted by descending priority, then name: the contract every surface uses.
    const names = body.baseCommands.map((command) => command.name);
    assert.deepEqual(names, [
      "plan",
      "compact",
      "goal",
      "status",
      "export",
      "mode",
      "permission",
      "new",
      "feedback",
      "help",
    ]);
    assert.deepEqual(
      body.baseCommands.map((command) => command.priority),
      [100, 95, 90, 85, 80, 75, 70, 65, 60, 50],
    );

    // Metadata shape per kind: prompt commands carry no `action`, action
    // commands do; bodies/templates never appear.
    for (const command of body.baseCommands) {
      const isAction = command.kind === "action";
      const keys = Object.keys(command);
      assert.ok(keys.includes("name"));
      assert.ok(keys.includes("aliases"));
      assert.ok(keys.includes("description"));
      assert.ok(keys.includes("argumentHint"));
      assert.ok(keys.includes("kind"));
      assert.ok(keys.includes("requiresArguments"));
      assert.ok(keys.includes("priority"));
      assert.equal("template" in command, false);
      assert.equal("body" in command, false);
      assert.equal("file" in command, false);
      if (isAction) assert.equal(typeof command.action, "string");
      else assert.equal("action" in command, false);
    }

    const plan = body.baseCommands.find((command) => command.name === "plan");
    assert.ok(plan);
    assert.equal(plan.kind, "prompt");
    assert.deepEqual(plan.aliases, ["计划"]);
    assert.equal(plan.argumentHint, "<objective>");
    assert.equal(plan.requiresArguments, true);
    const compact = body.baseCommands.find((command) => command.name === "compact");
    assert.ok(compact);
    assert.equal(compact.kind, "action");
    assert.equal(compact.action, "compact");
    assert.deepEqual(compact.aliases, ["压缩"]);
    assert.equal(compact.requiresArguments, false);
    const help = body.baseCommands.find((command) => command.name === "help");
    assert.ok(help);
    assert.deepEqual(help.aliases, ["h", "?"]);

    // Metadata only, like the discovered catalogue: no template bodies.
    assert.ok(!JSON.stringify(body).includes("The operator wants a plan"));
    assert.ok(!JSON.stringify(body).includes("Session goal"));
  } finally {
    await handle.close();
    sessions.cleanup();
  }
});