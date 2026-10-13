import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { inProject } from '../data'
import { useUi } from '../ui'
import { Icon } from '../Icon'
import { letterOf, personColor, shortProject, timeAgo } from '../util'
import { vkeys, type BuildTypeDef, type Row } from './data'
import { platLabel, stageLabel } from './labels'
import { StageModal } from './StageModal'

type Event = {
  id: string
  status: string
  fromStatus: string | null
  statusLabel: string
  comment: string | null
  actor: { id: string; name: string; avatarUrl: string | null } | null
  createdAt: string
}

/**
 * Карточка версии со своим адресом: /versions/v/<проект>/<id>.
 *
 * В первой версии у версии была своя страница с лентой стадий — кто, когда и
 * с каким комментарием перевёл её дальше. Комментарий к стадии обязателен,
 * а увидеть его в v2 было негде: он уходил в базу и пропадал из виду.
 */
export function ReleaseCard({ row, buildTypes, onClose }: { row: Row; buildTypes: BuildTypeDef[]; onClose: () => void }) {
  const { t, i18n } = useTranslation('v2')
  const { companyId, openTask, flash } = useUi()
  const [stage, setStage] = useState(false)
  const detail = useQuery({
    queryKey: [...vkeys.all, 'detail', row.id],
    queryFn: () => api<{ events: Event[] }>(`/api/v1/releases/${row.id}`, inProject(row.project.id)),
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !stage && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, stage])
  // Публичной ссылки у версии нет — только адрес для своих.
  const copyLink = () => {
    const url = `${window.location.origin}${window.location.pathname}#/c/${companyId}/versions/v/${row.project.id}/${row.id}`
    void navigator.clipboard?.writeText(url).then(() => flash(t('versions.card.copied')), () => flash(url))
  }

  const label = row.step === 0 ? t('versions.st.requested') : stageLabel(t, row.buildType, row.status, row.statusLabel)
  const events = detail.data?.events ?? []
  const when = (iso: string) => new Date(iso).toLocaleString(i18n.language, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

  return (
    <div className="mwrap mwrap-top" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal rc" role="dialog" aria-modal="true" aria-label={`${row.appName ?? ''} ${row.version}`}>
        <div className="mh">
          <div style={{ minWidth: 0, flex: 1 }}>
            <h3>
              <span className="bidi">{row.appName || t('versions.noApp')}</span> <b dir="ltr">{row.version}</b>
            </h3>
            <div className="s bidi">{[shortProject(row.project.name), platLabel(row), row.buildProfile].filter(Boolean).join(' · ')}</div>
          </div>
          <button className="ib" aria-label={t('versions.card.copy')} title={t('versions.card.copy')} onClick={copyLink}>
            <Icon name="link" />
          </button>
          <button className="ib" aria-label={t('versions.rq.close')} onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>

        <div className="rc-stage">
          <span className={'rc-st' + (row.step === 3 ? ' live' : '')}>{label}</span>
          <button className="btn" onClick={() => setStage(true)}>
            {t('versions.card.change')}
          </button>
        </div>

        {(row.buildPageUrl || row.referenceUrl) && (
          <div className="rc-links">
            {row.buildPageUrl && (
              <a className="btn" href={row.buildPageUrl} target="_blank" rel="noreferrer">
                <Icon name="external" sm />
                {t('versions.openExpo')}
              </a>
            )}
            {row.referenceUrl && (
              <a className="btn" href={row.referenceUrl} target="_blank" rel="noreferrer">
                <Icon name="download" sm />
                {t('versions.download')}
              </a>
            )}
          </div>
        )}

        {row.tasks.length > 0 && (
          <div>
            <div className="lbl">{t('versions.card.tasks')}</div>
            <div className="rc-tasks">
              {row.tasks.map((tk) => (
                <button key={tk.id} className="tchip" title={tk.title} onClick={() => openTask(tk.id)}>
                  {tk.number}
                  <span className="bidi">{tk.title}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {row.notes?.trim() && (
          <div>
            <div className="lbl">{t('versions.card.notes')}</div>
            <p className="rc-notes bidi">{row.notes}</p>
          </div>
        )}

        <div>
          <div className="lbl">{t('versions.card.history')}</div>
          {detail.isLoading && <div className="rc-mute">{t('common.loading')}</div>}
          {!detail.isLoading && !events.length && <div className="rc-mute">{t('versions.card.noEvents')}</div>}
          <ol className="rc-tl">
            {events.map((e) => (
              <li key={e.id}>
                <span className="av" style={{ background: personColor(e.actor?.id) }}>
                  {e.actor ? letterOf(e.actor.name) : <Icon name="external" sm />}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div className="rc-tl-h">
                    <b className="bidi">{e.actor?.name ?? t('versions.expo')}</b>
                    <span>
                      {e.fromStatus ? `${stageLabel(t, row.buildType, e.fromStatus, e.fromStatus)} → ` : ''}
                      {stageLabel(t, row.buildType, e.status, e.statusLabel)}
                    </span>
                    <time title={when(e.createdAt)}>{timeAgo(i18n.language, e.createdAt)}</time>
                  </div>
                  {e.comment && <p className="bidi">{e.comment}</p>}
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
      {stage && <StageModal row={row} buildTypes={buildTypes} onClose={() => setStage(false)} />}
    </div>
  )
}
