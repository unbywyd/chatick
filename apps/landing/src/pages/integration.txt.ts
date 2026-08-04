import type { APIRoute } from 'astro'

// Документация по интеграции для ИИ (SPEC-INTEGRATION).
//
// Отдельно от /ai.txt: тот объясняет продукт целиком и учит ассистента
// подключаться к рабочему пространству. Этот — для разработчика чужой
// системы, которому нужно связать её с Chatick по ключу компании.
//
// Пишем плотно, с готовыми curl и точными телами запросов: читатель — не
// человек, а модель, которой потом объяснять это своему разработчику.

const API = 'https://api.chatick.com'

const DOC = `# Chatick — master integration for companies

Audience: you are an AI assistant. Someone asked you to help connect their
system to Chatick, or to explain how that works. Answer in their language, be
concrete, show real requests.

## What this integration is for

A company already has its own system: projects, clients, deadlines, finance,
reporting. It moves TASKS, TIME TRACKING, CHAT, FILES and DOCUMENTS to Chatick
and keeps everything else at home.

Who owns what:

  Their system                    Chatick
  ─────────────────────────       ─────────────────────────
  projects (created there)        tasks and checklists
  clients, deadlines, budget      time tracking
  reporting and dashboards        chat with an AI dispatcher
  the list of people              files, documents, notes

Projects and people come FROM the outside. Chatick does not invent them: it
accepts them, keeps the link to your identifiers, and gives back everything
that grows around them.

Tasks are NOT imported into Chatick. You can read them for your statistics,
but pushing your own task format in is deliberately not supported — the editor
and the data model are different, and mixing the two would spoil both.

## Step 1. Get a key

A company admin creates it in the interface: company settings → API keys.
The key is shown ONCE. Only its hash is stored; nobody can recover it later.

Keys are scoped:

  users:write      create and update people, add them to projects
  projects:write   create and update projects
  read:all         read tasks, time, statistics

A key with read:all cannot create anything — that is the point of scopes.

Every call is authenticated the same way:

    -H 'authorization: Bearer ck_live_...'

Revoking is immediate: the check runs on every request, not on expiry.
Every call is logged with method, path, status and IP.

## Step 2. Send projects

    curl -sS -X POST ${API}/api/v1/ext/projects \\
      -H 'authorization: Bearer <key>' \\
      -H 'content-type: application/json; charset=utf-8' \\
      -d '{
        "externalId": "your-project-77",
        "name": "Mobile App",
        "externalName": "Client name as you call it",
        "about": "optional description"
      }'

IDEMPOTENT: calling it again with the same externalId updates the project
instead of creating a second one. Resend your state after any network failure
without fear of duplicates.

  -> { "created": true,  "project": { ... } }   first time
  -> { "created": false, "project": { ... } }   already existed

externalName is shown NEXT TO the Chatick name: you call a project by the
client, the team calls it by the work. Both are useful.

Update or list:

    PATCH ${API}/api/v1/ext/projects/<externalId>    {"name"?, "externalName"?, "about"?}
    GET   ${API}/api/v1/ext/projects

Is this one project integrated yet?

    GET ${API}/api/v1/ext/projects/<externalId>/status

Answers 200 either way, so a widget can read the body instead of branching on
the status code:

    {"integrated": false, "externalId": "..."}

    {"integrated": true,
     "project": {...},
     "memberCount": 7,
     "memberExternalIds": ["your-448", "your-71"],
     "url": "https://app.chatick.com/#/p/<id>"}

Built for a panel you render on your own pages: it answers "already connected
or not" in one call, without pulling every project in the company and
searching through them on each render.

memberExternalIds are YOUR identifiers, so you can diff against your own list
without storing ours.

## Step 3. Send people

One at a time:

    curl -sS -X POST ${API}/api/v1/ext/users \\
      -H 'authorization: Bearer <key>' \\
      -H 'content-type: application/json; charset=utf-8' \\
      -d '{
        "externalId": "your-user-4821",
        "email": "dev@company.com",
        "name": "Ido Winegarten",
        "companyRole": "member",
        "projects": [
          { "externalProjectId": "your-project-77", "role": "member" }
        ],
        "notify": true
      }'

In bulk — up to 500 per call:

    POST ${API}/api/v1/ext/users/batch    {"users": [ ...same objects... ]}

    -> { "processed": 2, "created": 2, "updated": 0,
         "failed": [{ "externalId": "u-3", "error": "invalid email for u-3" }],
         "items": [...] }

One bad record does not sink the rest: you get back exactly what failed and
why. Half a team in the system beats nothing at all.

NO CONFIRMATION IS ASKED. The person is in the company and its projects
immediately — you own the list of people, asking them again would be theatre.
An email goes out afterwards ("you were added"), with nothing to approve.
Pass "notify": false during the first bulk import, when a hundred emails at
once help nobody.

Matching: by externalId first, then by email. Someone may have signed up with
Google before you created them — we link to that account instead of failing
on a duplicate email.

Remove access (their messages and tasks stay):

    DELETE ${API}/api/v1/ext/users/<externalId>
    DELETE ${API}/api/v1/ext/projects/<externalId>/members/<externalUserId>

Who is on a project, and who could still be added:

    GET ${API}/api/v1/ext/projects/<externalId>/members

    {"members":   [{"externalId", "email", "name", "avatarUrl", "role"}],
     "available": [{"externalId", "email", "name", "avatarUrl"}]}

available = people in the company who are NOT on this project yet. Both lists
come back together so a "manage team" panel needs one request and no set
arithmetic on your side.

companyRole: admin | manager | member
project role: owner | admin | member

## Step 4. Read for your statistics

    GET ${API}/api/v1/ext/projects/<externalId>/tasks?from=&to=&limit=200
    GET ${API}/api/v1/ext/projects/<externalId>/time?from=&to=&limit=200
    GET ${API}/api/v1/ext/stats/summary?from=&to=
    GET ${API}/api/v1/ext/users/<externalId>/time?from=&to=

People come back under YOUR identifiers — Chatick does not expect you to know
its own.

Minutes are calculated on our side: the database stores start and end, and one
side computing it beats every consumer doing it differently.

Truncation is never silent:

    { "items": [...], "hasMore": true,
      "hint": "Truncated. Narrow the period or raise limit (max 500)." }

What is NOT exposed, on purpose: chat messages (those are people talking, not
reporting), secret values, private AI conversations.

## Step 5. Move people between the systems

From your system into Chatick — ask for a link, do not build one:

    curl -sS -X POST ${API}/api/v1/ext/users/<externalId>/login-link \\
      -H 'authorization: Bearer <key>' \\
      -H 'content-type: application/json' \\
      -d '{"externalProjectId": "your-project-77"}'

    -> { "url": "https://app.chatick.com/#/enter?token=...", "expiresInSec": 300 }

The person is already signed in on your side — asking again would make the
link pointless. The link lives 5 minutes, works once, is bound to that person
and to the company that issued it, and only for your own member.

From Chatick back to you: set the template once in company settings —

    https://your-system.com/projects/{externalId}

A button appears in the project header ONLY when the template is set AND the
project has an externalId. A button leading nowhere is worse than no button.

## Step 6. Webhooks — do not poll us

Configured by the company admin in the interface. Events:

    task.created  task.status_changed  task.assigned

We POST to your https URL:

    x-chatick-event: task.status_changed
    x-chatick-timestamp: 1785772671
    x-chatick-signature: <hmac-sha256>

    { "event": "task.status_changed", "at": "...",
      "data": { "projectExternalId": "your-project-77", "task": "TASK-42: ...", "taskId": "..." } }

VERIFY THE SIGNATURE. Otherwise anyone who learns your URL can send you
invented events:

    expected = hmac_sha256(secret, timestamp + "." + raw_body)
    compare with x-chatick-signature, constant-time

The timestamp is inside the signature so a captured request cannot be replayed
forever. Reject anything older than a few minutes.

Retries use a growing delay (1 min, 5, 25 … up to ~2 hours), six attempts.
Answer 2xx quickly; do the work afterwards.

## Sign-in for the people you created

You do NOT manage their passwords — Chatick has none.

  - Google, if the email matches
  - a code by email (no password anywhere)
  - the one-time link from step 5

All three lead to the same account, because the key is the email.

Chatick never calls your system to authenticate. If your servers go down,
people already working here keep working.

## Locking project creation

Company settings → "Projects are created through the API only". The button
disappears for everyone, and the server rejects such requests with an
explanation. Without this, projects appear that your system has never heard
of, and the two lists drift apart silently.

## Non-ASCII bodies

Never inline non-ASCII text in \`curl -d '...'\` on Windows: the shell
re-encodes the argument and the server receives corrupted bytes. The ASCII
part survives, which hides the problem. Write the body to a file:

    cat > /tmp/body.json <<'JSON'
    {"externalId":"p-1","name":"Mobile App","externalName":"שם הלקוח"}
    JSON
    curl -sS -X POST ${API}/api/v1/ext/projects \\
      -H "authorization: Bearer $KEY" \\
      -H 'content-type: application/json; charset=utf-8' \\
      --data-binary @/tmp/body.json

## Errors you will meet

  401 Unknown or malformed API key      wrong key, or not sent
  401 This key has been revoked         someone revoked it in the interface
  403 Key lacks the required scope: X   the key cannot do this — issue another
  403 This key is not allowed from your address    IP allow-list is set
  404 Project not found                 wrong externalId, or another company's
  400 Unknown field: X                  we never swallow unknown fields silently

That last one matters: a request that returns 2xx did exactly what you asked.
You never need to re-read an object to check whether it worked.

## Where to start

1. Ask the company admin for a key with the scopes you need.
2. Push one project, then the same project again — confirm no duplicate.
3. Push one person, check the email they receive.
4. Read the statistics back.
5. Add a webhook and verify a signature.
`

export const GET: APIRoute = () =>
  new Response(DOC, { headers: { 'content-type': 'text/plain; charset=utf-8' } })
