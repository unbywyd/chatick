# @chatick/desktop

Electron-обёртка над `@chatick/app`.

## Dev

```bash
pnpm app dev        # поднять vite на :5173
pnpm desktop dev    # electron грузит localhost:5173
```

## Упаковка

```bash
pnpm app build                          # собрать веб-приложение
# скопировать apps/app/dist → apps/desktop/web
pnpm desktop dist                       # electron-builder → release/
```

Сборка `@chatick/app` использует `base: './'` и HashRouter — работает из `file://` без сервера.
