import { useCallback, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Navigate, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { api, getSessionToken, type CompanyInvite } from '@/lib/api'
import { useTheme } from '@/providers/theme'
import { useCompanies, useUserSocket, type Company } from './data'
import { setNext } from './auth/paths'
import { UiProvider, useUi } from './ui'
import { Header } from './Header'
import { Assistant } from './Assistant'
import { TaskPanel } from './tasks/TaskPanel'
import { HandoffDialog } from './tasks/Handoff'
import { Icon } from './Icon'
import { comboOf, showCombo, typing, useBindings, type KeyAction } from './keys'
import { KeysSheet, SearchPalette, useSearchOpener } from './Palette'
import { inkOn } from './util'
import './styles/main.css'
import './styles/fixes.css'
import './styles/rtl.css'
import { MovedBanner } from './MovedBanner'
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
  const loc = useLocation()
  useUserSocket(signedIn)
  if (!signedIn) {
    // Ссылку на задачу или документ открыли без входа — запоминаем, куда
    // шли: после входа вернём туда, а не в последнюю компанию.
    setNext(loc.pathname + loc.search)
    return <Navigate to="/login" replace />
  }
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
  const { aiOpen, setAiOpen, toast, openTaskId, ho, base, project, company } = useUi()
  const navigate = useNavigate()
  const keys = useBindings()
  const [pal, setPal] = useState(false)
  const [sheet, setSheet] = useState(false)
  useSearchOpener(useCallback(() => setPal(true), []))
  // Горячие клавиши (v2/keys.ts): поиск, ассистент, новая задача, разделы; «?» — шпаргалка.
  useEffect(() => {
    const run = (a: KeyAction) => {
      if (a === 'search') return setPal((v) => !v)
      if (a === 'assistant') return setAiOpen(!aiOpen)
      setPal(false)
      if (a === 'newTask') return navigate(`${base}/task/new`, { state: { projectId: project ?? undefined } })
      const path = { goTasks: '', goDocs: '/docs', goNotes: '/notes', goFiles: '/files', goTime: '/time', notifications: '/notifications' }[a]
      navigate(`${base}${path}`)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey && !typing(e)) {
        e.preventDefault()
        setSheet(true)
        return
      }
      const c = comboOf(e)
      if (!c) return
      const a = (Object.keys(keys) as KeyAction[]).find((k) => keys[k] === c)
      if (!a) return
      // В поле ввода — только Ctrl/⌘: ⌥ на Mac набирает символы.
      if (typing(e) && !/Ctrl|Meta/.test(c)) return
      e.preventDefault()
      run(a)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [aiOpen, setAiOpen, keys, navigate, base, project])
  return (
    <>
      <div className="shell">
        <main className="main">
          {/* В колонке, а не над всем экраном: ассистент рядом прилипает к
              шапке на всю высоту, и полоса над ним уводила его низ за экран. */}
          <MovedBanner company={company} />
          <Outlet />
        </main>
        {aiOpen && <Assistant />}
        {!aiOpen && (
          <button className="ai-fab" onClick={() => setAiOpen(true)} aria-label={t('ai.openAria')}>
            <span className="ico">
              <Icon name="spark" sm />
            </span>
            {t('ai.open')}
            <kbd>{showCombo(keys.assistant)}</kbd>
          </button>
        )}
      </div>
      {openTaskId && <TaskPanel key={openTaskId} taskId={openTaskId} />}
      {pal && <SearchPalette onClose={() => setPal(false)} onKeys={() => setSheet(true)} />}
      {sheet && <KeysSheet onClose={() => setSheet(false)} />}
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
  // Без компаний — сначала проверить приглашения: вошедший не по ссылке из
  // письма иначе попадал сразу в «Создать компанию» и не знал, что его ждут.
  const none = companies.data?.length === 0
  const all = useQuery({
    queryKey: ['v2', 'auth', 'companies'],
    queryFn: () => api<{ companies: Company[]; invites: CompanyInvite[] }>('/api/v1/companies'),
    enabled: none,
  })
  if (!getSessionToken()) return <Navigate to="/login" replace />
  if (!companies.data) return null
  const last = localStorage.getItem('chatick_v2_company')
  // Иначе — та, где больше всего проектов: обычно это и есть рабочая компания.
  const pick = companies.data.find((c) => c.id === last) ?? [...companies.data].sort((a, b) => b.projectsCount - a.projectsCount)[0]
  // Компаний нет — завести свою (или принять приглашение со списка компаний).
  if (!pick) {
    if (!all.data) return null
    return <Navigate to={all.data.invites.length ? '/companies' : '/new-company'} replace />
  }
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
