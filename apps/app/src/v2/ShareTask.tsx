import { ShareDialog, type ShareEntity } from '@/components/ShareDialog'
import { useUi } from './ui'

/**
 * «Поделиться» — тот же диалог, что в старом клиенте: внутренняя ссылка для
 * своих и публичная для тех, кто вне компании (публикует руководство
 * проекта — решает сервер). appPath — адрес в v2 относительно компании.
 */
export function ShareItem({ type, id, title, path, canPublish, onClose }: { type: ShareEntity; id: string; title: string; path: string; canPublish: boolean; onClose: () => void }) {
  const { companyId } = useUi()
  // Поверх окон v2 (просмотр файла, модалки библиотеки): у диалога свой z-50.
  return (
    <div style={{ position: 'relative', zIndex: 90 }}>
      <ShareDialog type={type} id={id} title={title} appPath={`/c/${companyId}${path}`} canPublish={canPublish} onClose={onClose} />
    </div>
  )
}

/** Задача: внутренняя ссылка ведёт на страницу задачи v2. */
export function ShareTask({ taskId, title, canPublish, onClose }: { taskId: string; title: string; canPublish: boolean; onClose: () => void }) {
  return <ShareItem type="task" id={taskId} title={title} path={`/task/${taskId}`} canPublish={canPublish} onClose={onClose} />
}
