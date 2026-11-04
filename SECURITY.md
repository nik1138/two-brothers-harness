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