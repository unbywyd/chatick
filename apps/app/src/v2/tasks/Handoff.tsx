import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { errorCode, keys, useHandoff, useMe, useTask, type HandoffAction, type Person, type TaskFull } from '../data'
import { useUi } from '../ui'
import { Icon } from '../Icon'
import { fuzzyMatch } from '../ui/Floating'
import { letterOf, personColor } from '../util'

type Act = HandoffAction | 'other'
const NEED: ReadonlySet<Act> = new Set(['review', 'return', 'ask', 'answer', 'cancel'])

/** Какие ходы предложить вкладками — как в макете: главный первым. */
function actsFor(task: TaskFull['task'], myId: string): Act[] {
  if (task.holder?.id !== myId) return ['other']
  if (task.ball.waitingClientSince) return ['other', 'ask']
  if (task.ball.move === 'review') return ['return', 'other', 'ask']
  if (task.ball.move === 'answer') return ['answer', 'other', 'ask']
  return ['review', 'other', 'ask']
}

/**
 * Окно передачи мяча. Кому — угаданный получатель сверху, ниже команда
 * проекта; записка обязательна там, где без неё ход бессмыслен (проверка,
 * возврат, вопрос, ответ, отмена). Сервер проверит то же самое — здесь мы
 * только не даём отправить заведомо пустое.
 */
export function HandoffDialog() {
  const { t } = useTranslation('v2')
  const { ho, closeHo, flash } = useUi()
  const me = useMe()
  const full = useTask(ho?.taskId ?? null)
  const qc = useQueryClient()
  const handoff = useHandoff()
  const [act, setAct] = useState<Act>(ho?.action ?? 'other')
  const [person, setPerson] = useState<string | null>(ho?.to ?? null)
  const [q, setQ] = useState('')
  const [note, setNote] = useState('')
  const [touched, setTouched] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ta = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeHo()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeHo])

  const data = full.data
  const myId = me.data?.id
  if (!ho || !data || !myId) return null
  const task = data.task
  const fixedOnly = act === 'cancel' || act === 'reopen'
  let list: Act[] = fixedOnly ? [act] : actsFor(task, myId)
  if (!list.includes(act)) list = [act, ...list]

  const notMe = (p: Person | null) => (p && p.id !== myId ? p : null)
  const guess: Person | null =
    act === 'review'
      ? notMe(task.owner)
      : act === 'ask'
        ? (notMe(task.owner) ?? null)
        : act === 'return'
          ? notMe(task.returnTo)
          : act === 'answer'
            ? (task.askFrom ?? task.owner)
            : act === 'reopen'
              ? task.holder
              : null
  const fixed = act === 'return' || act === 'answer' || act === 'cancel'
  const to: Person | null = act === 'cancel' ? null : person ? (data.team.find((p) => p.id === person) ?? null) : guess
  const s = q.trim().toLowerCase()
  const team = data.team.filter((p) => p.id !== task.holder?.id && p.id !== guess?.id && fuzzyMatch(p.name, q))
  const nt = note.trim()
  const need = NEED.has(act)
  const missing = need && !nt
  const holderMine = task.holder?.id === myId
  const mvAfter = act === 'review' ? 'review' : act === 'ask' ? 'answer' : act === 'other' ? (holderMine ? task.ball.move : 'do') : 'do'
  const info = t(`ho.${act === 'other' ? 'pass' : act}`, { returnObjects: true }) as [string, string, string]
  const heading =
    act === 'other' && holderMine && task.ball.move === 'review' ? t('ho.passReview') : act === 'other' && holderMine && task.ball.move === 'answer' ? t('ho.forward') : info[0]
  const gsub =
    act === 'review'
      ? task.owner?.id !== myId
        ? t('ho.gsub.owner')
        : t('ho.gsub.reviewer')
      : act === 'return'
        ? t('ho.gsub.handed')
        : act === 'answer'
          ? t('ho.gsub.asked')
          : act === 'ask'
            ? t('ho.gsub.owner')
            : ''
  const name = to ? (to.id === myId ? t('ho.myself') : to.name) : ''
  const cta = (() => {
    if (act === 'cancel') return t('ho.cta.cancel')
    if (act === 'reopen') return t('ho.cta.reopen')
    if (!to) return t('ho.choose')
    if (act === 'other') {
      if (to.id === myId) return t('ho.cta.take')
      if (mvAfter === 'review') return t('ho.cta.passReview', { name })
      if (mvAfter === 'answer') return t('ho.cta.forward', { name })
      return t('ho.cta.pass', { name })
    }
    return t(`ho.cta.${act}`, { name })
  })()
  const blocked = (!to && act !== 'cancel' && act !== 'reopen') || missing || handoff.isPending

  const submit = () => {
    setTouched(true)
    if (blocked || !task.project) return
    const action: HandoffAction = act === 'other' ? 'pass' : act
    handoff.mutate(
      { taskId: task.id, projectId: task.project.id, action, to: act === 'cancel' ? undefined : (to?.id ?? undefined), note: nt || undefined },
      {
        onSuccess: (r) => {
          const round = (r as { ball?: { round?: number } }).ball?.round ?? task.ball.round + 1
          closeHo()
          const key = act === 'other' ? (to?.id === myId ? 'take' : 'pass') : act
          flash(t(`ho.done.${key}`, { name: to?.name ?? '', round: t('round', { n: round }) }))
        },
        onError: (e) => {
          const code = errorCode(e)
          if (code === 'conflict') void qc.invalidateQueries({ queryKey: keys.task(task.id) })
          setError(t(`err.${code}`, { defaultValue: t('err.generic') }))
        },
      },
    )
  }

  return (
    <div className="mwrap" onMouseDown={(e) => e.target === e.currentTarget && closeHo()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={heading}>
        <div className="mh">
          <div style={{ minWidth: 0, flex: 1 }}>
            <h3>{heading}</h3>
            <div className="s">
              <span className="tid">{task.number}</span> <span className="bidi">{task.title}</span>
            </div>
          </div>
          <button className="ib" aria-label={t('ho.close')} onClick={closeHo}>
            <Icon name="close" />
          </button>
        </div>
        {list.length > 1 && (
          <div className="htabs" role="tablist">
            {list.map((k) => (
              <button
                key={k}
                className={k === act ? 'on' : ''}
                role="tab"
                aria-selected={k === act}
                onClick={() => {
                  setAct(k)
                  setPerson(null)
                  setError(null)
                }}
              >
                {k === 'other' && holderMine && task.ball.move !== 'do'
                  ? task.ball.move === 'review'
                    ? t('ho.tabPassReview')
                    : t('ho.tabForward')
                  : (t(`ho.${k === 'other' ? 'pass' : k}`, { returnObjects: true }) as string[])[0]}
              </button>
            ))}
          </div>
        )}
        {act !== 'cancel' && (
          <div>
            <div className="lbl">{t('ho.to')}</div>
            {guess && (
              <button className={'guess' + (!person ? ' sel' : '')} onClick={() => setPerson(null)}>
                <span className="av lg" style={{ background: personColor(guess.id) }}>
                  {letterOf(guess.name)}
                </span>
                <span className="gb">
                  <b className="bidi">{guess.id === myId ? t('ho.myself') : guess.name}</b>
                  {gsub && <small>{gsub}</small>}
                </span>
                {!person && <Icon name="check" />}
              </button>
            )}
            {!fixed && (team.length > 0 || s) && (
              <>
                <label className="psearch">
                  <Icon name="search" sm />
                  <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={guess ? t('ho.teamPh') : t('ho.teamSearch')} aria-label={t('ho.teamSearch')} />
                </label>
                <div className="ppl">
                  {team.slice(0, 8).map((p) => (
                    <button key={p.id} className={'pp' + (person === p.id ? ' sel' : '')} onClick={() => setPerson(p.id)}>
                      <span className="av" style={{ background: personColor(p.id) }}>
                        {letterOf(p.name)}
                      </span>
                      <span className="bidi">{p.id === myId ? t('ho.myself') : p.name}</span>
                    </button>
                  ))}
                  {team.length > 8 && <span className="pmore">{t('ho.more', { n: team.length - 8 })}</span>}
                </div>
              </>
            )}
          </div>
        )}
        <div className="notebox">
          <div className="nrow">
            <span className="lbl" style={{ margin: 0 }}>
              {need ? t('ho.note') : t('ho.noteOpt')}
            </span>
            <span className="nkeys">{t('ho.keys')}</span>
          </div>
          <textarea
            ref={ta}
            autoFocus
            className={'ta sm' + (missing && touched ? ' miss' : '')}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            placeholder={info[1]}
            aria-label={t('ho.note')}
          />
          {missing && touched && (
            <div className="need">
              <Icon name="info" />
              {info[2]}
            </div>
          )}
        </div>
        {to && act !== 'cancel' && (
          <div className="ballline">
            {t('ho.goes')}{' '}
            <span className="ar3">
              <Icon name="arrow" sm />
            </span>
            <span className="av" style={{ background: personColor(to.id) }}>
              {letterOf(to.name)}
            </span>
            <b className="bidi">{name}</b>
            <span className={`mv mv-${mvAfter}`}>
              <i />
              {t(`mv.${mvAfter}`)}
            </span>
          </div>
        )}
        <div className="mf">
          <div className="res" role={error ? 'alert' : undefined} style={error ? { color: 'var(--signal)' } : undefined}>
            {error ?? (!to && act !== 'cancel' && act !== 'reopen' ? t('ho.pick') : missing ? '' : t('ho.seen'))}
          </div>
          <button className="btn" onClick={closeHo}>
            {t('ho.cancelBtn')}
          </button>
          <button className={(act === 'cancel' ? 'btn-hot' : 'btn-acc') + (blocked ? ' dis' : '')} onClick={submit} aria-disabled={blocked}>
            {cta}
          </button>
        </div>
      </div>
    </div>
  )
}
