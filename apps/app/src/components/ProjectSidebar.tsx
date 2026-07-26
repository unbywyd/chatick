import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Building2, Plus, Search } from 'lucide-react'
import { api, type Company, type Me, type ProjectListItem } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ProfileMenu } from '@/components/ProfileMenu'
import { AvatarGroup } from '@/components/ui/avatar-group'
import { Input } from '@/components/ui/input'
import { Logo } from '@/components/Logo'

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

export function ProjectSidebar({ me, onPick }: { me?: Me; onPick?: () => void }) {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const { id: activeId } = useParams()
  const [q, setQ] = useState('')

  const companies = useQuery({
    queryKey: ['companies'],
    queryFn: () => api<{ companies: Company[] }>('/api/v1/companies'),
  })
  const company = companies.data?.companies[0]

  const projects = useQuery({
    queryKey: ['sidebar-projects', company?.id],
    enabled: Boolean(company?.id),
    queryFn: () => api<ProjectListItem[]>(`/api/v1/projects?companyId=${company!.id}`),
    refetchInterval: 30_000, // подтягиваем новые сообщения и бейджи
  })

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

  const open = (projectId: string) => {
    navigate(`/p/${projectId}/chat`)
    onPick?.()
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-card/40">
      {/* Шапка: компания — вход в её настройки, команду, бэкап */}
      <div className="flex items-center gap-2 border-b px-3 py-2.5">
        <Logo className="shrink-0" />
        <button
          onClick={() => navigate(`/start/${company?.id ?? ''}`)}
          className="ms-auto flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title={t('sidebar.companySettings')}
        >
          <Building2 className="size-3.5 shrink-0" />
          <span className="truncate">{company?.name ?? '…'}</span>
        </button>
      </div>

      <div className="p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('sidebar.search')}
            className="h-8 ps-8 text-sm"
          />
        </div>
      </div>

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
                <AvatarGroup members={p.members ?? []} total={p.memberCount} size={42} />
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

      {/* Низ: новый проект + профиль — как в WhatsApp Desktop */}
      <div className="flex items-center gap-2 border-t p-2">
        <button
          onClick={() => navigate(`/start/${company?.id ?? ''}`)}
          className="flex flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Plus className="size-3.5" />
          {t('sidebar.newProject')}
        </button>
        {/* тот же аватар, что в шапке, ведёт себя одинаково: открывает меню
            профиля. Раньше отсюда уводило на /connect — разное поведение у
            одного и того же элемента. */}
        <ProfileMenu me={me} companyId={company?.id} />
      </div>
    </div>
  )
}
