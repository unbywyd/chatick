import type { TFunction } from 'i18next'
import type { BallItem, Move } from './data'

/** Цвет человека — из id, всегда один и тот же: по нему узнают в списке. */
const PALETTE = ['#2F5FD0', '#B4441A', '#6D3FC4', '#0F766E', '#86198F', '#9A3412', '#1D4ED8', '#4D7C0F', '#BE185D', '#0E7490', '#B45309', '#334155']
export function personColor(id: string | null | undefined): string {
  if (!id) return '#71717A'
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return PALETTE[Math.abs(h) % PALETTE.length]!
}
export const letterOf = (name: string | null | undefined) => (name?.trim()?.[0] ?? '?').toUpperCase()
export const firstName = (name: string | null | undefined) => (name ?? '').trim().split(/\s+/)[0] ?? ''
export const projectColor = (p: { id: string; color: string | null } | null | undefined) => p?.color || personColor(p?.id)

/**
 * Короткое имя проекта для чипа: всё до скобок и после « - » длинное, а
 * узнают проект по началу. «Vpure - וי פיור (ורד & ענר כהן)» → «Vpure - וי פיור».
 */
export const shortProject = (name: string) => name.replace(/\s*\(.*\)\s*$/, '').trim() || name

/** Чёрный или белый текст поверх акцента — по яркости, как в макете. */
export function inkOn(hex: string): string {
  const h = hex.replace('#', '')
  const f = h.length === 3 ? h.split('').map((x) => x + x).join('') : h
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16) / 255) as [number, number, number]
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return lum > 0.5 ? '#1B1D1A' : '#FFFFFF'
}

const DAY = 864e5
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

/** Дней до срока: 0 — сегодня, меньше нуля — просрочено. */
export function dueDiff(due: string | null): number | null {
  if (!due) return null
  return Math.round((startOfDay(new Date(due)) - startOfDay(new Date())) / DAY)
}

export function dueText(t: TFunction, due: string | null, lng: string): string {
  const n = dueDiff(due)
  if (n === null) return t('due.none')
  if (n === 0) return t('due.today')
  if (n === 1) return t('due.tomorrow')
  return new Date(due!).toLocaleDateString(lng, { month: 'short', day: 'numeric' })
}

/** Группа по сроку — как на макете: просрочено / сегодня / неделя / позже / без срока. */
export function dueGroup(due: string | null): 'late' | 'today' | 'week' | 'later' | 'none' {
  const n = dueDiff(due)
  if (n === null) return 'none'
  return n < 0 ? 'late' : n === 0 ? 'today' : n <= 7 ? 'week' : 'later'
}

/** Сколько дней мяч лежит у держателя. */
export const heldDays = (since: string | null) => (since ? Math.floor((Date.now() - new Date(since).getTime()) / DAY) : 0)

export function waitText(t: TFunction, since: string | null): string {
  if (!since) return ''
  const ms = Date.now() - new Date(since).getTime()
  if (ms < 60_000) return t('wait.now')
  if (ms < 3_600_000) return t('wait.min', { n: Math.floor(ms / 60_000) })
  if (ms < DAY) return t('wait.h', { n: Math.floor(ms / 3_600_000) })
  return t('wait.d', { n: Math.floor(ms / DAY) })
}

/**
 * Нагрев: сколько дней мяч может пролежать, прежде чем «горит». Проверка и
 * вопрос держат чужую работу — им меньше терпения, чем делу.
 */
const HEAT: Record<Move, [number, number]> = { do: [3, 5], review: [1, 2], answer: [1, 2] }
export function heatOf(move: Move, since: string | null): 'warm' | 'hot' | 'burn' {
  const d = heldDays(since)
  const h = HEAT[move] ?? HEAT.do
  return d >= h[1] ? 'burn' : d >= h[0] ? 'hot' : 'warm'
}

export const isImportant = (priority: string) => priority === 'high' || priority === 'urgent'

/** Ход для метки: «ждём клиента» — пауза поверх хода. */
export const moveKey = (i: Pick<BallItem, 'ball'>) => (i.ball.waitingClientSince ? 'client' : i.ball.move)

export function fmtClock(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
export const fmtHm = (min: number) => `${Math.floor(min / 60)}:${String(Math.floor(min % 60)).padStart(2, '0')}`

export function timeAgo(lng: string, at: string): string {
  const d = new Date(at)
  const diff = Date.now() - d.getTime()
  if (diff < DAY && new Date().getDate() === d.getDate()) return d.toLocaleTimeString(lng, { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString(lng, { month: 'short', day: 'numeric' })
}
