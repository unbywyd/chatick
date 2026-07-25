// Минимальный санитайзер для HTML документов (SPEC §8.25).
// Контент пишут доверенные участники проекта через Tiptap, но публичная страница
// отдаётся на нашем домене — поэтому чистим по строгому allow-list, без зависимостей.

const ALLOWED_TAGS = new Set([
  'p', 'br', 'hr', 'div', 'span',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'b', 'em', 'i', 'u', 's', 'mark', 'code', 'pre', 'blockquote', 'sub', 'sup',
  'ul', 'ol', 'li',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'a', 'img', 'label', 'input',
])

// какие атрибуты разрешены у каких тегов
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'title', 'target', 'rel']),
  img: new Set(['src', 'alt', 'title', 'width', 'height']),
  th: new Set(['colspan', 'rowspan']),
  td: new Set(['colspan', 'rowspan']),
  ol: new Set(['start']),
  li: new Set(['data-checked']),
  ul: new Set(['data-type']), // чек-листы Tiptap
  input: new Set(['type', 'checked', 'disabled']),
}
// разрешены везде
const GLOBAL_ATTRS = new Set(['class', 'style'])

// только безопасные схемы ссылок/картинок
const SAFE_URL = /^(https?:\/\/|\/|mailto:|#)/i
// style — только безопасные декларации (без url(), expression() и т.п.)
const SAFE_STYLE = /^[a-z-]+:\s*[#a-z0-9 .,%()/-]+$/i

function cleanAttrs(tag: string, attrsRaw: string): string {
  const out: string[] = []
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g
  let m: RegExpExecArray | null
  while ((m = re.exec(attrsRaw))) {
    const name = m[1]!.toLowerCase()
    const value = m[3] ?? m[4] ?? ''
    const allowed = ALLOWED_ATTRS[tag]?.has(name) || GLOBAL_ATTRS.has(name)
    if (!allowed) continue
    if (name.startsWith('on')) continue // обработчики — никогда
    if ((name === 'href' || name === 'src') && !SAFE_URL.test(value.trim())) continue
    // input допускаем только как чекбокс чек-листа — никаких полей ввода на нашем домене
    if (tag === 'input' && name === 'type' && value.toLowerCase() !== 'checkbox') return ' disabled'
    if (name === 'style') {
      const decls = value
        .split(';')
        .map((d) => d.trim())
        .filter((d) => d && SAFE_STYLE.test(d))
      if (!decls.length) continue
      out.push(`style="${decls.join('; ').replace(/"/g, '')}"`)
      continue
    }
    out.push(`${name}="${value.replace(/"/g, '&quot;')}"`)
  }
  // внешние ссылки открываем безопасно
  if (tag === 'a') out.push('rel="noopener noreferrer nofollow"')
  // чекбоксы чек-листа на публичной странице — только для чтения
  if (tag === 'input') out.push('disabled')
  return out.length ? ' ' + out.join(' ') : ''
}

export function sanitizeHtml(html: string): string {
  // вырезаем целиком опасные блоки вместе с содержимым
  const stripped = html.replace(/<(script|style|iframe|object|embed|noscript)[\s\S]*?<\/\1\s*>/gi, '')

  return stripped.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)((?:[^<>"']|"[^"]*"|'[^']*')*)\/?>/g, (match, rawTag: string, attrs: string) => {
    const tag = rawTag.toLowerCase()
    if (!ALLOWED_TAGS.has(tag)) return '' // неизвестный тег — убираем разметку, текст остаётся
    if (match.startsWith('</')) return `</${tag}>`
    const selfClosing = tag === 'br' || tag === 'hr' || tag === 'img'
    return `<${tag}${cleanAttrs(tag, attrs)}${selfClosing ? ' /' : ''}>`
  })
}
