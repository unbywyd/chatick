import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  comboFromEvent,
  comboOf,
  loadBindings,
  SHORTCUTS,
  type ActionId,
  type Bindings,
} from '@/lib/shortcuts'

// Глобальные горячие клавиши (SPEC §8.36).
//
// Слушатель один на приложение и висит на window. Действия он выполняет не
// сам: создание задачи и документа живёт внутри вкладок, которые могут быть
// не смонтированы. Поэтому переходим на нужный адрес с параметром (?new=1),
// а вкладка подхватывает его — тот же приём, что уже используется для задач.

/** Текущие настройки, с подпиской на изменения со страницы настройки. */
export function useBindings(): Bindings {
  const [bindings, setBindings] = useState<Bindings>(loadBindings)
  useEffect(() => {
    const reload = () => setBindings(loadBindings())
    window.addEventListener('shortcuts:changed', reload)
    // storage — когда настройки поменяли в другой вкладке браузера
    window.addEventListener('storage', reload)
    return () => {
      window.removeEventListener('shortcuts:changed', reload)
      window.removeEventListener('storage', reload)
    }
  }, [])
  return bindings
}

/** Стоит ли курсор в поле ввода. */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || !el.tagName) return false
  const tag = el.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable
}

/**
 * Уступить ли сочетание полю, в котором сейчас печатают.
 *
 * Уступаем не всё подряд, а только то, что полю действительно нужно: Ctrl+B и
 * Ctrl+I в редакторе — это жирный и курсив, Ctrl+A — выделить всё. Alt же
 * символов не даёт и в редакторе ничем не занят, поэтому Alt-команды работают
 * и из поля: иначе «фокус в ИИ» не нажать из чата, а именно оттуда его и
 * жмут — ради этого перехода клавиша и нужна.
 */
function yieldsToField(e: KeyboardEvent): boolean {
  if (!isTyping(e.target)) return false
  return !e.altKey
}

export type ShortcutHandlers = {
  /** перевести фокус в чат: чат-колонка сама знает, как это сделать */
  focusChat?: () => void
  /** открыть режим ИИ и поставить фокус в его поле */
  focusAi?: () => void
}

/**
 * Вешает глобальный слушатель. Вызывается один раз — из layout'а проекта.
 *
 * handlers держим в ref: чат передаёт свежие замыкания на каждый рендер, и
 * без ref слушатель пересоздавался бы постоянно.
 */
export function useShortcuts(handlers: ShortcutHandlers, opts: { enabled?: boolean } = {}) {
  const { enabled = true } = opts
  const navigate = useNavigate()
  const { id: projectId, companyId } = useParams()
  const bindings = useBindings()
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  const [cheatSheet, setCheatSheet] = useState(false)

  const run = useCallback(
    (action: ActionId) => {
      if (!projectId) return
      const p = `/c/${companyId}/p/${projectId}`
      switch (action) {
        // Создание: вкладка может быть не смонтирована, поэтому просим её
        // через адрес, а не дёргаем её состояние снаружи.
        case 'newTask':
          return navigate(`${p}/tasks?create=1`)
        case 'newDocument':
          return navigate(`${p}/documents?create=1`)
        case 'addResource':
          return navigate(`${p}/resources?create=1`)
        case 'goTasks':
          return navigate(`${p}/tasks`)
        case 'goFiles':
          return navigate(`${p}/files`)
        case 'goTime':
          return navigate(`${p}/time`)
        case 'focusChat':
          return handlersRef.current.focusChat?.()
        case 'focusAi':
          return handlersRef.current.focusAi?.()
      }
    },
    [navigate, projectId, companyId],
  )

  // Карта «сочетание → действие»: искать по ней дешевле, чем перебирать список
  // на каждое нажатие.
  const byCombo = useMemo(() => {
    const map = new Map<string, ActionId>()
    for (const s of SHORTCUTS) map.set(comboOf(s.id, bindings), s.id)
    return map
  }, [bindings])

  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      if (yieldsToField(e)) return

      // «?» — шпаргалка. Отдельно от остальных: это одиночная клавиша, и
      // Shift здесь часть самого символа, а не модификатор. В поле не ловим:
      // там это просто знак вопроса.
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isTyping(e.target)) return
        e.preventDefault()
        setCheatSheet((v) => !v)
        return
      }
      if (e.key === 'Escape') return setCheatSheet(false)

      const combo = comboFromEvent(e)
      if (!combo) return
      const action = byCombo.get(combo)
      if (!action) return
      e.preventDefault()
      setCheatSheet(false)
      run(action)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [byCombo, run, enabled])

  return { cheatSheet, closeCheatSheet: useCallback(() => setCheatSheet(false), []) }
}
