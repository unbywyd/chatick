import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { api, API_URL, getSessionToken } from '@/lib/api'
import { Icon } from './Icon'
import './i18n/project'
import { isMac } from './keys'

const SUPPORT = 'support@chatick.com'
const MAX_SHOT = 8 * 1024 * 1024

/**
 * Окно поверх всего приложения. Открывается из меню профиля в шапке, а шапка
 * и меню — позиционированные блоки: без портала окно ужималось до их размера.
 */
function Modal({ title, icon, onClose, children }: { title: string; icon: string; onClose: () => void; children: React.ReactNode }) {
  const { t } = useTranslation('v2')
  const root = document.querySelector('.app') ?? document.body
  return createPortal(
    <div className="mwrap mwrap-top" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="mh">
          <span className="rk">
            <Icon name={icon} />
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <h3 style={{ marginTop: 8 }}>{title}</h3>
          </div>
          <button className="ib" aria-label={t('me2.close')} onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        {children}
      </div>
    </div>,
    root,
  )
}

/** «О программе»: версия и куда писать. Открывается из меню и из трея (?about=1). */
export function AboutModal({ onClose, onReport }: { onClose: () => void; onReport: () => void }) {
  const { t } = useTranslation('v2')
  const about = useQuery({ queryKey: ['v2', 'about'], queryFn: () => api<{ version: string; text?: string; website?: string }>('/api/v1/about') })
  return (
    <Modal title={t('me2.aboutTitle')} icon="info" onClose={onClose}>
      <div className="me2-about">
        <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" />
        <div>
          <b>Chatick</b>
          <span>{t('me2.version', { v: about.data?.version ?? '…' })}</span>
        </div>
      </div>
      {about.data?.text && <p className="co-hint bidi">{about.data.text}</p>}
      <p className="co-hint">
        {t('me2.support')}{' '}
        <a href={`mailto:${SUPPORT}`} dir="ltr">
          {SUPPORT}
        </a>
        {about.data?.website && (
          <>
            {' · '}
            <a href={about.data.website} target="_blank" rel="noreferrer" dir="ltr">
              {about.data.website.replace(/^https?:\/\//, '')}
            </a>
          </>
        )}
      </p>
      <div className="mf">
        <div className="res" />
        <button className="btn" onClick={onReport}>
          {t('me2.report')}
        </button>
        <button className="btn-acc" onClick={onClose}>
          {t('me2.ok')}
        </button>
      </div>
    </Modal>
  )
}

/**
 * «Сообщить о проблеме»: текст и скриншот. Скриншот можно вставить из буфера —
 * баг обычно уже снят Print Screen. Страница, на которой человек был, уходит
 * вместе с отчётом.
 */
export function ReportModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('v2')
  const [body, setBody] = useState('')
  const [shot, setShot] = useState<File | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [done, setDone] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const attach = (f: File | null | undefined) => {
    if (!f) return
    if (!f.type.startsWith('image/')) return setErr(t('me2.notImage'))
    if (f.size > MAX_SHOT) return setErr(t('me2.tooLarge'))
    setErr(null)
    setShot(f)
  }
  const send = async () => {
    if (body.trim().length < 10) return setErr(t('me2.tooShort'))
    setSending(true)
    try {
      const form = new FormData()
      form.set('topic', 'bug')
      form.set('body', body.trim())
      form.set('page', location.href)
      if (shot) form.set('screenshot', shot)
      const token = getSessionToken()
      const r = await fetch(`${API_URL}/api/v1/about/feedback`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: form })
      if (!r.ok) throw new Error(String(r.status))
      setDone(true)
      setTimeout(onClose, 2000)
    } catch {
      setErr(t('me2.failed'))
    } finally {
      setSending(false)
    }
  }
  return (
    <Modal title={t('me2.report')} icon="mail" onClose={onClose}>
      {done ? (
        <p className="co-hint" style={{ fontSize: 15, color: 'var(--ink)' }}>
          {t('me2.sent')}
        </p>
      ) : (
        <div onPaste={(e) => attach(Array.from(e.clipboardData.files).find((f) => f.type.startsWith('image/')))}>
          <textarea
            className="nin psx-ta bidi"
            autoFocus
            rows={5}
            value={body}
            onChange={(e) => {
              setBody(e.target.value)
              setErr(null)
            }}
            placeholder={t('me2.reportPh')}
            aria-label={t('me2.report')}
          />
          <div className="psx-row" style={{ marginTop: 10 }}>
            <button className="mini" onClick={() => fileRef.current?.click()}>
              {shot ? t('me2.shotReplace') : t('me2.shotAdd')}
            </button>
            {shot && <span className="co-hint bidi" style={{ margin: 0 }}>{shot.name}</span>}
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => attach(e.target.files?.[0])} />
          </div>
          <p className="co-hint">{t('me2.shotHint', { key: isMac ? '⌘V' : 'Ctrl+V' })}</p>
          <div className="mf">
            <div className="res" role={err ? 'alert' : undefined} style={err ? { color: 'var(--signal)' } : undefined}>
              {err}
            </div>
            <button className="btn" onClick={onClose}>
              {t('me2.cancel')}
            </button>
            <button className={'btn-acc' + (sending ? ' dis' : '')} onClick={() => void send()}>
              {sending ? t('me2.sending') : t('me2.send')}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}
