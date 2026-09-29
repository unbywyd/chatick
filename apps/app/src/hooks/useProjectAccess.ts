import { useEffect, useRef, useState } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { api, ensureMediaToken } from '@/lib/api'

// Источник истины о текущем проекте — projectId в URL (SPEC §8.29).
// Запросы проекта называют его серверу сами (X-Project из адреса), токена
// проекта больше нет. Хук лишь отвечает, можно ли показывать проект: удалён
// ли он, в команде ли человек, приняты ли правила чата.

type State =
  | { status: 'ready' }
  | { status: 'loading' }
  | { status: 'needRules'; chatRules: string; projectName: string }
  /** проекта больше нет: удалили, пока человек был внутри */
  | { status: 'gone' }
  /**
   * Проект существует, но человек не в его команде.
   *
   * Отдельно от 'gone': 404 значит «удалён», 403 — «не пустили». Раньше оба
   * показывали «проекта больше нет», и админ компании, зашедший в чужой
   * проект, шёл выяснять, кто что удалил.
   */
  | { status: 'notMember' }
  | { status: 'error'; message: string }

/**
 * Данные, которые НЕ зависят от открытого проекта.
 *
 * Всё остальное сносится при переключении: многие запросы к проекту не
 * передают projectId в ключе кэша — сервер узнаёт проект из X-Project, — и
 * отличить свои данные от чужих в кэше нельзя. Перечислять проектные ключи
 * поимённо бессмысленно: забудешь один, и на экране повиснут чужие спринты.
 *
 * Поэтому наоборот: перечислен короткий белый список, а сомнительное
 * считается проектным. Ошибиться в эту сторону безопасно — лишний запрос
 * против показа чужих данных.
 *
 * Сюда попадает только то, что ходит без проекта. notify-config, например,
 * выглядит общим, но у него ['notify-config', projectId] и X-Project — он
 * проектный.
 */
const SESSION_KEYS = new Set([
  'about',
  'bridge-sessions',
  'companies',
  'desktop-running',
  'desktop-tasks',
  'inbox',
  'inbox-prefs',
  'inbox-system',
  'me',
  'tray-projects',
])

/**
 * Снести кэш проекта, оставив общее.
 *
 * qc.clear() сносил и то и другое. Шапка сайдбара с названием компании и
 * переключателем — на ['companies'], и она пустела при каждом переходе между
 * проектами: компания не менялась, а контрол мигал и прыгал. staleTime там
 * стоял, но против clear() он бессилен — тот удаляет запись целиком, а не
 * помечает устаревшей.
 */
export function dropProjectCache(qc: QueryClient): void {
  qc.removeQueries({
    predicate: (q) => {
      const head = q.queryKey[0]
      return typeof head !== 'string' || !SESSION_KEYS.has(head)
    },
  })
}

type Access = { status: 'ready' } | Exclude<State, { status: 'ready' } | { status: 'loading' }>

/**
 * Можно ли в проект — одним запросом к карточке проекта (сессия).
 *
 * Отдельно от хука: стартовый экран спрашивает то же самое перед переходом,
 * чтобы показать правила в своём окне, а не на пустом экране проекта.
 */
export async function projectAccess(id: string): Promise<Access> {
  try {
    const p = await api<{ name: string; chatRules: string; myRole: string | null; rulesAccepted: boolean }>(
      `/api/v1/projects/${id}`,
    )
    // Карточку видит и админ компании вне команды — но внутрь проекта его не
    // пускают: для него это «не в команде», как и раньше.
    if (!p.myRole) return { status: 'notMember' }
    if (!p.rulesAccepted) return { status: 'needRules', chatRules: p.chatRules ?? '', projectName: p.name }
    return { status: 'ready' }
  } catch (e) {
    const err = e as { status?: number }
    // Проект удалён или доступ отобрали — это не «ошибка сети», а состояние,
    // которое надо объяснить словами.
    if (err.status === 404) return { status: 'gone' }
    if (err.status === 403) return { status: 'notMember' }
    return { status: 'error', message: e instanceof Error ? e.message : String(e) }
  }
}

/** Принять правила чата проекта (SPEC §4.2). */
export const acceptProjectRules = (id: string) =>
  api(`/api/v1/projects/${id}/rules/accept`, { method: 'POST' })

/**
 * Проекты, в которые уже пускали в этой вкладке. Возврат в такой проект —
 * мгновенный: показываем сразу, перепроверяем фоном (проект могли удалить,
 * пока человек был в другом).
 */
const admitted = new Set<string>()
/** Проект, чьи данные сейчас лежат в кэше. Сменился — кэш проекта сносится. */
let cachedProject: string | null = null

export function useProjectAccess(projectId: string | undefined): State & { accept: () => void } {
  const qc = useQueryClient()
  // Состояние помнит, к какому проекту оно относится. Иначе на первом кадре
  // после смены адреса ещё стоит 'ready' прошлого проекта, и вкладки успевают
  // отрисовать его кэш под новым заголовком.
  const [state, setState] = useState<State & { for?: string }>({ status: 'loading' })
  // защита от гонки: пока проверяем, пользователь мог кликнуть другой проект
  const wanted = useRef<string | undefined>(undefined)

  const check = async (id: string, quiet: boolean) => {
    wanted.current = id
    if (!quiet) setState({ status: 'loading', for: id })
    // Картинки в задачах и чате ждут медиа-токен в адресе; без него первый
    // показ дал бы битые изображения, а перерисовать их потом некому.
    const [access] = await Promise.all([projectAccess(id), ensureMediaToken()])
    if (wanted.current !== id) return // успели переключиться дальше — ответ уже неактуален
    if (access.status === 'ready') {
      admitted.add(id)
      if (cachedProject !== id) {
        dropProjectCache(qc)
        cachedProject = id
      }
    } else admitted.delete(id)
    // Фоновая перепроверка не прячет работающий проект за ошибкой сети.
    if (quiet && access.status === 'error') return
    setState({ ...access, for: id })
  }

  useEffect(() => {
    if (!projectId) return
    if (admitted.has(projectId) && cachedProject === projectId) {
      wanted.current = projectId
      setState({ status: 'ready', for: projectId })
      void check(projectId, true)
      return
    }
    void check(projectId, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  const accept = () => {
    if (!projectId) return
    const id = projectId
    setState({ status: 'loading', for: id })
    acceptProjectRules(id)
      .then(() => check(id, false))
      .catch((e: unknown) => setState({ status: 'error', message: e instanceof Error ? e.message : String(e), for: id }))
  }

  const current: State = state.for === projectId ? state : { status: 'loading' }
  return { ...current, accept }
}
