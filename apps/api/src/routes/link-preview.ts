import { Hono, type Context } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { companies, projects } from '../db/schema.js'

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
  // Логотип проекта отдаётся публично и кэшируется — мессенджер заберёт его
  // без сессии. Нет своего — общий значок приложения.
  //
  // Имя файла проверено на живом сайте: у SPA любой несуществующий путь
  // отдаёт index.html с кодом 200, поэтому «картинка» молча оказывается
  // страницей, а превью выходит без изображения — и никакой ошибки при этом
  // не видно.
  const image = project?.logoKey ? `${API()}/api/v1/projects/${projectId}/logo` : `${APP()}/logo.png`

  // Куда идти человеку: тот самый хэшевый адрес. Мессенджер показывает
  // превью, а по нажатию открывается приложение на нужном месте.
  const target = `${APP()}/#${appPath}`

  c.header('Content-Type', 'text/html; charset=utf-8')
  // Превью мессенджеры кэшируют надолго; час — компромисс между «имя проекта
  // переименовали» и лишними запросами к нам.
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
