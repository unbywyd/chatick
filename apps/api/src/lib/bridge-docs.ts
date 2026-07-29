import type { BridgeIdentity } from './bridge-auth.js'
import { expandPermissions } from '../routes/projects.js'

// Самоописываемая инструкция для внешнего ИИ (SPEC §8.27).
// Читатель — не человек, а Claude Code: пишем плотно, по делу, с готовыми
// примерами curl. Никаких маркетинговых вступлений.

const base = () => (process.env.API_PUBLIC_URL || 'https://api.chatick.com').replace(/\/$/, '')

/**
 * Каталог ручек — ОДИН на оба гайда.
 *
 * Раньше проектное и компанейское подключения имели каждое свой список, и
 * фича, добавленная в один, для половины подключений просто не существовала —
 * молча. Так и вышло с чек-листом: ассистент читал компанейский гайд, раздела
 * не находил и делал вывод, что фичи нет.
 *
 * Поэтому список здесь один, а различие сведено к одному параметру: у
 * компанейского туннеля к пути дописывается ?project=<id>. Забыть обновить
 * второй документ теперь нельзя — второго документа нет.
 *
 * @param q суффикс проекта: '' для проектного туннеля, '?project=<id>' для компанейского
 */
function endpointCatalog(q: string): string {
  // Первый параметр в строке запроса: у компанейского уже занят ?project=
  const amp = q ? '&' : '?'
  return `  GET    /x/tasks${q}${amp}assignee=me&status=todo&q=text&sprint=<sprintId>&limit=50
         status: todo | in_progress | review | done
  GET    /x/tasks/<id>${q}
  POST   /x/tasks${q}              {"title","description?","assignee?","status?","priority?","dueDate?","estimateMinutes?","sprintId?"}
  PATCH  /x/tasks/<id>${q}         any subset of the same fields
  DELETE /x/tasks/<id>${q}

  Unknown fields in a body are rejected with 400 naming the field — a request
  that returns 2xx did exactly what you asked, so there is no need to re-read
  the object afterwards to check.

  GET    /x/activity${q}${amp}entityType=task&action=delete&actor=me&q=text&from=&to=&limit=50
         Project history: who changed what and when. Read-only.
         entityType: task | file | document | note | resource | member | project
         Use it before asking the human "what happened here" — and to find
         things that no longer exist: a deleted file still has its entry.

  GET    /x/tasks/<id>/checklist${q}          items, done/total
  POST   /x/tasks/<id>/checklist${q}          {"items":["...","..."]} or {"text":"...","note":"..."}
  PATCH  /x/tasks/<id>/checklist/<itemId>${q} {"done"?, "note"?, "text"?}

  A checklist is the task broken into steps, or questions waiting for an
  answer. Send several at once via items. The note under an item is optional —
  most items are just things to do. Ticking is manual and reversible: answering
  and considering it done are separate decisions, and nothing happens
  automatically when all are ticked.

  A checklist is NOT a field of the task: create the task first, then POST its
  items to the sub-resource above. Sending "checklist" inside POST /x/tasks is
  rejected with 400.

  GET    /x/tasks/<id>/comments${q}
  POST   /x/tasks/<id>/comments${q}   {"text"}
  GET    /x/sprints${q}
  POST   /x/sprints${q}            {"name","startsAt?","endsAt?"}

  Changing only the status (plus sprint or ordering) needs tasks.changeStatus,
  which every member has — moving a card across the board is not the same as
  rewriting the task. Touching anything else needs tasks.edit.

  assignee accepts "me", a user id, a name or an email.
  dueDate accepts ISO date or "tomorrow", "in 3 days", "next monday".

  POST   /x/shares/<type>/<id>${q}    publish a link; type: file | note | resource | message | task
  DELETE /x/shares/<type>/<id>${q}    revoke it

  Publishing puts the thing on the public internet, so only project owners and
  admins can do it (403 otherwise) — and ask the human first even when allowed.
  The response carries both links: one for the team, one public.`
}

/** Инструкция для НЕавторизованного: как подключиться. Отдаётся по голой ссылке. */
export function connectDoc(): string {
  const b = base()
  return `# Chatick — bridge for AI assistants

You are reading the connection guide for Chatick (team chat + project workspace:
tasks, files, documents, resources).

You are NOT connected yet. Connect first, then re-read the authenticated guide.

## How to connect (device flow — no secrets in chat history)

1. Request a code:

   curl -s -X POST ${b}/x/device -H 'content-type: application/json' \\
     -d '{"client":"Claude Code"}'

   Response: { "userCode": "ABCD-2345", "deviceCode": "...", "verifyUrl": "...", "expiresInSec": 600 }

2. Tell the human, verbatim:
   "Open ${'{verifyUrl}'} and enter the code {userCode} to grant me access."
   Do NOT print deviceCode to the human — it is your secret.

3. Poll every 3 seconds until status changes (max ~10 min):

   curl -s -X POST ${b}/x/device/poll -H 'content-type: application/json' \\
     -d '{"deviceCode":"<deviceCode>"}'

   -> {"status":"pending"}   keep polling
   -> {"status":"denied"}    the human refused — stop and tell them
   -> {"status":"expired"}   start over from step 1
   -> {"status":"approved","token":"ck_...","user":{...},"project":{...}}

4. Keep the token in memory for this session only. Never write it to a file,
   never echo it back to the human, never commit it.

5. Read the authenticated guide — it lists every endpoint and your exact
   permissions:

   curl -s ${b}/x/guide -H 'authorization: Bearer <token>'

## Notes

- The token dies when the tunnel is closed, after 12h, or after 2h idle.
  If a call returns 401, the tunnel is closed: start over from step 1.
- Everything you do happens AS THE HUMAN who approved the code, limited to
  their permissions, and is recorded in the project history under their name.
`
}

/** Полная инструкция для авторизованного ИИ: кто он, что может, как звать API. */
export function guideDoc(id: BridgeIdentity): string {
  const b = base()
  // Туннель на всю компанию: конкретный проект выбирается в каждом запросе,
  // поэтому и права перечислить заранее нельзя — они свои в каждом проекте.
  if (!id.projectId || !id.project || !id.permissions) return companyGuideDoc(id)
  const permissions = id.permissions
  const project = id.project
  const perms = expandPermissions(permissions)
  const can = (p: keyof typeof perms) => (perms[p] ? 'YES' : 'NO')

  // Явно перечисляем запреты: агенту дешевле прочитать, чем ловить 403
  const denied = Object.entries(perms)
    .filter(([, allowed]) => !allowed)
    .map(([action]) => action)

  return `# Chatick — connected as ${id.user.name || id.user.email}

Project: ${project.name} (id: ${id.projectId})
Acting as: ${id.user.name || id.user.email} <${id.user.email}> (id: ${id.userId})

Every call below acts as this person, respects their permissions, and is
recorded in the project history under their name. Authenticate each request:

    -H 'authorization: Bearer <token>'

Base URL: ${b}/x

## Your permissions in this project

  tasks: ${permissions.tasks}   files: ${permissions.files}   resources: ${permissions.resources}
  documents: ${permissions.documents}   notes: ${permissions.notes}

  create/edit tasks .... ${can('tasks.create')} / ${can('tasks.edit')}
  delete tasks ......... ${can('tasks.delete')}
  upload/delete files .. ${can('files.upload')} / ${can('files.delete')}
  write/delete docs .... ${can('documents.write')} / ${can('documents.delete')}
  write/delete notes ... ${can('notes.write')} / ${can('notes.delete')}
  manage resources ..... ${can('resources.manage')}
${denied.length ? `\n  NOT ALLOWED: ${denied.join(', ')}\n  Do not attempt these — they return 403.` : ''}

## Rules

- "me" means ${id.user.name || id.user.email} <${id.user.email}> — the account this
  tunnel was opened under, not whoever is talking to you. If a person has two
  accounts, "assign it to me" may not mean the account you are acting as: say
  which one you used.
- Deletions are soft and reversible for 7 days (the response says
  restorableForDays). Worth knowing before asking for confirmation on every
  small thing — but ask anyway when the deletion is not obviously wanted.
- Destructive actions (delete, bulk status changes) need explicit human
  confirmation first. Ask, then act.
- Write content in the project's language, not the language of the request.
- NON-ASCII BODIES: never put non-ASCII text (Cyrillic, Hebrew, emoji, typographic
  dashes) inline in \`curl -d '...'\` — on Windows the shell re-encodes the argument
  and the server receives corrupted bytes. The ASCII part survives, which hides the
  problem. Write the body to a file and send it with --data-binary:

    cat > /tmp/body.json <<'JSON'
    {"text":"Тестовое сообщение"}
    JSON
    curl -sS -X POST ${b}/x/messages -H "authorization: Bearer $TOKEN" \\
      -H 'content-type: application/json; charset=utf-8' --data-binary @/tmp/body.json

  Applies to every endpoint with a body: messages, tasks, documents, comments.
  Corrupted text CANNOT be fixed through this bridge — there is no edit/delete for
  chat messages — so verify before sending, not after.
- On 401 the tunnel is closed — re-run the device flow (GET ${b}/x).

## What concerns me — start here

  GET  /x/inbox?unread=1&limit=30    everything addressed to this person
  POST /x/inbox/read                 {"ids":["..."]} or {"all":true}

Each item carries \`whatIsAsked\` — one sentence written by our AI describing what
the reader is actually expected to do ("Send the latest APK build"), plus
\`entityType\`/\`entityId\` pointing at the thing it is about:

  entityType="message" -> GET /x/messages/<entityId>/context   read the conversation
                          around it, then answer with POST /x/messages
                          {"text":"...","replyToId":"<entityId>","attachmentIds":[...]}
  entityType="task"    -> GET /x/tasks/<entityId>

Mark items read once handled, otherwise you will see them again.

Example — handle everything waiting for me:

    curl -s '${b}/x/inbox' -H 'authorization: Bearer <token>'
    curl -s '${b}/x/messages/<messageId>/context' -H 'authorization: Bearer <token>'
    # upload the file the person asked for, then answer in that thread
    curl -s -X POST ${b}/x/files -H 'authorization: Bearer <token>' -F 'file=@./app.apk'
    curl -s -X POST ${b}/x/messages -H 'authorization: Bearer <token>' \
      -H 'content-type: application/json' \
      -d '{"text":"Here is the latest build","replyToId":"<messageId>","attachmentIds":["<fileId>"]}'

## Tasks

${endpointCatalog('')}

  Example — what is on my plate:
    curl -s '${b}/x/tasks?assignee=me&status=todo' -H 'authorization: Bearer <token>'

  Example — create a task and assign it:
    curl -s -X POST ${b}/x/tasks -H 'authorization: Bearer <token>' \\
      -H 'content-type: application/json' \\
      -d '{"title":"Fix login redirect","assignee":"me","priority":"high","estimateMinutes":60}'

## Files

  GET    /x/files?type=image&q=name&taskId=<id>&limit=50
  GET    /x/files/<id>/content        -> raw bytes (redirects to storage)
  POST   /x/files                     multipart: file=@path, taskId=<id> (optional)
  DELETE /x/files/<id>

  Example — attach a file to a task:
    curl -s -X POST ${b}/x/files -H 'authorization: Bearer <token>' \\
      -F 'file=@./report.pdf' -F 'taskId=<taskId>'

  Reading attachments. Tasks, task comments and chat messages carry an
  "attachments" array with id, name, mime, size and contentUrl. You do not
  need to search /x/files to find what belongs to a task — it arrives with
  the task itself:

    curl -s ${b}/x/tasks/<id> -H 'authorization: Bearer <token>'
    -> { ..., "attachments": [{ "id": "...", "name": "mockup.png",
                                "mime": "image/png", "size": 84213,
                                "contentUrl": "${b}/x/files/<id>/content" }] }

  Fetch the bytes with the same token — images, PDFs, anything:
    curl -s <contentUrl> -H 'authorization: Bearer <token>' -o mockup.png

  Inline images. Tasks, documents, notes, comments and chat messages can all
  carry images embedded in their text as <img src=".../files/inline/<id>">.
  Every one of them reports those images in "attachments" as well, so reading
  that field is enough — no HTML parsing needed anywhere.

  Those URLs also accept your bridge token, if you would rather follow them:

    curl -s '<src from the html>' -H 'authorization: Bearer <token>' -o shot.webp

  The same image also appears in the task's "attachments", so in practice you
  rarely need to parse the HTML at all.

  Save with the right extension. Every file — in "attachments" and in
  GET /x/files alike — carries "ext". Write it as <name><ext> and nothing else:
  "ext" is empty when the name already ends with it, so the concatenation is
  always safe and never produces "shot.webp.webp".

  This matters: saved under a name with no extension, an image is easily
  mistaken for text and read back as a screenful of binary noise.

## Documents

  GET    /x/documents?q=text
  GET    /x/documents/<id>?format=text|html&offset=0&limit=4000
         Long documents are read in chunks; the response says whether more remains.
  POST   /x/documents          {"title","content"}   content is HTML
  PATCH  /x/documents/<id>     {"title?","content?"}
  POST   /x/documents/<id>/append  {"content"}       safe for long docs
  DELETE /x/documents/<id>

## Time tracking

You know when work started and stopped — so record it, instead of the human
poking at timers.

  GET  /x/time/running          what is running now + the project's timer limit
  POST /x/time/start            {"task?":"TASK-12","description?":"...","startedAt?":"<ISO>"}
  POST /x/time/stop             {"id?":"<entryId>"}  — id needed only if several run
  POST /x/time                  {"startedAt","endedAt","task?","description?"} — after the fact
  GET  /x/time/report?from=YYYY-MM-DD&to=YYYY-MM-DD

  ONE entry links to at most ONE task. Two things at once means two timers —
  the project caps how many may run (1 unless changed).
  Everything is optional: a bare start with no task and no description is the
  normal case.
  In /x/time, an end earlier than the start is read as the next day.

Example — a working session:

    curl -sS -X POST ${b}/x/time/start -H "authorization: Bearer $TOKEN" \\
      -H 'content-type: application/json' -d '{"task":"TASK-12","description":"login redirect"}'
    # ... work ...
    curl -sS -X POST ${b}/x/time/stop -H "authorization: Bearer $TOKEN" \\
      -H 'content-type: application/json' -d '{}'

## Notes — the project journal

A note is a deliberate record: a solved problem, a decision, a contradiction, a
reminder. Notes are created ON REQUEST, never automatically. When the person
says "save this", "remember how we fixed it", "log that this contradicts what
was said earlier" — that is a note.

  GET    /x/notes?q=text&type=solution&tag=dns&scope=company&limit=50
  GET    /x/notes/<id>              full body + the quoted sources
  POST   /x/notes                   {"type","title","body","tags":[],"scope","sourceMessageIds":[],"mentionedIds":[],"remindAt"}
  PATCH  /x/notes/<id>              same fields; sourceMessageIds APPENDS quotes
  DELETE /x/notes/<id>
  POST   /x/notes/<id>/task         turn the note into a task
         {"title?","assigneeId?","priority?","dueDate?"} — all optional.
         The note SURVIVES and keeps a link to the task: it explains why the
         task exists and carries the quotes it grew from. Calling it twice
         returns the same task instead of creating a duplicate.

  type:  solution     a problem and how it was solved — the reusable kind
         problem      a known issue with no fix yet
         decision     what was agreed and why
         contradiction  people said conflicting things
         mismatch     the build does not match the design or the docs — there
                      IS a source of truth and something deviates from it
         gap          the design/spec itself is missing a case — nothing to
                      deviate from yet, someone has to decide
         reminder     something to resurface later (set remindAt)
         business     business-logic rule worth writing down
         note         anything else

  scope: "project" (default) or "company". Use "company" for technical
         solutions — they are then findable from every project of this company,
         which is the whole point: hit the same DNS error in another project,
         search once, find the fix. Keep internal disputes and business rules
         at "project".

### Saving a solution (from the editor, no chat involved)

    cat > /tmp/note.json <<'JSON'
    {"type":"solution","scope":"company","title":"DNS resolution fails in Docker on WSL2",
     "body":"<p>Symptom: ... </p><p>Fix: ...</p>","tags":["dns","docker","wsl"]}
    JSON
    curl -sS -X POST ${b}/x/notes -H "authorization: Bearer $TOKEN" \\
      -H 'content-type: application/json; charset=utf-8' --data-binary @/tmp/note.json

### Recording a contradiction (from chat)

Pass sourceMessageIds IN THE ORDER THE MESSAGES WERE SENT — the chain is the
evidence. We copy each message's text and author at save time, so the note still
proves the point after the messages are edited away or scroll out of history.

    GET /x/messages?limit=50           # find the message ids
    POST /x/notes {"type":"contradiction","title":"Auth flow: three conflicting instructions",
                   "body":"<p>...</p>","sourceMessageIds":["m1","m2","m3"],"mentionedIds":["<userId>"]}

mentionedIds notifies those people — use it when someone needs to know the note
exists, not by default.

### Note or task?

A task is work someone will do: it has an assignee, a status, and it closes.
A note is an observation that is not yet actionable — nobody knows what to do
about it. When a note has been discussed and the action is clear, convert it:
POST /x/notes/<id>/task.

### Before solving anything, check whether it is already solved

    curl -s '${b}/x/notes?scope=company&q=<the+error+text>' -H "authorization: Bearer $TOKEN"

Worth doing at the start of a debugging session: a past project may already
carry the answer.

## Chat

  GET    /x/messages?limit=50&before=<iso>
  POST   /x/messages           {"text","replyToId?":"<messageId>","attachmentIds?":["<fileId>"]}
         Posts as the human, bypassing the AI dispatcher.
         To attach files: upload them with POST /x/files first (without taskId),
         then pass the returned ids here. Text may be empty if there are files.

## Resources

  GET    /x/resources          links and credentials metadata
  Secret VALUES are never exposed through this bridge, by design. Do not ask for them.

## Project context

  GET    /x/context            project description, chat rules, members with roles
                               and responsibilities, sprints, task counts

Start with GET /x/context if you need to understand the project before acting.

## Team

  GET    /x/members                    who is in the project, with roles and permission levels
  GET    /x/members/available          company people not yet in this project
  POST   /x/members                    {"userId"|"email", "role"?: "admin"|"member"}
  PATCH  /x/members/<userId>           {"role"?, "permissions"?, "jobTitle"?, "responsibility"?}

Managing the team requires being an owner/admin of the project, or an admin of
the company. GET /x/members works for anyone who can read tasks and reports
"canManage" so you know whether the rest will be allowed.

Adding someone already in the company puts them in the project right away and
sends them a notification email. If the email belongs to nobody in the company,
a company admin can still invite them in one call — the invite carries this
project with it, so accepting the invite joins both. Anyone below company admin
gets 403 for outsiders and should invite through the interface.

Permission levels per domain (tasks, files, resources, documents, notes):

  none | read | write | crud

Changing "role" resets permissions to that role's defaults — set "permissions"
in the same call if you want to keep custom levels. The project owner cannot be
changed.

  PATCH /x/members/<id>  {"role": "admin"}
  PATCH /x/members/<id>  {"permissions": {"files": "crud", "resources": "read"}}
  PATCH /x/members/<id>  {"jobTitle": "Backend developer", "responsibility": "API and deploys"}

Removing a person from a project is NOT available here — do it in the
interface. It is irreversible, sends them an email, and closes their tunnels.
To take away access without removing them, set every domain to "none".

## Project settings

  PATCH  /x/projects/<id>      {"name"?, "about"?, "chatRules"?, "color"?}

Requires being an owner/admin of the project (or a company manager). Membership
and deleting the project are deliberately left to humans: the first hands out
access to other people's data, the second cannot be undone.
`
}


/** Строка области в шапке: у мастер-туннеля компании нет. */
function scopeLine(id: BridgeIdentity): string {
  if (id.scopeAll) return 'Scope: ALL your companies and projects'
  return `Company: ${id.company?.name ?? ''} (id: ${id.companyId})`
}

/** Вступление: чем эта связь отличается и с чего начинать. */
function scopeIntro(id: BridgeIdentity): string {
  if (!id.scopeAll) {
    return [
      'This is a COMPANY-WIDE connection: you can work across every project in this',
      'company that this person is a member of.',
    ].join('\n')
  }
  return [
    'This is a MASTER connection: every project this person belongs to, in every',
    'company, including ones they are added to later. It grants nothing beyond',
    'their own access — each call still checks their membership and permissions',
    'in that particular project.',
    '',
    '    GET /x/companies      their companies, each with the projects they are in',
    '    GET /x/projects       flat list of the same projects, with permissions',
    '',
    'Start with GET /x/companies when a company is mentioned by name, and with',
    'GET /x/projects when a project is. Both report which project the person is',
    'looking at right now — prefer it unless told otherwise.',
  ].join('\n')
}

/** Инструкция для company-туннеля: доступ ко всем проектам компании сразу. */
function companyGuideDoc(id: BridgeIdentity): string {
  const b = base()
  return `# Chatick — connected as ${id.user.name || id.user.email}

${scopeLine(id)}
Acting as: ${id.user.name || id.user.email} <${id.user.email}> (id: ${id.userId})

${scopeIntro(id)}

    -H 'authorization: Bearer <token>'

Base URL: ${b}/x

## Choosing a project — read this first

Every project-scoped call needs a project. Add \`?project=<projectId>\`:

    curl -s '${b}/x/tasks?project=<projectId>&assignee=me' -H 'authorization: Bearer <token>'

Start here to see what is available and your permissions in each:

    GET /x/projects
    GET /x/companies      the same projects grouped by company, with your role

Without ?project= a call returns 400 telling you the same thing.

## Rules

- "me" means ${id.user.name || id.user.email}.
- Permissions are checked PER PROJECT. Company access does not grant access to
  a project this person was never added to — such calls return 403.
- Destructive actions (delete, bulk status changes) need explicit human
  confirmation first. Ask, then act.
- Write content in each project's own language (GET /x/context tells you).
- On 401 the tunnel is closed — re-run the device flow (GET ${b}/x).

## Endpoints

Everything below behaves exactly as in a single-project connection, but takes
\`?project=<projectId>\`:

  GET    /x/projects                    list projects + your permissions in each
  GET    /x/context?project=<id>        description, rules, members, task counts

${endpointCatalog('?project=<id>')}

  GET / POST / PATCH / DELETE  /x/documents...?project=<id>
  POST   /x/documents/<id>/append?project=<id>
  GET / POST  /x/messages?project=<id>   POST takes {"text","replyToId?","attachmentIds?"}
  GET    /x/messages/<messageId>/context?project=<id>   conversation around a message

  GET / POST  /x/time/start | /x/time/stop | /x/time...?project=<id>
         Timers and after-the-fact entries; GET /x/time/report for hours.

  GET / POST / PATCH / DELETE  /x/notes...?project=<id>
         Project journal: solutions, decisions, contradictions, reminders.
         ?scope=company searches notes shared across the whole company — check
         it before debugging something that may already have been solved.

  GET    /x/inbox                       what concerns this person, ACROSS ALL projects
  POST   /x/inbox/read                  {"ids":[...]} or {"all":true}
         Each item has whatIsAsked (AI-written), project.id, entityType/entityId.
         Start every "check what's waiting for me" request here.

  POST   /x/projects                    {"name","about?","chatRules?"} — new project
  PATCH  /x/projects/<id>               {"name"?,"about"?,"chatRules"?,"color"?}
         Creating requires company admin/manager; the person you act for becomes
         the owner. Adding members and deleting a project are left to humans:
         the first hands out access to other people's data, the second cannot be
         undone. Ask them to do it in the app.
  GET    /x/files?project=<id>          POST multipart to upload
  GET    /x/resources?project=<id>      metadata only; secret values never exposed

  POST   /x/disconnect                  close this tunnel when you are done

Example — what is on my plate across the company:

    for p in $(curl -s ${b}/x/projects -H 'authorization: Bearer <token>' | jq -r '.items[].id'); do
      curl -s "${b}/x/tasks?project=$p&assignee=me&status=todo" -H 'authorization: Bearer <token>'
    done
`
}
