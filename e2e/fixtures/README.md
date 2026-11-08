# E2E fixtures

The `approval-*`, `stop`, `folding`, `plan-dock`, `approval-reason` and
`reasoning-replay` scenarios in `../run.mjs` need scripted, deterministic model
responses. Every scenario runs against the TypeScript server
(`packages/harness/dist/cli.js serve`). That server has no
responder-monkeypatching hook, so the fixture is a scripted
**OpenAI-compatible model server**:

```
node scripted-server.mjs --port P --scenario approval|slow|plan|folding|delete|reasoning \
  [--senior-model e2e-senior] [--junior-model e2e-junior] [--linger-ms 30000]
```

Endpoints: `GET /v1/models`, `POST /v1/chat/completions` (queued,
deterministic responses: a junior `workspace_write_file` tool call, then a
deliverable after the tool result; a plain-text senior verification; fixed
consult/delegation/proposal/review/decision payloads; per-call usage). The
`reasoning` scenario additionally answers a streaming request (`stream: true`)
with real `text/event-stream` chat-completion chunks (`delta.reasoning_content`
thinking first, then content, a usage chunk and `[DONE]`); every other request
keeps the non-streaming JSON completion.

Scenario scripts (all inferred from the rendered transcript, so multi-run
scenarios need no hidden server state — a fresh task message after the previous
run's decision starts the next run):

- `approval` — one workspace write, then the deliverable (used by
  approval-allow/deny so the real permission/approval broker parks the run).
  Its FIRST senior opening reply is a deliberately malformed delegation, so
  exactly one real `[[REPAIR_REQUEST]]` repair cycle happens per fixture
  process (the browser scenario asserts the neutral "Reply format repair"
  activity and that no raw marker renders); the repair retry answers with a
  valid delegation.
- `slow` — the senior's first answer lingers `--linger-ms` and aborts the
  moment the harness stops the run, so a stop unwinds in ~1 s.
- `plan` — work-mode runs whose junior writes one whole `todo_write` plan per
  run: 3 items on the first run, 6 items on the second (bounded list + expand),
  an empty list on the third (the model clears the plan), then the deliverable.
- `folding` — work-mode runs whose junior writes two `todo_write` plans per run
  (two tool cards, enough for the browser fold summary) and then the deliverable;
  on the second run the deliverable lingers `--linger-ms` so the browser can
  observe the followed run's still-open rows. The two snapshots deliberately
  differ in item count (2 vs 3): runtime event arguments are clipped to strings
  and events use whole-second timestamps, so identical calls would be
  byte-identical and the web client's exact-JSON runtime-event dedupe would
  collapse them into a single tool card. Each folding run also starts on a fresh
  wall-clock second so its whole tool loop shares one event timestamp.
- `delete` — one `workspace_delete_file` approval (the browser
  `approval-reason` scenario creates the target file before the run), then the
  deliverable after the operator decision; the request carries the product's
  documented `DELETE_APPROVAL_REASON`, which the approval card renders.
- `reasoning` — a task whose text carries the `e2e-reasoning` marker is
  answered with SSE `delta.reasoning_content` thinking chunks before the reply
  content: the senior consult call streams thinking with an ANSI escape, a BEL
  control byte and literal `<img onerror=…>` markup (must be sanitized and stay
  text), the junior proposal call streams ~12 000 chars (must be head+tail
  clipped by the backend), and review/decision stream a short clean record. A
  task without the marker gets the historical JSON reply and therefore persists
  no reasoning record — the browser scenario uses both sessions in one fixture
  process to prove the "no events, no replayed row" case.

`../run.mjs` starts it automatically next to the server, which is
spawned as:

```
node ../../packages/harness/dist/cli.js serve --host 127.0.0.1 --port P --sessions-dir D
```

with `TWO_BROTHERS_PROVIDER=openai`, `TWO_BROTHERS_BASE_URL=http://127.0.0.1:<model-port>/v1`,
`TWO_BROTHERS_SENIOR_MODEL=e2e-senior`, `TWO_BROTHERS_JUNIOR_MODEL=e2e-junior`
(ambient `TWO_BROTHERS_*` provider env is stripped so runs stay
deterministic). The workspace is registered through the UI as usual for the
approval scenarios, so the write goes through the real permission/approval
broker; `plan`/`folding` runs need no workspace (the plan tool never touches
one) and therefore never park on an approval.

The scripted scenarios assert user-visible outcomes: allow → `e2e-hello.txt`
exists + "Changed files" shows the diff; deny → file absent + rejected
approval card; stop → "Run stopped" toast + no active run on `GET
/api/runs`; folding → completed-run tool cards collapse into an
`aria-expanded` summary that expands/collapses in place; plan-dock → the Plan
dock counts/markers, its bounded "+N more" expand control and the
"Plan updated"/"Plan cleared." announcements; reasoning-replay → the session
runtime sidecar (via `GET /api/sessions/<name>/events`) carries bounded
`reasoning` events, and after a reload the web replays them as collapsed
"Thinking · replayed" rows whose expanded body is escaped plain text, with the
documented clipping marker on the over-long record and no row at all for a
session without reasoning events.

While `packages/harness/dist/cli.js` does not exist (build it with
`cd packages/harness && npm run build`), every scenario is reported as
**SKIP** (never FAIL).