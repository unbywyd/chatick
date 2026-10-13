import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, getMediaToken, inlineImageUrl } from '@/lib/api'
import { inProject, type CompanyProject } from '../data'
import { useUi } from '../ui'
import { Icon } from '../Icon'
import { ShareItem } from '../ShareTask'
import { shortProject } from '../util'
import { errText, fmtSize } from './shared'

/**
 * Файл библиотеки и его просмотр поверх экрана — общие для «Файлов» и
 * вложений задачи: и там и там те же «скачать», «поделиться», «удалить».
 */

export type FileItem = {
  id: string
  name: string
  mime: string
  size: number
  createdAt: string
  taskId: string | null
  taskNumber: string | null
  messageId: string | null
  uploader: { id: string; name: string } | null
}
export type Row = FileItem & { project: CompanyProject; kind: Kind; src: Src }
export type Kind = 'img' | 'vid' | 'doc' | 'oth'
export type Src = 'chat' | 'task' | 'up'


/** Тип по mime и расширению: у части файлов mime пустой (octet-stream). */
export function kindOf(f: { name: string; mime: string }): Kind {
  const m = f.mime
  const ext = f.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ''
  if (m.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic', 'avif', 'bmp'].includes(ext)) return 'img'
  if (m.startsWith('video/') || ['mp4', 'webm', 'mov', 'mkv', 'avi'].includes(ext)) return 'vid'
  if (/pdf|word|excel|sheet|presentation|document|text|csv/.test(m) || ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'ppt', 'pptx', 'txt', 'md', 'odt'].includes(ext))
    return 'doc'
  return 'oth'
}
export const srcOf = (f: FileItem): Src => (f.messageId ? 'chat' : f.taskId ? 'task' : 'up')

/**
 * Просмотр файла поверх экрана. Картинка — по медиа-токену, видео и PDF —
 * по короткой ссылке сервера (view-url), остальное — скачать.
 */
export function Viewer({ f, onClose, onDeleted }: { f: Row; onClose: () => void; onDeleted?: () => void }) {
  const [sharing, setSharing] = useState(false)
  const { t, i18n } = useTranslation('v2')
  const { openTask, flash, company } = useUi()
  const boss = company.myRole === 'admin' || company.myRole === 'manager'
  const qc = useQueryClient()
  const [url, setUrl] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const pdf = /pdf/.test(f.mime) || /\.pdf$/i.test(f.name)
  const token = getMediaToken()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !sharing && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, sharing])
  useEffect(() => {
    if (f.kind === 'vid' || pdf)
      void api<{ url: string }>(`/api/v1/files/${f.id}/view-url`, inProject(f.project.id))
        .then((r) => setUrl(r.url))
        .catch(() => setUrl(null))
  }, [f, pdf])

  const download = async () => {
    try {
      const r = await api<{ url: string }>(`/api/v1/files/${f.id}/download`, inProject(f.project.id))
      window.open(r.url, '_blank', 'noopener')
    } catch (e) {
      flash(errText(t, e))
    }
  }
  const remove = useMutation({
    mutationFn: () => api(`/api/v1/files/${f.id}`, { method: 'DELETE', ...inProject(f.project.id) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['v2', 'lib', 'files', f.project.id] })
      void qc.invalidateQueries({ queryKey: ['v2', 'lib', 'trash', f.project.id] })
      flash(t('library.files.deleted'))
      onDeleted?.()
      onClose()
    },
    onError: (e) => flash(errText(t, e)),
  })

  return (
    <>
    {sharing && (
      <ShareItem type="file" id={f.id} title={f.name} path={`/files/f/${f.project.id}/${f.id}`} canPublish={boss} onClose={() => setSharing(false)} />
    )}
    <div className="lib-view" role="dialog" aria-modal="true" aria-label={f.name} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="lib-view-bar">
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="lib-view-n bidi">{f.name}</div>
          <div className="lib-view-m">
            {shortProject(f.project.name)} · {fmtSize(f.size, t)}
            {f.uploader ? ` · ${f.uploader.name}` : ''} · {new Date(f.createdAt).toLocaleDateString(i18n.language, { day: 'numeric', month: 'short' })}
          </div>
        </div>
        {f.taskId && (
          <button
            className="mini"
            onClick={() => {
              onClose()
              openTask(f.taskId!)
            }}
          >
            {f.taskNumber ?? t('library.files.task')}
          </button>
        )}
        <button className="mini" onClick={() => setSharing(true)}>
          {t('library.files.share')}
        </button>
        <button className="mini" onClick={() => void download()}>
          {t('library.files.download')}
        </button>
        <button className={'mini' + (confirm ? ' lib-danger' : '')} onClick={() => (confirm ? remove.mutate() : setConfirm(true))} onBlur={() => setConfirm(false)}>
          {confirm ? t('library.files.confirmDelete') : t('library.files.delete')}
        </button>
        <button className="ib" aria-label={t('library.close')} onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div className="lib-view-body" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        {f.kind === 'img' && token && <img src={`${inlineImageUrl(f.id)}?t=${encodeURIComponent(token)}`} alt={f.name} />}
        {f.kind === 'vid' && url && <video src={url} controls autoPlay />}
        {pdf && url && <iframe src={url} title={f.name} />}
        {f.kind !== 'img' && f.kind !== 'vid' && !pdf && (
          <div className="lib-view-none">
            <div>{t('library.files.noPreview')}</div>
            <button className="btn-acc" onClick={() => void download()}>
              {t('library.files.download')}
            </button>
          </div>
        )}
      </div>
    </div>
    </>
  )
}
