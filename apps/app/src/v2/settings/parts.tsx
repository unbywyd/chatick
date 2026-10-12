import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { API_URL, ApiError, getSessionToken } from '@/lib/api'
import { useUi } from '../ui'

/** Переключатель макета (.sw). Кнопка с aria-pressed — читается как переключатель. */
export function Sw({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" className={'sw' + (on ? ' on' : '')} aria-pressed={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)} />
}

/**
 * Подтверждение прямо в строке (.conf), как в макете у «Закрыть доступ».
 * Всё необратимое в настройках проходит через него: отдельное окно ради
 * одной кнопки уводит взгляд от того, что именно удаляется.
 */
export function Confirm({ text, yes, onYes, onNo, busy }: { text: string; yes: string; onYes: () => void; onNo: () => void; busy?: boolean }) {
  const { t } = useTranslation('v2')
  return (
    <div className="conf" role="alert">
      <span>{text}</span>
      <button className="btn sm red" onClick={onYes} disabled={busy}>
        {yes}
      </button>
      <button className="btn sm" onClick={onNo}>
        {t('settings.cancel')}
      </button>
    </div>
  )
}

/** Текст ошибки сервера, если он есть, — иначе общий. */
export function errText(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    const b = e.body as { error?: string; detail?: string; hint?: string } | undefined
    return [b?.error, b?.hint ?? b?.detail].filter(Boolean).join(' — ') || fallback
  }
  return e instanceof Error && e.message ? e.message : fallback
}

/** Ошибку — всплывашкой, как и успех: настройки длинные, и строка под полем часто вне экрана. */
export function useFail() {
  const { flash } = useUi()
  const { t } = useTranslation('v2')
  return useCallback((e: unknown) => flash(errText(e, t('settings.failed'))), [flash, t])
}

/** Загрузка файла multipart-ом: api() всегда шлёт JSON. */
export async function upload(path: string, file: File): Promise<unknown> {
  const fd = new FormData()
  fd.append('file', file)
  const res = await fetch(`${API_URL}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${getSessionToken()}` }, body: fd })
  const body = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new Error(body.error ?? res.statusText)
  return body
}

export function fmtBytes(n: number, lng: string): string {
  const units = lng === 'ru' ? ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'] : ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toLocaleString(lng, { maximumFractionDigits: v < 10 && i > 0 ? 1 : 0 })} ${units[i]}`
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
