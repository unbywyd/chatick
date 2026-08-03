import type { APIRoute } from 'astro'
import { LOCALES } from '../i18n'

// Карта сайта. Генерируем, а не держим файлом: список языков живёт в i18n.ts,
// и статическая копия разошлась бы с ним при первом же добавлении локали —
// молча, потому что никто не проверяет sitemap глазами.
//
// hreflang в каждой записи: без него поисковик считает переводы дублями и
// показывает случайный из них, а не тот, на котором человек ищет.

const SITE = 'https://chatick.com'

// Страницы вне локалей: одни и те же для всех языков.
const PAGES = ['/changelog', '/privacy', '/terms']

// Страница интеграции есть на всех языках — как и главная.
const LOCALIZED = ['/integration']

export const GET: APIRoute = () => {
  const entries = [
    ...LOCALES.map((l) => ({ url: `${SITE}${l.path}`, priority: l.code === 'en' ? '1.0' : '0.9' })),
    ...LOCALES.flatMap((l) =>
      LOCALIZED.map((page) => ({
        url: `${SITE}${l.code === 'en' ? '' : `/${l.code}`}${page}`,
        priority: '0.8',
      })),
    ),
    ...PAGES.map((p) => ({ url: `${SITE}${p}`, priority: '0.4' })),
  ]

  const alternates = LOCALES.map(
    (l) => `    <xhtml:link rel="alternate" hreflang="${l.code}" href="${SITE}${l.path}"/>`,
  ).join('\n')

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${entries
  .map(
    (e) => `  <url>
    <loc>${e.url}</loc>
    <priority>${e.priority}</priority>
${e.url.includes('/changelog') || e.url.includes('/privacy') || e.url.includes('/terms') ? '' : `${alternates}\n    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE}/"/>\n`}  </url>`,
  )
  .join('\n')}
</urlset>
`

  return new Response(body, { headers: { 'content-type': 'application/xml; charset=utf-8' } })
}
