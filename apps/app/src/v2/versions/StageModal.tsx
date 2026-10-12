import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { inProject } from '../data'
import { useUi } from '../ui'
import { Icon } from '../Icon'
import { httpStatus, vkeys, type BuildTypeDef, type Row } from './data'
import { platLabel, stageLabel } from './labels'

/**
 * Смена стадии версии. В макете её нет, но без неё раздел только читает:
 * Expo сам доводит версию до «сборка готова», а TestFlight, ревью и магазин
 * отмечает человек. Комментарий обязателен на сервере — он ложится в историю
 * версии, поэтому спрашиваем его здесь же, а не получаем отказ после нажатия.
 */
export function StageModal({ row, buildTypes, onClose }: { row: Row; buildTypes: BuildTypeDef[]; onClose: () => void }) {
  const { t } = useTranslation('v2')
  const { flash } = useUi()
  const qc = useQueryClient()
  const stages = buildTypes.find((b) => b.key === row.buildType)?.stages ?? []
  const cur = stages.findIndex((s) => s.key === row.status)
  const [pick, setPick] = useState<string | null>(stages[cur + 1]?.key ?? null)
  const [comment, setComment] = useState('')
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const move = useMutation({
    mutationFn: () =>
      api(`/api/v1/releases/${row.id}/stage`, { method: 'POST', body: JSON.stringify({ status: pick, comment: comment.trim() }), ...inProject(row.project.id) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: vkeys.all })
      flash(t('versions.stage.done', { label: stageLabel(t, row.buildType, pick!, pick!) }))
      onClose()
    },
    onError: (e) => setErr(httpStatus(e) === 403 ? t('versions.err.rights') : (e as Error).message || t('versions.err.generic')),
  })
  const ready = Boolean(pick) && pick !== row.status && Boolean(comment.trim())

  return (
    <div className="mwrap mwrap-top" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={t('versions.stage.title')}>
        <div className="mh">
          <div style={{ minWidth: 0, flex: 1 }}>
            <h3>{t('versions.stage.title')}</h3>
            <div className="s bidi">
              {[row.appName, row.version, platLabel(row)].filter(Boolean).join(' · ')}
            </div>
          </div>
          <button className="ib" aria-label={t('versions.rq.close')} onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="cbx-l" role="radiogroup" aria-label={t('versions.stage.title')} style={{ maxHeight: 'none' }}>
          {stages.map((s, i) => {
            const sel = pick === s.key
            return (
              <button key={s.key} className={'cbx-o' + (sel ? ' hi' : '')} role="radio" aria-checked={sel} onClick={() => setPick(s.key)}>
                <span className="pipe" aria-hidden="true">
                  <i className={i < cur ? 'done' : i === cur ? 'cur' : ''} />
                </span>
                <span className="cbx-n">{stageLabel(t, row.buildType, s.key, s.label)}</span>
                {i === cur && <small style={{ color: 'var(--ink3)' }}>{t('versions.stage.now')}</small>}
                {sel && <Icon name="check" sm />}
              </button>
            )
          })}
        </div>
        <input
          className="nin bidi"
          value={comment}
          autoFocus
          onChange={(e) => setComment(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && ready && !move.isPending && move.mutate()}
          placeholder={t('versions.stage.comment')}
          aria-label={t('versions.stage.commentAria')}
          maxLength={2000}
        />
        {err && (
          <div className="need" role="alert">
            <Icon name="info" />
            {err}
          </div>
        )}
        <div className="mf">
          <div className="res">{comment.trim() ? '' : t('versions.stage.need')}</div>
          <button className="btn" onClick={onClose}>
            {t('versions.rq.cancel')}
          </button>
          <button className={'btn-acc' + (ready && !move.isPending ? '' : ' dis')} onClick={() => ready && !move.isPending && move.mutate()}>
            {t('versions.stage.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
