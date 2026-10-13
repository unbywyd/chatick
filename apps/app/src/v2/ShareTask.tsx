import { ShareDialog } from '@/components/ShareDialog'
import { useUi } from './ui'

/**
 * «Поделиться задачей» — тот же диалог, что в старом клиенте: внутренняя
 * ссылка для своих и публичная для тех, кто вне компании (публикует
 * руководство проекта — решает сервер). Внутренняя ведёт на страницу задачи v2.
 */
export function ShareTask({ taskId, title, canPublish, onClose }: { taskId: string; title: string; canPublish: boolean; onClose: () => void }) {
  const { companyId } = useUi()
  return <ShareDialog type="task" id={taskId} title={title} appPath={`/c/${companyId}/task/${taskId}`} canPublish={canPublish} onClose={onClose} />
}
