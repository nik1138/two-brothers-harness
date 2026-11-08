# Two Brothers Protocol — v1

A harness for cooperation between two agents: the **senior brother** and the
**junior brother**. Both work with **one shared context**, have **different
system prompts**, and **exchange structured messages**. The senior is the
arbiter: it consults the junior, may delegate part of the work, and makes the
final decision after the discussion.

The protocol is language-agnostic: it is described in JSON, and the
TypeScript package reproduces it exactly, with the zero-dependency
`typescript/` tree as the minimal second implementation of the same contract.
Because the contract is transport-neutral, cooperation across processes or
languages needs no protocol change.

---

## 1. Roles

| Role | Identifier | System prompt | Model (default) | Behavior |
|---|---|---|---|---|
| Senior brother | `senior` | experienced, level-headed, arbiter | — (not set by default; configure via §7) | Consults the junior, delegates part of the work, reviews proposals, makes the **final decision**. |
| Junior brother | `junior` | brave, determined, straightforward | — (not set by default; configure via §7) | Gives advice and proposals, **takes on part of the work**, is ready to argue its case, but does not override the senior's final decision without a compelling reason. |

The system prompts live in [`shared/prompts.json`](shared/prompts.json) and
can be overridden with the environment variables
`TWO_BROTHERS_SENIOR_SYSTEM` / `TWO_BROTHERS_JUNIOR_SYSTEM`.

---

## 2. Shared Context

The context is an **append-only list of events** (`events`). On every model
call, both brothers receive a **full copy of the context**, i.e. they see
exactly the same record:

1. the user's task;
2. all messages they have already sent each other;
3. the current state (what is required, what is already done).

`SharedContext`:
- `events: list[Event]` — append-only;
- `append(event: Event) -> Event`;
- `render_for_role(role: str) -> list[ChatMessage]` — turns the context into
  chat messages for the model: `[system_prompt(role)] + rendered_events`;
- `render_for_user() -> str` — human-readable text for the terminal.

**Principle:** the context is hidden from neither the senior nor the junior.
The only difference between them is the system prompt and the model.

---

## 3. Message envelope

All messages are JSON objects with the same envelope:

```json
{
  "v": 1,
  "id": "msg-0007",
  "seq": 7,
  "ts": "2026-10-24T13:50:00Z",
  "from": "senior",
  "to": "junior",
  "kind": "consult",
  "payload": {}
}
```

- `v` — protocol version (default 1).
- `id` — unique message id.
- `seq` — sequence number in the context (monotonically increasing).
- `ts` — ISO-8601 UTC.
- `from` — `"senior"` | `"junior"` | `"user"`.
- `to` — `"senior"` | `"junior"` | `"user"`.
- `kind` — message type (see below).
- `payload` — object; exactly one key set per type (details under each kind below).

The JSON Schema lives in [`shared/protocol.schema.json`](shared/protocol.schema.json).

---

## 4. Message kinds and their payloads

### `consult` — senior → junior
The senior asks for advice / a proposal on the task.

```json
{
  "task": "Plan a migration from Redis to Valkey",
  "ask": "Suggest an optimal phased plan and the main risks.",
  "expect": "proposal",
  "deadline_hint": "within the day"
}
```

- `task` (string, required) — what needs to be done.
- `ask` (string, required) — the concrete question to the junior.
- `expect` (`"proposal"` | `"review"` | `"answer"` | `"work"`, default `"proposal"`).
- `deadline_hint` (string, optional).

### `proposal` — junior → senior
The answer to a `consult`: a solution, a plan, arguments.

```json
{
  "title": "Migration in 3 phases",
  "answer": "Phase 1 — parallel dual-write...",
  "rationale": "It reduces risk because...",
  "risks": ["Dual-write complexity", "Possible key divergence"],
  "confidence": 0.7,
  "asks": ["Can an extra shard be allocated for phase 2?"]
}
```

- `title` (string, required).
- `answer` (string, required) — the most important part.
- `rationale` (string).
- `risks` (list[string]).
- `confidence` (number 0..1, default 0.5).
- `asks` (list[string]).

### `delegation` — senior → junior
The senior **hands over part of the work** to the junior.

```json
{
  "work": "Write a prototype adapter and 3 tests",
  "acceptance": ["adapter compiles", "three tests are enough", "no network calls"],
  "return": "deliverable",
  "notes": "Work in branches/valkey-adapter; do not refactor shared modules"
}
```

- `work` (string, required).
- `acceptance` (list[string], required) — completion criteria.
- `return` (`"deliverable"` | `"proposal"`, default `"deliverable"`).
- `notes` (string).

### `deliverable` — junior → senior
The result of work taken on.

```json
{
  "result": "adapter.ts + tests/adapter.test.ts are ready, 3 tests pass.",
  "artifacts": ["src/adapter.ts", "tests/adapter.test.ts"],
  "notes": "No network calls.",
  "confidence": 0.8
}
```

- `result` (string, required).
- `artifacts` (list[string]).
- `notes` (string).
- `confidence` (number 0..1, default 0.5).

### `review` — senior → junior
The verdict on a proposal / result: accept, rework, or reject.

```json
{
  "verdict": "revise",
  "notes": "The plan is good, but rollback during dual-write is not covered. Add a rollback path.",
  "points": ["No rollback considered", "No countermeasure for key conflicts"]
}
```

- `verdict` (`"accept"` | `"revise"` | `"reject"`, required).
- `notes` (string).
- `points` (list[string]).

### `decision` — senior (arbiter) → user
The **final decision**. A single such message ends the cycle.

```json
{
  "decision": "Migrate in 3 phases, with dual-write and rollback...",
  "rationale": "The senior took the junior's advice about rollback into account...",
  "confidence": 0.82,
  "dissent": null,
  "accepted_proposals": ["Phase 1 dual-write"]
}
```

- `decision` (string, required).
- `rationale` (string).
- `confidence` (number 0..1, default 0.7).
- `dissent` (string | null) — the junior's argument that the senior **did not
  accept** (empty for now).
- `accepted_proposals` (list[string]).

### `message` — anyone → anyone
A simple message without a strict structure.

```json
{ "text": "I agree with your approach." }
```

- `text` (string, required).

---

## 5. Cooperation cycle (harness loop)

```
user task
   │
   ▼
senior.think(context)  ── (may decide at once if it deems that effective)
   │
   ▼
senior.consult(junior)  ── consult / delegation
   │
   ▼
junior.respond(context) ── proposal / deliverable
   │
   ▼
senior.review(context)  ── accept | revise | reject
   │  revise ──► loop (max_rounds)
   ▼
senior.decision(context) ── decision (final)
   │
   ▼
print the full conversation + the final decision
```

The senior controls the cycle:

1. Receives the task from the user.
2. Decides whether to **ask for advice** (`consult`), **delegate part of the
   work** (`delegation`), or **decide on its own**. By default — `consult`, so
   that cooperation is visible.
3. Receives the junior's answer.
4. Reviews it (`review`). If `revise` — sends additions and the cycle repeats
   (bounded by `--max-rounds`, default 3).
5. Formulates the `decision` — the final decision with rationale, confidence,
   and the junior's objections.
6. The harness prints the whole conversation with explicit role labels.

**Important:** the junior may propose its own solution (`proposal`), not just
carry out assignments. If the junior considers the senior's decision wrong, it
writes the argument into the `proposal`/`deliverable`, and the senior records
it in `decision.dissent` — the dispute is explicit and stays in the context.

---

## 6. Providers

The harness knows nothing about models directly — it calls
`Provider.chat(messages, response_kind) -> str`.

- **`openai` (default)** — OpenAI-compatible `POST {base_url}/chat/completions`.
  Config: `base_url`, `api_key`, `model`, `temperature`, `timeout`.
  Works with DeepSeek, OpenAI, OpenRouter, local servers (vLLM, llama.cpp,
  Ollama with the OpenAI-compatible layer) and OpenCode Zen.
- **`mock`** — offline, deterministic provider. No network. Lets you run the
  cooperation cycle and the tests without an API key. See the section on the
  mock contract below.

---

## 7. Configuration

Environment variables and CLI flags (identical across implementations):

| Environment variable | Flag | Default | Description |
|---|---|---|---|
| `TWO_BROTHERS_PROVIDER` | `--provider` | `openai` | `openai` or `mock` |
| `TWO_BROTHERS_BASE_URL` | `--base-url` | — (empty) | OpenAI-compatible base URL; an `openai` run fails fast with a clear error until set |
| `TWO_BROTHERS_API_KEY` | `--api-key` | — | API key (may be empty for a local server) |
| `TWO_BROTHERS_SENIOR_MODEL` | `--senior-model` | — (empty) | senior model; fails fast until set |
| `TWO_BROTHERS_JUNIOR_MODEL` | `--junior-model` | — (empty) | junior model; fails fast until set |
| `TWO_BROTHERS_SENIOR_SYSTEM` | `--senior-system` | (in `shared/prompts.json`) | override the senior system prompt |
| `TWO_BROTHERS_JUNIOR_SYSTEM` | `--junior-system` | (in `shared/prompts.json`) | override the junior system prompt |
| `TWO_BROTHERS_MAX_ROUNDS` | `--max-rounds` | `3` | maximum discussion rounds |
| `TWO_BROTHERS_MODE` | `--mode` | `consult` | cooperation mode: `consult` (advice) / `work` (delegation) / `auto` |
| `TWO_BROTHERS_TEMPERATURE` | `--temperature` | `0.4` | temperature |
| `TWO_BROTHERS_TIMEOUT` | `--timeout` | `120` | per-request HTTP timeout in seconds; bounds every attempt of the retry loop |
| `TWO_BROTHERS_RETRIES` | `--retries` | `6` | retries after a failed model call (`0` = single attempt); backoff grows 2 s, 4 s, 8 s, … capped at 30 s — 7 attempts total by default |
| `TWO_BROTHERS_VERBOSE` | `--verbose` | `false` | verbose output |
| `TWO_BROTHERS_JSON` | `--json` | `false` | equivalent to `--json` in the running implementation (explicit output flags/modes win over it): the TypeScript package emits its documented single machine-readable output object, while the zero-dependency reference keeps the §9 decision-line output |
| `TWO_BROTHERS_SESSION_FILE` | `--session-file` | — | JSONL file to persist every envelope to |
| `TWO_BROTHERS_RESUME` | `--resume` | `false` | resume the session file instead of starting a new one |

Precedence: CLI flags > environment variables > defaults. (In the web
workspace, per-role settings persisted in `sessions/settings.json` sit
between environment variables and defaults — an environment variable set
wins over the persisted value.)

---

## 8. CLI

```
two-brothers run "<task>"            # one call: task -> cooperation -> decision
two-brothers chat                    # REPL: many tasks in one session
two-brothers selftest                # offline check of the protocol and providers (mock)
```

The cooperation mode is set with the `--mode` flag:

- `consult` (default) — the senior asks for advice, the junior gives a
  `proposal`, the senior reviews (`review`) and makes the `decision`.
- `work` — the senior **delegates part of the work** (`delegation`), the junior
  executes and returns a `deliverable`, the senior reviews and makes the `decision`.
- `auto` — the senior chooses between advice and delegation.

Identical interface in the TypeScript package (`node dist/cli.js ...`) and the
zero-dependency reference (`node src/cli.ts ...`).

## 9. Output

- With `--verbose`: every step with the role label and the message type.
- Without `--verbose`: a compact conversation.
- `--json`: the final `decision` as JSON (the zero-dependency reference
  behavior; the TypeScript package's `--json`/`TWO_BROTHERS_JSON` emit its
  documented machine-readable output object instead — see
  `docs/cli-reference.md`).

---

## 10. Sample conversation (mock provider)

```
[user]        Plan a migration from Redis to Valkey.
[senior]      consult -> junior: Suggest an optimal phased plan and the main risks.
[junior]      proposal -> senior: "Migration in 3 phases" (confidence 0.7) ...
[senior]      review -> junior: accept
[senior]      decision -> user: Migration in 3 phases, with dual-write and rollback ... (0.82)
```

---

## 11. Mock provider contract

`mock` uses no network and answers deterministically so that demos and tests
do not depend on an API. To behave identically in the package and the
reference, it
reacts to the `response_kind` parameter (passed by the harness on every call)
and to the task text taken from the context.

`Provider.chat(messages, response_kind) -> str` always returns a **JSON string**
with the right payload (this text is then placed into `Message.payload` and
into the context).

| `response_kind` | Returned JSON |
|---|---|
| `"consult"` | `{"task": "<task>", "ask": "...", "expect": "proposal", "deadline_hint": "..."}` |
| `"delegation"` | `{"work": "<task-derived>", "acceptance": ["..."], "return": "deliverable", "notes": ""}` |
| `"proposal"` | `{"title": "...", "answer": "...", "rationale": "...", "risks": [...], "confidence": 0.7, "asks": [...]}` |
| `"deliverable"` | `{"result": "...", "artifacts": [...], "notes": "...", "confidence": 0.8}` |
| `"review"` | `{"verdict": "accept", "notes": "...", "points": []}` |
| `"decision"` | `{"decision": "...", "rationale": "...", "confidence": 0.82, "dissent": null, "accepted_proposals": [...]}` |
| other | `{"text": "<echo first 120 chars of the task>"}` |

- In `proposal`/`decision` the text must reference the task (taken from the
  last user message or the last `consult`). This verifies that the context is
  the same for both brothers.
- `verdict` is deterministic: `accept` if the context has no `review` with
  `verdict != accept` yet, otherwise `revise`. This gives the cycle a visible
  discussion.
- All confidence values are numbers, not strings.

The harness **must** pass `response_kind` and be able to parse the returned
JSON, and must also tolerate replies from real models that may not be JSON
(record it, try to extract a JSON block, and as a last resort copy the text
into a `message`).
