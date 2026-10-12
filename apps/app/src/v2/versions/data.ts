import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '@/lib/api'
import { inProject, SOCKET_EVENT, useProjects, type CompanyProject, type Person, type SocketMessage } from '../data'

/**
 * Данные раздела «Версии».
 *
 * Версии живут внутри проекта и включаются в проекте отдельно (функция
 * releases, по умолчанию выключена). Для экрана компании — одна ручка
 * /api/v1/company-releases: все видимые версии и состояние вебхука Expo по
 * проектам. Адрес и секрет вебхука — отдельно и только по проекту
 * (/api/v1/integrations/expo, право releases.manage).
 */

export type Release = {
  id: string
  version: string
  appName: string | null
  buildType: string
  buildTypeLabel: string
  status: string
  statusLabel: string
  isLive: boolean
  owner: Person | null
  buildProfile: string | null
  referenceUrl: string | null
  buildPageUrl: string | null
  notes: string | null
  releasedAt: string | null
  tasks: { id: string; number: string; title: string; status: string }[]
  createdAt: string
  updatedAt: string
}

export type Expo = { connected: boolean; live: boolean; url?: string; secret?: string; lastEventAt?: string | null }
export type BuildTypeDef = { key: string; label: string; stages: { key: string; label: string; live?: boolean; tone?: string }[] }

export const vkeys = {
  /** Префикс: перечитать список после любой правки версии. */
  all: ['v2', 'releases'] as const,
  company: (companyId: string) => ['v2', 'releases', companyId] as const,
  expo: (projectId: string) => ['v2', 'expo', projectId] as const,
  buildTypes: ['v2', 'build-types'] as const,
  members: (projectId: string) => ['v2', 'members', projectId] as const,
}

export const httpStatus = (e: unknown) => (e instanceof ApiError ? e.status : 0)
const status = httpStatus

type CompanyReleases = { projects: Record<string, { expo: { connected: boolean; live: boolean } }>; items: (Release & { projectId: string })[] }

export function loadExpo(projectId: string): Promise<Expo> {
  return api<Expo>('/api/v1/integrations/expo', inProject(projectId)).catch((e: unknown) => {
    if (status(e) === 404 || status(e) === 403) return { connected: false, live: false }
    throw e
  })
}

export type Row = Release & { project: CompanyProject; step: 0 | 1 | 2 | 3 }

/**
 * Четыре точки макета: запрошено → собирается → собрано → выпущено.
 *
 * Отдельной стадии «запрошено» на сервере нет: запрос сборки заводит версию
 * сразу в «собирается». Отличаем по следам: есть связанная задача, а от
 * Expo ещё ничего не приходило (ни страницы сборки, ни файла).
 */
export function stepOf(r: Release): 0 | 1 | 2 | 3 {
  if (r.isLive) return 3
  if (r.status === 'building') return r.tasks.length && !r.buildPageUrl && !r.referenceUrl ? 0 : 1
  return 2
}

export function useVersionsData(companyId: string) {
  const qc = useQueryClient()
  const projects = useProjects(companyId)
  const list = projects.data ?? []
  const rel = useQuery({
    queryKey: vkeys.company(companyId),
    queryFn: () => api<CompanyReleases>(`/api/v1/company-releases?companyId=${encodeURIComponent(companyId)}`),
    staleTime: 30_000,
  })
  const onIds = Object.keys(rel.data?.projects ?? {})
  // Лестницы стадий — с сервера, чтобы не держать вторую копию на клиенте.
  // Ручка живёт внутри проекта; берём любой проект с включёнными версиями.
  const bt = useQuery({
    queryKey: vkeys.buildTypes,
    queryFn: () => api<{ buildTypes: BuildTypeDef[] }>('/api/v1/releases/build-types', inProject(onIds[0]!)).then((r) => r.buildTypes),
    enabled: onIds.length > 0,
    staleTime: Infinity,
  })

  // Вебхук Expo двигает версию без человека — перечитываем по событию.
  useEffect(() => {
    const on = (e: Event) => {
      const m = (e as CustomEvent<SocketMessage>).detail
      if (m?.event === 'releases_changed') {
        void qc.invalidateQueries({ queryKey: vkeys.all })
        void qc.invalidateQueries({ queryKey: ['v2', 'expo'] })
      }
    }
    window.addEventListener(SOCKET_EVENT, on)
    return () => window.removeEventListener(SOCKET_EVENT, on)
  }, [qc])

  const byId = new Map(list.map((p) => [p.id, p]))
  const rows: Row[] = []
  for (const r of rel.data?.items ?? []) {
    const p = byId.get(r.projectId)
    if (p) rows.push({ ...r, project: p, step: stepOf(r) })
  }
  const expoBy = new Map<string, Expo>(Object.entries(rel.data?.projects ?? {}).map(([id, v]) => [id, v.expo]))
  return {
    projects: list,
    rows,
    expoBy,
    onSet: new Set(onIds),
    buildTypes: bt.data ?? [],
    loading: projects.isLoading || rel.isLoading,
    failed: projects.isError || rel.isError,
  }
}

/** Включить версии в проекте, если выключены: у v2 нет вкладки проекта, где это делалось. */
export async function ensureReleasesOn(projectId: string, on: boolean) {
  if (on) return
  await api(`/api/v1/projects/${projectId}/features`, { method: 'POST', body: JSON.stringify({ feature: 'releases', enabled: true }) })
}
