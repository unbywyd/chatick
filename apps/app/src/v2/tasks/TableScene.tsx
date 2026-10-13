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
 * Геометрия в единицах сцены (стол — в центре квадрата 600×600). Сцена —
 * безопасная рамка с местами на любое число людей и уменьшена до --z
 * (стили): стол всегда стоит в одной точке и не съедает экран.
 */
const TABLE = 300 // диаметр стола
const TABLE_IMG = Math.round((744 * TABLE) / 442) // слой стола 744, в нём стол 442
const HANDS = TABLE / 2 - 22 // руки героя лежат на бортике
const BOX = 136 // герой вписан в квадрат
const BOX_LEAD = 188 // тот, чей ход, — крупнее остальных
const BALL_R = Math.round((TABLE / 2) * 0.32) // ближе к центру: перед руками — имя
const CHIP = 54 // мяч — «мяч на твоей стороне»
const HIT_R = HANDS + 72
const LABEL_R = HANDS - 26 // имя — на сукне перед руками
const TOP = 270 // угол места держателя: сверху
const PAD = 10 // запас под тени героев; сами поля — у карточки
const RIM = TABLE / 2 + 4 // край стола с бортиком
const MAX_SEATS = 6 // сервер сажает за стол не больше шести

/**
 * Безопасная рамка сцены: места для любого числа людей (2–6) с держателем
 * наверху, каждый герой — во весь свой квадрат. Стол стоит в одной точке и не
 * прыгает ни от задачи к задаче, ни когда мяч переходит к другому.
 */
const SAFE = (() => {
  let [x0, x1, y0, y1] = [-RIM, RIM, -RIM, RIM]
  for (let n = 2; n <= MAX_SEATS; n++)
    for (let j = 0; j < n; j++) {
      const box = j ? BOX : BOX_LEAD
      const a = ((TOP + (j * 360) / n) * Math.PI) / 180
      for (const u of [HANDS, HANDS + box])
        for (const v of [-box / 2, box / 2]) {
          const x = u * Math.cos(a) - v * Math.sin(a)
          const y = u * Math.sin(a) + v * Math.cos(a)
          ;[x0, x1, y0, y1] = [Math.min(x0, x), Math.max(x1, x), Math.min(y0, y), Math.max(y1, y)]
        }
    }
  return { w: Math.ceil(x1 - x0 + 2 * PAD), h: Math.ceil(y1 - y0 + 2 * PAD), cx: Math.round(PAD - x0), cy: Math.round(PAD - y0) }
})()

type Seat = Scene['seats'][number]

/** Герой, вписанный в квадрат: тот, чей ход, — крупнее. */
function heroBox(p: Seat, lead: boolean) {
  const h = heroOf(p)
  const box = lead ? BOX_LEAD : BOX
  const k = Math.min(box / h.w, box / h.h)
  return { slug: h.slug, w: Math.round(h.w * k), h: Math.round(h.h * k) }
}


// Состояние сцены — одним цветом: метка, часы, подсветка за держателем и мяч (table/ball-<состояние>.webp).
const SPOT = { warm: 'rgba(212,243,107,.7)', hot: 'rgba(255,181,71,.55)', burn: 'rgba(255,110,50,.55)', away: 'rgba(255,255,255,.95)', client: 'rgba(255,214,51,.55)' }
const INK = { warm: '#4D7A12', hot: '#855600', burn: '#C2410C', away: '#4E524C', client: '#7A5C00' }

function useTick(on: boolean) {
  const [, set] = useState(0)
  useEffect(() => {
    if (!on) return
    const id = window.setInterval(() => set((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [on])
}

// Стол свёрнут — помним в браузере: мешает сегодня, не значит «убрать навсегда».
const FOLD_KEY = 'chatick_v2_table_folded'
function readFold() {
  try {
    return localStorage.getItem(FOLD_KEY) === '1'
  } catch {
    return false
  }
}
function saveFold(on: boolean) {
  try {
    if (on) localStorage.setItem(FOLD_KEY, '1')
    else localStorage.removeItem(FOLD_KEY)
  } catch {
    /* приватное окно — свернём только до перезагрузки */
  }
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
  const [folded, setFolded] = useState(readFold)
  const fold = () => setFolded((v) => (saveFold(!v), !v))
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
        <span className="sv-sub">{folded ? t('tbl.folded', { mine: mine.length, away: away.length }) : t('tbl.sub')}</span>
        <button className={'sv-fold' + (folded ? '' : ' open')} onClick={fold} aria-expanded={!folded}>
          <Icon name="chevron" sm />
          {folded ? t('tbl.show') : t('tbl.hide')}
        </button>
      </div>
      {!folded && (
        <>
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
        </>
      )}
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
  // Ждём клиента — пауза поверх хода: не «тепло» и не «горит», а своё состояние.
  const tone = client ? 'client' : heat
  useTick(true)

  const n = s.seats.length
  const seatA = (j: number) => TOP + (j * 360) / n
  const hi = Math.max(0, s.seats.findIndex((p) => p.id === s.holder?.id))
  // Поворот всего стола: держатель — наверх. При передаче стол плавно поворачивается.
  const G = useMemo(() => (((TOP - seatA(hi)) % 360) + 540) % 360 - 180, [hi, n]) // eslint-disable-line react-hooks/exhaustive-deps
  const q = (seatA(hi) * Math.PI) / 180
  const { cx, cy } = SAFE
  const leadH = s.seats[hi] ? heroBox(s.seats[hi], true).h : BOX_LEAD

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
    <div className="sv-scene lamp orb tgs" style={{ '--H': INK[tone], '--S': SPOT[tone] } as React.CSSProperties} aria-roledescription="scene" aria-label={s.number}>
      <div className="tg-st" style={{ width: `calc(${SAFE.w}px * var(--z))`, height: `calc(${SAFE.h}px * var(--z))` }}>
        <div className="tg-in" style={{ width: SAFE.w, height: SAFE.h }}>
          <div className="tg-spot" style={{ left: cx - 110, top: Math.round(cy - HANDS - leadH / 2 - 70) }} />
          <div className="tg-grp" style={{ transform: `translate(${cx - 300}px, ${cy - 300}px) rotate(${G}deg)` }}>
            <img className="tg-tab2" src={`${import.meta.env.BASE_URL}table/table.webp`} alt="" style={{ width: TABLE_IMG, height: TABLE_IMG, left: (600 - TABLE_IMG) / 2, top: (600 - TABLE_IMG) / 2 }} />
            {s.seats.map((p, j) => {
              const h = heroBox(p, j === hi)
              return (
                <div key={p.id} className="tg-seat" style={{ transform: `rotate(${seatA(j) - TOP}deg)` }}>
                  <img className="tg-hero2" src={heroSrc(h.slug)} alt="" style={{ width: h.w, height: h.h, bottom: 300 + HANDS }} />
                </div>
              )
            })}
            {/* Мяч лежит на столе, но стоит ровно: стол поворачивается, мяч — обратно, как имена.
                Цвет — состояние: зелёный — тепло, оранжевый — жарко, горящий — горит,
                синий — ход не твой, жёлтый — ждём клиента. */}
            <img
              className={'tg-ball' + (mine ? ` ${tone}` : '')}
              src={`${import.meta.env.BASE_URL}table/ball-${tone}.webp`}
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
      </div>
      <div className="sv-info">
        <div className="sv-meta">
          <span className="ob-tag">{t(`tbl.heat.${tone}`)}</span>
          <span className="tg-clk" title={t('tbl.clockHint')}>
            {clock(s.ball.waitingClientSince ?? s.ball.heldSince)}
          </span>
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
          {a.canPassOn && (
            <button className="btn" onClick={a.pass} title={s.ball.move === 'review' ? t('act.passReview') : t('act.forward')}>
              {t('act.pass')}
            </button>
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
