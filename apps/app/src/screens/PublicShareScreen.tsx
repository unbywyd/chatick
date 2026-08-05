import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Download, FileText, KeyRound, Link2, MessageSquare, NotebookPen } from 'lucide-react'
import { API_URL } from '@/lib/api'
import { Logo } from '@/components/Logo'
import { Avatar } from '@/components/ui/avatar'
import { ProjectBadge } from '@/components/ui/project-badge'

// Публичная страница по ссылке (SPEC §8.34).
//
// Открывается БЕЗ входа, поэтому живёт вне ProjectLayout и не трогает
// project-токен. Показывает ровно один объект и ничего вокруг: это окно в
// одну вещь, а не гостевой доступ в проект.

type Payload = {
  type: 'file' | 'note' | 'resource' | 'message' | 'task'
  project: { name: string; color?: string; logoUrl?: string | null } | null
  file?: { id: string; name: string; mime: string; size: number; createdAt: string }
  note?: { title: string; body: string; type: string; tags: string[]; createdAt: string }
  resource?: { title: string; url: string | null; description: string }
  message?: {
    text: string
    createdAt: string
    author: { name: string; avatarUrl: string | null } | null
    attachments?: { id: string; name: string; mime: string; size: number }[]
  }
  task?: { number: string; title: string; description: string; status: string }
}

export function PublicShareScreen() {
  const { t, i18n } = useTranslation()
  const { slug = '' } = useParams()
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<'gone' | 'failed' | null>(null)

  useEffect(() => {
    const base = API_URL.replace(/\/$/, '')
    fetch(`${base}/s/${encodeURIComponent(slug)}`)
      .then(async (r) => {
        if (r.ok) return setData((await r.json()) as Payload)
        // 404 и 410 — одно и то же для читателя: ссылки больше нет
        setError(r.status === 404 || r.status === 410 ? 'gone' : 'failed')
      })
      .catch(() => setError('failed'))
  }, [slug])

  if (error) {
    return (
      <Shell>
        <p className="text-center text-sm text-muted-foreground">
          {t(error === 'gone' ? 'share.gone' : 'share.failed')}
        </p>
      </Shell>
    )
  }
  if (!data) return <Shell>{null}</Shell>

  const raw = `${API_URL.replace(/\/$/, '')}/s/${encodeURIComponent(slug)}/raw`
  const date = (iso: string) => new Date(iso).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' })

  return (
    <Shell project={data.project}>
      {data.file && (
        <article className="space-y-4">
          <Header icon={<FileText className="size-4" />} title={data.file.name} sub={date(data.file.createdAt)} />

          {/* Смотреть и слушать — прямо здесь: по ссылке приходят посмотреть,
              а скачивать ради этого файл — лишний шаг. */}
          <Preview mime={data.file.mime} url={raw} name={data.file.name} />

          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">{formatSize(data.file.size)}</span>
            <a
              href={raw}
              download={data.file.name}
              className="inline-flex items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-sm font-semibold text-brand-foreground transition-opacity hover:opacity-90"
            >
              <Download className="size-3.5" />
              {t('files.download')}
            </a>
          </div>
        </article>
      )}

      {data.note && (
        <article className="space-y-3">
          <Header icon={<NotebookPen className="size-4" />} title={data.note.title} sub={date(data.note.createdAt)} />
          <div className="msg-md text-sm" dangerouslySetInnerHTML={{ __html: data.note.body }} />
          {data.note.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {data.note.tags.map((tag) => (
                <span key={tag} className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  #{tag}
                </span>
              ))}
            </div>
          )}
        </article>
      )}

      {data.resource && (
        <article className="space-y-3">
          <Header icon={<KeyRound className="size-4" />} title={data.resource.title} />
          {data.resource.url && (
            <a
              href={data.resource.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-brand hover:underline"
            >
              <Link2 className="size-3.5" />
              {data.resource.url}
            </a>
          )}
          {data.resource.description && <p className="text-sm text-muted-foreground">{data.resource.description}</p>}
        </article>
      )}

      {data.message && (
        <article className="space-y-3">
          <div className="flex items-center gap-2">
            <Avatar name={data.message.author?.name ?? 'AI'} src={data.message.author?.avatarUrl ?? null} size={28} />
            <div>
              <p className="text-sm font-medium">{data.message.author?.name ?? 'AI'}</p>
              <p className="text-xs text-muted-foreground">{date(data.message.createdAt)}</p>
            </div>
          </div>
          {/* Сообщение из одной скрепки — это картинка, а не пустота: без
              вложений такая страница выглядела бы сломанной. */}
          {data.message.text.trim() && data.message.text.trim() !== '📎' && (
            <p className="whitespace-pre-wrap text-sm">{stripMentions(data.message.text)}</p>
          )}
          {data.message.attachments?.map((a) => {
            const url = `${API_URL.replace(/\/$/, '')}/s/${encodeURIComponent(slug)}/raw?file=${a.id}`
            return (
              <div key={a.id} className="space-y-2">
                <Preview mime={a.mime} url={url} name={a.name} />
                <a
                  href={url}
                  download={a.name}
                  className="inline-flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm hover:bg-accent"
                >
                  <Download className="size-3.5" />
                  {a.name}
                  <span className="text-xs text-muted-foreground">{formatSize(a.size)}</span>
                </a>
              </div>
            )
          })}
        </article>
      )}

      {data.task && (
        <article className="space-y-3">
          <Header
            icon={<MessageSquare className="size-4" />}
            title={`${data.task.number} ${data.task.title}`}
          />
          {data.task.description && (
            <div className="msg-md text-sm" dangerouslySetInnerHTML={{ __html: data.task.description }} />
          )}
        </article>
      )}
    </Shell>
  )
}

/**
 * Показ содержимого прямо на странице.
 *
 * Картинку, видео, звук и PDF смотрят по ссылке, а не скачивают: заставлять
 * человека сохранять файл ради взгляда — плохой ответ на присланную ссылку.
 * Остальное честно предлагаем скачать: браузер всё равно не покажет.
 */
function Preview({ mime, url, name }: { mime: string; url: string; name: string }) {
  if (mime.startsWith('image/')) {
    return <img src={url} alt={name} className="max-h-[70vh] w-full rounded-lg border object-contain" />
  }
  if (mime.startsWith('video/')) {
    return <video src={url} controls className="max-h-[70vh] w-full rounded-lg border" />
  }
  if (mime.startsWith('audio/')) {
    return <audio src={url} controls className="w-full" />
  }
  if (mime === 'application/pdf') {
    return <iframe src={url} title={name} className="h-[70vh] w-full rounded-lg border" />
  }
  return null
}

/** Обёртка страницы: шапка с логотипом и проектом, из которого пришли. */
function Shell({ children, project }: { children: React.ReactNode; project?: Payload['project'] }) {
  const { t } = useTranslation()
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="flex items-center justify-between border-b px-5 py-3">
        <Logo />
        {project && (
          <span className="flex items-center gap-2 text-sm text-muted-foreground">
            <ProjectBadge name={project.name} color={project.color} logoUrl={project.logoUrl} size={22} />
            {project.name}
          </span>
        )}
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 p-6">{children}</main>
      <footer className="border-t px-5 py-3 text-center text-xs text-muted-foreground">{t('share.footer')}</footer>
    </div>
  )
}

function Header({ icon, title, sub }: { icon: React.ReactNode; title: string; sub?: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-1 text-muted-foreground">{icon}</span>
      <div className="min-w-0">
        <h1 className="break-words text-lg font-bold tracking-tight">{title}</h1>
        {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
      </div>
    </div>
  )
}

/** Разметка упоминаний читателю снаружи не нужна и ничего не значит. */
const stripMentions = (text: string) => text.replace(/@\[([^\]]+)\]\([^)]+\)/g, '@$1')

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
