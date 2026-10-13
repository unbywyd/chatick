import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { errorCode, useMe, useTable, type Scene } from '../data'
import { useUi } from '../ui'
import { Icon } from '../Icon'
import { ProjectLogo } from '../ProjectLogo'
import { heatOf, shortProject } from '../util'
import { heroOf, heroSrc } from '../heroes'
import { useBallActions } from './actions'
import '../i18n/list'

/*
 * «На столе» — сцена из макета: круглый стол сверху, вокруг в креслах герои
 * людей задачи, мяч лежит перед тем, у кого ход. Держатель мяча —
 * всегда наверху: герои нарисованы лицом к столу, и сверху лицо видно прямо.
 * Клик по герою — передать ему мяч (ход подбирается по смыслу, как в макете).
 *
 * Геометрия в единицах сцены 600×600 (на экране 480: zoom .8).
 */
const TABLE = 300 // диаметр стола
const TABLE_IMG = Math.round((744 * TABLE) / 442) // слой стола 744, в нём стол 442
const HANDS = TABLE / 2 - 22 // руки героя лежат на бортике
const BOX = 136 // герой вписан в квадрат
const BOX_LEAD = 188 // тот, чей ход, — крупнее остальных
const SHIFT = 22 // стол чуть ниже центра: крупному держателю наверху нужно место
const BALL_R = Math.round((TABLE / 2) * 0.46)
const CHIP = 54 // мяч — «мяч на твоей стороне»
const HIT_R = HANDS + 72
const LABEL_R = HANDS - 26 // имя — на сукне перед руками
const TOP = 270 // угол места держателя: сверху

const SPOT = { warm: 'rgba(212,243,107,.7)', hot: 'rgba(255,181,71,.55)', burn: 'rgba(255,110,50,.55)', away: 'rgba(255,255,255,.95)' }
const INK = { warm: '#4D7A12', hot: '#855600', burn: '#C2410C', away: '#4E524C' }

function useTick(on: boolean) {
  const [, set] = useState(0)
  useEffect(() => {
    if (!on) return
    const id = window.setInterval(() => set((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [on])
}

const p2 = (x: number) => String(x).padStart(2, '0')
function clock(since: string | null) {
  if (!since) return '00:00:00'
  const el = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 1000))
  const d = Math.floor(el / 86400)
  return `${d ? `${d}d ` : ''}${p2(Math.floor((el % 86400) / 3600))}:${p2(Math.floor((el % 3600) / 60))}:${p2(el % 60)}`
}

export function TableScenes({ project }: { project: string | null }) {
  const { t } = useTranslation('v2')
  const { companyId } = useUi()
  const table = useTable(companyId)
  const inProj = (s: Scene) => !project || s.project?.id === project
  const mine = (table.data?.mine ?? []).filter(inProj)
  const away = (table.data?.away ?? []).filter(inProj)
  const [side, setSide] = useState<'mine' | 'away'>('mine')
  const [cur, setCur] = useState<string | null>(null)
  const list = side === 'mine' ? mine : away
  // Своё пусто, а чужое есть — показываем чужое, а не пустую вкладку.
  useEffect(() => {
    if (side === 'mine' && !mine.length && away.length) setSide('away')
    if (side === 'away' && !away.length && mine.length) setSide('mine')
  }, [side, mine.length, away.length])
  const scene = list.find((s) => s.id === cur) ?? list[0]
  if (!mine.length && !away.length) return null

  return (
    <section className="sv-hot" aria-label={t('tbl.title')}>
      <div className="sv-h">
        <h2>{t('tbl.title')}</h2>
        <span className="sv-sub">{t('tbl.sub')}</span>
      </div>
      <div className="sv-tabs">
        <div className="seg sv-seg" role="tablist" aria-label={t('tbl.whose')}>
          <button className={(side === 'mine' ? 'on' : '') + (mine.length ? '' : ' dis')} role="tab" aria-selected={side === 'mine'} onClick={() => setSide('mine')}>
            {t('tbl.mine')}
            <span className="n">{mine.length}</span>
          </button>
          <button className={(side === 'away' ? 'on' : '') + (away.length ? '' : ' dis')} role="tab" aria-selected={side === 'away'} onClick={() => setSide('away')}>
            {t('tbl.away')}
            <span className="n">{away.length}</span>
          </button>
        </div>
        {list.length > 1 &&
          list.map((s) => (
            <button key={s.id} className={'sv-tab' + (s.id === scene?.id ? ' on' : '')} aria-pressed={s.id === scene?.id} onClick={() => setCur(s.id)} title={s.title}>
              <i className={side === 'mine' ? heatOf(s.ball.move, s.ball.heldSince) : ''} />
              <span className="m">{s.number}</span>
              <span className="t">{s.title}</span>
            </button>
          ))}
      </div>
      {scene && <SceneView key={scene.id} s={scene} />}
    </section>
  )
}

function SceneView({ s }: { s: Scene }) {
  const { t } = useTranslation('v2')
  const { openTask, openHo, flash } = useUi()
  const qc = useQueryClient()
  const me = useMe()
  const myId = me.data?.id
  const a = useBallActions(s, myId)
  const mine = s.holder?.id === myId
  const client = Boolean(s.ball.waitingClientSince)
  const heat = mine ? heatOf(s.ball.move, s.ball.heldSince) : 'away'
  useTick(true)

  const n = s.seats.length
  const seatA = (j: number) => TOP + (j * 360) / n
  const hi = Math.max(0, s.seats.findIndex((p) => p.id === s.holder?.id))
  // Поворот всего стола: держатель — наверх. При передаче стол плавно поворачивается.
  const G = useMemo(() => (((TOP - seatA(hi)) % 360) + 540) % 360 - 180, [hi, n]) // eslint-disable-line react-hooks/exhaustive-deps
  const q = (seatA(hi) * Math.PI) / 180

  // Ход по клику на героя — как в макете: проверяющий кликает по приславшему —
  // «вернуть», спросивший — «ответить», владелец при работе — «на проверку».
  const pick = (id: string) => {
    let act = 'other'
    if (s.ball.move === 'review') act = id === s.last?.actor?.id ? 'return' : 'ask'
    else if (s.ball.move === 'answer') act = id === s.ball.askFromId ? 'answer' : 'ask'
    else act = id === s.owner?.id ? 'review' : 'other'
    return act !== 'other' && !s.can.includes(act) ? 'other' : act
  }
  const canToss = (id: string) => mine && !client && id !== myId

  const off = useMutation({
    mutationFn: () => api('/api/v1/ball/table', { method: 'POST', body: JSON.stringify({ taskId: s.id, on: false }) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['v2', 'ball'] })
      flash(t('tbl.offDone'))
    },
    onError: (e) => flash(t(`err.${errorCode(e)}`, { defaultValue: t('err.generic') })),
  })

  const doing = t(`tbl.doing.${client ? 'client' : s.ball.move}`)
  const from = s.last?.actor && s.last.actor.id !== myId ? t('tbl.from', { name: s.last.actor.name }) : s.owner?.id === myId ? t('tbl.yourTask') : ''

  return (
    <div className="sv-scene lamp orb tgs" style={{ '--H': INK[heat], '--S': SPOT[heat] } as React.CSSProperties} aria-roledescription="scene" aria-label={s.number}>
      <div className="tg-st">
        <div className="tg-in">
          <div className="tg-spot" style={{ top: SHIFT - 14 }} />
          <div className="tg-grp" style={{ transform: `translateY(${SHIFT}px) rotate(${G}deg)` }}>
            <img className="tg-tab2" src={`${import.meta.env.BASE_URL}table/table.webp`} alt="" style={{ width: TABLE_IMG, height: TABLE_IMG, left: (600 - TABLE_IMG) / 2, top: (600 - TABLE_IMG) / 2 }} />
            {s.seats.map((p, j) => {
              const h = heroOf(p)
              const box = j === hi ? BOX_LEAD : BOX
              const k = Math.min(box / h.w, box / h.h)
              return (
                <div key={p.id} className="tg-seat" style={{ transform: `rotate(${seatA(j) - TOP}deg)` }}>
                  <img className="tg-hero2" src={heroSrc(h.slug)} alt="" style={{ width: Math.round(h.w * k), height: Math.round(h.h * k), bottom: 300 + HANDS }} />
                </div>
              )
            })}
            {/* Мяч лежит на столе, но стоит ровно: стол поворачивается, мяч — обратно, как имена. */}
            <img
              className={'tg-ball' + (mine ? ` ${heat}` : '')}
              src={`${import.meta.env.BASE_URL}table/ball.webp`}
              alt=""
              style={{ left: Math.round(300 + BALL_R * Math.cos(q) - CHIP / 2), top: Math.round(300 + BALL_R * Math.sin(q) - CHIP / 2), rotate: `${-G}deg` }}
            />
            {s.seats.map((p, j) => {
              const r = (seatA(j) * Math.PI) / 180
              const can = canToss(p.id)
              const label = can ? t('tbl.passTo', { name: p.name }) : p.name
              return (
                <div key={p.id}>
                  <div
                    className={'tg-hit' + (can ? ' can' : '')}
                    style={{ left: Math.round(300 + HIT_R * Math.cos(r)), top: Math.round(300 + HIT_R * Math.sin(r)) }}
                    role="button"
                    tabIndex={can ? 0 : -1}
                    aria-label={label}
                    title={label}
                    onClick={() => can && openHo({ taskId: s.id, action: pick(p.id) as never, to: p.id })}
                    onKeyDown={(e) => can && (e.key === 'Enter' || e.key === ' ') && openHo({ taskId: s.id, action: pick(p.id) as never, to: p.id })}
                  />
                  <span
                    className={'tg-lab' + (p.id === s.holder?.id ? ' on' : '')}
                    style={{ left: Math.round(300 + LABEL_R * Math.cos(r)), top: Math.round(300 + LABEL_R * Math.sin(r)), transform: `translate(-50%,-50%) rotate(${-G}deg)` }}
                  >
                    {p.id === myId ? t('tbl.you') : p.name.split(' ')[0]}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
        <div className="tg-clk" title={t('tbl.clockHint')}>
          {clock(s.ball.waitingClientSince ?? s.ball.heldSince)}
        </div>
      </div>
      <div className="sv-info">
        <div className="sv-meta">
          <span className="ob-tag">{t(`tbl.heat.${heat}`)}</span>
          {s.project && <ProjectLogo project={s.project} size="xs" />}
          {s.project && <span className="pn">{shortProject(s.project.name)}</span>}
          <span className="ob-id">{s.number}</span>
        </div>
        <button className="sv-title" onClick={() => openTask(s.id)}>
          {s.title}
        </button>
        <div className="lp-who">
          <b>{mine ? t('tbl.yourMove') : (s.holder?.name ?? t('panel.nobody'))}</b>
          <span>
            {' · '}
            {doing}
            {from && ` · ${from}`}
          </span>
          {s.ball.round > 1 && <span className="rnd">{t('round', { n: s.ball.round })}</span>}
        </div>
        {s.last?.note && <p className="sv-note">“{s.last.note}”</p>}
        <div className="sc-acts">
          {a.isRev && (
            <>
              <button className="btn-acc" onClick={a.accept}>
                <Icon name="check" />
                {t('act.accept')}
              </button>
              <button className="btn" onClick={a.back}>
                {t('act.return')}
              </button>
            </>
          )}
          {a.isDo && (
            <>
              <button className="btn-acc" onClick={a.toReview}>
                {t('act.review')}
              </button>
              <button className="btn" onClick={a.pass}>
                {t('act.pass')}
              </button>
            </>
          )}
          {a.isAns && (
            <button className="btn-acc" onClick={a.answer}>
              {t('act.answer')}
            </button>
          )}
          {a.isClient && (
            <button className="btn" onClick={a.clientReplied}>
              {t('act.clientReplied')}
            </button>
          )}
          {a.canTake && (
            <button className="btn" onClick={a.take}>
              {t('act.take')}
            </button>
          )}
          <button className="lnk2" onClick={() => openTask(s.id)}>
            {t('act.open')}
          </button>
          <button className="lnk2" onClick={() => off.mutate()} disabled={off.isPending}>
            {t('tbl.off')}
          </button>
        </div>
        {mine && !client && n > 1 && <div className="sc-hint">{t('tbl.hint')}</div>}
      </div>
    </div>
  )
}
