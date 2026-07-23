import { useTranslation } from 'react-i18next'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

export const CHAT_RULES_MAX = 300

export type AiConfig = {
  strictness: number
  allowFlood: boolean
  allowJokes: boolean
  allowQuestions: boolean
  allowOfftopic: boolean
}

export const DEFAULT_AI_CONFIG: AiConfig = {
  strictness: 50,
  allowFlood: false,
  allowJokes: true,
  allowQuestions: true,
  allowOfftopic: false,
}

export type ProjectSettings = {
  name: string
  about: string
  chatRules: string
  aiConfig: AiConfig
}

// Форма настроек проекта (SPEC §4): используется при создании и в редактировании
export function ProjectSettingsForm({
  value,
  onChange,
  showName = true,
}: {
  value: ProjectSettings
  onChange: (v: ProjectSettings) => void
  showName?: boolean
}) {
  const { t } = useTranslation()
  const set = <K extends keyof ProjectSettings>(k: K, v: ProjectSettings[K]) => onChange({ ...value, [k]: v })
  const setAi = <K extends keyof AiConfig>(k: K, v: AiConfig[K]) =>
    onChange({ ...value, aiConfig: { ...value.aiConfig, [k]: v } })

  const rulesLeft = CHAT_RULES_MAX - value.chatRules.length

  return (
    <div className="space-y-6">
      {showName && (
        <Field label={t('projectForm.name')}>
          <Input value={value.name} onChange={(e) => set('name', e.target.value)} placeholder={t('start.projectName')} />
        </Field>
      )}

      <Field label={t('projectForm.about')}>
        <textarea
          value={value.about}
          onChange={(e) => set('about', e.target.value)}
          rows={3}
          placeholder={t('projectForm.aboutPlaceholder')}
          className="w-full resize-none rounded-md border bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
        />
      </Field>

      {/* Правила чата — жёсткий лимит, попадают в каждый промпт ИИ (SPEC §4.2) */}
      <Field
        label={t('projectForm.rules')}
        hint={t('projectForm.rulesHint')}
        trailing={
          <span className={cn('text-xs tabular-nums', rulesLeft < 30 ? 'text-destructive' : 'text-muted-foreground')}>
            {rulesLeft}
          </span>
        }
      >
        <textarea
          value={value.chatRules}
          onChange={(e) => set('chatRules', e.target.value.slice(0, CHAT_RULES_MAX))}
          rows={3}
          maxLength={CHAT_RULES_MAX}
          placeholder={t('projectForm.rulesPlaceholder')}
          className="w-full resize-none rounded-md border bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
        />
      </Field>

      {/* Конфигурация ИИ (SPEC §4.1) */}
      <div className="rounded-lg border p-4">
        <h3 className="text-sm font-semibold">{t('projectForm.aiTitle')}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('projectForm.aiSubtitle')}</p>

        <div className="mt-4 space-y-4">
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm">{t('projectForm.strictness')}</span>
              <span className="text-xs tabular-nums text-muted-foreground">{value.aiConfig.strictness}%</span>
            </div>
            <Slider
              value={[value.aiConfig.strictness]}
              onValueChange={([v]) => setAi('strictness', v ?? 50)}
              min={0}
              max={100}
              step={5}
            />
            <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
              <span>{t('projectForm.strictnessLow')}</span>
              <span>{t('projectForm.strictnessHigh')}</span>
            </div>
          </div>

          <ToggleRow label={t('projectForm.allowFlood')} checked={value.aiConfig.allowFlood} onChange={(v) => setAi('allowFlood', v)} />
          <ToggleRow label={t('projectForm.allowJokes')} checked={value.aiConfig.allowJokes} onChange={(v) => setAi('allowJokes', v)} />
          <ToggleRow label={t('projectForm.allowQuestions')} checked={value.aiConfig.allowQuestions} onChange={(v) => setAi('allowQuestions', v)} />
          <ToggleRow label={t('projectForm.allowOfftopic')} checked={value.aiConfig.allowOfftopic} onChange={(v) => setAi('allowOfftopic', v)} />
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  hint,
  trailing,
  children,
}: {
  label: string
  hint?: string
  trailing?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <label className="text-sm font-medium">{label}</label>
        {trailing}
      </div>
      {children}
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3">
      <span className="text-sm">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  )
}
