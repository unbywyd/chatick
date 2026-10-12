import { consumePendingInvite, consumeReturnTo, setReturnTo } from '@/lib/api'

/**
 * Адреса раздела «Вход» — в одном месте.
 *
 * Вход v2 — основной (12.10): старые экраны входа больше не подключены.
 */
export const AUTH = {
  login: '/login',
  code: '/login/code',
  newco: '/new-company',
  callback: '/auth',
  invite: (token: string) => `/invite/${encodeURIComponent(token)}`,
  consent: (oauthId: string) => `/connect?oauth=${encodeURIComponent(oauthId)}`,
  companies: '/companies',
}

/**
 * Куда вести после входа.
 *
 * Свой ключ рядом со старым «return to»: старый не принимает адреса на
 * /login*, а новая компания и согласие пока живут именно там. Пишем в оба —
 * после входа через Google человека встречает старый /auth, и он читает свой.
 */
const NEXT_KEY = 'chatick_v2_next'

export function setNext(path: string) {
  if (!path.startsWith('/') || path.startsWith('//')) return
  try {
    localStorage.setItem(NEXT_KEY, path)
  } catch {
    /* хранилище закрыто — уйдём на общий экран */
  }
  setReturnTo(path)
}

/** Забрать цель после входа. Приглашение важнее всего: без него доступа к тому, ради чего шли, ещё нет. */
export function takeNext(): string {
  const invite = consumePendingInvite()
  let next: string | null = null
  try {
    next = localStorage.getItem(NEXT_KEY)
    localStorage.removeItem(NEXT_KEY)
  } catch {
    next = null
  }
  const old = consumeReturnTo()
  if (invite) return `${AUTH.invite(invite)}?go=1`
  if (next && next.startsWith('/') && !next.startsWith('//')) return next
  return old ?? '/start'
}

/** Почта между шагами «почта» и «код»: переживает перезагрузку вкладки, но не браузер. */
const EMAIL_KEY = 'chatick_v2_otp_email'
export const otpEmail = {
  get: () => {
    try {
      return sessionStorage.getItem(EMAIL_KEY) ?? ''
    } catch {
      return ''
    }
  },
  set: (v: string) => {
    try {
      sessionStorage.setItem(EMAIL_KEY, v)
    } catch {
      /* без хранилища шаг кода попросит почту заново */
    }
  },
}
