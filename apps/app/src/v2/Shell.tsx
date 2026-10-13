import { useEffect } from 'react'
import { Navigate, Outlet, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { getSessionToken } from '@/lib/api'
import { useTheme } from '@/providers/theme'
import { useCompanies, useUserSocket } from './data'
import { UiProvider, useUi } from './ui'
import { Header } from './Header'
import { Assistant } from './Assistant'
import { TaskPanel } from './tasks/TaskPanel'
import { HandoffDialog } from './tasks/Handoff'
import { Icon } from './Icon'
import { inkOn } from './util'
import './styles/main.css'
import './styles/fixes.css'
import './styles/rtl.css'
import './i18n'

const ACCENT = '#D4F36B'

/**
 * Оболочка экрана компании: шапка, страница, ассистент справа, панель задачи
 * и окно передачи поверх. Один экран на компанию — проекты в нём фильтр.
 */
export function Shell() {
  const { companyId } = useParams()
  const companies = useCompanies()
  const signedIn = Boolean(getSessionToken())
  useUserSocket(signedIn)
  if (!signedIn) return <Navigate to="/login" replace />
  if (!companies.data) return <Frame>{companies.isError ? <Failed onRetry={() => void companies.refetch()} /> : null}</Frame>
  const company = companies.data.find((c) => c.id === companyId)
  if (!company) return <Navigate to="/start" replace />
  localStorage.setItem('chatick_v2_company', company.id)
  return (
    <UiProvider company={company}>
      <Frame>
        <Header />
        <Body />
      </Frame>
    </UiProvider>
  )
}

function Frame({ children }: { children: React.ReactNode }) {
  const { resolved } = useTheme()
  const { i18n } = useTranslation()
  return (
    <div
      className={'app lay-stage' + (resolved === 'dark' ? ' dark' : '')}
      dir={i18n.dir()}
      style={{ '--accent': ACCENT, '--accent-ink': inkOn(ACCENT) } as React.CSSProperties}
    >
      {children}
    </div>
  )
}

function Body() {
  const { t } = useTranslation('v2')
  const { aiOpen, setAiOpen, toast, openTaskId, ho } = useUi()
  // Ctrl+J — ассистент, как подписано на кнопке.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        setAiOpen(!aiOpen)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [aiOpen, setAiOpen])
  return (
    <>
      <div className="shell">
        <main className="main">
          <Outlet />
        </main>
        {aiOpen && <Assistant />}
        {!aiOpen && (
          <button className="ai-fab" onClick={() => setAiOpen(true)} aria-label={t('ai.openAria')}>
            <span className="ico">
              <Icon name="spark" sm />
            </span>
            {t('ai.open')}
            <kbd>Ctrl J</kbd>
          </button>
        )}
      </div>
      {openTaskId && <TaskPanel key={openTaskId} taskId={openTaskId} />}
      {ho && <HandoffDialog key={ho.taskId + ho.action} />}
      {toast && (
        <div className="toast" role="status">
          <Icon name="check" />
          {toast}
        </div>
      )}
    </>
  )
}

function Failed({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation('v2')
  return (
    <div className="none" style={{ padding: 48 }}>
      {t('common.error')} · <button onClick={onRetry}>{t('common.retry')}</button>
    </div>
  )
}

/** Без компании в адресе — последняя открытая или первая из списка. */
export function StartRedirect() {
  const companies = useCompanies()
  if (!getSessionToken()) return <Navigate to="/login" replace />
  if (!companies.data) return null
  const last = localStorage.getItem('chatick_v2_company')
  // Иначе — та, где больше всего проектов: обычно это и есть рабочая компания.
  const pick = companies.data.find((c) => c.id === last) ?? [...companies.data].sort((a, b) => b.projectsCount - a.projectsCount)[0]
  // Компаний нет — завести свою (или принять приглашение со списка компаний).
  if (!pick) return <Navigate to="/new-company" replace />
  return <Navigate to={`/c/${pick.id}`} replace />
}

export function Soon() {
  const { t } = useTranslation('v2')
  return (
    <div className="wrap">
      <div className="none" style={{ padding: '64px 0' }}>
        {t('common.soon')}
      </div>
    </div>
  )
}
