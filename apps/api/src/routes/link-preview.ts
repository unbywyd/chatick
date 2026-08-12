import { Hono, type Context } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { companies, credentials, files, notes, projects, tasks, releases } from '../db/schema.js'
import { parseShortPath, resolveShortCode } from '../lib/short-links.js'

/**
 * Превью ссылки на проект для мессенджеров (Open Graph).
 *
 * Ссылками на проект и задачу зовут коллег — это основной способ. В WhatsApp
 * и Telegram такая ссылка выглядела одинаково для всех проектов: «Chatick,
 * app.chatick.com». По ней не понять, куда зовут, и в переписке из десяти
 * ссылок они неразличимы.
 *
 * Почему это не решается статикой: адрес у нас хэшевый (/#/c/…/p/…), а всё
 * после «#» браузер серверу НЕ отправляет. Значит, сервер, отдающий index.html,
 * про проект ничего не знает и знать не может. Поэтому мессенджеров пускаем на
 * отдельный путь БЕЗ решётки, где проект виден серверу.
 *
 * Что раскрываем: имя и логотип проекта. Их увидит любой, кому переслали
 * ссылку, и серверы мессенджеров — они скачивают превью без чьей-либо сессии.
 * Это осознанный размен: без имени превью бесполезно. Ничего сверх имени —
 * ни задач, ни участников, ни описания — сюда не попадает.
 */
export const linkPreviewRoute = new Hono()

const APP = () => (process.env.APP_PUBLIC_URL || 'https://app.chatick.com').replace(/\/$/, '')
const API = () => (process.env.API_PUBLIC_URL || 'https://api.chatick.com').replace(/\/$/, '')


/**
 * Язык страницы перехода — по заголовку браузера.
 *
 * Своей сессии здесь нет и быть не может: по короткой ссылке приходят и те,
 * кто не входил. Accept-Language — единственное, что о человеке известно.
 */
function labels(c: Context) {
  const raw = (c.req.header('accept-language') || '').toLowerCase()
  const lang = raw.startsWith('he') || raw.includes(',he') ? 'he' : raw.startsWith('ru') || raw.includes(',ru') ? 'ru' : 'en'
  return {
    open: { en: 'Open', ru: 'Открыть', he: 'פתחו' }[lang],
    hint: {
      en: 'Redirecting you now…',
      ru: 'Сейчас переведём…',
      he: 'מעבירים אתכם…',
    }[lang],
  }
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * Вкладка проекта — в подпись превью, чтобы «задачи» и «файлы» различались.
 * Незнакомое слово в подпись не пускаем: путь приходит снаружи.
 */
const TABS: Record<string, string> = {
  tasks: 'Tasks',
  chat: 'Chat',
  files: 'Files',
  docs: 'Documents',
  documents: 'Documents',
  notes: 'Notes',
  resources: 'Resources',
  time: 'Time',
  history: 'History',
}

// Хвост произвольной длины: адреса бывают и /tasks, и /tasks/<id>, и
// /files/<id>. Ловим всё под проектом — иначе ссылка на конкретную задачу
// (а ими и делятся чаще всего) мимо превью проходила бы молча.
linkPreviewRoute.get('/c/:companyId/p/:projectId', render)
linkPreviewRoute.get('/c/:companyId/p/:projectId/*', render)

/**
 * Короткая ссылка: /t-AbC12.
 *
 * Отдаёт то же превью, что и длинная, — иначе ради компактности пришлось бы
 * терять название задачи в мессенджере, а это половина смысла ссылки.
 *
 * Доступ не выдаётся: адрес назначения обычный, и дальше решают права.
 */
linkPreviewRoute.get('/:short{[a-z]-[2-9a-zA-Z]{4,12}}', async (c) => {
  const parsed = parseShortPath(c.req.param('short'))
  if (!parsed) return c.notFound()

  const link = await resolveShortCode(parsed.type, parsed.code)
  // Ссылки нет или сущность удалили вместе с проектом — ведём в приложение,
  // а не показываем 404: человек хотя бы попадёт туда, где сможет искать.
  if (!link) return renderCard(c, null, null, `${APP()}/`)

  const project = await db.query.projects.findFirst({ where: eq(projects.id, link.projectId) })
  if (!project) return renderCard(c, null, null, `${APP()}/`)

  const title = await titleOf(link.entityType, link.entityId)
  const path = `/c/${project.companyId}/p/${project.id}/${TAB_OF[link.entityType] ?? 'tasks'}/${link.entityId}`
  // Та же ступенька, что у длинной ссылки: логотип проекта, иначе компании,
  // иначе значок приложения.
  const company = await db.query.companies.findFirst({ where: eq(companies.id, project.companyId) })
  const image = project.logoKey
    ? `${API()}/api/v1/projects/${project.id}/logo`
    : company?.logoKey
      ? `${API()}/api/v1/companies/${company.id}/logo`
      : `${APP()}/logo.png`
  return renderCard(c, project, title, `${APP()}/#${path}`, undefined, image)
})

/** Куда ведёт сущность внутри проекта. */
const TAB_OF: Record<string, string> = {
  task: 'tasks',
  file: 'files',
  note: 'notes',
  resource: 'resources',
  message: 'chat',
  document: 'docs',
  release: 'releases',
}

/**
 * Название сущности для превью.
 *
 * Ровно столько, сколько уже раскрывает длинная ссылка: имя. Ни описания, ни
 * исполнителей, ни статуса — превью читают серверы мессенджеров без чьей-либо
 * сессии, и всё лишнее здесь утекает всем, кому переслали ссылку.
 */
async function titleOf(type: string, id: string): Promise<string | null> {
  switch (type) {
    case 'task': {
      const r = await db.query.tasks.findFirst({ where: eq(tasks.id, id) })
      return r ? `${r.number} ${r.title}` : null
    }
    case 'file': {
      const r = await db.query.files.findFirst({ where: eq(files.id, id) })
      return r?.name ?? null
    }
    case 'note': {
      const r = await db.query.notes.findFirst({ where: eq(notes.id, id) })
      return r?.title ?? null
    }
    case 'resource': {
      const r = await db.query.credentials.findFirst({ where: eq(credentials.id, id) })
      return r?.name ?? null
    }
    case 'release': {
      const r = await db.query.releases.findFirst({ where: eq(releases.id, id) })
      // Тип сборки в заголовке: «1.4.0» без платформы ничего не говорит, а
      // версий с одним номером на iOS и Android бывает две.
      return r ? `${r.version} (${r.buildType})` : null
    }
    default:
      return null
  }
}

async function render(c: Context) {
  const projectId = c.req.param('projectId') ?? ''
  const project = projectId
    ? await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
    : null

  // Проекта нет — отдаём обычную карточку приложения, а не 404: ссылка могла
  // устареть, и «страница не найдена» в превью пугает сильнее, чем помогает.
  const company = project ? await db.query.companies.findFirst({ where: eq(companies.id, project.companyId) }) : null

  const title = project ? project.name : 'Chatick'
  // Путь БЕЗ префикса монтирования: c.req.path отдаёт «/link/c/…», а человеку
  // нужен адрес внутри приложения — «/c/…». С префиксом ссылка из превью
  // никуда не ведёт, и заметить это можно только открыв её.
  const appPath = c.req.path.replace(/^\/link/, '')
  // Вкладка — сегмент сразу после проекта: /c/<c>/p/<p>/<tab>[/<id>].
  const tabSeg = appPath.split('/')[5] ?? ''
  const tab = TABS[tabSeg.split('?')[0]!.toLowerCase()]
  const subtitle = project
    ? [company?.name, tab].filter(Boolean).join(' · ') || 'Project workspace'
    : 'Team chat and project workspace'
  // Картинка: свой логотип проекта → логотип компании → значок приложения.
  //
  // Компания в середине не для полноты: логотип есть далеко не у каждого
  // проекта, а у компании обычно есть. Без этой ступеньки превью почти всегда
  // показывало значок Chatick — то есть ровно то, ради чего всё и делалось,
  // не работало: узнать, куда зовут, по картинке было нельзя.
  //
  // Оба логотипа отдаются публично и кэшируются: мессенджер заберёт их без
  // сессии. Запасной файл проверен на живом сайте — у SPA несуществующий путь
  // отдаёт index.html с кодом 200, и «картинка» молча оказывается страницей.
  const image = project?.logoKey
    ? `${API()}/api/v1/projects/${projectId}/logo`
    : company?.logoKey
      ? `${API()}/api/v1/companies/${company.id}/logo`
      : `${APP()}/logo.png`

  // Куда идти человеку: тот самый хэшевый адрес. Мессенджер показывает
  // превью, а по нажатию открывается приложение на нужном месте.
  const target = `${APP()}/#${appPath}`

  return renderCard(c, project ?? null, null, target, subtitle, image)
}

/**
 * Одна карточка на оба вида ссылок — длинную и короткую.
 *
 * Разметка превью раньше жила только в render(). Короткая ссылка со своей
 * копией означала бы, что теги однажды разойдутся, а заметно это станет лишь
 * в чужом мессенджере, где мы ничего не увидим.
 */
function renderCard(
  c: Context,
  project: { id: string; name: string; companyId: string; logoKey: string | null } | null,
  entityTitle: string | null,
  target: string,
  subtitleOverride?: string,
  imageOverride?: string,
) {
  // Название сущности впереди: в списке ссылок человек ищет задачу, а не
  // проект — проект уходит в подпись.
  const title = entityTitle || project?.name || 'Chatick'
  const subtitle =
    subtitleOverride ?? (entityTitle && project ? project.name : project ? 'Project workspace' : 'Team chat and project workspace')

  // Картинку выбирает вызывающий: у длинной ссылки есть ступенька «логотип
  // компании», без которой превью почти всегда показывало бы значок Chatick.
  const image = imageOverride ?? (project?.logoKey ? `${API()}/api/v1/projects/${project.id}/logo` : `${APP()}/logo.png`)
  const { open: OPEN_LABEL, hint: REDIRECT_HINT } = labels(c)

  c.header('Content-Type', 'text/html; charset=utf-8')
  c.header('Cache-Control', 'public, max-age=3600')
  return c.body(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<meta property="og:type" content="website">
<meta property="og:site_name" content="Chatick">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(subtitle)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:url" content="${esc(target)}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(subtitle)}">
<meta name="twitter:image" content="${esc(image)}">
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="0; url=${esc(target)}">
<link rel="canonical" href="${esc(target)}">
</head>
<style>
  /* Страницу видно долю секунды, но видно всегда — по короткой ссылке человек
     проходит именно здесь. Голая синяя ссылка на белом фоне читалась как
     сломанная страница, а не как переход. */
  :root { color-scheme: dark }
  * { box-sizing: border-box }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    background: #0e0f0c; color: #f4f5f0;
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  }
  .card { width: 100%; max-width: 420px; text-align: center }
  .logo { width: 46px; height: 46px; margin: 0 auto 18px }
  /* Название задачи бывает на иврите вперемешку с латиницей — направление
     отдаём браузеру, иначе строка рассыпается. */
  .name {
    margin: 0 0 6px; font-size: 17px; font-weight: 700; unicode-bidi: plaintext;
    overflow-wrap: anywhere;
  }
  .sub { margin: 0 0 22px; color: #8a8f7e; font-size: 13.5px; unicode-bidi: plaintext }
  .spin {
    width: 22px; height: 22px; margin: 0 auto 18px; border-radius: 50%;
    border: 2px solid rgba(255,255,255,.14); border-top-color: #d4f228;
    animation: sp .7s linear infinite;
  }
  @keyframes sp { to { transform: rotate(360deg) } }
  /* Анимация — украшение, а не смысл: тем, кто просил её отключить, крутиться
     не будет, а страница всё равно уедет сама. */
  @media (prefers-reduced-motion: reduce) { .spin { animation: none } }
  .go {
    display: inline-flex; align-items: center; justify-content: center;
    min-height: 42px; padding: 10px 22px; border-radius: 999px;
    background: #d4f228; color: #1c2003; font-weight: 700; text-decoration: none;
  }
  .hint { margin-top: 14px; font-size: 12.5px; color: #8a8f7e }
</style>
</head>
<body>
<div class="card">
  <svg class="logo" viewBox="0 0 48 48" fill="none" aria-hidden="true">
    <path d="M24 4C12.4 4 3 12.7 3 23.5c0 5.4 2.4 10.3 6.2 13.8L8 44l8.4-3.2c2.4.7 4.9 1.2 7.6 1.2 11.6 0 21-8.7 21-19.5S35.6 4 24 4Z" stroke="#f4f5f0" stroke-width="4" stroke-linejoin="round"/>
    <path d="M15 24.5 21 30l12-12" stroke="#d4f228" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
  <div class="spin"></div>
  <p class="name">${esc(title)}</p>
  <p class="sub">${esc(subtitle)}</p>
  <!-- Кнопка не запасной вариант, а основной путь для тех, у кого скрипты
       отключены: без неё они упрутся в страницу, которая никуда не ведёт. -->
  <a class="go" href="${esc(target)}">${esc(OPEN_LABEL)}</a>
  <p class="hint">${esc(REDIRECT_HINT)}</p>
</div>
<script>location.replace(${JSON.stringify(target)})</script>
</body>
</html>`)
}
