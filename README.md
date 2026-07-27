# Chatick

A team workspace where chat is the interface and an AI dispatcher does the
filing. Messages become tasks, questions get answered, and nobody has to
remember which of five tools a decision was written down in.

**[chatick.com](https://chatick.com)** · [Changelog](https://chatick.com/changelog)
· [Terms](https://chatick.com/terms) · [Privacy](https://chatick.com/privacy)

## What is in the box

Everything a small team actually uses, in one place:

- **Chat** with an AI dispatcher that summarises what is being asked of you,
  routes it, and can answer or act on its own.
- **Tasks** — list and table views, statuses, assignees, sprints, comments,
  reminders.
- **Time tracking** — a timer per task, reports per person and per period.
- **Documents** with collaborative editing, version history and public links.
- **Notes, files and resources**, including credentials that are encrypted
  before they reach the database.
- **Desktop application** for Windows with a tray panel, system notifications
  and a running timer at a glance.

Anything an AI assistant can reach over HTTP, it can do here too: create tasks,
change statuses, reply in chat, work through your notifications — without you
leaving your editor.

## Your data stays yours

Full export and import, at any time. The source is here, so if the hosted
service ever goes away — or you simply prefer your own servers — you can run the
whole thing yourself and lose nothing.

## Layout

```
chatick/
├── apps/
│   ├── api/       Hono + Drizzle + Postgres — REST, WebSocket, AI dispatcher
│   ├── app/       Vite + React 19 + Tailwind v4 — the application
│   ├── desktop/   Electron shell (tray, system notifications, timer)
│   └── landing/   Astro — the public site, three languages
├── CHANGELOG.md   every release, and the build refuses to skip it
└── DEPLOY.md      how to run it yourself
```

## Getting started

```bash
pnpm install
cp apps/api/.env.example apps/api/.env   # fill in the required values
pnpm api db:migrate
pnpm dev                                 # everything at once
```

Individually:

```bash
pnpm api dev        # API only        → :3200
pnpm app dev        # web app only    → :5173
pnpm desktop dev    # Electron over localhost:5173
pnpm landing dev    # the public site
```

You need Node 22+, pnpm 10+ and PostgreSQL. The AI features need an Anthropic
key; file uploads need an S3-compatible bucket. Both are optional — the rest of
the application works without them.

See [DEPLOY.md](./DEPLOY.md) for running it in production.

## Conventions

- Packages live under `@chatick/*` and are wired together with `workspace:*`.
- Secrets belong in `.env`, which is never committed.
- Database changes are plain SQL migrations under `apps/api/drizzle`, listed in
  `meta/_journal.json`.
- Every release is described in [CHANGELOG.md](./CHANGELOG.md) before it ships —
  the landing build fails when the version has no entry, so a release can never
  go out undocumented.

## Licence

[Business Source License 1.1](./LICENSE). In plain words: use it, modify it and
run it inside your own organisation freely, commercially and for any number of
people. The one thing you may not do is resell it to others as a hosted service.
On 2030-01-01 it converts to Apache 2.0.

## Who builds this

Chatick is built by an independent developer, also behind
[webtopro.com](https://webtopro.com) and [unbywyd.com](https://unbywyd.com).

Questions, bugs, ideas: [support@chatick.com](mailto:support@chatick.com).
