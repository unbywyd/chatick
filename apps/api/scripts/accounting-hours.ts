/**
 * Табель часов за месяц для бухгалтерии — Excel.
 *
 *   npx tsx scripts/accounting-hours.ts --email <почта> --company <название> [--month 2026-09]
 *       [--out файл.xlsx] [--max-day 8] [--lang en|ru|he]
 *
 * Берёт записи трекера человека во всех проектах компании за месяц (сутки —
 * по часовому поясу компании), сохраняет сумму до минуты и раскладывает её по
 * правилам (см. lib/accounting-hours.ts): поровну, не больше --max-day часов в
 * день, воскресенье–четверг; пятница, затем суббота — только если не влезло.
 *
 * Только читает базу. Месяц по умолчанию — текущий в поясе компании.
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { and, eq, ilike, sql } from 'drizzle-orm'
import { db } from '../src/db/client.js'
import { companies, projects, timeEntries, users } from '../src/db/schema.js'
import { planMonth, splitByProject } from '../src/lib/accounting-hours.js'
import { readTimeConfig } from '../src/routes/time.js'

// xlsx уже есть в клиенте (экспорт часов из интерфейса) — не тащим вторую копию в API.
const XLSX = createRequire(join(import.meta.dirname, '../../app/package.json'))('xlsx') as typeof import('xlsx')

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}

const L = {
  en: {
    days: 'Days', projects: 'Projects', summary: 'Summary', date: 'Date', day: 'Day', hours: 'Hours', hm: 'H:MM',
    project: 'Project', share: 'Share', total: 'Total', employee: 'Employee', email: 'Email', company: 'Company',
    month: 'Month', totalHours: 'Total hours', workDays: 'Days with hours', rule: 'Distribution rule',
    ruleText: (max: number) => `Hours tracked in the month, spread evenly, max ${max} h/day, Sunday–Thursday; Friday, then Saturday only if needed.`,
    weekdays: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  },
  ru: {
    days: 'По дням', projects: 'По проектам', summary: 'Итого', date: 'Дата', day: 'День', hours: 'Часы', hm: 'Ч:ММ',
    project: 'Проект', share: 'Доля', total: 'Итого', employee: 'Сотрудник', email: 'Почта', company: 'Компания',
    month: 'Месяц', totalHours: 'Всего часов', workDays: 'Дней с часами', rule: 'Правило раскладки',
    ruleText: (max: number) => `Часы за месяц разложены поровну, не больше ${max} ч в день, воскресенье–четверг; пятница, затем суббота — только если не влезло.`,
    weekdays: ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'],
  },
  he: {
    days: 'ימים', projects: 'פרויקטים', summary: 'סיכום', date: 'תאריך', day: 'יום', hours: 'שעות', hm: 'ש:דד',
    project: 'פרויקט', share: 'חלק', total: 'סה"כ', employee: 'עובד', email: 'אימייל', company: 'חברה',
    month: 'חודש', totalHours: 'סה"כ שעות', workDays: 'ימים עם שעות', rule: 'כלל חלוקה',
    ruleText: (max: number) => `שעות החודש מחולקות באופן שווה, עד ${max} שעות ליום, ראשון–חמישי; שישי ואז שבת רק אם צריך.`,
    weekdays: ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'],
  },
} as const

async function main() {
  const email = arg('email')?.toLowerCase()
  const companyName = arg('company')
  if (!email || !companyName) throw new Error('Usage: --email <email> --company <name> [--month YYYY-MM]')
  const maxDay = Number(arg('max-day') ?? 8)
  const lang = (arg('lang') ?? 'en') as keyof typeof L
  const t = L[lang] ?? L.en

  const user = await db.query.users.findFirst({ where: eq(users.email, email) })
  if (!user) throw new Error(`No user ${email}`)
  const found = await db.select().from(companies).where(ilike(companies.name, companyName))
  if (found.length !== 1) throw new Error(`Company "${companyName}": found ${found.length}`)
  const company = found[0]!
  const tz = readTimeConfig(company.timeConfig).timezone || 'UTC'

  // Месяц — по поясу компании, а не машины, где запущен скрипт.
  const nowLocal = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit' }).format(new Date())
  const month = arg('month') ?? nowLocal.slice(0, 7)
  const m = /^(\d{4})-(\d{2})$/.exec(month)
  if (!m) throw new Error(`--month must be YYYY-MM, got ${month}`)
  const year = Number(m[1])
  const mon = Number(m[2])
  const next = mon === 12 ? `${year + 1}-01` : `${year}-${String(mon + 1).padStart(2, '0')}`

  const from = sql`(${`${month}-01 00:00`}::timestamp at time zone ${tz})`
  const to = sql`(${`${next}-01 00:00`}::timestamp at time zone ${tz})`
  // Запись через полночь на границе месяца режем по границе — как экран часов.
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      seconds: sql<number>`coalesce(sum(greatest(extract(epoch from (
        least(${timeEntries.endedAt}, ${to}) - greatest(${timeEntries.startedAt}, ${from})
      )), 0)), 0)::float`,
    })
    .from(timeEntries)
    .innerJoin(projects, eq(projects.id, timeEntries.projectId))
    .where(
      and(
        eq(timeEntries.userId, user.id),
        eq(projects.companyId, company.id),
        sql`${timeEntries.endedAt} is not null`,
        sql`${timeEntries.endedAt} > ${from}`,
        sql`${timeEntries.startedAt} < ${to}`,
      ),
    )
    .groupBy(projects.id, projects.name)

  // Итог округляем ОДИН раз, а по проектам делим наибольшим остатком. Если
  // округлять каждый проект отдельно, округления складываются, и сумма
  // проектов расходится с настоящим итогом на минуту-другую.
  const exact = rows.map((r) => ({ id: r.id, name: r.name, x: Number(r.seconds) / 60 }))
  const total = Math.round(exact.reduce((a, p) => a + p.x, 0))
  const floored = exact.map((p) => ({ ...p, minutes: Math.floor(p.x) }))
  let rest = total - floored.reduce((a, p) => a + p.minutes, 0)
  for (const p of [...floored].sort((a, b) => b.x - Math.floor(b.x) - (a.x - Math.floor(a.x)))) {
    if (rest <= 0) break
    p.minutes++
    rest--
  }
  const perProject = floored
    .filter((p) => p.minutes > 0)
    .map(({ id, name, minutes }) => ({ id, name, minutes }))
    .sort((a, b) => b.minutes - a.minutes)

  const plan = planMonth(year, mon, total, maxDay * 60)
  const cells = splitByProject(plan.days, perProject)

  // Точное значение, а показ — два знака (формат клетки ниже): так сумма
  // столбца в Excel сходится с итогом, а не расходится на сотую.
  const hours = (min: number) => min / 60
  const hm = (min: number) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`

  // --- По дням: день, часы, и сколько из них на каждый проект ---
  const dayRows: (string | number)[][] = [[t.date, t.day, t.hours, t.hm, ...perProject.map((p) => p.name)]]
  plan.days.forEach((d, i) => {
    if (!d.minutes) return
    dayRows.push([d.date, t.weekdays[d.weekday]!, hours(d.minutes), hm(d.minutes), ...perProject.map((p) => hours(cells[i]!.get(p.id) ?? 0))])
  })
  dayRows.push([t.total, '', hours(total), hm(total), ...perProject.map((p) => hours(p.minutes))])

  // --- По проектам ---
  const projectRows: (string | number)[][] = [[t.project, t.hours, t.hm, t.share]]
  for (const p of perProject) projectRows.push([p.name, hours(p.minutes), hm(p.minutes), total ? Math.round((p.minutes / total) * 1000) / 10 + '%' : ''])
  projectRows.push([t.total, hours(total), hm(total), total ? '100%' : ''])

  const summary: (string | number)[][] = [
    [t.employee, user.name],
    [t.email, user.email],
    [t.company, company.name],
    [t.month, month],
    [t.totalHours, hours(total)],
    [t.hm, hm(total)],
    [t.workDays, plan.days.filter((d) => d.minutes > 0).length],
    [t.rule, t.ruleText(maxDay)],
  ]

  const wb = XLSX.utils.book_new()
  // allNumbers — все числа листа это часы: формат один, иначе рядом «8» и «7.43».
  const sheet = (data: (string | number)[][], widths: number[], allNumbers = true) => {
    const ws = XLSX.utils.aoa_to_sheet(data)
    for (const [addr, cell] of Object.entries(ws)) {
      if (!addr.startsWith('!') && (cell as { t?: string }).t === 'n' && (allNumbers || !Number.isInteger((cell as { v: number }).v))) (cell as { z?: string }).z = '0.00'
    }
    ws['!cols'] = widths.map((w) => ({ wch: w }))
    return ws
  }
  XLSX.utils.book_append_sheet(wb, sheet(dayRows, [12, 13, 8, 8, ...perProject.map((p) => Math.min(40, Math.max(10, p.name.length)))]), t.days)
  XLSX.utils.book_append_sheet(wb, sheet(projectRows, [40, 10, 10, 8]), t.projects)
  XLSX.utils.book_append_sheet(wb, sheet(summary, [18, 90], false), t.summary)

  const out = arg('out') ?? `hours-${month}.xlsx`
  XLSX.writeFile(wb, out)

  // Отчёт в консоль: сверить глазами до того, как файл уйдёт в бухгалтерию.
  console.log(`${user.name} · ${company.name} · ${month} (${tz})`)
  for (const p of perProject) console.log(`  ${hm(p.minutes).padStart(7)}  ${p.name}`)
  console.log(`  ${hm(total).padStart(7)}  = ${hours(total).toFixed(2)} h`)
  const daysUsed = plan.days.filter((d) => d.minutes > 0)
  const max = Math.max(0, ...daysUsed.map((d) => d.minutes))
  console.log(`  days: ${daysUsed.length}, max/day ${hm(max)}${plan.usedFridays ? ', Fridays used' : ''}${plan.usedSaturdays ? ', Saturdays used' : ''}${plan.overLimit ? `, OVER ${maxDay}h/day` : ''}`)
  console.log(`  → ${out}`)
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
