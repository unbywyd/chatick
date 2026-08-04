import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import { Settings2 } from 'lucide-react'
import { comboOf, displayCombo, SHORTCUTS } from '@/lib/shortcuts'
import { useBindings } from '@/hooks/useShortcuts'
import { Button } from '@/components/ui/button'

// Шпаргалка по «?» (SPEC §8.36) — как в Gmail и Linear: её пробуют первой,
// когда хотят узнать, что вообще умеют клавиши.

export function ShortcutsCheatSheet({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { id: projectId, companyId } = useParams()
  const bindings = useBindings()

  const groups = ['create', 'navigate', 'chat'] as const

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-6" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-xl border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-bold">{t('shortcuts.title')}</h2>

        <div className="mt-4 space-y-4">
          {groups.map((g) => (
            <section key={g}>
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t(`shortcuts.groups.${g}`)}
              </h3>
              <ul className="mt-1.5 space-y-1">
                {SHORTCUTS.filter((s) => s.group === g).map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-4 text-sm">
                    <span>{t(`shortcuts.actions.${s.id}`)}</span>
                    <kbd className="rounded border bg-secondary px-2 py-0.5 font-mono text-xs">
                      {displayCombo(comboOf(s.id, bindings))}
                    </kbd>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <div className="mt-5 flex justify-between gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              onClose()
              navigate(`/c/${companyId}/p/${projectId}/shortcuts`)
            }}
          >
            <Settings2 className="size-3.5" />
            {t('shortcuts.customize')}
          </Button>
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('files.cancel')}
          </Button>
        </div>
      </div>
    </div>
  )
}
