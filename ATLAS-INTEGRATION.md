# Atlas ↔ Chatick integration

Working document for the Atlas side of the integration. Written for whoever
implements it in Atlas — and for the AI assistant working in that repository.

Everything here reflects what is deployed as of 2026-08-04. Endpoint paths,
scope names, header names and limits were read from the source, not from
memory. Where something is not built yet, it says so explicitly.

---

## 1. What the client asked for

Atlas is a company running its own management system. They approached us
wanting Chatick as the *collaboration layer* on top of it — not as a
replacement.

In their words, the requirements were:

1. **Their people log in through their system.** No separate Chatick account,
   no second password to manage.
2. **They own the user directory.** People are hired, moved and dismissed in
   Atlas. Chatick must follow, never lead.
3. **They own the projects.** Projects exist in Atlas — with deadlines,
   budgets and finance. Chatick receives them.
4. **They can read their own statistics** — hours worked, tasks, activity —
   to bill clients and pay salaries from their own system.
5. **Cross-links both ways**, so a person can jump from an Atlas project to
   the same project's chat and back.
6. **Push notifications to their system** when something happens in Chatick.

### The division of responsibility

This is the part worth keeping in mind, because it decides every design
question that follows:

| Atlas owns | Chatick owns |
| --- | --- |
| People (hiring, roles, dismissal) | Chat and discussion |
| Projects (creation, deadlines, finance) | Tasks and their status |
| Clients and billing | Time tracking |
| The org chart | Documents, notes, files, resources |

**Atlas is the source of truth for *who* and *what*. Chatick is the source of
truth for *how the work actually went*.**

When both sides can edit the same thing, the two lists drift apart — and the
failure is not cosmetic. Someone dismissed in Atlas keeps reading project
chat in Chatick because they were removed "in the wrong system". That is why
the write direction is deliberately one-way, and why the locks in §4 exist.

---

## 2. What we built on the Chatick side

All of this is deployed and live. Nothing below is a plan.

| Capability | Where it lives |
| --- | --- |
| External API (17 endpoints) | `apps/api/src/routes/ext.ts` |
| API keys — issue, scope, revoke | `apps/api/src/lib/company-key.ts` |
| Webhooks with HMAC signing and retry | `apps/api/src/lib/webhooks.ts` |
| One-time login links (SSO entry) | `apps/api/src/lib/enter-link.ts` |
| Company settings UI (keys, webhooks, links) | `apps/app/src/components/company/` |
| Locks: projects and members from outside only | `apps/api/src/lib/members-locked.ts` |
| Machine-readable API doc | `apps/landing/src/pages/integration.txt.ts` |
| Human-readable doc | `https://chatick.com/integration` |

### Quick reference

- **Base URL:** `https://api.chatick.com/api/v1/ext`
- **Auth header:** `Authorization: Bearer ck_live_...`
- **Scopes:** `users:write`, `projects:write`, `read:all`
- **Batch limit:** 500 users per call
- **Widget status check:** `GET /projects/:externalId/status` — one call, answers "integrated or not"
- **Webhook headers:** `x-chatick-event`, `x-chatick-timestamp`, `x-chatick-signature`
- **Webhook events:** `task.created`, `task.status_changed`, `task.assigned`, `time.logged`, `project.updated`

There is a plain-text version of the full API at
`https://chatick.com/integration.txt` — written specifically to be pasted into
an AI assistant's context. If you are an AI reading this document, fetch that
file too; it has request and response shapes for every endpoint.

---

## 3. What Atlas needs to build

In dependency order. Steps 1–3 are the minimum viable integration; 4–6 make it
feel native.

### Step 1 — Get a key

A Chatick company admin creates it in **Company settings → API keys**. Grant
only the scopes Atlas actually uses.

The key is shown **once**, at creation. We store only a SHA-256 hash — we
cannot recover it later, and neither can we. Losing it means issuing a new one.

Treat it as a server-side secret. It grants access to the whole company: never
put it in browser code, a mobile app, or a public repository.

### Step 2 — Push the user directory

```http
POST /api/v1/ext/users/batch
Authorization: Bearer ck_live_...
Content-Type: application/json

{
  "users": [
    {
      "externalId": "atlas-448",
      "email": "tal@atlas.co.il",
      "name": "Tal Levi",
      "projects": ["atlas-proj-12", "atlas-proj-31"]
    }
  ]
}
```

`externalId` is **your** identifier, and it is the anchor of the whole
integration. Send the same value every time for the same person. It is what
lets us match your records to ours without you storing our IDs.

The call is idempotent: sending the same user twice updates, it does not
duplicate. Run it on a schedule *and* on every change in Atlas — a nightly
full sync catches anything a missed webhook dropped.

Max 500 users per call. For the initial import, page through.

For a single user, `POST /api/v1/ext/users` takes the same object without the
array wrapper.

**Dismissal:** `DELETE /api/v1/ext/users/:externalId` removes them from the
company and every project in it. Call this the moment someone leaves Atlas —
this is the whole reason the locks in §4 exist.

### Step 3 — Push projects

```http
POST /api/v1/ext/projects
{
  "externalId": "atlas-proj-12",
  "name": "Client portal redesign",
  "about": "Optional description, up to 5000 chars"
}
```

Also idempotent by `externalId`. Use `PATCH /api/v1/ext/projects/:externalId`
to rename or update.

Membership is managed per project:

```http
POST   /api/v1/ext/projects/:externalId/members
DELETE /api/v1/ext/projects/:externalId/members/:externalUserId
```

### Step 4 — Seamless login (this is the SSO piece)

This is what the client meant by "log in through our system". There is no
OAuth handshake to implement; it is one server-side call.

```http
POST /api/v1/ext/users/:externalId/login-link
→ { "url": "https://app.chatick.com/#/enter?token=...", "expiresInSec": 300 }
```

The flow in Atlas:

1. A logged-in Atlas user clicks "Open chat".
2. Your **backend** calls the endpoint above (never the browser — that would
   expose the key).
3. You redirect the user to the returned `url`.
4. They land in Chatick already signed in.

The token is **single-use and valid for 5 minutes**. Generate it at the moment
of the click, not in advance. Do not email it, log it, or put it in a page
that gets cached.

Two mistakes to avoid: minting links for users who did not ask (each one is a
usable session), and treating the URL as stable (it is not — it burns on use).

### Step 5 — Read statistics back

For invoicing and payroll, from Atlas's own reports:

```http
GET /api/v1/ext/projects/:externalId/time?from=2026-07-01&to=2026-07-31
GET /api/v1/ext/users/:externalId/time?from=…&to=…
GET /api/v1/ext/projects/:externalId/tasks
GET /api/v1/ext/stats/summary
```

All read endpoints require the `read:all` scope and are scoped to your company
only.

### Step 6 — Receive webhooks

Configure the endpoint in **Company settings → Webhooks**. We deliver:

`task.created`, `task.status_changed`, `task.assigned`, `time.logged`,
`project.updated`

**Verify every delivery.** An unverified webhook endpoint is an open door for
anyone who guesses the URL:

```
signature = HMAC_SHA256(secret, "{timestamp}.{raw_body}")
```

Compare against the `x-chatick-signature` header using a constant-time
comparison. Reject anything where `x-chatick-timestamp` is more than a few
minutes old — that stops a captured request being replayed later.

Use the **raw request body** for the HMAC, not a re-serialized object. Parsing
and re-encoding JSON changes key order and whitespace, and the signature will
never match. This is the single most common integration bug.

Retries: 6 attempts with exponential backoff, up to ~2 hours. Return 2xx
quickly and process asynchronously; a slow endpoint looks like a failure and
gets retried.

---

## 3b. Building the integration widget inside Atlas

This is the concrete shape of what Atlas wants on its task page: an
unobtrusive "switch to Chatick" panel that becomes a "this project runs on
Chatick" panel once connected.

Everything below runs off the Chatick API. **Atlas stores nothing** — no
Chatick project ids, no user ids, no "is integrated" flag in its own database.
State lives here and is asked for.

### On page load — is this project connected?

```http
GET /api/v1/ext/projects/1178667/status
```

Not connected:

```json
{ "integrated": false, "externalId": "1178667" }
```

Connected:

```json
{
  "integrated": true,
  "project": { "id": "...", "name": "...", "slug": "..." },
  "memberCount": 7,
  "memberExternalIds": ["atlas-448", "atlas-71"],
  "url": "https://app.chatick.com/#/p/<id>"
}
```

Note it answers **200 in both cases**. A 404 would force the widget to read a
status code as data; this way it is just `if (res.integrated)`.

`memberExternalIds` are **Atlas's own identifiers**, so the widget can diff
against its own member list without ever storing a Chatick id.

### The wizard — two calls

```http
POST /api/v1/ext/projects
{ "externalId": "1178667", "name": "Dev tasks", "about": "..." }

POST /api/v1/ext/projects/1178667/members
{ "members": [ { "externalUserId": "atlas-448", "role": "member" } ] }
```

After these, `status` returns `integrated: true`. That is the signal to hide
the task list and render the connected panel.

### The connected panel — managing the team

```http
GET /api/v1/ext/projects/1178667/members
```

```json
{
  "members":   [ { "externalId", "email", "name", "avatarUrl", "role" } ],
  "available": [ { "externalId", "email", "name", "avatarUrl" } ]
}
```

`available` is everyone in the company who is **not** on this project yet —
exactly the "who could be added" list. Both come back in one request, so the
widget does no set arithmetic.

Add and remove with the same endpoints the wizard used:

```http
POST   /api/v1/ext/projects/1178667/members
DELETE /api/v1/ext/projects/1178667/members/atlas-448
```

### The "Open in Chatick" button

```http
POST /api/v1/ext/users/atlas-448/login-link
{ "externalProjectId": "1178667" }
→ { "url": "https://app.chatick.com/#/enter?token=…", "expiresInSec": 300 }
```

With `externalProjectId` the person lands **directly in that project's chat**,
already signed in. Without it, on the general screen.

Call this from the Atlas **backend** at the moment of the click, and redirect.
Never from the browser — that would put the company key in client code.

### Does the members lock (§4) block this widget?

**No, and this is worth being clear about.** The lock stops team edits *inside
Chatick*. The widget talks through the external API using the company key — it
*is* the external system. Turning the lock on is what makes Atlas the single
place where team changes happen, and this widget is that place.

---

## 4. The locks — read this before turning them on

Two settings in **Company settings → Integration**. Both are **off by
default**, and both are enforced server-side on every endpoint, not by hiding
buttons in the UI.

### "Projects come from the external system"

Removes project creation from Chatick entirely. Projects appear only via
`POST /api/v1/ext/projects`.

### "People come from the external system"

The team stays **visible** in Chatick — everyone sees who is on a project. But
adding, removing, changing roles, editing permissions and inviting are all
refused. Membership changes only through the API.

Affected endpoints return `403` with:

```json
{ "error": "Team is managed by your external system. Add or remove people there." }
```

**Why server-side matters.** Hiding buttons is not a lock. The same endpoints
are reachable from `curl` and from Chatick's own AI bridge. Both loopholes
existed and were found by the completeness tests: the AI assistant could add
people, and it could create projects in defiance of the projects lock. Both
are closed, and the tests now name the specific unguarded endpoint if a future
change reopens one.

**Turn these on only after Atlas is reliably pushing data.** With the locks on
and no working sync, nobody can add anyone anywhere. Recommended order: get
steps 2–3 working, verify a few days of syncing, then enable.

---

## 5. Where to look in the Chatick repo

For whoever needs to change something on our side.

| What | File |
| --- | --- |
| All external endpoints | `apps/api/src/routes/ext.ts` |
| Key issue / verify / revoke | `apps/api/src/lib/company-key.ts` |
| Webhook queue, signing, retry | `apps/api/src/lib/webhooks.ts` |
| One-time login tokens | `apps/api/src/lib/enter-link.ts` |
| Membership lock helper | `apps/api/src/lib/members-locked.ts` |
| Company mail (own SMTP/SendGrid) | `apps/api/src/lib/company-mail.ts` |
| SSRF protection for outbound calls | `apps/api/src/lib/ssrf.ts` |
| Integration settings UI | `apps/app/src/components/company/IntegrationSettings.tsx` |
| API keys UI | `apps/app/src/components/company/ApiKeysTab.tsx` |
| Webhooks UI | `apps/app/src/components/company/WebhooksSettings.tsx` |
| Company mail UI | `apps/app/src/components/company/MailSettings.tsx` |
| Full API spec | `SPEC-INTEGRATION.md` |
| Security notes | `SECURITY.md` |

Tests worth knowing about, in `apps/api/src/lib/`:

- `security.test.ts` — SSRF ranges, webhook signature tampering, open redirects
- `members-locked.test.ts` — verifies the lock is present at *every* mutation
  point, by scanning the route sources
- `company-mail.test.ts` — secret handling, no key leakage into request bodies
- `support-login.test.ts` — the support login path cannot be turned into a backdoor

Run them with `pnpm --filter @chatick/api exec vitest run`.

Note the deliberate exception: `ext.ts` is **not** subject to the membership
lock. It is the external system — it is the thing allowed to write.

---

## 6. Other things worth telling Atlas

### Email from their own domain

Chatick can send all mail from Atlas's domain instead of ours — own SMTP server
or SendGrid. **Company settings → Company email.**

Worth raising with them: a message about Atlas's internal work arriving "from
Chatick" reads as phishing to their staff, and it lands in spam more often,
because our domain's SPF/DKIM say nothing about their address.

Credentials are encrypted (AES-256-GCM) and never returned by the API — the UI
only shows whether a secret is set. There is a "send test" button that reports
the actual failure reason, so a typo in a password gets caught by the admin
rather than by employees who quietly stop receiving mail.

### Company language

Set in company settings; projects inherit it. Emails to people who have no
personal preference yet — for instance someone just created through the API —
go out in the company's language. Hebrew and RTL are supported throughout.

### Company branding

Company logo and name replace Chatick's in the header, so their people see
their own brand.

---

## 7. Not built yet

Being explicit so nobody plans around something that does not exist:

- **No inbound webhooks.** Chatick does not receive events *from* Atlas. Atlas
  pushes changes by calling the API. If they need event-driven sync in that
  direction, it has to be built.
- **No task write API.** Tasks are created and managed inside Chatick; the
  external API can only read them. If Atlas wants to create tasks from their
  side, that is new work.
- **No activity-log endpoint.** `GET /projects/:id/activity` appears in the
  original spec but was never built.
- **Webhook events are limited to the five listed.** Adding more is small work
  in `webhooks.ts`, but they do not exist today.
- **No IP allowlist on API keys.** A leaked key works from anywhere until it is
  revoked. Revocation is immediate, in the keys UI.

---

## 8. Suggested rollout

1. Issue a key with `users:write` and `projects:write` only. Add `read:all`
   when they get to reporting.
2. Push a handful of test users and one project. Confirm they appear.
3. Wire the login link and click through it end to end.
4. Backfill the full directory (paged, 500 at a time).
5. Run the sync for a few days. Watch for drift.
6. **Then** enable the two locks.
7. Add webhooks and reporting last — they are read-side, and nothing depends
   on them.

Do not enable the locks before step 5 is genuinely stable. Everything else is
reversible; a locked company with a broken sync is a company where nobody can
add anyone.
