/**
 * CLI `serve` lifecycle: graceful shutdown. SIGINT/SIGTERM drive a
 * cooperative cancel of in-flight runs, a bounded unwind grace, SSE/server
 * close, and the normal exit-code path (0, not a signal death).
 *
 * Windows cannot deliver POSIX signals to a spawned CLI reliably, so the
 * installed handlers are driven in-process with `process.emit(...)` and the
 * cancel/close core (`shutdownServe`) is tested directly — the same split
 * e2e/cli.ts relies on for its serve scenario.
 *
 * Run with: node --test tests/serveshutdown.test.ts
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { main, shutdownServe, type CliIO } from "../src/cli.ts";
import { createServer } from "../src/server.ts";

function makeIO(): CliIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (line) => out.push(line), error: (line) => err.push(line) };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-serve-shutdown-"));
  try {
    await fn(dir);
  } finally {
    // Windows briefly holds handles on freshly written files.
    for (let attempt = 0; ; attempt++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        return;
      } catch (exc) {
        if (attempt >= 4) throw exc;
        const deadline = Date.now() + 50 * (attempt + 1);
        while (Date.now() < deadline) {
          // busy-wait: cleanup runs synchronously inside test teardowns
        }
      }
    }
  }
}

/** Reserve a free loopback port by bind-then-release (e2e/cli.ts idiom). */
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as net.AddressInfo;
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("waitFor timed out");
}

async function getJson(
  url: string,
): Promise<{ status: number; body: unknown } | { error: string }> {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        let body: unknown = raw;
        try {
          body = JSON.parse(raw);
        } catch {
          // keep the raw text
        }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on("error", (err) => resolve({ error: String(err) }));
  });
}

test("shutdownServe cancels an active run, closes the server, preserves flushed sessions", async () => {
  await withTempDir(async (dir) => {
    const sessionFile = path.join(dir, "sess.jsonl");
    const flushed = '{"kind":"message","seq":1}\n{"kind":"decision","seq":2}\n';
    fs.writeFileSync(sessionFile, flushed, "utf-8");

    const app = createServer({ sessionsDir: dir });
    const server = await app.listen("127.0.0.1", 0);

    let unwound = false;
    const record = app.state.runs.submit(
      "long task",
      "sess",
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            unwound = true;
            reject(new Error("aborted"));
          });
        }),
      "consult",
    );
    await waitFor(() => app.state.runs.get(record.runId)?.status === "running");

    await shutdownServe(app, 2_000);

    assert.equal(unwound, true, "the run unwound on the cooperative stop");
    assert.equal(app.state.runs.get(record.runId)?.status, "cancelled");
    assert.equal(server.address(), null, "server closed (no longer listening)");
    assert.equal(
      fs.readFileSync(sessionFile, "utf-8"),
      flushed,
      "already-flushed session JSONL is untouched",
    );
  });
});

test("shutdownServe does not hang when a run ignores its abort signal", async () => {
  await withTempDir(async (dir) => {
    const app = createServer({ sessionsDir: dir });
    const server = await app.listen("127.0.0.1", 0);
    const record = app.state.runs.submit(
      "stuck task",
      "sess",
      () =>
        new Promise(() => {
          // never settles, ignores the abort signal
        }),
      "consult",
    );
    await waitFor(() => app.state.runs.get(record.runId)?.status === "running");

    const started = Date.now();
    await shutdownServe(app, 300);
    assert.ok(Date.now() - started < 5_000, "shutdown stays bounded by the grace window");
    assert.equal(server.address(), null, "server closed even with a stuck run");
  });
});

test("serve: SIGINT resolves main() with 0, logs, stops accepting, removes handlers", async () => {
  await withTempDir(async (dir) => {
    const io = makeIO();
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const sigintBefore = process.listenerCount("SIGINT");
    const sigtermBefore = process.listenerCount("SIGTERM");

    const running = main(
      ["serve", "--host", "127.0.0.1", "--port", String(port), "--sessions-dir", dir],
      io,
    );
    await waitFor(() => io.out.some((line) => line.includes("Two Brothers server on")));

    const before = await getJson(`${base}/api/sessions`);
    assert.deepEqual(before, { status: 200, body: [] });

    process.emit("SIGINT");
    const code = await running;

    assert.equal(code, 0, "normal exit semantics: exit 0, not a signal death");
    assert.match(io.err.join("\n"), /SIGINT received — shutting down/);
    assert.equal(process.listenerCount("SIGINT"), sigintBefore, "SIGINT handler removed");
    assert.equal(process.listenerCount("SIGTERM"), sigtermBefore, "SIGTERM handler removed");

    const after = await getJson(`${base}/api/sessions`);
    assert.ok("error" in after, "no longer accepting connections after shutdown");
  });
});
