import { useMemo, useState } from 'react'
import { useSidebarCollapsed } from '@/hooks/useSidebarCollapsed'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react'
import { api, type Company, type Me, type ProjectListItem } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ProfileMenu } from '@/components/ProfileMenu'
import { NotificationBell } from '@/components/NotificationBell'
import { TimerControl } from '@/components/time/TimerControl'
import { ProjectBadge } from '@/components/ui/project-badge'
import { CompanyBrand } from '@/components/CompanyBrand'
import { Input } from '@/components/ui/input'

// Постоянный список проектов = список чатов (SPEC §8.29).
// Не отдельная страница, а колонка: клик меняет правую часть, список остаётся.

/** Время как в мессенджере: сегодня — часы, вчера — словом, дальше — дата. */
function relTime(iso: string, locale: string): string {
  const d = new Date(iso)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString())
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-1, 'day')
  return d.toLocaleDateString(locale, { day: 'numeric', month: 'short' })
}

export function ProjectSidebar({
  me,
  companyId,
  onPick,
}: {
  me?: Me
  /** компания ОТКРЫТОГО проекта — не обязательно своя */
  companyId?: string
  onPick?: () => void
}) {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const { id: activeId } = useParams()
  const [q, setQ] = useState('')
  // Свёрнутый режим: остаются только значки проектов. Состояние общее с
  // колонкой-обёрткой, поэтому живёт в хуке, а не здесь.
  const [collapsedPref, toggleCollapsed] = useSidebarCollapsed()
  // На мобильном сайдбар — выезжающая панель: свёрнутый до значков он там
  // бессмыслен, потому что открывают его как раз чтобы выбрать проект.
  const isMobile = useMediaQuery('(max-width: 767px)')
  const collapsed = collapsedPref && !isMobile

  const companies = useQuery({
    queryKey: ['companies'],
    queryFn: () => api<{ companies: Company[] }>('/api/v1/companies'),
    // Состав компаний меняется в разы реже, чем человек ходит между
    // проектами. Без этого шапка сайдбара пустела на каждом переходе, пока
    // ехал ответ, — а приходил в нём ровно тот же список.
    staleTime: 5 * 60_000,
  })
  // Компания открытого проекта, а не первая из списка.
  //
  // Брать первую было ошибкой: зайдя по приглашению в чужой проект,
  // человек видел в шапке своё название компании и свои проекты в списке —
  // при том, что открыт был чужой. Пока приглашений не было, разницы никто
  // не замечал.
  //
  // Отката на первую компанию нет и когда companyId не нашёлся: чужая компания
  // в шапке — это ложь о том, где человек находится, а пустая шапка честно
  // говорит, что компания ещё не известна.
  const myCompanies = companies.data?.companies ?? []
  const company = companyId ? myCompanies.find((c) => c.id === companyId) : myCompanies[0]
  const projects = useQuery({
    queryKey: ['sidebar-projects', company?.id],
    enabled: Boolean(company?.id),
    queryFn: () => api<ProjectListItem[]>(`/api/v1/projects?companyId=${company!.id}`),
    refetchInterval: 30_000, // подтягиваем новые сообщения и бейджи
    /**
     * Список не считается устаревшим сразу.
     *
     * Без staleTime react-query перезапрашивал его при каждом монтировании —
     * то есть на каждом переходе между проектами. Данные приходили те же
     * самые, но на время запроса список успевал моргнуть, и сайдбар
     * пропадал-появлялся на каждом клике.
     *
     * Свежесть при этом не страдает: refetchInterval выше продолжает
     * обновлять бейджи каждые 30 секунд, а по возвращении на вкладку список
     * перечитывается сам.
     */
    staleTime: 30_000,
    /** Прежние проекты остаются на экране, пока едут новые. */
    placeholderData: (prev) => prev,
  })

  // меню профиля показывает настройки активного проекта — значит нужна и роль
  const active = projects.data?.find((p) => p.id === activeId)
  // Админ компании распоряжается любым её проектом, даже не состоя в нём, —
  // так же решает и сервер. Без этого кнопки настроек не было у того, кто по
  // правам всё может.
  const isAdmin = active?.myRole === 'owner' || active?.myRole === 'admin' || company?.myRole === 'admin'

  const list = useMemo(() => {
    const mine = (projects.data ?? []).filter((p) => p.isMember)
    const needle = q.trim().toLowerCase()
    const filtered = needle ? mine.filter((p) => p.name.toLowerCase().includes(needle)) : mine
    // как в мессенджере: свежие разговоры сверху
    return [...filtered].sort((a, b) => {
      const at = a.lastMessage?.at ? Date.parse(a.lastMessage.at) : 0
      const bt = b.lastMessage?.at ? Date.parse(b.lastMessage.at) : 0
      return bt - at
    })
  }, [projects.data, q])

  // Список загружен по company.id — значит компания открываемого проекта
  // известна и подставляется в адрес без похода за самим проектом.
  const open = (projectId: string) => {
    navigate(`/c/${company?.id ?? ''}/p/${projectId}/chat`)
    onPick?.()
  }

  if (collapsed) {
    return (
      <div className="flex h-full flex-col bg-card/40">
        <button
          onClick={toggleCollapsed}
          title={t('sidebar.expand')}
          className="grid h-12 shrink-0 place-items-center border-b text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <PanelLeftOpen className="size-4 rtl:rotate-180" />
        </button>

        {/* таймер виден всегда: запустить и остановить нужно чаще, чем что-либо
            ещё в сайдбаре */}
        {activeId && (
          <div className="flex justify-center border-b py-2">
            <TimerControl collapsed />
          </div>
        )}

        {/*
          Колонка ровно 56px, и в неё не помещались две вещи, нарисованные
          СНАРУЖИ кнопки: кольцо активного проекта (ring-2) и счётчик
          непрочитанных (-end-1). Браузер считал список переполненным и давал
          горизонтальную прокрутку — полоса съедала ширину, иконки дёргались.

          overflow-x-clip, а не hidden: clip не создаёт прокручиваемую область
          вовсе, поэтому кольцо остаётся видимым целиком. Боковые отступы дают
          обоим украшениям место, вместо того чтобы их срезать.
        */}
        <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto overflow-x-clip px-1.5 py-2">
          {list.map((p) => {
            const unread = p.stats?.unread ?? 0
            const active = p.id === activeId
            return (
              <li key={p.id} className="flex justify-center">
                <button
                  onClick={() => open(p.id)}
                  title={p.name}
                  className={cn(
                    // ring-offset-2 даёт кольцу зазор от логотипа: без него
                    // обводка ложилась вплотную к картинке, и активный проект
                    // выглядел меньше соседей и как будто обрезанным.
                    // Цвет отступа — фон сайдбара, иначе между кольцом и
                    // значком светилась бы белая рамка.
                    'relative rounded-lg transition-all',
                    active
                      ? 'ring-2 ring-brand ring-offset-2 ring-offset-background'
                      : 'opacity-80 hover:opacity-100',
                  )}
                >
                  {/* 34px, а не 38: в 56px колонки значок должен уместиться
                      вместе с кольцом активного и его зазором, иначе обводка
                      упрётся в край и вернётся горизонтальная прокрутка. */}
                  <ProjectBadge name={p.name} color={p.color} logoUrl={p.logoUrl} size={34} />
                  {/* Бейдж — только непрочитанные уведомления, то есть места,
                      где человека затронули лично. Чужая активность сюда не
                      попадает и попадать не должна. */}
                  {unread > 0 && (
                    <span className="absolute -end-1 -top-1 grid min-w-4 place-items-center rounded-full bg-brand px-1 text-[10px] font-bold text-brand-foreground ring-2 ring-card">
                      {unread > 99 ? '99+' : unread}
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>

        <div className="flex flex-col items-center gap-2 border-t p-2">
          {/* В свёрнутом сайдбаре вернуться в компанию было нечем: шапка с её
              названием видна только развёрнутым. Логотип и есть эта дверь. */}
          <button
            onClick={() => navigate(`/start/${company?.id ?? ''}`)}
            title={company?.name ?? t('sidebar.companySettings')}
            className="grid size-9 place-items-center overflow-hidden rounded-md transition-opacity hover:opacity-80"
          >
            {company?.logoUrl ? (
              <img src={company.logoUrl} alt="" className="no-zoom size-9 rounded-md object-cover" />
            ) : (
              <span className="grid size-9 place-items-center rounded-md bg-secondary text-sm font-semibold text-secondary-foreground">
                {(company?.name ?? '?').trim().charAt(0).toUpperCase()}
              </span>
            )}
          </button>
          {/* колокольчик и профиль живут только здесь: в навбаре проекта они
              дублировались, а сайдбар виден на любой вкладке */}
          <NotificationBell currentProjectId={activeId} />
          <ProfileMenu me={me} projectId={activeId} projectName={active?.name} companyId={company?.id} isAdmin={isAdmin} />
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-card/40">
      {/* Наверху — таймер: его трогают чаще всего остального в сайдбаре, и
          место у самого края самое дешёвое по движению мыши.
          Компания переехала вниз: туда возвращаются, а не работают в ней. */}
      {/* Поиск в самой шапке, рядом с кнопкой сворачивания. Таймер — строкой
          ниже, ровно там же, где кнопка «плей» в свёрнутом сайдбаре: при
          переключении режимов она остаётся на одной линии и не прыгает. */}
      <div className="flex items-center gap-2 border-b px-2 py-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('sidebar.search')}
            className="h-8 ps-8 text-sm"
          />
        </div>
        <button
          onClick={toggleCollapsed}
          title={t('sidebar.collapse')}
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <PanelLeftClose className="size-4 rtl:rotate-180" />
        </button>
      </div>

      {activeId && (
        <div className="border-b px-2 py-2">
          <TimerControl collapsed={false} />
        </div>
      )}

      <ul className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {projects.isLoading && <p className="px-3 py-2 text-sm text-muted-foreground">…</p>}
        {list.map((p) => {
          const unread = p.stats?.unread ?? 0
          const active = p.id === activeId
          return (
            <li key={p.id}>
              <button
                onClick={() => open(p.id)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-start transition-colors',
                  active ? 'bg-accent' : 'hover:bg-accent/60',
                )}
              >
                {/* значок проекта, а не лица участников: в списке нужно
                    различать проекты, а люди в них и так пересекаются */}
                <ProjectBadge name={p.name} color={p.color} logoUrl={p.logoUrl} size={42} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className={cn('truncate text-sm', unread > 0 ? 'font-bold' : 'font-medium')}>{p.name}</span>
                    {p.lastMessage && (
                      <span className="ms-auto shrink-0 text-[10px] text-muted-foreground">
                        {relTime(p.lastMessage.at, i18n.language)}
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                      {p.lastMessage ? (
                        <>
                          <span className="text-foreground/70">{p.lastMessage.author}:</span> {p.lastMessage.text}
                        </>
                      ) : (
                        t('start.noMessages')
                      )}
                    </span>
                    {unread > 0 && (
                      <span className="grid min-w-4.5 shrink-0 place-items-center rounded-full bg-brand px-1.5 text-[10px] font-bold text-brand-foreground">
                        {unread > 99 ? '99+' : unread}
                      </span>
                    )}
                  </span>
                  {/* прогресс проекта тонкой полоской — не спорит с текстом */}
                  {(p.stats?.tasksTotal ?? 0) > 0 && (
                    <span className="mt-1 block h-0.5 overflow-hidden rounded-full bg-secondary">
                      <span
                        className="block h-full rounded-full bg-brand/70"
                        style={{ width: `${p.stats!.progress}%` }}
                      />
                    </span>
                  )}
                </span>
              </button>
            </li>
          )
        })}
        {!projects.isLoading && list.length === 0 && (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            {q ? t('start.nothingFound') : t('start.noProjects')}
          </p>
        )}
      </ul>

      {/* Низ: возврат в компанию + профиль.
          Раньше здесь была кнопка «Новый проект». Она вела не туда, где
          создают проект, а на список проектов компании, и у человека без
          права на создание упиралась в отказ. Возврат в компанию — то, что
          отсюда действительно нужно, и в свёрнутом виде его не было вовсе. */}
      <div className="flex items-center gap-2 border-t p-2">
        {/* CompanyBrand, а не мелкий круглый значок: логотип и название —
            это лицо компании, и люди хотят видеть их, а не кружок 18px. */}
        <button
          onClick={() => navigate(`/start/${company?.id ?? ''}`)}
          title={t('sidebar.companySettings')}
          className="flex min-w-0 flex-1 items-center rounded-md px-2 py-1.5 transition-colors hover:bg-accent"
        >
          <CompanyBrand name={company?.name} logoUrl={company?.logoUrl} />
        </button>
        {/* тот же аватар, что в шапке, ведёт себя одинаково: открывает меню
            профиля. Раньше отсюда уводило на /connect — разное поведение у
            одного и того же элемента. */}
        <NotificationBell currentProjectId={activeId} />
        <ProfileMenu me={me} projectId={activeId} projectName={active?.name} companyId={company?.id} isAdmin={isAdmin} />
      </div>
    </div>
  )
}
