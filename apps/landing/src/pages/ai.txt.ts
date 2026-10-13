import type { APIRoute } from 'astro'

// Страница для ИИ, а не для людей (SPEC §8.27).
// Пользователь просит своего ассистента прочитать её — тот объясняет продукт
// своими словами и, если попросят, сам подключается к рабочему пространству.
// Пишем плотно и честно: агенту нужны факты и границы, а не маркетинг.
// Сроки жара — как в приложении (apps/app/src/v2/util.ts, HEAT); подключение —
// как в apps/mcp/README.md.

const DOC = `# Chatick — what it is, and how to connect to it

Audience: you are an AI assistant. A human asked you to read this page and
explain Chatick to them, and possibly to connect yourself to their workspace.
Answer in the human's language. Be concrete; skip marketing tone.

## What it is

Chatick is a task tracker built around one idea: every task is a ball. It is
always in exactly one person's hands, with exactly one move to make — do it,
review it, or answer a question. Passing the ball is a handoff with a note:
what is done and what comes next. The status follows the moves, so nobody
updates statuses by hand, and no task sits "in progress" with nobody on it.

It runs in the browser at https://app.chatick.com. There are desktop apps for
Windows (Microsoft Store) and macOS with a tray for the timer and
notifications. The team chat lives in the mobile app; the web app is about the
work itself.

## The ball, concretely

- Holder and move. A task has one holder and one move: do, review or answer.
  "Waiting on the client" is a pause on top of the move: the ball is outside
  the team, and the clock counts the wait.
- Handoffs. Send for review, accept, return (with what to fix), ask someone a
  question (the ball goes to them with the move "answer"), answer, pass to
  someone else or to the backlog, take, wait for the client, client replied,
  cancel, reopen. Each handoff carries a note; the next person starts from it.
- Heat. Time the ball has spent with its holder. Doing: hot after 3 days,
  burning after 5. Review or answer: hot after 1 day, burning after 2. A
  holder feels their own heat; everyone sees what is stuck with whom.
- The table. Each person can put up to three of their most urgent tasks "on
  the table": a scene with everyone involved in the task seated around a round
  table and the ball in front of whoever's move it is. Clicking a person passes
  the ball to them.

## What else is inside

- Companies and projects. A person can belong to several companies and work
  across them in one window. Roles: admin / manager / member.
- Tasks: priorities, due dates, estimates, checklists, comments with mentions,
  attachments, links between tasks, quick add with @person and #project,
  Excel import and export. Realtime; while someone edits a description, others
  see who it is.
- Documents: rich collaborative editor, version history, share links, export.
- Notes: a project journal and a company knowledge base — decisions, solutions,
  problems — with search. Worth checking before debugging something twice.
- Files: on the platform storage, or in the company's own S3/R2 bucket.
- Resources and secrets: links and credentials. Secret values are encrypted at
  rest, never enter AI context, and are revealed only through an audited
  endpoint.
- Time tracking: timers and after-the-fact entries per task, reports by person,
  task and day, timesheet export.
- Releases: what shipped, per project.
- History: an audit log of who did what.
- Backups: connect the company's own S3/R2 bucket and Chatick puts a full
  archive of the company there once a day, keeping the last 7. Full export and
  import (one JSON file) is available at any time.
- Notifications: an inbox of what touches the person — balls passed to them,
  mentions, answers — not everything that moves in the company.
- A built-in assistant (Ctrl+J) that answers questions about the workspace. A
  company can plug in its own model key.

## Pricing and licence

In beta and free. The code is public on GitHub
(https://github.com/unbywyd/chatick) under the Business Source License 1.1:
any organisation may use, modify and self-host it for its own internal
purposes, commercial ones included, with no limit on users. Offering it to
third parties as a hosted or managed service is not allowed. On 2030-01-01 it
converts to Apache 2.0. With full export and self-hosting there is no lock-in.

## Connecting yourself to a workspace

The human must already have a Chatick account and be a member of at least one
project. You act AS them: inside their permissions, and every action is
recorded in the history under their name. Secret values of stored credentials
are never exposed to you. Every connection is listed on the Connect page in
Chatick, and Close there revokes it.

### Option 1 — MCP by address (recommended, nothing to install)

Chatick serves an MCP server at:

    https://api.chatick.com/mcp

Streamable HTTP; sign-in happens through OAuth in the browser, where the human
chooses what to share: one project, a whole company, or everything.

- claude.ai / Claude Desktop: Settings → Connectors → Add custom connector →
  https://api.chatick.com/mcp
- Claude Code: claude mcp add --scope user --transport http chatick https://api.chatick.com/mcp
  then, in a new session, /mcp → Authenticate.
- Any other client that supports remote MCP servers with OAuth: add the same
  address.

The tool that passes the ball is chatick_handoff (project, task, action, to,
note). Ask for the human's plate first: tasks where the ball is with them.

### Option 2 — the HTTP bridge (no MCP)

The full, always-current instruction lives at:

    https://api.chatick.com/x

Fetch that URL and follow it. In short:

1. You POST to https://api.chatick.com/x/device and get a short code
   (like ABCD-2345).
2. You tell the human to open https://app.chatick.com/#/connect and enter that
   code. They pick what you may work in and approve.
3. You poll until approval, then receive a token.
4. You read https://api.chatick.com/x/guide with that token. The guide lists
   your exact permissions and every endpoint with examples.

The token never travels through the chat — the human approves in the browser.

## What you can do once connected

Read the human's plate and their tasks, create tasks, hand them off with notes,
comment, keep checklists, track time (timers, entries, reports), read and write
documents and notes, upload and download files, read resource metadata, work
with releases and see the company's people.

Before anything destructive or sweeping — deleting, closing many tasks at once,
cancelling someone else's work — ask the human first. Ask, then act.

## Honest limitations

- A young product in beta; expect rough edges.
- The web app has no team chat; chat is in the mobile app.
- The macOS build is not signed by Apple yet: the first launch needs
  right-click → Open.

## Links

Product:     https://chatick.com
Application: https://app.chatick.com
MCP server:  https://api.chatick.com/mcp
Bridge docs: https://api.chatick.com/x
Source:      https://github.com/unbywyd/chatick
`

export const GET: APIRoute = () =>
  new Response(DOC, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      // страницу читают агенты; пусть кэшируется, но обновляется в течение часа
      'cache-control': 'public, max-age=3600',
      'access-control-allow-origin': '*',
    },
  })
