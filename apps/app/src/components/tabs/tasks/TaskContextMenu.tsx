import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { CheckCircle, Copy, Flag, Play, Trash2, UserCheck } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuCheckItem,
  ContextMenuSeparator,
  ContextMenuLabel,
} from '@/components/ui/context-menu'
import { useConfirm } from '@/components/ui/confirm'
import { STATUSES, PRIORITIES, STATUS_ICON, STATUS_COLOR, PRIORITY_COLOR, type Task } from './types'

// Контекстное меню задачи (правый клик): быстрые статус/приоритет/назначить/ссылка/удалить.
export function TaskContextMenu({
  task,
  canEdit,
  meId,
  children,
  onPatch,
  onDelete,
  onStartTimer,
  asChild = true,
}: {
  task: Task
  canEdit: boolean
  meId?: string
  children: React.ReactNode
  onPatch: (body: Record<string, unknown>) => void
  onDelete: () => void
  /** учёт времени по этой задаче — если трекинг включён в проекте */
  onStartTimer?: () => void
  asChild?: boolean
}) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  // Из параметров маршрута, а не разбором хеша: адрес вырос на два сегмента,
  // и счёт по позициям ломался бы при каждом таком изменении.
  const { id: projectId, companyId } = useParams()

  const copyLink = async () => {
    const url = `${window.location.origin}${window.location.pathname}#/c/${companyId}/p/${projectId}/tasks/${task.id}`
    try {
      await navigator.clipboard.writeText(url)
      toast.success(t('tasks.linkCopied'))
    } catch {
      toast.error(t('composer.clipboardDenied'))
    }
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild={asChild}>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {/* Время тратится на задачи — начинать учёт логично отсюда, а не
            перенабирая описание в контроле таймера. */}
        {onStartTimer && task.status !== 'done' && (
          <>
            <ContextMenuItem onSelect={onStartTimer}>
              <Play className="size-4 text-brand" />
              {t('time.startOnTask')}
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}

        {/* Быстрое «Готово» / статусы */}
        {canEdit && task.status !== 'done' && (
          <ContextMenuItem onSelect={() => onPatch({ status: 'done' })}>
            <CheckCircle className="size-4 text-brand" />
            {t('tasks.markDone')}
          </ContextMenuItem>
        )}

        {canEdit && (
          <>
            <ContextMenuLabel>{t('tasks.statusLabel')}</ContextMenuLabel>
            {STATUSES.map((s) => {
              const Icon = STATUS_ICON[s]
              return (
                <ContextMenuCheckItem key={s} checked={s === task.status} onSelect={() => onPatch({ status: s })}>
                  <Icon className={`size-3.5 ${STATUS_COLOR[s]}`} />
                  {t(`tasks.status.${s}`)}
                </ContextMenuCheckItem>
              )
            })}
            <ContextMenuSeparator />
            <ContextMenuLabel>{t('tasks.priorityLabel')}</ContextMenuLabel>
            {PRIORITIES.map((p) => (
              <ContextMenuCheckItem key={p} checked={p === task.priority} onSelect={() => onPatch({ priority: p })}>
                <Flag className={`size-3.5 ${PRIORITY_COLOR[p]}`} />
                {t(`tasks.priority.${p}`)}
              </ContextMenuCheckItem>
            ))}
            <ContextMenuSeparator />
            {meId && task.assignee?.id !== meId && (
              <ContextMenuItem onSelect={() => onPatch({ assigneeId: meId })}>
                <UserCheck className="size-4" />
                {t('tasks.assignToMe')}
              </ContextMenuItem>
            )}
          </>
        )}

        <ContextMenuItem onSelect={copyLink}>
          <Copy className="size-4" />
          {t('tasks.copyLink')}
        </ContextMenuItem>

        {canEdit && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={async () => {
                if (await confirm({ title: t('tasks.deleteConfirm', { number: task.number }), destructive: true, confirmLabel: t('files.delete') }))
                  onDelete()
              }}
            >
              <Trash2 className="size-4" />
              {t('files.delete')}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
