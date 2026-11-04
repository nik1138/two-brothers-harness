# E2E fixtures

The `approval-*` and `stop` scenarios in `../run.mjs` need scripted,
deterministic model responses. Every scenario runs against the TypeScript
server (`packages/harness/dist/cli.js serve`). That server has no
responder-monkeypatching hook, so the fixture is a scripted
**OpenAI-compatible model server**:

```
node scripted-server.mjs --port P --scenario approval|slow \
  [--senior-model e2e-senior] [--junior-model e2e-junior] [--linger-ms 30000]
```

Endpoints: `GET /v1/models`, `POST /v1/chat/completions` (queued,
deterministic responses: a junior `workspace_write_file` tool call, then a
deliverable after the tool result; a plain-text senior verification; fixed
consult/delegation/proposal/review/decision payloads; per-call usage). In
the `slow` scenario the senior's first answer lingers `--linger-ms` and
aborts the moment the harness stops the run, so a stop unwinds in ~1 s.

`../run.mjs` starts it automatically next to the server, which is
spawned as:

```
node ../../packages/harness/dist/cli.js serve --host 127.0.0.1 --port P --sessions-dir D
```

with `TWO_BROTHERS_PROVIDER=openai`, `TWO_BROTHERS_BASE_URL=http://127.0.0.1:<model-port>/v1`,
`TWO_BROTHERS_SENIOR_MODEL=e2e-senior`, `TWO_BROTHERS_JUNIOR_MODEL=e2e-junior`
(ambient `TWO_BROTHERS_*` provider env is stripped so runs stay
deterministic). The workspace is registered through the UI as usual, so the
write goes through the real permission/approval broker.

The scripted scenarios assert user-visible outcomes: allow → `e2e-hello.txt`
exists + "Changed files" shows the diff; deny → file absent + rejected
approval card; stop → "Run stopped" toast + no active run on `GET
/api/runs`.

While `packages/harness/dist/cli.js` does not exist (build it with
`cd packages/harness && npm run build`), every scenario is reported as
**SKIP** (never FAIL).