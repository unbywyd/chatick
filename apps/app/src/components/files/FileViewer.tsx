import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, ExternalLink, Loader2, Share2, X } from 'lucide-react'
import * as XLSX from 'xlsx'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ZoomableImage } from '@/components/ZoomableImage'

export type ViewerFile = { id: string; name: string; mime: string; hasOriginal?: boolean }

// Детекция по mime И расширению (mime бывает octet-stream). Порядок важен: spreadsheet до text.
function kindOf(file: ViewerFile): 'image' | 'video' | 'audio' | 'pdf' | 'sheet' | 'text' | 'office' | 'other' {
  const m = file.mime
  const ext = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ''
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('video/') || ['mp4', 'webm', 'mov', 'mkv', 'avi'].includes(ext)) return 'video'
  if (m.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'].includes(ext)) return 'audio'
  if (m === 'application/pdf' || ext === 'pdf') return 'pdf'
  if (/spreadsheetml|ms-excel/.test(m) || ['xlsx', 'xls', 'csv'].includes(ext)) return 'sheet'
  if (/wordprocessingml|msword|presentationml|ms-powerpoint|opendocument/.test(m) || ['doc', 'docx', 'ppt', 'pptx', 'odt', 'ods', 'odp'].includes(ext))
    return 'office'
  if (m.startsWith('text/') || /json|xml|javascript|csv|markdown/.test(m) || ['txt', 'json', 'xml', 'md', 'log', 'yml', 'yaml', 'ts', 'js', 'css', 'html'].includes(ext))
    return 'text'
  return 'other'
}

// Встроенный просмотрщик: картинки, PDF, таблицы (SheetJS локально), текст, office → Google Viewer
export function FileViewer({
  file,
  onClose,
  onShare,
}: {
  file: ViewerFile
  onClose: () => void
  /** есть право делиться — решает вызывающий */
  onShare?: () => void
}) {
  const { t } = useTranslation()
  const kind = kindOf(file)
  const [url, setUrl] = useState<string | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [sheet, setSheet] = useState<{ names: string[]; html: string } | null>(null)
  const [activeSheet, setActiveSheet] = useState(0)
  const [wb, setWb] = useState<XLSX.WorkBook | null>(null)
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
        const { url } = await api<{ url: string }>(`/api/v1/files/${file.id}/view-url`, {}, 'project')
        if (!alive) return
        setUrl(url)

        if (kind === 'text') {
          const res = await fetch(url)
          if (alive) setText((await res.text()).slice(0, 200_000))
        } else if (kind === 'sheet') {
          // таблицы читаем локально (SheetJS) — приватно, без Google
          const buf = await (await fetch(url)).arrayBuffer()
          const book = XLSX.read(buf, { type: 'array' })
          if (!alive) return
          setWb(book)
          renderSheet(book, 0)
        }
      } catch {
        if (alive) setError(true)
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id])

  const renderSheet = (book: XLSX.WorkBook, idx: number) => {
    const name = book.SheetNames[idx]!
    const html = XLSX.utils.sheet_to_html(book.Sheets[name]!, { editable: false })
    setSheet({ names: book.SheetNames, html })
    setActiveSheet(idx)
  }

  const download = async (original = false) => {
    const { url } = await api<{ url: string }>(`/api/v1/files/${file.id}/download${original ? '?original=1' : ''}`, {}, 'project')
    window.open(url, '_blank')
  }

  const googleViewer = url ? `https://docs.google.com/gview?embedded=1&url=${encodeURIComponent(url)}` : null

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/85 backdrop-blur-sm" onClick={onClose}>
      <header className="flex items-center gap-2 px-4 py-3 text-white" onClick={(e) => e.stopPropagation()}>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{file.name}</span>
        {kind === 'office' && googleViewer && (
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
        {/* Поделиться, а не скачать: ссылку можно переслать, и человек увидит
            превью вместо файла в загрузках. */}
        {onShare && (
          <Button variant="outline" size="sm" className="border-white/20 bg-white/10 text-white hover:bg-white/20" onClick={onShare}>
            <Share2 className="size-3.5" />
            {t('tasks.share')}
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
        ) : kind === 'image' ? (
          <ZoomableImage src={url} alt={file.name} />
        ) : kind === 'video' ? (
          <video src={url} controls autoPlay className="max-h-full max-w-full rounded-lg" />
        ) : kind === 'audio' ? (
          <div className="rounded-xl bg-card p-8">
            <audio src={url} controls autoPlay className="w-80 max-w-full" />
          </div>
        ) : kind === 'pdf' ? (
          <iframe src={url} title={file.name} className="h-full w-full max-w-5xl rounded-lg bg-white" />
        ) : kind === 'sheet' ? (
          sheet ? (
            <div className="flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-lg bg-white text-black">
              {sheet.names.length > 1 && (
                <div className="flex gap-1 overflow-x-auto border-b bg-gray-100 p-1">
                  {sheet.names.map((n, i) => (
                    <button
                      key={n}
                      onClick={() => wb && renderSheet(wb, i)}
                      className={cn('whitespace-nowrap rounded px-2.5 py-1 text-xs', i === activeSheet ? 'bg-white font-semibold shadow' : 'text-gray-600 hover:bg-white/60')}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              )}
              <div className="sheet-view flex-1 overflow-auto p-2" dangerouslySetInnerHTML={{ __html: sheet.html }} />
            </div>
          ) : (
            <Loader2 className="size-6 animate-spin text-white/70" />
          )
        ) : kind === 'text' ? (
          <pre className="h-full w-full max-w-4xl overflow-auto rounded-lg bg-card p-4 font-mono text-xs text-foreground">
            {text ?? <Loader2 className="size-5 animate-spin" />}
          </pre>
        ) : kind === 'office' && googleViewer ? (
          <iframe src={googleViewer} title={file.name} className="h-full w-full max-w-5xl rounded-lg bg-white" />
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
