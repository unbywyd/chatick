import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Check, Copy, Plug, X } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm'

// Интеграция с Expo (EAS): кнопка, инструкция и признак «подключено».
//
// Смысл: разработчик запускает `eas build` и в Chatick не заходит вовсе —
// версия появляется сама, со ссылкой на сборку и на страницу логов. Дальше
// (TestFlight, ревью, магазин) по-прежнему руками: EAS о магазинах не знает.

type State = {
  connected: boolean
  /**
   * Приходило ли от Expo хоть одно событие.
   *
   * connected — это только наша половина: секрет заведён. Вторую половину
   * делают руками в чужой системе (`eas webhook:create`), и знать о ней мы
   * можем единственным способом — постучались к нам или нет.
   */
  live?: boolean
  url?: string
  secret?: string
  lastEventAt?: string | null
}

/**
 * Логотип Expo — официальный путь, а не нарисованный по памяти.
 *
 * Инлайном: внешние картинки в интерфейс не тянем, и логотип должен работать
 * без сети. Одна кривая, viewBox 24×24, красится currentColor — значит
 * подхватывает цвет кнопки и в светлой теме, и в тёмной.
 */
export function ExpoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M0 20.084c.043.53.23 1.063.718 1.778.58.849 1.576 1.315 2.303.567.49-.505 5.794-9.776 8.35-13.29a.761.761 0 0 1 1.248 0c2.556 3.514 7.86 12.785 8.35 13.29.727.748 1.723.282 2.303-.567.57-.835.728-1.42.728-2.046 0-.426-8.26-15.798-9.092-17.078-.8-1.23-1.044-1.498-2.397-1.542h-1.032c-1.353.044-1.597.311-2.398 1.542C8.267 3.991.33 18.758 0 19.77z" />
    </svg>
  )
}

export function ExpoIntegration({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState<'url' | 'secret' | 'cmd' | null>(null)

  const state = useQuery({
    queryKey: ['expo-integration', projectId],
    queryFn: () => api<State>('/api/v1/integrations/expo', {}, 'project'),
  })

  const connect = useMutation({
    mutationFn: () => api<State>('/api/v1/integrations/expo', { method: 'POST' }, 'project'),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['expo-integration', projectId] })
      setOpen(true)
    },
    onError: (e: { message?: string }) => toast.error(e.message || t('common.error')),
  })

  const disconnect = useMutation({
    mutationFn: () => api('/api/v1/integrations/expo', { method: 'DELETE' }, 'project'),
    onSuccess: () => {
      setOpen(false)
      void qc.invalidateQueries({ queryKey: ['expo-integration', projectId] })
    },
    onError: (e: { message?: string }) => toast.error(e.message || t('common.error')),
  })

  const connected = state.data?.connected ?? false
  /**
   * Три состояния вместо двух.
   *
   * Кнопка говорила «Expo подключён» с той секунды, как её нажали, и не меняла
   * показаний никогда: она смотрела на наличие секрета, а не на то, работает
   * ли связь. На живых данных из трёх проектов с интеграцией доходили сборки
   * от одного — остальные семнадцать дней и три дня показывали «подключён»,
   * не получив ни одного события.
   *
   * Теперь «подключён» значит «сборки доходят», а до первой — честное
   * ожидание. Нейтральное, без обвинений: может, вебхук не прописан, а может,
   * просто ещё не собирали.
   */
  const live = state.data?.live ?? false
  const waiting = connected && !live
  const cmd = state.data?.url
    ? `eas webhook:create --event BUILD --url ${state.data.url} --secret ${state.data.secret}`
    : ''

  const copy = async (text: string, what: 'url' | 'secret' | 'cmd') => {
    await navigator.clipboard.writeText(text).catch(() => {})
    setCopied(what)
    setTimeout(() => setCopied(null), 1500)
  }

  if (!canManage && !connected) return null

  return (
    <>
      <button
        onClick={() => (connected ? setOpen(true) : canManage ? connect.mutate() : setOpen(true))}
        disabled={connect.isPending}
        title={waiting ? t('expo.waitingHint') : connected ? t('expo.connectedHint') : t('expo.connectHint')}
        className={cn(
          'inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors',
          // Ярко — только когда сборки реально доходят. Ожидание приглушено:
          // это не ошибка и не успех, а «ещё не проверено делом».
          live
            ? 'border-brand/40 bg-brand/10 text-brand-ink'
            : waiting
              ? 'border-dashed text-muted-foreground hover:bg-accent hover:text-foreground'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground',
        )}
      >
        <ExpoMark className="size-3.5" />
        {waiting ? t('expo.waiting') : connected ? t('expo.connected') : t('expo.connect')}
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setOpen(false)}>
          <div
            className="max-h-[85vh] w-full max-w-xl overflow-y-auto rounded-xl border bg-card p-4 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <ExpoMark className="size-4" />
                {t('expo.title')}
              </h3>
              <button
                onClick={() => setOpen(false)}
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>

            <p className="mb-3 text-sm text-muted-foreground">{t('expo.what')}</p>

            {connected ? (
              <>
                <ol className="mb-4 space-y-3 text-sm">
                  <li>
                    <div className="mb-1 font-medium">{t('expo.step1')}</div>
                    <div className="flex items-center gap-1">
                      <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre rounded bg-secondary px-2 py-1.5 font-mono text-[11px]">
                        {cmd}
                      </code>
                      <button
                        onClick={() => copy(cmd, 'cmd')}
                        title={t('expo.copy')}
                        className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                      >
                        {copied === 'cmd' ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                      </button>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{t('expo.step1Hint')}</p>
                  </li>
                  <li>
                    <div className="font-medium">{t('expo.step2')}</div>
                    <p className="text-xs text-muted-foreground">{t('expo.step2Hint')}</p>
                  </li>
                </ol>

                <div className="mb-4 rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground">
                  {/* Что придёт автоматически, а что нет — говорим прямо, иначе
                      человек будет ждать, что версия сама доедет до магазина. */}
                  {t('expo.scope')}
                </div>

                {/* Пока событий не было, главное на экране — не «когда
                    последнее», а «связь ещё не проверена делом». Команда выше,
                    её и надо выполнить. */}
                {waiting && (
                  <div className="mb-3 rounded-md border border-dashed p-2 text-xs text-muted-foreground">
                    {t('expo.waitingExplain')}
                  </div>
                )}

                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>
                    {state.data?.lastEventAt
                      ? t('expo.lastEvent', { when: new Date(state.data.lastEventAt).toLocaleString() })
                      : t('expo.noEventsYet')}
                  </span>
                  {canManage && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      onClick={async () => {
                        if (await confirm({ title: t('expo.disconnectConfirm'), description: t('expo.disconnectHint'), destructive: true })) {
                          disconnect.mutate()
                        }
                      }}
                    >
                      {t('expo.disconnect')}
                    </Button>
                  )}
                </div>
              </>
            ) : (
              <div className="flex justify-end">
                <Button disabled={connect.isPending} onClick={() => connect.mutate()}>
                  <Plug className="size-3.5" />
                  {t('expo.connect')}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
