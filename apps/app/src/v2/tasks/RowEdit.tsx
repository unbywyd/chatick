import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { errorCode, inProject, useHandoff, useRefreshBall, type BallItem, type TaskFull } from '../data'
import { useUi } from '../ui'
import { Icon } from '../Icon'
import { DatePop, fromYmd } from '../ui/Calendar'
import { Floating, fuzzyMatch } from '../ui/Floating'
import { dueDiff, dueText, isImportant, letterOf, moveKey, personColor } from '../util'
import type { useBallActions } from './actions'

/**
 * Правка прямо в строке списка: важность, срок, ход и кому мяч.
 *
 * Срок и важность — обычная правка задачи. Ход и «кому» — через мяч: это не
 * поле, а передача с журналом и уведомлением, поэтому идут теми же ходами,
 * что и кнопки. Право решает сервер; отказ показываем тостом.
 */

type Actions = ReturnType<typeof useBallActions>

function usePatch(i: BallItem) {
  const { t } = useTranslation('v2')
  const { flash } = useUi()
  const refresh = useRefreshBall()
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/api/v1/tasks/${i.id}`, { method: 'PATCH', body: JSON.stringify(body), ...inProject(i.project!.id) }),
    onError: (e) => flash(t(`err.${errorCode(e)}`, { defaultValue: t('err.generic') })),
    onSettled: () => refresh(i.id),
  })
}

/** Флажок важности: «!» горит у важной, у обычной проступает при наведении. */
export function PrioFlag({ item: i }: { item: BallItem }) {
  const { t } = useTranslation('v2')
  const patch = usePatch(i)
  const on = isImportant(i.priority)
  return (
    <button
      className={'flag rflag' + (on ? '' : ' off')}
      title={on ? t('row.unmark') : t('row.mark')}
      aria-label={on ? t('row.unmark') : t('row.mark')}
      aria-pressed={on}
      disabled={!i.project || patch.isPending}
      onClick={() => patch.mutate({ priority: on ? 'normal' : 'high' })}
    >
      !
    </button>
  )
}

const iso = (d: Date) => {
  // Срок — конец выбранного дня по местному времени, как в форме задачи.
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 0)
  return x.toISOString()
}
const ymd = (s: string | null) => {
  if (!s) return ''
  const d = new Date(s)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function DueCell({ item: i }: { item: BallItem }) {
  const { t, i18n } = useTranslation('v2')
  const patch = usePatch(i)
  const [open, setOpen] = useState(false)
  const [btn, setBtn] = useState<HTMLButtonElement | null>(null)
  const n = dueDiff(i.dueDate)
  const set = (d: Date | null) => {
    setOpen(false)
    patch.mutate({ dueDate: d ? iso(d) : null })
  }
  const plus = (days: number) => {
    const d = new Date()
    d.setDate(d.getDate() + days)
    return d
  }
  return (
    <span className="rcell">
      <button
        ref={setBtn}
        className={'due rbtn' + (n !== null && n < 0 ? ' late' : '') + (n === 0 ? ' today' : '')}
        title={t('row.due')}
        aria-expanded={open}
        disabled={!i.project}
        onClick={() => setOpen(!open)}
      >
        {dueText(t, i.dueDate, i18n.language)}
        <small>{n !== null && n < 0 ? t('due.days', { count: -n }) : ''}</small>
      </button>
      <DatePop
        open={open}
        anchor={btn}
        onClose={() => setOpen(false)}
        value={i.dueDate ? ymd(i.dueDate) : null}
        onPick={(v) => set(v ? fromYmd(v) : null)}
        clearable
        quick
      />
    </span>
  )
}

/** Метка хода — она же меню: какие ходы сейчас можно сделать с задачей. */
export function MoveCell({ item: i, a }: { item: BallItem; a: Actions }) {
  const { t } = useTranslation('v2')
  const [open, setOpen] = useState(false)
  const [btn, setBtn] = useState<HTMLButtonElement | null>(null)
  const mk = moveKey(i)
  // Цвет и значок — по смыслу хода: принять зелёный, вернуть оранжевый,
  // проверка синяя, вопрос фиолетовый, клиент — жёлтый. Не гадать по тексту.
  type It = { label: string; run: () => void; k: 'ok' | 'ret' | 'rev' | 'ask' | 'work' | 'pass'; icon: string }
  const items: It[] = []
  if (a.isDo) items.push({ label: t('act.review'), run: a.toReview, k: 'rev', icon: 'send' })
  if (a.isRev) items.push({ label: t('act.accept'), run: a.accept, k: 'ok', icon: 'check' }, { label: t('act.return'), run: a.back, k: 'ret', icon: 'back' })
  if (a.isAns) items.push({ label: t('act.answer'), run: a.answer, k: 'ask', icon: 'ask' })
  if (a.canPassOn) items.push({ label: i.ball.move === 'review' ? t('act.passReview') : t('act.forward'), run: a.pass, k: 'pass', icon: 'arrow' })
  else if (a.open) items.push({ label: t('act.pass'), run: a.pass, k: 'pass', icon: 'arrow' })
  if (a.canAsk) items.push({ label: t('act.ask'), run: a.ask, k: 'ask', icon: 'ask' })
  if (a.canTake) items.push({ label: t('act.take'), run: a.take, k: 'work', icon: 'hand' })
  if (a.canClient) items.push({ label: i.ball.waitingClientSince ? t('act.clientReplied') : t('act.waitClient'), run: a.toggleClient, k: 'work', icon: 'clock' })
  return (
    <div className="mvcell rcell">
      <button ref={setBtn} className={`mv mv-${mk} rbtn`} title={t('row.move')} aria-expanded={open} disabled={!items.length} onClick={() => setOpen(!open)}>
        <i />
        {t(`mv.${mk}`)}
      </button>
      {i.ball.round > 1 && <span className="rnd">{t('round', { n: i.ball.round })}</span>}
      {open && (
        <Floating anchor={btn} onClose={() => setOpen(false)} className="rpop">
          <div role="menu">
            {items.map((it) => (
              <button
                key={it.label}
                className={`gp mvi k-${it.k}`}
                role="menuitem"
                onClick={() => {
                  setOpen(false)
                  it.run()
                }}
              >
                <span className="mvd">
                  <Icon name={it.icon} sm />
                </span>
                <span className="nm">{it.label}</span>
              </button>
            ))}
          </div>
        </Floating>
      )}
    </div>
  )
}

/**
 * Человек в строке — кому мяч. Клик открывает команду проекта: выбранному
 * мяч уходит ходом «передать» (без записки — для записки есть окно передачи).
 */
export function PersonCell({ item: i, label, person, wait }: { item: BallItem; label: string; person: BallItem['owner']; wait: React.ReactNode }) {
  const { t } = useTranslation('v2')
  const { flash } = useUi()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [btn, setBtn] = useState<HTMLButtonElement | null>(null)
  const handoff = useHandoff()
  const team = useQuery({
    queryKey: ['v2', 'task', i.id],
    queryFn: () => api<TaskFull>(`/api/v1/ball/task/${i.id}`),
    enabled: open,
  })
  const list = (team.data?.team ?? []).filter((p) => p.id !== i.holder?.id && fuzzyMatch(p.name, q))
  const pass = (to: { id: string; name: string }) => {
    setOpen(false)
    if (!i.project) return
    handoff.mutate(
      { taskId: i.id, projectId: i.project.id, action: 'pass', to: to.id },
      {
        onSuccess: () => flash(t('ho.done.pass', { name: to.name })),
        onError: (e) => flash(t(`err.${errorCode(e)}`, { defaultValue: t('err.generic') })),
      },
    )
  }
  return (
    <span className="from rcell">
      <button ref={setBtn} className="rperson" title={t('row.who')} aria-expanded={open} disabled={!i.project || i.status === 'done' || i.status === 'cancelled'} onClick={() => setOpen(!open)}>
        <span className="av" style={{ background: personColor(person?.id) }}>
          {letterOf(person?.name)}
        </span>
        <span className="bidi">{label}</span>
      </button>
      {wait}
      {open && (
        <Floating anchor={btn} onClose={() => setOpen(false)} className="rpop wide">
          <div className="hd">{t('row.whoHead')}</div>
          <label className="cbx-s" style={{ margin: '0 4px 6px' }}>
            <Icon name="search" sm />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && list[0] && pass(list[0])}
              placeholder={t('ho.teamSearch')}
              aria-label={t('ho.teamSearch')}
              autoFocus
            />
          </label>
          {!team.data && <div className="cbx-none">{t('common.loading')}</div>}
          {list.map((p) => (
            <button key={p.id} className="gp" onClick={() => pass(p)}>
              <span className="av" style={{ background: personColor(p.id), width: 24, height: 24, fontSize: 11 }}>
                {letterOf(p.name)}
              </span>
              <span className="nm bidi">{p.name}</span>
            </button>
          ))}
          {team.data && !list.length && <div className="cbx-none">{t('tasks.noPerson')}</div>}
        </Floating>
      )}
    </span>
  )
}
