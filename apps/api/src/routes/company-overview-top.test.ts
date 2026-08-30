import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Топ проектов на обзоре компании.
//
// В компании с двумя десятками проектов список занимал всю страницу, и нужный
// искали глазами — хотя заходят в проекты почти всегда именно отсюда.
// Показываем те, где человека коснулось свежее всего; остальные — на вкладке.

const route = readFileSync(join(import.meta.dirname, 'companies.ts'), 'utf8')
const tab = readFileSync(
  join(import.meta.dirname, '../../../app/src/components/company/OverviewTab.tsx'),
  'utf8',
)

/** Тело сортировки списка проектов в ответе обзора. */
function sortBody(): string {
  const at = route.indexOf('projects: list.sort(')
  expect(at, 'сортировка проектов не найдена').toBeGreaterThan(-1)
  return route.slice(at, at + 1100)
}

describe('порядок отвечает на «куда мне зайти»', () => {
  it('свои проекты идут раньше чужих', () => {
    // В проект, где я не состою, всё равно не пустят — держать его выше того,
    // где меня ждут, значит тратить первую строку впустую.
    expect(sortBody()).toMatch(/a\.isMember !== b\.isMember/)
  })

  it('проекты с бедой поднимаются выше тихих', () => {
    // Просрочка и застрявшие задачи — это «работа не движется». Пока карточка
    // показывала имя и часы, порядок был неважен; теперь она показывает, что
    // горит, и проект с четырьмя стоящими задачами не должен оказываться
    // пятым, уступив тихому со свежим уведомлением.
    //
    // Саботаж: убрать ступень trouble — на живых данных Simply Touch с
    // четырьмя застрявшими снова уедет вниз.
    const body = sortBody()
    expect(body, 'беда не учитывается в порядке').toMatch(/trouble\(a\) !== trouble\(b\)/)
    expect(body, 'просрочка и застрявшее считаются не вместе').toMatch(
      /p\.overdue \+ p\.blocked/,
    )
    // Но НЕ выше своих: в чужой проект всё равно не пустят.
    expect(body.indexOf('isMember')).toBeLessThan(body.indexOf('trouble'))
  })

  it('дальше — по свежести того, что меня коснулось', () => {
    expect(sortBody()).toMatch(/lastTouchedAt/)
  })

  it('проекты без уведомлений сортируются часами', () => {
    // Для них это единственный признак, что там вообще идёт работа.
    expect(sortBody()).toMatch(/b\.minutes - a\.minutes/)
  })
})

describe('сигнал — уведомления мне, а не любая активность', () => {
  it('запрос ограничен моими уведомлениями', () => {
    // Иначе шумный проект, где я не участвую, вытеснял бы с главной тот,
    // где меня ждут.
    const at = route.indexOf('const notifyRows')
    expect(at, 'запрос уведомлений не найден').toBeGreaterThan(-1)
    const body = route.slice(at, at + 700)
    expect(body).toMatch(/eq\(notifications\.userId, sub\)/)
    expect(body).toMatch(/groupBy\(notifications\.projectId\)/)
  })

  it('дата приходит текстом ISO, а не timestamp', () => {
    // Саботаж: вернуть max(created_at) — драйвер отдаст Date, сравнение строк
    // станет алфавитным, и «Aug 12» окажется выше «Aug 18». Поймано замером
    // на живых данных, глазами такое не видно.
    const at = route.indexOf('lastAt: sql')
    expect(route.slice(at, at + 200)).toMatch(/to_char/)
  })
})

describe('список обрезан, но ничего не потеряно', () => {
  it('показывается не больше шести', () => {
    // Было десять. Под проектами теперь ещё и люди, и десять карточек
    // отодвигали всё остальное за нижний край экрана. Именно шесть, а не
    // пять: сетка в две колонки, нечётное число оставляет дыру.
    expect(tab).toMatch(/const TOP_PROJECTS = 6/)
    // Именно РИСУЕТСЯ обрезанный список, а не просто вычисляется: проверка на
    // наличие переменной проходила и тогда, когда рендер брал полный список,
    // — то есть не ловила ровно ту ошибку, ради которой написана.
    expect(tab, 'рисуется полный список вместо обрезанного').toMatch(/\{visibleProjects\.map\(/)
    expect(tab).not.toMatch(/\{shownProjects\.map\(/)
  })

  it('кнопка появляется, только когда что-то скрыто', () => {
    // Прятать три проекта за «показать все» — лишний шаг на ровном месте.
    expect(tab).toMatch(/shownProjects\.length > TOP_PROJECTS/)
    expect(tab).toMatch(/overLimit &&/)
  })

  it('список разворачивается НА МЕСТЕ, а не уводит на вкладку', () => {
    // Человек шёл в конкретный проект; уводить его на соседний экран значит
    // терять место, к которому он шёл, и возвращаться кнопкой «назад».
    expect(tab).toMatch(/onClick=\{\(\) => setAllProjects\(true\)\}/)
    expect(tab, 'развёрнутый список нельзя свернуть обратно').toMatch(/setAllProjects\(false\)/)
    expect(tab, 'остался уход на вкладку').not.toMatch(/onOpenAllProjects/)
  })

  it('поиск снимает предел', () => {
    // «Найдено, но не показано» — худшее, что можно ответить ищущему.
    expect(tab).toMatch(/!needle && shownProjects\.length > TOP_PROJECTS/)
  })

  it('кнопка называет число скрытых', () => {
    // «Все проекты» без числа не даёт понять, стоит ли туда идти.
    expect(tab).toMatch(/overview\.allProjects/)
    expect(tab).toMatch(/count: shownProjects\.length/)
  })
})

describe('карточка не потеряла данных', () => {
  it('всё, что о проекте видно, осталось на карточке', () => {
    // Урезать список — не значит урезать то, что о проекте видно.
    for (const field of ['tasksDone', 'tasksTotal', 'members', 'messages', 'progress', 'overdue', 'blocked']) {
      expect(tab, `поле ${field} пропало`).toMatch(new RegExp(`p\.${field}`))
    }
  })

  it('часов на карточке НЕТ — они живут периодом', () => {
    // Часы зависят от переключателя периода, а он стоит ниже, в секции часов.
    // Число наверху, молча меняющееся от элемента внизу экрана, — ровно та
    // немота, из-за которой переключатель туда и переехал.
    //
    // Саботаж: вернуть {formatDuration(p.minutes)} в карточку.
    const at = tab.indexOf('{visibleProjects.map(')
    const card = tab.slice(at, tab.indexOf('{/* Шторка', at))
    expect(card, 'часы вернулись на карточку проекта').not.toMatch(/formatDuration\(p\.minutes\)/)
  })

  it('смена периода не гасит страницу целиком', () => {
    // Период входит в ключ запроса: без placeholderData react-query считает
    // новый период новыми данными, q.data становится undefined, срабатывает
    // заглушка «…» — и мигает вся страница, включая просрочку, прогресс и
    // людей, которые от периода не зависят вовсе.
    //
    // Саботаж: убрать placeholderData — мигание вернётся.
    expect(tab, 'при смене периода перерисовывается вся страница').toMatch(
      /placeholderData: \(prev\) => prev/,
    )
    // И признак загрузки остаётся: иначе непонятно, применился ли выбор.
    expect(tab).toMatch(/q\.isFetching &&/)
  })

  it('переключатель периода стоит в секции часов, а не в шапке', () => {
    // В шапке он читался как «период всей страницы» и обещал больше, чем
    // делает: у просрочки и прогресса прошлого нет вовсе.
    const picker = tab.indexOf('<PeriodPicker')
    const rhythm = tab.indexOf("t('overview.rhythm')")
    expect(picker, 'переключатель периода пропал').toBeGreaterThan(-1)
    expect(picker, 'переключатель снова в шапке страницы').toBeGreaterThan(rhythm)
  })

  it('непрочитанное видно на карточке', () => {
    // Проект стоит наверху по свежести — метка объясняет, почему он там.
    expect(tab).toMatch(/p\.unread > 0/)
  })
})
