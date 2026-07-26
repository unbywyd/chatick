import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Pencil, X } from 'lucide-react'
import { API_URL, getSessionToken, api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  ProjectSettingsForm,
  DEFAULT_AI_CONFIG,
  DEFAULT_TIME_CONFIG,
  type ProjectSettings,
  type AiConfig,
} from '@/components/ProjectSettingsForm'

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
  myRole: 'owner' | 'admin' | 'member' | null
}

export function AboutTab({ project, loading }: { project?: ProjectDetails; loading: boolean }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const navigate = useNavigate()
  // страница = форма: просмотр деталей отдельно от неё не нужен
  const [editing, setEditing] = useState(true)
  const [form, setForm] = useState<ProjectSettings | null>(null)

  const save = useMutation({
    mutationFn: (v: ProjectSettings) =>
      api(`/api/v1/projects/${project!.id}`, { method: 'PATCH', body: JSON.stringify(v) }),
    onSuccess: () => {
      toast.success(t('projectForm.saved'))
      qc.invalidateQueries({ queryKey: ['project', project!.id] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  // Логотип кладётся сразу, отдельным запросом: это файл, а не поле формы, и
  // ждать общего «Сохранить» ради него нет причины.
  const uploadLogo = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch(`${API_URL}/api/v1/projects/${project!.id}/logo`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getSessionToken()}` },
        body: fd,
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Upload failed')
      return (await res.json()) as { logoUrl: string }
    },
    onSuccess: (r) => {
      setForm((f) => (f ? { ...f, logoUrl: r.logoUrl } : f))
      qc.invalidateQueries({ queryKey: ['project', project!.id] })
      qc.invalidateQueries({ queryKey: ['projects'] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const removeLogo = useMutation({
    mutationFn: () => api(`/api/v1/projects/${project!.id}/logo`, { method: 'DELETE' }),
    onSuccess: () => {
      setForm((f) => (f ? { ...f, logoUrl: null } : f))
      qc.invalidateQueries({ queryKey: ['project', project!.id] })
      qc.invalidateQueries({ queryKey: ['projects'] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  if (loading || !project) return <p className="p-6 text-sm text-muted-foreground">…</p>

  const canEdit = project.myRole === 'owner' || project.myRole === 'admin'

  const startEdit = () => {
    setForm({
      name: project.name,
      about: project.about,
      chatRules: project.chatRules,
      aiConfig: { ...DEFAULT_AI_CONFIG, ...project.aiConfig },
      color: project.color,
      logoUrl: project.logoUrl ?? null,
      timeConfig: { ...DEFAULT_TIME_CONFIG, ...(project.timeConfig ?? {}) } as never,
      storageLimit: project.storageLimit != null ? Number(project.storageLimit) : null,
    })
    setEditing(true)
  }

  if (editing && form) {
    return (
      <div className="mx-auto w-full max-w-6xl p-6">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-xl font-bold tracking-tight">{t('projectForm.editTitle')}</h1>
          <Button variant="ghost" size="icon" onClick={() => navigate(`/p/${project.id}/chat`)}>
            <X className="size-4" />
          </Button>
        </div>
        <ProjectSettingsForm
          value={form}
          onChange={setForm}
          onLogoUpload={(f) => uploadLogo.mutate(f)}
          onLogoRemove={() => removeLogo.mutate()}
        />
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={() => navigate(`/p/${project.id}/chat`)}>
            {t('rules.decline')}
          </Button>
          <Button variant="brand" disabled={save.isPending || !form.name.trim()} onClick={() => save.mutate(form)}>
            {t('projectForm.save')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-8 p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight">{project.name}</h1>
          <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
            {project.about || t('about.noDescription')}
          </p>
        </div>
        {canEdit && (
          <Button variant="outline" size="sm" onClick={startEdit}>
            <Pencil className="size-3.5" />
            {t('about.edit')}
          </Button>
        )}
      </div>

      {project.chatRules && (
        <section>
          <h2 className="text-sm font-semibold">{t('about.rules')}</h2>
          <p className="mt-2 whitespace-pre-wrap rounded-md bg-secondary p-3 text-sm">{project.chatRules}</p>
        </section>
      )}
    </div>
  )
}
