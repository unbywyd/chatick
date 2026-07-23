# Deploy — chatick-next на webtopro

> Сервер, доступы и правила безопасности: `.local-notes/SERVER.md` (не в git).
> Все команды на сервере — после `ssh myserver` и:
> ```bash
> export PATH=/root/.nvm/versions/node/v22.18.0/bin:$PATH
> export PM2_HOME=/root/.pm2
> ```

## Раскладка

| Что | Значение |
|---|---|
| Каталог | `/var/www/chatick-next` |
| PM2-процесс | `chatick-next-api` |
| Порт API | `3200` (3160 — старый chatick, 3180 — vexelkit) |
| БД | `chatick_next` на локальном Postgres `:55432`, юзер `chatick_next` |
| Домены | `api.chatick.com` → :3200; `app.chatick.com` → `apps/app/dist`; `cp.chatick.com` → админка (позже) |

## Этап 0 — потушить старый chatick (ничего не удалять!)

```bash
pm2 stop chatick-api      # именно stop, НЕ delete
pm2 save
```

- БД `chatick`, `chatick_shadow` — не трогать.
- `/var/www/chatick/monorepo` — не трогать.
- R2-бакеты `chatick-assets`, `chatick-private` — не трогать.
- nginx-вхосты перепишем на этапе 3 (старый конфиг сохранить: `cp /etc/nginx/sites-enabled/chatick.com /root/backup-nginx-chatick.com.$(date +%F)`).

## Этап 1 — БД

```bash
# под postgres-суперюзером (уточнить как заходить: sudo -u postgres psql -p 55432)
CREATE USER chatick_next WITH PASSWORD '<из .local-notes/CREDENTIALS.md>';
CREATE DATABASE chatick_next OWNER chatick_next;
```

## Этап 2 — код и процесс

```bash
mkdir -p /var/www/chatick-next && cd /var/www/chatick-next
git clone git@github.com:unbywyd/chatick-next.git .   # репо создать заранее
corepack enable && corepack prepare pnpm@10.28.2 --activate  # если ещё не
pnpm install

# .env: залить локальный apps/api/.env (с NODE_ENV=production, CORS_ORIGIN=https://app.chatick.com)
# .env.production для apps/app уже в репо (VITE_API_URL=https://api.chatick.com)

pnpm build
cd apps/api && pnpm db:migrate && cd ../..

cd apps/api
pm2 start pnpm --name chatick-next-api -- start
pm2 save
```

## Этап 3 — nginx

Правим `/etc/nginx/sites-enabled/chatick.com` (бэкап сделан на этапе 0):

- `api.chatick.com` → `proxy_pass http://127.0.0.1:3200;` (было 3160). Оставить `proxy_read_timeout 86400s` (SSE/WebSocket), `client_max_body_size 50M`.
- `app.chatick.com` → `root /var/www/chatick-next/apps/app/dist;` + `try_files $uri $uri/ /index.html;`
- `chat.chatick.com` → 301 на `app.chatick.com` (или 404) — поддомен освобождаем.
- `chatick.com` / `www` — пока оставить как есть (basic-auth заглушка старого лендинга) или 301 на app.
- `cp.chatick.com` — пока не трогаем; при готовности админки → `proxy_pass http://127.0.0.1:3201;`.

TLS-сертификаты уже покрывают все поддомены — перевыпуск не нужен.

```bash
nginx -t && systemctl reload nginx
```

## Этап 4 — smoke

```bash
curl -s https://api.chatick.com/health
curl -s -o /dev/null -w 'app: %{http_code}\n' https://app.chatick.com/
pm2 logs chatick-next-api --lines 50 --nostream
```

## Обновление прода (обычный цикл)

```bash
cd /var/www/chatick-next
git pull --ff-only
pnpm install          # если менялся pnpm-lock.yaml
pnpm build
cd apps/api && pnpm db:migrate && cd ../..   # если есть новые миграции
pm2 restart chatick-next-api --update-env
```

Только фронт: `pnpm --filter @chatick/app build` — nginx подхватит dist без рестарта.

## Откат на старый chatick (если что)

```bash
pm2 stop chatick-next-api
pm2 start chatick-api
# nginx: вернуть бэкап конфига, nginx -t && systemctl reload nginx
```
