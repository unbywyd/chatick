import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, ExternalLink, Loader2, X } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'

export type ViewerFile = { id: string; name: string; mime: string; hasOriginal?: boolean }

const isImage = (m: string) => m.startsWith('image/')
const isPdf = (m: string) => m === 'application/pdf'
const isText = (m: string) => m.startsWith('text/') || /json|xml|javascript|typescript|csv|markdown/.test(m)
// office-форматы просматриваем через Google Docs Viewer (нужен публичный presigned inline URL)
const isOffice = (m: string) =>
  /(msword|wordprocessingml|ms-excel|spreadsheetml|ms-powerpoint|presentationml|opendocument)/.test(m)

// Встроенный просмотрщик файлов: картинки, PDF (iframe), текст (inline), office → Google Viewer
export function FileViewer({ file, onClose }: { file: ViewerFile; onClose: () => void }) {
  const { t } = useTranslation()
  const [url, setUrl] = useState<string | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        // прокси-URL на нашем домене — работает в iframe/img/Google без CORS/CSP-проблем R2
        const { url } = await api<{ url: string }>(`/api/v1/files/${file.id}/view-url`, {}, 'project')
        if (!alive) return
        setUrl(url)
        if (isText(file.mime)) {
          const res = await fetch(url)
          const body = await res.text()
          if (alive) setText(body.slice(0, 200_000))
        }
      } catch {
        if (alive) setError(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [file.id, file.mime])

  const download = async (original = false) => {
    const { url } = await api<{ url: string }>(`/api/v1/files/${file.id}/download${original ? '?original=1' : ''}`, {}, 'project')
    window.open(url, '_blank')
  }

  const googleViewer = url ? `https://docs.google.com/gview?embedded=1&url=${encodeURIComponent(url)}` : null

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/85 backdrop-blur-sm" onClick={onClose}>
      <header className="flex items-center gap-2 px-4 py-3 text-white" onClick={(e) => e.stopPropagation()}>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{file.name}</span>
        {isOffice(file.mime) && googleViewer && (
          <Button variant="outline" size="sm" className="border-white/20 bg-white/10 text-white hover:bg-white/20" onClick={() => window.open(googleViewer, '_blank')}>
            <ExternalLink className="size-3.5" />
            {t('viewer.google')}
          </Button>
        )}
        {file.hasOriginal && (
          <Button variant="outline" size="sm" className="border-white/20 bg-white/10 text-white hover:bg-white/20" onClick={() => download(true)}>
            {t('viewer.original')}
          </Button>
        )}
        <Button variant="outline" size="sm" className="border-white/20 bg-white/10 text-white hover:bg-white/20" onClick={() => download(false)}>
          <Download className="size-3.5" />
          {t('files.download')}
        </Button>
        <Button variant="ghost" size="icon" className="text-white hover:bg-white/10" onClick={onClose}>
          <X className="size-5" />
        </Button>
      </header>

      <div className="flex flex-1 items-center justify-center overflow-hidden p-4" onClick={(e) => e.stopPropagation()}>
        {error ? (
          <p className="text-white/70">{t('viewer.failed')}</p>
        ) : !url ? (
          <Loader2 className="size-6 animate-spin text-white/70" />
        ) : isImage(file.mime) ? (
          <img src={url} alt={file.name} className="max-h-full max-w-full rounded-lg object-contain" />
        ) : isPdf(file.mime) ? (
          <iframe src={url} title={file.name} className="h-full w-full max-w-4xl rounded-lg bg-white" />
        ) : isText(file.mime) ? (
          <pre className="h-full w-full max-w-4xl overflow-auto rounded-lg bg-card p-4 font-mono text-xs text-foreground">
            {text ?? <Loader2 className="size-5 animate-spin" />}
          </pre>
        ) : isOffice(file.mime) && googleViewer ? (
          <iframe src={googleViewer} title={file.name} className="h-full w-full max-w-4xl rounded-lg bg-white" />
        ) : (
          <div className="rounded-xl bg-card p-8 text-center">
            <p className="text-sm text-muted-foreground">{t('viewer.noPreview')}</p>
            <Button variant="brand" size="sm" className="mt-3" onClick={() => download(false)}>
              <Download className="size-3.5" />
              {t('files.download')}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
