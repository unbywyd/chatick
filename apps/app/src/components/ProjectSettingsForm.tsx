import { useState } from 'react'
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

export type AiConfig = {
  mode: AiMode
  language: string // язык ПРОЕКТА: задачи, документы и чат ведутся на нём; иное ИИ переводит
  autoTranslate: boolean
  answerRepeats: boolean
  improveTasks: boolean // ИИ адаптирует новые задачи под язык проекта и улучшает формулировку
  generateTaskNotes: boolean // ИИ генерирует заметки (факты/проблемы/рекомендации) к задаче
}

export const DEFAULT_AI_CONFIG: AiConfig = {
  mode: 'assistant',
  language: 'en',
  autoTranslate: true,
  answerRepeats: true,
  improveTasks: false,
  generateTaskNotes: false,
}

export type ProjectSettings = {
  name: string
  about: string
  chatRules: string
  aiConfig: AiConfig
  storageLimit?: number | null // байты; null = наследовать компанию; число = override
}

const GB = 1024 * 1024 * 1024
const STORAGE_OPTIONS = [1, 2, 5, 10, 50] as const // GB

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

const FORM_TABS = ['general', 'ai', 'rules'] as const
type FormTab = (typeof FORM_TABS)[number]

// Настройки проекта — поля растут, разбито табами: Основное / ИИ / Правила
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
  const [tab, setTab] = useState<FormTab>('general')
  const set = <K extends keyof ProjectSettings>(k: K, v: ProjectSettings[K]) => onChange({ ...value, [k]: v })
  const setAi = <K extends keyof AiConfig>(k: K, v: AiConfig[K]) =>
    onChange({ ...value, aiConfig: { ...value.aiConfig, [k]: v } })

  const rulesLeft = CHAT_RULES_MAX - value.chatRules.length
  const lang = PROJECT_LANGUAGES.find((l) => l.code === value.aiConfig.language)

  return (
    <div>
      <nav className="mb-4 flex gap-1 border-b">
        {FORM_TABS.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm transition-colors',
              tab === key ? 'border-brand font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t(`projectForm.tabs.${key}`)}
          </button>
        ))}
      </nav>

      {tab === 'general' && (
        <div className="space-y-5">
          {showName && (
            <Field label={t('projectForm.name')}>
              <Input value={value.name} onChange={(e) => set('name', e.target.value)} placeholder={t('start.projectName')} />
            </Field>
          )}
          {/* Язык проекта — фундаментальное свойство: задачи, документы и чат на нём */}
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">{t('projectForm.language')}</p>
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
          <Field label={t('projectForm.about')}>
            <textarea
              value={value.about}
              onChange={(e) => set('about', e.target.value)}
              rows={5}
              placeholder={t('projectForm.aboutPlaceholder')}
              className="w-full resize-none rounded-md border bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
            />
          </Field>

          {/* Лимит хранилища проекта (override; по умолчанию наследует пул компании) */}
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">{t('projectForm.storageLimit')}</p>
              <p className="text-xs text-muted-foreground">{t('projectForm.storageLimitHint')}</p>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5">
                  {value.storageLimit == null ? t('projectForm.inheritCompany') : value.storageLimit > 0 ? `${(value.storageLimit / GB).toFixed(0)} GB` : t('projectForm.noLimit')}
                  <ChevronDown className="size-3.5 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuCheckItem checked={value.storageLimit == null} onSelect={() => set('storageLimit', null)}>
                  {t('projectForm.inheritCompany')}
                </DropdownMenuCheckItem>
                {STORAGE_OPTIONS.map((gb) => (
                  <DropdownMenuCheckItem key={gb} checked={value.storageLimit === gb * GB} onSelect={() => set('storageLimit', gb * GB)}>
                    {gb} GB
                  </DropdownMenuCheckItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      )}

      {tab === 'ai' && (
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
                  value.aiConfig.mode === key ? 'border-brand bg-accent' : 'hover:bg-accent/50',
                )}
              >
                <Icon className={cn('size-4', value.aiConfig.mode === key ? 'text-brand' : 'text-muted-foreground')} />
                <p className="mt-2 text-sm font-medium">{t(`aiMode.${key}.title`)}</p>
                <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{t(`aiMode.${key}.desc`)}</p>
              </button>
            ))}
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
          <ToggleRow
            label={t('projectForm.improveTasks')}
            hint={t('projectForm.improveTasksHint')}
            checked={value.aiConfig.improveTasks}
            onChange={(v) => setAi('improveTasks', v)}
          />
          <ToggleRow
            label={t('projectForm.generateTaskNotes')}
            hint={t('projectForm.generateTaskNotesHint')}
            checked={value.aiConfig.generateTaskNotes}
            onChange={(v) => setAi('generateTaskNotes', v)}
          />
        </div>
      )}

      {tab === 'rules' && (
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
            rows={5}
            maxLength={CHAT_RULES_MAX}
            placeholder={t('projectForm.rulesPlaceholder')}
            className="w-full resize-none rounded-md border bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
          />
        </Field>
      )}
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
