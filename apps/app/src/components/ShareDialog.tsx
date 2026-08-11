import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Check, Copy, Globe, Link2, Lock, Trash2, TriangleAlert } from 'lucide-react'
import { api, previewUrl } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// Диалог «Поделиться» — один на все сущности (SPEC §8.34).
//
// Два способа поделиться, и разница между ними существенная:
//
//   внутренняя ссылка — адрес внутри приложения. Откроет тот, у кого есть
//   доступ к проекту; остальным покажут вход. Ничего не публикует.
//
//   публичная ссылка — работает БЕЗ входа, у любого, кто её получил. Поэтому
//   её выдают явно, о последствиях предупреждают, и отозвать можно в один клик.

export type ShareEntity = 'file' | 'document' | 'note' | 'resource' | 'message' | 'task'

type Share = { slug: string; expiresAt: string | null; views: number; createdAt: string }

export function ShareDialog({
  type,
  id,
  title,
  /** внутренний адрес: /c/<companyId>/p/<projectId>/files/<id> и подобные */
  appPath,
  canPublish,
  onClose,
}: {
  type: ShareEntity
  id: string
  title: string
  appPath: string
  /** публиковать наружу могут владелец и админ проекта */
  canPublish: boolean
  onClose: () => void
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [copied, setCopied] = useState<'app' | 'public' | null>(null)

  const shareQ = useQuery({
    queryKey: ['share', type, id],
    queryFn: () => api<{ share: Share | null }>(`/api/v1/shares/${type}/${id}`),
  })
  const share = shareQ.data?.share ?? null

  const publish = useMutation({
    mutationFn: () => api<{ share: Share }>(`/api/v1/shares/${type}/${id}`, { method: 'POST', body: '{}' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['share', type, id] }),
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const revoke = useMutation({
    mutationFn: () => api(`/api/v1/shares/${type}/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success(t('share.revoked'))
      qc.invalidateQueries({ queryKey: ['share', type, id] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  // Ссылка для команды идёт через /link у API, а не прямо в приложение.
  //
  // Адрес приложения хэшевый, а всё после «#» браузер серверу не отправляет —
  // значит, мессенджер, скачивая превью, про проект ничего не узнаёт, и в
  // WhatsApp все ссылки выглядят одинаково: «Chatick, app.chatick.com».
  // /link отдаёт теги с именем и логотипом проекта, а человека тут же
  // переводит на тот же самый адрес в приложении.
  const longUrl = previewUrl(appPath)

  // Короткая ссылка — то же самое, но 19 символов вместо 90: chatick.com/t-AbC12.
  // Длинную такую в чат не пошлёшь, она переносится по строкам и ломается на «#».
  //
  // Доступа она не открывает: адрес назначения тот же, дальше решают права.
  // Публичный доступ — соседняя секция, и путать их нельзя.
  const shortQ = useQuery({
    queryKey: ['short-link', type, id],
    queryFn: () => api<{ url: string | null }>(`/api/v1/shares/short/${type}/${id}`),
    // Код выдаётся один раз и не меняется — перезапрашивать нечего.
    staleTime: Infinity,
    retry: false,
  })
  // Пока код едет — показываем длинную ссылку, а не пустое поле: копировать
  // будет нечего, и человек решит, что диалог сломан.
  const appUrl = shortQ.data?.url ?? longUrl
  // Ссылка ведёт на СТРАНИЦУ, а не на JSON: /s/:slug у API — это данные для
  // неё, и присылать человеку голый ответ сервера было бы издевательством.
  const publicUrl = share ? `${window.location.origin}/#/s/${share.slug}` : ''

  const copy = async (text: string, which: 'app' | 'public') => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(which)
      setTimeout(() => setCopied(null), 1600)
    } catch {
      toast.error(t('composer.clipboardDenied'))
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-6" onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl border bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-base font-bold">{t('share.title')}</h2>
        <p className="mt-0.5 truncate text-sm text-muted-foreground">{title}</p>

        {/* Внутренняя ссылка — обычный путь: ничего не публикует */}
        <section className="mt-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Lock className="size-3.5 text-muted-foreground" />
            {t('share.appLink')}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('share.appLinkHint')}</p>
          <div className="mt-2 flex gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border bg-secondary px-3 py-2 text-xs">{appUrl}</code>
            <Button variant="outline" size="sm" onClick={() => copy(appUrl, 'app')}>
              {copied === 'app' ? <Check className="size-3.5 text-brand" /> : <Copy className="size-3.5" />}
              {copied === 'app' ? t('connect.copied') : t('connect.copy')}
            </Button>
          </div>
        </section>

        {/* Публичная — отдельно и с предупреждением: она работает без входа */}
        <section className="mt-5 rounded-lg border p-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Globe className="size-3.5 text-muted-foreground" />
            {t('share.publicLink')}
          </div>

          {share ? (
            <>
              <div className="mt-2 flex gap-2">
                <code className="min-w-0 flex-1 truncate rounded-md border bg-secondary px-3 py-2 text-xs">
                  {publicUrl}
                </code>
                <Button variant="outline" size="sm" onClick={() => copy(publicUrl, 'public')}>
                  {copied === 'public' ? <Check className="size-3.5 text-brand" /> : <Copy className="size-3.5" />}
                  {copied === 'public' ? t('connect.copied') : t('connect.copy')}
                </Button>
              </div>
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">
                  {t('share.views', { count: share.views })}
                </span>
                {canPublish && (
                  <button
                    onClick={() => revoke.mutate()}
                    disabled={revoke.isPending}
                    className="inline-flex items-center gap-1 text-xs text-destructive hover:underline"
                  >
                    <Trash2 className="size-3" />
                    {t('share.revoke')}
                  </button>
                )}
              </div>
            </>
          ) : (
            <>
              <p className="mt-0.5 flex items-start gap-1.5 text-xs text-muted-foreground">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
                {t('share.publicWarning')}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                disabled={!canPublish || publish.isPending}
                onClick={() => publish.mutate()}
              >
                <Link2 className="size-3.5" />
                {t('share.publish')}
              </Button>
              {!canPublish && <p className="mt-1.5 text-xs text-muted-foreground">{t('share.onlyAdmins')}</p>}
            </>
          )}
        </section>

        <div className={cn('mt-5 flex justify-end')}>
          <Button variant="outline" onClick={onClose}>
            {t('files.cancel')}
          </Button>
        </div>
      </div>
    </div>
  )
}
