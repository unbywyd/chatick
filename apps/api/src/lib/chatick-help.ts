/**
 * Справка о самом Chatick — для ассистента.
 *
 * Живёт отдельно и отдаётся ИНСТРУМЕНТОМ, а не системным промптом. Промпт
 * уходит с каждым сообщением: положить туда описание продукта значит платить
 * за него в каждом разговоре о задачах, где оно ни разу не понадобится.
 * Спрашивают «а как в Chatick сделать X» несколько раз в день, а не в каждой
 * реплике.
 *
 * Пишем о том, что человек ВИДИТ и делает, а не о том, как устроено внутри:
 * спрашивающему нужен ответ «где нажать», а не архитектура.
 */
export const CHATICK_HELP = `
# Chatick — what it is

Every task is always in someone's hands, and everyone can see whose. Chatick is
where a team keeps its tasks, documents, files and hours — one screen per
company, projects are a filter on it.

Company → projects → people.

# Where things are (web and desktop)

- **Tasks** — the main screen. Three tabs: On me (the ball is mine), From me
  (I own it, someone else has the ball), All (everything I can see). Each task
  has a move: do, review or answer. Moves pass the ball: "send for review",
  "return", "ask", "answer", "pass" — with a short note the next person reads
  first. The line at the top creates a task in one go: "what to do @who
  #project !tomorrow". Right-click a task for quick actions; select several to
  hand off, set a due date or delete them at once; export or import Excel.
- **Documents** — collaborative editing, several people at once, with version
  history and restore.
- **Notes** — the company journal: decisions, solutions, things not to repeat.
- **Files** — everything uploaded to tasks or directly, with preview.
- **Resources** — links and accesses. Secrets are encrypted and visible only to
  the people chosen for them.
- **Versions** — app builds and their stages.
- **Time** — "Hours": your timer and entries, and for managers hours by people
  and by projects, with Excel export. A person has one timer at a time.
- **Team** — who does what: open tasks on each person, what waits for their
  review or answer, what is overdue, who is working right now.
- **History** — what changed and who changed it.

# The chats

- **Team chat** lives in the Chatick mobile app; the web has no chat.
- **Assistant** — private, one on one, the panel on the right (Ctrl+J). Nobody
  else sees it. Ask it to create or hand off tasks, find something, open a
  document or file on the screen, draft a task for you to confirm.

# Company level

Company menu → Manage company: projects and their teams, people and roles,
access, archive. Settings (admin): company name and language, time tracking,
the company AI key and AI for new tasks, backup, storage and mail, external
system, API keys, webhooks, deleting the company. A new company starts with two
steps: first project (with its language) and inviting people.

# Roles and permissions

Company: admin, manager, member. In a project a person may lead it; on top of
that each person has a level per area (tasks, documents, files, resources,
versions): none / view / edit / edit and delete.

# Connecting an outside assistant

Settings → AI connections gives the MCP address for Claude and other assistants
and lets you enter a connection code. The assistant then works with the
person's rights, and everything it does appears in history under their name.

# Desktop app

Windows and Mac. The tray panel opens on Notifications (grouped by project),
the second tab is what is on you, plus the running timer.

# Notifications

Only what concerns you: mentions, hand-offs, replies, requests. Someone else's
activity does not light up your badge.
`.trim()
