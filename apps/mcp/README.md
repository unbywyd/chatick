# @chatick/mcp

MCP server for Chatick: tasks, comments, checklists, time, resources — as tools
instead of hand-written `curl`.

## Install

```bash
claude mcp add --scope user --transport stdio chatick -- node /path/to/apps/mcp/dist/index.js
```

Then ask Claude what is on your plate in Chatick. The first call runs
`chatick_connect`, which tries the desktop app and falls back to a one-time code.

## Connecting

Two paths, and you do not choose between them — `chatick_connect` tries the
first and quietly takes the second.

**With the desktop app running.** A window comes up naming who is asking and
listing your companies and projects. Pick one, press Allow, and you are
connected — nothing to read out of the chat and type. Deny answers immediately;
the assistant is told no rather than waiting out a timeout.

**Without it.** The usual device flow: the assistant shows a code, you open the
link and approve it there. Nothing about this path changed, and it stays the
path for anyone who has no desktop app or cannot install one.

What the window is actually approving is a code the server already issued to
the assistant. The token itself is never handed over the local port — the
assistant collects it from the server, exactly as in the code flow. So the
desktop path adds no second way to obtain access, only a shorter way to consent
to the existing one.

## How much you open

Three choices, and they are yours — the assistant asks for a code, never for a
scope. It cannot widen what you granted.

| Choice | What the assistant sees |
|---|---|
| **One project** | that project only |
| **A whole company** | every project in it you are a member of |
| **All my projects** | every company and project you belong to, including ones you join later |

The last one is the master scope, offered as a separate switch rather than
another row in the list: it is a different kind of decision, and it covers
companies that do not exist yet.

None of them grants anything beyond your own access. Every call still checks
your membership and permissions in that particular project, so an assistant on
a master tunnel can do exactly what you can do, and nothing more.

Open tunnels are listed in the app under a company's **Connect** tab and in the
tray panel, with the scope written next to each. Close any of them there.

### When the window does not appear

The app writes `~/.chatick/desktop-port.json` when it starts; the server reads
it. No file means no desktop path, and the assistant falls back to a code
without stalling.

- **App not running, or was killed.** Start it. A crash can leave a stale file
  behind, so a fallback to the code flow after a crash is expected, not a bug.
- **Port 17325 taken.** Not a problem: the app takes any free port and records
  it in that file. Measured with 17325 deliberately occupied — the app came up
  on 50708 and the connection worked.
- **A popup you did not ask for.** Deny it. The file holds a shared secret, and
  on Windows file permissions do not restrict reading it — verified: `chmod 600`
  leaves the file at `666`. Anything on your machine can therefore make that
  window appear. It cannot do more than that: issuing a token needs your logged
  in session and your project membership, checked server-side, and it happens
  only when you press the button. An unexpected window is worth a second look,
  not alarm.

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
