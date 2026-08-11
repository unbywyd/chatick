import { Hono, type Context } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { companies, credentials, files, notes, projects, tasks } from '../db/schema.js'
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
<body>
<!-- Человек сюда почти не попадает: мессенджер читает теги и ведёт по ссылке
     сам. Но если попал — редирект и обычная ссылка на случай, если он
     отключён. -->
<a href="${esc(target)}">${esc(title)}</a>
<script>location.replace(${JSON.stringify(target)})</script>
</body>
</html>`)
}
