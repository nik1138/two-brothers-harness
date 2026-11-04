/**
 * `GET /api/commands`: slash-command metadata only (never template bodies),
 * plus per-mode fields and discovery diagnostics. In-process server, temp
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
  } finally {
    await handle.close();
    sessions.cleanup();
    commands.cleanup();
  }
});