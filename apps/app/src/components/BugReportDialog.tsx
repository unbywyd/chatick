import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Bug, Check, ImagePlus, Loader2, X } from 'lucide-react'
import { API_URL, getSessionToken, type Me } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Avatar } from '@/components/ui/avatar'

// Сообщение об ошибке (SPEC §8.35).
//
// Отдельно от «О проекте»: про баг сообщают в момент, когда он случился, и
// искать его в меню «о нас» никто не станет. Поэтому диалог зовётся из любого
// места, а не прячется на странице про компанию.
//
// Скриншот необязателен, но заметен: один снимок экрана заменяет три письма с
// уточнениями. Вставить можно и из буфера — обычно баг уже сфотографирован
// клавишей Print Screen.

const MAX_SHOT = 8 * 1024 * 1024

export function BugReportDialog({ me, onClose }: { me?: Me; onClose: () => void }) {
  const { t } = useTranslation()
  const [body, setBody] = useState('')
  const [email, setEmail] = useState('')
  const [shot, setShot] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [done, setDone] = useState(false)
  const [trap, setTrap] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const signedIn = Boolean(me && getSessionToken())

  const attach = (file: File | null) => {
    if (!file) return
    if (!file.type.startsWith('image/')) return toast.error(t('bug.notImage'))
    if (file.size > MAX_SHOT) return toast.error(t('bug.tooLarge'))
    setShot(file)
    setPreview(URL.createObjectURL(file))
  }

  const submit = async () => {
    if (body.trim().length < 10) return toast.error(t('bug.tooShort'))
    if (!signedIn && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) return toast.error(t('bug.needEmail'))

    setSending(true)
    try {
      // multipart — только когда есть картинка: пустой файл тоже занимает место
      const form = new FormData()
      form.set('topic', 'bug')
      form.set('body', body.trim())
      form.set('page', location.href)
      form.set('website', trap) // приманка для ботов
      if (!signedIn) form.set('email', email.trim())
      if (shot) form.set('screenshot', shot)

      const token = getSessionToken()
      const r = await fetch(`${API_URL}/api/v1/about/feedback`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: form,
      })
      if (!r.ok) throw new Error(String(r.status))
      setDone(true)
      // Показали «спасибо» и ушли: держать окно после успеха незачем
      setTimeout(onClose, 2200)
    } catch {
      toast.error(t('bug.failed'))
    } finally {
      setSending(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-xl border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        // Скриншот из буфера: баг обычно уже снят Print Screen, и просить
        // сохранить файл на диск ради этого — лишний шаг.
        onPaste={(e) => {
          const img = Array.from(e.clipboardData.files).find((f) => f.type.startsWith('image/'))
          if (img) attach(img)
        }}
      >
        {done ? (
          <div className="grid justify-items-center gap-3 py-8 text-center">
            <span className="grid size-14 place-items-center rounded-full bg-brand/15 text-brand-ink">
              <Check className="size-7" />
            </span>
            <p className="text-sm">{t('bug.sent')}</p>
          </div>
        ) : (
          <>
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <span className="grid size-9 place-items-center rounded-lg bg-secondary text-muted-foreground">
                  <Bug className="size-4" />
                </span>
                <div>
                  <h2 className="text-base font-bold">{t('bug.title')}</h2>
                  <p className="text-xs text-muted-foreground">{t('bug.subtitle')}</p>
                </div>
              </div>
              <Button variant="ghost" size="icon" onClick={onClose}>
                <X className="size-4" />
              </Button>
            </div>

            {/* Кто сообщает — видно сразу: вошедшего не спрашиваем о почте */}
            {signedIn ? (
              <div className="mt-4 flex items-center gap-2 rounded-lg border bg-secondary/50 p-2">
                <Avatar name={me!.name} src={me!.avatarUrl} size={26} />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{me!.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{me!.email}</p>
                </div>
              </div>
            ) : (
              <label className="mt-4 block text-sm font-medium">
                {t('bug.email')}
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="mt-1.5 h-9 w-full rounded-md border bg-transparent px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </label>
            )}

            <label className="mt-3 block text-sm font-medium">
              {t('bug.what')}
              <textarea
                autoFocus
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={4}
                placeholder={t('bug.placeholder')}
                className="mt-1.5 w-full resize-none rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </label>

            {/* Скриншот */}
            <div className="mt-3">
              {preview ? (
                <div className="relative overflow-hidden rounded-lg border">
                  <img src={preview} alt="" className="max-h-48 w-full object-contain bg-black/20" />
                  <button
                    onClick={() => {
                      setShot(null)
                      setPreview(null)
                    }}
                    className="absolute end-2 top-2 cursor-pointer rounded-md bg-black/70 p-1.5 text-white hover:bg-black/90"
                    title={t('files.delete')}
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => fileRef.current?.click()}
                  className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground transition-colors hover:border-brand/50 hover:text-foreground"
                >
                  <ImagePlus className="size-4" />
                  {t('bug.attach')}
                </button>
              )}
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => attach(e.target.files?.[0] ?? null)}
              />
            </div>

            {/* Приманка для ботов: спрятана от людей и скринридеров */}
            <input
              type="text"
              tabIndex={-1}
              autoComplete="off"
              aria-hidden
              value={trap}
              onChange={(e) => setTrap(e.target.value)}
              className="pointer-events-none absolute -left-[9999px] size-0 opacity-0"
            />

            <div className="mt-4 flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">{t('bug.note')}</p>
              <Button variant="brand" disabled={sending} onClick={submit} className="shrink-0">
                {sending ? <Loader2 className="size-4 animate-spin" /> : <Bug className="size-4" />}
                {t('bug.send')}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}
