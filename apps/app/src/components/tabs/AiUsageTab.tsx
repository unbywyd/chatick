import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Bot, Check, Cpu } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { AiBehaviorFields } from '@/components/AiBehaviorFields'
import { PageHeader } from '@/components/ui/page-header'
import { DEFAULT_AI_CONFIG, type AiConfig } from '@/components/ProjectSettingsForm'

/**
 * Табы страницы ИИ.
 *
 * Настройки первыми: сюда приходят настраивать, а не смотреть отчёт. Расход,
 * журнал и прайсинг — про одно и то же и смотрятся подряд, поэтому одним
 * табом, а не тремя.
 */
const AI_TABS = ['settings', 'usage'] as const
type AiTab = (typeof AI_TABS)[number]

// ИИ-агент проекта + учёт использования (SPEC §8.11).
type Config = {
  source: 'company' | 'trial' | 'custom'
  /** что работает по факту: при 'company' без ключа компании отвечает пробный */
  activeSource?: 'company' | 'trial' | 'custom' | null
  trialSpentUsd?: number
  provider: string
  model: string
  hasKey: boolean
  trialBudget: number
  trialAvailable: boolean
  spentUsd: number
  providers: { id: string; label: string; defaultModel: string }[]
}
type UsageRow = { model: string; source: string; calls: number; tokensIn: number; tokensOut: number; costUsd: number | null }
type LogRow = { id: string; model: string; source: string; feature: string | null; tokensIn: number; tokensOut: number; costUsd: number | null; createdAt: string }
type PriceRow = { model: string; inputPerM: number | null; outputPerM: number | null; custom: boolean; hasDefault: boolean }

const fmtUsd = (n: number | null) => (n === null ? '—' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`)
const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

export function AiUsageTab({ projectId, isAdmin }: { projectId: string; isAdmin: boolean }) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const onErr = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e))

  /**
   * Таб — из адреса, а не из состояния.
   *
   * Тот же приём, что в настройках компании: ссылкой делятся, страницу
   * обновляют, и таб должен пережить и то и другое. Чужое значение в адресе
   * не роняет экран, а откатывается к первому табу. Дефолт в адрес не пишем:
   * /ai короче и понятнее, чем /ai/settings.
   */
  const navigate = useNavigate()
  const { companyId, aiTab } = useParams()
  const tab: AiTab = AI_TABS.includes(aiTab as AiTab) ? (aiTab as AiTab) : 'settings'
  const goTab = (key: AiTab) => {
    const base = `/c/${companyId}/p/${projectId}/ai`
    // replace: кнопка «назад» должна уводить со страницы, а не отматывать по табам
    navigate(key === 'settings' ? base : `${base}/${key}`, { replace: true })
  }

  const cfgQ = useQuery({ queryKey: ['ai-config', projectId], queryFn: () => api<Config>('/api/v1/ai/config', {}, 'project') })
  const usageQ = useQuery({ queryKey: ['ai-usage', projectId], queryFn: () => api<{ spentUsd: number; byModel: UsageRow[] }>('/api/v1/ai/usage', {}, 'project') })
  const logQ = useQuery({ queryKey: ['ai-log', projectId], queryFn: () => api<LogRow[]>('/api/v1/ai/usage/log', {}, 'project') })
  const priceQ = useQuery({ queryKey: ['ai-pricing', projectId], queryFn: () => api<PriceRow[]>('/api/v1/ai/pricing', {}, 'project') })

  const cfg = cfgQ.data
  const trialPct = cfg && cfg.trialBudget > 0 ? Math.min(100, (cfg.spentUsd / cfg.trialBudget) * 100) : 0

  const [source, setSource] = useState<'company' | 'trial' | 'custom'>('trial')
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  /** Провайдера меняют осознанно: иначе показываем карточку, а не форму. */
  const [changingCustom, setChangingCustom] = useState(false)

  useEffect(() => {
    if (!cfg) return
    setSource(cfg.source)
    setProvider(cfg.provider || cfg.providers[0]?.id || '')
    setModel(cfg.model)
  }, [cfg])

  const saveCfg = useMutation({
    mutationFn: () =>
      api('/api/v1/ai/config', { method: 'PUT', body: JSON.stringify({ source, provider, model: model || undefined, apiKey: apiKey || undefined }) }, 'project'),
    onSuccess: () => {
      toast.success(t('ai.saved'))
      setApiKey('')
      // Сохранили — возвращаемся к карточке, иначе форма остаётся открытой
      // и выглядит так, будто ничего не применилось.
      setChangingCustom(false)
      qc.invalidateQueries({ queryKey: ['ai-config', projectId] })
    },
    onError: onErr,
  })

  /**
   * Поведение агента: раньше жило в настройках проекта и сохранялось общей
   * кнопкой формы. Здесь общей кнопки нет, поэтому у полей своё сохранение —
   * иначе они бы молча ничего не делали.
   */
  const projQ = useQuery({
    queryKey: ['project-ai-behavior', projectId],
    queryFn: () => api<{ aiConfig: AiConfig | null; chatRules: string | null }>(`/api/v1/projects/${projectId}`),
  })
  const [behavior, setBehavior] = useState<{ aiConfig: AiConfig; chatRules: string } | null>(null)
  // Заполняем один раз пришедшими данными и больше не трогаем: иначе правка
  // затиралась бы ответом фонового перезапроса прямо под руками.
  useEffect(() => {
    const p = projQ.data
    if (!p) return
    setBehavior((cur) => cur ?? { aiConfig: { ...DEFAULT_AI_CONFIG, ...(p.aiConfig ?? {}) }, chatRules: p.chatRules ?? '' })
  }, [projQ.data])

  const saveBehavior = useMutation({
    mutationFn: () =>
      api(`/api/v1/projects/${projectId}`, {
        method: 'PATCH',
        body: JSON.stringify({ aiConfig: behavior?.aiConfig, chatRules: behavior?.chatRules ?? '' }),
      }),
    onSuccess: () => {
      toast.success(t('ai.saved'))
      qc.invalidateQueries({ queryKey: ['project-ai-behavior', projectId] })
      qc.invalidateQueries({ queryKey: ['projects'] })
    },
    onError: onErr,
  })

  return (
    <div className="page-w space-y-8 p-6">
      <PageHeader icon={<Bot className="size-5" />} title={t('ai.title')} subtitle={t('ai.subtitle')} />

      <nav className="flex gap-1 border-b">
        {AI_TABS.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => goTab(key)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm transition-colors',
              tab === key ? 'border-brand font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t(`ai.tabs.${key}`)}
          </button>
        ))}
      </nav>

      {tab === 'settings' && (
      <>
      {/* Источник ИИ */}
      <section className="space-y-4 rounded-xl border bg-card p-4">
        <h2 className="text-sm font-semibold">{t('ai.source')}</h2>
        <div className="grid gap-2 sm:grid-cols-3">
          {(['company', 'trial', 'custom'] as const).map((s) => {
            const disabled = s === 'trial' && !cfg?.trialAvailable
            const picked = source === s
            const active = cfg?.activeSource === s
            return (
              <button
                key={s}
                disabled={!isAdmin || disabled}
                onClick={() => setSource(s)}
                className={cn(
                  'rounded-lg border p-3 text-start text-sm transition-colors disabled:opacity-50',
                  // Подсветка — у того, кто работает: это ответ на вопрос
                  // «какой ИИ сейчас обслуживает проект».
                  picked ? 'border-brand bg-accent' : 'hover:bg-secondary',
                )}
              >
                <div className="flex flex-wrap items-center gap-2 font-medium">
                  {t(`ai.sourceOpt.${s}.label`)}
                  {active && (
                    <span className="rounded-full bg-brand/15 px-2 py-0.5 text-[10px] font-semibold text-brand-ink">
                      {t('ai.activeNow')}
                    </span>
                  )}

                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">{t(`ai.sourceOpt.${s}.hint`)}</div>
              </button>
            )
          })}
        </div>

        {/* Пробный бюджет */}
        {(source === 'trial' || cfg?.activeSource === 'trial') && cfg && (
          <div>
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className="text-muted-foreground">{t('ai.trialUsed', { spent: fmtUsd(cfg.spentUsd), budget: fmtUsd(cfg.trialBudget) })}</span>
              <span className={cn('tabular-nums', trialPct > 90 && 'text-destructive')}>{trialPct.toFixed(0)}%</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
              <div className={cn('h-full transition-all', trialPct > 90 ? 'bg-destructive' : 'bg-brand')} style={{ width: `${trialPct}%` }} />
            </div>
            {trialPct >= 100 && <p className="mt-1 text-xs text-destructive">{t('ai.trialExhausted')}</p>}
          </div>
        )}

        {/* Свой агент — уже настроен: карточка, а не форма.
            Ключ сохранён и на экране его нет; разворачивать все поля ради
            смены модели значит требовать заполнить заново то, что менять не
            просили. */}
        {source === 'custom' && cfg?.hasKey && !changingCustom && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-2 rounded-lg border bg-card px-3 py-2.5 text-sm">
            <Check className="size-4 shrink-0 text-brand-ink" />
            <span className="font-medium">{cfg.providers.find((p) => p.id === provider)?.label}</span>
            <span className="text-muted-foreground">·</span>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={!isAdmin}
              placeholder={cfg.providers.find((p) => p.id === provider)?.defaultModel}
              className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs disabled:border-transparent disabled:bg-transparent"
            />
            {isAdmin && (
              <div className="ms-auto flex shrink-0 items-center gap-1">
                <Button variant="brand" size="sm" onClick={() => saveCfg.mutate()} disabled={saveCfg.isPending}>
                  {t('llm.apply')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    // Новый провайдер — новый ключ и новая модель.
                    setModel('')
                    setApiKey('')
                    setChangingCustom(true)
                  }}
                >
                  {t('llm.changeProvider')}
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Свой агент — форма: пока ключа нет либо провайдера меняют. */}
        {source === 'custom' && cfg && (!cfg.hasKey || changingCustom) && (
          <div className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">{t('ai.provider')}</span>
              <Select value={provider} onValueChange={setProvider} disabled={!isAdmin}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {cfg.providers.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">{t('ai.model')}</span>
              <input value={model} onChange={(e) => setModel(e.target.value)} disabled={!isAdmin} placeholder={cfg.providers.find((p) => p.id === provider)?.defaultModel} className="h-9 w-full rounded-md border bg-background px-3 text-sm" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">{t('ai.apiKey')}</span>
              <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} disabled={!isAdmin} placeholder={cfg.hasKey ? t('ai.keyKeep') : ''} className="h-9 w-full rounded-md border bg-background px-3 text-sm" />
            </label>
            <p className="text-xs text-muted-foreground">{t('ai.keyNote')}</p>
          </div>
        )}

        {/* Общая кнопка не нужна, когда показана карточка: у неё своя
            «Применить», и две кнопки сохранения рядом только путают. */}
        {isAdmin && !(source === 'custom' && cfg?.hasKey && !changingCustom) && (
          <div className="flex gap-2">
            <Button variant="brand" onClick={() => saveCfg.mutate()} disabled={saveCfg.isPending}>
              {t('ai.save')}
            </Button>
            {changingCustom && (
              <Button
                variant="outline"
                onClick={() => {
                  setChangingCustom(false)
                  setProvider(cfg?.provider || cfg?.providers[0]?.id || '')
                  setModel(cfg?.model ?? '')
                  setApiKey('')
                }}
              >
                {t('common.cancel')}
              </Button>
            )}
          </div>
        )}
      </section>

      {/* Поведение агента и правила — переехали из настроек проекта: всё про
          ИИ должно жить в одном месте, а не тремя экранами врозь. */}
      {behavior && (
        <section className="space-y-4 rounded-xl border bg-card p-4">
          <h2 className="text-sm font-semibold">{t('ai.behavior')}</h2>
          <AiBehaviorFields
            value={behavior.aiConfig}
            onChange={(v) => setBehavior({ ...behavior, aiConfig: v })}
            chatRules={behavior.chatRules}
            onRulesChange={(v) => setBehavior({ ...behavior, chatRules: v })}
          />
          {isAdmin && (
            <div className="flex justify-end">
              <Button variant="brand" onClick={() => saveBehavior.mutate()} disabled={saveBehavior.isPending}>
                {t('ai.save')}
              </Button>
            </div>
          )}
        </section>
      )}
      </>
      )}

      {tab === 'usage' && (
      <>
      {/* Использование по моделям */}
      <section className="space-y-3 rounded-xl border bg-card p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Cpu className="size-4" />
          {t('ai.usage')}
          <span className="ms-auto text-xs font-normal text-muted-foreground">{t('ai.totalSpent', { total: fmtUsd(usageQ.data?.spentUsd ?? 0) })}</span>
        </h2>
        {(usageQ.data?.byModel.length ?? 0) === 0 ? (
          <p className="text-xs text-muted-foreground">{t('ai.noUsage')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="px-2 py-1.5 text-start">{t('ai.model')}</th>
                  <th className="px-2 py-1.5 text-start">{t('ai.sourceCol')}</th>
                  <th className="px-2 py-1.5 text-end">{t('ai.calls')}</th>
                  <th className="px-2 py-1.5 text-end">{t('ai.tokensIn')}</th>
                  <th className="px-2 py-1.5 text-end">{t('ai.tokensOut')}</th>
                  <th className="px-2 py-1.5 text-end">{t('ai.cost')}</th>
                </tr>
              </thead>
              <tbody>
                {usageQ.data!.byModel.map((r, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="px-2 py-1.5 font-mono text-xs">{r.model}</td>
                    <td className="px-2 py-1.5 text-xs text-muted-foreground">{t(`ai.sourceOpt.${r.source}.label`)}</td>
                    <td className="px-2 py-1.5 text-end tabular-nums">{r.calls}</td>
                    <td className="px-2 py-1.5 text-end tabular-nums">{fmtTok(r.tokensIn)}</td>
                    <td className="px-2 py-1.5 text-end tabular-nums">{fmtTok(r.tokensOut)}</td>
                    <td className="px-2 py-1.5 text-end tabular-nums">{r.costUsd === null ? t('ai.noPrice') : fmtUsd(r.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Прайсинг моделей */}
      {isAdmin && <PricingEditor projectId={projectId} rows={priceQ.data ?? []} onSaved={() => { qc.invalidateQueries({ queryKey: ['ai-pricing', projectId] }); qc.invalidateQueries({ queryKey: ['ai-usage', projectId] }) }} />}

      {/* Лог вызовов */}
      <section className="space-y-3 rounded-xl border bg-card p-4">
        <h2 className="text-sm font-semibold">{t('ai.log')}</h2>
        {(logQ.data?.length ?? 0) === 0 ? (
          <p className="text-xs text-muted-foreground">{t('ai.noUsage')}</p>
        ) : (
          <ul className="space-y-1 text-xs">
            {logQ.data!.map((r) => (
              <li key={r.id} className="flex items-center gap-2 border-b py-1 last:border-0">
                <span className="text-muted-foreground">{new Date(r.createdAt).toLocaleString(i18n.language)}</span>
                <span className="font-mono">{r.model}</span>
                {r.feature && <span className="rounded bg-secondary px-1">{r.feature}</span>}
                <span className="ms-auto tabular-nums text-muted-foreground">↓{fmtTok(r.tokensIn)} ↑{fmtTok(r.tokensOut)}</span>
                <span className="tabular-nums">{r.costUsd === null ? '—' : fmtUsd(r.costUsd)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      </>
      )}
    </div>
  )
}

function PricingEditor({ projectId, rows, onSaved }: { projectId: string; rows: PriceRow[]; onSaved: () => void }) {
  const { t } = useTranslation()
  const onErr = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e))
  const save = useMutation({
    mutationFn: (b: { model: string; inputPerM: number | null; outputPerM: number | null }) =>
      api('/api/v1/ai/pricing', { method: 'PUT', body: JSON.stringify(b) }, 'project'),
    onSuccess: onSaved,
    onError: onErr,
  })

  return (
    <section className="space-y-3 rounded-xl border bg-card p-4">
      <h2 className="text-sm font-semibold">{t('ai.pricing')}</h2>
      <p className="text-xs text-muted-foreground">{t('ai.pricingHint')}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-xs text-muted-foreground">
              <th className="px-2 py-1.5 text-start">{t('ai.model')}</th>
              <th className="px-2 py-1.5 text-end">{t('ai.inputPerM')}</th>
              <th className="px-2 py-1.5 text-end">{t('ai.outputPerM')}</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <PriceRowEditor key={r.model} row={r} onSave={(inp, out) => save.mutate({ model: r.model, inputPerM: inp, outputPerM: out })} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function PriceRowEditor({ row, onSave }: { row: PriceRow; onSave: (inp: number | null, out: number | null) => void }) {
  const { t } = useTranslation()
  const [inp, setInp] = useState(row.inputPerM?.toString() ?? '')
  const [out, setOut] = useState(row.outputPerM?.toString() ?? '')
  useEffect(() => {
    setInp(row.inputPerM?.toString() ?? '')
    setOut(row.outputPerM?.toString() ?? '')
  }, [row.inputPerM, row.outputPerM])

  const dirty = inp !== (row.inputPerM?.toString() ?? '') || out !== (row.outputPerM?.toString() ?? '')

  return (
    <tr className="border-b last:border-0">
      <td className="px-2 py-1.5 font-mono text-xs">
        {row.model}
        {row.custom && <span className="ms-1 rounded bg-brand/15 px-1 text-[10px] text-brand-ink">custom</span>}
      </td>
      <td className="px-2 py-1.5 text-end">
        <input value={inp} onChange={(e) => setInp(e.target.value)} placeholder={row.hasDefault ? '' : '—'} className="w-20 rounded border bg-background px-1.5 py-0.5 text-end text-xs" />
      </td>
      <td className="px-2 py-1.5 text-end">
        <input value={out} onChange={(e) => setOut(e.target.value)} placeholder={row.hasDefault ? '' : '—'} className="w-20 rounded border bg-background px-1.5 py-0.5 text-end text-xs" />
      </td>
      <td className="px-1">
        {dirty && (
          <button
            title={t('ai.save')}
            onClick={() => onSave(inp === '' ? null : Number(inp), out === '' ? null : Number(out))}
            className="text-xs text-brand-ink hover:underline"
          >
            {t('ai.save')}
          </button>
        )}
      </td>
    </tr>
  )
}
