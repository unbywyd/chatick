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

type State = { connected: boolean; url?: string; secret?: string; lastEventAt?: string | null }

/** Логотип Expo. Инлайном: внешние картинки в интерфейс не тянем. */
export function ExpoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M11.4 8.4c.16-.24.34-.27.48-.27.14 0 .4.03.56.27 1.2 1.63 3.17 4.8 4.63 7.14 0 0 1.15 1.85 1.9 2.9C20.13 16.9 21 15 21 12.9c0-1.4-.5-2.5-1.2-3.7-.7-1.2-3.3-5.3-4.3-6.6C14.4 1.2 13.4.7 12 .7c-1.4 0-2.4.5-3.5 1.9-1 1.3-3.6 5.4-4.3 6.6C3.5 10.4 3 11.5 3 12.9c0 2.1.87 4 2.03 5.54.75-1.05 1.9-2.9 1.9-2.9 1.46-2.34 3.43-5.51 4.47-7.14Z" />
      <path d="M5.03 18.44C6.7 20.6 9.2 22 12 22s5.3-1.4 6.97-3.56c-1.1.6-2.3.9-3.47.9-1.4 0-2.5-.4-3.5-1.3-1 .9-2.1 1.3-3.5 1.3-1.17 0-2.37-.3-3.47-.9Z" />
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
        title={connected ? t('expo.connectedHint') : t('expo.connectHint')}
        className={cn(
          'inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors',
          connected
            ? 'border-brand/40 bg-brand/10 text-brand-ink'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground',
        )}
      >
        <ExpoMark className="size-3.5" />
        {connected ? t('expo.connected') : t('expo.connect')}
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
