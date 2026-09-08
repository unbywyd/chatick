import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Download, FolderKanban, Lock, Users, X } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/avatar'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

/**
 * Статистика по людям компании.
 *
 * Кто чем занят, когда в последний раз что-то СДЕЛАЛ, сколько наработал за
 * месяц. Админ видит всех, участник — только себя; решает это сервер, здесь мы
 * лишь показываем присланное.
 *
 * Развёрнуто по умолчанию показываем немногих: в живой компании двенадцать
 * человек, и у половины нет ни одной задачи. Карточки на всех сразу удлинили
 * бы главную страницу вдвое ради пустых строк.
 */

type Person = {
  id: string
  name: string
  avatarUrl: string | null
  role: string
  /** Последнее ДЕЙСТВИЕ: правка, сообщение, комментарий. Чтение не считается. */
  lastActiveAt: string | null
  /** Даты с активностью — для полоски. */
  activeDays: string[]
  openTasks: number
  doneTasks: number
  minutesThisMonth: number
  rhythm: Rhythm
}

/**
 * Как человек ОТВЕЧАЕТ на задачи.
 *
 * Здесь намеренно нет возраста задачи и «процента доведения»: оба меряют
 * очередь, а не человека. На живых данных по среднему возрасту открытых задач
 * худшим выходил самый быстрый исполнитель компании — просто на него заводят
 * вдвое больше, чем он успевает взять.
 *
 * Пороги для flags считает СЕРВЕР: правило, выписанное дважды, однажды
 * разойдётся. Здесь только выбираем текст.
 */
type Rhythm = {
  openNow: number
  untouched: number
  waitAvgDays: number
  waitWorstDays: number
  over2w: number
  /** null — не «ноль», а «не к чему было прикасаться». */
  /**
   * Медиана времени до первого касания ЧУЖОЙ задачи.
   *
   * null — когда таких откликов меньше трёх: медиана по одному-двум числам
   * это само число, а не медиана. Самозаведённые задачи в счёт не идут — их
   * трогают в ту же минуту, и они топили метрику у всех.
   */
  reactMedianHours: number | null
  /** На скольких откликах стоит медиана: объясняет прочерк. */
  reactSample: number
  closed: number
  medianLifeDays: number | null
  blocking: number
  blockingWorstDays: number
  actions: number
  comments: number
  openProjects: number
  topProject: { name: string; open: number } | null
  flags: string[]
}

/** За какой срок считаем ритм. Список закрытый — его же проверяет сервер. */
const PERIODS = [7, 30, 90] as const

/** Сколько показываем до нажатия «показать всех». */
const PREVIEW = 4

/**
 * «2 часа назад», «вчера», «12 августа».
 *
 * Часы — пока они отвечают на вопрос точнее даты. Дальше суток человеку важно
 * не «53 часа назад», а «позавчера»; ещё дальше — просто число.
 *
 * Через Intl: склонения, порядок слов и «вчера» на иврите берёт на себя
 * браузер. Своя таблица на три языка разъехалась бы на первом же «5 часов»
 * против «5 часа».
 */
function useAgo() {
  const { i18n } = useTranslation()
  return (iso: string | null): string => {
    if (!iso) return '—'
    const then = new Date(iso)
    const mins = Math.round((Date.now() - then.getTime()) / 60000)
    const rtf = new Intl.RelativeTimeFormat(i18n.language, { numeric: 'auto' })
    if (mins < 1) return rtf.format(0, 'minute')
    if (mins < 60) return rtf.format(-mins, 'minute')
    const hours = Math.round(mins / 60)
    if (hours < 24) return rtf.format(-hours, 'hour')
    const days = Math.round(hours / 24)
    // «Вчера» и «позавчера» Intl отдаёт словом при numeric:'auto'. Дальше —
    // дата: «6 дней назад» заставляет считать в уме, а число не заставляет.
    if (days <= 2) return rtf.format(-days, 'day')
    return then.toLocaleDateString(i18n.language, { day: 'numeric', month: 'short' })
  }
}

/** Дальше этого не заглядываем, даже если компания старше. */
const MAX_STRIP_DAYS = 90

/**
 * Полоска активности.
 *
 * Не насыщенность, как у гитхаба, а факт: был день или не был. Считать
 * «сколько сделано» не по чему — правка описания и закрытая задача весят в
 * журнале одинаково, и раскрашивать их разной густотой значило бы придумать
 * точность, которой нет.
 *
 * Длина полосы РАСТЁТ ВМЕСТЕ С ИСТОРИЕЙ: от первого дня компании, но не
 * глубже 90 суток. Жёсткие 90 у молодой компании давали две трети пустых
 * клеток, и читались они как «человек не работал», хотя означали «нас тогда
 * здесь не было» — в живой компании вся история 26 дней.
 */
function ActivityStrip({ days, since }: { days: string[]; since: string | null }) {
  const { t, i18n } = useTranslation()
  const set = new Set(days.map((d) => d.slice(0, 10)))

  // Сколько дней рисуем: от первого дня компании, но в пределах 90.
  const from = since ? new Date(since) : null
  const spanDays = from
    ? Math.min(MAX_STRIP_DAYS, Math.max(1, Math.round((Date.now() - from.getTime()) / 86400000) + 1))
    : MAX_STRIP_DAYS

  const cells: { key: string; active: boolean }[] = []
  for (let i = spanDays - 1; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const key = d.toISOString().slice(0, 10)
    cells.push({ key, active: set.has(key) })
  }

  const fmt = (key: string) =>
    new Date(key).toLocaleDateString(i18n.language, { day: 'numeric', month: 'long' })

  return (
    <div>
      {/* min-w-0 на полосе и клетках: без него flex-элемент не сжимается уже
          своего содержимого, и 28 клеток с зазорами распирали страницу на
          узком экране — отсюда горизонтальная прокрутка внизу всей страницы.
          В RTL она же ломала расчёт высоты, и низ содержимого обрезался. */}
      <div className="flex min-w-0 gap-px">
        {cells.map((c) => (
          <span
            key={c.key}
            /* Дата и что в этот день было. Просто дата на пустой клетке
               оставляет вопрос «и что?» — говорим прямо: работал или нет. */
            title={`${fmt(c.key)} — ${c.active ? t('people.dayActive') : t('people.dayIdle')}`}
            className={cn(
              'h-4 min-w-0 flex-1 rounded-[1px] transition-colors',
              c.active ? 'bg-brand hover:bg-brand/80' : 'bg-muted-foreground/15 hover:bg-muted-foreground/30',
            )}
          />
        ))}
      </div>
      {/* Подпись: иначе непонятно, что за полоса и за какой срок. */}
      <p className="mt-1 text-[11px] text-muted-foreground">
        {t('people.activeDays', { count: set.size, days: spanDays })}
      </p>
    </div>
  )
}

/**
 * Часы реакции → «40 мин» / «1.5 ч» / «4.8 дн».
 *
 * Единица меняется, потому что «115 часов» человек всё равно делит в уме на
 * сутки, а «0.01 дня» не читается вовсе.
 */
function reactValue(hours: number | null): { value: string; unit: 'min' | 'hour' | 'day' } | null {
  if (hours === null) return null
  if (hours < 1) return { value: String(Math.max(1, Math.round(hours * 60))), unit: 'min' }
  if (hours < 48) return { value: hours.toFixed(1), unit: 'hour' }
  return { value: (hours / 24).toFixed(1), unit: 'day' }
}

/** Один показатель в карточке. */
function Metric({
  label,
  value,
  unit,
  note,
  tone,
}: {
  label: string
  value: string
  unit?: string
  note?: string
  tone?: 'ok' | 'warn' | 'bad'
}) {
  return (
    <div className="min-w-0">
      <p className="truncate text-[10px] uppercase tracking-wide text-muted-foreground/70">{label}</p>
      <p
        className={cn(
          'mt-0.5 text-base font-semibold tabular-nums',
          tone === 'ok' && 'text-emerald-600 dark:text-emerald-400',
          tone === 'warn' && 'text-amber-600 dark:text-amber-400',
          tone === 'bad' && 'text-red-600 dark:text-red-400',
        )}
      >
        {value}
        {unit && <span className="ms-0.5 text-[11px] font-medium text-muted-foreground">{unit}</span>}
      </p>
      {note && <p className="truncate text-[10px] text-muted-foreground/70">{note}</p>}
    </div>
  )
}

/**
 * Ритм внутри карточки человека.
 *
 * Ярлыки объясняют цифру словами: «6 чужих задач стоят 27 дней» — факт, с
 * которым можно прийти к человеку, в отличие от «работает медленно».
 */
type FlagTask = {
  id: string
  number: string
  title: string
  status: string
  /** Сколько дней задача существует и остаётся нетронутой. */
  days: number
  /** Сколько ЧУЖИХ задач ждут эту. Только для флага blocking. */
  holds: number
  project: { id: string; name: string }
  /** Я в команде этого проекта — иначе задачу не открыть. */
  isMember: boolean
}

/**
 * Задачи за флагом — списком.
 *
 * Плашка называет число («7 ждут дольше двух недель»), но разбирать их всё
 * равно идти, а по семи проектам это семь заходов. Здесь они одним списком,
 * с возрастом и проектом.
 *
 * Группировки по проектам нет намеренно: задач единицы, а порядок «самая
 * давняя сверху» отвечает на «с чего начать» лучше, чем алфавит проектов.
 */
function FlagTasksDialog({
  companyId,
  userId,
  personName,
  flag,
  label,
  onClose,
}: {
  companyId: string
  userId: string
  personName: string
  flag: string
  label: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const q = useQuery({
    queryKey: ['people-flag', companyId, userId, flag],
    queryFn: () =>
      api<{ items: FlagTask[] }>(`/api/v1/companies/${companyId}/people/${userId}/flag/${flag}`),
  })
  const items = q.data?.items ?? []

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-16"
      onClick={onClose}
    >
      <div className="w-full max-w-xl rounded-xl border bg-card shadow-lg" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b p-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-bold">{personName}</h2>
            {/* Текст плашки целиком: человек пришёл по ней и должен видеть,
                на что именно смотрит. */}
            <p className="mt-0.5 text-xs text-muted-foreground">{label}</p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto p-4">
          {q.isLoading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t('common.loading')}</p>
          ) : !items.length ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t('people.flagEmpty')}</p>
          ) : (
            <ul className="space-y-1.5">
              {items.map((x) => (
                <li key={x.id}>
                  <div
                    className={cn(
                      'flex min-w-0 items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm',
                      !x.isMember && 'opacity-60',
                    )}
                  >
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">{x.number}</span>
                    <span className="min-w-0 flex-1 truncate" title={x.title}>{x.title}</span>
                    {/* Возраст жирным: он и есть мера беды, и по нему список
                        отсортирован. Оранжевым от двух недель — как в полосе
                        блокеров, чтобы пороги не разъезжались по интерфейсу. */}
                    <span
                      className={cn(
                        'shrink-0 text-xs font-semibold tabular-nums',
                        x.days >= 14 ? 'text-orange-600 dark:text-orange-400' : 'text-foreground',
                      )}
                    >
                      {t('people.flagDays', { count: x.days })}
                    </span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 ps-1 text-xs text-muted-foreground">
                    <span className="flex min-w-0 shrink-0 items-center gap-1">
                      {x.isMember ? <FolderKanban className="size-3" /> : <Lock className="size-3" />}
                      <span className="truncate">{x.project.name}</span>
                    </span>
                    {x.holds > 0 && (
                      <>
                        <span aria-hidden>·</span>
                        <span>{t('blockers.stripHolding', { count: x.holds })}</span>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

function RhythmBlock({
  r,
  companyId,
  userId,
  personName,
}: {
  r: Rhythm
  companyId: string
  userId: string
  personName: string
}) {
  // Какой флаг раскрыт списком. null — модалка закрыта.
  const [flagOpen, setFlagOpen] = useState<string | null>(null)
  const { t } = useTranslation()
  const react = reactValue(r.reactMedianHours)

  /**
   * Цвет — по ПРИСЛАННЫМ признакам, а не по своему счёту.
   *
   * Пороги («молчит дольше двух недель», «не тронута половина») живут на
   * сервере. Повторив их здесь, мы получили бы расхождение: сервер молчит,
   * а карточка красная — или наоборот.
   */
  const waitTone = r.flags.includes('stalled')
    ? 'bad'
    : r.flags.includes('ignoring')
      ? 'warn'
      : r.untouched
        ? undefined
        : 'ok'

  const flagText: Record<string, string> = {
    stalled: t('people.flagStalled', { count: r.over2w, worst: r.waitWorstDays }),
    blocking: t('people.flagBlocking', { count: r.blocking, worst: r.blockingWorstDays }),
    ignoring: t('people.flagIgnoring', { untouched: r.untouched, open: r.openNow }),
    overloadedOne: t('people.flagOverloadedOne', {
      open: r.openNow,
      closed: r.closed,
      project: r.topProject?.name ?? '',
      top: r.topProject?.open ?? 0,
    }),
    overloadedMany: t('people.flagOverloadedMany', {
      open: r.openNow,
      closed: r.closed,
      projects: r.openProjects,
    }),
    scattered: t('people.flagScattered', { open: r.openNow, projects: r.openProjects }),
  }
  // Красным — только то, что мешает ДРУГИМ. Перегрузка и разброс не претензия,
  // и цветом о них кричать нельзя: очередь тогда читается как безделье.
  const loud = new Set(['stalled', 'blocking'])

  return (
    <>
      <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-t pt-2 sm:grid-cols-4">
        <Metric
          label={t('people.waiting')}
          value={r.openNow ? `${r.untouched}/${r.openNow}` : String(r.untouched)}
          note={
            r.untouched
              ? t('people.waitingNote', { avg: r.waitAvgDays, worst: r.waitWorstDays })
              : t('people.waitingNone')
          }
          tone={waitTone}
        />
        <Metric
          label={t('people.react')}
          value={react?.value ?? '—'}
          unit={react ? t(`people.unit.${react.unit}`) : undefined}
          // Прочерк без объяснения выглядит поломкой. Говорим, почему его
          // нельзя посчитать: откликов на чужие задачи слишком мало.
          note={
            r.reactMedianHours === null
              ? t('people.reactFew', { count: r.reactSample })
              : t('people.reactNote')
          }
          tone={
            r.reactMedianHours === null ? undefined : r.reactMedianHours <= 4 ? 'ok' : r.reactMedianHours > 24 ? 'bad' : undefined
          }
        />
        <Metric
          label={t('people.closed')}
          value={String(r.closed)}
          note={
            r.medianLifeDays === null
              ? undefined
              : r.medianLifeDays <= 1
                ? t('people.closedSameDay')
                : t('people.closedIn', { days: r.medianLifeDays })
          }
        />
        <Metric
          label={t('people.actions')}
          value={String(r.actions)}
          note={t('people.actionsNote', { count: r.comments })}
        />
      </div>

      {r.flags.map((f) => {
        /**
         * За «stalled» и «blocking» стоят конкретные задачи — их и открываем.
         *
         * Остальные флаги говорят о РАСПРЕДЕЛЕНИИ очереди («очередь растёт»,
         * «размазан по проектам»), и списка за ними нет: показывать по клику
         * все сорок задач человека значит обещать ответ и не дать его.
         */
        const openable = f === 'stalled' || f === 'blocking'
        const cls = cn(
          'mt-2 flex w-full items-start gap-1.5 rounded-md px-2 py-1.5 text-start text-[11px] leading-snug',
          loud.has(f) ? 'bg-red-500/10 text-red-700 dark:text-red-300' : 'bg-muted text-muted-foreground',
          openable && 'transition-colors hover:brightness-95 dark:hover:brightness-125',
        )
        if (!openable) return <p key={f} className={cls}>{flagText[f]}</p>
        return (
          <button key={f} type="button" className={cls} onClick={() => setFlagOpen(f)}>
            <span className="min-w-0 flex-1">{flagText[f]}</span>
            {/* Стрелка — единственный признак, что плашка кликабельна:
                курсор на телефоне не наведёшь. rtl:rotate-180 — в иврите
                «дальше» это влево. */}
            <ChevronRight className="mt-0.5 size-3.5 shrink-0 rtl:rotate-180" />
          </button>
        )
      })}

      {flagOpen && (
        <FlagTasksDialog
          companyId={companyId}
          userId={userId}
          personName={personName}
          flag={flagOpen}
          label={flagText[flagOpen] ?? ''}
          onClose={() => setFlagOpen(null)}
        />
      )}
    </>
  )
}

export function PeopleStats({
  companyId,
  onOpenReport,
}: {
  companyId: string
  /**
   * Скачать часы человека за ЭТОТ МЕСЯЦ.
   *
   * Заменяет прежнюю секцию «Время команды»: она отвечала на тот же вопрос —
   * кто сколько наработал, — и стояла отдельным блоком с теми же людьми.
   * Держать два списка одних и тех же людей ради одной кнопки незачем.
   */
  onOpenReport?: (userId: string, period: { from: string; to: string }) => void
}) {
  const { t, i18n } = useTranslation()
  const ago = useAgo()
  const [expanded, setExpanded] = useState(false)
  const [q, setQ] = useState('')
  const [days, setDays] = useState<(typeof PERIODS)[number]>(30)

  const peopleQ = useQuery({
    queryKey: ['company-people', companyId, days],
    queryFn: () => api<{ items: Person[]; seesEveryone: boolean; activitySince: string | null }>(
        `/api/v1/companies/${companyId}/people?days=${days}`,
      ),
  })

  const all = peopleQ.data?.items ?? []
  const seesEveryone = peopleQ.data?.seesEveryone ?? false
  // С какого дня у компании есть история: полоса рисуется от него, а не от
  // жёстких 90 суток. Считает сервер — он видит всю компанию, а клиент только
  // своих людей.
  const activitySince = peopleQ.data?.activitySince ?? null

  const filtered = q.trim()
    ? all.filter((p) => p.name.toLowerCase().includes(q.trim().toLowerCase()))
    : all
  // Поиск показывает найденное целиком: свернув результат до четырёх, мы бы
  // спрятали как раз то, что человек искал.
  const shown = q.trim() || expanded ? filtered : filtered.slice(0, PREVIEW)
  const hidden = filtered.length - shown.length

  const hours = (min: number) => (min / 60).toLocaleString(i18n.language, { maximumFractionDigits: 1 })

  /** Этот месяц — тот же период, за который посчитаны часы в карточке. */
  const thisMonth = () => {
    const now = new Date()
    const iso = (d: Date) => d.toISOString().slice(0, 10)
    return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: iso(now) }
  }

  if (!peopleQ.isLoading && !all.length) return null

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Users className="size-4" />
          {t('people.title')}
        </h2>
        {/* ms-auto прижимает группу к дальнему краю в ОБОИХ направлениях:
            justify-between на обёртке работает, только пока строка одна, а
            перенос оставлял бы её у левого края и в иврите. */}
        <div className="flex flex-wrap items-center gap-2 ms-auto">
          {/* За какой срок считан ритм. Возле цифр, а не в шапке страницы:
              период меняет ровно эти числа и ничего больше. */}
          <div className="flex shrink-0 rounded-lg border p-0.5">
            {PERIODS.map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                aria-pressed={days === d}
                className={cn(
                  'whitespace-nowrap rounded-md px-2 py-1 text-xs transition-colors',
                  days === d ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t(`people.period${d}`)}
              </button>
            ))}
          </div>
          {/* Поиск по людям — только тому, кому есть среди кого искать.
              flex-1 вместо w-full: поле по-прежнему занимает всё свободное
              место (ради этого w-full и ставили — на телефоне оно было
              нерастяжимым), но больше не ТРЕБУЕТ целой строки и не утаскивает
              за собой переключатель периода. Из-за этого в иврите вся группа
              отрывалась от заголовка и уезжала к левому краю.
              min-w-0 — чтобы плейсхолдер не распирал строку. */}
          {seesEveryone && all.length > PREVIEW && (
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('people.search')}
              className="h-8 min-w-0 flex-1 max-w-56 text-sm"
            />
          )}
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {shown.map((p) => (
          <div key={p.id} className="rounded-xl border bg-card p-3">
            <div className="flex items-center gap-2">
              <Avatar src={p.avatarUrl} name={p.name} size={28} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{p.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {p.lastActiveAt ? t('people.lastActive', { when: ago(p.lastActiveAt) }) : t('people.neverActive')}
                </p>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
              <span>
                <span className="font-semibold tabular-nums">{p.openTasks}</span>{' '}
                <span className="text-muted-foreground">{t('people.open')}</span>
              </span>
              <span>
                <span className="font-semibold tabular-nums">{p.doneTasks}</span>{' '}
                <span className="text-muted-foreground">{t('people.done')}</span>
              </span>
              <span>
                <span className="font-semibold tabular-nums">{hours(p.minutesThisMonth)}</span>{' '}
                <span className="text-muted-foreground">{t('people.hoursThisMonth')}</span>
              </span>
              {/* Скачать часы за этот месяц. Кнопка со словом, а не голая
                  иконка: иконку рядом с цифрами читают как украшение и не
                  нажимают. Пустых отчётов не предлагаем. */}
              {onOpenReport && p.minutesThisMonth > 0 && (
                <button
                  onClick={() => onOpenReport(p.id, thisMonth())}
                  className="ms-auto inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <Download className="size-3" />
                  {t('people.report')}
                </button>
              )}
            </div>

            <div className="mt-2">
              <ActivityStrip days={p.activeDays} since={activitySince} />
            </div>

            {/* Ритм показываем только тем, у кого есть о чём говорить: у
                человека без задач и без действий четыре прочерка отвечают
                «ничего не известно», а выглядят как «ничего не делал». */}
            {p.rhythm && (p.rhythm.openNow > 0 || p.rhythm.actions > 0) && (
              <RhythmBlock r={p.rhythm} companyId={companyId} userId={p.id} personName={p.name} />
            )}
          </div>
        ))}
      </div>

      {hidden > 0 && (
        <button
          onClick={() => setExpanded(true)}
          className="text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {t('people.showAll', { count: filtered.length })}
        </button>
      )}
      {q.trim() && !filtered.length && (
        <p className="text-xs text-muted-foreground">{t('people.noneFound')}</p>
      )}
    </section>
  )
}
