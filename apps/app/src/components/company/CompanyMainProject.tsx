import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Star, X } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

/**
 * Главный проект компании — умолчание для панели в трее (SPEC §8.33).
 *
 * Панель открывалась с «Выберите проект», и таймер нельзя было запустить, пока
 * не выберешь: на новой машине и после чистки хранилища — каждый раз заново.
 *
 * Личный выбор человека ОСТАЁТСЯ главнее: это умолчание для тех, кто ещё
 * ничего не выбрал, а не приказ. Жёсткая настройка сбрасывала бы выбор в трее
 * при каждой перерисовке, и раздражало бы это сильнее, чем пустая панель.
 */
type Project = { id: string; name: string }

export function CompanyMainProject({ companyId }: { companyId: string }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [q, setQ] = useState('')

  const current = useQuery({
    queryKey: ['company-main-project', companyId],
    queryFn: () => api<{ project: Project | null; canEdit: boolean }>(`/api/v1/companies/${companyId}/main-project`),
  })

  const projects = useQuery({
    queryKey: ['projects', companyId],
    queryFn: () => api<Project[]>(`/api/v1/projects?companyId=${companyId}`),
  })

  const save = useMutation({
    mutationFn: (projectId: string | null) =>
      api(`/api/v1/companies/${companyId}/main-project`, { method: 'PATCH', body: JSON.stringify({ projectId }) }),
    onSuccess: () => {
      toast.success(t('projectForm.saved'))
      setQ('')
      qc.invalidateQueries({ queryKey: ['company-main-project', companyId] })
      // Панель читает список компаний — там же едет и эта настройка.
      qc.invalidateQueries({ queryKey: ['companies'] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const canEdit = current.data?.canEdit ?? false
  const chosen = current.data?.project ?? null

  // Показываем не весь список, а то, что искали: у компании бывает
  // полтора десятка проектов, и прокручивать их ради одного — работа.
  const found = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return []
    return (projects.data ?? []).filter((p) => p.name.toLowerCase().includes(needle)).slice(0, 6)
  }, [q, projects.data])

  if (current.isLoading) return null

  return (
    <div className="space-y-3 rounded-xl border bg-card p-4">
      <div className="flex items-center gap-2">
        <Star className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">{t('mainProject.title')}</h3>
      </div>
      <p className="-mt-2 text-xs text-muted-foreground">{t('mainProject.hint')}</p>

      <div className="flex items-center gap-2">
        <span className={cn('text-sm', !chosen && 'text-muted-foreground')}>
          {chosen ? chosen.name : t('mainProject.none')}
        </span>
        {chosen && canEdit && (
          <button
            onClick={() => save.mutate(null)}
            disabled={save.isPending}
            title={t('mainProject.clear')}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>

      {canEdit && (
        <div className="space-y-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('mainProject.search')}
            className="w-full max-w-sm rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          {found.length > 0 && (
            <ul className="max-w-sm space-y-1">
              {found.map((p) => (
                <li key={p.id}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start"
                    disabled={save.isPending || p.id === chosen?.id}
                    onClick={() => save.mutate(p.id)}
                  >
                    {p.name}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {/* Молчать, когда ничего не нашлось, нельзя: человек решит, что
              поиск сломан, а не что проекта с таким именем нет. */}
          {q.trim() && found.length === 0 && (
            <p className="text-xs text-muted-foreground">{t('mainProject.notFound')}</p>
          )}
        </div>
      )}
    </div>
  )
}
