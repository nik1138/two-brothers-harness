/**
 * Live thinking/text token streaming over the run SSE endpoint.
 *
 * Hermetic: `createServer` runs in-process over a temp sessions directory on an
 * ephemeral port, with the deterministic mock provider wrapped in a gate so the
 * test can attach SSE listeners *before* any delta is produced (tokens are
 * ephemeral — a late listener never sees the past). Covers:
 * - `POST /api/runs {"stream_tokens": true}` → named `event: token` SSE frames
 *   (`{type, run_id, role, kind, delta, at}`, no `id:`), thinking before text
 *   per provider call, deltas concatenating to the mock reasoning/replies;
 * - default off: the stream carries only the existing typed events;
 * - multiple concurrent SSE listeners receive the same sequence, and a throwing
 *   in-process listener is isolated from the run and the other listeners;
 * - tokens never reach `record.events` or the runtime sidecar, are never
 *   replayed by `?after`, and no frame follows `run_end`;
 * - a non-boolean `stream_tokens` is the generic 400.
 *
 * Run with: node --test tests/servertokens.test.ts
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { resolveConfig } from "../src/config.ts";
import type { ChatMessage } from "../src/context.ts";
import {
  MOCK_REASONING,
  MockProvider,
  type ChatOptions,
  type Provider,
} from "../src/provider.ts";
import { createServer, type ServerHandle } from "../src/server.ts";
import type { TokenStreamEvent } from "../src/runstream.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface RunningServer {
  base: string;
  handle: ServerHandle;
  root: string;
  sessionsDir: string;
  close(): Promise<void>;
}

async function startServer(options: {
  providers?: { senior?: Provider; junior?: Provider };
} = {}): Promise<RunningServer> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-srv-tokens-"));
  const sessionsDir = path.join(root, "sessions");
  const handle = createServer({
    configFactory: () => resolveConfig({ provider: "mock", mode: "consult" }),
    webDist: null,
    sessionsDir,
    pluginsDir: path.join(root, "missing-plugins"),
    ...(options.providers ? { providerOverrides: options.providers } : {}),
  });
  const server = await handle.listen("127.0.0.1", 0);
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    handle,
    root,
    sessionsDir,
    close: async () => {
      await handle.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
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

interface StartedRun {
  run_id: string;
  session: string;
  status: string;
}

async function startRun(
  server: RunningServer,
  body: Record<string, unknown>,
): Promise<StartedRun> {
  const res = await api<StartedRun>(server.base, "POST", "/api/runs", body);
  assert.equal(res.status, 202, JSON.stringify(res.body));
  assert.equal(typeof res.body.run_id, "string");
  return res.body;
}

/**
 * Mock provider wrapper whose first provider call blocks on a gate, so a test
 * can open SSE connections (and register in-process listeners) before any
 * token is emitted. After `release()` every call passes straight through.
 */
interface GatedProvider {
  provider: Provider;
  release(): void;
  /** Resolves when the first provider call reaches the gate. */
  firstCall: Promise<void>;
}

function gatedMock(): GatedProvider {
  const inner = new MockProvider();
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let markFirstCall!: () => void;
  const firstCall = new Promise<void>((resolve) => {
    markFirstCall = resolve;
  });
  let started = false;
  const pass = async (): Promise<void> => {
    if (!started) {
      started = true;
      markFirstCall();
    }
    await gate;
  };
  const provider: Provider = {
    async chat(
      messages: ChatMessage[],
      responseKind?: string,
      signal?: AbortSignal,
      options?: ChatOptions,
    ): Promise<string> {
      await pass();
      return inner.chat(messages, responseKind, signal, options);
    },
    async chatWithTools(messages, tools, options) {
      await pass();
      return inner.chatWithTools(messages, tools, options);
    },
  };
  return { provider, release: () => releaseGate(), firstCall };
}

interface SseFrame {
  /** Raw frame text (without the trailing blank line). */
  raw: string;
  /** SSE `event:` field; "message" is EventSource's default/unnamed event. */
  event: string;
  /** Joined `data:` lines. */
  data: string;
  /** SSE `id:` field, or null when the frame carries none. */
  id: string | null;
}

function parseSseFrame(raw: string): SseFrame | null {
  let event = "message";
  let id: string | null = null;
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    else if (line.startsWith("id:")) id = line.slice(3).trim();
  }
  if (data.length === 0) return null;
  return { raw, event, data: data.join("\n"), id };
}

interface SseStream {
  opened: Promise<void>;
  /** Frames observed so far (live array; also the resolved `done` value). */
  frames: SseFrame[];
  /** Comment-only blocks (the server's `: keepalive` heartbeats), raw. */
  comments: string[];
  /** Resolves when the server ends the response. */
  done: Promise<SseFrame[]>;
  close(): void;
}

/** Open one raw SSE connection and collect parsed frames until the server ends it. */
function collectSse(base: string, route: string, timeoutMs = 15000): SseStream {
  const frames: SseFrame[] = [];
  const comments: string[] = [];
  let openedResolve!: () => void;
  const opened = new Promise<void>((resolve) => {
    openedResolve = resolve;
  });
  let settle!: (frames: SseFrame[]) => void;
  let fail!: (exc: unknown) => void;
  let settled = false;
  const done = new Promise<SseFrame[]>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const finish = (exc?: unknown): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (exc !== undefined) fail(exc);
    else settle(frames);
  };
  const timer = setTimeout(() => {
    req.destroy();
    finish(new Error(`SSE ${route} timed out; trailing frames: ${JSON.stringify(frames.slice(-2))}`));
  }, timeoutMs);
  timer.unref?.();
  const req = http.get(base + route, (res) => {
    openedResolve();
    if (res.statusCode !== 200) {
      res.resume();
      finish(new Error(`SSE ${route} -> HTTP ${res.statusCode}`));
      return;
    }
    let buffer = "";
    res.setEncoding("utf-8");
    res.on("data", (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (raw.split("\n").every((line) => line === "" || line.startsWith(":"))) {
          if (raw.includes(": keepalive")) comments.push(raw);
          continue;
        }
        const frame = parseSseFrame(raw);
        if (frame !== null) frames.push(frame);
      }
    });
    res.on("end", () => finish());
    res.on("error", (exc) => finish(exc));
  });
  req.on("error", (exc) => {
    if (!settled) finish(exc);
  });
  return {
    opened,
    frames,
    comments,
    done,
    close: () => {
      req.destroy();
      finish();
    },
  };
}

interface TokenFrameJson {
  type: "token";
  run_id: string;
  role: string;
  kind: "text" | "thinking";
  delta: string;
  /** Epoch seconds, like every typed runtime event on the stream. */
  at: number;
}

/** Every named token frame as parsed JSON, in arrival order. */
function tokenFrames(frames: SseFrame[]): Array<{ frame: SseFrame; json: TokenFrameJson }> {
  return frames
    .filter((frame) => frame.event === "token")
    .map((frame) => ({ frame, json: JSON.parse(frame.data) as TokenFrameJson }));
}

interface TypedFrameJson {
  type: string;
  run_id?: string;
  status?: string;
  [key: string]: unknown;
}

function typedFrames(frames: SseFrame[]): Array<{ frame: SseFrame; json: TypedFrameJson }> {
  return frames
    .filter((frame) => frame.event === "message")
    .map((frame) => ({ frame, json: JSON.parse(frame.data) as TypedFrameJson }));
}

/** The runtime sidecar lines for one session (one JSON object per line). */
function readSidecar(
  sessionsDir: string,
  session: string,
): Array<Record<string, unknown>> {
  const file = path.join(sessionsDir, "runtime", `${session}.events.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// streamed token frames
// ---------------------------------------------------------------------------

test("stream_tokens: named token frames, thinking before text, replay cursor untouched", async () => {
  const gate = gatedMock();
  const server = await startServer({ providers: { senior: gate.provider, junior: gate.provider } });
  try {
    const run = await startRun(server, { task: "stream the thinking", stream_tokens: true });
    const stream = collectSse(server.base, `/api/runs/${run.run_id}/events`);
    await stream.opened;
    await gate.firstCall;
    gate.release();
    const frames = await stream.done;

    // The existing heartbeat comments are still emitted while the run is in
    // flight (named token frames are additive to that framing).
    assert.ok(
      stream.comments.some((comment) => comment.includes(": keepalive")),
      "keepalive heartbeats unchanged",
    );

    // 1. Named `event: token` frames, each with a data line and NO `id:` line.
    const tokens = tokenFrames(frames);
    assert.ok(tokens.length > 0, "token frames arrived");
    for (const { frame } of tokens) {
      assert.equal(frame.event, "token");
      assert.ok(frame.raw.startsWith("event: token\ndata: "), frame.raw.slice(0, 80));
      assert.equal(frame.id, null, "token frames carry no SSE id");
      assert.ok(!frame.raw.includes("\nid:"), "no id line on a token frame");
    }

    // 2. Exact payload contract `{type, run_id, role, kind, delta, at}`.
    for (const { json } of tokens) {
      assert.deepEqual(Object.keys(json), ["type", "run_id", "role", "kind", "delta", "at"]);
      assert.equal(json.type, "token");
      assert.equal(json.run_id, run.run_id);
      assert.ok(json.role === "senior" || json.role === "junior");
      assert.ok(json.kind === "text" || json.kind === "thinking");
      assert.equal(typeof json.delta, "string");
      assert.equal(typeof json.at, "number", "at is epoch seconds like typed events");
      assert.ok(Number.isInteger(json.at) && json.at > 0);
    }
    assert.deepEqual(
      new Set(tokens.map(({ json }) => json.kind)),
      new Set(["text", "thinking"]),
      "the mock streams both reasoning and visible reply deltas",
    );

    // 3. Group the deltas per provider call: each call starts with thinking
    //    deltas and then emits its visible text; the consult cycle makes four
    //    streamed calls. Thinking deltas concatenate to the mock reasoning and
    //    the text deltas concatenate to the JSON replies.
    const groups: Array<{ role: string; thinking: string; text: string }> = [];
    for (const { json } of tokens) {
      let group = groups[groups.length - 1];
      if (group === undefined || (json.kind === "thinking" && group.text !== "")) {
        group = { role: json.role, thinking: "", text: "" };
        groups.push(group);
      }
      assert.equal(json.role, group.role, "one role per provider call");
      if (json.kind === "thinking") group.thinking += json.delta;
      else group.text += json.delta;
    }
    assert.equal(groups.length, 4, "consult mode streams four provider calls");
    for (const group of groups) {
      assert.equal(
        group.thinking,
        MOCK_REASONING,
        "thinking deltas are the deterministic mock reasoning, delivered before the reply",
      );
      assert.ok(group.text.length > 0);
      const reply = JSON.parse(group.text) as Record<string, unknown>;
      assert.equal(typeof reply, "object");
    }

    // 4. The typed-event frames are unchanged: `id:` tags, unnamed events, and
    //    `run_end` is the final frame (no token frame after it).
    const typed = typedFrames(frames);
    assert.ok(typed.length > 0);
    for (const { frame } of typed) {
      assert.match(String(frame.id), /^\d+$/, "typed frames still carry the ?after id");
    }
    assert.deepEqual(
      typed.map(({ frame }) => Number(frame.id)),
      Array.from({ length: typed.length }, (_, index) => index + 1),
      "typed ids stay dense from 1 on a fresh connection",
    );
    const last = frames[frames.length - 1];
    assert.ok(last !== undefined);
    assert.equal(last.event, "message", "no token frame follows run_end");
    assert.equal(JSON.parse(last.data).type, "run_end");
    assert.equal(JSON.parse(last.data).status, "completed");
  } finally {
    await server.close();
  }
});

test("stream_tokens defaults off: the stream carries only typed events", async () => {
  const server = await startServer();
  try {
    const run = await startRun(server, { task: "no token streaming" });
    const frames = await collectSse(server.base, `/api/runs/${run.run_id}/events`).done;

    assert.ok(frames.length > 0);
    assert.equal(frames.filter((frame) => frame.event === "token").length, 0);
    for (const frame of frames) {
      assert.equal(frame.event, "message");
      assert.match(String(frame.id), /^\d+$/);
    }
    const types = typedFrames(frames).map(({ json }) => json.type);
    assert.ok(types.includes("run_status"));
    assert.ok(types.includes("envelope"));
    assert.equal(types[types.length - 1], "run_end");
  } finally {
    await server.close();
  }
});

test("two concurrent SSE listeners receive the same ephemeral token sequence", async () => {
  const gate = gatedMock();
  const server = await startServer({ providers: { senior: gate.provider, junior: gate.provider } });
  try {
    const run = await startRun(server, { task: "two listeners", stream_tokens: true });
    const first = collectSse(server.base, `/api/runs/${run.run_id}/events`);
    const second = collectSse(server.base, `/api/runs/${run.run_id}/events`);
    await Promise.all([first.opened, second.opened]);
    await gate.firstCall;
    gate.release();
    const [firstFrames, secondFrames] = await Promise.all([first.done, second.done]);

    const signature = (frames: SseFrame[]): string[] =>
      tokenFrames(frames).map(({ json }) => `${json.role}|${json.kind}|${json.delta}`);
    assert.ok(signature(firstFrames).length > 0);
    assert.deepEqual(signature(firstFrames), signature(secondFrames), "both listeners see every delta");
    for (const frames of [firstFrames, secondFrames]) {
      const last = frames[frames.length - 1];
      assert.equal(JSON.parse(last?.data ?? "{}").type, "run_end");
    }
  } finally {
    await server.close();
  }
});

test("live-token listeners are fail-soft, unsubscribable and dropped at run_end", async () => {
  const gate = gatedMock();
  const server = await startServer({ providers: { senior: gate.provider, junior: gate.provider } });
  try {
    const run = await startRun(server, { task: "isolated listeners", stream_tokens: true });
    const record = server.handle.state.runs.get(run.run_id);
    assert.ok(record);
    const received: TokenStreamEvent[] = [];
    let throwingCalls = 0;
    const unsubscribed: TokenStreamEvent[] = [];

    // Throwing listener FIRST: the fan-out must isolate it from the healthy one.
    record.onLiveToken(() => {
      throwingCalls += 1;
      throw new Error("broken listener");
    });
    record.onLiveToken((event) => received.push(event));
    const unsubscribe = record.onLiveToken((event) => unsubscribed.push(event));
    unsubscribe();

    await gate.firstCall;
    gate.release();
    assert.equal(await server.handle.state.runs.wait(run.run_id), true);
    assert.equal(record.status, "completed", "a throwing listener never breaks the run");

    assert.ok(throwingCalls > 0, "the throwing listener was called");
    assert.ok(received.length > 0, "the healthy listener still received tokens");
    assert.ok(received.some((event) => event.kind === "thinking"));
    assert.ok(received.some((event) => event.kind === "text"));
    for (const event of received) {
      assert.equal(event.type, "token");
      assert.equal(typeof event.delta, "string");
    }
    assert.deepEqual(unsubscribed, [], "an unsubscribed listener is never called");

    // Tokens never reached the typed event buffer or the public record shape.
    assert.equal(
      record.events.some((event) => (event as { type?: string }).type === "token"),
      false,
    );
    assert.equal("tokens" in record.public(), false);

    // The registry is closed at run_end: a late subscriber and a late emit are
    // both no-ops.
    let lateCalls = 0;
    const lateUnsubscribe = record.onLiveToken(() => {
      lateCalls += 1;
    });
    record.emitLiveToken({
      type: "token",
      role: "senior",
      kind: "text",
      delta: "late",
      at: new Date().toISOString(),
    });
    lateUnsubscribe();
    assert.equal(lateCalls, 0, "no token delivery after the terminal status");
  } finally {
    await server.close();
  }
});

test("tokens are ephemeral: absent from events/sidecar, never replayed by ?after", async () => {
  const gate = gatedMock();
  const server = await startServer({ providers: { senior: gate.provider, junior: gate.provider } });
  try {
    const run = await startRun(server, { task: "ephemeral tokens", stream_tokens: true });
    const stream = collectSse(server.base, `/api/runs/${run.run_id}/events`);
    await stream.opened;
    await gate.firstCall;
    gate.release();
    const live = await stream.done;
    const liveTokenCount = tokenFrames(live).length;
    assert.ok(liveTokenCount > 0);
    const typedCount = typedFrames(live).length;
    assert.ok(typedCount > 0);

    // 1. The in-memory typed buffer carries no token records.
    const record = server.handle.state.runs.get(run.run_id);
    assert.ok(record);
    assert.equal(record.events.length, typedCount);
    assert.equal(
      record.events.some((event) => (event as { type?: string }).type === "token"),
      false,
    );

    // 2. The runtime sidecar JSONL carries no token records.
    const sidecar = readSidecar(server.sessionsDir, run.session);
    assert.ok(sidecar.length > 0, "the typed events were persisted");
    assert.equal(sidecar.length, typedCount);
    assert.equal(
      sidecar.some((event) => event.type === "token"),
      false,
      "tokens never reach the sidecar",
    );
    assert.equal(sidecar.filter((event) => event.run_id === run.run_id).length, typedCount);

    // 3. A `?after=0` reconnect replays the persisted typed events only.
    const replay = await collectSse(
      server.base,
      `/api/runs/${run.run_id}/events?after=0`,
    ).done;
    assert.equal(replay.filter((frame) => frame.event === "token").length, 0);
    assert.deepEqual(
      replay.map((frame) => frame.id),
      record.events.map((_, index) => String(index + 1)),
      "typed ids are replayable and dense",
    );
    assert.deepEqual(
      typedFrames(replay).map(({ json }) => json.type),
      record.events.map((event) => (event as { type?: string }).type),
    );
    assert.equal(typedFrames(replay)[typedFrames(replay).length - 1]?.json.type, "run_end");

    // 4. Reconnecting at the end has nothing to replay — and no token frames.
    const drained = await collectSse(
      server.base,
      `/api/runs/${run.run_id}/events?after=${typedCount}`,
    ).done;
    assert.deepEqual(drained, []);
  } finally {
    await server.close();
  }
});

test("stream_tokens is a strict boolean on POST /api/runs", async () => {
  const server = await startServer();
  try {
    for (const bad of ["true", "yes", 1, 0, null, {}, []]) {
      const res = await api<{ detail?: string }>(server.base, "POST", "/api/runs", {
        task: "bad stream_tokens",
        stream_tokens: bad,
      });
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.equal(res.body.detail, "invalid request body", JSON.stringify(bad));
    }
    assert.deepEqual((await api(server.base, "GET", "/api/runs")).body, [], "no run was created");

    // An explicit `false` is accepted and behaves exactly like the default.
    const run = await startRun(server, { task: "explicit off", stream_tokens: false });
    const frames = await collectSse(server.base, `/api/runs/${run.run_id}/events`).done;
    assert.equal(frames.filter((frame) => frame.event === "token").length, 0);
    const record = server.handle.state.runs.get(run.run_id);
    assert.ok(record);
    assert.equal(
      record.events.some((event) => (event as { type?: string }).type === "token"),
      false,
    );
  } finally {
    await server.close();
  }
});
