// HTML-шаблон писем в стиле продукта (чёрно-лаймовый) + текстовая версия.
// Верстка табличная и с инлайновыми стилями — почтовые клиенты не поддерживают
// современный CSS, а Gmail вырезает <style> из <head>.

export type MailLang = 'en' | 'ru' | 'he'

export const mailLang = (locale: string | null | undefined): MailLang => {
  const s = (locale || 'en').slice(0, 2)
  return s === 'ru' || s === 'he' ? s : 'en'
}

const esc = (s: string) => s.replace(/[<>&"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[ch]!)

export type MailContent = {
  lang: MailLang
  title: string
  /** абзацы основного текста */
  paragraphs: string[]
  action?: { label: string; url: string }
  /** мелкий текст под кнопкой */
  note?: string
  footer?: string
}

const BRAND = '#c9f24d'
const INK = '#111113'

/** HTML-письмо. */
export function renderMail(c: MailContent): string {
  const dir = c.lang === 'he' ? 'rtl' : 'ltr'
  const align = c.lang === 'he' ? 'right' : 'left'

  const body = c.paragraphs
    .map(
      (p) =>
        `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#33333a;">${p}</p>`,
    )
    .join('')

  const button = c.action
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 8px;">
         <tr><td style="border-radius:10px;background:${BRAND};">
           <a href="${esc(c.action.url)}"
              style="display:inline-block;padding:13px 26px;font-size:15px;font-weight:700;
                     color:${INK};text-decoration:none;border-radius:10px;">${esc(c.action.label)}</a>
         </td></tr>
       </table>`
    : ''

  // запасная ссылка: часть клиентов режет кнопки, плюс её можно скопировать
  const fallback = c.action
    ? `<p style="margin:6px 0 0;font-size:12px;line-height:1.5;color:#8a8a93;word-break:break-all;">
         <a href="${esc(c.action.url)}" style="color:#8a8a93;">${esc(c.action.url)}</a>
       </p>`
    : ''

  return `<!doctype html>
<html lang="${c.lang}" dir="${dir}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(c.title)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f6;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f6;padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="max-width:520px;background:#ffffff;border-radius:14px;overflow:hidden;
                    border:1px solid #e6e6ea;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
        <tr><td style="background:${INK};padding:18px 24px;">
          <span style="font-size:17px;font-weight:800;color:#ffffff;letter-spacing:-0.02em;">Chatick</span>
        </td></tr>
        <tr><td dir="${dir}" align="${align}" style="padding:26px 24px 24px;">
          <h1 style="margin:0 0 14px;font-size:19px;line-height:1.35;color:${INK};font-weight:700;">${esc(c.title)}</h1>
          ${body}
          ${button}
          ${fallback}
          ${c.note ? `<p style="margin:16px 0 0;font-size:13px;line-height:1.5;color:#6b6b73;">${c.note}</p>` : ''}
        </td></tr>
        <tr><td dir="${dir}" align="${align}" style="padding:14px 24px 20px;border-top:1px solid #eeeef1;">
          <p style="margin:0;font-size:12px;line-height:1.5;color:#9a9aa2;">${c.footer ?? 'Chatick'}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`
}

/** Текстовая версия того же письма — обязательна, письма без text/plain чаще летят в спам. */
export function renderMailText(c: MailContent): string {
  const strip = (s: string) => s.replace(/<[^>]+>/g, '')
  return [
    strip(c.title),
    '',
    ...c.paragraphs.map(strip),
    ...(c.action ? ['', `${c.action.label}: ${c.action.url}`] : []),
    ...(c.note ? ['', strip(c.note)] : []),
    ...(c.footer ? ['', strip(c.footer)] : []),
  ].join('\n')
}
