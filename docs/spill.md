# Tool-output spill

Long tool results are hard to keep inline: the model context is bounded, and a
hard clip throws away the rest. Spill stores the full plain-text result on disk
and gives the model a bounded preview plus a retrieval handle.

## What the model sees

A result at or under the inline budget is returned unchanged, byte for byte. A
larger result is replaced by a head+tail preview, one marker, and one
instruction line:

```text
<head of the result>
<tail of the result>

[[SPILL id=0123456789abcdef0123456789abcdef chars=48000]]
Full output saved; read it in chunks with spill_read {"id":"0123456789abcdef0123456789abcdef","offset":0,"max_chars":16384}.
```

The marker carries no filesystem path and no secret. The model reads the rest
with the built-in `spill_read` tool:

```json
{"id": "0123456789abcdef0123456789abcdef", "offset": 16384, "max_chars": 16384}
```

`offset` and `max_chars` are character counts. One call returns at most 16 KiB;
the result includes the total length and the next offset so the model can
continue. A complete read (offset 0, end of file) is the artifact text alone.
`spill_read` is part of both role belts whenever spill is configured; a run
without spill keeps its previous tool belt and prompt bytes.

If spill storage fails (permissions, disk full, an unwritable root), the run
does not fail. The result falls back to the existing
`...[truncated N chars]...` clipping and `HarnessResult.warnings` records one
`tool output spill failed ...` line.

## Where files live

| Surface | Spill root |
|---|---|
| `serve` | `<sessionsDir>/spill` |
| CLI `run` / `chat` with a session file | `<session-file directory>/spill` |
| CLI without `--session-file` | no spill; current clipping applies |
| `tui` | `<sessionsDir>/spill` |
| Embedded harness | `HarnessOptions.spill.root` |

Spill is configured through `HarnessOptions.spill`:

```ts
new TwoBrothersHarness(cfg, {
  spill: { root: "/path/to/spill", maxInlineChars: 20_000, maxReadChars: 16_384 },
});
```

`maxInlineChars` defaults to 20,000. `maxReadChars` defaults to 16 KiB and is
hard-capped at 16 KiB regardless of configuration.

## Storage and retention

One spill is one file, `<root>/<id>.txt`, where `id` is 16 random bytes rendered
as lowercase hex. Writes go to a temp file, are fsynced best-effort, and are
renamed into place. Ids are validated against `[a-f0-9]{16,64}` before a path is
resolved, so a model can never turn an id into a traversal or an arbitrary read.
The files are local trusted data (tool output); the directory is created with
owner-only permissions where the platform honors them.

The root must be either missing (it is created lazily by the first save) or an
existing **real directory**. A symlink or junction at `<root>` is refused at
every entry point: `stats`/`prune` throw and `save`/`read` reject with
`SpillRootUnsafeError` before they scan or write. A plain file at `<root>` is
refused the same way. The check is identity-at-entry, not a kernel-handle
guarantee: a same-user process that replaces the root mid-pass is outside the
threat model.

Retention is **opt-in**; nothing is deleted automatically by default.

### Inspect: `spill stats`

```powershell
two-brothers spill stats [--sessions-dir <dir>] [--json]
```

`stats` is read-only and reports the number of valid artifacts and their total
size. It scans only regular files whose names are exactly `<valid-id>.txt`:
symlinks below the root are never followed, directories, `.tmp-*` writes and
malformed ids are ignored, and a missing root is an empty store (`0` files, `0`
bytes) rather than an error. An existing root that is a symlink/junction or not
a real directory is rejected (exit 1), as are gc-only flags (`--older-than`,
`--dry-run`, `--force`), which are a usage error (exit 2).

### Prune: `spill gc`

```powershell
two-brothers spill gc [--sessions-dir <dir>] --older-than <n>m|h|d [--dry-run] [--json] [--force]
```

`--older-than` is required and uses the strict `<positive-integer><unit>` form:
`m` minutes, `h` hours, `d` days (for example `30m`, `24h`, `7d`). There is no
default age, so a bare `spill gc` is a usage error (exit 2) and can never delete
everything by accident. A file is removed only when its mtime is **strictly
older** than `now - older-than`; a file exactly at the boundary is kept.

`--dry-run` reports the same `removed`/`kept`/`bytes` counts without deleting
anything. `gc` takes the sessions-store single-writer lock
(`<sessions-dir>/.writer.json`) and refuses while `serve` or the TUI holds it;
stop the writer first, or pass `--force` to bypass the lock (unsafe while a
writer is live). A missing sessions directory is an empty store: nothing is
created and the command exits 0.

Only these entries can ever be deleted:

- regular files directly under `<root>` whose name is `<id>.txt` with
  `id` matching `[a-f0-9]{16,64}` (lowercase hex);
- stale regular `.tmp-<id>` save files (the same valid id shape) whose mtime is
  strictly older than the cutoff. They are reported separately as
  `temps_removed`/`temp_bytes` and never counted as artifacts.

Everything else is never touched: symlinks (they are `lstat`ed, never followed),
directories, malformed/uppercase ids, temp names outside the exact
`.tmp-<id>` shape, paths resolved outside the configured root, and other spill
roots. An unlink failure is counted and reported as a warning; it does not
abort the rest of the pass. The root is re-checked when the store is entered,
but a same-user swap of `<root>` during an in-flight pass is outside this
guarantee.

### Server startup prune

```powershell
two-brothers serve --spill-retention-days <n>
```

When set to a positive number of days, `serve` prunes valid files under
`<sessions-dir>/spill` older than `n` days once after the server successfully
binds (it already holds the writer lock; the pass runs in the `listen()`
success callback). A failed bind therefore deletes nothing. The default is off:
without the flag no automatic deletion ever happens. A prune failure only logs
one skip line (plus one line per failed unlink) and never fails startup, and a
missing spill root is an empty store. The count (removed/kept/bytes, plus stale
temp files) is logged honestly. A second server that cannot take the writer
lock never reaches the retention pass.

Only `serve`, the TUI, `sessions migrate` and `spill gc` participate in the
single-writer lock; `run` and `chat` do not take it, so stop them before
migrating or pruning (they may still be writing their own session files).

Removing the directory is always safe; a later `spill_read` for a deleted id
returns a normal tool-error string.


## MCP results

MCP adapters normally clip their text to 20 KiB with
`...[truncated N chars]...`. When a run has spill enabled, `loadMcpTools` is
called with `deferOutputBounds: true`: it hands the sanitized full text to the
harness, which spills above the same inline budget. Without spill, the 20 KiB
MCP clip is unchanged.

## Limits

- Only text results spill. Tools that impose their own hard cap before returning
  (for example the workspace `read_file` default and the streaming shell
  runner) still cut the text at that cap; spill can only preserve what the tool
  returned.
- Spill is per run: the marker is delivered in the live tool conversation, not
  in protocol envelopes or the session JSONL, so a resumed session does not
  advertise old spill ids.
- Cleanup is operator-driven: `spill gc` by age, or the opt-in
  `serve --spill-retention-days <n>` startup pass. There is no per-session
  deletion and no deletion while a writer runs unless `spill gc --force` is
  passed.
