import { assertPublic } from './ssrf.js'

// Иконка сайта для ресурса (SPEC §8.1).
//
// Ресурсы — это в основном ссылки, и глазами в списке ищут по картинке, а не
// по тексту: Figma, GitLab и Jira узнаются мгновенно. Берём og:image, если
// есть, иначе favicon.
//
// БЕЗОПАСНОСТЬ. Здесь сервер ходит по адресу, который назвал пользователь, —
// это SSRF. Без ограничений любой участник проекта смог бы нашими руками
// постучаться на 127.0.0.1:55432 или в метаданные облака (169.254.169.254) и
// прочитать то, что снаружи закрыто. Поэтому:
//   - только http/https;
//   - адрес резолвим САМИ и проверяем IP до запроса, а редиректы обходим
//     вручную — иначе публичный домен redirect'ом уводит во внутреннюю сеть;
//   - ответ ограничен по размеру и времени.

const MAX_ICON_BYTES = 200 * 1024
const MAX_HTML_BYTES = 512 * 1024
const TIMEOUT_MS = 5000
const MAX_REDIRECTS = 3

/** fetch с ручными редиректами: каждый прыжок проверяем заново. */
async function safeFetch(raw: string, accept: string): Promise<Response | null> {
  let url = raw
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      return null
    }
    try {
      await assertPublic(u)
    } catch {
      return null
    }

    const res = await fetch(u, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept, 'user-agent': 'Chatick/1.0 (+link preview)' },
    }).catch(() => null)
    if (!res) return null

    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location')
      if (!next) return null
      url = new URL(next, u).toString()
      continue
    }
    return res.ok ? res : null
  }
  return null
}

/** Читает тело, обрывая на лимите: заявленный content-length может лгать. */
async function readCapped(res: Response, limit: number): Promise<Buffer | null> {
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > limit) return null
  const chunks: Buffer[] = []
  let total = 0
  const reader = res.body?.getReader()
  if (!reader) return null
  for (;;) {
    const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }))
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > limit) {
      void reader.cancel()
      return null
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

const attr = (html: string, re: RegExp): string | null => html.match(re)?.[1]?.trim() || null

/**
 * Иконка сайта как data-URI, либо null.
 *
 * data-URI, а не файл в хранилище: картинка весит килобайты, а отдельный файл
 * притащил бы за собой presign, чистку и разное поведение при своём S3 —
 * несоразмерно ради favicon.
 */
export async function fetchSiteIcon(rawUrl: string): Promise<string | null> {
  let page: URL
  try {
    page = new URL(rawUrl)
  } catch {
    return null
  }

  const candidates: string[] = []

  // 1. og:image и <link rel=icon> из разметки страницы.
  const res = await safeFetch(page.toString(), 'text/html,application/xhtml+xml')
  if (res && (res.headers.get('content-type') ?? '').includes('html')) {
    const body = await readCapped(res, MAX_HTML_BYTES)
    const html = body?.toString('utf8').slice(0, MAX_HTML_BYTES) ?? ''
    const head = html.split(/<\/head>/i)[0] ?? html

    const og =
      attr(head, /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ??
      attr(head, /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
    if (og) candidates.push(og)

    // Крупные иконки предпочтительнее: apple-touch-icon обычно 180px, тогда
    // как /favicon.ico — 16px и в списке выглядит мылом.
    for (const re of [
      /<link[^>]+rel=["'][^"']*apple-touch-icon[^"']*["'][^>]+href=["']([^"']+)["']/i,
      /<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]+href=["']([^"']+)["']/i,
      /<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*icon[^"']*["']/i,
    ]) {
      const href = attr(head, re)
      if (href) candidates.push(href)
    }
  } else if (res) {
    // Ссылка ведёт не на страницу — тело не читаем, соединение закрываем.
    void res.body?.cancel()
  }

  // 2. Запасной путь — /favicon.ico в корне.
  candidates.push('/favicon.ico')

  for (const href of candidates) {
    let iconUrl: string
    try {
      iconUrl = new URL(href, page).toString()
    } catch {
      continue
    }
    const iconRes = await safeFetch(iconUrl, 'image/*')
    if (!iconRes) continue
    const mime = (iconRes.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
    if (!mime.startsWith('image/') || mime.includes('svg')) {
      // SVG пропускаем намеренно: это документ со скриптами, а мы отдадим его
      // в вёрстку клиента.
      void iconRes.body?.cancel()
      continue
    }
    const buf = await readCapped(iconRes, MAX_ICON_BYTES)
    if (!buf?.length) continue
    return `data:${mime};base64,${buf.toString('base64')}`
  }

  return null
}

/**
 * Имя из ссылки: github.com/acme/repo → «github.com». Домен и есть то, как
 * ресурс называют вслух, а «www» и корневой слэш только мешают.
 */
export function nameFromUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl)
    const host = u.hostname.replace(/^www\./, '')
    const path = u.pathname.replace(/\/+$/, '')
    // Для ссылки вглубь добавляем последний осмысленный кусок пути:
    // «figma.com» у пяти макетов подряд не различить.
    const tail = path.split('/').filter(Boolean).pop()
    return tail && tail.length <= 40 ? `${host}/${decodeURIComponent(tail)}` : host
  } catch {
    return ''
  }
}
