# Design: why this is cooperation, not subagents

## 1. What "Two Brothers" is

Two LLM agents with explicit roles, the same context and different system
prompts:

- **Senior (older brother)** — experienced and level-headed, the arbiter.
  Consults, delegates, reviews and makes the final decision.
- **Junior (younger brother)** — brave and determined. Gives advice, proposes
  solutions, can take on part of the work, and is ready to argue its case.

## 2. Why this is not subagents

In conventional agent systems, subagents are **called and gone**: the parent
sends a task, receives a result and never sees how it was reasoned out. Here
the situation is different:

| | Subagent | Two Brothers |
|---|---|---|
| Context | Partial, ends on return | **One shared append-only log**, fully visible to both |
| Roles | Worker/executor | **Senior + junior**, each with its own behavior and prompt |
| Interaction | One call, one direction | **Dialogue**: advice → proposal → discussion → decision |
| Decision | Returns a result to the parent | **Senior is the arbiter**, records the dispute and dissent |
| Hierarchy | Parent commands | **Direct messages between the brothers** within one context |

The main goal is **cooperation**: the junior is not a "subordinate" but a
second voice that the senior must hear and take into account. If the junior
sees a problem, it says so directly; the senior either accepts the argument
or rejects it and records the reason.

## 3. Shared context

`SharedContext` is an append-only list of events. Every model call receives
exactly the same transcript:

```
[[TASK]]
<user task>
[[/TASK]]

Context events:
[1] [user -> senior] message: {"text": "..."}
[2] [senior -> junior] consult: {...}
[3] [junior -> senior] proposal: {...}
...
```

The system prompt is the only difference between the senior's and the
junior's calls. That is what "same context, different roles" means. It is
verified by a test (`packages/harness/tests/harness.test.ts`, "shared context
is identical for both roles").

## 4. Message protocol

Structured messages (see [`PROTOCOL.md`](PROTOCOL.md)). Envelope:

```json
{ "v": 1, "id": "...", "seq": 2, "ts": "...", "from": "senior", "to": "junior", "kind": "consult", "payload": {...} }
```

Kinds: `consult`, `proposal`, `delegation`, `deliverable`, `review`, `decision`, `message`.

**Why one protocol:** the protocol is a language-agnostic contract. Two
implementations — the TypeScript package and the zero-dependency
`typescript/` reference — must speak the same "language" so that:
- they can be compared;
- later one process can run a brother and another process the other brother,
  and they would still understand each other.

## 5. Cooperation cycle

```
user task
   │
   ▼
senior → junior   consult   ("advise me")
   │                        or  delegation ("do part of the work")
   ▼
junior → senior   proposal  or  deliverable
   │
   ▼
senior → junior   review    accept | revise | reject
   │  revise → junior → senior (bounded by --max-rounds)
   ▼
senior → user     decision   (final, confidence, dissent)
```

- `--mode consult` (default): the senior asks for advice, the junior proposes,
  the senior decides.
- `--mode work`: the senior delegates part of the work, the junior executes
  and returns the result.
- `--mode auto`: the senior chooses (in v0.1 this reduces to `consult`).

## 6. Decisions and limitations v0.1

- Providers: `openai` (OpenAI-compatible) and `mock` (offline, deterministic),
  plus Anthropic and Google Gemini wire adapters in the TypeScript package
  (per-role `--senior-kind` / `--junior-kind`).
- Models are configured independently for the senior and the junior.
- The current v0.1 is one harness process with both brothers in one session.
  **Cross-language cooperation** (the brothers in separate processes or
  languages) requires a transport (socket/pipe/HTTP) around the protocol. The protocol is already ready for this.
- Adding a third brother (a sister) requires only a new role + system prompt:
  the protocol is not tied to the number of participants.

## 7. Verification on real models

The harness CLI talks to OpenAI-compatible HTTP endpoints (`--provider
openai`); Anthropic and Google Gemini are reachable through their adapters
(`--senior-kind` / `--junior-kind`). The model `spark-x2.6` in that environment is reachable
**only through DSH routing** (provider `xhtoken`); it has no HTTP endpoint, so
it cannot be connected to the CLI directly. Verification on spark-x2.6 is done
through a `subagent` with an explicit route:

```
provider: xhtoken
model:    spark-x2.6
```

The full cycle (senior consult → junior proposal → senior review → senior
decision) is run with an explicit `xhtoken/spark-x2.6`, where the junior and
the senior receive the same context but different prompts. This confirms that
the protocol works on a real model.

## 8. What is next (possibly)

- Transport for cross-language mode (one brother in another process or
  language).
- Context persistence to a file/database — done: `--session-file` / `--resume`.
- GUI / API on top of the harness — done: the web workspace.
- Model pool and fallback on 429/errors (bounded retry and error
  classification are done; cross-model fallback is not).
- Exact linear evaluation for blind cooperation tests.
