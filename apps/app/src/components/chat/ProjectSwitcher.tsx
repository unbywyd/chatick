import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Check, ChevronsUpDown } from 'lucide-react'
import { api, setProjectToken } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'

// Переключатель проекта в шапке: имя текущего проекта = дропдаун со списком проектов компании.
type ProjectDetails = { id: string; companyId: string; name: string }
type ProjectListItem = { id: string; name: string; isMember: boolean }

export function ProjectSwitcher({ projectName }: { projectName?: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { id: projectId } = useParams()
  const [q, setQ] = useState('')

  // companyId берём из уже закэшированного детального запроса проекта
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api<ProjectDetails>(`/api/v1/projects/${projectId}`),
    enabled: Boolean(projectId),
  })
  const companyId = project.data?.companyId

  const projects = useQuery({
    queryKey: ['company-projects', companyId],
    queryFn: () => api<ProjectListItem[]>(`/api/v1/projects?companyId=${companyId}`),
    enabled: Boolean(companyId),
  })

  const enter = useMutation({
    mutationFn: (pid: string) =>
      api<{ token: string; project: { id: string } }>(`/api/v1/projects/${pid}/enter`, {
        method: 'POST',
        body: JSON.stringify({ acceptRules: false }),
      }),
    onSuccess: (r) => {
      setProjectToken(r.token)
      // жёсткая навигация: смена project-токена → перезагрузить контекст проекта
      window.location.hash = `#/p/${r.project.id}`
      window.location.reload()
    },
    onError: (e: unknown, pid) => {
      const err = e as { status?: number; body?: { needRulesAccept?: boolean } }
      if (err.status === 428 && err.body?.needRulesAccept) {
        // проект требует принятия правил — уводим на экран входа в проект
        setProjectToken(null)
        navigate(`/start`)
        toast.info(t('projSwitch.needRules'))
        void pid
      } else {
        toast.error(e instanceof Error ? e.message : String(e))
      }
    },
  })

  const list = (projects.data ?? []).filter((p) => p.isMember)
  const showSearch = list.length > 5
  const needle = q.trim().toLowerCase()
  const filtered = needle ? list.filter((p) => p.name.toLowerCase().includes(needle)) : list

  return (
    <DropdownMenu onOpenChange={(o) => !o && setQ('')}>
      <DropdownMenuTrigger asChild>
        <button className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
          <span className="truncate">/ {projectName ?? '…'}</span>
          <ChevronsUpDown className="size-3 shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-60 overflow-y-auto">
        {showSearch && (
          <div className="p-1">
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              onKeyDownCapture={(e) => e.stopPropagation()}
              placeholder={t('projSwitch.search')}
              className="h-7 w-full rounded border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        )}
        {filtered.map((p) => (
          <DropdownMenuItem key={p.id} onSelect={() => p.id !== projectId && enter.mutate(p.id)}>
            {/* активный проект — чёрная галка в лаймовом круге: тонкая лаймовая
                иконка на светлом фоне была практически не видна */}
            {p.id === projectId ? (
              <span className="grid size-4 shrink-0 place-items-center rounded-full bg-brand">
                <Check className="size-2.5 text-brand-foreground" strokeWidth={3} />
              </span>
            ) : (
              <span className="size-4 shrink-0" />
            )}
            <span className="truncate">{p.name}</span>
          </DropdownMenuItem>
        ))}
        {filtered.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">{t('start.nothingFound')}</p>}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
