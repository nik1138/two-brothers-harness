/**
 * Run-scoped workspace edit undo — HTTP routes and serve-run capture wiring
 * (wave 23, `src/workspacehistory.ts` + `src/server.ts`).
 *
 * The store is a PERSISTED session side artifact under `<sessionsDir>/undo`, so
 * these tests exercise the restart-resilient contract: preview/apply/discard a
 * workspace-bound run's file mutations after the backend that made them is
 * gone, with the documented 404/409/422 guards and no faked state.
 *
 * Everything here is hermetic: scripted providers, in-process loopback HTTP,
 * temp session/workspace dirs. No network, no subprocesses.
 *
 * Run with: node tests/run-all.ts (or node --test tests/serverundo.test.ts)
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { resolveConfig } from "../src/config.ts";
import type { ChatMessage, ToolCall } from "../src/context.ts";
import {
  type Provider,
  type Tool,
  type ToolChatOptions,
  type ToolChatResponse,
} from "../src/provider.ts";
import { createServer, type ServerOptions } from "../src/server.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tmpdir(prefix: string): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const VALID: Record<string, Record<string, unknown>> = {
  consult: { task: "t", ask: "a", expect: "proposal", deadline_hint: "today" },
  proposal: { title: "P", answer: "A", rationale: "R", risks: [], confidence: 0.7, asks: [] },
  delegation: { work: "W", acceptance: ["done"], return: "deliverable", notes: "" },
  deliverable: { result: "R", artifacts: [], notes: "", confidence: 0.8 },
  review: { verdict: "accept", notes: "", points: [] },
  decision: { decision: "D", rationale: "", confidence: 0.7, dissent: null, accepted_proposals: [] },
};

function validReply(kind: string): string {
  return JSON.stringify(VALID[kind]);
}

function toolCall(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id, name, args };
}

/** One scripted `chatWithTools` round: tool calls and/or final text. */
interface ToolRound {
  toolCalls?: ToolCall[];
  text?: string;
}

/** A scripted provider recording nothing but answering from per-kind queues. */
class ScriptedProvider implements Provider {
  private readonly toolQueues: Record<string, ToolRound[]>;
  private readonly chatQueues: Record<string, string[]>;

  constructor(script: { tools?: Record<string, ToolRound[]>; chat?: Record<string, string[]> } = {}) {
    this.toolQueues = Object.fromEntries(
      Object.entries(script.tools ?? {}).map(([key, value]) => [key, [...value]]),
    );
    this.chatQueues = Object.fromEntries(
      Object.entries(script.chat ?? {}).map(([key, value]) => [key, [...value]]),
    );
  }

  async chat(_messages: ChatMessage[], responseKind = "message"): Promise<string> {
    const queue = this.chatQueues[responseKind];
    if (queue !== undefined && queue.length > 0) return queue.shift()!;
    return validReply(responseKind);
  }

  async chatWithTools(
    _messages: ChatMessage[],
    _tools: Tool[],
    options: ToolChatOptions = {},
  ): Promise<ToolChatResponse> {
    const kind = options.responseKind ?? "deliverable";
    const queue = this.toolQueues[kind];
    const round = queue?.shift();
    if (round === undefined) return { content: validReply(kind), toolCalls: [] };
    return { content: round.text ?? "", toolCalls: round.toolCalls ?? [] };
  }
}

interface ServerFixture {
  base: string;
  handle: ReturnType<typeof createServer>;
  close(): Promise<void>;
}

/** Start one in-process server over a CALLER-owned sessions directory. */
async function startServer(
  sessionsDir: string,
  options: Partial<ServerOptions> = {},
): Promise<ServerFixture> {
  const handle = createServer({
    configFactory: () => resolveConfig({ provider: "mock", mode: "work" }),
    webDist: null,
    workers: 1,
    sessionsDir,
    approvalPolicy: "allow-all",
    ...options,
  });
  const server = await handle.listen("127.0.0.1", 0);
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, handle, close: () => handle.close() };
}

/** A workspace-bound work-mode junior that writes, edits, then deletes. */
function mutationProviders(): { senior: ScriptedProvider; junior: ScriptedProvider } {
  return {
    senior: new ScriptedProvider({ tools: { verify: [{ text: "" }] } }),
    junior: new ScriptedProvider({
      tools: {
        deliverable: [
          {
            toolCalls: [
              toolCall("call-create", "workspace_write_file", {
                path: "created.txt",
                content: "made by the run\n",
              }),
            ],
          },
          {
            toolCalls: [
              toolCall("call-edit", "workspace_edit_file", {
                path: "existing.txt",
                old: "original",
                new: "edited",
              }),
            ],
          },
          {
            toolCalls: [toolCall("call-delete", "workspace_delete_file", { path: "doomed.txt" })],
          },
          { text: validReply("deliverable") },
        ],
      },
    }),
  };
}

/** Create + register a temp workspace, seeded with an editable and a doomed file. */
async function seedWorkspace(
  base: string,
  root: string,
): Promise<{ id: string; dir: string }> {
  const dir = path.join(root, "workspace");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "existing.txt"), "original\n", "utf-8");
  fs.writeFileSync(path.join(dir, "doomed.txt"), "bye\n", "utf-8");
  const created = await post<Record<string, any>>(base, "/api/workspaces", { path: dir, name: "undo-ws" });
  assert.equal(created.status, 201);
  return { id: String(created.body.id), dir };
}

async function submitWorkspaceRun(
  base: string,
  workspaceId: string,
  session = "chat",
): Promise<{ runId: string; sessionName: string }> {
  const started = await post<Record<string, any>>(base, "/api/runs", {
    task: "do the work",
    mode: "work",
    session,
    workspace_id: workspaceId,
  });
  assert.equal(started.status, 202);
  return { runId: String(started.body.run_id), sessionName: String(started.body.session) };
}

async function api<T = unknown>(
  base: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(base + route, init);
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed as T };
}

const post = <T = unknown>(base: string, route: string, body?: unknown) =>
  api<T>(base, "POST", route, body);
const get = <T = unknown>(base: string, route: string) => api<T>(base, "GET", route);
const del = <T = unknown>(base: string, route: string) => api<T>(base, "DELETE", route);

async function waitFor(condition: () => boolean, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition did not become true in time");
    await sleep(15);
  }
}

async function waitTerminal(
  base: string,
  runId: string,
  timeoutMs = 20000,
): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await get<Record<string, any>>(base, `/api/runs/${runId}`);
    if (["completed", "failed", "cancelled"].includes(String(body.status))) return body;
    if (Date.now() > deadline) throw new Error(`run ${runId} did not finish in time`);
    await sleep(20);
  }
}

/** path → preview status for compact assertions. */
function statuses(preview: Record<string, any>): Record<string, string> {
  return Object.fromEntries(
    (preview.statuses as Array<Record<string, any>>).map((entry) => [entry.path, entry.status]),
  );
}

/** Wrap one provider's chatWithTools and park its Nth call until released. */
function gatedToolsAt(
  inner: Provider,
  callNumber: number,
): { provider: Provider; entered: () => boolean; release(): void } {
  let count = 0;
  let entered = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider: Provider = {
    async chat(messages: ChatMessage[], responseKind?: string): Promise<string> {
      return inner.chat(messages, responseKind);
    },
    async chatWithTools(
      messages: ChatMessage[],
      tools: Tool[],
      options?: ToolChatOptions,
    ): Promise<ToolChatResponse> {
      count += 1;
      if (count === callNumber) {
        entered = true;
        await gate;
      }
      return inner.chatWithTools!(messages, tools, options);
    },
  };
  return { provider, entered: () => entered, release: () => release() };
}

// ---------------------------------------------------------------------------
// round trip: preview → apply → discard
// ---------------------------------------------------------------------------

test("GET previews a workspace run's mutations, POST applies them, DELETE discards", async () => {
  const tmp = tmpdir("tb-serverundo-");
  const sessionsDir = path.join(tmp.root, "sessions");
  const providers = mutationProviders();
  const srv = await startServer(sessionsDir, { providerOverrides: providers });
  try {
    const workspace = await seedWorkspace(srv.base, tmp.root);
    const { runId, sessionName } = await submitWorkspaceRun(srv.base, workspace.id);
    const terminal = await waitTerminal(srv.base, runId);
    assert.equal(terminal.status, "completed");

    // The run really mutated the workspace.
    assert.equal(fs.readFileSync(path.join(workspace.dir, "existing.txt"), "utf-8"), "edited\n");
    assert.equal(fs.existsSync(path.join(workspace.dir, "doomed.txt")), false);
    assert.equal(fs.readFileSync(path.join(workspace.dir, "created.txt"), "utf-8"), "made by the run\n");

    const preview = await get<Record<string, any>>(
      srv.base,
      `/api/sessions/${encodeURIComponent(sessionName)}/undo/${runId}`,
    );
    assert.equal(preview.status, 200);
    assert.equal(preview.body.session, sessionName);
    assert.equal(preview.body.run_id, runId);
    assert.equal(preview.body.workspace_root, fs.realpathSync(workspace.dir));
    assert.deepEqual(statuses(preview.body), {
      "created.txt": "created",
      "existing.txt": "applicable",
      "doomed.txt": "deleted",
    });
    assert.deepEqual(preview.body.counts, {
      applicable: 1,
      created: 1,
      deleted: 1,
      changed_since: 0,
      skipped: 0,
      missing: 0,
      total: 3,
    });
    // Preview is read-only.
    assert.equal(fs.readFileSync(path.join(workspace.dir, "existing.txt"), "utf-8"), "edited\n");

    const applied = await post<Record<string, any>>(
      srv.base,
      `/api/sessions/${encodeURIComponent(sessionName)}/undo/${runId}`,
    );
    assert.equal(applied.status, 200);
    assert.equal(applied.body.applied, 3);
    assert.equal(applied.body.refused, 0);
    assert.equal(applied.body.failed, 0);
    assert.equal(applied.body.files.length, 3);
    for (const file of applied.body.files as Array<Record<string, any>>) {
      assert.equal(file.status, "applied");
      assert.ok(typeof file.preview_status === "string");
    }
    assert.equal(applied.body.counts.total, 3);
    assert.equal(fs.existsSync(path.join(workspace.dir, "created.txt")), false);
    assert.equal(fs.readFileSync(path.join(workspace.dir, "existing.txt"), "utf-8"), "original\n");
    assert.equal(fs.readFileSync(path.join(workspace.dir, "doomed.txt"), "utf-8"), "bye\n");
    assert.equal(fs.existsSync(path.join(workspace.dir, "created.txt")), false);

    // A second apply refuses everything: the live files no longer match the
    // recorded post-images, so undo never replays a restore.
    const afterPreview = await get<Record<string, any>>(
      srv.base,
      `/api/sessions/${encodeURIComponent(sessionName)}/undo/${runId}`,
    );
    assert.equal(afterPreview.body.counts.changed_since, 3);
    const again = await post<Record<string, any>>(
      srv.base,
      `/api/sessions/${encodeURIComponent(sessionName)}/undo/${runId}`,
    );
    assert.equal(again.body.applied, 0);
    assert.equal(again.body.refused, 3);

    const discarded = await del<Record<string, any>>(
      srv.base,
      `/api/sessions/${encodeURIComponent(sessionName)}/undo/${runId}`,
    );
    assert.equal(discarded.status, 200);
    assert.deepEqual(discarded.body, { discarded: true, session: sessionName, run_id: runId });
    const missing = await get(srv.base, `/api/sessions/${encodeURIComponent(sessionName)}/undo/${runId}`);
    assert.equal(missing.status, 404);
    const missingDiscard = await del(
      srv.base,
      `/api/sessions/${encodeURIComponent(sessionName)}/undo/${runId}`,
    );
    assert.equal(missingDiscard.status, 404);
  } finally {
    await srv.close();
    tmp.cleanup();
  }
});

test("changed-since files are refused while the rest of the run still applies", async () => {
  const tmp = tmpdir("tb-serverundo-");
  const sessionsDir = path.join(tmp.root, "sessions");
  const providers = mutationProviders();
  const srv = await startServer(sessionsDir, { providerOverrides: providers });
  try {
    const workspace = await seedWorkspace(srv.base, tmp.root);
    const { runId, sessionName } = await submitWorkspaceRun(srv.base, workspace.id);
    await waitTerminal(srv.base, runId);

    // An operator/other process changes one of the recorded files afterwards.
    fs.writeFileSync(path.join(workspace.dir, "existing.txt"), "external change\n", "utf-8");

    const preview = await get<Record<string, any>>(
      srv.base,
      `/api/sessions/${encodeURIComponent(sessionName)}/undo/${runId}`,
    );
    assert.equal(statuses(preview.body)["existing.txt"], "changed-since");
    assert.equal(statuses(preview.body)["created.txt"], "created");

    const applied = await post<Record<string, any>>(
      srv.base,
      `/api/sessions/${encodeURIComponent(sessionName)}/undo/${runId}`,
    );
    assert.equal(applied.body.applied, 2);
    assert.equal(applied.body.refused, 1);
    assert.equal(fs.readFileSync(path.join(workspace.dir, "existing.txt"), "utf-8"), "external change\n");
    assert.equal(fs.existsSync(path.join(workspace.dir, "created.txt")), false);
    assert.equal(fs.readFileSync(path.join(workspace.dir, "doomed.txt"), "utf-8"), "bye\n");
  } finally {
    await srv.close();
    tmp.cleanup();
  }
});

test("undo is restart-resilient: a fresh server on the same sessions dir serves it", async () => {
  const tmp = tmpdir("tb-serverundo-");
  const sessionsDir = path.join(tmp.root, "sessions");
  const providers = mutationProviders();
  const first = await startServer(sessionsDir, { providerOverrides: providers });
  let runId = "";
  let sessionName = "";
  let workspaceDir = "";
  try {
    const workspace = await seedWorkspace(first.base, tmp.root);
    workspaceDir = workspace.dir;
    ({ runId, sessionName } = await submitWorkspaceRun(first.base, workspace.id));
    const terminal = await waitTerminal(first.base, runId);
    assert.equal(terminal.status, "completed");
  } finally {
    await first.close();
  }

  // The in-memory run record is gone with the process; the persisted manifest
  // (and the GET /api/runs sidecar fallback) are not what this route uses.
  const second = await startServer(sessionsDir, { providerOverrides: mutationProviders() });
  try {
    assert.equal(second.handle.state.runs.get(runId), null);
    const preview = await get<Record<string, any>>(
      second.base,
      `/api/sessions/${encodeURIComponent(sessionName)}/undo/${runId}`,
    );
    assert.equal(preview.status, 200);
    assert.equal(preview.body.counts.total, 3);
    assert.equal(preview.body.workspace_root, fs.realpathSync(workspaceDir));

    const applied = await post<Record<string, any>>(
      second.base,
      `/api/sessions/${encodeURIComponent(sessionName)}/undo/${runId}`,
    );
    assert.equal(applied.body.applied, 3);
    assert.equal(fs.readFileSync(path.join(workspaceDir, "existing.txt"), "utf-8"), "original\n");
    assert.equal(fs.readFileSync(path.join(workspaceDir, "doomed.txt"), "utf-8"), "bye\n");
    assert.equal(fs.existsSync(path.join(workspaceDir, "created.txt")), false);
  } finally {
    await second.close();
    tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// guards: 404 / 409 / session + workspace identity
// ---------------------------------------------------------------------------

test("404 for an unknown session, an unknown record and a cross-session run id", async () => {
  const tmp = tmpdir("tb-serverundo-");
  const sessionsDir = path.join(tmp.root, "sessions");
  const providers = mutationProviders();
  const srv = await startServer(sessionsDir, { providerOverrides: providers });
  try {
    const workspace = await seedWorkspace(srv.base, tmp.root);
    const { runId, sessionName } = await submitWorkspaceRun(srv.base, workspace.id);
    await waitTerminal(srv.base, runId);

    const noSession = await get(srv.base, "/api/sessions/never.jsonl/undo/aaaaaaaaaaaa");
    assert.equal(noSession.status, 404);
    assert.deepEqual(noSession.body, { detail: "not found" });

    const noRecord = await get(
      srv.base,
      `/api/sessions/${encodeURIComponent(sessionName)}/undo/aaaaaaaaaaaa`,
    );
    assert.equal(noRecord.status, 404);

    // Another real session exists; the run id still belongs to "chat".
    const other = await post<Record<string, any>>(srv.base, "/api/sessions", { title: "Other" });
    assert.ok(["200", "201"].includes(String(other.status)));
    const otherName = String(other.body.name);
    assert.notEqual(otherName, sessionName);
    const crossSession = await get(
      srv.base,
      `/api/sessions/${encodeURIComponent(otherName)}/undo/${runId}`,
    );
    assert.equal(crossSession.status, 404);
  } finally {
    await srv.close();
    tmp.cleanup();
  }
});

test("409 for an unregistered workspace, a corrupt record and an unsupported version", async () => {
  const tmp = tmpdir("tb-serverundo-");
  const sessionsDir = path.join(tmp.root, "sessions");
  const providers = mutationProviders();
  const srv = await startServer(sessionsDir, { providerOverrides: providers });
  try {
    const workspace = await seedWorkspace(srv.base, tmp.root);
    const { runId, sessionName } = await submitWorkspaceRun(srv.base, workspace.id);
    await waitTerminal(srv.base, runId);
    const undoUrl = (id: string): string =>
      `/api/sessions/${encodeURIComponent(sessionName)}/undo/${id}`;
    const runsDir = path.join(sessionsDir, "undo", "runs");
    const valid = JSON.parse(
      fs.readFileSync(path.join(runsDir, `${runId}.json`), "utf-8"),
    ) as Record<string, unknown>;

    fs.writeFileSync(path.join(runsDir, "badrecord.json"), "{not json", "utf-8");
    const corrupt = await get<Record<string, any>>(srv.base, undoUrl("badrecord"));
    assert.equal(corrupt.status, 409);
    assert.match(String(corrupt.body.detail), /not valid JSON/);

    fs.writeFileSync(
      path.join(runsDir, "oldrecord.json"),
      JSON.stringify({ ...valid, version: 99 }),
      "utf-8",
    );
    const unsupported = await get<Record<string, any>>(srv.base, undoUrl("oldrecord"));
    assert.equal(unsupported.status, 409);
    assert.match(String(unsupported.body.detail), /unsupported undo record version/);

    // The record is fine until its workspace leaves the registry; undoing into
    // an unregistered directory must never happen.
    const removed = await del(srv.base, `/api/workspaces/${workspace.id}`);
    assert.equal(removed.status, 200);
    const mismatch = await get<Record<string, any>>(srv.base, undoUrl(runId));
    assert.equal(mismatch.status, 409);
    assert.match(String(mismatch.body.detail), /not registered/);
    const applyMismatch = await post<Record<string, any>>(srv.base, undoUrl(runId));
    assert.equal(applyMismatch.status, 409);
    // Nothing was touched by the refused apply.
    assert.equal(fs.readFileSync(path.join(workspace.dir, "existing.txt"), "utf-8"), "edited\n");
  } finally {
    await srv.close();
    tmp.cleanup();
  }
});

test("409 while the run is still active in memory — for preview and apply", async () => {
  const tmp = tmpdir("tb-serverundo-");
  const sessionsDir = path.join(tmp.root, "sessions");
  const junior = mutationProviders().junior;
  // Park the run on its final deliverable round: by then the mutations (and
  // therefore the undo record) exist, but the run can still change files.
  const gated = gatedToolsAt(junior, 4);
  const srv = await startServer(sessionsDir, {
    providerOverrides: { senior: mutationProviders().senior, junior: gated.provider },
  });
  try {
    const workspace = await seedWorkspace(srv.base, tmp.root);
    const { runId, sessionName } = await submitWorkspaceRun(srv.base, workspace.id);
    await waitFor(gated.entered);
    const recordPath = path.join(sessionsDir, "undo", "runs", `${runId}.json`);
    await waitFor(() => fs.existsSync(recordPath));
    const live = await get<Record<string, any>>(srv.base, `/api/runs/${runId}`);
    assert.equal(live.body.status, "running");

    const preview = await get<Record<string, any>>(
      srv.base,
      `/api/sessions/${encodeURIComponent(sessionName)}/undo/${runId}`,
    );
    assert.equal(preview.status, 409);
    assert.match(String(preview.body.detail), /still running/);
    const applied = await post<Record<string, any>>(
      srv.base,
      `/api/sessions/${encodeURIComponent(sessionName)}/undo/${runId}`,
    );
    assert.equal(applied.status, 409);

    gated.release();
    const terminal = await waitTerminal(srv.base, runId);
    assert.equal(terminal.status, "completed");
    const after = await get<Record<string, any>>(
      srv.base,
      `/api/sessions/${encodeURIComponent(sessionName)}/undo/${runId}`,
    );
    assert.equal(after.status, 200);
    assert.equal(after.body.counts.total, 3);
  } finally {
    await srv.close();
    tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// capture wiring: bounds, fail-soft, non-workspace runs
// ---------------------------------------------------------------------------

test("capture failure is fail-soft: the run completes and simply has no undo record", async () => {
  const tmp = tmpdir("tb-serverundo-");
  const sessionsDir = path.join(tmp.root, "sessions");
  fs.mkdirSync(sessionsDir);
  // A regular file where the store root should be makes every store write fail
  // with ENOTDIR — the run must proceed unaffected (one diagnostic only).
  fs.writeFileSync(path.join(sessionsDir, "undo"), "not a directory", "utf-8");
  const providers = mutationProviders();
  const srv = await startServer(sessionsDir, { providerOverrides: providers });
  try {
    const workspace = await seedWorkspace(srv.base, tmp.root);
    const { runId, sessionName } = await submitWorkspaceRun(srv.base, workspace.id);
    const terminal = await waitTerminal(srv.base, runId);
    assert.equal(terminal.status, "completed");
    assert.equal(fs.readFileSync(path.join(workspace.dir, "existing.txt"), "utf-8"), "edited\n");
    assert.equal(fs.existsSync(path.join(workspace.dir, "created.txt")), true);

    const preview = await get(
      srv.base,
      `/api/sessions/${encodeURIComponent(sessionName)}/undo/${runId}`,
    );
    assert.equal(preview.status, 404);
  } finally {
    await srv.close();
    tmp.cleanup();
  }
});

test("a run without a workspace leaves no undo record", async () => {
  const tmp = tmpdir("tb-serverundo-");
  const sessionsDir = path.join(tmp.root, "sessions");
  const srv = await startServer(sessionsDir);
  try {
    const started = await post<Record<string, any>>(srv.base, "/api/runs", {
      task: "consult without a workspace",
      session: "plain",
    });
    assert.equal(started.status, 202);
    const terminal = await waitTerminal(srv.base, String(started.body.run_id));
    assert.equal(terminal.status, "completed");
    const sessionName = String(started.body.session);
    assert.ok(sessionName.endsWith(".jsonl"));
    const preview = await get(
      srv.base,
      `/api/sessions/${encodeURIComponent(sessionName)}/undo/${String(started.body.run_id)}`,
    );
    assert.equal(preview.status, 404);
    assert.equal(fs.existsSync(path.join(sessionsDir, "undo", "runs")), false);
  } finally {
    await srv.close();
    tmp.cleanup();
  }
});
