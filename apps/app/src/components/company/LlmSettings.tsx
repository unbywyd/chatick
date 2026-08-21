import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { BrainCircuit, Check, ChevronDown, Loader2, Pencil, Trash2 } from 'lucide-react'
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
   * Что именно правят прямо сейчас.
   *
   * Раньше форма со всеми полями висела всегда, и по ней читалось, будто
   * сменить модель можно только заполнив заново и её, и ключ — которого на
   * экране нет и никогда не будет. Теперь по умолчанию видно только
   * состояние, а поля появляются под конкретное действие.
   */
  const [editingModel, setEditingModel] = useState(false)
  const [changing, setChanging] = useState(false)

  const saveVision = useMutation({
    mutationFn: (v: boolean) =>
      api(`/api/v1/companies/${companyId}/llm/vision`, { method: 'PATCH', body: JSON.stringify({ vision: v }) }),
    // Тот же ключ, что у запроса статуса: с чужим ключом карточка оставалась
    // со старым значением, пока страницу не обновят.
    onSuccess: () => qc.invalidateQueries({ queryKey: ['company-llm', companyId] }),
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
      setEditingModel(false)
      setChanging(false)
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

  /** Вернуть поля к сохранённому и закрыть правку. */
  const resetEdit = () => {
    setEditingModel(false)
    setChanging(false)
    setModel(status.data?.model ?? '')
    setApiKey('')
  }

  if (status.isLoading) return <p className="text-sm text-muted-foreground">…</p>

  const connected = Boolean(status.data?.configured)
  const showForm = isAdmin && (!connected || changing)

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

      {/* Подключено — тонкая карточка состояния, а не развёрнутая форма. */}
      {connected && !changing && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2 rounded-lg border bg-card px-3 py-2.5 text-sm">
          <Check className="size-4 shrink-0 text-brand-ink" />
          <span className="font-medium">{status.data!.providers.find((p) => p.id === status.data!.provider)?.label}</span>

          {editingModel ? (
            /* Смена модели прямо здесь: это единственное, что правят часто, и
               разворачивать ради неё всю форму с ключом незачем. */
            <form
              className="flex min-w-0 flex-1 items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                if (!save.isPending) save.mutate()
              }}
            >
              <Input
                autoFocus
                value={model}
                onChange={(e) => setModel(e.target.value)}
                onKeyDown={(e) => {
                  // Escape отменяет правку. Без него выйти из режима можно было
                  // только сохранив — то есть никак.
                  if (e.key === 'Escape') resetEdit()
                }}
                placeholder={selected?.defaultModel ?? ''}
                className="h-8 min-w-0 flex-1 text-xs"
              />
              <Button type="submit" variant="brand" size="sm" disabled={save.isPending}>
                {save.isPending && <Loader2 className="size-3.5 animate-spin" />}
                {save.isPending ? t('llm.testing') : t('llm.apply')}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={resetEdit}>
                {t('common.cancel')}
              </Button>
            </form>
          ) : (
            <>
              <span className="text-muted-foreground">·</span>
              <button
                type="button"
                disabled={!isAdmin}
                title={isAdmin ? t('llm.changeModel') : undefined}
                onClick={() => {
                  setProvider(status.data!.provider)
                  setModel(status.data!.model ?? '')
                  setEditingModel(true)
                }}
                className="inline-flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-muted-foreground transition-colors enabled:hover:bg-accent enabled:hover:text-foreground disabled:cursor-default"
              >
                <span className="truncate">{status.data!.model}</span>
                {isAdmin && <Pencil className="size-3 shrink-0" />}
              </button>

              {isAdmin && (
                <div className="ms-auto flex shrink-0 items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      // Провайдер меняют целиком: у нового свой ключ и своя
                      // модель, и подставлять старые значения было бы враньём.
                      setProvider(status.data!.provider)
                      setModel('')
                      setApiKey('')
                      setChanging(true)
                    }}
                  >
                    {t('llm.changeProvider')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-destructive hover:text-destructive"
                    title={t('llm.disconnect')}
                    onClick={async () => {
                      if (await confirm({ title: t('llm.disconnectConfirm'), destructive: true, confirmLabel: t('llm.disconnect') }))
                        remove.mutate()
                    }}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Распознавание изображений — рядом с подключением, а не внутри формы:
          галочка сохраняется сама и к смене провайдера отношения не имеет. */}
      {connected && isAdmin && !changing && (
        <label className="flex cursor-pointer items-start gap-2 rounded-lg border p-2.5">
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
      )}

      {/* Не подключено и прав нет — сказать прямо, а не показывать пустоту. */}
      {!connected && !isAdmin && (
        <p className="rounded-lg border bg-card px-3 py-2.5 text-sm text-muted-foreground">{t('llm.notConfigured')}</p>
      )}

      {/* Форма — только когда подключения нет или его меняют осознанно. */}
      {showForm && (
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
          <div className="flex justify-end gap-2">
            {changing && (
              <Button type="button" variant="outline" onClick={resetEdit}>
                {t('common.cancel')}
              </Button>
            )}
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
