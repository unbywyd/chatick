import { useMemo, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Eye, MessageCircleQuestion, ShieldCheck, ChevronDown, HardDrive } from 'lucide-react'
import { DangerZone, DangerAction } from '@/components/company/DangerZone'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { ProjectBadge } from '@/components/ui/project-badge'
import { COUNTRIES, countryByCode, allTimezones, timezoneOffset } from '@/lib/countries'
import { Combobox } from '@/components/ui/combobox'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { LanguagePicker } from '@/components/ui/language-picker'
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
  autoPostTaskEvents: boolean // автосообщения в чат о событиях задач (SPEC §8.23)
}

export const DEFAULT_AI_CONFIG: AiConfig = {
  mode: 'assistant',
  language: 'en',
  autoTranslate: true,
  answerRepeats: true,
  improveTasks: false,
  generateTaskNotes: false,
  autoPostTaskEvents: true,
}

export type TimeConfig = {
  maxTimers: number
  idleAction: 'remind' | 'stop'
  idleHours: number
  repeatHours: number
  /** страна задаёт пояс, первый день недели и язык — одним выбором */
  country: string
  timezone: string
  weekStart: number
  /** пропускать описания записей через ИИ на язык проекта */
  translate: boolean
}

export const DEFAULT_TIME_CONFIG: TimeConfig = {
  maxTimers: 1,
  idleAction: 'remind',
  idleHours: 8,
  repeatHours: 8,
  country: '',
  timezone: 'UTC',
  weekStart: 1,
  translate: false,
}

export type ProjectSettings = {
  name: string
  about: string
  timeConfig?: TimeConfig
  /** цвет значка проекта; при создании раздаётся случайный */
  color?: string
  logoUrl?: string | null
  chatRules: string
  aiConfig: AiConfig
  storageLimit?: number | null // байты; null = наследовать компанию; число = override
}

// Та же палитра, что раздаёт сервер новому проекту (routes/projects.ts).
const PROJECT_COLORS = [
  '#6366f1', '#0ea5e9', '#14b8a6', '#22c55e', '#eab308',
  '#f97316', '#ef4444', '#ec4899', '#a855f7', '#64748b',
] as const

const GB = 1024 * 1024 * 1024
// Варианты не выше бесплатного пула компании: эффективный лимит всё равно
// считается как минимум из проектного и остатка компании, и предлагать 50 ГБ
// значит обещать то, чего нет.
const STORAGE_OPTIONS = [1, 2] as const // GB

const MODES: { key: AiMode; icon: typeof Eye }[] = [
  { key: 'observer', icon: Eye },
  { key: 'assistant', icon: MessageCircleQuestion },
  { key: 'moderator', icon: ShieldCheck },
]

// Хранилище и опасная зона — отдельными вкладками. Удаление проекта висело
// прямо под обычными полями «Основного», куда заходят менять имя и цвет: до
// необратимой кнопки дотягивались мимоходом.
const FORM_TABS = ['general', 'ai', 'rules', 'time', 'danger'] as const
type FormTab = (typeof FORM_TABS)[number]

// Настройки проекта — поля растут, разбито табами: Основное / ИИ / Правила
export function ProjectSettingsForm({
  value,
  onChange,
  showName = true,
  projectId,
  onLogoUpload,
  onLogoRemove,
  onDelete,
}: {
  value: ProjectSettings
  onChange: (v: ProjectSettings) => void
  showName?: boolean
  /** существующий проект — нужен, чтобы узнать, чьё хранилище используется */
  projectId?: string
  // загрузка логотипа возможна только у существующего проекта: файл кладётся
  // сразу, поэтому в форме создания эти обработчики не передаются
  onLogoUpload?: (file: File) => void
  onLogoRemove?: () => void
  /** Удаление проекта — отдельной вкладкой, если человеку оно вообще доступно. */
  onDelete?: () => void
}) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<FormTab>('general')
  const qc = useQueryClient()

  // Связь с внешней системой: показываем отвязку, только если она есть.
  const linked = useQuery({
    queryKey: ['project-external', projectId],
    enabled: Boolean(projectId),
    queryFn: () =>
      api<{ externalId: string | null; externalLink: { name: string } | null }>(`/api/v1/projects/${projectId}`),
  })
  const externalLinked = Boolean(linked.data?.externalId)
  const externalSystem = linked.data?.externalLink?.name

  const unlink = useMutation({
    mutationFn: () => api(`/api/v1/projects/${projectId}/unlink-external`, { method: 'POST' }),
    onSuccess: () => {
      toast.success(t('project.unlinkDone'))
      qc.invalidateQueries({ queryKey: ['project-external', projectId] })
      qc.invalidateQueries({ queryKey: ['projects'] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  // Чьё хранилище у проекта: на своём лимит не применяется и не показывается.
  const storage = useQuery({
    queryKey: ['storage-config', projectId],
    enabled: Boolean(projectId),
    queryFn: () => api<{ provider: 'platform' | 'custom' }>(`/api/v1/projects/${projectId}/storage`),
  })
  const customStorage = storage.data?.provider === 'custom'
  const logoInput = useRef<HTMLInputElement>(null)
  const time = { ...DEFAULT_TIME_CONFIG, ...(value.timeConfig ?? {}) }
  // список зон длинный и не меняется — собираем один раз на монтирование
  const timezoneOptions = useMemo(
    () => allTimezones().map((tz) => ({ value: tz, label: tz.replace(/_/g, ' '), hint: timezoneOffset(tz) })),
    [],
  )
  const setTime = <K extends keyof TimeConfig>(k: K, v: TimeConfig[K]) =>
    onChange({ ...value, timeConfig: { ...time, [k]: v } })
  const set = <K extends keyof ProjectSettings>(k: K, v: ProjectSettings[K]) => onChange({ ...value, [k]: v })
  const setAi = <K extends keyof AiConfig>(k: K, v: AiConfig[K]) =>
    onChange({ ...value, aiConfig: { ...value.aiConfig, [k]: v } })

  const rulesLeft = CHAT_RULES_MAX - value.chatRules.length

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
          {/* Значок проекта: в свёрнутом сайдбаре только он и виден */}
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium">{t('projectForm.badge')}</p>
              <p className="text-xs text-muted-foreground">{t('projectForm.badgeHint')}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {PROJECT_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => set('color', c)}
                    style={{ backgroundColor: c }}
                    className={cn(
                      'size-6 rounded-md transition-transform',
                      (value.color ?? PROJECT_COLORS[0]) === c ? 'scale-110 ring-2 ring-foreground ring-offset-2 ring-offset-background' : 'hover:scale-105',
                    )}
                    aria-label={c}
                  />
                ))}
              </div>
            </div>
            <div className="flex shrink-0 flex-col items-center gap-1.5">
              <ProjectBadge name={value.name || '?'} color={value.color} logoUrl={value.logoUrl} size={56} />
              {onLogoUpload && (
                <>
                  <input
                    ref={logoInput}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f) onLogoUpload(f)
                      e.target.value = ''
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => logoInput.current?.click()}
                    className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                  >
                    {value.logoUrl ? t('projectForm.logoReplace') : t('projectForm.logoUpload')}
                  </button>
                  {value.logoUrl && onLogoRemove && (
                    <button
                      type="button"
                      onClick={onLogoRemove}
                      className="text-xs text-destructive underline-offset-2 hover:underline"
                    >
                      {t('projectForm.logoRemove')}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Язык проекта — фундаментальное свойство: задачи, документы и чат на нём */}
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">{t('projectForm.language')}</p>
              <p className="text-xs text-muted-foreground">{t('projectForm.languageHint')}</p>
            </div>
            <LanguagePicker
              value={value.aiConfig.language}
              onChange={(code) => setAi('language', code)}
              className="w-52 shrink-0"
            />
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

          {/* Лимит хранилища. На своём R2 его не показываем вовсе: там платит
              клиент, ограничивать нечего, а лишний контрол только путает. */}
          {!customStorage && (
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
          )}
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
          <ToggleRow
            label={t('projectForm.autoPostTaskEvents')}
            hint={t('projectForm.autoPostTaskEventsHint')}
            checked={value.aiConfig.autoPostTaskEvents}
            onChange={(v) => setAi('autoPostTaskEvents', v)}
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

      {tab === 'danger' && (
        <DangerZone>
          {/* Отвязка от внешней системы: связь создавалась снаружи и снаружи же
              только и рвалась. Если доступ к той системе потерян, проект
              оставался помеченным навсегда. Содержимое не трогаем. */}
          {externalLinked && projectId && (
            <DangerAction
              title={t('project.unlinkAction')}
              description={t('project.unlinkHint', { system: externalSystem || t('team.yourSystem') })}
              actionLabel={t('project.unlinkAction')}
              onAction={() => unlink.mutate()}
            />
          )}

          {/* Удаление — только тому, кому оно вообще доступно. Раньше при этом
              пропадала и вся вкладка: человек видел пустой экран. */}
          {onDelete ? (
            <DangerAction
              title={t('project.deleteAction')}
              description={t('danger.deleteProjectHint')}
              actionLabel={t('project.deleteAction')}
              onAction={onDelete}
            />
          ) : (
            !externalLinked && <p className="text-sm text-muted-foreground">{t('project.dangerEmpty')}</p>
          )}
        </DangerZone>
      )}

      {tab === 'time' && (
        <div className="space-y-5">
          {/* Регион задаётся одним выбором: пояс, первый день недели и язык
              связаны, и настраивать их порознь — путь к рассинхрону отчётов. */}
          <div className="space-y-3 rounded-lg border p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">{t('time.country')}</p>
                <p className="text-xs text-muted-foreground">{t('time.countryHint')}</p>
              </div>
              <Select
                value={time.country || 'none'}
                onValueChange={(code) => {
                  const preset = countryByCode(code)
                  if (!preset) {
                    setTime('country', '')
                    return
                  }
                  onChange({
                    ...value,
                    timeConfig: {
                      ...time,
                      country: preset.code,
                      timezone: preset.timezone,
                      weekStart: preset.weekStart,
                    },
                    // язык проекта — тоже часть региона, но перебивать уже
                    // выбранный не станем: его могли задать осознанно
                    aiConfig: value.aiConfig.language
                      ? value.aiConfig
                      : { ...value.aiConfig, language: preset.language ?? 'en' },
                  })
                }}
              >
                <SelectTrigger className="w-52">
                  <SelectValue placeholder={t('time.countryNone')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('time.countryNone')}</SelectItem>
                  {COUNTRIES.map((c) => (
                    <SelectItem key={c.code} value={c.code}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <p className="mb-1 text-xs text-muted-foreground">{t('time.timezone')}</p>
                <Combobox
                  options={timezoneOptions}
                  value={time.timezone}
                  onChange={(tz) => setTime('timezone', tz)}
                  placeholder="UTC"
                />
              </div>
              <div>
                <p className="mb-1 text-xs text-muted-foreground">{t('time.weekStart')}</p>
                <Select value={String(time.weekStart)} onValueChange={(v) => setTime('weekStart', Number(v))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[0, 1, 6].map((d) => (
                      <SelectItem key={d} value={String(d)}>
                        {t(`notif.weekday.${d}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          {/* Параллельные таймеры: они же закрывают потребность вести две
              задачи разом — вместо списка задач внутри одной записи. */}
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">{t('time.maxTimers')}</p>
              <p className="text-xs text-muted-foreground">{t('time.maxTimersHint')}</p>
            </div>
            <Input
              type="number"
              min={1}
              max={20}
              value={time.maxTimers}
              onChange={(e) => setTime('maxTimers', Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
              className="w-20 text-center"
            />
          </div>

          <ToggleRow
            label={t('time.translate')}
            hint={t('time.translateHint')}
            checked={time.translate}
            onChange={(v) => setTime('translate', v)}
          />

          <div className="space-y-2">
            <p className="text-sm font-medium">{t('time.idleAction')}</p>
            <div className="flex gap-1.5">
              {(['remind', 'stop'] as const).map((action) => (
                <button
                  key={action}
                  type="button"
                  onClick={() => setTime('idleAction', action)}
                  className={cn(
                    'rounded-full border px-3 py-1 text-xs transition-colors',
                    time.idleAction === action
                      ? 'border-brand bg-brand/10 text-foreground'
                      : 'text-muted-foreground hover:bg-accent',
                  )}
                >
                  {t(action === 'remind' ? 'time.idleRemind' : 'time.idleStop')}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="mb-1 text-xs text-muted-foreground">{t('time.idleHours')}</p>
                <Input
                  type="number"
                  min={1}
                  max={48}
                  value={time.idleHours}
                  onChange={(e) => setTime('idleHours', Math.max(1, Math.min(48, Number(e.target.value) || 8)))}
                />
              </div>
              {time.idleAction === 'remind' && (
                <div>
                  <p className="mb-1 text-xs text-muted-foreground">{t('time.repeatHours')}</p>
                  <Input
                    type="number"
                    min={1}
                    max={48}
                    value={time.repeatHours}
                    onChange={(e) => setTime('repeatHours', Math.max(1, Math.min(48, Number(e.target.value) || 8)))}
                  />
                </div>
              )}
            </div>
          </div>
        </div>
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
