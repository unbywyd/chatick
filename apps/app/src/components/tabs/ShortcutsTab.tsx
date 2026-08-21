import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Keyboard, RotateCcw, X } from 'lucide-react'
import {
  comboFromEvent,
  comboOf,
  displayCombo,
  findConflict,
  loadBindings,
  saveBindings,
  SHORTCUTS,
  type ActionId,
  type Bindings,
} from '@/lib/shortcuts'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// Страница настройки горячих клавиш (SPEC §8.36).
//
// Сочетание не выбирают из списка, а нажимают: так сразу видно, что клавиша
// вообще доходит до приложения, и не надо гадать, как называется кнопка.

export function ShortcutsTab() {
  const { t } = useTranslation()
  const [bindings, setBindings] = useState<Bindings>(loadBindings)
  /** какое действие сейчас ждёт нажатия */
  const [capturing, setCapturing] = useState<ActionId | null>(null)

  const apply = (next: Bindings) => {
    setBindings(next)
    saveBindings(next)
  }

  const groups = ['create', 'navigate', 'chat'] as const

  return (
    <div className="page-w p-6">
      <div className="flex items-center gap-2">
        <Keyboard className="size-5 text-muted-foreground" />
        <h1 className="text-lg font-bold">{t('shortcuts.title')}</h1>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{t('shortcuts.hint')}</p>

      <div className="mt-6 space-y-6">
        {groups.map((g) => (
          <section key={g}>
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t(`shortcuts.groups.${g}`)}
            </h2>
            <ul className="mt-2 divide-y rounded-lg border">
              {SHORTCUTS.filter((s) => s.group === g).map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-4 p-3">
                  <span className="text-sm">{t(`shortcuts.actions.${s.id}`)}</span>
                  <div className="flex items-center gap-1.5">
                    <ComboButton
                      combo={comboOf(s.id, bindings)}
                      capturing={capturing === s.id}
                      onStart={() => setCapturing(s.id)}
                      onCancel={() => setCapturing(null)}
                      onCapture={(combo) => {
                        const clash = findConflict(combo, s.id, bindings)
                        if (clash) {
                          toast.error(
                            t('shortcuts.conflict', { action: t(`shortcuts.actions.${clash}`) }),
                          )
                          return
                        }
                        apply({ ...bindings, [s.id]: combo })
                        setCapturing(null)
                      }}
                    />
                    {/* Сброс — только у изменённых: у остальных кнопка ничего
                        не делала бы и лишь путала. */}
                    {bindings[s.id] && (
                      <button
                        title={t('shortcuts.reset')}
                        onClick={() => {
                          const next = { ...bindings }
                          delete next[s.id]
                          apply(next)
                        }}
                        className="cursor-pointer rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                      >
                        <RotateCcw className="size-3.5" />
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <div className="mt-6">
        <Button variant="outline" size="sm" onClick={() => apply({})} disabled={!Object.keys(bindings).length}>
          <RotateCcw className="size-3.5" />
          {t('shortcuts.resetAll')}
        </Button>
      </div>
    </div>
  )
}

/** Кнопка-ловушка: нажатая, ждёт сочетание и показывает его же. */
function ComboButton({
  combo,
  capturing,
  onStart,
  onCancel,
  onCapture,
}: {
  combo: string
  capturing: boolean
  onStart: () => void
  onCancel: () => void
  onCapture: (combo: string) => void
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!capturing) return
    ref.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      // Пока ловим — забираем всё: иначе Alt+F успел бы увести на файлы.
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') return onCancel()
      const next = comboFromEvent(e)
      if (next) onCapture(next)
    }
    // capture: перехватываем раньше глобального слушателя горячих клавиш.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [capturing, onCancel, onCapture])

  return (
    <button
      ref={ref}
      onClick={capturing ? onCancel : onStart}
      className={cn(
        'inline-flex min-w-28 cursor-pointer items-center justify-center gap-1.5 rounded-md border px-2.5 py-1.5 font-mono text-xs',
        capturing ? 'border-brand text-brand-ink' : 'bg-secondary hover:bg-accent',
      )}
    >
      {capturing ? (
        <>
          {t('shortcuts.press')}
          <X className="size-3" />
        </>
      ) : (
        displayCombo(combo)
      )}
    </button>
  )
}
