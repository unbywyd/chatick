import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { X } from 'lucide-react'
import { api, API_URL, getSessionToken } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { DangerZone, DangerAction } from '@/components/company/DangerZone'
import {
  ProjectSettingsForm,
  DEFAULT_AI_CONFIG,
  DEFAULT_TIME_CONFIG,
  type ProjectSettings,
  type AiConfig,
} from '@/components/ProjectSettingsForm'

// Настройки проекта — модалка, а не страница: заходят сюда изредка, и терять
// ради этого рабочий экран незачем. Открывается сразу формой; отдельного
// просмотра деталей нет, он добавлял клик и ничего больше.

type ProjectDetails = {
  id: string
  name: string
  about: string
  chatRules: string
  aiConfig: Partial<AiConfig>
  color?: string
  logoUrl?: string | null
  timeConfig?: Record<string, unknown>
  storageLimit?: string | number | null
}

export function ProjectSettingsDialog({
  projectId,
  onClose,
  onDelete,
}: {
  projectId: string
  onClose: () => void
  /** удаление доступно только владельцу — решает вызывающий */
  onDelete?: () => void
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [form, setForm] = useState<ProjectSettings | null>(null)

  useQuery({
    queryKey: ['project', projectId],
    queryFn: async () => {
      const p = await api<ProjectDetails>(`/api/v1/projects/${projectId}`)
      // форму наполняем один раз: иначе фоновый рефетч затрёт правки
      setForm((cur) =>
        cur ?? {
          name: p.name,
          about: p.about,
          chatRules: p.chatRules,
          aiConfig: { ...DEFAULT_AI_CONFIG, ...p.aiConfig },
          color: p.color,
          logoUrl: p.logoUrl ?? null,
          timeConfig: { ...DEFAULT_TIME_CONFIG, ...(p.timeConfig ?? {}) } as never,
          storageLimit: p.storageLimit != null ? Number(p.storageLimit) : null,
        },
      )
      return p
    },
  })

  const save = useMutation({
    mutationFn: (v: ProjectSettings) => api(`/api/v1/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify(v) }),
    onSuccess: () => {
      toast.success(t('projectForm.saved'))
      qc.invalidateQueries({ queryKey: ['project', projectId] })
      qc.invalidateQueries({ queryKey: ['sidebar-projects'] })
      onClose()
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const uploadLogo = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch(`${API_URL}/api/v1/projects/${projectId}/logo`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getSessionToken()}` },
        body: fd,
      })
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'Upload failed')
      return (await res.json()) as { logoUrl: string }
    },
    onSuccess: (r) => {
      setForm((f) => (f ? { ...f, logoUrl: r.logoUrl } : f))
      qc.invalidateQueries({ queryKey: ['sidebar-projects'] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const removeLogo = useMutation({
    mutationFn: () => api(`/api/v1/projects/${projectId}/logo`, { method: 'DELETE' }),
    onSuccess: () => {
      setForm((f) => (f ? { ...f, logoUrl: null } : f))
      qc.invalidateQueries({ queryKey: ['sidebar-projects'] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85dvh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border bg-card shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b px-5 py-3">
          <h2 className="text-base font-bold">{t('profile.projectSettings')}</h2>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {form ? (
            <ProjectSettingsForm
              value={form}
              onChange={setForm}
              projectId={projectId}
              onLogoUpload={(f) => uploadLogo.mutate(f)}
              onLogoRemove={() => removeLogo.mutate()}
            />
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">…</p>
          )}

          {/* Необратимое — отдельным блоком внизу, а не пунктом в меню
              карточки, куда легко попасть мимоходом. */}
          {form && onDelete && (
            <DangerZone>
              <DangerAction
                title={t('project.deleteAction')}
                description={t('danger.deleteProjectHint')}
                actionLabel={t('project.deleteAction')}
                onAction={onDelete}
              />
            </DangerZone>
          )}
        </div>

        <footer className="flex justify-end gap-2 border-t px-5 py-3">
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="brand" disabled={!form || save.isPending} onClick={() => form && save.mutate(form)}>
            {t('common.save')}
          </Button>
        </footer>
      </div>
    </div>
  )
}
