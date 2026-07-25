import type { BridgeIdentity } from './bridge-auth.js'
import { expandPermissions } from '../routes/projects.js'

// Самоописываемая инструкция для внешнего ИИ (SPEC §8.27).
// Читатель — не человек, а Claude Code: пишем плотно, по делу, с готовыми
// примерами curl. Никаких маркетинговых вступлений.

const base = () => (process.env.API_PUBLIC_URL || 'https://api.chatick.com').replace(/\/$/, '')

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

  tasks: ${permissions.tasks}   files: ${permissions.files}   resources: ${permissions.resources}   documents: ${permissions.documents}

  create/edit tasks .... ${can('tasks.create')} / ${can('tasks.edit')}
  delete tasks ......... ${can('tasks.delete')}
  upload/delete files .. ${can('files.upload')} / ${can('files.delete')}
  write/delete docs .... ${can('documents.write')} / ${can('documents.delete')}
  manage resources ..... ${can('resources.manage')}
${denied.length ? `\n  NOT ALLOWED: ${denied.join(', ')}\n  Do not attempt these — they return 403.` : ''}

## Rules

- "me" means ${id.user.name || id.user.email}. \`assignee=me\` filters to their tasks.
- Destructive actions (delete, bulk status changes) need explicit human
  confirmation first. Ask, then act.
- Write content in the project's language, not the language of the request.
- On 401 the tunnel is closed — re-run the device flow (GET ${b}/x).

## Tasks

  GET    /x/tasks?assignee=me&status=todo&q=text&sprint=<id>&limit=50
         status: todo | in_progress | review | done
  GET    /x/tasks/<id>
  POST   /x/tasks              {"title","description?","assignee?","status?","priority?","dueDate?","estimateMinutes?","sprintId?"}
  PATCH  /x/tasks/<id>         any subset of the same fields
  DELETE /x/tasks/<id>
  GET    /x/tasks/<id>/comments
  POST   /x/tasks/<id>/comments   {"text"}
  GET    /x/sprints
  POST   /x/sprints            {"name","startsAt?","endsAt?"}

  assignee accepts "me", a user id, a name or an email.
  dueDate accepts ISO date or "tomorrow", "in 3 days", "next monday".

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

## Documents

  GET    /x/documents?q=text
  GET    /x/documents/<id>?format=text|html&offset=0&limit=4000
         Long documents are read in chunks; the response says whether more remains.
  POST   /x/documents          {"title","content"}   content is HTML
  PATCH  /x/documents/<id>     {"title?","content?"}
  POST   /x/documents/<id>/append  {"content"}       safe for long docs
  DELETE /x/documents/<id>

## Chat

  GET    /x/messages?limit=50&before=<iso>
  POST   /x/messages           {"text"}   posts as the human, bypassing the AI dispatcher

## Resources

  GET    /x/resources          links and credentials metadata
  Secret VALUES are never exposed through this bridge, by design. Do not ask for them.

## Project context

  GET    /x/context            project description, chat rules, members with roles
                               and responsibilities, sprints, task counts

Start with GET /x/context if you need to understand the project before acting.
`
}


/** Инструкция для company-туннеля: доступ ко всем проектам компании сразу. */
function companyGuideDoc(id: BridgeIdentity): string {
  const b = base()
  return `# Chatick — connected as ${id.user.name || id.user.email}

Company: ${id.company?.name ?? ''} (id: ${id.companyId})
Acting as: ${id.user.name || id.user.email} <${id.user.email}> (id: ${id.userId})

This is a COMPANY-WIDE connection: you can work across every project in this
company that this person is a member of.

    -H 'authorization: Bearer <token>'

Base URL: ${b}/x

## Choosing a project — read this first

Every project-scoped call needs a project. Add \`?project=<projectId>\`:

    curl -s '${b}/x/tasks?project=<projectId>&assignee=me' -H 'authorization: Bearer <token>'

Start here to see what is available and your permissions in each:

    GET /x/projects

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
  GET    /x/tasks?project=<id>&assignee=me&status=todo
  GET    /x/tasks/<taskId>?project=<id>
  POST   /x/tasks?project=<id>          {"title","assignee?","status?",...}
  PATCH  /x/tasks/<taskId>?project=<id>
  DELETE /x/tasks/<taskId>?project=<id>
  GET / POST  /x/tasks/<taskId>/comments?project=<id>
  GET / POST  /x/sprints?project=<id>
  GET / POST / PATCH / DELETE  /x/documents...?project=<id>
  POST   /x/documents/<id>/append?project=<id>
  GET / POST  /x/messages?project=<id>
  GET    /x/files?project=<id>          POST multipart to upload
  GET    /x/resources?project=<id>      metadata only; secret values never exposed

  POST   /x/disconnect                  close this tunnel when you are done

Example — what is on my plate across the company:

    for p in $(curl -s ${b}/x/projects -H 'authorization: Bearer <token>' | jq -r '.items[].id'); do
      curl -s "${b}/x/tasks?project=$p&assignee=me&status=todo" -H 'authorization: Bearer <token>'
    done
`
}
