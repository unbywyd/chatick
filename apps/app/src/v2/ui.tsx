import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { Company, HandoffAction } from './data'

/**
 * Общее состояние экрана компании.
 *
 * Проект-фильтр и открытая задача живут в адресе (?p=, ?t=): ссылку на
 * задачу можно переслать, а «назад» в браузере закрывает панель. Окно
 * передачи и всплывашка — только в памяти, им в адресе делать нечего.
 */
export type HoState = { taskId: string; action: HandoffAction | 'other'; to?: string | null } | null

type Ui = {
  companyId: string
  company: Company
  base: string
  project: string | null
  setProject: (id: string | null) => void
  openTaskId: string | null
  openTask: (id: string) => void
  closeTask: () => void
  ho: HoState
  openHo: (s: NonNullable<HoState>) => void
  closeHo: () => void
  toast: string | null
  flash: (msg: string) => void
  aiOpen: boolean
  setAiOpen: (v: boolean) => void
}

const Ctx = createContext<Ui | null>(null)

export function UiProvider({ company, children }: { company: Company; children: React.ReactNode }) {
  const [params, setParams] = useSearchParams()
  const [ho, setHo] = useState<HoState>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [aiOpen, setAiOpenState] = useState(() => localStorage.getItem('chatick_v2_ai') === '1')
  const timer = useRef<number | undefined>(undefined)

  const setParam = useCallback(
    (key: string, value: string | null) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (value) next.set(key, value)
          else next.delete(key)
          return next
        },
        { replace: key === 'p' },
      ),
    [setParams],
  )

  const flash = useCallback((msg: string) => {
    setToast(msg)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setToast(null), 3200)
  }, [])

  const value = useMemo<Ui>(
    () => ({
      companyId: company.id,
      company,
      base: `/c/${company.id}`,
      project: params.get('p'),
      setProject: (id) => setParam('p', id),
      openTaskId: params.get('t'),
      openTask: (id) => setParam('t', id),
      closeTask: () => setParam('t', null),
      ho,
      openHo: setHo,
      closeHo: () => setHo(null),
      toast,
      flash,
      aiOpen,
      setAiOpen: (v) => {
        setAiOpenState(v)
        localStorage.setItem('chatick_v2_ai', v ? '1' : '0')
      },
    }),
    [company, params, setParam, ho, toast, flash, aiOpen],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useUi(): Ui {
  const v = useContext(Ctx)
  if (!v) throw new Error('useUi outside UiProvider')
  return v
}
