import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Check, ChevronsUpDown } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'

// Переключатель проекта в шапке: имя текущего проекта = дропдаун со списком проектов компании.
type ProjectListItem = { id: string; name: string; isMember: boolean }

export function ProjectSwitcher({ projectName }: { projectName?: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  // Компания из адреса: список соседних проектов собирается сразу, не дожидаясь
  // ответа по самому проекту.
  const { id: projectId, companyId } = useParams()
  const [q, setQ] = useState('')

  const projects = useQuery({
    queryKey: ['company-projects', companyId],
    queryFn: () => api<ProjectListItem[]>(`/api/v1/projects?companyId=${companyId}`),
    enabled: Boolean(companyId),
  })

  // Просто переход: проект называется адресом, токен менять незачем. Правила
  // чата, если они не приняты, покажет сам экран проекта.
  const open = (pid: string) => navigate(`/c/${companyId}/p/${pid}`)

  const list = (projects.data ?? []).filter((p) => p.isMember)
  const showSearch = list.length > 5
  const needle = q.trim().toLowerCase()
  const filtered = needle ? list.filter((p) => p.name.toLowerCase().includes(needle)) : list

  return (
    <DropdownMenu onOpenChange={(o) => !o && setQ('')}>
      <DropdownMenuTrigger asChild>
        <button className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
          <span className="truncate font-semibold">{projectName ?? '…'}</span>
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
          <DropdownMenuItem key={p.id} onSelect={() => p.id !== projectId && open(p.id)}>
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
