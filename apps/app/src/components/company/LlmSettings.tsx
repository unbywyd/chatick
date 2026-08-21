import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { BrainCircuit, Check, ChevronDown, Loader2, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckItem,
} from '@/components/ui/dropdown-menu'

type LlmStatus = {
  configured: boolean
  provider: string | null
  model: string | null
  vision?: boolean
  providers: { id: string; label: string; defaultModel: string }[]
}

// BYO-LLM компании: провайдер + модель + ключ. Ключ шифруется на сервере и не отдаётся обратно.
export function LlmSettings({ companyId, isAdmin }: { companyId: string; isAdmin: boolean }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const [provider, setProvider] = useState<string | null>(null)
  const [model, setModel] = useState('')
  // Вижен: выключен по умолчанию — не всякая модель умеет смотреть картинки.
  const [vision, setVision] = useState(false)

  /**
   * Галочка сохраняется САМА, без кнопки.
   *
   * Через общее сохранение не выходило: оно требует ввести ключ заново, а он
   * уже сохранён и повторно не показывается — кнопка оставалась серой, и
   * переключить галочку было нечем.
   */
  const saveVision = useMutation({
    mutationFn: (v: boolean) =>
      api(`/api/v1/companies/${companyId}/llm/vision`, { method: 'PATCH', body: JSON.stringify({ vision: v }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['llm-status', companyId] }),
    onError: (e) => {
      // Не сохранилось — возвращаем галочку на место, иначе человек уйдёт с
      // экрана в уверенности, что включил.
      setVision((v) => !v)
      toast.error(e instanceof Error ? e.message : String(e))
    },
  })
  const [apiKey, setApiKey] = useState('')

  const status = useQuery({
    queryKey: ['company-llm', companyId],
    queryFn: () => api<LlmStatus>(`/api/v1/companies/${companyId}/llm`),
  })

  // Показываем сохранённое значение, а не «выключено» при каждом заходе:
  // иначе человек видит снятую галочку и думает, что настройка не применилась.
  useEffect(() => {
    if (status.data) setVision(Boolean(status.data.vision))
  }, [status.data])

  const selected = status.data?.providers.find((p) => p.id === (provider ?? status.data?.provider))

  const save = useMutation({
    mutationFn: () =>
      api(`/api/v1/companies/${companyId}/llm`, {
        method: 'PUT',
        // vision шлём всегда: сервер выключает его, если поле не пришло, и
        // сохранение модели молча гасило бы только что включённую галочку.
        body: JSON.stringify({
          provider: provider ?? status.data?.provider,
          model: model || undefined,
          apiKey: apiKey || undefined,
          vision,
        }),
      }),
    onSuccess: () => {
      toast.success(t('llm.saved'))
      setApiKey('')
      qc.invalidateQueries({ queryKey: ['company-llm', companyId] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const remove = useMutation({
    mutationFn: () => api(`/api/v1/companies/${companyId}/llm`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['company-llm', companyId] }),
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  /**
   * Можно ли сохранять — одним условием на кнопку и на отправку формы.
   *
   * Раньше их было два, и они разошлись: кнопку починили, проверку в onSubmit
   * забыли. Кнопка стала активной, форма отправлялась, обработчик молча
   * отказывался сохранять — нажатие без единого следа.
   *
   * Ключ обязателен, только пока его нет: меняя одну модель, человек не должен
   * вводить его заново — мы его даже не показываем.
   */
  const canSave =
    Boolean(provider ?? status.data?.provider) && (Boolean(apiKey) || Boolean(status.data?.configured)) && !save.isPending

  if (status.isLoading) return <p className="text-sm text-muted-foreground">…</p>

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-secondary">
          <BrainCircuit className="size-5 text-brand-ink" />
        </span>
        <div>
          <h2 className="text-base font-bold">{t('llm.title')}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{t('llm.subtitle')}</p>
        </div>
      </div>

      {/* Статус */}
      <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2.5 text-sm">
        {status.data?.configured ? (
          <>
            <Check className="size-4 text-brand-ink" />
            <span>
              {t('llm.configured')}: <b>{status.data.providers.find((p) => p.id === status.data!.provider)?.label}</b>
              {' · '}
              <span className="text-muted-foreground">{status.data.model}</span>
            </span>
            {isAdmin && (
              <Button
                variant="destructive"
                size="icon"
                className="ms-auto"
                title={t('llm.disconnect')}
                onClick={async () => {
                  if (await confirm({ title: t('llm.disconnectConfirm'), destructive: true, confirmLabel: t('llm.disconnect') }))
                    remove.mutate()
                }}
              >
                <Trash2 className="size-4" />
              </Button>
            )}
          </>
        ) : (
          <span className="text-muted-foreground">{t('llm.notConfigured')}</span>
        )}
      </div>

      {/* Форма (admin) */}
      {isAdmin && (
        <form
          className="space-y-3 rounded-lg border p-4"
          onSubmit={(e) => {
            e.preventDefault()
            // Те же условия, что и у кнопки. Разойдись они — кнопка активна, а
            // отправка молча ничего не делает: клик в пустоту без ошибки.
            if (canSave) save.mutate()
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <p className="mb-1 text-xs text-muted-foreground">{t('llm.provider')}</p>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="w-full justify-between">
                    {selected?.label ?? t('llm.choose')}
                    <ChevronDown className="size-3.5 text-muted-foreground" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-56">
                  {status.data?.providers.map((p) => (
                    <DropdownMenuCheckItem
                      key={p.id}
                      checked={p.id === (provider ?? status.data?.provider)}
                      onSelect={() => {
                        setProvider(p.id)
                        setModel('')
                      }}
                    >
                      {p.label}
                    </DropdownMenuCheckItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div>
              <p className="mb-1 text-xs text-muted-foreground">{t('llm.model')}</p>
              <Input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={selected?.defaultModel ?? ''}
                className="h-8 text-xs"
              />
            </div>
          </div>
          {/* Распознавание изображений.
              Выключено по умолчанию намеренно: модель, которая не умеет
              смотреть картинки, отвечает ошибкой на ВЕСЬ запрос — человек
              получит «не получилось» вместо ответа и не поймёт, при чём тут
              скриншот. Включать должен тот, кто знает свою модель. */}
          <label className="flex cursor-pointer items-start gap-2 rounded-md border p-2.5">
            <input
              type="checkbox"
              checked={vision}
              onChange={(e) => {
                setVision(e.target.checked)
                saveVision.mutate(e.target.checked)
              }}
              disabled={saveVision.isPending}
              className="mt-0.5 size-3.5 shrink-0"
            />
            <span className="min-w-0">
              <span className="block text-xs font-medium">{t('llm.vision')}</span>
              <span className="block text-[11px] leading-snug text-muted-foreground">{t('llm.visionHint')}</span>
            </span>
          </label>

          <div>
            <p className="mb-1 text-xs text-muted-foreground">{t('llm.apiKey')}</p>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={status.data?.configured ? t('llm.keyKeep') : 'sk-…'}
              autoComplete="off"
            />
            <p className="mt-1 text-xs text-muted-foreground">{t('llm.keyNote')}</p>
          </div>
          <div className="flex justify-end">
            <Button variant="brand" type="submit" disabled={!canSave}>
              {save.isPending && <Loader2 className="size-3.5 animate-spin" />}
              {save.isPending ? t('llm.testing') : t('llm.saveTest')}
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}
