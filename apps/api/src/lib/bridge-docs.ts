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
         fields=brief — number, title, status, priority, refs, sprint, assignee
         and no description or attachments. Use it whenever you are picking
         tasks rather than reading them: descriptions are the bulk of the
         payload, and a list you only need numbers from should not spend your
         context on the full text of sixty task bodies.
         Every task carries "openBlockers" (unfinished tasks it waits for) and
         "blocking" (tasks waiting for it). openBlockers > 0 means the work
         cannot start yet — do not propose it as the next thing to do, and do
         not assign someone to it without saying what it is waiting for.
         brief also carries "commentCount", "lastCommentAt" and
         "unansweredMention": the last is true when this person was mentioned
         in the comments and has not written since. That is "where was I asked
         something and never replied" — visible from the list itself, instead
         of reading the comments of every task one by one to find out.
  GET    /x/tasks/<id>${q}
         <id> is the task NUMBER ("TASK-81") or its id — everywhere a task
         appears in a path. Use the number: it is what the human says out
         loud, it survives you losing whatever id map you kept, and it is
         what the reply shows you.

         Every task in a reply carries "url" — the ready link to open it.
         Give the human THAT, never one you assembled yourself: the address
         format has changed once already, and a guessed /#/p/<id> opens a
         blank screen.

         Replies about ONE task (GET/POST/PATCH of a single task) also carry
         "shortUrl" — chatick.com/t-AbC12. Prefer it when writing to a person:
         "url" is 90 characters with two ids and a "#", it wraps across lines
         in chat and stretches message cards out of shape. Both open the same
         task and neither grants access: rights are checked on arrival.
         Lists omit "shortUrl" — ask for the single task when you need it.
  POST   /x/tasks${q}              {"title","description?","assignee?","status?","priority?","estimateMinutes?","dueDate?","sprintId?","attachmentIds?","resourceIds?","refs?"}
  PATCH  /x/tasks/<id>${q}         any subset of the same fields
  PATCH  /x/tasks/bulk${q}         {"tasks":["TASK-4","TASK-7"], "set":{...}, "refs":{"TASK-4":"19.1"}}
  DELETE /x/tasks/<id>${q}
  DELETE /x/tasks/bulk${q}         {"tasks":["TASK-4","TASK-7"]}
  POST   /x/tasks/<id>/restore${q}
  GET    /x/trash${q}${amp}type=task|file

  "dueDate" — when the task is due: "2026-09-14", or a full timestamp if the
  hour matters. null clears it. A bare date is read as midday, so it does not
  slide to the previous day in western time zones.

  Set it when the person names a date or a deadline, and leave it empty when
  they do not: a made-up due date looks like a commitment somebody gave, and
  the board stops meaning anything once half the dates are guesses.

  "resourceIds" — resources this task needs: a staging URL, an SSH key, a
  database. Link them, never copy a secret into the description: a password
  pasted there is readable by everyone who can see the task and cannot be taken
  back, while a linked resource keeps deciding for itself who may open it.
  Create the resource with POST /x/resources, pass its id here. Ids from
  another project are ignored rather than rejected, so one stale id does not
  fail the whole call.

  "refs" — what this task is called OUTSIDE Chatick: screen numbers in a design
  file, clauses of a contract, line items of an estimate. Free text, split on
  COMMAS only: "12.3, 4 - 3, 5" is three refs, and "4 - 3" stays one because
  for some teams that is a range and for others a compound number. Digits, dots
  and hyphens are kept, anything else is dropped. Pass "" to clear.

  GET /x/tasks returns at most "limit" tasks (50 by default, 200 max) but also
  tells you "total" — how many actually match — and "truncated": true when the
  list you got is only part of them. CHECK IT before acting on "all of them":
  a sprint of sixty comes back as fifty, and closing those fifty is not
  closing the sprint. Narrow the filter or raise the limit, and if it still
  does not fit, say so instead of silently doing part of the job.

  PATCH /x/tasks/bulk applies ONE change to MANY tasks in a single request.
  Use it whenever the human says "all of them", "the whole sprint", "every
  screen": one call instead of thirty, and the reply tells you exactly which
  tasks changed. Name tasks by number ("TASK-4") or id, up to 100 per request.
  The usual pairing is GET /x/tasks?fields=brief to find them, then one bulk
  call with the numbers from it — note the list allows 200 and bulk allows
  100, so a very wide selection needs two calls rather than one rejected
  with 400.

    {"tasks":["TASK-4","TASK-7","TASK-9"], "set":{"status":"done"}}
    {"tasks":["TASK-4","TASK-7"], "set":{"sprintId":"<id>","priority":"high"}}
    {"tasks":["TASK-4","TASK-7"], "refs":{"TASK-4":"19.1","TASK-7":"19.2*"}}

  "set" holds what is the same for every task and takes the same fields as a
  single PATCH. "refs" holds what differs per task — numbering a list of
  screens is the case it exists for. You may send both; refs wins for a task
  named in it. At least one of them is required.

  The reply is {"updated","failed","items","errors"} and a task can fail while
  others succeed — not found, or not yours to edit. ALWAYS read "errors"
  before reporting back: reporting "done" when half the list failed is worse
  than failing outright, because the human stops checking. Nothing is rolled
  back — the tasks in "items" really did change.

  DELETE /x/tasks/bulk removes many at once, same shape of reply and the same
  per-task rules: your own tasks you may delete, other people's need the
  delete permission, and each one is checked separately. Deletion stays soft —
  everything lands in /x/trash for seven days. Still, confirm with the human
  before clearing a list you assembled yourself: "not found" costs a retry,
  but a wrongly deleted sprint costs their afternoon.

  Deleting is soft and undoable — and now undoable BY YOU. /x/trash lists what
  was deleted in this project with daysLeft on each; restore puts it back.
  After seven days a cleaner removes it for good and nothing can be recovered,
  so if you deleted the wrong thing, fix it in the same conversation rather
  than telling the human to go and do it.

  Unknown fields in a body are rejected with 400 naming the field — a request
  that returns 2xx did exactly what you asked, so there is no need to re-read
  the object afterwards to check.

  GET    /x/activity${q}${amp}entityType=task&action=delete&actor=me&q=text&from=&to=&limit=50
         Project history: who changed what and when. Read-only.
         entityType: task | file | document | note | resource | member | project
         Use it before asking the human "what happened here" — and to find
         things that no longer exist: a deleted file still has its entry.

  GET    /x/db${q}                            databases connected to this project, and what you may read
  POST   /x/db/<id>/read${q}                   {"sql":"select ...", "limit":100}

  A project can have a real database attached — the customer's, not ours. You
  can READ it. You cannot write: the query runs inside a read-only transaction,
  so the database engine itself rejects any UPDATE, INSERT, DELETE or DROP,
  including ones hidden in a CTE or after a semicolon. Do not try to work
  around it; ask the human to make the change.

  Call GET /x/db first. It lists "readableTables" — the ONLY tables you may
  touch, chosen by a human, plus "hiddenColumns" that are stripped from every
  answer. Querying anything else fails with a message naming what is allowed;
  that is a closed door, not a hint to keep guessing.

  Plain SELECT is fine — joins, aggregates, whatever answers the question.
  Results are capped and "truncated": true means you saw only part; say so
  rather than reporting a partial count as the total.

  This is production data belonging to someone else. Read what the question
  needs, not the whole table, and do not copy personal data (names, emails,
  phone numbers) into chat messages or task descriptions where it will outlive
  the conversation.

  GET    /x/blockers${q}                      what is holding the WHOLE project, and who owns it
  GET    /x/tasks/<id>/blockers${q}           what this task waits for, and what waits for it
  POST   /x/tasks/<id>/blockers${q}           {"tasks":["TASK-3","TASK-5"], "side":"blockedBy"|"blocking"}
  DELETE /x/tasks/<id>/blockers/<linkId>${q}  remove one link

  Dependencies say WHAT ORDER the work happens in: "payment cannot be built
  before authentication". You are often the first to see this — you read the
  whole design file at once, while a human opens one screen at a time. When
  the order is obvious from what you just read, record it instead of
  mentioning it in a comment nobody will act on.

  GET /x/blockers answers "why is this project not moving?" in one call. It
  returns the tasks that hold others — sorted so the worst offender is first —
  each with its owner, and a link straight to the task. Do not rebuild this
  from /x/tasks: naming the wrong owner sends the human to chase the wrong
  person, and that costs more than the call you saved.

    holdingCount   how many tasks are holding others
    blockedCount   how many distinct tasks are waiting
    owners[]       who to ask, with blockingTasks = how much rides on them
    items[]        each holder: task, owner, and the tasks it blocks (with urls)

  Report it as chains, not totals: "TASK-82 blocks five screens, all waiting
  on Elisha" is actionable; "22 tasks are blocked" is not. An owner of null
  means the task belongs to nobody — that is its own problem, and worth saying
  out loud, because there is no one to ask.

  Finished tasks are excluded on both sides: a closed task holds nobody, even
  though the link stays for history.

  side="blockedBy" (the default) means the listed tasks must be finished
  BEFORE this one. side="blocking" is the mirror: this task must be finished
  before the listed ones. Both write the same link, so pick whichever matches
  the sentence you would say out loud.

  The reply to GET includes "openBlockers" — unfinished tasks in the way.
  Zero means the task can be picked up right now; that is the number worth
  reporting to a human asking "what can I start?".

  A link SURVIVES the blocker being finished — it is a fact about the work,
  not a temporary flag. Do not delete links to "clean up" after a task is
  done: openBlockers already drops to zero on its own, and the history of what
  waited for what is the only way to explain later why something sat for two
  weeks.

  Loops are rejected with 400. If A waits for B and B waits for A, NEITHER can
  ever be finished, and nothing in the interface makes that visible — every
  single step looks reasonable. The check follows the whole chain, so
  A→B→C→A is caught too. When you get that error, the link you wanted is
  backwards: the other task already depends on this one.

  GET    /x/tasks/<id>/checklist${q}          items, done/total
  POST   /x/tasks/<id>/checklist${q}          {"items":["...","..."]} or {"text":"...","note":"..."}
  PATCH  /x/tasks/<id>/checklist/<itemId>${q} {"done"?, "note"?, "text"?}
  DELETE /x/tasks/<id>/checklist/<itemId>${q} remove an item added by mistake

  A checklist is the task broken into steps, or questions waiting for an
  answer. Send several at once via items. The note under an item is optional —
  most items are just things to do. Ticking is manual and reversible: answering
  and considering it done are separate decisions, and nothing happens
  automatically when all are ticked.

  A checklist is NOT a field of the task: create the task first, then POST its
  items to the sub-resource above. Sending "checklist" inside POST /x/tasks is
  rejected with 400.

  GET    /x/tasks/<id>/comments${q}
  POST   /x/tasks/<id>/comments${q}   {"text", "replyTo?", "attachmentIds?"}

  Comments are the discussion on a task, and you take part in it like anyone
  else. Read the thread before you act on a task: the description says what was
  asked, the comments say what was decided since.

  Each comment comes back with id, text, author, authorId, createdAt,
  attachments — and replyTo when it answers an earlier one. Pass that id as
  "replyTo" to answer a specific comment instead of dropping a remark at the
  end of the thread; without it the thread reads as a flat list and nobody can
  tell what you were responding to.

  To address someone, write @[Their Name](<userId>) — take the id from
  GET /x/members. Only that exact markup notifies them; a plain "@name" is
  just text. The task's author and assignee, and the person you replied to,
  are told about a new comment anyway, so do not mention them for that alone.

  The same markup works in a task DESCRIPTION and notifies the same way, so
  you can pull someone in when you create the task rather than commenting
  right after. The assignee already learns of the assignment — mention others
  only when they specifically need to see it.

  Attaching files. Upload with POST /x/files first, then pass the returned ids
  as "attachmentIds" (up to 10). A screenshot of the failure often IS the
  answer, and no amount of text replaces it. The file also lands in the task's
  own file list, exactly as when a person attaches one. "text" may be empty
  when there are files.

  Commenting needs tasks.read: anyone who can see tasks can comment.

  PATCH  /x/tasks/<id>/comments/<commentId>${q}   { "text": "..." }
  DELETE /x/tasks/<id>/comments/<commentId>${q}

  Editing and deleting follow the same rule as everywhere else: the author
  changes their own, an admin changes any. You act as the person whose token
  this is, so "your own" means theirs — not every comment the assistant wrote
  on someone else's behalf. Anything else comes back 403, not a silent no-op.

  Deleting a comment is permanent — unlike a task, it is not recoverable.
  Prefer editing when the point is to correct something.

  GET    /x/releases${q}                   what shipped and where, plus "live"
  GET    /x/releases/<id>${q}              one version with its stage history
  POST   /x/releases/request${q}   {"version","appName?","buildType","assignee?","comment?","buildProfile?","estimateMinutes?"}
  POST   /x/releases${q}           {"version","appName?","buildType","status?","referenceUrl?","notes?","comment?","buildProfile?"}
  POST   /x/releases/<id>/stage${q} {"status","comment"}   comment REQUIRED

  /x/releases/request is the one you usually want. A manager does not "create a
  version" — they ASK someone to build one. It creates the TASK (with the
  assignee, who gets notified), the VERSION, and the link between them in a
  single call. Doing it as three calls risks breaking in the middle and leaving
  a task with no version. POST /x/releases without /request is for registering
  something ALREADY built, when there is nobody to ask.

  "appName" is WHICH app was built — "Client", "Provider", "Admin". A project
  often ships more than one, and buildType does not tell them apart: the client
  and the provider for iOS are both "ios". Without it the "what is live"
  summary collapsed them into one line and the second app vanished from view.
  The web form requires it; here it is optional so older versions still work.

  "buildProfile" is what it was built WITH — development | preview | production
  (eas build --profile). It is NOT the stage: the stage says where the build
  got to, the profile says how it was made. The same production build passes
  through TestFlight and then the store; a preview build may never leave the
  first stage. Optional, and for web or backend usually pointless.

  Versions answer the question people currently ask out loud: "which version is
  in production". The list reply carries "live" — the version that reached
  people, per build type — so you never have to work it out from the list
  yourself.

  buildType is one of ios | android | web | backend | desktop | other, and each
  has its OWN ladder of stages: iOS goes building → testflight → in_review →
  released, Android has no review step, web and backend go through staging. The
  reply carries "buildTypes" with every ladder, so read it instead of guessing
  a stage name — a wrong one is rejected with the allowed list.

  Moving a stage notifies the person who CREATED the version, and whoever is
  assigned to the linked tasks — not the whole project. They asked for the
  build or are shipping it; everyone else does not need the noise. Nothing is
  sent to whoever made the change.

  Moving a stage REQUIRES a comment. This is not ceremony: "why has 1.4 been
  sitting in Apple review for a week" is the same kind of question as "what is
  in production", and it has no answer if each transition overwrites the last
  without saying anything. Write what actually happened.

  There is no DELETE. A version is a fact — it was built and it went somewhere.
  Erasing it erases the answer to "what was in production that Tuesday". Close
  a wrong one by moving its stage and saying so.

  Releases are OFF by default. If the project has not enabled them, every one
  of these returns 404 with an explanation — do not report that as a bug, tell
  the human a project owner or admin turns them on in project settings.

  GET    /x/integrations/expo${q}  is Expo connected? returns the ready command
  POST   /x/integrations/expo${q}  connect it; returns the ready command

  Connecting Expo means EAS reports every build to Chatick by itself: the
  version appears with links to the artifact and to the build logs, and moves
  off "building" on its own. The developer never opens Chatick for it.

  POST returns a ready "command" — give it to the human to run IN THE APP
  FOLDER. Several apps (client, provider) each need it run in their own folder;
  the same secret works for all of them, they are told apart by build name.

  Calling POST twice is safe: it returns the SAME secret, not a new one, so a
  second call cannot silently break an already configured webhook.

  What arrives automatically is only the build itself. TestFlight, store review
  and release are still marked by a human — EAS knows nothing about the stores,
  so do not promise the human that those will update on their own.

  Tasks link to versions from the TASK side: pass "releaseIds" to POST or PATCH
  /x/tasks. GET of a single task returns "releases" with each version's current
  stage, so "what is this task shipping in" needs no second call. The link is
  optional both ways — a version lives without a task, a task without a version.

  GET    /x/sprints${q}                    id, name, color, taskCount
  POST   /x/sprints${q}            {"name","startsAt?","endsAt?"}
  PATCH  /x/sprints/<id>${q}       {"name?","color?"}
  DELETE /x/sprints/<id>${q}${amp}force=1

  Renaming exists so a typo — or a name mangled by the shell's encoding — can
  be fixed without sending the human into the app.

  Deleting a sprint deletes NO tasks: they simply end up without one. A sprint
  that still holds tasks refuses with 409 and says how many; repeat with
  ?force=1 when losing the grouping is genuinely intended. Ask the human first
  — a sprint you did not create is someone's plan.

  Changing only the status (plus sprint or ordering) needs tasks.changeStatus,
  which every member has — moving a card across the board is not the same as
  rewriting the task. Touching anything else needs tasks.edit.

  assignee accepts "me", a user id, a name or an email.

  GET    /x/chat/summaries${q}${amp}q=text&from=&to=&full=1&limit=30
         The chat compressed into per-day summaries — how to know what was
         discussed months ago without reading thousands of lines.
  GET    /x/chat/summaries/<id>${q}          one summary in full
  GET    /x/chat/messages${q}${amp}from=&to=&q=text&limit=200
         The RAW messages of a period, oldest first.

  How to recall something old: search the summaries, find the period, then
  fetch its raw messages and quote the exact words. Every summary carries
  from/to and a ready-made messagesUrl for exactly that. Nothing is ever
  deleted — summaries sit on top of the full history, they do not replace it.

  When you only have a word and no idea when it was said, pass q on its own:
  /x/chat/messages?q=migration searches the whole history and returns the most
  recent matches. Add from/to to walk back through an older period. The reply
  says hasMore when more matched than fit — it is never silently cut.

  GET    /x/shares/<type>/<id>${q}    is it already public? -> {"shared":false} or the link
  POST   /x/shares/<type>/<id>${q}    publish a link; type: file | note | resource | message | task
  DELETE /x/shares/<type>/<id>${q}    revoke it

  Check with GET before saying anything about privacy: a thing may already be
  on the public internet, and that changes what you should advise.

  Publishing puts the thing on the public internet, so only project owners and
  admins can do it (403 otherwise) — and ask the human first even when allowed.
  The response carries both links: one for the team, one public.

  POST   /x/report                {"kind","body","context"?}
         kind: missing | bug | request | docs

  Tell the Chatick team what got in your way. No project needed — the reports
  worth the most come from where you could not do anything at all.

    missing  you tried to do what was asked and there is no endpoint for it
    bug      something behaved differently from what this guide says
    request  the person asked for a feature that does not exist
    docs     this guide is wrong, unclear, or its example does not work

  Send one when you actually hit the wall — not "it would be nice if". "body"
  is what happened in your own words; "context" is what you were trying to do,
  and without it a report of a missing endpoint cannot be acted on, because
  there is no one left to ask.

  Five per hour. It goes to the team, is read by a human, and is NOT
  implemented automatically: never promise the person a fix or a date. Say you
  passed it on, and carry on with what can be done today.

  Do not use it for anything about the person's own project — their bugs, their
  requests, their team. This is about Chatick itself.`
}

/** Инструкция для НЕавторизованного: как подключиться. Отдаётся по голой ссылке. */
export function connectDoc(): string {
  const b = base()
  return `# Chatick — bridge for AI assistants

You are reading the connection guide for Chatick (team chat + project workspace:
tasks, files, documents, resources).

You are NOT connected yet. Connect first, then re-read the authenticated guide.

## Before you print a code: check your tool list

Look for a tool named \`chatick_connect\` in your own tool list. One look — no
command, no file to read. MCP tools are either there or they are not.

- Present → call it and stop reading here. It handles the desktop app and the
  code flow itself; where the app runs, the human just presses a button.
- Absent → the server is not configured in this session. Use the curl flow
  below and say so in one line, rather than asking the human whether MCP is
  available: they cannot see your tool list, and you can.

The steps here are for the second case only.

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

- The token dies when the tunnel is closed, after 24h, or after 12h idle.
  If a call returns 401, the tunnel is closed: start over from step 1.
- Every response carries "x-tunnel-expires-in" (seconds left) and
  "x-tunnel-expires-at". CHECK IT BEFORE STARTING ANYTHING MULTI-STEP. Dying
  halfway leaves the work half-done — a task created and its checklist
  rejected with 401 is worse than not starting: the human is left with a
  stub they did not ask for and have to clean up. If the remaining time
  looks short for what you are about to do, re-run the device flow first, or
  do the part that matters and tell the human what is left.
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
- MARKDOWN IS FINE. Task descriptions, comments, notes and documents accept
  markdown and it is converted on our side — headings, lists, bold, code, links,
  tables, and a single newline stays a line break. Send HTML if you already have
  it; both end up as the same stored markup. What you must NOT do is send a wall
  of prose because you feared markdown would show up raw — it will not.
- Hebrew, Arabic and other right-to-left text needs nothing special: every
  paragraph takes its direction from its own content, so mixed Russian, Hebrew
  and English in one description each read the right way round.
- NON-ASCII BODIES — read this before your first write. Never put non-ASCII text
  (Cyrillic, Hebrew, emoji, typographic dashes) inline in \`curl -d '...'\`. On
  Windows the shell re-encodes the argument and the server stores \`?????\`. The
  request SUCCEEDS and returns 201, so nothing warns you; the ASCII part survives,
  which hides the problem further. Send the body through stdin instead:

    curl -sS -X POST ${b}/x/messages -H "authorization: Bearer $TOKEN" \\
      -H 'content-type: application/json; charset=utf-8' --data-binary @- <<'JSON'
    {"text":"Тестовое сообщение"}
    JSON

  A file works too (\`--data-binary @/tmp/body.json\`). This applies to EVERY write —
  tasks, comments, messages, notes, documents, sprints, time entries. Most projects
  here are not in English, so treat stdin as the default way to send a body, not
  the exception. After creating something with a non-ASCII name, read it back once
  and check the characters survived.

  Applies to every endpoint with a body: messages, tasks, documents, comments.
  Corrupted text CANNOT be fixed through this bridge — there is no edit/delete for
  chat messages — so verify before sending, not after.
- On 401 the tunnel is closed — re-run the device flow (GET ${b}/x). Watch
  "x-tunnel-expires-in" on every response and reconnect BEFORE a long
  multi-step job rather than after it fails halfway.

## What concerns me — start here

  GET  /x/inbox?unread=1&limit=30    everything addressed to this person
  POST /x/inbox/read                 {"ids":["..."]}, {"all":true} or
                                     {"entityType":"task","entityId":"..."}

Each item carries \`whatIsAsked\` — one sentence written by our AI describing what
the reader is actually expected to do ("Send the latest APK build"), plus
\`entityType\`/\`entityId\` pointing at the thing it is about:

  entityType="message" -> GET /x/messages/<entityId>/context   read the conversation
                          around it, then answer with POST /x/messages
                          {"text":"...","replyToId":"<entityId>","attachmentIds":[...]}
  entityType="task"    -> GET /x/tasks/<entityId>

Mark items read once handled, otherwise you will see them again — and so does the
person, as a counter for work that is already done. Clearing by entity is usually
what you want: one task collects several notifications (assigned, mentioned,
commented), and {"entityType":"task","entityId":"<task id>"} closes all of them
with the id you already have.

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
  POST   /x/files/<id>/restore        bring one back from the trash
  POST   /x/files                     multipart: file=@path, taskId=<id>, keepOriginal=1 (both optional)
  DELETE /x/files/<id>

  Several files in one call are allowed: repeat -F 'file=@...' and the reply is
  {"items":[...],"uploaded":N,"failed":N} instead of a single object, with a
  per-file error where one did not go through. Sending one file keeps the old
  single-object reply.

  Images are resized to 2048px and converted to webp, and the original is NOT
  kept — a second copy would eat everything the conversion saves. That is the
  deliberate default, not a defect; pass keepOriginal=1 when the exact bytes
  matter (a design source, a PNG with transparency, a file someone must
  download unchanged). With keepOriginal=1 nothing is converted at all: what
  you sent is what is stored.

  The reply says which happened: "optimized": true means it was converted to
  webp, false means the bytes are yours untouched. Do NOT read "hasOriginal"
  as an answer to that — it means "a SECOND, unconverted copy exists", and it
  is false for every new upload including keepOriginal=1 ones, because when
  nothing was converted there is nothing to keep a copy of.

  To attach files to a TASK rather than to a comment, upload them first and
  pass the ids as "attachmentIds" to POST or PATCH /x/tasks — the same place a
  person drops them in the app. attachmentIds on a comment attaches to the
  comment instead.

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
         Searches titles AND their text. Each item says "matchedIn": content
         or title, and the preview shows the matching passage — so you can tell
         which document is worth opening before opening any.
  GET    /x/documents/<id>?q=text&context=300
         SEARCH INSIDE one document. Returns only the matching passages with
         their offsets, not the whole text. Use this first when you are after
         something specific: a 30k-character spec is 8 sequential reads
         otherwise, and you usually need one paragraph.
         Then read around a hit with ?offset=<its offset>.
  GET    /x/documents/<id>?format=text|html&offset=0&limit=4000
         Long documents are read in chunks; the response says whether more remains.
  POST   /x/documents          {"title","content"}   content is HTML
  PATCH  /x/documents/<id>     {"title?","content?"}
  POST   /x/documents/<id>/append  {"content"}       safe for long docs

  Writing answers with "totalChars" — the length AFTER the write. Compare it
  with what you sent: {id, title} alone looks like success whatever happened,
  and reporting a saved document that still holds the old text is worse than
  reporting a failure.
  DELETE /x/documents/<id>
  GET    /x/documents/<id>/versions                    who changed it and when
  POST   /x/documents/<id>/versions/<versionId>/restore

  Every edit snapshots the previous state, so a rewrite that went wrong is
  undoable — restore also snapshots the current text first, so the undo itself
  is undoable. You rewrite documents more often than anyone here; check the
  versions before assuming something was lost.

## Time tracking

You know when work started and stopped — so record it, instead of the human
poking at timers.

  GET   /x/time/running          what is running now + the project's timer limit
  POST  /x/time/start            {"task?":"TASK-12","description?":"...","startedAt?":"<ISO>"}
  POST  /x/time/stop             {"id?":"<entryId>"}  — id needed only if several run
  POST  /x/time/resume           {"id?":"<entryId>"}  — carry on after a break
  POST  /x/time                  {"startedAt","endedAt","task?","description?"} — after the fact
  GET   /x/time?from=&to=&task=TASK-12&q=text&mine=1&limit=100
  PATCH /x/time/<entryId>        {"description?","task?","startedAt?","endedAt?","project?"}
  GET   /x/time/report?from=YYYY-MM-DD&to=YYYY-MM-DD

  ONE entry links to at most ONE task. Two things at once means two timers —
  the project caps how many may run (1 unless changed).
  Everything is optional: a bare start with no task and no description is the
  normal case.
  In /x/time, an end earlier than the start is read as the next day.

  Pause and resume. There is no pause field, on purpose: a break must not end
  up in the hours. Pausing IS stopping — POST /x/time/stop. Carrying on is
  POST /x/time/resume, which opens a fresh entry with the same description and
  task as the one you finished last, so nothing is retyped and nothing is lost.
  Pass an id to continue a specific earlier entry instead of the latest.

  The limit counts the PERSON, not the project. A timer running in another
  project blocks a new one here, and the 409 names that project — say which one
  rather than reporting a mysterious refusal. /x/time/running lists every
  timer of theirs, each flagged "here": a timer forgotten in a neighbouring
  project is exactly what needs saying out loud. Stopping works on those too.

  Fixing an entry. /x/time lists individual entries — that is where the ids
  come from; /x/time/report only adds hours up. PATCH corrects what is wrong:
  the description, the task, the times, or "project" to move the hours where
  they belong (moving clears the task, since it lived in the old project).
  Setting "endedAt": null makes the entry run again. Own entries always; other
  people's only with tasks.edit, and only inside this project.

  Deleting entries is not available through the bridge. Correct a wrong entry;
  erasing someone's recorded hours is not yours to do.

Example — a working session with a break:

    curl -sS -X POST ${b}/x/time/start -H "authorization: Bearer $TOKEN" \\
      -H 'content-type: application/json' -d '{"task":"TASK-12","description":"login redirect"}'
    # ... work ...
    curl -sS -X POST ${b}/x/time/stop -H "authorization: Bearer $TOKEN" \\
      -H 'content-type: application/json' -d '{}'
    # ... break ...
    curl -sS -X POST ${b}/x/time/resume -H "authorization: Bearer $TOKEN" \\
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
         {"title?","assigneeId?","priority?"} — all optional.
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
  GET    /x/messages/<id>/context?around=10
  POST   /x/messages           {"text","replyToId?":"<messageId>","attachmentIds?":["<fileId>"]}
         Posts as the human, bypassing the AI dispatcher.
         To attach files: upload them with POST /x/files first (without taskId),
         then pass the returned ids here. Text may be empty if there are files.

  Reading. /x/messages is the recent feed, newest last; page back with
  "before". Every message carries id, text, author, attachments, createdAt —
  and "replyTo" when it answers an earlier one, so you can follow a thread
  instead of reading the room as a flat list. /x/messages/<id>/context opens
  the conversation around one message when a notification or a note points
  at it.

  You see exactly what the human sees, and no more. A message being written
  under the dispatcher's clarifying question, or one that turned into an
  action and never reached the chat, is not in the feed unless it is theirs.
  Do not treat gaps in ids as messages you were denied — the chat is simply
  not a continuous log.

  Replying. Pass "replyTo"'s id as "replyToId" to answer a specific message.
  Do it whenever you answer something said a while ago: without it nobody can
  tell what you are responding to.

  To address someone, write @[Their Name](<userId>) — ids come from
  GET /x/members. That exact markup notifies them; a plain "@name" is text.

  Length. Up to 20000 characters, the same as the composer. Longer is refused
  with 400 rather than trimmed — a truncated message that returns 201 would
  read as delivered in full.

  DELETE /x/messages/<id>

  Deleting follows the usual rule: the author removes their own, an admin
  removes any. You act as the person whose token this is. A message from the
  assistant itself has no author, so only an admin can remove it.

  This is permanent and it disappears for everyone — chat has no trash, unlike
  tasks. Attached files stay in the project; they are only detached from the
  message. Say what you removed rather than doing it quietly.

  Editing a message is not possible for anyone — there is no edit in the app
  either, and no "edited" marker exists. Post a correction instead.

## Resources

  GET    /x/resources          links and secrets metadata; "canSeeSecrets" says
                               whether the secrets under each one are open to you
  POST   /x/resources          {"name"?,"url"?,"description"?,"secrets"?,"viewers"?}
  PATCH  /x/resources/<id>     same fields; pass "url": null to drop the link

  An unknown field is refused with 400 listing what is allowed, rather than
  dropped. The project goes in the query (?project=<id>) like everywhere else.

  "secrets" is [{"label","value"}]. On PATCH they are ADDED, not replaced: a
  list sent short would otherwise wipe someone else's key.

  DELETE /x/resources/<id>/secrets/<secretId>  remove one secret
  Because PATCH only adds, this is how you undo your own mistake — a wrong
  label, a value pasted twice. It takes exactly one named secret; the resource
  itself stays, deleting that is still a human's call.

  This is where project links belong — designs, dashboards, repositories,
  staging environments. Put a link here rather than in a note: notes are a
  stream, resources are the list people open when they need the link again.
  Give either a url or a name; with only a url the name is taken from it.

  Secrets live UNDER a resource and have their own audience. The link and the
  description are visible to the whole project; each secret is visible only to
  the people in "viewers", plus whoever created the resource. Do not list the
  author — they always see their own.

  A resource you create through this bridge starts shared with NOBODY but its
  author. Name the people who need it in "viewers" (ids from GET /x/members),
  or the person you made it for will not be able to open it — and say out loud
  who you gave it to, because they cannot see that from the task.

  Only the author changes "viewers" later; resources.manage is not enough.

  CHECK THE PERSON CAN SEE RESOURCES AT ALL before listing them. Two different
  gates guard a secret, and the first one is older than your list:

    resources: none   they do not see the resources tab — sharing a secret with
                      them changes nothing, they cannot reach the card
    resources: read   they can open a resource and reveal secrets shared
                      with them  <- the minimum for "viewers" to mean anything
    resources: write  they can also create and edit resources

  GET /x/members reports each person's levels. Listing someone with "none"
  is not refused, it is simply useless: you will report the access as granted
  and they will still see nothing.

  If they genuinely need it and you own or administer the project, raise their
  level first — PATCH /x/members/<userId> {"permissions":{"resources":"read"}} —
  and say that you did. If you do not manage the team, do not quietly skip
  them: name who is missing access and who can grant it.

  Reading a value is one secret at a time, through the app or
  POST /x/resources/<id>/secrets/<secretId>/reveal, and every read is audited.

  Do not go looking for secrets to store. Write down what the human handed you
  for that purpose — never values you found in a .env, a log or an earlier
  message, and never a value you were not asked to keep.

  Deleting a resource is left to humans — it takes its secrets with it.

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
- MARKDOWN IS FINE — descriptions, comments, notes and documents accept it and
  it is converted on our side. Right-to-left text needs nothing special.
- NON-ASCII BODIES — read this before your first write. Never put non-ASCII text
  (Cyrillic, Hebrew, emoji, typographic dashes) inline in \`curl -d '...'\`. On
  Windows the shell re-encodes the argument and the server stores \`?????\`. The
  request SUCCEEDS and returns 201, so nothing warns you. Send the body through
  stdin instead:

    curl -sS -X POST '${b}/x/messages?project=<id>' -H "authorization: Bearer $TOKEN" \\
      -H 'content-type: application/json; charset=utf-8' --data-binary @- <<'JSON'
    {"text":"Тестовое сообщение"}
    JSON

  This applies to EVERY write. Projects here are rarely in English, so treat
  stdin as the default way to send a body, not the exception.
- On 401 the tunnel is closed — re-run the device flow (GET ${b}/x). Watch
  "x-tunnel-expires-in" on every response and reconnect BEFORE a long
  multi-step job rather than after it fails halfway.

## Endpoints

Everything below behaves exactly as in a single-project connection, but takes
\`?project=<projectId>\`:

  GET    /x/projects                    list projects + your permissions in each
  GET    /x/context?project=<id>        description, rules, members, task counts

${endpointCatalog('?project=<id>')}

  GET / POST / PATCH / DELETE  /x/documents...?project=<id>
  POST   /x/documents/<id>/append?project=<id>
         Writing answers with "totalChars" — the length after the write.
         Check it against what you sent instead of trusting {id, title}.
  GET / POST  /x/messages?project=<id>   POST takes {"text","replyToId?","attachmentIds?"}
  GET    /x/messages/<messageId>/context?project=<id>   conversation around a message
  DELETE /x/messages/<id>?project=<id>   author removes their own, admin any
         Messages carry "replyTo" — pass it back as "replyToId" to answer one.
         Mention with @[Their Name](<userId>); max 20000 characters, refused
         rather than trimmed. You see only what the human sees: drafts still
         under the dispatcher's question are not in the feed.
         Deleting is permanent and visible to everyone — chat has no trash.
         A message from the assistant has no author: only an admin removes it.
         Editing a message is not possible for anyone; post a correction.

  GET / POST  /x/time/start | /x/time/stop | /x/time/resume | /x/time...?project=<id>
  PATCH  /x/time/<entryId>?project=<id>  {"description?","task?","startedAt?","endedAt?","project?"}
         Timers and after-the-fact entries; GET /x/time lists them one by one,
         GET /x/time/report adds the hours up.
         Pausing IS stopping — there is no pause field, a break must not land
         in the hours; /x/time/resume carries on with the same description and
         task. The parallel-timer limit counts the PERSON across all projects,
         so /x/time/running shows timers from every project of theirs and a
         forgotten one elsewhere blocks a new start here — name that project.
         "project" in PATCH moves the hours to another project (clears the
         task). Deleting entries is not available.

  GET / POST / PATCH / DELETE  /x/notes...?project=<id>
         Project journal: solutions, decisions, contradictions, reminders.
         ?scope=company searches notes shared across the whole company — check
         it before debugging something that may already have been solved.

  GET    /x/mentions                    where THIS PERSON was asked, ACROSS ALL projects
         Mentions in comments, chat and notes, plus tasks assigned to them.
         CHECK THIS BEFORE /x/inbox. "Someone closed their own task" and "a
         person asked me a question and is waiting" are events of different
         weight, and in one shared list the second drowns in the first — a
         question sitting in a comment took three calls to find.
         ?unread=0 includes answered ones, ?since=<ISO> only newer ones.

  GET    /x/inbox                       what concerns this person, ACROSS ALL projects
  POST   /x/inbox/read                  {"ids":[...]}, {"all":true}, or
         {"entityType":"task","entityId":"<id>"} to clear every notification about
         one task at once — the id you already have, instead of collecting theirs.
         Each item has whatIsAsked (AI-written), project.id, entityType/entityId
         and a ready "url". Start every "check what's waiting for me" here.
         ?since=<ISO> asks only for what arrived after a moment you already saw,
         instead of pulling the last thirty and eyeballing them for new ones.

  POST   /x/projects                    {"name","about?","chatRules?"} — new project
  PATCH  /x/projects/<id>               {"name"?,"about"?,"chatRules"?,"color"?}
         Creating requires company admin/manager; the person you act for becomes
         the owner. Adding members and deleting a project are left to humans:
         the first hands out access to other people's data, the second cannot be
         undone. Ask them to do it in the app.
  GET    /x/files?project=<id>          POST multipart to upload
  GET    /x/resources?project=<id>      list; "canSeeSecrets" says whether the
                                        secrets under it are shared with you
  POST   /x/resources?project=<id>      {"name"?,"url"?,"description"?,"secrets"?,"viewers"?}
  PATCH  /x/resources/<id>?project=<id> {"name"?,"url"?,"description"?,"viewers"?}
         A resource is a link plus optional secrets under it. The link and the
         description are visible to the whole project; each SECRET is visible
         only to the people listed in "viewers", plus whoever created the
         resource. Do not list the author — they always see their own.
         Created through the bridge, a resource starts shared with NOBODY but
         its author. Name the people who need it in "viewers" (user ids from
         GET /x/members), or the human you made it for will not be able to
         open it. Changing "viewers" later is allowed only to the author.
         Before listing someone, check their "resources" level in
         GET /x/members: with "none" they never reach the card, and sharing a
         secret with them changes nothing — you would report access that does
         not exist. Owners and admins can raise it with
         PATCH /x/members/<userId> {"permissions":{"resources":"read"}};
         everyone else should name who is missing access rather than skip them
         quietly.
  DELETE /x/resources/<id>/secrets/<secretId>?project=<id>
         Remove one secret. PATCH only adds, so this is how a wrong label or a
         duplicated value gets undone without leaving the resource littered.

  POST   /x/disconnect                  close this tunnel when you are done

Example — what is on my plate across the company:

    for p in $(curl -s ${b}/x/projects -H 'authorization: Bearer <token>' | jq -r '.items[].id'); do
      curl -s "${b}/x/tasks?project=$p&assignee=me&status=todo" -H 'authorization: Bearer <token>'
    done
`
}
