import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueries, useQuery } from '@tanstack/react-query'
import type { TFunction } from 'i18next'
import { api, API_URL, ApiError, getSessionToken } from '@/lib/api'
import { inProject, useProjects, type CompanyProject } from '../data'
import { useUi } from '../ui'
import { ProjectLogo } from '../ProjectLogo'
import { Icon } from '../Icon'
import { letterOf, personColor, shortProject } from '../util'
import '../i18n/library'
import '../styles/library.css'

/**
 * Общее для «Ресурсов», «Файлов» и «Истории».
 *
 * Все три раздела на сервере живут внутри проекта (X-Project), а экран у нас
 * один на компанию. Поэтому список собираем по проектам параллельно и
 * склеиваем: проектов в компании десятки, не тысячи, и каждый ответ
 * кэшируется отдельно — переключение проекта в карусели не ходит в сеть.
 */

export type Person = { id: string; name: string; email?: string; avatarUrl: string | null }

/** Проекты компании без архивных: в архиве ни ресурсов, ни истории не ищут. */
export function useLibProjects(companyId: string) {
  const q = useProjects(companyId)
  const list = useMemo(() => (q.data ?? []).filter((p) => !(p as CompanyProject & { archived?: boolean }).archived), [q.data])
  return { list, isLoading: q.isLoading }
}

/**
 * Один и тот же запрос во все проекты сразу.
 *
 * Отказ проекта (нет права, проект закрыт) — пустой ответ, а не ошибка
 * экрана: человек видит то, что ему можно, остальное просто не приходит.
 */
export function usePerProject<T>(name: string, all: CompanyProject[], path: string, extra: unknown[] = [], enabled = true) {
  // Выбранный в карусели проект — первым в очереди: запросов десятки, а
  // браузер держит к серверу всего несколько соединений.
  const first = useUi().project
  const projects = first ? [...all].sort((a, b) => Number(b.id === first) - Number(a.id === first)) : all
  return useQueries({
    queries: projects.map((p) => ({
      queryKey: ['v2', 'lib', name, p.id, path, ...extra],
      queryFn: () => api<T>(path, inProject(p.id)).catch(() => null),
      staleTime: 30_000,
      enabled,
    })),
    combine: (rs) => ({
      parts: rs.map((r, i) => ({ project: projects[i]!, data: (r.data ?? null) as T | null })),
      loading: rs.some((r) => r.isLoading),
    }),
  })
}

/** Люди компании — имена для истории и фильтра «кто». */
export function usePeople(companyId: string) {
  const q = useQuery({
    queryKey: ['v2', 'lib', 'people', companyId],
    queryFn: () => api<{ user: Person }[]>(`/api/v1/companies/${companyId}/members`).then((r) => r.map((m) => m.user)),
    staleTime: 5 * 60_000,
  })
  const list = q.data ?? []
  const byId = useMemo(() => new Map(list.map((p) => [p.id, p])), [list])
  return { list, byId }
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const h = window.setTimeout(() => setV(value), ms)
    return () => window.clearTimeout(h)
  }, [value, ms])
  return v
}

export function useCopy() {
  const { t } = useTranslation('v2')
  const { flash } = useUi()
  return (text: string, msg?: string) =>
    navigator.clipboard.writeText(text).then(
      () => flash(msg ?? t('library.copied')),
      () => flash(t('library.copyFailed')),
    )
}

const DAY = 864e5
const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

/** «Сегодня», «Вчера», иначе дата — заголовок группы по дням. */
export function dayLabel(t: TFunction, lng: string, at: string): string {
  const d = new Date(at)
  const diff = Math.round((dayStart(new Date()) - dayStart(d)) / DAY)
  if (diff === 0) return t('library.today')
  if (diff === 1) return t('library.yesterday')
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString(lng, sameYear ? { day: 'numeric', month: 'long' } : { day: 'numeric', month: 'long', year: 'numeric' })
}
export const dayKey = (at: string) => String(dayStart(new Date(at)))

/** Группы по дням в том порядке, в каком пришли элементы (свежие сверху). */
export function byDay<T>(items: T[], at: (x: T) => string): { key: string; first: string; items: T[] }[] {
  const out: { key: string; first: string; items: T[] }[] = []
  for (const x of items) {
    const k = dayKey(at(x))
    const g = out.find((o) => o.key === k)
    if (g) g.items.push(x)
    else out.push({ key: k, first: at(x), items: [x] })
  }
  return out
}

export function fmtSize(n: number, t: TFunction): string {
  if (n < 1024) return t('library.size.b', { n })
  if (n < 1024 * 1024) return t('library.size.kb', { n: Math.round(n / 1024) })
  return t('library.size.mb', { n: (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) })
}

/**
 * Окно поверх экрана — классы макета. Фиксированное, а не «absolute» как в
 * макете: разделы длинные, и окно, открытое из середины списка, иначе
 * оказалось бы над краем экрана.
 */
export function Modal({ label, onClose, wide, top, children }: { label: string; onClose: () => void; wide?: boolean; top?: boolean; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Открытый выпадающий список закрывается первым, окно — следующим Esc.
      if (document.querySelector('.lib-modal .cbx-pop')) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className={'mwrap lib-modal' + (top ? ' mwrap-top' : '')} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={'modal' + (wide ? ' wide' : '')} role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>
  )
}

/** Выбор проекта — комбобокс с поиском, как в окне «Новый ресурс». */
export function ProjectCombo({
  projects,
  value,
  onChange,
  disabled,
}: {
  projects: CompanyProject[]
  value: string | null
  onChange: (id: string) => void
  disabled?: boolean
}) {
  const { t } = useTranslation('v2')
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const cur = projects.find((p) => p.id === value) ?? null
  const s = q.trim().toLowerCase()
  const items = projects.filter((p) => !s || p.name.toLowerCase().includes(s))
  const pick = (id: string) => {
    onChange(id)
    setOpen(false)
    setQ('')
  }
  return (
    <div className="cbx">
      <button
        type="button"
        className="cbx-f"
        onClick={() => !disabled && setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('library.projectAria', { name: cur ? shortProject(cur.name) : '—' })}
        disabled={disabled}
        style={disabled ? { cursor: 'default' } : undefined}
      >
        {cur ? <ProjectLogo project={cur} /> : <span className="logo sm all" />}
        <span className="cbx-n">{cur ? shortProject(cur.name) : t('library.pickProject')}</span>
        {!disabled && <Icon name="chevron" sm />}
      </button>
      {open && (
        <>
          <div className="cbx-scrim" onClick={() => setOpen(false)} />
          <div className="cbx-pop">
            <label className="cbx-s">
              <Icon name="search" sm />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setOpen(false)
                  if (e.key === 'Enter' && items[0]) pick(items[0].id)
                }}
                placeholder={t('library.findProject', { n: projects.length })}
                aria-label={t('library.findProjectAria')}
                autoFocus
              />
            </label>
            <div className="cbx-l" role="listbox">
              {items.map((p) => (
                <button key={p.id} type="button" className="cbx-o" role="option" aria-selected={p.id === value} onClick={() => pick(p.id)}>
                  <ProjectLogo project={p} />
                  <span className="cbx-n">{shortProject(p.name)}</span>
                  {p.id === value && <Icon name="check" sm />}
                </button>
              ))}
              {!items.length && <div className="cbx-none">{t('car.none', { q })}</div>}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/** Выбор человека — «кто» в истории. null — все. */
export function PersonCombo({ people, value, onChange }: { people: Person[]; value: string | null; onChange: (id: string | null) => void }) {
  const { t } = useTranslation('v2')
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const cur = people.find((p) => p.id === value) ?? null
  const s = q.trim().toLowerCase()
  const items = people.filter((p) => !s || p.name.toLowerCase().includes(s) || (p.email ?? '').toLowerCase().includes(s))
  const pick = (id: string | null) => {
    onChange(id)
    setOpen(false)
    setQ('')
  }
  const all = t('library.everyone')
  return (
    <div className="cbx">
      <button type="button" className="cbx-f" onClick={() => setOpen(!open)} aria-haspopup="listbox" aria-expanded={open} aria-label={t('library.whoAria', { name: cur?.name ?? all })}>
        {cur ? (
          <span className="av pcav" style={{ background: personColor(cur.id) }}>
            {letterOf(cur.name)}
          </span>
        ) : (
          <span className="av pcav" style={{ background: 'var(--ink3)' }}>
            <Icon name="people" sm />
          </span>
        )}
        <span className="cbx-n">{cur?.name ?? all}</span>
        <Icon name="chevron" sm />
      </button>
      {open && (
        <>
          <div className="cbx-scrim" onClick={() => setOpen(false)} />
          <div className="cbx-pop">
            <label className="cbx-s">
              <Icon name="search" sm />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
                placeholder={t('library.findPerson', { n: people.length })}
                aria-label={t('library.findPersonAria')}
                autoFocus
              />
            </label>
            <div className="cbx-l" role="listbox">
              {!s && (
                <button type="button" className="cbx-o" role="option" aria-selected={!value} onClick={() => pick(null)}>
                  <span className="av pcav" style={{ background: 'var(--ink3)' }}>
                    <Icon name="people" sm />
                  </span>
                  <span className="cbx-n">{all}</span>
                  {!value && <Icon name="check" sm />}
                </button>
              )}
              {items.map((p) => (
                <button key={p.id} type="button" className="cbx-o" role="option" aria-selected={p.id === value} onClick={() => pick(p.id)}>
                  <span className="av pcav" style={{ background: personColor(p.id) }}>
                    {letterOf(p.name)}
                  </span>
                  <span className="cbx-n">{p.name}</span>
                  {p.id === value && <Icon name="check" sm />}
                </button>
              ))}
              {!items.length && <div className="cbx-none">{t('library.noPerson', { q })}</div>}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/** Загрузка multipart в проект: api() шлёт JSON и для FormData не годится. */
export async function uploadTo(projectId: string, url: string, form: FormData): Promise<Response> {
  const token = getSessionToken()
  return fetch(`${API_URL}${url}`, {
    method: 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'X-Project': projectId },
    body: form,
  })
}

/** Проект по id из списка — для строк, где сервер прислал только id. */
export const projectMap = (list: CompanyProject[]) => new Map(list.map((p) => [p.id, p]))

/** Ошибка сервера — человеческим текстом: «нет прав» отдельно, остальное общим. */
export function errText(t: TFunction, e: unknown): string {
  if (e instanceof ApiError) return e.status === 403 ? t('library.forbidden') : e.status === 404 ? t('library.notFound') : t('err.generic')
  if (e instanceof TypeError) return t('library.network')
  if (e instanceof Error && e.message) return e.message
  return t('err.generic')
}
