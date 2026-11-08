/**
 * Server-side session mutations and export: fork, rewind, HTML export.
 *
 * Hermetic: `createServer` runs in-process against a temp sessions directory and
 * is exercised over real HTTP on an ephemeral port (no subprocesses, no live
 * model endpoints, no sleeps except one short ordering wait in the rewind CAS
 * test). Covers:
 * - `POST /api/sessions/{name}/fork`: whole/prefix copies, explicit names, the
 *   `.meta.json` parent link, source byte-identity, dense `seq` in the copy, and
 *   the 400/404/409/422 status map (invalid seq/name, unknown source, taken
 *   name, corrupt source, live run/manual compaction);
 * - `POST /api/sessions/{name}/rewind`: honest kept/removed/turns/stopped fields
 *   and the compaction floor, dense `seq` after the rewrite, runtime-event
 *   sidecar clearing (and other sessions' sidecars untouched), no-op cuts, the
 *   400/404/409/422 guards and the changed-file CAS;
 * - `GET /api/sessions/{name}/export?format=html`: content type / disposition /
 *   escaping / no scripts-or-links, plus markdown staying on its old path.
 *
 * Run with: node --test tests/sessionapi.test.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { COMPACTION_SUMMARY_PREFIX } from "../src/compaction.ts";
import { SessionStore } from "../src/session.ts";
import { createServer, type ServerHandle } from "../src/server.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface RunningServer {
  base: string;
  handle: ServerHandle;
  dir: string;
  sessionsDir: string;
  close(): Promise<void>;
}

async function startServer(): Promise<RunningServer> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-srv-sessionapi-"));
  const sessionsDir = path.join(root, "sessions");
  const handle = createServer({ webDist: null, sessionsDir });
  const server = await handle.listen("127.0.0.1", 0);
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    handle,
    dir: root,
    sessionsDir,
    close: async () => {
      await handle.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

interface ApiResult<T = unknown> {
  status: number;
  headers: Headers;
  text: string;
  body: T;
}

async function request<T = unknown>(
  base: string,
  route: string,
  options: { method?: string; body?: unknown } = {},
): Promise<ApiResult<T>> {
  const init: RequestInit = { method: options.method ?? "GET" };
  if (options.body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(options.body);
  }
  const res = await fetch(base + route, init);
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, headers: res.headers, text, body: parsed as T };
}

function envelope(
  seq: number,
  from: string,
  to: string,
  kind: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    v: 1,
    id: `msg-${seq}`,
    seq,
    ts: "2026-11-06T12:00:00Z",
    from,
    to,
    kind,
    payload,
  };
}

/** One rewindable operator turn: the task envelope plus the decision reply. */
function turn(seq: number, text: string): Array<Record<string, unknown>> {
  return [
    envelope(seq, "user", "senior", "message", { text }),
    envelope(seq + 1, "senior", "user", "decision", { decision: `done: ${text}` }),
  ];
}

function writeSession(
  dir: string,
  name: string,
  events: Array<Record<string, unknown>>,
): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf-8");
  return file;
}

function writeSidecar(dir: string, name: string, title: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name.replace(/\.jsonl$/, "")}.meta.json`),
    JSON.stringify({ created: 1, title }, null, 2),
    "utf-8",
  );
}

function runtimeSidecarPath(sessionsDir: string, name: string): string {
  return path.join(sessionsDir, "runtime", `${name}.events.jsonl`);
}

function writeRuntimeSidecar(sessionsDir: string, name: string, line: string): string {
  const file = runtimeSidecarPath(sessionsDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, line + "\n", "utf-8");
  return file;
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function seqsOf(file: string): number[] {
  return new SessionStore(file).load().map((event) => event.seq);
}

function listNames(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Park a real run on a session: a job that never settles keeps the record in a
 * non-terminal ACTIVE state, exactly what the fork/rewind guard must refuse.
 * Returns a stop function that unwinds the record before the server closes.
 */
async function parkRun(srv: RunningServer, session: string): Promise<() => Promise<void>> {
  const record = srv.handle.state.runs.submit(
    "park",
    session,
    (signal) =>
      new Promise<never>((_resolve, reject) => {
        // Never settles on its own; stop() aborts this signal and the record
        // must become terminal for the server to close cleanly.
        signal.addEventListener("abort", () => reject(new Error("parked run stopped")), {
          once: true,
        });
      }),
    "auto",
  );
  const deadline = Date.now() + 10_000;
  while (String(record.status) !== "running") {
    if (Date.now() > deadline) throw new Error("parked run never reached running");
    await delay(10);
  }
  return async () => {
    srv.handle.state.runs.stop(record.runId);
    await srv.handle.state.runs.wait(record.runId, 5_000);
  };
}

// ---------------------------------------------------------------------------
// fork
// ---------------------------------------------------------------------------

test("POST fork: whole-session copy, parent link, byte-identical source, dense seq", async () => {
  const srv = await startServer();
  try {
    const source = writeSession(srv.sessionsDir, "src.jsonl", [
      ...turn(1, "Plan the Redis migration"),
      ...turn(3, "Write the rollback plan"),
    ]);
    writeSidecar(srv.sessionsDir, "src.jsonl", "Migration planning");
    const sourceHash = sha256(source);
    const sourceBytes = fs.readFileSync(source);

    const response = await request(srv.base, "/api/sessions/src.jsonl/fork", { method: "POST" });
    assert.equal(response.status, 201, response.text);
    const body = response.body as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ["events", "forked_from", "name", "title"]);
    assert.equal(body.name, "src-fork-1.jsonl");
    assert.equal(body.title, "Migration planning (fork)");
    assert.equal(body.events, 4);
    assert.deepEqual(body.forked_from, { name: "src.jsonl", seq: 4 });

    const forkFile = path.join(srv.sessionsDir, "src-fork-1.jsonl");
    assert.deepEqual(fs.readFileSync(forkFile), sourceBytes, "the copy must be byte-identical");
    assert.deepEqual(seqsOf(forkFile), [1, 2, 3, 4]);

    const meta = JSON.parse(
      fs.readFileSync(path.join(srv.sessionsDir, "src-fork-1.meta.json"), "utf-8"),
    ) as Record<string, unknown>;
    assert.deepEqual(meta.parent, { name: "src.jsonl", seq: 4 });
    assert.equal(meta.title, "Migration planning (fork)");

    // source file and sidecar untouched; the only new files are the fork pair
    assert.equal(sha256(source), sourceHash);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(srv.sessionsDir, "src.meta.json"), "utf-8")).title,
      "Migration planning",
    );
    const namesAfterFork = listNames(srv.sessionsDir);
    for (const expected of [
      "src.jsonl",
      "src.meta.json",
      "src-fork-1.jsonl",
      "src-fork-1.meta.json",
    ]) {
      assert.ok(namesAfterFork.includes(expected), `missing ${expected}: ${namesAfterFork.join(", ")}`);
    }
    assert.equal(namesAfterFork.filter((name) => name.includes("-fork-")).length, 2);

    // a second fork takes the next free slot
    const second = await request(srv.base, "/api/sessions/src.jsonl/fork", { method: "POST" });
    assert.equal(second.status, 201, second.text);
    assert.equal((second.body as Record<string, unknown>).name, "src-fork-2.jsonl");
  } finally {
    await srv.close();
  }
});

test("POST fork: seq cuts a prefix; explicit name (with or without .jsonl) is honored", async () => {
  const srv = await startServer();
  try {
    writeSession(srv.sessionsDir, "src.jsonl", [
      ...turn(1, "first task"),
      ...turn(3, "second task"),
    ]);

    const cut = await request(srv.base, "/api/sessions/src.jsonl/fork", {
      method: "POST",
      body: { seq: 2, name: "branch-a" },
    });
    assert.equal(cut.status, 201, cut.text);
    const cutBody = cut.body as Record<string, unknown>;
    assert.equal(cutBody.name, "branch-a.jsonl");
    assert.equal(cutBody.events, 2);
    assert.deepEqual(cutBody.forked_from, { name: "src.jsonl", seq: 2 });
    assert.deepEqual(seqsOf(path.join(srv.sessionsDir, "branch-a.jsonl")), [1, 2]);

    const suffixed = await request(srv.base, "/api/sessions/src.jsonl/fork", {
      method: "POST",
      body: { name: "branch-b.jsonl" },
    });
    assert.equal(suffixed.status, 201);
    assert.equal((suffixed.body as Record<string, unknown>).name, "branch-b.jsonl");
    assert.ok(fs.existsSync(path.join(srv.sessionsDir, "branch-b.jsonl")));
    assert.ok(!fs.existsSync(path.join(srv.sessionsDir, "branch-b.jsonl.jsonl")));
    assert.equal((suffixed.body as Record<string, unknown>).events, 4);
  } finally {
    await srv.close();
  }
});

test("POST fork: a crash-torn tail forks its complete prefix; valid final no-newline forks too", async () => {
  const srv = await startServer();
  try {
    const events = [...turn(1, "first task"), ...turn(3, "second task")];
    const complete = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
    fs.mkdirSync(srv.sessionsDir, { recursive: true });
    const tornSource = path.join(srv.sessionsDir, "torn.jsonl");
    fs.writeFileSync(tornSource, complete + '{"v":1,"id":"msg-5","seq":5', "utf-8");
    const tornHash = sha256(tornSource);

    const torn = await request(srv.base, "/api/sessions/torn.jsonl/fork", { method: "POST" });
    assert.equal(torn.status, 201, torn.text);
    const tornBody = torn.body as Record<string, unknown>;
    assert.equal(tornBody.events, 4);
    assert.deepEqual(tornBody.forked_from, { name: "torn.jsonl", seq: 4 });
    const tornFork = path.join(srv.sessionsDir, String(tornBody.name));
    assert.equal(fs.readFileSync(tornFork, "utf-8"), complete);
    assert.deepEqual(seqsOf(tornFork), [1, 2, 3, 4]);
    assert.equal(sha256(tornSource), tornHash, "the torn source must never be rewritten");

    // A complete final envelope without its newline is not a tear.
    const nonlText = [...turn(1, "alpha")].map((event) => JSON.stringify(event)).join("\n");
    const nonlSource = path.join(srv.sessionsDir, "nonl.jsonl");
    fs.writeFileSync(nonlSource, nonlText, "utf-8");
    const nonl = await request(srv.base, "/api/sessions/nonl.jsonl/fork", { method: "POST" });
    assert.equal(nonl.status, 201, nonl.text);
    assert.equal((nonl.body as Record<string, unknown>).events, 2);
    assert.equal(
      fs.readFileSync(path.join(srv.sessionsDir, String((nonl.body as Record<string, unknown>).name)), "utf-8"),
      nonlText,
    );

    // Interior / newline-terminated corruption stays 422 even next to a torn tail.
    fs.writeFileSync(
      path.join(srv.sessionsDir, "interior.jsonl"),
      JSON.stringify(events[0]) + "\nnot json\n" + '{"v":1,"id":"msg-6","seq":6',
      "utf-8",
    );
    const interior = await request(srv.base, "/api/sessions/interior.jsonl/fork", {
      method: "POST",
    });
    assert.equal(interior.status, 422, interior.text);
    assert.match(interior.text, /line 2/);
    assert.deepEqual(
      listNames(srv.sessionsDir).filter((name) => name.includes("interior-fork")),
      [],
    );
  } finally {
    await srv.close();
  }
});

test("POST fork: error statuses are honest and write nothing", async () => {
  const srv = await startServer();
  try {
    writeSession(srv.sessionsDir, "src.jsonl", [...turn(1, "only task")]);
    fs.writeFileSync(path.join(srv.sessionsDir, "corrupt.jsonl"), '{"v":1}\nnot json\n', "utf-8");
    writeSession(srv.sessionsDir, "taken.jsonl", [...turn(1, "existing")]);
    const srcHash = sha256(path.join(srv.sessionsDir, "src.jsonl"));

    const unknown = await request(srv.base, "/api/sessions/nope.jsonl/fork", { method: "POST" });
    assert.equal(unknown.status, 404);

    // an encoded traversal name is flattened and never escapes the directory
    const traversal = await request(srv.base, "/api/sessions/..%2Fevil.jsonl/fork", {
      method: "POST",
    });
    assert.equal(traversal.status, 404, traversal.text);

    for (const seq of [0, 3, 1.5, "2"]) {
      const badSeq = await request(srv.base, "/api/sessions/src.jsonl/fork", {
        method: "POST",
        body: { seq },
      });
      assert.equal(badSeq.status, 400, `seq ${String(seq)} -> ${badSeq.text}`);
      assert.match(badSeq.text, /at seq/i);
    }

    const badName = await request(srv.base, "/api/sessions/src.jsonl/fork", {
      method: "POST",
      body: { name: "../evil" },
    });
    assert.equal(badName.status, 400, badName.text);
    assert.match(badName.text, /path separator/);

    const dotName = await request(srv.base, "/api/sessions/src.jsonl/fork", {
      method: "POST",
      body: { name: "." },
    });
    assert.equal(dotName.status, 400, dotName.text);

    const taken = await request(srv.base, "/api/sessions/src.jsonl/fork", {
      method: "POST",
      body: { name: "taken" },
    });
    assert.equal(taken.status, 409, taken.text);

    const corrupt = await request(srv.base, "/api/sessions/corrupt.jsonl/fork", {
      method: "POST",
    });
    assert.equal(corrupt.status, 422, corrupt.text);

    assert.equal(sha256(path.join(srv.sessionsDir, "src.jsonl")), srcHash);
    assert.deepEqual(
      listNames(srv.sessionsDir).filter((name) => name.includes("-fork-")),
      [],
    );
  } finally {
    await srv.close();
  }
});

test("POST fork: refuses a live run and a manual compaction honestly", async () => {
  const srv = await startServer();
  try {
    writeSession(srv.sessionsDir, "busy.jsonl", [...turn(1, "busy task")]);
    const stop = await parkRun(srv, "busy.jsonl");
    try {
      const live = await request(srv.base, "/api/sessions/busy.jsonl/fork", { method: "POST" });
      assert.equal(live.status, 409, live.text);
      assert.match(live.text, /stop it before forking/);
    } finally {
      await stop();
    }
    srv.handle.state.compactions.add("busy.jsonl");
    const compacting = await request(srv.base, "/api/sessions/busy.jsonl/fork", {
      method: "POST",
    });
    assert.equal(compacting.status, 409, compacting.text);
    assert.match(compacting.text, /compaction/);
    // released -> the same request succeeds
    srv.handle.state.compactions.delete("busy.jsonl");
    const ok = await request(srv.base, "/api/sessions/busy.jsonl/fork", { method: "POST" });
    assert.equal(ok.status, 201, ok.text);
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// export html
// ---------------------------------------------------------------------------

test("GET export?format=html: self-contained page, escaped payload, no scripts/links", async () => {
  const srv = await startServer();
  try {
    writeSession(srv.sessionsDir, "h.jsonl", [
      envelope(1, "user", "senior", "message", {
        text: 'before <script>alert("x")</script> \u001b[31mred\u001b[0m after',
      }),
      envelope(2, "senior", "user", "decision", { decision: "accept <b>bold</b>" }),
    ]);
    writeSidecar(srv.sessionsDir, "h.jsonl", "Hostile & <title>");

    const res = await fetch(`${srv.base}/api/sessions/h.jsonl/export?format=html`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(res.headers.get("content-disposition"), 'attachment; filename="h.html"');
    const html = await res.text();

    assert.ok(html.startsWith("<!doctype html>\n"), html.slice(0, 40));
    assert.ok(html.includes('<meta charset="utf-8">'));
    assert.ok(html.includes("<title>Hostile &amp; &lt;title&gt;</title>"));
    assert.ok(!/<script/i.test(html));
    assert.ok(!html.includes("<img"));
    assert.ok(html.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"));
    assert.ok(html.includes("&lt;b&gt;bold&lt;/b&gt;"));
    assert.ok(!html.includes("\u001b"));
    assert.ok(!/\b(href|src)=/i.test(html));
    assert.ok(!/url\(/i.test(html));
    assert.ok(html.includes('<section class="event" id="seq-1">'));
    assert.ok(html.trimEnd().endsWith("</html>"));

    // HEAD returns the same headers without a body
    const head = await fetch(`${srv.base}/api/sessions/h.jsonl/export?format=html`, {
      method: "HEAD",
    });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(await head.text(), "");

    // markdown stays on its own content type/body path
    const markdown = await fetch(`${srv.base}/api/sessions/h.jsonl/export`);
    assert.equal(markdown.status, 200);
    assert.equal(markdown.headers.get("content-type"), "text/markdown; charset=utf-8");
    assert.equal(markdown.headers.get("content-disposition"), 'attachment; filename="h.md"');
    const md = await markdown.text();
    assert.ok(md.startsWith("# Hostile & <title>\n"));
    assert.ok(md.includes("## 1. user → senior · message"));

    // unknown formats are a 400 naming all three formats
    const bad = await fetch(`${srv.base}/api/sessions/h.jsonl/export?format=xml`);
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /markdown, json or html/);

    // missing session is still a 404
    const missing = await fetch(`${srv.base}/api/sessions/nope.jsonl/export?format=html`);
    assert.equal(missing.status, 404);
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// torn tail (vendor scout F3)
// ---------------------------------------------------------------------------

test("a torn final line stays listed/detail-readable; rewind refuses 422", async () => {
  const srv = await startServer();
  try {
    const file = writeSession(srv.sessionsDir, "torn.jsonl", [
      ...turn(1, "redis migration task"),
    ]);
    fs.appendFileSync(file, '{"v":1,"id":"msg-torn","seq":3,"ts":"2026-', "utf-8");
    const beforeBytes = fs.readFileSync(file);

    const list = await request<Array<Record<string, unknown>>>(srv.base, "/api/sessions");
    assert.equal(list.status, 200, list.text);
    assert.ok(
      (list.body as unknown as Array<Record<string, unknown>>).some(
        (item) => item.name === "torn.jsonl",
      ),
      list.text,
    );

    const detail = await request<Record<string, unknown>>(srv.base, "/api/sessions/torn.jsonl");
    assert.equal(detail.status, 200, detail.text);
    assert.deepEqual(
      (detail.body.events as Array<Record<string, unknown>>).map((event) => event.seq),
      [1, 2],
    );

    // Read-only routes never rewrite the torn file.
    assert.deepEqual(fs.readFileSync(file), beforeBytes);

    // A destructive rewind still refuses before rewriting (strict read).
    const rewind = await request(srv.base, "/api/sessions/torn.jsonl/rewind", {
      method: "POST",
      body: { turns: 1 },
    });
    assert.equal(rewind.status, 422, rewind.text);
    assert.deepEqual(fs.readFileSync(file), beforeBytes);
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// rewind
// ---------------------------------------------------------------------------

test("POST rewind: honest cut fields, dense seq after rewrite, sidecar cleared only for that session", async () => {
  const srv = await startServer();
  try {
    const source = writeSession(srv.sessionsDir, "r.jsonl", [
      ...turn(1, "first task"),
      ...turn(3, "second task"),
    ]);
    writeSession(srv.sessionsDir, "other.jsonl", [...turn(1, "other task")]);
    const sidecar = writeRuntimeSidecar(
      srv.sessionsDir,
      "r.jsonl",
      JSON.stringify({ type: "run_status", status: "completed", run_id: "run-1" }),
    );
    const otherSidecar = writeRuntimeSidecar(
      srv.sessionsDir,
      "other.jsonl",
      JSON.stringify({ type: "run_status", status: "completed", run_id: "run-2" }),
    );

    const response = await request(srv.base, "/api/sessions/r.jsonl/rewind", {
      method: "POST",
      body: { turns: 1 },
    });
    assert.equal(response.status, 200, response.text);
    const body = response.body as Record<string, unknown>;
    assert.equal(body.name, "r.jsonl");
    assert.equal(body.rewritten, true);
    assert.equal(body.kept, 2);
    assert.equal(body.removed, 2);
    assert.equal(body.turns, 1);
    assert.equal(body.requested_turns, 1);
    assert.equal(body.stopped_at_compaction, false);
    assert.equal(body.stops_before, "operator-turn");
    assert.match(String(body.reason), /removed the last 1 operator turn/);
    assert.equal(body.runtime_events_cleared, true);

    // the kept prefix keeps its bytes and its dense seq; resume works
    assert.deepEqual(seqsOf(source), [1, 2]);
    const kept = fs.readFileSync(source, "utf-8");
    assert.ok(kept.includes("first task"));
    assert.ok(!kept.includes("second task"));

    // this session's runtime evidence is gone; the other session's is untouched
    assert.ok(!fs.existsSync(sidecar));
    assert.ok(fs.existsSync(otherSidecar));
    assert.ok(fs.readFileSync(otherSidecar, "utf-8").includes("run-2"));

    // a second rewind removes the remaining turn (empty session, still valid)
    const again = await request(srv.base, "/api/sessions/r.jsonl/rewind", {
      method: "POST",
      body: { turns: 1 },
    });
    assert.equal(again.status, 200, again.text);
    assert.equal((again.body as Record<string, unknown>).kept, 0);
    assert.deepEqual(seqsOf(source), []);
  } finally {
    await srv.close();
  }
});

test("POST rewind: no-op cuts are honest; missing sidecar is a no-op; errors are honest", async () => {
  const srv = await startServer();
  try {
    writeSession(srv.sessionsDir, "one.jsonl", [...turn(1, "only task")]);
    fs.writeFileSync(path.join(srv.sessionsDir, "corrupt.jsonl"), "not json\n", "utf-8");

    // deeper-than-available clamps at session start, honestly
    const clamped = await request(srv.base, "/api/sessions/one.jsonl/rewind", {
      method: "POST",
      body: { turns: 99 },
    });
    assert.equal(clamped.status, 200, clamped.text);
    const clampedBody = clamped.body as Record<string, unknown>;
    assert.equal(clampedBody.rewritten, true);
    assert.equal(clampedBody.turns, 1);
    assert.equal(clampedBody.requested_turns, 99);
    assert.equal(clampedBody.stops_before, "session-start");
    assert.equal(clampedBody.runtime_events_cleared, false);

    // nothing left to rewind is a success with a reason, file untouched
    const nowEmpty = fs.readFileSync(path.join(srv.sessionsDir, "one.jsonl"), "utf-8");
    const noop = await request(srv.base, "/api/sessions/one.jsonl/rewind", {
      method: "POST",
      body: { turns: 1 },
    });
    assert.equal(noop.status, 200, noop.text);
    const noopBody = noop.body as Record<string, unknown>;
    assert.equal(noopBody.rewritten, false);
    assert.equal(noopBody.removed, 0);
    assert.equal(noopBody.runtime_events_cleared, false);
    assert.equal(fs.readFileSync(path.join(srv.sessionsDir, "one.jsonl"), "utf-8"), nowEmpty);

    for (const turns of [0, 101, 1.5, "1", null]) {
      const bad = await request(srv.base, "/api/sessions/one.jsonl/rewind", {
        method: "POST",
        body: { turns },
      });
      assert.equal(bad.status, 400, `turns ${String(turns)} -> ${bad.text}`);
      assert.match(bad.text, /rewind turns/);
    }

    const unknown = await request(srv.base, "/api/sessions/nope.jsonl/rewind", {
      method: "POST",
      body: { turns: 1 },
    });
    assert.equal(unknown.status, 404);

    const corrupt = await request(srv.base, "/api/sessions/corrupt.jsonl/rewind", {
      method: "POST",
      body: { turns: 1 },
    });
    assert.equal(corrupt.status, 422, corrupt.text);

    // live run and manual compaction guards
    writeSession(srv.sessionsDir, "busy.jsonl", [...turn(1, "busy task")]);
    const stop = await parkRun(srv, "busy.jsonl");
    try {
      const live = await request(srv.base, "/api/sessions/busy.jsonl/rewind", {
        method: "POST",
        body: { turns: 1 },
      });
      assert.equal(live.status, 409, live.text);
      assert.match(live.text, /stop it before rewinding/);
    } finally {
      await stop();
    }
    srv.handle.state.compactions.add("busy.jsonl");
    const compacting = await request(srv.base, "/api/sessions/busy.jsonl/rewind", {
      method: "POST",
      body: { turns: 1 },
    });
    assert.equal(compacting.status, 409, compacting.text);
    srv.handle.state.compactions.delete("busy.jsonl");
  } finally {
    await srv.close();
  }
});

test("POST rewind: a compaction summary is a hard floor, reported honestly", async () => {
  const srv = await startServer();
  try {
    writeSession(srv.sessionsDir, "c.jsonl", [
      ...turn(1, "summarized task"),
      envelope(3, "user", "senior", "message", {
        text: `${COMPACTION_SUMMARY_PREFIX}old work happened.`,
      }),
      ...turn(4, "post-summary task"),
    ]);

    const response = await request(srv.base, "/api/sessions/c.jsonl/rewind", {
      method: "POST",
      body: { turns: 2 },
    });
    assert.equal(response.status, 200, response.text);
    const body = response.body as Record<string, unknown>;
    assert.equal(body.rewritten, true);
    assert.equal(body.turns, 1);
    assert.equal(body.requested_turns, 2);
    assert.equal(body.kept, 3);
    assert.equal(body.removed, 2);
    assert.equal(body.stopped_at_compaction, true);
    assert.equal(body.stops_before, "compaction-summary");
    assert.match(String(body.reason), /compaction summary/);
    // the summary and everything before it stay in the transcript
    const events = new SessionStore(path.join(srv.sessionsDir, "c.jsonl")).load();
    assert.deepEqual(
      events.map((event) => event.seq),
      [1, 2, 3],
    );
    assert.ok(events[2].payload.text === `${COMPACTION_SUMMARY_PREFIX}old work happened.`);
  } finally {
    await srv.close();
  }
});

test("POST rewind: a session changed while the request body streamed is a 409 CAS", async () => {
  const srv = await startServer();
  try {
    const file = writeSession(srv.sessionsDir, "cas.jsonl", [
      ...turn(1, "first task"),
      ...turn(3, "second task"),
    ]);
    const encoder = new TextEncoder();
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;
        controller.enqueue(encoder.encode('{"turns":'));
      },
    });
    const pending = fetch(`${srv.base}/api/sessions/cas.jsonl/rewind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as unknown as RequestInit);
    // The handler captures the file identity before awaiting the body; give it
    // a moment to start, then rewrite the file while the upload is still open
    // and only afterwards finish the (now-valid) JSON body.
    await delay(400);
    fs.appendFileSync(file, JSON.stringify(envelope(5, "user", "senior", "message", { text: "late" })) + "\n");
    controllerRef!.enqueue(encoder.encode("1}"));
    controllerRef!.close();
    const response = await pending;
    const text = await response.text();
    assert.equal(response.status, 409, text);
    assert.match(text, /session changed while rewinding; retry/);
    // nothing was cut: the file still has all envelopes
    assert.deepEqual(seqsOf(file), [1, 2, 3, 4, 5]);
  } finally {
    await srv.close();
  }
});
