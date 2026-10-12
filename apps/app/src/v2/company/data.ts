import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { TFunction } from 'i18next'
import { api, ApiError } from '@/lib/api'
import type { CompanyRole, Move } from '../data'

/**
 * Данные «Управления компанией»: люди компании, команды всех проектов и
 * открытые задачи с держателями — одним запросом (/companies/:id/teams),
 * чтобы не обходить проекты по одному.
 */
export type CoMember = {
  id: string
  role: CompanyRole
  jobTitle: string
  user: { id: string; name: string; email: string; avatarUrl: string | null }
}
export type TeamRole = 'owner' | 'admin' | 'member'
export type TeamRow = { projectId: string; userId: string; role: TeamRole; name: string; email: string }
export type OpenTask = { id: string; number: string; title: string; projectId: string; holderId: string | null; move: Move; heldSince: string | null }
/** Что ведётся во внешней системе: состав людей и/или список проектов. */
export type External = { name: string | null; members: boolean; projects: boolean }
export type Teams = { members: TeamRow[]; open: OpenTask[]; external?: External }
export type Invite = { id: string; email: string; role: CompanyRole; projectId: string | null; createdAt: string }

export const coKeys = {
  all: ['v2', 'co'] as const,
  members: (cid: string) => ['v2', 'co', 'members', cid] as const,
  teams: (cid: string) => ['v2', 'co', 'teams', cid] as const,
  invites: (cid: string) => ['v2', 'co', 'invites', cid] as const,
}

export function useCoMembers(cid: string) {
  return useQuery({ queryKey: coKeys.members(cid), queryFn: () => api<CoMember[]>(`/api/v1/companies/${cid}/members`) })
}

export function useTeams(cid: string) {
  return useQuery({ queryKey: coKeys.teams(cid), queryFn: () => api<Teams>(`/api/v1/companies/${cid}/teams`) })
}

export function useInvites(cid: string) {
  return useQuery({ queryKey: coKeys.invites(cid), queryFn: () => api<Invite[]>(`/api/v1/companies/${cid}/invites`) })
}

/** После любой правки состава — перечитать раздел, проекты в шапке и мячи. */
export function useCoRefresh() {
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: coKeys.all })
    void qc.invalidateQueries({ queryKey: ['v2', 'projects'] })
    void qc.invalidateQueries({ queryKey: ['v2', 'ball'] })
  }
}

/** «Ведёт проект» — админ проекта; создатель (owner) ведёт его всегда. */
export const isLead = (r: TeamRole) => r === 'admin' || r === 'owner'

/**
 * Клиент для проекта — то, что в названии в скобках:
 * «Vpure - וי פיור (ורד & ענר כהן)» → «ורד & ענר כהן».
 */
export const clientOf = (name: string) => /\(([^)]*)\)\s*$/.exec(name)?.[1]?.trim() ?? ''

/** Отказы сервера приходят английским текстом — переводим известные. */
export function coError(t: TFunction, e: unknown): string {
  if (!(e instanceof ApiError)) return t('company.err.generic')
  const msg = String((e.body as { error?: string } | undefined)?.error ?? '')
  const map: [RegExp, string][] = [
    [/already in the company/i, 'exists'],
    [/already pending/i, 'pending'],
    [/already in this company/i, 'self'],
    [/external system/i, e.status === 403 && /Projects are created/.test(msg) ? 'viaApi' : 'locked'],
    [/name already exists/i, 'nameTaken'],
    [/owner (role )?cannot/i, 'ownerFixed'],
    [/only admin/i, 'onlyAdmin'],
    [/^Forbidden$/, 'forbidden'],
  ]
  const hit = map.find(([re]) => re.test(msg))
  if (hit) return t(`company.err.${hit[1]}`)
  if (e.status === 400 && /email/i.test(msg)) return t('company.err.email')
  return t('company.err.generic')
}

/**
 * Передать мячи человека другому — по одной задаче, ходом «передать».
 *
 * Сервер при удалении сам раздаёт мячи владельцам задач, но макет хочет,
 * чтобы начальство выбрало получателя: поэтому передаём ДО удаления. Ход
 * «передать» не меняет сам ход — проверка остаётся проверкой.
 */
export async function passAll(list: OpenTask[], to: string, note: string) {
  for (const x of list) {
    await api(`/api/v1/tasks/${x.id}/handoff`, {
      method: 'POST',
      body: JSON.stringify({ action: 'pass', to, note }),
      headers: { 'X-Project': x.projectId },
    })
  }
}
