import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SOCKET_EVENT, setTaskView, type SocketMessage } from '../data'
import { letterOf, personColor } from '../util'
import '../i18n/list'

export type Viewer = { id: string; name: string; avatarUrl: string | null; editing: boolean }

/**
 * Кто ещё открыл эту задачу и правит ли описание. Себя не показываем
 * (другие вкладки того же человека — тоже он).
 */
export function useTaskPresence(taskId: string, editing: boolean, myId: string | undefined): Viewer[] {
  const [users, setUsers] = useState<Viewer[]>([])
  useEffect(() => {
    setTaskView({ taskId, editing })
  }, [taskId, editing])
  useEffect(() => {
    const on = (e: Event) => {
      const msg = (e as CustomEvent<SocketMessage>).detail
      if (msg.event !== 'task_presence') return
      const p = msg.payload as { taskId?: string; users?: Viewer[] }
      if (p.taskId === taskId) setUsers((p.users ?? []).filter((u) => u.id !== myId))
    }
    window.addEventListener(SOCKET_EVENT, on)
    return () => {
      window.removeEventListener(SOCKET_EVENT, on)
      setTaskView(null)
      setUsers([])
    }
  }, [taskId, myId])
  return users
}

/** Аватарки тех, кто сейчас в задаче; кто правит описание — подписан. */
export function TaskPeers({ users }: { users: Viewer[] }) {
  const { t } = useTranslation('v2')
  if (!users.length) return null
  const editor = users.find((u) => u.editing)
  return (
    <span className="tpeers" role="status" title={users.map((u) => u.name).join(', ')}>
      <span className="tpeers-av" aria-hidden="true">
        {users.slice(0, 4).map((u) => (
          <span key={u.id} className={'av' + (u.editing ? ' ed' : '')} style={{ background: personColor(u.id) }}>
            {u.avatarUrl ? <img src={u.avatarUrl} alt="" /> : letterOf(u.name)}
          </span>
        ))}
      </span>
      <span className="tpeers-t bidi">{editor ? t('peers.editing', { name: editor.name }) : t('peers.here', { count: users.length, name: users[0]!.name })}</span>
    </span>
  )
}
