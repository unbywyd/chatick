import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Download, X } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ProjectBadge } from '@/components/ui/project-badge'
import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { PeriodPicker, resolvePreset, type Period } from '@/components/ui/period-picker'
import { PeoplePicker } from '@/components/ui/people-picker'
import * as XLSX from 'xlsx'
import { formatDuration } from '@/lib/time-parse'

// Часы по всей компании (SPEC §8.32): кто сколько отработал и на каких
// проектах. Нужно для расчётов с людьми, поэтому строки — «человек × проект»
// и выгружаются одной кнопкой.

type Person = {
  userId: string
  name: string
  avatarUrl: string | null
  minutes: number
  projects: { id: string; name: string; minutes: number; color: string | null; logoUrl: string | null }[]
  days: { day: string; minutes: number }[]
  /** рабочих дней в периоде — по ним, а не по календарным, считается среднее */
  daysWorked: number
  avgPerDay: number
}
type Report = { people: Person[]; totalMinutes: number }

type Member = { user: { id: string; name: string; email: string; avatarUrl: string | null } }

export function CompanyTimeTab({ companyId }: { companyId: string }) {
  const navigate = useNavigate()
  const { t, i18n } = useTranslation()
  // Фильтры живут в адресе: ссылку на отчёт можно переслать, а переход с
  // обзора не теряется — начальное состояние useState срабатывает только при
  // первом монтировании, и компонент про него не узнавал.
  const [params, setParams] = useSearchParams()
  // По умолчанию — текущий месяц: открывают отчёт, чтобы посмотреть, что
  // происходит сейчас, а не подвести итог позапрошлому. За прошлый месяц
  // заходят раз в месяц и выбирают его руками.
  const period: Period = {
    from: params.get('from') || resolvePreset('thisMonth').from,
    to: params.get('to') || resolvePreset('thisMonth').to,
  }
  const userId = params.get('user') ?? ''

  const patchParams = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(params)
    for (const [k, v] of Object.entries(next)) {
      if (v) p.set(k, v)
      else p.delete(k)
    }
    setParams(p, { replace: true })
  }
  const setPeriod = (v: Period) => patchParams({ from: v.from, to: v.to })
  const setUserId = (v: string) => patchParams({ user: v || null })

  const members = useQuery({
    queryKey: ['company-members', companyId],
    // сервер отдаёт массив, а не { members: [...] } — из-за этого список был
    // пуст, и выбранный человек не находился
    queryFn: () => api<Member[]>(`/api/v1/companies/${companyId}/members`),
  })

  const query = useMemo(() => {
    const p = new URLSearchParams()
    if (period.from) p.set('from', period.from)
    if (period.to) p.set('to', period.to)
    if (userId) p.set('userId', userId)
    return p.toString()
  }, [period, userId])

  const report = useQuery({
    queryKey: ['company-time', companyId, query],
    // Сессионный токен, а не проектный: это экран компании, проекта здесь
    // может не быть вовсе — запрос падал в 401 и повторялся бесконечно.
    queryFn: () => api<Report>(`/api/v1/time/company/${companyId}?${query}`),
    // Прежние данные видны, пока грузятся новые: при смене периода вкладка
    // схлопывалась в многоточие вместо того, чтобы просто обновить числа.
    placeholderData: (prev) => prev,
  })

  // Отбор людей делает выбор в панели: отдельное поле поиска убрано, оно
  // дублировало его и путало.
  const people = report.data?.people ?? []

  /**
   * Выгрузка — настоящий .xlsx, а не CSV.
   *
   * CSV Excel разбирает САМ и угадывает типы по своей локали. Угадывал он
   * плохо: «6.67» превращалось в «июн.67», «5.50» в «фев.50», а дата
   * «2026-08-15» — в «########», потому что не влезала в столбец. Человек
   * открывал файл и видел кашу из дат вместо часов.
   *
   * В xlsx тип задан явно: часы — число, дата — дата, ширина столбца своя.
   * Гадать нечего. Библиотека уже в проекте — ею выгружаются задачи.
   */
  const saveXlsx = (
    header: string[],
    rows: (string | number)[][],
    widths: number[],
    sheet: string,
    name: string,
  ) => {
    const ws = XLSX.utils.aoa_to_sheet([header, ...rows])
    ws['!cols'] = widths.map((wch) => ({ wch }))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, sheet)
    XLSX.writeFile(wb, `${name}-${period.from}_${period.to}.xlsx`)
  }

  /** Часы числом, а не строкой: по столбцу должны считаться суммы. */
  const hours = (minutes: number) => Number((minutes / 60).toFixed(2))

  /**
   * Дата в местном виде.
   *
   * Кладём строкой, а не датой: у Date в ячейке своё представление, и Excel
   * снова покажет её по-своему — вплоть до «########» в узком столбце.
   */
  const day = (iso: string) =>
    new Date(`${iso}T12:00:00`).toLocaleDateString(i18n.language, {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    })

  /** Свод: человек × проект. По нему считают, кому сколько заплатить. */
  const exportSummary = () => {
    if (!people.length) {
      toast.error(t('time.nothingToExport'))
      return
    }
    saveXlsx(
      // Заголовки на языке интерфейса: файл открывает человек, а не машина.
      [t('time.colPerson'), t('time.colProject'), t('time.colHours'), t('time.colDays'), t('time.colAvg')],
      [
        ...people.flatMap((p) =>
          p.projects.map((pr, i) => [
            p.name,
            pr.name,
            hours(pr.minutes),
            // дни и среднее относятся к человеку, а не к проекту — ставим их
            // только в первой строке, иначе сумма по столбцу соврёт
            i === 0 ? p.daysWorked : '',
            i === 0 ? hours(p.avgPerDay) : '',
          ]),
        ),
        [],
        [t('time.colTotal'), '', hours(report.data?.totalMinutes ?? 0), '', ''],
      ],
      [22, 34, 10, 14, 20],
      t('time.colHours'),
      'hours',
    )
  }

  /** Подневная: то, чем сверяют табель. */
  const exportDaily = () => {
    if (!people.length) {
      toast.error(t('time.nothingToExport'))
      return
    }
    saveXlsx(
      [t('time.colPerson'), t('time.colDate'), t('time.colHours')],
      people.flatMap((p) => p.days.map((d) => [p.name, day(d.day), hours(d.minutes)])),
      [22, 14, 10],
      t('time.colHours'),
      'hours-daily',
    )
  }

  /** Выгрузка по одному человеку: чаще всего платят именно поштучно. */
  const exportPerson = (p: Person) => {
    saveXlsx(
      [t('time.colPerson'), t('time.colDate'), t('time.colHours')],
      [
        ...p.days.map((d) => [p.name, day(d.day), hours(d.minutes)]),
        [],
        [t('time.colProjects'), '', ''],
        ...p.projects.map((pr) => [pr.name, '', hours(pr.minutes)]),
        [],
        [t('time.colTotal'), '', hours(p.minutes)],
        [t('time.colDays'), '', p.daysWorked],
        [t('time.colAvg'), '', hours(p.avgPerDay)],
      ],
      [30, 14, 10],
      t('time.colHours'),
      `hours-${p.name.replace(/\s+/g, '-').toLowerCase()}`,
    )
  }

  const maxMinutes = Math.max(1, ...people.map((p) => p.minutes))

  // Что сейчас применено — строкой под панелью. Фильтр может прийти из
  // адреса (ссылка на отчёт), и тогда человек видит непонятно урезанный
  // список, не понимая почему.
  const selectedPerson = (members.data ?? []).find((m) => m.user.id === userId)?.user
  const defaults = resolvePreset('thisMonth')
  const periodChanged = period.from !== defaults.from || period.to !== defaults.to
  const activeFilters = Boolean(userId) || periodChanged

  const resetAll = () => {
    setParams(new URLSearchParams(), { replace: true })
  }

  return (
    <div className="space-y-4">
      {/* Панель липкая: со списком в двадцать человек период и итог уезжают
          вверх, а сверяются с ними постоянно. -mx/px компенсируют отступы
          страницы, чтобы фон перекрывал контент под собой целиком. */}
      <div className="sticky -top-8 z-10 -mx-6 -mt-8 flex flex-wrap items-center gap-2 border-b bg-background px-6 pb-3 pt-8">
        <PeriodPicker value={period} onChange={setPeriod} className="w-52" />
        {/* Отдельного поля поиска здесь НЕТ намеренно.
            Их стояло два подряд, и оба отбирали людей: текстовое по имени и
            выбор ниже. При этом поиск уже встроен в сам выбор — он виден,
            стоит его раскрыть. Второе поле не добавляло ничего, кроме
            вопроса, чем они отличаются.

            Выбранного показывает строка применённых фильтров ниже — здесь
            чипс дублировал бы её. */}
        <PeoplePicker
          single
          hideChips
          className="w-52"
          people={(members.data ?? []).map((m) => m.user)}
          value={userId ? [userId] : []}
          onChange={(ids) => setUserId(ids[0] ?? '')}
          // «Все» описывает состояние, а не действие: непонятно, что
          // от поля вообще ждут. «Выбрать человека» отвечает прямо.
          placeholder={t('time.pickPerson')}
          clearLabel={t('time.everyone')}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <Download className="size-3.5" />
              {t('time.export')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={exportSummary}>{t('time.exportSummary')}</DropdownMenuItem>
            <DropdownMenuItem onSelect={exportDaily}>{t('time.exportDaily')}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="ms-auto text-sm">
          <span className="text-muted-foreground">{t('time.total')}: </span>
          <span className="font-mono text-base font-semibold tabular-nums">
            {formatDuration(report.data?.totalMinutes ?? 0)}
          </span>
        </span>
      </div>

      {/* Что применено — чипсами с крестиками. Фильтр мог прийти из адреса
          (ссылка на отчёт), и без этого список выглядит необъяснимо урезанным,
          а снять фильтр нечем. */}
      {activeFilters && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {periodChanged && (
            <FilterChip
              label={`${new Date(period.from).toLocaleDateString(i18n.language)} — ${new Date(period.to).toLocaleDateString(i18n.language)}`}
              onClear={() => setPeriod(resolvePreset('thisMonth'))}
            />
          )}
          {userId && (
            <FilterChip
              label={selectedPerson?.name ?? userId}
              avatar={selectedPerson ? { name: selectedPerson.name, src: selectedPerson.avatarUrl } : undefined}
              onClear={() => setUserId('')}
            />
          )}

          <button onClick={resetAll} className="text-xs text-muted-foreground underline-offset-4 hover:underline">
            {t('time.resetFilters')}
          </button>
        </div>
      )}

      {report.isLoading ? (
        <p className="py-10 text-center text-sm text-muted-foreground">…</p>
      ) : !people.length ? (
        <p className="py-10 text-center text-sm text-muted-foreground">{t('time.noData')}</p>
      ) : (
        <ul className="space-y-2">
          {people.map((p) => (
            <li key={p.userId} className="rounded-lg border bg-card p-3">
              <div className="flex items-center gap-3">
                <Avatar name={p.name} src={p.avatarUrl} size={28} />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{p.name}</span>
                <span className="h-2 w-32 overflow-hidden rounded-full bg-secondary">
                  <span className="block h-full rounded-full bg-brand" style={{ width: `${(p.minutes / maxMinutes) * 100}%` }} />
                </span>
                <span className="w-20 shrink-0 text-end font-mono text-base tabular-nums">{formatDuration(p.minutes)}</span>
                <button
                  onClick={() => exportPerson(p)}
                  title={t('time.exportPerson')}
                  className="shrink-0 rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <Download className="size-3.5" />
                </button>
              </div>

              {/* дни и средняя выработка: по ним сверяют табель */}
              <p className="mt-1 text-xs text-muted-foreground">
                {t('time.daysWorked', { count: p.daysWorked })} · {t('time.avgPerDay')} {formatDuration(p.avgPerDay)}
              </p>

              {/* разбивка по проектам: на какой проект списывать часы */}
              {/* Полосы через строку: без них глаз не связывает имя слева с
                  числом справа — на широкой строке они расходятся, и человек
                  ведёт пальцем по экрану. Плюс воздуха: попадать в строку
                  мышью должно быть легко.

                  Строка целиком ведёт на ВРЕМЯ проекта, а не на проект: сюда
                  приходят разбираться с часами, и лишний переход по вкладкам
                  внутри проекта — работа, которую можно не делать. */}
              <ul className="mt-2 overflow-hidden rounded-md border text-xs">
                {p.projects.map((pr, i) => (
                  <li key={pr.id} className={cn(i % 2 === 1 && 'bg-muted/40')}>
                    <button
                      onClick={() => navigate(`/c/${companyId}/p/${pr.id}/time`)}
                      title={pr.name}
                      className="flex w-full items-center gap-2 px-2 py-1.5 text-start transition-colors hover:bg-accent"
                    >
                      <ProjectBadge name={pr.name} color={pr.color} logoUrl={pr.logoUrl} size={14} />
                      <span className="min-w-0 flex-1 truncate">{pr.name}</span>
                      <span className="font-mono tabular-nums text-muted-foreground">{formatDuration(pr.minutes)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Применённый фильтр: видно, что включено, и снимается одним нажатием. */
function FilterChip({
  label,
  avatar,
  onClear,
}: {
  label: string
  avatar?: { name: string; src: string | null }
  onClear: () => void
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border bg-card py-0.5 pe-1.5 ps-2 text-xs">
      {avatar && <Avatar name={avatar.name} src={avatar.src} size={16} />}
      <span className="max-w-52 truncate">{label}</span>
      <button
        type="button"
        onClick={onClear}
        className="rounded-full p-0.5 text-muted-foreground transition-colors hover:text-destructive"
      >
        <X className="size-3" />
      </button>
    </span>
  )
}
