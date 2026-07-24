import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { CheckCircle, Copy, Flag, Trash2, UserCheck } from 'lucide-react'
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
  asChild = true,
}: {
  task: Task
  canEdit: boolean
  meId?: string
  children: React.ReactNode
  onPatch: (body: Record<string, unknown>) => void
  onDelete: () => void
  asChild?: boolean
}) {
  const { t } = useTranslation()
  const confirm = useConfirm()

  const copyLink = async () => {
    const pid = window.location.hash.split('/')[2]
    const url = `${window.location.origin}${window.location.pathname}#/p/${pid}/tasks/${task.id}`
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
