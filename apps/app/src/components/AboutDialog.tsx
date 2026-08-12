import { createPortal } from 'react-dom'
import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ExternalLink, Mail, Send } from 'lucide-react'
import { api, getSessionToken, type Me } from '@/lib/api'
import { Logo } from '@/components/Logo'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Avatar } from '@/components/ui/avatar'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'

// «О проекте» и форма обратной связи (SPEC §8.35).
//
// Открывается и до входа: вопрос бывает как раз у того, кто ещё не завёл
// аккаунт. Вошедшему поля имени и почты не показываем — они известны, и
// давать их править значит позволить написать от чужого имени.

const TOPICS = ['question', 'bug', 'feature', 'billing', 'other'] as const

export function AboutDialog({ me, onClose }: { me?: Me; onClose: () => void }) {
  const { t } = useTranslation()
  const [writing, setWriting] = useState(false)

  const about = useQuery({
    queryKey: ['about'],
    queryFn: () => api<{ version: string; text: string; website: string }>('/api/v1/about'),
  })

  // Через портал, в body: диалог открывают из меню профиля в сайдбаре, а на
  // сайдбаре стоит transition — он создаёт содержащий блок, и position:fixed
  // внутри отсчитывается от колонки, а не от окна.
  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-6" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl border bg-card p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        {writing ? (
          <FeedbackForm me={me} onDone={onClose} onBack={() => setWriting(false)} />
        ) : (
          <>
            <div className="flex items-center gap-3">
              <Logo />
              <span className="rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground">
                {about.data?.version ?? '…'}
              </span>
            </div>

            {about.data?.text && <p className="mt-4 whitespace-pre-wrap text-sm">{about.data.text}</p>}

            {about.data?.website && (
              <a
                href={about.data.website}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-flex items-center gap-1.5 text-sm text-brand-ink hover:underline"
              >
                <ExternalLink className="size-3.5" />
                {about.data.website.replace(/^https?:\/\//, '')}
              </a>
            )}

            {/* Прямая почта: не всем удобна форма, а адрес работает всегда */}
            <p className="mt-4 text-xs text-muted-foreground">
              <a href="mailto:support@chatick.com" className="hover:text-foreground hover:underline">
                {t('about.supportMail')}
              </a>
            </p>

            <div className="mt-6 flex justify-end gap-2">
              <Button variant="outline" onClick={onClose}>
                {t('files.cancel')}
              </Button>
              <Button variant="brand" onClick={() => setWriting(true)}>
                <Mail className="size-4" />
                {t('about.contactUs')}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}

function FeedbackForm({ me, onDone, onBack }: { me?: Me; onDone: () => void; onBack: () => void }) {
  const { t } = useTranslation()
  const [topic, setTopic] = useState<(typeof TOPICS)[number]>('question')
  const [body, setBody] = useState('')
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  // Приманка для ботов: настоящий человек этого поля не видит и не заполнит.
  const [trap, setTrap] = useState('')

  const signedIn = Boolean(me && getSessionToken())

  const submit = useMutation({
    mutationFn: () =>
      api('/api/v1/about/feedback', {
        method: 'POST',
        body: JSON.stringify({
          topic,
          body,
          // Для вошедшего сервер возьмёт имя и почту из сессии — присланному
          // здесь он всё равно не поверит.
          email: signedIn ? undefined : email,
          name: signedIn ? undefined : name,
          website: trap,
          page: window.location.hash,
        }),
      }),
    onSuccess: () => {
      toast.success(t('about.sent'))
      onDone()
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const valid = body.trim().length >= 10 && (signedIn || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()))

  return (
    <>
      <h2 className="text-base font-bold">{t('about.contactUs')}</h2>

      {/* Кто пишет — видно сразу, чтобы не гадать, с какого адреса уйдёт */}
      {signedIn && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border bg-secondary/50 p-2">
          <Avatar name={me!.name} src={me!.avatarUrl} size={28} />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{me!.name}</p>
            <p className="truncate text-xs text-muted-foreground">{me!.email}</p>
          </div>
        </div>
      )}

      <label className="mt-4 block text-sm font-medium">
        {t('about.topic')}
        <Select value={topic} onValueChange={(v) => setTopic(v as (typeof TOPICS)[number])}>
          <SelectTrigger className="mt-1.5">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TOPICS.map((x) => (
              <SelectItem key={x} value={x}>
                {t(`about.topics.${x}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>

      {!signedIn && (
        <>
          <label className="mt-3 block text-sm font-medium">
            {t('about.yourName')}
            <Input value={name} onChange={(e) => setName(e.target.value)} className="mt-1.5" />
          </label>
          <label className="mt-3 block text-sm font-medium">
            {t('about.yourEmail')}
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="mt-1.5"
            />
          </label>
        </>
      )}

      <label className="mt-3 block text-sm font-medium">
        {t('about.message')}
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={5}
          placeholder={t('about.messagePlaceholder')}
          className="mt-1.5 w-full resize-none rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
      </label>

      {/* Спрятано от людей и от скринридеров, видно только ботам */}
      <input
        type="text"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden
        value={trap}
        onChange={(e) => setTrap(e.target.value)}
        className="pointer-events-none absolute -left-[9999px] size-0 opacity-0"
      />

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" onClick={onBack}>
          {t('connect.back')}
        </Button>
        <Button variant="brand" disabled={!valid || submit.isPending} onClick={() => submit.mutate()}>
          <Send className="size-4" />
          {t('about.send')}
        </Button>
      </div>
    </>
  )
}
