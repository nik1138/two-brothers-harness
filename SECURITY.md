# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| `0.0.x` | Yes — current release line |
| older | No |

Fixes land on the current `0.0.x` line; there are no maintenance branches
for earlier versions.

## Reporting a vulnerability

**Please don't open public issues for vulnerabilities.** A public report
exposes every deployment until a fix ships.

- **Preferred:** GitHub private vulnerability reporting — open the repository's
  **Security** tab and choose **Report a vulnerability**. This channel has to
  be enabled by the maintainer in **Settings → Security → Private vulnerability
  reporting**; if the form is missing, use email instead.
- **Email fallback:** `nik1138@mail.ru` (the address in [`LICENSE`](LICENSE)).

Please include the affected version or commit, the command or HTTP call that
triggers the issue, and the smallest reproduction you have. We aim to
acknowledge a report within 48 hours.

There is no bug bounty.

## Scope

Two Brothers runs locally: the CLI is a process you start, and the web
workspace (`node dist/cli.js serve`) is a single-user server with no
authentication of its own. Exposing either to an untrusted network is outside
the intended deployment, so a report that depends on doing so will be treated
as expected behavior. In scope: protocol/payload handling, session files,
provider and MCP client code, workspace tool confinement and approvals,
plugin loading, and secret storage.

## Deployment expectations

- **Loopback only.** `serve` binds `127.0.0.1` by default (`--host` changes
  this) and is designed for a single operator on one machine. There is no
  authentication, authorization, or transport encryption — do not expose it
  to a network interface you do not fully trust. If you must reach it from
  another machine, put your own authenticated, TLS-terminating proxy in
  front; the server itself will not protect you.
- **API keys on the command line leak.** `--api-key <key>` (and the manual
  `--senior-api-key`/`--junior-api-key` forms) land in shell history and in
  process listings while the run is alive. Prefer the environment variables
  (`TWO_BROTHERS_API_KEY`, `TWO_BROTHERS_SENIOR_API_KEY`,
  `TWO_BROTHERS_JUNIOR_API_KEY`) or, for `models`/`onboard`, the
  `--api-key-env <VAR>` form that reads the key from a named variable. In the
  web workspace, enter keys in Settings instead: they are sealed at rest and
  never returned by the API.
- **Session files are plaintext transcripts.** Everything the brothers said,
  including quoted secrets from the task or tool output, ends up in the JSONL
  session files and runtime sidecars under `--sessions-dir`. Treat that
  directory as sensitive and do not publish or share it.
