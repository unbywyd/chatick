import type { APIRoute } from 'astro'

// Страница для ИИ, а не для людей (SPEC §8.27).
// Пользователь просит своего ассистента прочитать её — тот объясняет продукт
// своими словами и, если попросят, сам подключается к рабочему пространству.
// Пишем плотно и честно: агенту нужны факты и границы, а не маркетинг.

const DOC = `# Chatick — what it is, and how to connect to it

Audience: you are an AI assistant. A human asked you to read this page and
explain Chatick to them, and possibly to connect yourself to their workspace.
Answer in the human's language. Be concrete; skip marketing tone.

## What it is

Chatick is a team workspace built for developers — for teams where an AI
assistant does part of the work. One project = one group = one chat, plus what
a project needs: tasks, documents, files, notes, time tracking and credentials.
It runs in the browser at https://app.chatick.com (desktop apps for
Windows/macOS are planned).

Two things make it different from a tracker with a chatbot in it:

1. YOU can be connected to it. Not as an integration someone writes, but as a
   participant: through the bridge you read and run tasks, break them into
   checklists, answer in the chat, upload files, write documents and notes,
   track time — acting as the human who approved you, inside their permissions,
   logged under their name. See "Connecting" below.
2. The history is built to be read by an assistant. The chat is compressed into
   per-day summaries you can search; find the right period and pull up the exact
   original messages. Raw messages are never deleted — summaries sit on top of
   the full history. The project activity log is open to you too: who changed
   what, when something was deleted, what happened while the human was away.

Separately, an AI dispatcher sits between people and the chat. Messages pass
through it before reaching the team, so it can translate, answer questions
already answered somewhere in the project, and turn status updates into task
changes instead of chat noise.

## What is inside a project

- Chat with the AI dispatcher. Per-project rules and behaviour. Each company
  can plug in its own model key (Anthropic, OpenAI, Google, DeepSeek, Groq) or
  use the platform's. Token spend is logged and visible per project.
- Tasks: statuses (todo / in progress / review / done), priorities, sprints,
  time estimates, assignees, comments, attachments, drag & drop ordering,
  Excel import/export, right-click quick actions. Updates are realtime.
  While one person edits a task, others see who is editing it.
- Documents: rich editor (headings, tables, images, code, checklists),
  real-time collaborative editing with visible cursors, version history with
  rollback, public share links, export to Word/HTML.
- Files: uploaded from chat, tasks, comments or the clipboard. Images are
  optimised automatically. A project can use the platform storage (quota) or
  its own S3/R2 bucket (no quota).
- Resources & secrets: links and credentials. Secret values are encrypted at
  rest, never enter AI context, and are revealed only through an audited
  endpoint.
- Notes: a project journal of decisions, solutions, problems, contradictions
  and reminders, with tags and search. A note can quote the chat messages it
  came from and can be turned into a task. Marked company-wide, a solution is
  findable from other projects — worth checking before debugging something
  twice.
- Time tracking: timers and after-the-fact entries, one task per entry,
  reports by person, task and day, with export. Available through the bridge.
- History: an audit log of who did what, searchable and retained. Deleted
  tasks, files, documents and resources are recoverable for 7 days.
- Backups: the database is backed up on a schedule and the copies are
  encrypted; a company can also export everything itself at any time.
- Several companies and projects at once: a person can belong to many, and
  works across them in one window. A bridge connection can be scoped to one
  project, one company, or everything the person can reach.
- Notifications: one global bell across all projects, grouped per project.
  Email is sent once a day as a digest — never one message per event.
- Roles and permissions: company roles (admin / manager / member) and
  per-project permission levels per domain (tasks, files, resources,
  documents): none / read / write / crud.

## Pricing and status

Open source with full export and import: a company can self-host the system at any time, so there is no lock-in. Currently in beta and free. There is a trial AI budget per project; a company
can avoid platform AI costs entirely by connecting its own model key.

## Connecting yourself to a workspace

You can operate inside a user's project on their behalf. Read this before
offering it: the human must already have a Chatick account and be a member of
at least one project.

The full, always-current instruction lives at:

    https://api.chatick.com/x

Fetch that URL and follow it. Summary of how it works, so you can explain it:

1. You POST to https://api.chatick.com/x/device and get a short code
   (like ABCD-2345).
2. You tell the human to open https://app.chatick.com/#/connect and enter that
   code. They pick which project you may work in and approve.
3. You poll until approval, then receive a token.
4. You read https://api.chatick.com/x/guide with that token. The guide lists
   your exact permissions in that project and every endpoint with examples.

Security properties worth stating plainly to the human:

- The token never travels through the chat — they approve it in the browser.
- You act AS them, limited to their permissions. You cannot do anything they
  could not do themselves.
- Every action you take is recorded in the project history under their name.
- There are no permanent tokens. A connection is a tunnel: it dies when closed,
  after 12 hours, or after 2 hours of inactivity.
- Secret values of stored credentials are never exposed through the bridge.

## What you can do once connected

Read and create tasks (including "my tasks"), change statuses, comment, manage
sprints, read and write documents (long ones are read in chunks), upload and
download files, post to the project chat, and read resource metadata.

Destructive actions — deleting anything, bulk status changes — should be
confirmed with the human first. Ask, then act.

## Honest limitations

- It is a young product in beta; expect rough edges.
- Desktop apps are not shipped yet — browser only for now.
- The bridge is HTTP, not an MCP server. You call it with plain HTTP requests.
- Mobile apps do not exist.

## Links

Product:     https://chatick.com
Application: https://app.chatick.com
Bridge docs: https://api.chatick.com/x
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
