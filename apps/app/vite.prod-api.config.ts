import { defineConfig, mergeConfig } from 'vite'
import base from './vite.config'

/**
 * Локальный веб против БОЕВОГО API — проверить окно и панель трея десктопа
 * на своих данных, не трогая установленное приложение и не поднимая API.
 *
 * Зачем прокси. Боевой API пускает только свои адреса (CORS), и
 * http://localhost:<порт> в их число не входит: запросы со страницы падали бы
 * ещё на предварительном OPTIONS. Через прокси самого vite браузер ходит на
 * тот же адрес, откуда страница, — CORS не участвует вовсе.
 *
 * А локальный API (по умолчанию localhost:3200) брать нельзя: его .env
 * смотрит в боевую базу, и фоновые задачи заработали бы вторым экземпляром.
 *
 * Данные НАСТОЯЩИЕ: таймер, задачи, уведомления — те же, что в приложении.
 *
 *   npx vite --config vite.prod-api.config.ts                 → http://localhost:5173
 *   CHATICK_WEB_PORT=5199 npx vite --config vite.prod-api.config.ts
 *
 * Десктоп к нему: из apps/desktop — CHATICK_URL=http://localhost:5173 npx electron .
 */
const API = 'https://api.chatick.com'
const port = Number(process.env.CHATICK_WEB_PORT || 5173)

// Веб берёт адрес API из VITE_API_URL — направляем его на себя же, в прокси.
// process.env, а не define: vite сам подхватывает VITE_* из окружения.
process.env.VITE_API_URL = `http://localhost:${port}`

export default mergeConfig(
  base,
  defineConfig({
    // Свой кеш зависимостей: общий node_modules/.vite делил бы его с обычным
    // `vite`, и запуск этого конфига пересобирал бы зависимости соседнему
    // серверу, открытому рядом.
    cacheDir: 'node_modules/.vite-prod-api',
    server: {
      port,
      // Порт занят — падаем, а не уезжаем на соседний: адрес API уже вшит выше.
      strictPort: true,
      proxy: {
        '/api': { target: API, changeOrigin: true },
        '/files': { target: API, changeOrigin: true },
        // сокет уведомлений и задач
        '/ws': { target: API.replace(/^http/, 'ws'), ws: true, changeOrigin: true },
      },
    },
  }),
)
