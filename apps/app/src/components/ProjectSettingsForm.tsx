import { useTranslation } from 'react-i18next'
import { Eye, MessageCircleQuestion, ShieldCheck, ChevronDown } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckItem,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

export const CHAT_RULES_MAX = 300

// SPEC §4.1: каждый параметр = конкретное действие диспетчера
export type AiMode = 'observer' | 'assistant' | 'moderator'
export type Offtopic = 'ignore' | 'remind' | 'hold'

export type AiConfig = {
  mode: AiMode
  language: string // язык проекта
  autoTranslate: boolean
  answerRepeats: boolean
  offtopic: Offtopic
}

export const DEFAULT_AI_CONFIG: AiConfig = {
  mode: 'assistant',
  language: 'en',
  autoTranslate: true,
  answerRepeats: true,
  offtopic: 'remind',
}

export type ProjectSettings = {
  name: string
  about: string
  chatRules: string
  aiConfig: AiConfig
}

const PROJECT_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'ru', label: 'Русский' },
  { code: 'he', label: 'עברית' },
] as const

const MODES: { key: AiMode; icon: typeof Eye }[] = [
  { key: 'observer', icon: Eye },
  { key: 'assistant', icon: MessageCircleQuestion },
  { key: 'moderator', icon: ShieldCheck },
]

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
  const lang = PROJECT_LANGUAGES.find((l) => l.code === value.aiConfig.language)

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

      {/* Правила чата: тон, шутки, флуд — человеческим языком; в каждый промпт ИИ (SPEC §4.2) */}
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

        {/* Режим — 3 карточки */}
        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          {MODES.map(({ key, icon: Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => setAi('mode', key)}
              className={cn(
                'rounded-lg border p-3 text-start transition-colors',
                value.aiConfig.mode === key ? 'border-brand bg-accent' : 'hover:bg-accent/50',
              )}
            >
              <Icon className={cn('size-4', value.aiConfig.mode === key ? 'text-brand' : 'text-muted-foreground')} />
              <p className="mt-2 text-sm font-medium">{t(`aiMode.${key}.title`)}</p>
              <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{t(`aiMode.${key}.desc`)}</p>
            </button>
          ))}
        </div>

        <div className="mt-4 space-y-4">
          {/* Язык проекта */}
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm">{t('projectForm.language')}</p>
              <p className="text-xs text-muted-foreground">{t('projectForm.languageHint')}</p>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5">
                  {lang?.label ?? value.aiConfig.language}
                  <ChevronDown className="size-3.5 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {PROJECT_LANGUAGES.map((l) => (
                  <DropdownMenuCheckItem key={l.code} checked={l.code === value.aiConfig.language} onSelect={() => setAi('language', l.code)}>
                    {l.label}
                  </DropdownMenuCheckItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <ToggleRow
            label={t('projectForm.autoTranslate')}
            hint={t('projectForm.autoTranslateHint')}
            checked={value.aiConfig.autoTranslate}
            onChange={(v) => setAi('autoTranslate', v)}
          />
          <ToggleRow
            label={t('projectForm.answerRepeats')}
            hint={t('projectForm.answerRepeatsHint')}
            checked={value.aiConfig.answerRepeats}
            onChange={(v) => setAi('answerRepeats', v)}
          />

          {/* Оффтоп — сегмент из 3 действий */}
          <div>
            <p className="text-sm">{t('projectForm.offtopic')}</p>
            <div className="mt-2 flex rounded-md border p-0.5">
              {(['ignore', 'remind', 'hold'] as const).map((o) => (
                <button
                  key={o}
                  type="button"
                  onClick={() => setAi('offtopic', o)}
                  className={cn(
                    'flex-1 rounded px-2 py-1.5 text-xs transition-colors',
                    value.aiConfig.offtopic === o
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {t(`offtopic.${o}`)}
                </button>
              ))}
            </div>
          </div>
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
