# chatick-next

Проектное рабочее пространство, где чат — интерфейс, а ИИ — диспетчер.
Концепция: [CONCEPT.md](./CONCEPT.md) · Деплой: [DEPLOY.md](./DEPLOY.md)

## Структура

```
chatick-next/
├── apps/
│   ├── api/      Hono + Drizzle (postgres.js) — REST + (позже) MCP · порт 3170
│   ├── app/      Vite + React + Tailwind v4 + shadcn — основное приложение · :5173
│   ├── desktop/  Electron-обёртка над app (Win/Mac)
│   └── admin/    Next.js глобальная админка (последний этап) · :3171
├── packages/     (общие пакеты — по мере надобности)
├── pnpm-workspace.yaml
└── turbo.json
```

## Dev

```bash
pnpm install
pnpm dev                 # все приложения
pnpm api dev             # только API      (нужен apps/api/.env, см. .env.example)
pnpm app dev             # только клиент
pnpm desktop dev         # electron поверх localhost:5173

# БД
pnpm api db:generate     # сгенерить миграцию из schema.ts
pnpm api db:migrate      # применить миграции
pnpm api db:studio       # drizzle studio
```

## Конвенции

- Node ≥ 22, pnpm 10, Turbo.
- Пакеты в неймспейсе `@chatick/*`, шарятся через `workspace:*`.
- Секреты — только в `.env` (не коммитятся) и `.local-notes/` (gitignored).
- Прод: свой сервер, PM2 + nginx (см. DEPLOY.md). Локально не деплоим — только через git.
