import { useOutletContext } from 'react-router-dom'

/**
 * Контекст открытого проекта — отдельным модулем, без зависимостей.
 *
 * Раньше и типы, и хук жили в ProjectScreen. Вкладки берут их оттуда, а
 * ProjectScreen импортирует сами вкладки — получался цикл. Он работал по
 * случайности: порядок вычисления модулей складывался удачно. Стоило
 * поменять состав импортов, и браузер падал на «does not provide an export
 * named useProjectCtx» — экспорт при этом был на месте, просто модуль ещё не
 * успел выполниться.
 *
 * Здесь этого не случится: файл не импортирует ничего из приложения, и
 * зациклиться ему не на чем.
 */

export type ProjectDetails = {
  /** Состав команды ведётся во внешней системе: видно, но не правится. */
  membersViaApiOnly?: boolean
  id: string
  companyId: string
  name: string
  about: string
  chatRules: string
  aiConfig: Record<string, unknown>
  myRole: 'owner' | 'admin' | 'member' | null
  /** Имя проекта во внешней системе — показывается рядом с нашим. */
  externalName?: string | null
  /** Готовая ссылка «туда». null, если интеграция не настроена. */
  externalLink?: { name: string; url: string } | null
}

export type ProjectOutletCtx = { project?: ProjectDetails; meId?: string }

export function useProjectCtx() {
  return useOutletContext<ProjectOutletCtx>()
}
