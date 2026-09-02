import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, ChevronRight, Clock, FolderKanban, Lock, MessageSquare, Users, X } from 'lucide-react'
import {
  Area,
  AreaChart,
  Bar,
  CartesianGrid,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { PeriodPicker, resolvePreset, type Period } from '@/components/ui/period-picker'
import { PeopleStats } from './PeopleStats'
import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { ProjectBadge } from '@/components/ui/project-badge'
import { ChartBox } from '@/components/ui/chart-box'
import { formatDuration } from '@/lib/time-parse'

// Обзор компании (SPEC §8.33): то, чего не видно в списке проектов —
// распределение нагрузки между проектами и людьми и ритм последних недель.

type ProjectStat = {
  id: string
  name: string
  color: string
  logoUrl: string | null
  tasksTotal: number
  tasksDone: number
  overdue: number
  /** Задачи, ждущие другую незакрытую задачу: работа упёрлась. */
  blocked: number
  progress: number
  members: number
  /** Я в команде этого проекта. Нет — содержимое закрыто, войти не выйдет. */
  isMember: boolean
  /** К кому идти за доступом. Приходит только для чужих проектов. */
  leads: { id: string; name: string; avatarUrl: string | null }[]
  minutes: number
  /** За всё время — чтобы часы за период не читались как «часов нет». */
  totalMinutes: number
  messages: number
  /** Когда меня последний раз затронуло в этом проекте. Null — ни разу. */
  lastTouchedAt: string | null
  /** Непрочитанные уведомления мне — по ним проект помечается на обзоре. */
  unread: number
}
type OverdueTask = {
  id: string
  number: string
  title: string
  status: string
  dueDate: string | null
  /** Сколько дней горит — считает сервер, чтобы клиент не вычитал даты. */
  overdueDays: number
  project: { id: string; name: string; color: string | null }
  assignee: { id: string; name: string; avatarUrl: string | null } | null
  /** Человек в этом проекте — иначе открыть задачу он не сможет. */
  isMember: boolean
}

type Overview = {
  projects: ProjectStat[]
  totals: {
    projects: number
    people: number
    tasksTotal: number
    tasksDone: number
    overdue: number
    minutes: number
    messages: number
  }
  weeks: { week: string; minutes: number }[]
}

const CHART_STYLE = {
  background: 'var(--popover)',
  border: '1px solid var(--border)',
  borderRadius: '0.5rem',
  fontSize: '0.75rem',
  color: 'var(--popover-foreground)',
}

/**
 * Цвет текста внутри подсказки.
 *
 * Recharts красит значение в цвет самого столбика, а столбики у нас лаймовые:
 * на белой подложке подсказки контраст 1.2 — цифру не прочитать. Столбик и так
 * виден рядом, цвет в тексте ничего не добавляет.
 */
const CHART_ITEM_STYLE = { color: 'var(--popover-foreground)' }
const CHART_LABEL_STYLE = { color: 'var(--muted-foreground)' }

export function OverviewTab({
  companyId,
  onOpenProject,
  onOpenReport,
  onOpenHours,
  onOpenTeam,
  onOpenTask,
}: {
  companyId: string
  onOpenProject?: (id: string) => void
  /** отчёт по человеку за тот же период — на вкладке «Часы» */
  onOpenReport?: (userId: string, period: Period) => void
  /** Вкладка «Часы» целиком — с карточки «Отработано». */
  onOpenHours?: () => void
  /** Вкладка «Команда» — с карточки «Людей». */
  onOpenTeam?: () => void
  /** Открыть конкретную задачу в её проекте — из списка просроченных. */
  onOpenTask?: (projectId: string, taskId: string) => void
}) {
  // Модалка просроченных: цифра отвечает «сколько», список — «где».
  const [overdueOpen, setOverdueOpen] = useState(false)
  /**
   * Шторка развёрнута: показываем все проекты прямо здесь.
   *
   * Раньше «Все проекты» уводило на соседнюю вкладку — человек терял место, к
   * которому шёл, и возвращался кнопкой «назад». Разворачиваем на месте.
   */
  const [allProjects, setAllProjects] = useState(false)
  const { t, i18n } = useTranslation()

  /**
   * По умолчанию — ПРОШЛЫЙ месяц, а не текущий.
   *
   * Текущий на первых числах пуст: второго сентября «этот месяц» — это два
   * дня, и график с часами показывал почти нулевую полосу. Человек открывает
   * обзор и видит спад, которого нет: месяц просто не наступил.
   *
   * Прошлый месяц всегда полный, и сравнивать его есть с чем.
   */
  const [period, setPeriod] = useState<Period>(() => resolvePreset('lastMonth'))
  const [projectQuery, setProjectQuery] = useState('')

  const q = useQuery({
    queryKey: ['company-overview', companyId, period.from, period.to],
    queryFn: () =>
      api<Overview>(
        `/api/v1/companies/${companyId}/overview?from=${encodeURIComponent(period.from)}&to=${encodeURIComponent(period.to)}`,
      ),
    /**
     * При смене периода держим прежние данные на экране.
     *
     * Период входит в ключ запроса, и без этого react-query считает новый
     * период новыми данными: q.data становится undefined, срабатывает
     * заглушка «…», и вся страница мигает целиком — включая просрочку,
     * прогресс и людей, которые от периода не зависят вовсе.
     *
     * Теперь меняются только числа, которым положено меняться.
     */
    placeholderData: (prev) => prev,
  })

  const d = q.data
  const totals = d?.totals
  // Фильтруем только список; график остаётся полным — на нём смотрят
  // распределение целиком, и «отфильтрованное время» вводило бы в заблуждение.
  const needle = projectQuery.trim().toLowerCase()
  const shownProjects = needle
    ? (d?.projects ?? []).filter((p) => p.name.toLowerCase().includes(needle))
    : (d?.projects ?? [])

  /**
   * На обзоре — только то, куда человек пойдёт; остальное под шторкой.
   *
   * В компании с двумя десятками проектов список занимал всю страницу, и
   * нужный искали глазами — хотя заходят в проекты почти всегда именно
   * отсюда. Сервер уже отдал их в порядке «где меня коснулось свежее
   * всего», поэтому здесь достаточно отрезать хвост.
   *
   * Шесть, а не десять: обзор — это верхушка, а под ним теперь ещё и люди.
   * Десять карточек отодвигали всё остальное за нижний край экрана.
   *
   * Именно шесть, а не пять: сетка в две колонки, и нечётное число оставляет
   * дыру в последнем ряду.
   */
  const TOP_PROJECTS = 6
  // При поиске предел снимаем: человек ищет конкретный проект, и «найдено,
  // но не показано» — худшее, что можно ответить.
  const overLimit = !needle && !allProjects && shownProjects.length > TOP_PROJECTS
  const visibleProjects = overLimit ? shownProjects.slice(0, TOP_PROJECTS) : shownProjects

  if (q.isLoading) return <p className="py-16 text-center text-sm text-muted-foreground">…</p>
  if (!d || !d.projects.length) {
    return <p className="py-16 text-center text-sm text-muted-foreground">{t('overview.empty')}</p>
  }

  const doneShare = totals?.tasksTotal ? Math.round((totals.tasksDone / totals.tasksTotal) * 100) : 0

  /**
   * Для графика — только проекты, где время есть.
   *
   * Пустой столбик не отвечает на вопрос «куда уходит время»: он занимает
   * строку и говорит «никуда». Список ниже показывает ВСЕ проекты — это его
   * работа, там ноль часов у нового проекта осмыслен.
   */

  return (
    <div className="space-y-5">
      {/*
        Цифры, за которыми приходят в первую очередь.

        ВСЕ ТРИ — про «сейчас», и переключателя периода здесь нет намеренно.
        Он висел над этим рядом и выглядел как период всей страницы, хотя
        правил двумя показателями из девяти: «просрочено» и «прогресс»
        прошлого не имеют вовсе — за июль их не восстановить, статусы с тех
        пор менялись, и истории у них нет.

        Переключатель уехал внутрь секции часов — туда, где он и работает.
      */}
      <div className="grid gap-3 sm:grid-cols-3">
        <Metric
          icon={CheckCircle2}
          label={t('overview.tasks')}
          value={`${totals?.tasksDone ?? 0} / ${totals?.tasksTotal ?? 0}`}
          hint={`${doneShare}%`}
        />
        <Metric
          icon={AlertTriangle}
          label={t('overview.overdue')}
          value={String(totals?.overdue ?? 0)}
          // просрочка — единственное, что здесь стоит подсвечивать тревожно
          tone={totals?.overdue ? 'warn' : undefined}
          // Клик только когда есть что показывать: пустая модалка на нуле —
          // обещание, за которым ничего нет.
          onClick={totals?.overdue ? () => setOverdueOpen(true) : undefined}
          actionLabel={totals?.overdue ? t('overview.details') : undefined}
        />
        <Metric
          icon={Users}
          label={t('overview.people')}
          value={String(totals?.people ?? 0)}
          onClick={onOpenTeam}
          actionLabel={onOpenTeam ? t('overview.toTeam') : undefined}
        />
      </div>

      {overdueOpen && (
        <OverdueDialog
          companyId={companyId}
          onClose={() => setOverdueOpen(false)}
          onOpenProject={(id) => {
            setOverdueOpen(false)
            onOpenProject?.(id)
          }}
          onOpenTask={(projectId, taskId) => {
            setOverdueOpen(false)
            onOpenTask?.(projectId, taskId)
          }}
        />
      )}

      <section className="rounded-lg border bg-card p-4">
        {/* Поиск появляется, когда список перестаёт читаться с одного взгляда.
            При пяти проектах поле только мешает, при двадцати — без него
            нужный ищут глазами по всей странице. */}
        {/* flex-wrap и min-w-0: на телефоне заголовок и поле в одной строке
            не помещались и распирали страницу вбок — отсюда горизонтальная
            прокрутка внизу. Теперь поле переносится на вторую строку. */}
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-semibold">{t('overview.projects')}</h2>
          {d.projects.length > 7 && (
            <input
              value={projectQuery}
              onChange={(e) => setProjectQuery(e.target.value)}
              placeholder={t('overview.findProject')}
              className="ms-auto w-full min-w-0 rounded-md border bg-background px-2.5 py-1 text-xs outline-none transition-colors focus:border-brand sm:w-56"
            />
          )}
        </div>
        {shownProjects.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t('overview.noProjectMatch')}</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {visibleProjects.map((p) => {
              // В чужой проект не пустят: карточка не кликается, и это видно
              // по курсору, а не по отказу после нажатия.
              const Tag = p.isMember && onOpenProject ? 'button' : 'div'
              return (
                <Tag
                  key={p.id}
                  {...(Tag === 'button' ? { onClick: () => onOpenProject!(p.id), type: 'button' as const } : {})}
                  className={cn(
                    // min-w-0 на САМОЙ карточке: элемент сетки по умолчанию не
                    // сжимается уже своего содержимого, и длинное имя проекта
                    // распирало карточку шире колонки — на 320px она выходила
                    // за экран на 10px и давала горизонтальную прокрутку всей
                    // страницы. Та же причина, что была у полоски активности.
                    'min-w-0 rounded-xl border bg-card p-3 text-start',
                    p.isMember && onOpenProject && 'transition-colors hover:border-brand/40 hover:bg-accent/40',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <ProjectBadge name={p.name} color={p.color} logoUrl={p.logoUrl} size={24} />
                    {/* min-w-0 обязателен: без него flex-элемент не сжимается
                        уже своего текста, и длинное имя выдавливает счётчики
                        за край карточки — на 320px от «5» оставалась половина
                        цифры. */}
                    <p className="min-w-0 flex-1 truncate text-sm font-medium">{p.name}</p>
                    {/* Непрочитанное — то, из-за чего стоит зайти прямо
                        сейчас; поэтому оно, а не числа, стоит первым справа. */}
                    {p.unread > 0 && (
                      <span className="shrink-0 rounded-full bg-brand px-1.5 text-[11px] font-medium text-brand-fg tabular-nums">
                        {p.unread}
                      </span>
                    )}
                    {/* Чужой проект: видно заранее, что внутрь не пустят. */}
                    {!p.isMember && <Lock className="size-3 shrink-0 text-muted-foreground" />}

                    {/* Люди и переписка — В ШАПКЕ, а не внизу карточки.
                        Это фон проекта: он не меняется от того, как идут
                        дела, и читать его строкой ниже незачем — она из-за
                        них жила в каждой карточке, даже когда сказать было
                        нечего. Внизу теперь только тревожное, и у спокойного
                        проекта строки нет вовсе. */}
                    <span className="shrink-0 inline-flex items-center gap-2 text-[11px] text-muted-foreground">
                      {/* Просрочка и застрявшее — ТОЖЕ здесь, цветом.
                          Отдельная строка под полосой существовала ради двух
                          чисел, которые есть не всегда, и держала высоту
                          КАЖДОЙ карточки. Цвет отличает их от серого фона
                          не хуже, чем отдельная строка, а слово рядом с
                          числом на своём месте: «4» под именем проекта
                          прочтут как что угодно.
                          Нули не показываем: ноль рядом со словом
                          «просрочено» глаз читает как тревогу. */}
                      {p.overdue > 0 && (
                        <span className="inline-flex items-center gap-1 text-rose-600 dark:text-rose-400">
                          <span className="font-semibold tabular-nums">{p.overdue}</span>
                          <span className="hidden min-[380px]:inline">{t('overview.overdueShort')}</span>
                        </span>
                      )}
                      {p.blocked > 0 && (
                        <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                          <span className="font-semibold tabular-nums">{p.blocked}</span>
                          <span className="hidden min-[380px]:inline">{t('overview.blockedShort')}</span>
                        </span>
                      )}
                      <span className="inline-flex items-center gap-1">
                        <Users className="size-3" />
                        {p.members}
                      </span>
                      {/* На узком экране переписку прячем: на 320px имени
                          остаётся 110px, и «Simply Touch (רון דגן…)»
                          обрезается до пары букв. Люди важнее — по ним видно,
                          свой проект или чужой; сколько в нём переписки,
                          видно внутри. */}
                      {p.messages > 0 && (
                        <span className="hidden items-center gap-1 min-[380px]:inline-flex">
                          <MessageSquare className="size-3" />
                          {p.messages}
                        </span>
                      )}
                    </span>
                  </div>

                  {/* Полоса и числа рядом: одна полоса не говорит, велика ли
                      работа — 90% из десяти задач и из двухсот это разные
                      новости. */}
                  <div className="mt-2.5 flex items-center gap-2">
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
                      <span className="block h-full rounded-full bg-brand" style={{ width: `${p.progress}%` }} />
                    </span>
                    <span dir="ltr" className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                      {p.tasksDone}/{p.tasksTotal}
                    </span>
                  </div>

                  {/* Строка тревоги — только когда есть о чём тревожиться.
                      Раньше она стояла всегда, потому что несла людей и
                      сообщения; те уехали в шапку, и у спокойного проекта
                      карточка стала на строку ниже.

                      Часов здесь НЕТ: они живут отрезком времени, а
                      переключатель периода стоит ниже, в секции часов. Число,
                      молча меняющееся от элемента внизу экрана, — ровно та
                      немота, из-за которой он туда и переехал. */}
                  {/* Осталась одна причина для третьей строки: пустой проект.
                      Полоса прогресса у него ничего не показывает, и без слов
                      «0/0» читается как «всё сделано». */}
                  {p.tasksTotal === 0 && (
                    <p className="mt-2 text-[11px] text-muted-foreground">{t('overview.noTasksYet')}</p>
                  )}
                </Tag>
              )
            })}
          </div>
        )}

        {/* Шторка: разворачиваем список ЗДЕСЬ, а не уводим на вкладку —
            человек шёл в конкретный проект, и терять место незачем. Число в
            подписи: «Все проекты» без него не говорит, стоит ли открывать. */}
        {overLimit && (
          <button
            onClick={() => setAllProjects(true)}
            className="mt-3 w-full rounded-md border border-dashed py-2 text-xs text-muted-foreground transition-colors hover:border-solid hover:text-foreground"
          >
            {t('overview.allProjects', { count: shownProjects.length })}
          </button>
        )}
        {/* Развернули — даём свернуть обратно: иначе длинный список остаётся
            навсегда, и обзор перестаёт быть обзором. */}
        {allProjects && !needle && shownProjects.length > TOP_PROJECTS && (
          <button
            onClick={() => setAllProjects(false)}
            className="mt-3 w-full rounded-md border border-dashed py-2 text-xs text-muted-foreground transition-colors hover:border-solid hover:text-foreground"
          >
            {t('overview.collapseProjects')}
          </button>
        )}
      </section>

      {/* Люди — сразу под проектами: «что делается» и «кто делает» стоят
          рядом, а не через весь экран друг от друга. */}
      <PeopleStats companyId={companyId} onOpenReport={onOpenReport} />

      {/*
        Часы: единственное на обзоре, что живёт ОТРЕЗКОМ ВРЕМЕНИ.

        Переключатель периода стоит здесь, а не в шапке страницы. В шапке он
        читался как «период всего экрана» и обещал больше, чем делает:
        просрочка, прогресс и «стоят» отвечают на вопрос «как сейчас», и
        прошлого у них нет — за июль их не посчитать, потому что статусы с тех
        пор менялись, а истории у них не ведётся.

        Рядом с переключателем — сумма за тот же период: раньше она стояла
        метрикой в верхнем ряду, среди чисел «на сейчас», и одна там жила по
        другим правилам, ничем этого не показывая.
      */}
      <section className="rounded-lg border bg-card p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-baseline gap-2">
            <h2 className="text-sm font-semibold">{t('overview.rhythm')}</h2>
            <span className="font-mono text-sm tabular-nums">{formatDuration(totals?.minutes ?? 0)}</span>
            {onOpenHours && (
              <button
                onClick={onOpenHours}
                className="text-xs text-muted-foreground transition-colors hover:text-brand-ink"
              >
                {t('overview.toHours')}
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Пока едут новые числа — приглушаем секцию, а не гасим страницу:
                видно, что период применился и ответ в пути. */}
            {q.isFetching && <span className="text-xs text-muted-foreground">…</span>}
            {/* На телефоне во всю ширину: 208px рядом с суммой не помещались,
                и строка распирала карточку. */}
            <PeriodPicker value={period} onChange={setPeriod} className="w-full sm:w-52" />
          </div>
        </div>
        {d.weeks.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t('time.noData')}</p>
        ) : (
          <ChartBox height={180}>
            <AreaChart data={d.weeks} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="rhythm" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--brand)" stopOpacity={0.5} />
                  <stop offset="100%" stopColor="var(--brand)" stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} strokeDasharray="3 3" className="stroke-border" />
              <XAxis
                dataKey="week"
                tickFormatter={(w: string) => `${w.slice(8)}.${w.slice(5, 7)}`}
                tickLine={false}
                axisLine={false}
                className="text-[10px]"
                stroke="currentColor"
                opacity={0.5}
              />
              <YAxis
                tickFormatter={(m: number) => String(Math.round(m / 60))}
                tickLine={false}
                axisLine={false}
                width={32}
                allowDecimals={false}
                className="text-[10px]"
                stroke="currentColor"
                opacity={0.5}
              />
              <Tooltip
                contentStyle={CHART_STYLE}
                itemStyle={CHART_ITEM_STYLE}
                labelStyle={CHART_LABEL_STYLE}
                labelFormatter={(w) =>
                  t('overview.weekOf', {
                    date: new Date(`${String(w)}T00:00:00`).toLocaleDateString(i18n.language, {
                      day: 'numeric',
                      month: 'long',
                    }),
                  })
                }
                formatter={(m) => [formatDuration(Number(m)), t('time.total')]}
              />
              <Area type="monotone" dataKey="minutes" stroke="var(--brand)" strokeWidth={2} fill="url(#rhythm)" />
            </AreaChart>
          </ChartBox>
        )}
      </section>

      {/* Проекты таблицей: прогресс, просрочка, часы и активность рядом */}
    </div>
  )
}

function Metric({
  icon: Icon,
  label,
  value,
  hint,
  tone,
  onClick,
  actionLabel,
}: {
  icon: typeof Clock
  label: string
  value: string
  hint?: string
  tone?: 'warn'
  /** Карточка ведёт куда-то — тогда она становится кнопкой. */
  onClick?: () => void
  /** Что будет по клику: «Подробнее», «К часам». Видно СРАЗУ, а не по наведению. */
  actionLabel?: string
}) {
  /**
   * Кликабельность должна быть видна до наведения.
   *
   * Курсор и подсветка на hover работают только для того, кто уже навёл — а
   * навести можно лишь туда, где ждёшь ответа. Поэтому подпись действия и
   * стрелка стоят в карточке постоянно, а hover их только подчёркивает.
   *
   * Кнопка, а не div с onClick: клавиатура и скринридер иначе проходят мимо.
   */
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag
      {...(onClick ? { type: 'button' as const, onClick } : {})}
      className={cn(
        'rounded-lg border bg-card p-3 text-start',
        onClick && 'group w-full cursor-pointer transition-colors hover:border-brand/60 hover:bg-accent/40',
      )}
    >
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className={cn('size-3.5', tone === 'warn' && 'text-amber-500')} />
        {label}
      </p>
      {/* dir="ltr" — иначе в иврите «231 / 480» переворачивается в «480 / 231»,
          и цифры меняются смыслом: выходит, что сделано больше, чем всего.

          Переворота ряда тут быть не должно. dir="ltr" уже задал порядок
          внутри: сначала число, потом проценты. row-reverse менял их местами
          заново, и доля уезжала влево от числа — впереди того, к чему
          относится.

          Прижимаем к началу строки: в иврите это правый край, как и вся
          карточка. */}
      <p
        dir="ltr"
        className={cn(
          'mt-1 flex items-baseline gap-2 font-mono text-xl font-semibold tabular-nums rtl:justify-end',
          tone === 'warn' && 'text-amber-500',
        )}
      >
        <span>{value}</span>
        {hint && <span className="font-sans text-xs font-normal text-muted-foreground">{hint}</span>}
      </p>
      {actionLabel && (
        <p className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground transition-colors group-hover:text-brand-ink">
          {actionLabel}
          {/* Стрелка по направлению чтения: в иврите она смотрит влево. */}
          <ChevronRight className="size-3 rtl:rotate-180" />
        </p>
      )}
    </Tag>
  )
}

/**
 * Просроченные задачи — списком.
 *
 * Цифра на карточке отвечает «сколько», не отвечая «где». Человек шёл
 * смотреть проект за проектом, и чем больше проектов, тем дольше.
 *
 * Группируем по проектам: просрочка редко бывает равномерной, обычно горит
 * один-два — и это первое, что нужно увидеть.
 */
function OverdueDialog({
  companyId,
  onClose,
  onOpenProject,
  onOpenTask,
}: {
  companyId: string
  onClose: () => void
  onOpenProject: (id: string) => void
  onOpenTask: (projectId: string, taskId: string) => void
}) {
  const { t } = useTranslation()
  const list = useQuery({
    queryKey: ['company-overdue', companyId],
    queryFn: () => api<{ items: OverdueTask[] }>(`/api/v1/companies/${companyId}/overdue`),
  })

  const items = list.data?.items ?? []
  // Группировка по проекту: горит обычно не везде, а в одном-двух местах.
  const byProject = new Map<string, { name: string; isMember: boolean; tasks: OverdueTask[] }>()
  for (const task of items) {
    const found = byProject.get(task.project.id)
    if (found) found.tasks.push(task)
    else byProject.set(task.project.id, { name: task.project.name, isMember: task.isMember, tasks: [task] })
  }
  // Свои проекты первыми: в чужие человек всё равно не войдёт.
  const groups = [...byProject.entries()].sort(
    (a, b) => (a[1].isMember === b[1].isMember ? b[1].tasks.length - a[1].tasks.length : a[1].isMember ? -1 : 1),
  )

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-16"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-xl border bg-card shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b p-4">
          <h2 className="flex items-center gap-2 text-lg font-bold">
            <AlertTriangle className="size-5 text-amber-500" />
            {t('overview.overdueTitle', { count: items.length })}
          </h2>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto p-4">
          {list.isLoading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t('common.loading')}</p>
          ) : !items.length ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t('overview.noOverdue')}</p>
          ) : (
            <div className="space-y-4">
              {groups.map(([projectId, group]) => (
                <section key={projectId}>
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <h3 className="flex items-center gap-1.5 text-sm font-medium">
                      <FolderKanban className="size-3.5 text-muted-foreground" />
                      {group.name}
                      <span className="text-xs font-normal text-muted-foreground">{group.tasks.length}</span>
                    </h3>
                    {group.isMember ? (
                      <button
                        type="button"
                        onClick={() => onOpenProject(projectId)}
                        className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-brand-ink"
                      >
                        {t('overview.toProject')}
                        <ChevronRight className="size-3 rtl:rotate-180" />
                      </button>
                    ) : (
                      // Не в команде — говорим сразу, а не отказом по клику.
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Lock className="size-3" />
                        {t('overview.notMember')}
                      </span>
                    )}
                  </div>

                  <ul className="space-y-1">
                    {group.tasks.map((task) => (
                      <li key={task.id}>
                        <button
                          type="button"
                          disabled={!group.isMember}
                          onClick={() => onOpenTask(projectId, task.id)}
                          className={cn(
                            'flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-start text-sm',
                            group.isMember
                              ? 'transition-colors hover:border-brand/60 hover:bg-accent/40'
                              : 'cursor-default opacity-60',
                          )}
                        >
                          <span className="font-mono text-xs text-muted-foreground">{task.number}</span>
                          <span className="min-w-0 flex-1 truncate">{task.title}</span>
                          {/* Дней просрочки, а не дата: «12 дней» читается сразу,
                              дату надо вычитать из сегодняшней в уме. */}
                          <span className="shrink-0 text-xs text-amber-600 dark:text-amber-500">
                            {t('overview.overdueDays', { count: task.overdueDays })}
                          </span>
                          {task.assignee && (
                            <Avatar name={task.assignee.name} src={task.assignee.avatarUrl} className="size-5 shrink-0" />
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** Иконка проекта в шапке вкладки — на случай пустой компании. */
export const OverviewIcon = FolderKanban
