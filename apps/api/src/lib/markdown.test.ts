import { describe, it, expect } from 'vitest'
import { markdownToHtml, looksLikeHtml, richText } from './markdown.js'

// Ассистент пишет markdown — это его естественный язык, и просить его не
// писать markdown бесполезно. Раньше такой текст ложился в базу как есть и
// показывался простынёй: `##` и `**` видны буквально, переносы схлопнуты
// (HTML их не различает).
//
// Разбор библиотечный (marked), поэтому проверяем не форму вывода, а то, что
// важно нам: наш синтаксис упоминаний уцелел, санитайзер не срезал лишнего и
// реальный текст ассистента перестал быть простынёй.

describe('распознавание разметки', () => {
  it('markdown разметкой не считается', () => {
    expect(looksLikeHtml('## Заголовок\n\n**жирный**')).toBe(false)
  })

  it('«5 < 10» — текст, а не разметка', () => {
    expect(looksLikeHtml('5 < 10 и 3 > 2')).toBe(false)
  })

  it('настоящий HTML распознаётся', () => {
    expect(looksLikeHtml('<p>привет</p>')).toBe(true)
  })

  it('готовую разметку не перемалываем заново — только проставляем направление', () => {
    expect(richText('<p>уже <strong>размечено</strong></p>')).toBe('<p dir="ltr">уже <strong>размечено</strong></p>')
  })
})

describe('блоки', () => {
  it('заголовки', () => {
    expect(markdownToHtml('# Раз')).toContain('<h1>Раз</h1>')
    expect(markdownToHtml('## Два')).toContain('<h2>Два</h2>')
  })

  it('одиночный перенос остаётся переносом, а не съедается', () => {
    expect(markdownToHtml('первая\nвторая')).toMatch(/первая<br\s*\/?>\s*вторая/)
  })

  it('пустая строка делит абзацы', () => {
    expect((markdownToHtml('раз\n\nдва').match(/<p>/g) ?? []).length).toBe(2)
  })

  it('маркированный список', () => {
    const html = markdownToHtml('- раз\n- два')
    expect(html).toContain('<ul>')
    expect((html.match(/<li>/g) ?? []).length).toBe(2)
  })

  it('нумерованный список', () => {
    expect(markdownToHtml('1. раз\n2. два')).toContain('<ol>')
  })

  it('вложенный список остаётся вложенным', () => {
    const html = markdownToHtml('- раз\n  - вложенный\n- два')
    expect((html.match(/<ul>/g) ?? []).length).toBe(2)
  })

  it('цитата', () => {
    expect(markdownToHtml('> сказано')).toContain('<blockquote>')
  })

  it('блок кода отдаётся буквально — разметка внутри него не разметка', () => {
    const html = markdownToHtml('```js\nconst a = **1**\n```')
    expect(html).toContain('<pre>')
    expect(html).toContain('**1**')
    expect(html).not.toContain('<strong>')
  })

  it('линейка', () => {
    expect(markdownToHtml('---')).toMatch(/<hr\s*\/?>/)
  })

  it('таблица — GFM включён', () => {
    expect(markdownToHtml('| a | b |\n| - | - |\n| 1 | 2 |')).toContain('<table>')
  })
})

describe('инлайн', () => {
  it('жирный и курсив', () => {
    const html = markdownToHtml('**жирный** и *курсив*')
    expect(html).toContain('<strong>жирный</strong>')
    expect(html).toContain('<em>курсив</em>')
  })

  it('код не даёт разметке сработать внутри себя', () => {
    const html = markdownToHtml('`a **b** c`')
    expect(html).toContain('<code>')
    expect(html).not.toContain('<strong>')
  })

  it('ссылка', () => {
    expect(markdownToHtml('[тут](https://chatick.com)')).toContain('<a href="https://chatick.com">тут</a>')
  })

  it('картинка остаётся картинкой', () => {
    expect(markdownToHtml('![вид](/a.png)')).toContain('<img src="/a.png"')
  })
})

describe('упоминания — наш синтаксис, не markdown', () => {
  it('становятся span, а не ссылкой на id', () => {
    const html = markdownToHtml('привет @[Дана](u1)')
    expect(html).toContain('data-type="mention"')
    expect(html).toContain('data-id="u1"')
    expect(html).not.toContain('<a href="u1"')
  })

  it('переживают санитайзер: без data-атрибутов ссылка на человека теряется', () => {
    const html = richText('привет @[Дана](u1), глянь')
    expect(html).toContain('data-id="u1"')
    expect(html).toContain('data-label="Дана"')
  })

  it('несколько в одном тексте не путаются местами', () => {
    const html = richText('@[Аня](u1) и @[Боря](u2)')
    expect(html.indexOf('data-id="u1"')).toBeLessThan(html.indexOf('data-id="u2"'))
    expect(html).toContain('Аня')
    expect(html).toContain('Боря')
  })
})

describe('безопасность', () => {
  it('скрипт не проходит ни из markdown, ни из HTML', () => {
    expect(richText('<script>alert(1)</script>')).not.toContain('<script')
    expect(richText('<p>да<script>alert(1)</script></p>')).not.toContain('<script')
  })

  it('javascript: в ссылке не выживает', () => {
    expect(richText('[клик](javascript:alert(1))')).not.toContain('javascript:')
  })

  it('направление блока санитайзер не срезает — иначе иврит разворачивало бы обратно', () => {
    expect(richText('<p dir="rtl">שלום</p>')).toContain('dir="rtl"')
  })
})

describe('текст, каким его пишет ассистент', () => {
  const md = [
    'בדקתי את הנושא. זהו חלק מורכב.',
    '',
    '## שלוש אפשרויות',
    '',
    '1. **מודל אנטומי תלת-ממד** — https://www.turbosquid.com',
    '2. **פלטפורמות בתשלום** — יש API',
    '',
    'חסרונות:',
    '- כל אזור חייב להיות אובייקט נפרד',
    '- עבודה של חודשים',
  ].join('\n')
  const html = richText(md)

  it('заголовок стал заголовком, а не строкой с решётками', () => {
    expect(html).toContain('שלוש אפשרויות</h2>')
    expect(html).not.toContain('##')
  })

  it('жирный стал жирным', () => {
    expect(html).toContain('<strong>')
    expect(html).not.toContain('**')
  })

  it('списки стали списками', () => {
    expect(html).toContain('<ol dir=')
    expect(html).toContain('<ul dir=')
  })

  it('и это больше не один слипшийся абзац', () => {
    expect((html.match(/<(p|h2|li)[ >]/g) ?? []).length).toBeGreaterThan(4)
  })

  it('адрес внутри ивритского текста уцелел', () => {
    expect(html).toContain('https://www.turbosquid.com')
  })
})

describe('направление проставляется само, без параметра в ручке', () => {
  it('ивритский абзац — rtl', () => {
    expect(richText('שלום עולם')).toContain('dir="rtl"')
  })

  it('английский — ltr', () => {
    expect(richText('hello world')).toContain('dir="ltr"')
  })

  it('русский — ltr', () => {
    expect(richText('привет мир')).toContain('dir="ltr"')
  })

  it('в одном тексте у каждого абзаца своё направление', () => {
    const html = richText('שלום עולם\n\nhello world')
    expect(html).toMatch(/<p dir="rtl">[^<]*<\/p>\s*<p dir="ltr">/)
  })

  it('список получает направление целиком — иначе текст справа, а маркеры слева', () => {
    const html = richText('- כל אזור\n- עבודה')
    expect(html).toContain('<ul dir="rtl">')
  })

  it('латинское название в начале ивритского пункта не разворачивает весь список', () => {
    // Направление по преобладанию, а не по первому символу: иначе пункт,
    // начинающийся с «API» или «biodigital.com», уводил бы весь список влево.
    expect(richText('- API של המערכת\n- עוד משהו')).toContain('<ul dir="rtl">')
  })

  it('соседний длинный абзац на другом языке не перебивает короткий', () => {
    // Считаем текст самого блока, а не остаток документа.
    const html = richText('שלום\n\nthis is a much longer english paragraph about everything')
    expect(html).toMatch(/<p dir="rtl">[^<]*<\/p>/)
  })

  it('выбор человека сильнее догадки', () => {
    expect(richText('<p dir="ltr">שלום</p>')).toContain('dir="ltr"')
  })

  it('строка без букв направления не размечается — там нечего определять', () => {
    expect(richText('12345')).not.toContain('dir=')
  })
})

describe('адреса не считаются языком', () => {
  it('ивритский список со ссылками остаётся ивритским', () => {
    const html = richText('- הפלטפורמה שלנו: biodigital.com\n- עוד אחת: https://www.visiblebody.com')
    expect(html).toContain('<ul dir="rtl">')
  })
})
