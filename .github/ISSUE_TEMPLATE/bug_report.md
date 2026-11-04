---
name: Bug report
about: Something does not work as documented
title: ""
labels: bug
---

## What happened

<!-- The command, the output, and what went wrong. -->

## What you expected

## Reproduction

<!-- Smallest set of commands that shows the problem. -->

```bash
cd packages/harness
node dist/cli.js run "..." --provider mock
```

## Environment

- `node --version`:
- OS:
- Provider and model (for example `mock`, or an OpenAI-compatible endpoint and
  its model name):
- Surface: CLI / web workspace / plugin / MCP server

## Session log

Sessions are local files (`--session-file <path>`, `sessions/*.jsonl`, runtime
sidecars in `sessions/runtime/`); nothing is uploaded automatically. Paste the
relevant protocol envelopes only, and redact API keys and anything else you
would not publish.