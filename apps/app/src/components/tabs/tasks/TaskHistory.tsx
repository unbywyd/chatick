import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ChevronRight, History } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/avatar'

/**
 * Путь задачи: завели → назначили → в работу → сдана.
 *
 * Только ВЕХИ, и это главное решение. Перетаскивание задачи в списке пишет
 * запись на каждое движение мышью — у TASK-1 их девять подряд за две минуты, —
 * а правку описания правят по десять раз. Показав всё, мы утопили бы четыре
 * настоящих шага в сорока строками «изменил».
 *
 * Свёрнуто по умолчанию: за задачей приходят ради описания и комментариев, а
 * история отвечает на вопрос, который возникает не каждый раз — «а кто это
 * вообще закрыл?».
 */

type Entry = {
  id: string
  action: string
  meta: { changed?: string[]; before?: Record<string, unknown>; after?: Record<string, unknown> } | null
  createdAt: string
  /** null — значит ИИ или система, а не человек. */
  actor: { id: string; name: string; avatarUrl: string | null } | null
}

export function TaskHistory({ taskId }: { taskId: string }) {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)

  const q = useQuery({
    queryKey: ['task-history', taskId],
    queryFn: () => api<{ items: Entry[]; people: Record<string, string> }>(`/api/v1/tasks/${taskId}/history`, {}, 'project'),
    // Не грузим, пока не открыли: у задачи и без того четыре запроса при
    // открытии, а историю смотрят изредка.
    enabled: open,
  })

  const items = q.data?.items ?? []
  const people = q.data?.people ?? {}

  const when = (iso: string) =>
    new Date(iso).toLocaleString(i18n.language, {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    })

  /**
   * Строка события.
   *
   * У записей, сделанных до появления значений в журнале, есть только имя
   * поля: тогда говорим «изменил статус», без «на какой». Врать о том, чего
   * не записано, нельзя, а промолчать про сам факт — потерять шаг.
   */
  const describe = (e: Entry): string => {
    const after = e.meta?.after ?? {}
    const before = e.meta?.before ?? {}

    if (e.action === 'create') return t('taskHistory.created')
    if (e.action === 'delete') return t('taskHistory.deleted')
    if (e.action === 'restore') return t('taskHistory.restored')

    if (e.action === 'status') {
      const to = after.status
      return typeof to === 'string'
        ? t('taskHistory.statusTo', { status: t(`tasks.status.${to}`) })
        : t('taskHistory.statusChanged')
    }

    if (e.action === 'assign') {
      const to = after.assigneeId
      if (typeof to === 'string') return t('taskHistory.assignedTo', { name: people[to] ?? '—' })
      // Явный null в after — сняли исполнителя. undefined значит «старая
      // запись, значений нет», и это другой случай.
      if (to === null) return t('taskHistory.unassigned')
      return t('taskHistory.assignChanged')
    }

    const changed = e.meta?.changed ?? []
    if (changed.includes('dueDate')) {
      const to = after.dueDate
      return typeof to === 'string'
        ? t('taskHistory.dueTo', { date: new Date(to).toLocaleDateString(i18n.language) })
        : to === null
          ? t('taskHistory.dueCleared')
          : t('taskHistory.dueChanged')
    }
    if (changed.includes('priority')) {
      const to = after.priority
      return typeof to === 'string'
        ? t('taskHistory.priorityTo', { priority: t(`tasks.priority.${to}`) })
        : t('taskHistory.priorityChanged')
    }
    if (changed.includes('estimateMinutes')) return t('taskHistory.estimateChanged')
    if (changed.includes('groupId')) return t('taskHistory.sprintChanged')
    void before
    return t('taskHistory.updated')
  }

  return (
    <div className="rounded-xl border bg-card">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 p-4 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <History className="size-4" />
        {t('taskHistory.title')}
        <ChevronRight className={cn('size-4 transition-transform rtl:rotate-180', open && 'rotate-90 rtl:rotate-90')} />
      </button>

      {open && (
        <div className="px-4 pb-4">
          {q.isLoading && <p className="text-sm text-muted-foreground">{t('common.loading')}</p>}
          {!q.isLoading && !items.length && <p className="text-sm text-muted-foreground">{t('taskHistory.empty')}</p>}

          {/* Лента с вертикальной нитью: шаги читаются как путь, а не как
              список несвязанных строк. */}
          <ol className="relative space-y-3 ps-5">
            {items.length > 0 && <span className="absolute inset-y-1 start-[5px] w-px bg-border" aria-hidden />}
            {items.map((e) => (
              <li key={e.id} className="relative">
                <span
                  className={cn(
                    'absolute -start-5 top-1.5 size-2.5 rounded-full border-2 border-background',
                    e.action === 'create' ? 'bg-brand' : e.action === 'status' ? 'bg-foreground/60' : 'bg-muted-foreground/40',
                  )}
                  aria-hidden
                />
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
                  <span className="inline-flex items-center gap-1.5">
                    {e.actor ? (
                      <>
                        <Avatar src={e.actor.avatarUrl} name={e.actor.name} size={16} />
                        <span className="font-medium">{e.actor.name}</span>
                      </>
                    ) : (
                      // Автор не человек: не выдаём это за чьё-то действие.
                      <span className="font-medium text-muted-foreground">{t('taskHistory.system')}</span>
                    )}
                  </span>
                  <span className="text-muted-foreground">{describe(e)}</span>
                  <span className="text-xs text-muted-foreground/70">{when(e.createdAt)}</span>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  )
}
