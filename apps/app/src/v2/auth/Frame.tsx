import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { api, type Me } from '@/lib/api'
import { keys } from '../data'
import { LOCALES } from '@/i18n'
import { useTheme } from '@/providers/theme'
import { inkOn } from '../util'
import '../styles/main.css'
import '../styles/rtl.css'
import '../styles/auth.css'
import '../i18n'
import '../i18n/auth'

const ACCENT = '#D4F36B'
export const LANG_SHORT: Record<string, string> = { ru: 'RU', en: 'EN', he: 'עב' }

/**
 * Корень экранов вне компании: шапки здесь нет, а тема, направление письма и
 * акцент — те же, что у Frame в Shell.tsx.
 */
export function AuthFrame({ kind, children }: { kind: 'au' | 'cp'; children: React.ReactNode }) {
  const { resolved } = useTheme()
  const { i18n } = useTranslation()
  return (
    <div
      className={`app ${kind}` + (resolved === 'dark' ? ' dark' : '')}
      dir={i18n.dir()}
      style={{ '--accent': ACCENT, '--accent-ink': inkOn(ACCENT) } as React.CSSProperties}
    >
      {children}
    </div>
  )
}

/** Экран входа: тёмная колонка слева, форма справа. */
export function AuthLayout({ children }: { children: React.ReactNode }) {
  const { t, i18n } = useTranslation('v2')
  return (
    <AuthFrame kind="au">
      <aside className="lft">
        <div className="lgo">
          {/* Знак — тот же, что у установленного приложения: новый появится вместе с его обновлением. */}
          <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" />
          Chatick
        </div>
        {/* Языки — там, где в макете были кнопки прототипа: на входе шапки нет. */}
        <div className="lft-tools" role="group" aria-label={t('me.language')}>
          {LOCALES.map((l) => (
            <button key={l.code} lang={l.code} className={i18n.resolvedLanguage === l.code ? 'on' : ''} onClick={() => void i18n.changeLanguage(l.code)}>
              {LANG_SHORT[l.code]}
            </button>
          ))}
        </div>
        <Scene />
        <h2>
          {t('auth.side.tagA')} <em>{t('auth.side.tagB')}</em>
        </h2>
        <p>{t('auth.side.note')}</p>
      </aside>
      <main className="rgt">
        <div className="box">{children}</div>
      </main>
    </AuthFrame>
  )
}

/** Картинки из макета нет файлом — рисуем её смысл: строки задач, одна у человека в руках. */
function Scene() {
  return (
    <div className="au-scene" aria-hidden="true">
      <div>
        <b style={{ background: '#2F5FD0' }}>E</b>
        <i />
        <i className="s" />
      </div>
      <div className="hot">
        <b style={{ background: '#B4441A' }}>H</b>
        <i />
        <span>✓</span>
      </div>
      <div>
        <b style={{ background: '#6D3FC4' }}>A</b>
        <i className="s" />
        <i />
      </div>
    </div>
  )
}

export function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path fill="#4285F4" d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.6 4.6 0 01-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3z" />
      <path fill="#34A853" d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0012 22z" />
      <path fill="#FBBC05" d="M6.4 14a6 6 0 010-3.9V7.5H3.1a10 10 0 000 9z" />
      <path fill="#EA4335" d="M12 6c1.5 0 2.8.5 3.8 1.5l2.9-2.9A10 10 0 003.1 7.5l3.3 2.6C7.2 7.8 9.4 6 12 6z" />
    </svg>
  )
}

/** Кто вошёл — только если вошёл: без сессии запрос дал бы 401 в консоль. Ключ общий с useMe. */
export function useMeIf(signedIn: boolean) {
  return useQuery({ queryKey: keys.me, queryFn: () => api<Me>('/api/v1/auth/me'), enabled: signedIn, staleTime: 5 * 60_000 })
}
