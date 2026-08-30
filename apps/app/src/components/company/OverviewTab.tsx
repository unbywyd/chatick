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

  // По умолчанию — текущий месяц: за него смотрят и по нему платят.
  const [period, setPeriod] = useState<Period>(() => resolvePreset('thisMonth'))
  const [projectQuery, setProjectQuery] = useState('')

  const q = useQuery({
    queryKey: ['company-overview', companyId, period.from, period.to],
    queryFn: () =>
      api<Overview>(
        `/api/v1/companies/${companyId}/overview?from=${encodeURIComponent(period.from)}&to=${encodeURIComponent(period.to)}`,
      ),
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
   * Пять, а не десять: обзор — это верхушка, а под ним теперь ещё и люди.
   * Десять карточек отодвигали всё остальное за нижний край экрана.
   */
  const TOP_PROJECTS = 5
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
      {/* Период сверху: цифры без указания срока читаются как «за всё время»,
          а смотрят обычно за месяц. */}
      <div className="flex justify-end">
        <PeriodPicker value={period} onChange={setPeriod} className="w-52" />
      </div>

      {/* Цифры, за которыми приходят в первую очередь */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          icon={Clock}
          label={t('overview.hours')}
          value={formatDuration(totals?.minutes ?? 0)}
          onClick={onOpenHours}
          actionLabel={onOpenHours ? t('overview.toHours') : undefined}
        />
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
        <div className="mb-3 flex items-center gap-3">
          <h2 className="text-sm font-semibold">{t('overview.projects')}</h2>
          {d.projects.length > 7 && (
            <input
              value={projectQuery}
              onChange={(e) => setProjectQuery(e.target.value)}
              placeholder={t('overview.findProject')}
              className="ms-auto w-40 rounded-md border bg-background px-2.5 py-1 text-xs outline-none transition-colors focus:border-brand sm:w-56"
            />
          )}
        </div>
        <ul className="space-y-2">
          {shownProjects.length === 0 && (
            <li className="py-6 text-center text-sm text-muted-foreground">{t('overview.noProjectMatch')}</li>
          )}
          {visibleProjects.map((p) => (
            // Строка кликается целиком: на обзоре видно, где что происходит,
            // и уходить за этим в список проектов — лишний шаг.
            <li
              key={p.id}
              onClick={() => onOpenProject?.(p.id)}
              className={cn(
                '-mx-2 flex items-center gap-3 rounded-md px-2 py-1 transition-colors',
                onOpenProject && 'cursor-pointer hover:bg-accent',
              )}
            >
              <ProjectBadge name={p.name} color={p.color} logoUrl={p.logoUrl} size={28} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-sm font-medium">{p.name}</span>
                  {/* Непрочитанное мне — счётчиком у имени. Проект уже стоит
                      наверху по свежести, но без метки непонятно, почему он
                      там: порядок объясняет сам себя. */}
                  {p.unread > 0 && (
                    <span className="shrink-0 rounded-full bg-brand/15 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-brand">
                      {p.unread}
                    </span>
                  )}
                  {/* Замок — заранее видно, что внутрь не пустят: без него
                      человек кликает и упирается в отказ, гадая, что сломалось. */}
                  {!p.isMember && (
                    <span
                      className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground"
                      title={
                        p.leads.length
                          ? t('overview.askForAccess', { names: p.leads.map((l) => l.name).join(', ') })
                          : t('overview.notMember')
                      }
                    >
                      <Lock className="size-3" />
                      {/* Имя того, кого просить: замок без адресата оставляет
                          человека с вопросом «а к кому идти». */}
                      {p.leads[0] && <span className="hidden max-w-28 truncate sm:inline">{p.leads[0].name}</span>}
                    </span>
                  )}
                  {p.overdue > 0 && (
                    <span className="shrink-0 text-[10px] text-amber-500">
                      {t('overview.overdueShort', { count: p.overdue })}
                    </span>
                  )}
                </div>
                <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-secondary">
                  <span className="block h-full rounded-full bg-brand/70" style={{ width: `${p.progress}%` }} />
                </span>
              </div>
              {/* dir="ltr": та же дробь, что и в карточке сверху, и так же
                  переворачивалась бы в иврите — «сделано» и «всего» менялись
                  бы местами. */}
              <span dir="ltr" className="w-14 shrink-0 text-end text-xs tabular-nums text-muted-foreground">
                {p.tasksDone}/{p.tasksTotal}
              </span>
              <span className="hidden w-16 shrink-0 items-center justify-end gap-1 text-xs tabular-nums text-muted-foreground sm:flex">
                <Users className="size-3" />
                {p.members}
              </span>
              <span className="hidden w-20 shrink-0 items-center justify-end gap-1 text-xs tabular-nums text-muted-foreground sm:flex">
                <MessageSquare className="size-3" />
                {p.messages}
              </span>
              {/* Часы за период и, приглушённо, за всё время. Вторую цифру
                  показываем только когда она отличается: одинаковые числа
                  рядом читаются как ошибка, а не как уточнение. */}
              <span className="flex w-24 shrink-0 items-baseline justify-end gap-1.5">
                <span className="font-mono text-sm tabular-nums">{formatDuration(p.minutes)}</span>
                {p.totalMinutes > p.minutes && (
                  <span
                    className="font-mono text-[10px] tabular-nums text-muted-foreground"
                    title={t('overview.totalHoursHint')}
                  >
                    {formatDuration(p.totalMinutes)}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
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

      {/* Ритм: по неделям видно, набирает компания обороты или затухает */}
      <section className="rounded-lg border bg-card p-4">
        <h2 className="mb-3 text-sm font-semibold">{t('overview.rhythm')}</h2>
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

      {/* Что происходит в проектах: прогресс, просрочка и что стоит.

          Здесь был график «куда уходит время» — столбики по проектам. Он
          занимал пол-экрана и отвечал на один вопрос, где часы, ничего не
          говоря ни о прогрессе, ни о том, что застряло. Карточки отвечают на
          вопрос, ради которого на обзор и заходят: как идут дела. */}
      <ActiveProjects
        projects={visibleProjects}
        onOpenProject={onOpenProject}
        overLimit={overLimit}
        total={shownProjects.length}
        onShowAll={() => setAllProjects(true)}
        expanded={allProjects && !needle && shownProjects.length > TOP_PROJECTS}
        onCollapse={() => setAllProjects(false)}
      />

      {/* Проекты таблицей: прогресс, просрочка, часы и активность рядом */}
    </div>
  )
}

/**
 * Карточки проектов: как идут дела.
 *
 * Заменили график «куда уходит время». Тот занимал пол-экрана и отвечал на
 * один вопрос — где часы, — молча о том, ради чего на обзор заходят: что с
 * прогрессом и что застряло.
 *
 * По четыре в ряд, как карточки людей ниже: одна сетка на весь обзор
 * читается спокойнее, чем каждая секция по-своему.
 */
function ActiveProjects({
  projects,
  onOpenProject,
  overLimit,
  total,
  onShowAll,
  expanded,
  onCollapse,
}: {
  projects: ProjectStat[]
  onOpenProject?: (projectId: string) => void
  overLimit: boolean
  total: number
  onShowAll: () => void
  expanded: boolean
  onCollapse: () => void
}) {
  const { t } = useTranslation()
  if (!projects.length) return null

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold">{t('overview.projects')}</h2>

      <div className="grid gap-2 sm:grid-cols-2">
        {projects.map((p) => {
          // В чужой проект не пустят: карточка не кликается, и это видно по
          // курсору, а не по отказу после нажатия.
          const Tag = p.isMember && onOpenProject ? 'button' : 'div'
          return (
            <Tag
              key={p.id}
              {...(Tag === 'button' ? { onClick: () => onOpenProject!(p.id), type: 'button' as const } : {})}
              className={cn(
                'rounded-xl border bg-card p-3 text-start',
                p.isMember && onOpenProject && 'transition-colors hover:border-brand/40 hover:bg-accent/40',
              )}
            >
              <div className="flex items-center gap-2">
                {/* Логотип, если он есть; иначе ProjectBadge сам рисует
                    цветную заглушку с буквой — проект узнаётся в обоих
                    случаях, и карточки не разъезжаются по высоте. */}
                <ProjectBadge name={p.name} color={p.color} logoUrl={p.logoUrl} size={24} />
                <p className="min-w-0 flex-1 truncate text-sm font-medium">{p.name}</p>
                {/* Непрочитанное — то, из-за чего сюда стоит зайти прямо
                    сейчас; поэтому оно, а не часы, стоит первым справа. */}
                {p.unread > 0 && (
                  <span className="shrink-0 rounded-full bg-brand px-1.5 text-[11px] font-medium text-brand-fg tabular-nums">
                    {p.unread}
                  </span>
                )}
              </div>

              {/* Прогресс: полоса и числа рядом. Одна полоса без чисел не
                  говорит, велика ли работа — 90% из десяти задач и из двухсот
                  это разные новости. */}
              <div className="mt-2.5 flex items-center gap-2">
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
                  <span className="block h-full rounded-full bg-brand" style={{ width: `${p.progress}%` }} />
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {p.tasksDone}/{p.tasksTotal}
                </span>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                {/* Просрочка и застрявшее — только когда они есть. Ноль рядом
                    с «просрочено» глаз всё равно читает как тревогу. */}
                {p.overdue > 0 && (
                  <span className="text-rose-600 dark:text-rose-400">
                    <span className="font-semibold tabular-nums">{p.overdue}</span> {t('overview.overdueShort')}
                  </span>
                )}
                {p.blocked > 0 && (
                  <span className="text-amber-600 dark:text-amber-400">
                    <span className="font-semibold tabular-nums">{p.blocked}</span> {t('overview.blockedShort')}
                  </span>
                )}
                {p.minutes > 0 && (
                  <span className="text-muted-foreground">{formatDuration(p.minutes)}</span>
                )}
                {/* Проект без единой задачи: пустая карточка иначе выглядит
                    как поломка, а не как «работа ещё не заведена». */}
                {p.tasksTotal === 0 && <span className="text-muted-foreground">{t('overview.noTasksYet')}</span>}
              </div>
            </Tag>
          )
        })}
      </div>

      {/* Шторка: разворачиваем здесь, а не уводим на вкладку. */}
      {overLimit && (
        <button
          onClick={onShowAll}
          className="w-full rounded-md border border-dashed py-2 text-xs text-muted-foreground transition-colors hover:border-solid hover:text-foreground"
        >
          {t('overview.allProjects', { count: total })}
        </button>
      )}
      {expanded && (
        <button
          onClick={onCollapse}
          className="w-full rounded-md border border-dashed py-2 text-xs text-muted-foreground transition-colors hover:border-solid hover:text-foreground"
        >
          {t('overview.collapseProjects')}
        </button>
      )}
    </section>
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
