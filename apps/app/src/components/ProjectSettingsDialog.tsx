import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { X } from 'lucide-react'
import { api, API_URL, getSessionToken } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  ProjectSettingsForm,
  DEFAULT_AI_CONFIG,
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
  const { companyId } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [form, setForm] = useState<ProjectSettings | null>(null)

  const projectQ = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api<ProjectDetails>(`/api/v1/projects/${projectId}`),
  })

  /**
   * Форма наполняется из ДАННЫХ, а не из тела запроса.
   *
   * Раньше setForm стоял внутри queryFn, и это работало ровно до тех пор, пока
   * каждое монтирование ходило на сервер. Ключ ['project', id] общий с
   * ProjectScreen: открывая настройки изнутри проекта, react-query находит
   * свежий ответ в кеше, queryFn НЕ ЗОВЁТ вовсе — и форма остаётся пустой.
   * Человек видел модалку с шапкой, кнопками и пустотой посередине.
   *
   * Наполняем один раз (cur ?? ...): фоновый рефетч не должен затирать то, что
   * человек уже набрал.
   */
  useEffect(() => {
    const p = projectQ.data
    if (!p) return
    setForm((cur) =>
      cur ?? {
        name: p.name,
        about: p.about,
        chatRules: p.chatRules,
        aiConfig: { ...DEFAULT_AI_CONFIG, ...p.aiConfig },
        color: p.color,
        logoUrl: p.logoUrl ?? null,
        storageLimit: p.storageLimit != null ? Number(p.storageLimit) : null,
      },
    )
  }, [projectQ.data])

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

  // Через портал, в body. Диалог открывают из меню профиля, а оно живёт в
  // сайдбаре — на котором стоит transition. Свойство transition создаёт
  // содержащий блок, и position:fixed внутри начинает отсчитываться от
  // колонки, а не от окна: диалог сжимался в ширину сайдбара и обрезался.
  return createPortal(
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
              onDelete={onDelete}
              value={form}
              onChange={setForm}
              projectId={projectId}
              // Сначала закрыть, потом перейти: иначе модалка остаётся поверх
              // новой страницы и клик читается как не сработавший.
              // companyId из адреса: модалка открывается только внутри проекта,
              // и тащить его отдельным свойством через все места незачем.
              onOpenAiPage={
                companyId
                  ? () => {
                      onClose()
                      navigate(`/c/${companyId}/p/${projectId}/ai`)
                    }
                  : undefined
              }
              onLogoUpload={(f) => uploadLogo.mutate(f)}
              onLogoRemove={() => removeLogo.mutate()}
            />
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">…</p>
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
    </div>,
    document.body,
  )
}
