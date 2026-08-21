import { Eye, MessageCircleQuestion, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import type { AiConfig, AiMode } from '@/components/ProjectSettingsForm'
import { CHAT_RULES_MAX } from '@/components/ProjectSettingsForm'

/**
 * Поведение ИИ-агента: режим, переключатели и правила чата.
 *
 * Отдельным компонентом, потому что мест два и они устроены по-разному.
 * На странице ИИ проекта поля сохраняются сами, а в форме настроек — общей
 * кнопкой внизу, вместе со всем остальным. Там же форма работает и при
 * СОЗДАНИИ проекта, когда проекта ещё нет и сохранять некуда.
 *
 * Отсюда договор: здесь только разметка, никаких запросов. Кто показывает —
 * тот и решает, как сохранять.
 */

// SPEC §4.1: каждый параметр = конкретное действие диспетчера
const MODES: { key: AiMode; icon: typeof Eye }[] = [
  { key: 'observer', icon: Eye },
  { key: 'assistant', icon: MessageCircleQuestion },
  { key: 'moderator', icon: ShieldCheck },
]

export function AiBehaviorFields({
  value,
  onChange,
  chatRules,
  onRulesChange,
}: {
  value: AiConfig
  onChange: (v: AiConfig) => void
  /** Правила чата лежат рядом с настройками ИИ, но не внутри aiConfig. */
  chatRules: string
  onRulesChange: (v: string) => void
}) {
  const { t } = useTranslation()
  const setAi = <K extends keyof AiConfig>(k: K, v: AiConfig[K]) => onChange({ ...value, [k]: v })
  const rulesLeft = CHAT_RULES_MAX - chatRules.length

  return (
    <div className="space-y-5">
      {/* Режим — 3 карточки (SPEC §4.1) */}
      <div className="grid gap-2 sm:grid-cols-3">
        {MODES.map(({ key, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => setAi('mode', key)}
            className={cn(
              'rounded-lg border p-3 text-start transition-colors',
              value.mode === key ? 'border-brand bg-accent' : 'hover:bg-accent/50',
            )}
          >
            <Icon className={cn('size-4', value.mode === key ? 'text-brand-ink' : 'text-muted-foreground')} />
            <p className="mt-2 text-sm font-medium">{t(`aiMode.${key}.title`)}</p>
            <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{t(`aiMode.${key}.desc`)}</p>
          </button>
        ))}
      </div>

      <ToggleRow
        label={t('projectForm.autoTranslate')}
        hint={t('projectForm.autoTranslateHint')}
        checked={value.autoTranslate}
        onChange={(v) => setAi('autoTranslate', v)}
      />
      <ToggleRow
        label={t('projectForm.answerRepeats')}
        hint={t('projectForm.answerRepeatsHint')}
        checked={value.answerRepeats}
        onChange={(v) => setAi('answerRepeats', v)}
      />
      <ToggleRow
        label={t('projectForm.improveTasks')}
        hint={t('projectForm.improveTasksHint')}
        checked={value.improveTasks}
        onChange={(v) => setAi('improveTasks', v)}
      />
      <ToggleRow
        label={t('projectForm.generateTaskNotes')}
        hint={t('projectForm.generateTaskNotesHint')}
        checked={value.generateTaskNotes}
        onChange={(v) => setAi('generateTaskNotes', v)}
      />
      <ToggleRow
        label={t('projectForm.autoPostTaskEvents')}
        hint={t('projectForm.autoPostTaskEventsHint')}
        checked={value.autoPostTaskEvents}
        onChange={(v) => setAi('autoPostTaskEvents', v)}
      />

      {/* Правила — здесь же: это продолжение того же разговора о том, как
          агент себя ведёт, и держать их вкладкой поодаль незачем. */}
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <label className="text-sm font-medium">{t('projectForm.rules')}</label>
          <span className={cn('text-xs tabular-nums', rulesLeft < 30 ? 'text-destructive' : 'text-muted-foreground')}>
            {rulesLeft}
          </span>
        </div>
        <textarea
          value={chatRules}
          onChange={(e) => onRulesChange(e.target.value.slice(0, CHAT_RULES_MAX))}
          rows={5}
          maxLength={CHAT_RULES_MAX}
          placeholder={t('projectForm.rulesPlaceholder')}
          className="w-full resize-none rounded-md border bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
        />
        <p className="mt-1 text-xs text-muted-foreground">{t('projectForm.rulesHint')}</p>
      </div>
    </div>
  )
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string
  hint?: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3">
      <span>
        <span className="block text-sm">{label}</span>
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  )
}
