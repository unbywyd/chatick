import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { AlertTriangle } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

// Удаление проекта (SPEC §4.2).
//
// Уносит всё: задачи, переписку, документы, заметки, часы и файлы. Отмены нет,
// поэтому перечисляем последствия и просим ввести название — не «вы уверены?»,
// на которое жмут не читая, а действие, требующее посмотреть на то, что удаляешь.

export function DeleteProjectDialog({
  projectId,
  projectName,
  onClose,
  onDeleted,
}: {
  projectId: string
  projectName: string
  onClose: () => void
  onDeleted: () => void
}) {
  const { t } = useTranslation()
  const [confirm, setConfirm] = useState('')

  const remove = useMutation({
    mutationFn: () =>
      api(`/api/v1/projects/${projectId}`, { method: 'DELETE', body: JSON.stringify({ confirm }) }),
    onSuccess: () => {
      toast.success(t('project.deleted', { name: projectName }))
      onDeleted()
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const matches = confirm.trim() === projectName

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-6" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl border bg-card p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="flex items-center gap-2 text-lg font-bold text-destructive">
          <AlertTriangle className="size-5" />
          {t('project.deleteTitle')}
        </h2>

        <p className="mt-3 text-sm text-muted-foreground">{t('project.deleteWhat')}</p>
        <ul className="mt-2 list-inside list-disc space-y-0.5 text-sm text-muted-foreground">
          <li>{t('project.deleteTasks')}</li>
          <li>{t('project.deleteChat')}</li>
          <li>{t('project.deleteDocs')}</li>
          <li>{t('project.deleteFiles')}</li>
          <li>{t('project.deleteTime')}</li>
        </ul>
        <p className="mt-3 text-sm font-medium text-destructive">{t('project.deleteIrreversible')}</p>

        <label className="mt-4 block text-sm">
          {t('project.deleteConfirmLabel', { name: projectName })}
          <Input
            autoFocus
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder={projectName}
            className="mt-1.5"
          />
        </label>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t('rules.decline')}
          </Button>
          <Button
            variant="destructive"
            disabled={!matches || remove.isPending}
            onClick={() => remove.mutate()}
          >
            {t('project.deleteAction')}
          </Button>
        </div>
      </div>
    </div>
  )
}
