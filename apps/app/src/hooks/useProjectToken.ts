import { useEffect, useRef, useState } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { api, getProjectToken, setProjectToken } from '@/lib/api'

// Источник истины о текущем проекте — projectId в URL (SPEC §8.29).
// Токен подтягивается под него фоном, поэтому переключение между проектами
// мгновенное, ссылки на проект остаются рабочими, а перезагрузки нет.

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

/** Декодирует projectId из текущего project-токена, не проверяя подпись. */
function projectOfToken(token: string | null): string | null {
  if (!token) return null
  try {
    const payload = JSON.parse(atob(token.split('.')[1]!)) as { projectId?: string }
    return payload.projectId ?? null
  } catch {
    return null
  }
}

/**
 * Данные, которые НЕ зависят от открытого проекта.
 *
 * Всё остальное сносится при переключении: запросы к проекту не передают
 * projectId в адресе — сервер узнаёт проект по токену, — и отличить свои
 * данные от чужих в кэше нельзя. Перечислять проектные ключи поимённо
 * бессмысленно: забудешь один, и на экране повиснут чужие спринты.
 *
 * Поэтому наоборот: перечислен короткий белый список, а сомнительное
 * считается проектным. Ошибиться в эту сторону безопасно — лишний запрос
 * против показа чужих данных.
 *
 * Сюда попадает только то, что ходит на session-токене. notify-config,
 * например, выглядит общим, но у него ['notify-config', projectId] и
 * project-токен — он проектный.
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

export function useProjectToken(projectId: string | undefined): State & { accept: () => void } {
  const qc = useQueryClient()
  const [state, setState] = useState<State>({ status: 'loading' })
  // защита от гонки: пока меняем токен, пользователь мог кликнуть другой проект
  const wanted = useRef<string | undefined>(undefined)

  const enter = async (id: string, acceptRules: boolean) => {
    wanted.current = id
    setState({ status: 'loading' })
    try {
      const r = await api<{ token: string }>(`/api/v1/projects/${id}/enter`, {
        method: 'POST',
        body: JSON.stringify({ acceptRules }),
      })
      if (wanted.current !== id) return // успели переключиться дальше — этот ответ уже неактуален
      setProjectToken(r.token)
      dropProjectCache(qc)
      setState({ status: 'ready' })
    } catch (e) {
      const err = e as { status?: number; body?: { needRulesAccept?: boolean; chatRules?: string; projectName?: string } }
      // Проект удалён или доступ отобрали — это не «ошибка сети», а состояние,
      // которое надо объяснить словами.
      if (err.status === 404 || err.status === 403) {
        setProjectToken(null)
        setState({ status: err.status === 403 ? 'notMember' : 'gone' })
        return
      }
      if (err.status === 428 && err.body?.needRulesAccept) {
        setState({
          status: 'needRules',
          chatRules: err.body.chatRules ?? '',
          projectName: err.body.projectName ?? '',
        })
        return
      }
      setState({ status: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }

  useEffect(() => {
    if (!projectId) return
    // Токен уже от этого проекта — показываем сразу, не дожидаясь сервера:
    // переключение должно быть мгновенным.
    //
    // Но проект мог исчезнуть, пока человек сидел внутри: токен-то остался
    // валидным. Поэтому параллельно перепроверяем — тихо, без экрана загрузки.
    if (projectOfToken(getProjectToken()) === projectId) {
      wanted.current = projectId
      setState({ status: 'ready' })
      void api(`/api/v1/projects/${projectId}`, {}, 'project').catch((e) => {
        const err = e as { status?: number }
        if (wanted.current !== projectId) return
        if (err.status === 404 || err.status === 403) {
          setProjectToken(null)
          setState({ status: err.status === 403 ? 'notMember' : 'gone' })
        }
      })
      return
    }
    void enter(projectId, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  return { ...state, accept: () => projectId && void enter(projectId, true) }
}
