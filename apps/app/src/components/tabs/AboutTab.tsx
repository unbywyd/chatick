import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Pencil, X } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  ProjectSettingsForm,
  DEFAULT_AI_CONFIG,
  type ProjectSettings,
  type AiConfig,
} from '@/components/ProjectSettingsForm'

type ProjectDetails = {
  id: string
  name: string
  about: string
  chatRules: string
  aiConfig: Partial<AiConfig>
  storageLimit?: string | number | null
  myRole: 'owner' | 'admin' | 'member' | null
}

export function AboutTab({ project, loading }: { project?: ProjectDetails; loading: boolean }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<ProjectSettings | null>(null)

  const save = useMutation({
    mutationFn: (v: ProjectSettings) =>
      api(`/api/v1/projects/${project!.id}`, { method: 'PATCH', body: JSON.stringify(v) }),
    onSuccess: () => {
      toast.success(t('projectForm.saved'))
      setEditing(false)
      qc.invalidateQueries({ queryKey: ['project', project!.id] })
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
      storageLimit: project.storageLimit != null ? Number(project.storageLimit) : null,
    })
    setEditing(true)
  }

  if (editing && form) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-xl font-bold tracking-tight">{t('projectForm.editTitle')}</h1>
          <Button variant="ghost" size="icon" onClick={() => setEditing(false)}>
            <X className="size-4" />
          </Button>
        </div>
        <ProjectSettingsForm value={form} onChange={setForm} />
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setEditing(false)}>
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
    <div className="mx-auto max-w-2xl space-y-8 p-6">
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
