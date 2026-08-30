import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Users } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/avatar'
import { Input } from '@/components/ui/input'

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
  /** Даты с активностью за 90 дней — для полоски. */
  activeDays: string[]
  openTasks: number
  doneTasks: number
  minutesThisMonth: number
}

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

/**
 * Полоска активности за 90 дней.
 *
 * Не насыщенность, как у гитхаба, а факт: был день или не был. Считать
 * «сколько сделано» не по чему — правка описания и закрытая задача весят в
 * журнале одинаково, и раскрашивать их разной густотой значило бы придумать
 * точность, которой нет.
 */
function ActivityStrip({ days }: { days: string[] }) {
  const { t } = useTranslation()
  const set = new Set(days.map((d) => d.slice(0, 10)))
  const cells: { key: string; active: boolean }[] = []
  for (let i = 89; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const key = d.toISOString().slice(0, 10)
    cells.push({ key, active: set.has(key) })
  }
  return (
    <div className="flex gap-px" title={t('people.activeDays', { count: set.size })} aria-hidden>
      {cells.map((c) => (
        <span
          key={c.key}
          className={cn('h-4 flex-1 rounded-[1px]', c.active ? 'bg-brand' : 'bg-muted-foreground/15')}
        />
      ))}
    </div>
  )
}

export function PeopleStats({ companyId }: { companyId: string }) {
  const { t, i18n } = useTranslation()
  const ago = useAgo()
  const [expanded, setExpanded] = useState(false)
  const [q, setQ] = useState('')

  const peopleQ = useQuery({
    queryKey: ['company-people', companyId],
    queryFn: () => api<{ items: Person[]; seesEveryone: boolean }>(`/api/v1/companies/${companyId}/people`),
  })

  const all = peopleQ.data?.items ?? []
  const seesEveryone = peopleQ.data?.seesEveryone ?? false

  const filtered = q.trim()
    ? all.filter((p) => p.name.toLowerCase().includes(q.trim().toLowerCase()))
    : all
  // Поиск показывает найденное целиком: свернув результат до четырёх, мы бы
  // спрятали как раз то, что человек искал.
  const shown = q.trim() || expanded ? filtered : filtered.slice(0, PREVIEW)
  const hidden = filtered.length - shown.length

  const hours = (min: number) => (min / 60).toLocaleString(i18n.language, { maximumFractionDigits: 1 })

  if (!peopleQ.isLoading && !all.length) return null

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Users className="size-4" />
          {t('people.title')}
        </h2>
        {/* Поиск по людям — только тому, кому есть среди кого искать. */}
        {seesEveryone && all.length > PREVIEW && (
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('people.search')}
            className="h-8 w-full max-w-56 text-sm"
          />
        )}
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
            </div>

            <div className="mt-2">
              <ActivityStrip days={p.activeDays} />
            </div>
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
