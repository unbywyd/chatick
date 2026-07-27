# Deploy

Chatick is a pnpm + Turbo monorepo with three deployable parts:

| App | What it is | Where it ends up |
|---|---|---|
| `apps/api` | Hono + Drizzle + Postgres | a Node process behind a reverse proxy |
| `apps/app` | Vite + React SPA | static files |
| `apps/landing` | Astro | static files |

Everything specific to a particular server — hostnames, ports, credentials —
lives in the environment, not in this file.

## Requirements

- Node 22+
- pnpm 10+
- PostgreSQL 15+
- An S3-compatible bucket (Cloudflare R2 works) for files and avatars
- An SMTP account for invitations, digests and notifications

## Configuration

Copy `apps/api/.env.example` to `apps/api/.env` and fill it in. The required
values are the database URL, `JWT_SECRET` and `ENCRYPTION_KEY`; the rest enable
optional pieces — Google sign-in, the AI dispatcher, file storage, email.

```bash
# a 32-byte key, hex-encoded
openssl rand -hex 32
```

The web app reads `VITE_API_URL` at build time — set it before building, or the
app will look for the API on localhost.

## Build

```bash
pnpm install
pnpm --filter @chatick/api build
pnpm --filter @chatick/app build      # → apps/app/dist
pnpm --filter @chatick/landing build  # → apps/landing/dist
```

The landing build fails on purpose when the version in `package.json` has no
entry in `CHANGELOG.md`. That is the guard which keeps a release from shipping
without a description — see `apps/landing/src/changelog.ts`.

## Database

Migrations are plain SQL under `apps/api/drizzle`, applied in the order listed
in `apps/api/drizzle/meta/_journal.json`:

```bash
psql "$DATABASE_URL" -f apps/api/drizzle/0001_....sql
```

Apply them in order on a fresh database. They are written to be re-runnable, so
applying one twice is harmless.

## Running the API

Any process manager will do. With PM2:

```bash
pm2 start apps/api/dist/server.js --name chatick-api
pm2 save
```

The API serves HTTP and a WebSocket on the same port. Whatever sits in front of
it must:

- pass WebSocket upgrades through to `/ws` and `/yjs`;
- allow long-lived connections (`proxy_read_timeout` well above the default) —
  chat, presence and collaborative documents depend on them;
- allow request bodies large enough for uploads (50 MB is a sensible ceiling).

## Serving the static parts

Point one virtual host at `apps/app/dist` and another at `apps/landing/dist`,
with an SPA-style fallback to `index.html` for the app.

Caching matters here. Hashed assets under `/assets/` and `/_astro/` can be
cached forever; `index.html` and `version.json` must not be cached at all, or
people keep running yesterday's build after a deploy:

```nginx
location ~* ^/(index\.html|version\.json)$ {
    add_header Cache-Control "no-cache, no-store, must-revalidate";
}
location ~* ^/(assets|_astro)/ {
    add_header Cache-Control "public, max-age=31536000, immutable";
}
```

## Desktop releases

`pnpm --filter @chatick/desktop dist` produces a Windows installer in
`apps/desktop/release`. The desktop shell loads the interface from the deployed
web app, so a new build is only needed when the shell itself changes.

Updates are served from a plain directory: upload the installer together with
`latest.yml` to wherever `build.publish.url` points, and installed copies pick
the update up on their own.

## Deploying an update

```bash
git pull
pnpm install
pnpm --filter @chatick/api build
pnpm --filter @chatick/app build
pnpm --filter @chatick/landing build
# apply any new migration
pm2 restart chatick-api
```

The static parts need no restart — the files are replaced in place.
