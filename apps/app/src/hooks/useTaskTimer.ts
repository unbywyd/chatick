import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'

/**
 * Запуск учёта времени по конкретной задаче (SPEC §8.32).
 *
 * Время тратится на задачи, поэтому начинать учёт логично из самой задачи, а
 * не перенабирая её название в контроле таймера. Идущий таймер при этом
 * останавливается: человек работает над чем-то одним, а два счётчика на одного
 * — это уже не учёт, а путаница.
 */
export function useTaskTimer(projectId: string | undefined) {
  const { t } = useTranslation()
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async (task: { id: string; title: string }) => {
      const running = await api<{ items: { id: string; taskId?: string | null }[] }>(
        '/api/v1/time/running',
        {},
        'project',
      ).catch(() => ({ items: [] as { id: string; taskId?: string | null }[] }))

      const current = running.items[0]
      if (current) await api(`/api/v1/time/${current.id}/stop`, { method: 'POST' }, 'project')

      // Повторное нажатие по той же задаче — это «стоп», а не «перезапуск».
      if (current?.taskId === task.id) return { started: false }

      await api(
        '/api/v1/time/start',
        { method: 'POST', body: JSON.stringify({ projectId, taskId: task.id, description: task.title }) },
        'project',
      )
      return { started: true }
    },
    onSuccess: (r) => {
      toast.success(r.started ? t('time.startedOnTask') : t('time.stopped'))
      qc.invalidateQueries({ queryKey: ['time-running'] })
      qc.invalidateQueries({ queryKey: ['time-entries'] })
      qc.invalidateQueries({ queryKey: ['desktop-running'] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })
}
