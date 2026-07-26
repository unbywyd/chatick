import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api, getProjectToken, setProjectToken } from '@/lib/api'

// Источник истины о текущем проекте — projectId в URL (SPEC §8.29).
// Токен подтягивается под него фоном, поэтому переключение между проектами
// мгновенное, ссылки на проект остаются рабочими, а перезагрузки нет.

type State =
  | { status: 'ready' }
  | { status: 'loading' }
  | { status: 'needRules'; chatRules: string; projectName: string }
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
      // данные предыдущего проекта не должны просочиться в новый
      qc.removeQueries({ queryKey: ['messages'] })
      qc.removeQueries({ queryKey: ['tasks'] })
      qc.removeQueries({ queryKey: ['documents'] })
      qc.removeQueries({ queryKey: ['files'] })
      qc.invalidateQueries()
      setState({ status: 'ready' })
    } catch (e) {
      const err = e as { status?: number; body?: { needRulesAccept?: boolean; chatRules?: string; projectName?: string } }
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
    // токен уже от этого проекта — ничего не делаем, переключение бесплатное
    if (projectOfToken(getProjectToken()) === projectId) {
      wanted.current = projectId
      setState({ status: 'ready' })
      return
    }
    void enter(projectId, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  return { ...state, accept: () => projectId && void enter(projectId, true) }
}
