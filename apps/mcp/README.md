# @chatick/mcp

MCP server for Chatick: tasks, comments, checklists, time, resources — as tools
instead of hand-written `curl`.

## Install

```bash
claude mcp add --scope user --transport stdio chatick -- node /path/to/apps/mcp/dist/index.js
```

Then ask Claude what is on your plate in Chatick. The first call runs
`chatick_connect`, which tries the desktop app and falls back to a one-time code.

## Why it exists next to the skill

The skill teaches **how to conduct work**; this teaches **what to call**. Two
things it does that a curl recipe cannot:

- **The token lives here.** No code to type each session — and where the desktop
  app is running, none at all.
- **Rules become code.** "Estimate is required", "a resource is shared with
  nobody by default", "`?project=` on a company token" stop being text somebody
  has to read.

## Staying in step with the bridge

Paths live in `src/bridge.ts` alone; tools name an endpoint rather than build a
URL. `apps/api/scripts/check-mcp-sync.mjs` runs on every API build and fails it
when this server calls something the bridge does not have.

That check exists because during one working day the guide fell behind the code
twice, both times silently. A third copy of the truth on someone else's machine
would be worse: the tool calls a route that no longer exists, and the person
gets a 404 instead of work.
