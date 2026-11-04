# Web UI Audit (2026-11-02)

Date: 2026-11-02. Scope: `web/` (Vue 3 + Vite + TypeScript workspace) measured
against the UX standard of modern harness web UIs (opencode web, kimi web,
deepseek-harness `--profile web`). **Read-only audit** — no code was changed
and the build was not run; every claim below comes from reading the sources
listed in *Method*. This document is the input for the next implementation
wave: §5 is a gap list (P0/P1/P2) and §6 is an implementation plan chunked so
independent subagents can work in parallel without file conflicts.

> **Backend framing (2026-11-03):** the TypeScript server
> (`packages/harness`; `node dist/cli.js serve`) is the primary web backend.
> The Python FastAPI backend is the frozen prototype's and is exercised for
> parity only; where this audit compares backends, the TypeScript server is
> the one the product ships.

Method: read `web/AGENTS.md`, all of `web/src/` (13 components, 8 core
modules, 1 018 lines of TS + 2 811 lines of Vue), the API routes in
`packages/harness/src/server.ts` (route table, lines 585–1095), the runtime
event emitter in `packages/harness/src/runtime.ts` (lines 440–640), tool-result
compaction in `packages/harness/src/runevents.ts`, and the browser E2E suite
`e2e/run.mjs`.

---

## 1. Current feature inventory

### 1.1 Architecture snapshot

Data flow: `EventSource /api/runs/{id}/events?after=N` → `App.vue`
(`handleRunEvent`) → two ref arrays (`events: Envelope[]`,
`runtimeEvents: RunEvent[]`) → pure projections (`chat.ts`, `runtime.ts`) →
merged `TimelineEntry[]` → `ChatView` renders. Session history loads via
`GET /api/sessions/{name}` + `GET /api/sessions/{name}/events` (runtime
sidecar). Live runs are discovered by polling `GET /api/runs` every 5 s
(`refreshLiveRuns`). State is entirely in `App.vue` (774 lines); there are no
stores/composables — `App.vue` is the store.

### 1.2 Core modules

| File | Lines | What it does |
|---|---|---|
| `src/App.vue` | 774 | The entire app state: session/workspaces refs, live-run map (`liveRuns`), SSE connect/reconnect (`?after=N`, max 6 attempts, run-state probe before reconnect), run finalization (usage fetch, session re-fetch, sidecar merge), approval answering, stop, retry, theme follow-OS, 5 s poll timer, all dialogs |
| `src/api.ts` | 168 | Typed client for sessions (list/get/create + runtime sidecar), workspaces, settings, runs (start/get/stop), approvals, `fs/browse`, providers. **Missing:** rename (PATCH), delete (DELETE), `listRuns`, plugins — those are raw `fetch` in components (see G-9) |
| `src/types.ts` | 248 | API types mirroring `PROTOCOL.md` envelopes and runtime events. `RunStatus` (line 59) lacks `'waiting'` — the UI casts around it (App.vue:383, 422–430, 446) |
| `src/chat.ts` | 231 | Envelope → group-chat projection. `toMessage` interprets all 7 payload kinds (message/consult/proposal/delegation/deliverable/review/decision) into title/body/detail-lines/lists/verdict/confidence; `projectEnvelopes` groups by author+recipient with a 10 min gap, splits on decision highlight and revise verdicts (revision dividers); `sessionTitle`/`taskOf`/`relativeTime` helpers |
| `src/runtime.ts` | 311 | Runtime-event → item projection: pairs `tool_started`/`tool_completed` (per-tool FIFO queue), pairs `approval_requested`/`approval_resolved`; `mergeTimeline` interleaves chat groups and runtime items chronologically; `changedFilesOf` collects diffs for the review panel; `parseRichText` = the only rich-text path (fenced code blocks + URL linkify, lines 242–279); `nextActorLabel` guesses the acting role from the timeline tail |
| `src/theme.ts` | 75 | naive-ui theme overrides mapped from the CSS tokens, light + dark |
| `src/modal.ts` | 18 | Stacked-modal mask-click guard |
| `src/style.css` | 966 | Design tokens (`:root` custom properties + `@media (prefers-color-scheme: dark)`), layout, chat stream, sidebar, dialogs, toasts, responsive breakpoints at 860/640 px |

### 1.3 Components

| Component | File | What it does today |
|---|---|---|
| Shell | `App.vue` | Sidebar + header (title, task, participants, provider chip, live/queued badge, settings button) + `ChatView` + `DiffReview` + retry button + `UsageFooter` + `Composer` + toasts + 4 dialogs |
| Sidebar | `components/Sidebar.vue` (421) | Session list grouped by workspace ("All" filter) or flat, client-side title search, workspace filter `<select>`, inline rename (PATCH) + delete (DELETE, 3 s "sure?" confirm) via **raw fetch** (lines 89–101), live dot per running session, collapse |
| ChatView | `components/ChatView.vue` (362) | Renders the merged timeline: revision dividers, `ToolActivity`, `ApprovalCard`, chat groups (avatar, speaker, recipient chip, time) with bubbles (kind chip, verdict chip, detail list, lists, dissent, confidence bar), per-bubble copy button, pin-to-bottom only when near bottom, working line with per-second ticker, `ContextMeter` |
| Composer | `components/Composer.vue` (133) | Textarea (Enter sends, Shift+Enter newline), mode select (consult/work/auto), provider override select (mock/openai/from settings), settings-missing warning banner, Stop button while busy |
| ToolActivity | `components/ToolActivity.vue` (284) | One card per tool call: actor chip, tool name, target (path or `$ cmd`), running/ok/failed pill, collapsed-by-default details (extra args, `DiffView` for diffs, `CommandResult` for shell-like results, plain text otherwise) |
| ApprovalCard | `components/ApprovalCard.vue` (178) | Inline card: action/target/command rows, reason, Allow/Deny buttons while pending, allowed/denied pill after; answers via `resolve` prop; optimistic flip only when not following the run |
| DiffView | `components/DiffView.vue` (188) | Unified-diff renderer: per-line add/del/context/hunk/meta coloring, +N/−N stats, horizontal scroll |
| DiffReview | `components/DiffReview.vue` (188) | Bottom panel aggregating all changed files of the session (naive-ui collapse, one item per file with stats); **default open** (line 11) |
| CommandResult | `components/CommandResult.vue` (209) | Shell-result card inside ToolActivity: command, exit pill, duration, collapsible stdout/stderr (max-height 16 rem), truncated note |
| SettingsDialog | `components/SettingsDialog.vue` (409) | Per-role (Senior/Junior): provider preset select, model, base URL, API key (never echoed back), plugin multi-select (raw `fetch /api/plugins`, lines 167–172); provider preset CRUD (immediate); one raw `PUT /api/settings` carrying roles+plugins (lines 220–235) |
| WorkspaceDialog | `components/WorkspaceDialog.vue` (79) | Register workspace directory (path + optional name) + `FolderPicker` browse |
| FolderPicker | `components/FolderPicker.vue` (105) | Directory explorer fed by `/api/fs/browse` (drive roots on Windows, parent nav, truncated hint), monotonic request-token race guard |
| NewSessionDialog | `components/NewSessionDialog.vue` (66) | Title (optional) + workspace select → `POST /api/sessions` |
| UsageFooter | `components/UsageFooter.vue` (115) | Live: elapsed ticker; after run: operator turns, in/out tokens, cache % |
| ContextMeter | `components/ContextMeter.vue` (61) | "N messages in context" note at ≥30, warning + nudge at ≥80 (heuristic count of projected items) |
| ErrorToast | `components/ErrorToast.vue` (13) | Bottom-left toast stack, auto-dismiss after 12 s, manual dismiss |

### 1.4 Backend API surface the UI can use (TS server, `server.ts`)

Sessions: `GET/POST /api/sessions`, `GET/PATCH/DELETE /api/sessions/{name}`,
`GET /api/sessions/{name}/events` (runtime sidecar). Workspaces:
`GET/POST/DELETE /api/workspaces[/​{id}]`. Settings: `GET/PUT /api/settings`
(roles + plugins section). Plugins: `GET /api/plugins`. Providers:
`GET/POST/PUT/DELETE /api/providers[​/{name}]`. FS: `GET /api/fs/browse`.
Runs: `POST /api/runs`, `GET /api/runs[?session=]`, `GET/POST stop
/api/runs/{id}[/stop]`, approvals `GET/POST /api/runs/{id}/approvals[​/{aid}]`,
SSE `GET /api/runs/{id}/events?after=N` emitting `run_status`
(queued/running only — **no `waiting` event is ever emitted**;
`runtime.ts:569–575` flips the run record to `waiting` when parked on an
approval, discoverable only via polling), `envelope`, `tool_started`,
`tool_completed`, `approval_requested`, `approval_resolved`, `run_error`,
`run_end` (carries `usage`). Tool results arrive pre-compacted and bounded
(`runevents.compactToolResult`: per-field clip, stdout/stderr block clip,
diff block clip, `truncated` flag) — the UI's output-bounding needs are met
by the backend contract.

### 1.5 E2E coverage today (`e2e/run.mjs`, Playwright on Edge/Chrome headless)

| Scenario | Covers |
|---|---|
| `chat` / `resume` (mock provider) | Full consult cycle rendered as 3 speakers, highlighted decision bubble, no raw JSON/markers leaked, reload restores history with metadata title |
| `approval-allow` / `approval-deny` (scripted fixture, work mode) | Approval card appears with "awaiting operator", Allow/Deny drives the write, `DiffReview` shows the changed file after allow / rejected pill after deny |
| `stop` (scripted slow run) | Stop button cancels, toast "Run stopped", backend has no active run |
| `real` (opt-in, LM Studio) | Full cycle on real models, envelope kinds on the SSE stream, run record carries numeric usage, wall-time deadline |

Each scenario runs against the TypeScript backend (the primary server) and the
frozen Python backend for parity.
**Not covered:** failed-run UX, settings/providers/plugins dialogs, session
rename/delete, workspace add via UI (only fixture pre-registration), tool-card
expand/collapse, dark mode, mobile viewport, keyboard navigation, usage
footer, context meter, markdown rendering, SSE reconnect.

---

## 2. The long work-mode run, as surfaced today

Walking the exact UI path for a `work`-mode run with tool calls and approvals
— the scenario the standard is judged on:

1. Operator sends the task → new session is selected, stream opens with
   `after=0`, everything replays live. Envelopes append one by one; bubbles
   appear atomically (no token streaming exists at protocol level — envelope
   granularity is the max, and the UI does render each envelope as it
   arrives). Each envelope triggers a **full O(n) re-projection**
   (`projectEnvelopes` + `mergeTimeline` over all events), so the run stutters
   more as the transcript grows.
2. Tool calls appear as compact, collapsed-by-default cards with a running
   pill — good. A run with many calls floods the timeline 1:1 (no grouping or
   "N calls" summary) but stays readable.
3. When the backend parks the run on an approval, **the only signal is the
   inline approval card**. The header badge still says `LIVE`, the activity
   line still says "Senior and Junior are working…" (App.vue:132–138), the
   footer still ticks elapsed, and the composer stays disabled with a Stop
   button. The run record says `waiting` (poll picks it up every 5 s) but
   App.vue deliberately flattens it back to `running` (App.vue:429–431,
   444–447). If the operator scrolled up to read history, nothing pulls them
   to the new card (no scroll-into-view, no banner, no sound).
4. Approving unblocks the run; the card flips to allowed/denied when the
   resolved event arrives.
5. File writes produce per-card diffs (collapsed) **and** the `DiffReview`
   panel at the bottom, which is **open by default** and stacks one full diff
   per file between the chat and the composer — on an edit-heavy run the
   composer is pushed far off-screen.
6. Markdown-heavy payloads (proposal answers, decision text, deliverable
   results from real models) render as plain text with pre-wrap: only fenced
   code blocks and URLs get any treatment (`parseRichText`). Bold, lists,
   tables, headings, inline code show raw — the primary content of the app
   looks broken on real models.
7. At `run_end` the footer switches to turns + in/out tokens + cache % (usage
   only exists at run end — a backend contract, not a UI gap). On failure: a
   12-second toast plus a floating "Retry last task" button; the error text is
   never shown inline and is gone after reload.

Baseline verdict: the plumbing (SSE + reconnect + projection + sidecar merge)
is solid and better than most local harness UIs; the rendering layer and the
approval/lifecycle ergonomics are where the gap to the modern standard lives.

---

## 3. Gap analysis

Priorities: **P0** hurts basic use of the app · **P1** is expected of any
modern harness web UI · **P2** is polish.

### P0 — hurts basic use

#### G-1. The approval-wait state is invisible; the UI actively misleads during it
- **Missing:** When a run parks on an approval, nothing in the chrome changes:
  badge `LIVE`, activity "Senior and Junior are working…", composer disabled
  with Stop. There is no `waiting` state in `types.ts` `RunStatus` (line 59),
  no banner, no scroll-into-view or focus pull to a newly arrived approval
  card, no keyboard shortcut to answer.
- **Why it matters:** The operator is the blocking resource and the UI tells
  them the agents are still working. On a long work run the operator learns
  to babysit the scrollbar instead of trusting the UI — the exact problem
  approval prompts exist to solve.
- **Fix sketch:** Add `'waiting'` to `RunStatus` in `types.ts`; stop
  flattening it in `App.vue` (`refreshLiveRuns` lines 412–451, plus the
  reconnect probe at 383 which already special-cases it). New computed
  `waiting = activeRun?.status === 'waiting'` drives: header badge
  "awaiting approval", `activity` text "Waiting for your approval", footer
  ticker label. In `ApprovalCard.vue`, `watch(pending)` → `scrollIntoView({
  block: 'nearest' })` + a one-time highlight animation when a card transitions
  to pending; add `y`/`n` key handling (scoped to when only one approval is
  pending). Keep the composer disabled (backend serializes same-session runs)
  but the Stop row may show "run is waiting for approval" context. Styles:
  `style.css` (badge + card pulse, append-only section).
- **Backend note:** no server change required — `GET /api/runs` already
  reports `waiting`; the SSE stream simply never emits it (a future
  `run_status: waiting` event would remove the ≤5 s detection lag).

#### G-2. No markdown rendering in message bodies
- **Missing:** `parseRichText` (`runtime.ts:242–279`) handles fenced code and
  URLs only. Everything else — headings, bold/italic, inline code, lists,
  tables, blockquotes — renders as raw characters with `white-space: pre-wrap`
  (`ChatView.vue:229–241`). Models write markdown in every non-trivial
  payload field (`answer`, `decision`, `result`, `notes`).
- **Why it matters:** Message content is the product. Real-model transcripts
  (see `SPARK-TRANSCRIPT.md`/`LMSTUDIO-TRANSCRIPT.md` shapes) are unreadable
  without markdown; every modern harness UI renders it.
- **Fix sketch:** Dependency rules forbid new npm packages (`web/AGENTS.md`
  rule 1) and naive-ui has no markdown component, so hand-roll a bounded
  CommonMark-subset renderer: new `src/markdown.ts` exporting
  `parseMarkdown(raw: string): MarkdownSegment[]` (segment = text | code
  block w/ lang | inline-styled text runs | list | table | heading |
  blockquote), built on the existing fence/link machinery from `parseRichText`
  (move, don't duplicate). `ChatView.vue` switches `richBody()` to the new
  parser and adds renderers per segment (mostly `<strong>`, `<em>`, `<ul>`,
  `<table>` — no syntax highlighting, that's P2); `style.css` gains a
  `.bubble-body` child-elements section (append-only). Copy serialization
  (`copyTextOf`, ChatView.vue:109–120) stays on the raw body — no contract
  change. Risk: segment parser must stay tolerant (model output is untrusted
  and often malformed); add unit-testable pure functions (no Vue) so E2E can
  assert on rendered DOM later.
- **Files:** new `web/src/markdown.ts`, `web/src/components/ChatView.vue`,
  `web/src/style.css`; removes/replaces `parseRichText` in
  `web/src/runtime.ts` (see chunk contract in §6).

#### G-3. Timeline projection is O(n) per event; no virtualization or windowing
- **Missing:** Every incoming envelope replaces `events.value` with a new
  array (`App.vue:233–238`), invalidating the `items` computed →
  `projectEnvelopes` + `mergeTimeline` re-run over the whole transcript
  (`chat.ts:138`, `runtime.ts:155`). A 500-envelope work run costs ~500 full
  passes ≈ O(n²). ChatView renders every row with no windowing.
- **Why it matters:** Long work-mode runs are the core scenario; per-event
  stutter grows linearly with transcript length and burns battery on the
  5 s poll ticks too.
- **Fix sketch:** Incremental projection: keep `projectEnvelopes` for initial
  load but add an append API (project only envelopes with `seq > maxSeq`,
  reuse the open group when the grouping predicate still holds; close-on-
  boundary only). Same for `projectRuntimeEvents` (append items, resolve
  pairs by id). Cache `TimelineEntry[]` and splice new entries into sorted
  position instead of re-sorting. Windowing: collapse everything above the
  first unread/recent boundary behind a "Show earlier messages (N)" button
  (simple, deterministic, keeps E2E selectors stable) — prefer this over
  naive-ui's `NVirtualList`, which fights variable-height rows and the
  pin-to-bottom logic. Defer rendering of collapsed ranges entirely
  (`v-if`, not `v-show`).
- **Files:** `web/src/chat.ts`, `web/src/runtime.ts`,
  `web/src/components/ChatView.vue`, `web/src/App.vue` (calls append API in
  `onEnvelope`/`ingestRuntimeEvent` instead of relying on computed
  invalidation — coordinate with Chunk 2 which owns App.vue; the contract is
  a new `appendProjection(env)` function signature, see §6).

#### G-4. `DiffReview` panel squeezes the composer off-screen on edit-heavy runs
- **Missing:** `DiffReview` sits between chat and composer, **open by
  default** (`DiffReview.vue:11`), one expander per changed file with full
  diffs inline; every new file write re-opens it.
- **Why it matters:** In work mode the operator composes the next instruction
  while files change; the input must stay on screen without manual collapsing
  on every change.
- **Fix sketch:** Default collapsed; keep a visible chip "Changed files · N
  (+a −r)" with an unread-style bump when a new file arrives while collapsed;
  remember the manual open/closed choice per session for the session lifetime.
  Optionally move the panel into a right-hand dock later — not required.
- **Files:** `web/src/components/DiffReview.vue` only (App.vue renders it
  conditionally already; no App.vue change needed).

### P1 — expected of a modern harness web UI

#### G-5. Failed-run errors don't surface inline and don't survive reload
- **Missing:** `run_error` events and a failed `run_end` produce only a 12 s
  toast (`App.vue:340–342`, `281`); the error text never appears in the
  transcript area, and after reload a failed session shows nothing (the
  sidecar has no error entry; the run record's `error` is never fetched for
  display).
- **Fix sketch:** Track `lastRunErrorBySession` in App.vue (from `run_error` /
  failed `run_end` / `getRun` on finalize). Render an inline error card at the
  tail of the timeline via a new `ChatView` prop pair `runError: string |
  null` + `onRetry: () => void` (contract owned by Chunk 1/2, see §6) with a
  Retry button (replacing the floating retry strip at App.vue:737–739). On
  session load, best-effort `GET /api/runs?session=` and surface the newest
  failed run's error — `listRunsForSession` already exists locally
  (App.vue:207–214).
- **Files:** `web/src/App.vue`, `web/src/components/ChatView.vue`,
  `web/src/components/UsageFooter.vue` (optional error dot), `web/src/api.ts`
  (typed `listRuns`, if Chunk 4 lands first — otherwise keep the local
  helper).

#### G-6. No manual theme control (OS-only dark mode)
- **Missing:** Theme follows `prefers-color-scheme` only (App.vue:623–629 +
  `style.css` media query). No in-app toggle, no persistence, no "system"
  third state.
- **Fix sketch:** `themeMode: 'light' | 'dark' | 'system'` persisted to
  `localStorage` (small module, e.g. `src/themeMode.ts`); App.vue resolves it
  into `isDark` and sets `data-theme` on `<html>`; `style.css` duplicates the
  dark token block under `:root[data-theme='dark']` (keep the media query as
  the `system` fallback); header toggle button (☾/☀/auto icon). naive-ui side
  already keyed off `isDark`.
- **Files:** `web/src/App.vue`, `web/src/theme.ts` (unchanged likely),
  `web/src/style.css` (append-only), new `src/themeMode.ts`.

#### G-7. Tool activity lacks run-level aggregation and elapsed timing
- **Missing:** N tool calls render as N cards with no summary; cards show a
  `running…` pill but no elapsed time, and no duration after completion
  (`tool_completed.at` is dropped when pairing in `runtime.ts:88–107`).
- **Fix sketch:** Add `finishedAt?: number` to `ToolActivityItem` (set from
  `tool_completed.at` in `runtime.ts` — Chunk 1 owns that file and adds the
  field as a contracted change; Chunk 3 consumes it). `ToolActivity.vue`
  shows a live ticking elapsed while running and a static duration after; a
  lightweight summary chip above the newest run's tool cluster ("12 calls · 2
  failed") computed in ChatView from consecutive tool entries. Optional:
  collapse consecutive completed-ok tool cards older than the latest N into
  one "earlier calls" row.
- **Files:** `web/src/components/ToolActivity.vue`,
  `web/src/components/CommandResult.vue` (copy-output button),
  `web/src/components/ChatView.vue` (summary chip), consumes
  `web/src/runtime.ts`.

#### G-8. Touch devices can't reach session rename/delete; composer controls can overflow on narrow screens
- **Missing:** `.session-actions` are `opacity: 0; pointer-events: none`
  revealed only on `:hover`/`:focus-within` (Sidebar.vue:367–380 + style.css)
  — no hover on touch. Under 640 px the sidebar overlays correctly, but
  `.composer-controls` (two selects + button on one right-aligned row) can
  wrap badly; participants hide at 860 px only.
- **Fix sketch:** `@media (hover: none)` keeps actions visible; add `flex-
  wrap: wrap` + full-width selects under 480 px; bump tap targets to ≥40 px.
- **Files:** `web/src/components/Sidebar.vue`, `web/src/style.css`
  (append-only), `web/src/components/Composer.vue`.

#### G-9. API client is bypassed in four places
- **Missing:** `api.ts` lacks rename/delete session, `listRuns`, and plugins;
  Sidebar.vue:89–101, App.vue:205–214 (`listRunsForSession` with a "backend-
  owns-api.ts" comment), SettingsDialog.vue:167–172/220–235 hand-roll fetch.
- **Fix sketch:** Add `renameSession`, `deleteSession`, `listRuns`,
  `listPlugins`, and a settings `updateSettings` variant that carries
  `plugins` to `api.ts`; switch the three call sites. Pure refactor, no
  behavior change.
- **Files:** `web/src/api.ts`, `web/src/components/Sidebar.vue`,
  `web/src/components/SettingsDialog.vue` (App.vue's helper migration is
  Chunk 2's job since App.vue is theirs).

#### G-10. Empty states have no calls to action; sidebar lacks counts
- **Missing:** "No sessions yet" is inert text; welcome card has no shortcut
  buttons; no session count anywhere.
- **Fix sketch:** Inline "New session" button in the empty sidebar hint;
  welcome card gets two buttons (New session / Add workspace); group headers
  show item counts.
- **Files:** `web/src/components/Sidebar.vue`, `web/src/App.vue` (welcome
  card — Chunk 2 file; coordinate or fold into Chunk 4's sidebar work with a
  one-line prop event already available: `newSession`/`addWorkspace` events
  exist).

### P2 — polish

| # | Gap | Why / fix sketch | Files |
|---|---|---|---|
| G-11 | No keyboard-driven session switching | Modern UIs have Ctrl/Cmd+K. New `Palette.vue` (fuzzy session search + actions: new/rename/delete/settings) mounted in App.vue; global keydown handler, respects dialogs-open | new `src/components/Palette.vue`, `App.vue` |
| G-12 | No in-session message search, no transcript export | Add a search box filtering/highlighting matching bubbles; export = `GET /api/sessions/{name}` JSON download | `ChatView.vue`, `App.vue` |
| G-13 | No run history per session | Only the latest completed run's usage is shown. List past runs (status, usage, error) from `GET /api/runs?session=` in a collapsible drawer | new `RunHistory.vue`, `App.vue`, `api.ts` |
| G-14 | No per-role model identity in the header | Header shows participants + provider chip only when overridden; surface `senior: model / junior: model` from settings (settings summary fetch) | `App.vue`, `api.ts` (or reuse Chunk 4 helper) |
| G-15 | No syntax highlighting in code blocks/diffs | Hand-rolled highlighting is a big lift for marginal gain at this scale; revisit only after markdown lands. Alternative: language-labeled fences get a subtle header chip | `markdown.ts`, `DiffView.vue` |
| G-16 | No new-message animation; bubbles pop in abruptly | ~10 lines of CSS (fade/slide-in on bubble mount), keep `prefers-reduced-motion` guard | `style.css` |
| G-17 | Composer niceties | Up-arrow recalls last task; Ctrl/Cmd+Enter send; auto-grow already OK | `Composer.vue` |
| G-18 | Reconnect give-up mislabels a live run | After 6 failed reconnects the run is finalized as `completed` in the UI (App.vue:372–376) regardless of the real backend state; show a "disconnected — run continues on the server" state instead and keep polling | `App.vue`, `UsageFooter.vue` |
| G-19 | Approval hardening | Optimistic local flip when following the run too (today only when not, App.vue:562–570); disable both buttons while `answering`; surface resolution failure on the card itself | `ApprovalCard.vue`, `App.vue` |
| G-20 | `ContextMeter` is a message count, not a context estimate | Fine as a proxy; could read `usage.input_tokens` of the latest run for a token-based bar (backend has the data at run end) | `ContextMeter.vue`, `App.vue` |

### Strengths to preserve (do not regress)

- Envelope-level streaming with `?after=N` resume + dedupe of sidecar/live
  twins (`runtimeDedupeKey`) — reconnect logic is better than most.
- Tool cards collapsed-by-default with bounded outputs (backend contract).
- Working line with per-second ticker + `nextActorLabel` role guessing.
- Revision dividers, decision highlighting, verdict/confidence/dissent
  rendering, per-bubble copy.
- Grouped sidebar with workspace filter + live dots, inline rename/delete.
- Follow-OS dark mode tokens kept in sync between CSS and naive-ui
  (`theme.ts` table comment).
- Solid aria baseline (`role="log"`, `aria-live`, labeled controls).

---

## 4. Suggested implementation order (parallel-safe chunking)

Rules: each chunk owns its files exclusively; `style.css` is the single shared
file — **append-only, new sections at the end with a `/* <chunk> */` banner**;
cross-chunk contracts listed under §4.2 must be implemented exactly as
specified so integration needs no rework. Every chunk ends with
`cd web && npm run build` (vue-tsc + vite) green before handoff; the E2E
chunk (5) runs the full `scripts/e2e-test.ps1`.

### Wave 1 — four parallel lanes

**Chunk 1 — Transcript pipeline & rendering** *(the big one)*
- Scope: G-2 (markdown), G-3 (incremental projection + windowing), the
  ChatView side of G-5 (render `runError`/`onRetry` props).
- Files: new `web/src/markdown.ts`; `web/src/chat.ts`; `web/src/runtime.ts`;
  `web/src/components/ChatView.vue`; `web/src/components/ContextMeter.vue`;
  `style.css` (append-only).
- Contracts it must provide: (a) `ToolActivityItem.finishedAt?: number`
  populated from `tool_completed.at`; (b) `ChatView` accepts optional
  `runError: string | null` and `onRetry: () => void` props, rendering an
  error card at the tail when set; (c) an exported `appendProjection`/
  incremental API from `chat.ts`/`runtime.ts` that App.vue (Chunk 2) can call
  — signature fixed up front: `appendEnvelope(env: Envelope): void` and
  `appendRuntimeEvent(ev: RunEvent): void` mutating cached projections, with
  the existing full projection kept for initial load.

**Chunk 2 — App shell, run lifecycle & approvals**
- Scope: G-1 (waiting state end-to-end), G-5 state side (track +
  pass `runError`, wire Retry, keep/replace the retry strip), G-6 (theme
  toggle), G-10 welcome-card buttons, G-18 if cheap (or defer), G-3 consumer
  (call the Chunk-1 append API in `onEnvelope`/`ingestRuntimeEvent`).
- Files: `web/src/App.vue`; `web/src/types.ts` (`'waiting'` in `RunStatus`);
  `web/src/components/ApprovalCard.vue`; `web/src/components/Composer.vue`;
  `web/src/components/UsageFooter.vue`; new `web/src/themeMode.ts`;
  `style.css` (append-only); header theme toggle.
- Depends on Chunk 1 contracts: yes (a, b, c) — sequence Chunk 2 to start
  after Chunk 1's contracts are merged, or stub the three call sites behind
  `typeof` guards. To keep lanes parallel in practice: **land Chunk 1 first**
  (it is the critical path), start Chunk 2 + 3 + 4 the moment it merges.

**Chunk 3 — Tool-call cards & diffs**
- Scope: G-4 (DiffReview collapsed default + chip), G-7 (elapsed/duration,
  run-level tool summary chip, copy-output).
- Files: `web/src/components/ToolActivity.vue`;
  `web/src/components/CommandResult.vue`; `web/src/components/DiffView.vue`;
  `web/src/components/DiffReview.vue`. Consumes contract (a) from Chunk 1.
  No other cross-chunk edits.

**Chunk 4 — Sessions, settings & API client**
- Scope: G-8 (touch-visible actions, composer wrap lives in Composer = Chunk
  2 — do the Sidebar half here; composer half rides with Chunk 2 or a
  2-line follow-up), G-9 (typed client + call-site migration), G-10 (sidebar
  empty-state CTA, group counts).
- Files: `web/src/api.ts`; `web/src/components/Sidebar.vue`;
  `web/src/components/SettingsDialog.vue`;
  `web/src/components/NewSessionDialog.vue`;
  `web/src/components/WorkspaceDialog.vue`;
  `web/src/components/FolderPicker.vue`; `style.css` (append-only).
- Explicitly forbidden for this chunk: touching `App.vue`, `ChatView.vue`,
  `runtime.ts` (owned elsewhere). App.vue's local `listRunsForSession`
  migration to `api.ts` is Chunk 2 follow-up.

### Wave 2 — after Wave 1 merges, parallel again

**Chunk 5 — E2E coverage for everything new**: `e2e/run.mjs` + fixtures —
waiting-banner scenario (extend the scripted approval fixture: assert badge +
activity text while parked), failed-run error-card scenario (scripted server
returns an error mid-run), markdown render assertion (scripted payload with
bold/table/list), theme toggle, mobile-viewport pass (touch actions
reachable), tool-card expand + DiffReview collapsed-default assertions. Keep
existing selectors stable; add new ones rather than renaming.

**Chunk 6 — Keyboard palette** (G-11): new `Palette.vue` + App.vue.
**Chunk 7 — Run history + message search** (G-12, G-13): new `RunHistory.vue`,
ChatView search box.
**Chunk 8 — Polish bundle** (G-14–G-17, G-19): header model chips, composer
recall, animations, approval optimistic flip.

### 4.1 Why this order

- G-1 + G-2 are the two gaps an operator hits in the first real session;
  both are prerequisites for trusting the UI during work-mode runs.
- G-3 must precede/ride with any rendering work so later chunks don't
  re-render hot paths they didn't touch.
- G-4/G-7/G-9 are independent leaf work — maximal parallelism, minimal risk.
- E2E (Chunk 5) last so it asserts the merged behavior once, not moving
  targets.

### 4.2 Cross-chunk contracts (fixed up front)

1. `RuntimeItem`/`ToolActivityItem` gains `finishedAt?: number`
   (Chunk 1 writes, Chunk 3 reads).
2. `ChatView` new optional props `runError?: string | null`,
   `onRetry?: () => void` (Chunk 1 renders, Chunk 2 passes).
3. `chat.ts`/`runtime.ts` export incremental append functions with the exact
   signatures `appendEnvelope(env: Envelope): void` /
   `appendRuntimeEvent(ev: RunEvent): void`; `App.vue` calls them from
   `onEnvelope`/`ingestRuntimeEvent` and keeps the full projection only for
   session load (Chunk 1 implements, Chunk 2 consumes).
4. `api.ts` additions by Chunk 4: `renameSession`, `deleteSession`,
   `listRuns(session?)`, `listPlugins`, `updateSettingsWithPlugins` — other
   chunks must not edit `api.ts`.
5. `style.css`: append-only, banner-commented sections per chunk; no edits to
   existing blocks (token changes, if any, go in a dedicated tokens commit
   owned by Chunk 2 since App.vue mounts `data-theme`).

### 4.3 Verification per chunk

- `cd web && npm run build` must pass every time (hard rule,
  `web/AGENTS.md` rule 2).
- Manual smoke: TS backend + `npm run dev`, one mock `consult` run, one
  scripted-approval `work` run (see `e2e/fixtures/README.md` for the scripted
  server recipe).
- Full gate at the end: `scripts/e2e-test.ps1` (both backends) green.
