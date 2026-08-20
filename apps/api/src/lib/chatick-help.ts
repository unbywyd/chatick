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

A team chat where the AI is a dispatcher, joined to a project workspace. One
place instead of "tasks over there, talk over here".

Company → projects → people. A project is a group chat plus everything the work
needs: tasks, files, documents, notes, resources, time.

# The two chats

- **Chat** — the group. Everyone sees it. Messages pass through the AI, which
  can translate, answer what was already answered, and turn "I finished X" into
  a task status instead of noise.
- **Assistant** — private, one on one. Nobody else sees it. This is where people
  ask to create things, dig through history, or get something explained.

Switch between them with the two tabs under the message box.

# Tabs of a project

- **Tasks** — the board. Statuses (todo / in progress / review / done),
  assignee, due date, estimate, priority, sprints, checklists, comments,
  dependencies between tasks, links to other tasks.
- **Files** — anything uploaded. Files can be attached to a task.
- **Documents** — collaborative editing, several people at once, with history.
- **Notes** — the project journal: decisions, solutions, things not to repeat.
- **Resources** — accesses and credentials. Secrets are encrypted; a resource
  can be linked to the task that needs it, so passwords never live in a
  description.
- **Releases** — versions and stages.
- **Time** — timers and after-the-fact entries; reports per person and project.
- **Team** — who is here, roles, permission levels per area.
- **History** — what changed and who changed it.

# Company level

Overview with per-project stats, team with job titles, hours across projects,
settings (language, AI, mail, storage, webhooks), backup, and connecting an
external assistant.

# Roles and permissions

Company: admin, manager, member. Project: owner, admin, member. On top of the
role each person has a level per area (tasks, files, resources): none / read /
write. "none" on resources means the person never even sees the card.

# Connecting an assistant

Settings → Connect gives a code to an outside AI (Claude Code and the like)
through MCP. It then works inside the project on the person's behalf — with
their rights, and everything it does appears in the project history under their
name.

# Desktop app

Windows and Mac. A tray panel shows unread, the running timer and your tasks
without opening the window.

# Notifications

Only what concerns you: mentions, assignments, replies, requests. Someone
else's activity does not light up your badge.
`.trim()
