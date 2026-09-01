import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Выгрузка часов открывается в Excel так, как её записали.
 *
 * Пока выгружали CSV, Excel разбирал его сам и угадывал типы по своей локали.
 * Угадывал плохо: «6.67» превращалось в «июн.67», «5.50» в «фев.50», а дата
 * «2026-08-15» — в «########», потому что не влезала в узкий столбец. По
 * такому файлу нельзя посчитать, и заметно это только открыв его.
 *
 * В .xlsx тип задан явно: часы — число, ширина столбца своя, гадать нечего.
 */

const tab = readFileSync(
  join(import.meta.dirname, '../../../app/src/components/company/CompanyTimeTab.tsx'),
  'utf8',
)

describe('файл настоящий, а не CSV', () => {
  it('пишется через xlsx', () => {
    // Саботаж: вернуть сборку строки с разделителями — Excel снова начнёт
    // угадывать, и часы опять станут датами.
    expect(tab, 'выгрузка вернулась к CSV').not.toMatch(/text\/csv/)
    expect(tab).toMatch(/XLSX\.writeFile\(wb, `\$\{name\}-\$\{period\.from\}_\$\{period\.to\}\.xlsx`\)/)
  })

  it('у столбцов задана ширина', () => {
    // Решётки вместо значения — это узкий столбец, а не порча данных. Но
    // объяснять это каждому, кто открыл файл, — не решение.
    expect(tab).toMatch(/ws\['!cols'\] = widths\.map\(\(wch\) => \(\{ wch \}\)\)/)
  })

  it('часы уходят числом, а не строкой', () => {
    // Строку Excel сложит как текст: сумма по столбцу не посчитается.
    expect(tab).toMatch(/const hours = \(minutes: number\) => Number\(\(minutes \/ 60\)\.toFixed\(2\)\)/)
    // И нигде не осталось ручной подмены разделителя — она была нужна CSV.
    expect(tab, 'осталась подмена точки на запятую от CSV').not.toMatch(/replace\('\.', ','\)/)
  })

  it('дата — строкой в местном виде', () => {
    // Date в ячейке Excel показывает по-своему, вплоть до «########».
    expect(tab).toMatch(/toLocaleDateString\(i18n\.language, \{\s*day: '2-digit'/)
  })
})

describe('содержимое', () => {
  it('заголовки на языке интерфейса', () => {
    // Файл открывает человек, а не машина: «Person» в русском отчёте —
    // недоделка, а не нейтральность.
    for (const key of ['colPerson', 'colProject', 'colHours', 'colTotal']) {
      expect(tab, `заголовок ${key} не переведён`).toMatch(new RegExp(`t\\('time\\.${key}'\\)`))
    }
    expect(tab, 'остались жёсткие английские заголовки').not.toMatch(/'Person', 'Date', 'Hours'/)
  })

  it('столбца минут нет — он дублировал часы', () => {
    expect(tab, 'вернулся столбец минут').not.toMatch(/colMinutes/)
  })

  it('кнопка не обещает CSV', () => {
    const ru = JSON.parse(
      readFileSync(join(import.meta.dirname, '../../../app/src/i18n/locales/ru.json'), 'utf8'),
    ) as { time: Record<string, string> }
    expect(ru.time.export, 'кнопка обещает CSV, а отдаёт xlsx').not.toMatch(/CSV/i)
  })

  it('переводы столбцов есть во всех трёх языках', () => {
    for (const lang of ['ru', 'en', 'he']) {
      const json = JSON.parse(
        readFileSync(join(import.meta.dirname, `../../../app/src/i18n/locales/${lang}.json`), 'utf8'),
      ) as { time: Record<string, string> }
      for (const key of ['colPerson', 'colProject', 'colHours', 'colDate', 'colDays', 'colAvg', 'colTotal']) {
        expect(json.time?.[key], `${lang}.time.${key} отсутствует`).toBeTruthy()
      }
    }
  })
})

describe('период', () => {
  it('«всё время» убрано из вариантов', () => {
    // Оно поднимало каждую запись компании: сейчас 92 строки, но при дюжине
    // человек за пять лет набегает тысяч тридцать. Максимум — «этот год»,
    // глубже выбирают календарём, осознанно.
    const picker = readFileSync(
      join(import.meta.dirname, '../../../app/src/components/ui/period-picker.tsx'),
      'utf8',
    )
    // Границы по объявлению и закрывающей скобке в начале строки:
    // indexOf(']') находил скобку внутри самого типа «PresetKey[]», и срез
    // обрывался на первой строке.
    const at = picker.indexOf('const PRESETS: PresetKey[] = [')
    const list = picker.slice(at, picker.indexOf('\n]', at))
    expect(list, '«всё время» вернулось в список').not.toMatch(/'all'/)
    expect(list, 'потерялся «этот год»').toMatch(/'thisYear'/)
  })

  it('выбранный вариант запоминается, а не вычисляется из дат', () => {
    // 1 сентября «этот месяц» — это с 1-го по 1-е, то есть буквально
    // «сегодня». Поиск по датам возвращал первый совпавший, и галочка вставала
    // на «Сегодня»: человек выбирал одно, выбиралось другое.
    //
    // Саботаж: убрать picked — на первое число месяца баг вернётся.
    const picker = readFileSync(
      join(import.meta.dirname, '../../../app/src/components/ui/period-picker.tsx'),
      'utf8',
    )
    expect(picker, 'выбранный вариант не запоминается').toMatch(
      /const \[picked, setPicked\] = useState<PresetKey \| null>\(null\)/,
    )
    expect(picker).toMatch(/setPicked\(key\)/)
  })
})
