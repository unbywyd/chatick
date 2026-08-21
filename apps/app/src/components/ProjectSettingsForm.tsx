import { useMemo, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ChevronDown, HardDrive } from 'lucide-react'
import { DangerZone, DangerAction } from '@/components/company/DangerZone'
import { AiBehaviorFields } from '@/components/AiBehaviorFields'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { ProjectBadge } from '@/components/ui/project-badge'
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
  autoPostTaskEvents: false,
}

export type ProjectSettings = {
  name: string
  about: string
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

// Хранилище и опасная зона — отдельными вкладками. Удаление проекта висело
// прямо под обычными полями «Основного», куда заходят менять имя и цвет: до
// необратимой кнопки дотягивались мимоходом.
// Настройки времени переехали в компанию: пояс и правила таймера — свойства
// организации, а не отдельной работы. Наследуются, задавать здесь нечего.
// «Правила» отдельной вкладкой больше нет: это часть поведения агента, и
// живёт она теперь рядом с остальными его настройками — во вкладке ИИ.
const FORM_TABS = ['general', 'ai', 'features', 'danger'] as const
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
  aiPageHref,
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
  /** Ссылка на страницу ИИ проекта: там источник, ключ и расход. */
  aiPageHref?: string
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
  const set = <K extends keyof ProjectSettings>(k: K, v: ProjectSettings[K]) => onChange({ ...value, [k]: v })
  const setAi = <K extends keyof AiConfig>(k: K, v: AiConfig[K]) =>
    onChange({ ...value, aiConfig: { ...value.aiConfig, [k]: v } })


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
          {/* Та же разметка, что и на странице ИИ проекта: правила переехали
              сюда же, отдельной вкладкой они были продолжением этого разговора.
              Здесь поля сохраняются общей кнопкой формы — в том числе при
              создании проекта, когда сохранять ещё некуда. */}
          <AiBehaviorFields
            value={value.aiConfig}
            onChange={(v) => set('aiConfig', v)}
            chatRules={value.chatRules}
            onRulesChange={(v) => set('chatRules', v)}
          />

          {/* Ссылка на страницу ИИ: там же выбирается источник и ключ, и без
              указателя два экрана выглядят независимыми. Только у готового
              проекта — на создании этой страницы ещё нет. */}
          {projectId && aiPageHref && (
            <a
              href={aiPageHref}
              className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm transition-colors hover:bg-accent/50"
            >
              <span>
                <span className="block font-medium">{t('projectForm.aiPageLink')}</span>
                <span className="block text-xs text-muted-foreground">{t('projectForm.aiPageLinkHint')}</span>
              </span>
              <ChevronDown className="size-4 -rotate-90 text-muted-foreground" />
            </a>
          )}
        </div>
      )}

      {tab === 'features' && projectId && <FeaturesSection projectId={projectId} />}

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
            !externalLinked && (
              // В рамке DangerZone у элементов свои отступы — голый текст из
              // неё вылезал.
              <p className="px-4 py-3 text-sm text-muted-foreground">{t('project.dangerEmpty')}</p>
            )
          )}
        </DangerZone>
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

/**
 * Дополнительные возможности проекта.
 *
 * Живёт отдельным компонентом, потому что состояние здесь не из формы: тумблер
 * применяется сразу, без «Сохранить». Смешав его с остальными полями, мы бы
 * получили вкладку, где половина изменений уже применена, а половина ждёт
 * кнопки — и никак этого не показывали.
 */
function FeaturesSection({ projectId }: { projectId: string }) {
  const { t } = useTranslation()
  const qc = useQueryClient()

  const state = useQuery({
    queryKey: ['project-features', projectId],
    queryFn: () => api<{ features: string[]; canManage: boolean }>(`/api/v1/projects/${projectId}/features`),
  })

  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      api(`/api/v1/projects/${projectId}/features`, {
        method: 'POST',
        body: JSON.stringify({ feature: 'releases', enabled }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project-features', projectId] })
      toast.success(t('common.saved'))
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  if (state.isLoading) return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>

  const on = state.data?.features.includes('releases') ?? false

  return (
    <div className="space-y-4">
      <ToggleRow
        label={t('projectForm.featureReleases')}
        hint={t('projectForm.featureReleasesHint')}
        checked={on}
        onChange={(v) => toggle.mutate(v)}
      />
      {!state.data?.canManage && <p className="text-xs text-muted-foreground">{t('projectForm.featuresAdminOnly')}</p>}
      {/* Выключение прячет вкладку, но НЕ трогает данные: случайный клик не
          должен стирать историю релизов. */}
      {on && <p className="text-xs text-muted-foreground">{t('projectForm.featureReleasesOffHint')}</p>}
    </div>
  )
}
