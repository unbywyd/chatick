import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Проверки RTL и переводов по docs/RTL_I18N_GUIDE.md.
//
// Эти ошибки не видно глазами: интерфейс на русском выглядит правильно в
// любом случае, а ломается он только на иврите — и обычно у того, кто не
// может сообщить об этом по-русски. Поэтому ловим их в тестах.

const SRC = join(import.meta.dirname, '..')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.tsx?$/.test(p) && !p.endsWith('.test.ts')) out.push(p)
  }
  return out
}

const files = walk(SRC).map((path) => ({ path, code: readFileSync(path, 'utf8') }))
const ui = files.filter((f) => f.path.endsWith('.tsx'))

/** Строки кода без комментариев — комментарии тут полны примеров «как нельзя». */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

describe('Rule 0 и 2: не переворачиваем то, что RN переворачивает сам', () => {
  it('нет isRTL в flexDirection и justifyContent', () => {
    // Классический двойной флип: RN уже отзеркалил раскладку, а мы делаем это
    // второй раз — и строка в иврите едет обратно в LTR.
    const bad: string[] = []
    for (const f of ui) {
      const code = stripComments(f.code)
      const re = /(flexDirection|justifyContent|alignItems)\s*:\s*[^,\n]*isRTL/g
      for (const m of code.matchAll(re)) bad.push(`${f.path}: ${m[0]}`)
    }
    expect(bad, `двойное отзеркаливание:\n${bad.join('\n')}`).toEqual([])
  })

  it('нет row-reverse без объяснения', () => {
    // row-reverse законен только как осознанное исключение — и тогда рядом
    // обязан стоять комментарий, почему.
    for (const f of ui) {
      const lines = f.code.split('\n')
      lines.forEach((line, i) => {
        if (!line.includes("'row-reverse'")) return
        const context = lines.slice(Math.max(0, i - 6), i).join('\n')
        expect(
          context.includes('//') || context.includes('*'),
          `${f.path}:${i + 1} — row-reverse без объяснения`,
        ).toBe(true)
      })
    }
  })
})

describe('Rule 1: логические свойства вместо физических', () => {
  it('нет marginLeft/paddingRight и подобных в стилях', () => {
    const bad: string[] = []
    for (const f of ui) {
      const code = stripComments(f.code)
      const re = /\b(margin|padding)(Left|Right)\s*:/g
      for (const m of code.matchAll(re)) bad.push(`${f.path}: ${m[0]}`)
    }
    expect(bad, `физические отступы вместо start/end:\n${bad.join('\n')}`).toEqual([])
  })
})

describe('Rule 3: TextInput и Text выравниваются явно', () => {
  it('у каждого TextInput задан textAlign', () => {
    // Без него в иврите курсор прижат влево, а текст утекает от него.
    for (const f of ui) {
      const count = (f.code.match(/<TextInput/g) ?? []).length
      if (!count) continue
      expect(
        f.code.includes('textAlign'),
        `${f.path} — есть TextInput, но нигде нет textAlign`,
      ).toBe(true)
    }
  })

  it('textAlign не задан значением start', () => {
    // 'start' не входит в документированные значения textAlign и молча
    // игнорируется — текст просто оказывается не с той стороны.
    for (const f of ui) {
      expect(stripComments(f.code)).not.toMatch(/textAlign\s*:\s*['"]start['"]/)
    }
  })

  it('экраны используют общий Txt, а не голый Text', () => {
    // Голый <Text> без textAlign на iOS уезжает влево во всём приложении.
    // Исключения — Txt (сама обёртка), Logo и Avatar: там одна буква или
    // латинское название, направление им безразлично.
    const allowed = ['Txt.tsx', 'Logo.tsx', 'Avatar.tsx']
    for (const f of ui) {
      if (allowed.some((a) => f.path.endsWith(a))) continue
      const bare = stripComments(f.code).match(/<Text[\s>]/g) ?? []
      expect(bare, `${f.path} — голый <Text> вместо <Txt>`).toEqual([])
    }
  })
})

describe('Rule 6: смена направления применяется перезагрузкой', () => {
  const i18n = files.find((f) => f.path.endsWith(join('i18n', 'index.ts')))!.code

  it('на импорте только разрешаем RTL, но не выбираем направление', () => {
    // forceRTL по запасному языку даёт «английский текст в RTL-раскладке»
    // до следующего запуска.
    expect(i18n).toMatch(/I18nManager\.allowRTL\(true\)/)
    const beforeBootstrap = i18n.slice(0, i18n.indexOf('export async function bootstrapLanguage'))
    expect(stripComments(beforeBootstrap)).not.toMatch(/I18nManager\.forceRTL/)
  })

  it('есть защита от вечного перезапуска', () => {
    // Без неё сбой применения флага уводит в бесконечный цикл, и человек
    // видит только сплеш.
    expect(i18n).toMatch(/RTL_GUARD_KEY/)
    expect(i18n).toMatch(/needsRestart: false/)
  })

  it('перезагрузка работает и в разработке, и в сборке', () => {
    const restart = files.find((f) => f.path.endsWith(join('i18n', 'restart.ts')))!.code
    expect(restart).toMatch(/__DEV__/)
    expect(restart).toMatch(/DevSettings\.reload/)
    expect(restart).toMatch(/expo-updates/)
  })

  it('expo-updates установлен — без него вариант B невозможен', () => {
    const pkg = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8'))
    expect(pkg.dependencies['expo-updates'], 'без expo-updates смена направления не применится').toBeTruthy()
  })

  it('язык готовится до показа интерфейса', () => {
    const app = readFileSync(join(SRC, '..', 'App.tsx'), 'utf8')
    expect(app).toMatch(/bootstrapLanguage\(\)/)
    expect(app).toMatch(/needsRestart/)
  })
})

describe('Rule 7: смена языка целиком', () => {
  const hook = files.find((f) => f.path.endsWith('useChangeLanguage.ts'))!.code

  it('выбор сохраняется', () => {
    expect(hook).toMatch(/storeLanguage\(target\)/)
  })

  it('перезапуск только при смене направления', () => {
    // Русский → английский направление не меняют, и дёргать человека нельзя.
    expect(hook).toMatch(/isRTLLanguage\(current\) !== isRTLLanguage\(target\)/)
    expect(hook).toMatch(/if \(!directionChanged\) return/)
  })
})

describe('Hermes: Intl нельзя доверять форматирование слов', () => {
  const fmt = files.find((f) => f.path.endsWith(join('lib', 'format.ts')))!.code

  it('единицы времени берутся из словаря, а не из Intl', () => {
    // В Node Intl отдаёт «שע׳», а Hermes на устройстве собран без полных
    // данных ICU и молча возвращает английское «h». На экране это выглядело
    // как «15h 12m» посреди иврита — без ошибки и без исключения.
    expect(stripComments(fmt)).not.toMatch(/style:\s*['"]unit['"]/)
    expect(fmt).toMatch(/mobile\.hourShort/)
    expect(fmt).toMatch(/mobile\.minuteShort/)
  })

  it('во всех языках заданы короткие единицы', () => {
    for (const lang of ['en', 'ru', 'he']) {
      const d = JSON.parse(readFileSync(join(SRC, 'i18n', 'locales', `${lang}.json`), 'utf8'))
      expect(d.mobile.hourShort, `${lang}: нет hourShort`).toBeTruthy()
      expect(d.mobile.minuteShort, `${lang}: нет minuteShort`).toBeTruthy()
    }
  })
})

describe('иконки: рисованные, а не глифы', () => {
  it('в интерфейсе нет эмодзи и типографских стрелок', () => {
    // Эмодзи рисует система: он цветной, разный на Android и iOS и не
    // подчиняется цвету текста. Знаки ▶ › ✓ берутся из шрифта: толщина у них
    // своя, к сетке они не выровнены. И то, и другое выдаёт черновик.
    const bad: string[] = []
    for (const f of ui) {
      if (f.path.endsWith('icons.tsx')) continue
      const code = stripComments(f.code)
      for (const m of code.matchAll(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}‹›▶◀❚]/gu)) {
        bad.push(`${f.path}: ${m[0]}`)
      }
    }
    expect(bad, `глифы вместо иконок:\n${bad.join('\n')}`).toEqual([])
  })

  it('в переводах нет знаков, которые рисует иконка', () => {
    // «+ Создать» рядом с нарисованным плюсом даёт два плюса подряд. Знак
    // остался в строке с тех пор, когда иконок не было, и на экране это
    // выглядит как опечатка.
    const bad: string[] = []
    for (const lang of ['en', 'ru', 'he']) {
      const d = JSON.parse(readFileSync(join(SRC, 'i18n', 'locales', `${lang}.json`), 'utf8'))
      const walk = (o: Record<string, unknown>, p = '') => {
        for (const [k, v] of Object.entries(o)) {
          if (typeof v === 'string') {
            if (/^\s*[+＋»«<>›‹→←]\s+/.test(v)) bad.push(`${lang}.${p}${k}: ${v}`)
          } else if (v && typeof v === 'object') {
            walk(v as Record<string, unknown>, `${p}${k}.`)
          }
        }
      }
      walk(d)
    }
    expect(bad, `знак в переводе дублирует иконку:\n${bad.join('\n')}`).toEqual([])
  })

  it('иконки собраны из одного набора с общей толщиной линии', () => {
    const icons = files.find((f) => f.path.endsWith('icons.tsx'))!.code
    expect(icons).toMatch(/strokeWidth = 2/)
    expect(icons).toMatch(/strokeLinecap="round"/)
  })
})

describe('шрифты: под каждое письмо своё начертание', () => {
  const txt = files.find((f) => f.path.endsWith('Txt.tsx'))!.code
  const i18nSrc = files.find((f) => f.path.endsWith(join('i18n', 'index.ts')))!.code

  it('иврит и кириллица получают разные семейства', () => {
    // Ни Heebo, ни Inter не покрывают оба письма: в Heebo нет кириллицы,
    // в Inter нет иврита. Один шрифт на всё оставил бы половину интерфейса
    // на системном — молча, без ошибки.
    expect(txt).toMatch(/he:\s*\{/)
    expect(txt).toMatch(/Heebo-/)
    expect(txt).toMatch(/Inter-/)
  })

  it('вес переводится в имя файла, а fontWeight снимается', () => {
    // fontWeight вместе с fontFamily даёт синтетически утолщённый Regular
    // вместо настоящего Bold.
    expect(txt).toMatch(/font\.fontWeight = undefined/)
  })

  it('шрифт грузится и при старте, и при смене языка', () => {
    // Переход иврит → английский идёт без перезапуска: без загрузки на лету
    // интерфейс остался бы с ивритским шрифтом на латинице.
    expect(i18nSrc).toMatch(/export async function loadFontsFor/)
    expect(i18nSrc).toMatch(/loadFontsFor\(resolved\)/)
    const hook = files.find((f) => f.path.endsWith('useChangeLanguage.ts'))!.code
    expect(hook).toMatch(/loadFontsFor\(target\)/)
  })

  it('файлы шрифтов лежат в проекте и зарегистрированы', () => {
    const pkg = JSON.parse(readFileSync(join(SRC, '..', 'app.json'), 'utf8'))
    const plugin = pkg.expo.plugins.find(
      (p: unknown) => Array.isArray(p) && p[0] === 'expo-font',
    ) as [string, { fonts: string[] }] | undefined
    expect(plugin, 'expo-font не подключён в app.json').toBeTruthy()
    for (const rel of plugin![1].fonts) {
      const file = join(SRC, '..', rel.replace('./', ''))
      const size = statSync(file).size
      // Настоящий TTF весит десятки килобайт. Страница 404, сохранённая под
      // именем шрифта, тоже «существует» — и молча ничего не отрисует.
      expect(size, `${rel}: подозрительный размер`).toBeGreaterThan(20_000)
      expect(readFileSync(file).subarray(0, 4).toString('hex')).toMatch(/^(00010000|74727565)$/)
    }
  })
})

describe('переводы: ничего не зашито в экранах', () => {
  it('в коде нет кириллических строк', () => {
    // Кириллица в JSX означает, что фраза не переводится вовсе.
    const bad: string[] = []
    for (const f of ui) {
      const code = stripComments(f.code)
      // Строковые литералы и текст между тегами.
      for (const m of code.matchAll(/(['"`])([^'"`\n]*[А-Яа-яЁё][^'"`\n]*)\1/g)) {
        bad.push(`${f.path}: ${m[2]}`)
      }
      for (const m of code.matchAll(/>([^<>{}\n]*[А-Яа-яЁё][^<>{}\n]*)</g)) {
        bad.push(`${f.path}: ${m[1].trim()}`)
      }
    }
    expect(bad, `непереведённые строки:\n${bad.join('\n')}`).toEqual([])
  })

  it('все три языка содержат одни и те же ключи', () => {
    // Ключ, забытый в одном языке, показывается сырым именем — и находит его
    // обычно пользователь, а не мы.
    const load = (l: string) =>
      JSON.parse(readFileSync(join(SRC, 'i18n', 'locales', `${l}.json`), 'utf8'))
    const flat = (o: Record<string, unknown>, p = ''): string[] =>
      Object.entries(o).flatMap(([k, v]) =>
        v && typeof v === 'object' ? flat(v as Record<string, unknown>, `${p}${k}.`) : [`${p}${k}`],
      )

    const en = flat(load('en'))
    for (const lang of ['ru', 'he']) {
      const other = flat(load(lang))
      // Формы множественного числа у языков разные (_one/_few/_many против
      // _one/_other) — сравниваем без суффиксов.
      const base = (keys: string[]) =>
        new Set(keys.map((k) => k.replace(/_(zero|one|two|few|many|other)$/, '')))
      const missing = [...base(en)].filter((k) => !base(other).has(k))
      expect(missing, `${lang}: нет ключей ${missing.join(', ')}`).toEqual([])
    }
  })

  it('иврит действительно на иврите', () => {
    // Пустой перевод или скопированный английский — частая ошибка сборки
    // словарей, и заметна она только тому, кто читает на иврите.
    const he = JSON.parse(readFileSync(join(SRC, 'i18n', 'locales', 'he.json'), 'utf8'))
    const values: string[] = []
    const collect = (o: Record<string, unknown>) => {
      for (const v of Object.values(o)) {
        if (typeof v === 'string') values.push(v)
        else if (v && typeof v === 'object') collect(v as Record<string, unknown>)
      }
    }
    collect(he)
    // Часть строк — имена собственные (Chatick), в них ивритских букв нет.
    const hebrew = values.filter((v) => /[֐-׿]/.test(v))
    expect(hebrew.length).toBeGreaterThan(values.length * 0.8)
  })
})
