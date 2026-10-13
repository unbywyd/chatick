import { useEffect, useState } from 'react'
import { ShareTask } from '../ShareTask'
import { TaskChecklist as ClassicChecklist } from '@/components/tabs/tasks/TaskChecklist'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, setScreenProject } from '@/lib/api'
import { RichEditor } from '@/components/ui/rich-editor'
import { inProject, useMe, useRefreshBall, useTask, type TaskFull } from '../data'
import { useUi } from '../ui'
import { ProjectLogo } from '../ProjectLogo'
import { Icon } from '../Icon'
import { TaskDiscussion, TaskHistory } from '../task/parts'
import { TaskPeers, useTaskPresence } from '../task/presence'
import { useBallActions, useTableToggle } from './actions'
import { dueDiff, dueText, fmtHm, heatOf, letterOf, personColor, projectColor, waitText } from '../util'

type CheckItem = { id: string; text: string; done: boolean }

/**
 * Панель задачи справа поверх главного экрана. Главное в ней — мяч: у кого,
 * какой ход, записка, и кнопки хода. Ниже — поля, описание, чек-лист и лента,
 * где передачи и комментарии идут вперемешку по времени.
 */
export function TaskPanel({ taskId }: { taskId: string }) {
  const { t, i18n } = useTranslation('v2')
  const { closeTask, base } = useUi()
  const navigate = useNavigate()
  const me = useMe()
  const full = useTask(taskId)
  const refresh = useRefreshBall()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.mwrap') && closeTask()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeTask])

  // Открыл задачу — прочитал всё, что о ней было: «новое» гаснет.
  const isNew = full.data?.task.isNew
  useEffect(() => {
    if (!isNew) return
    void api('/api/v1/inbox/read', { method: 'POST', body: JSON.stringify({ entityType: 'task', entityId: taskId }) }).then(() => refresh())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew, taskId])

  const task = full.data?.task
  const [sharing, setSharing] = useState(false)
  const peers = useTaskPresence(taskId, false, me.data?.id)
  return (
    <>
      {sharing && task && <ShareTask taskId={task.id} title={`${task.number} · ${task.title}`} canPublish={Boolean(full.data?.can.edit)} onClose={() => setSharing(false)} />}
      <div className="scrim" onClick={closeTask} />
      <section className="panel" aria-label={t('panel.aria')}>
        <div className="ph">
          {task?.project && (
            <>
              <ProjectLogo project={task.project} />
              <span className="pn bidi">{task.project.name}</span>
            </>
          )}
          <span className="tid">{task?.number}</span>
          <span style={{ flex: 1 }} />
          <TaskPeers users={peers} />
          {task && (
            <button className="ib" aria-label={t('act.share')} title={t('act.share')} onClick={() => setSharing(true)}>
              <Icon name="share" />
            </button>
          )}
          <button className="ib" aria-label={t('panel.full')} onClick={() => navigate(`${base}/task/${taskId}`)}>
            <Icon name="expand" />
          </button>
          <button className="ib" aria-label={t('panel.close')} onClick={closeTask}>
            <Icon name="close" />
          </button>
        </div>
        {!full.data && <div className="pb">{full.isError ? t('common.error') : t('common.loading')}</div>}
        {full.data && me.data && <PanelBody data={full.data} myId={me.data.id} lng={i18n.language} onFull={() => navigate(`${base}/task/${taskId}`)} />}
      </section>
    </>
  )
}

export function PanelBody({ data, myId, lng, onFull }: { data: TaskFull; myId: string; lng: string; onFull?: () => void }) {
  const { t } = useTranslation('v2')
  const task = data.task
  const pid = task.project?.id ?? null
  // Проект «с экрана» для старых виджетов (чек-лист, загрузка картинок).
  // Ставим при отрисовке, а не в эффекте: дочерние компоненты начинают
  // запросы раньше, чем срабатывают эффекты родителя.
  setScreenProject(pid)
  useEffect(() => {
    setScreenProject(pid)
    return () => setScreenProject(null)
  }, [pid])
  const n = dueDiff(task.dueDate)
  return (
    <>
      <div className="pb">
        <h2 className="pt bidi">{task.title}</h2>
        <Ball data={data} myId={myId} lng={lng} />
        <div className="fields">
          <div className="fld">
            <span className="k">{t('panel.owner')}</span>
            <span className="v">
              <span className="av" style={{ background: personColor(task.owner?.id), width: 20, height: 20, fontSize: 10 }}>
                {letterOf(task.owner?.name)}
              </span>
              <span className="bidi">{task.owner?.name ?? '—'}</span>
            </span>
          </div>
          <div className="fld">
            <span className="k">{t('panel.due')}</span>
            <span className="v">
              <span className={'due' + (n !== null && n < 0 ? ' late' : '') + (n === 0 ? ' today' : '')}>{dueText(t, task.dueDate, lng)}</span>
            </span>
          </div>
          <div className="fld">
            <span className="k">{t('panel.estimate')}</span>
            <span className="v">{task.estimateMinutes ? fmtHm(task.estimateMinutes) : '—'}</span>
          </div>
        </div>
        {task.description?.trim() ? (
          <div className="desc">
            <RichEditor value={task.description} onChange={() => {}} mentions={[]} preset="full" readOnly />
          </div>
        ) : (
          <p className="desc" style={{ color: 'var(--ink3)' }}>
            {t('panel.noDesc')}
          </p>
        )}
        <div className="cl-classic">
          <div className="v2chk"><ClassicChecklist taskId={task.id} canEdit={Boolean(data.can.edit)} /></div>
        </div>
        {/* Блокеры, связи, файлы, ресурсы и заметки живут на полной странице. В
            панели их нет, и без этой полоски казалось, что их нет вовсе. */}
        {onFull && (
          <button className="pn-more" onClick={onFull}>
            <Icon name="expand" sm />
            <b>{t('panel.more')}</b>
            <span>{t('panel.moreHint')}</span>
            <Icon name="chevronEnd" sm />
          </button>
        )}
        {task.project && (
          <>
            <TaskDiscussion task={task} lng={lng} mentions={data.team.map((p) => ({ id: p.id, label: p.name, avatarUrl: p.avatarUrl }))} />
            <TaskHistory task={task} lng={lng} />
          </>
        )}
      </div>
    </>
  )
}

export function Ball({ data, myId, lng }: { data: TaskFull; myId: string; lng: string }) {
  const { t } = useTranslation('v2')
  const task = data.task
  const a = useBallActions(task, myId)
  const toggleTable = useTableToggle()
  const [menu, setMenu] = useState(false)
  const closed = task.closed
  const mine = task.holder?.id === myId
  const mk = task.ball.waitingClientSince ? 'client' : task.ball.move
  const h = task.holder
  const wait = waitText(t, task.ball.heldSince)
  const ownerName = task.owner?.id === myId ? t('panel.you') : (task.owner?.name ?? '—')
  let sub: string
  if (closed) sub = task.status === 'done' ? t('panel.subClosedDone') : t('panel.subClosedCancel')
  else if (task.ball.waitingClientSince)
    sub = t('panel.subClient', { date: new Date(task.ball.waitingClientSince).toLocaleDateString(lng, { month: 'short', day: 'numeric' }) })
  else if (mine) {
    const from = task.owner?.id === myId ? t('panel.yourTask') : t('panel.fromName', { name: task.owner?.name ?? '—' })
    sub = t('panel.subMine', { from, wait })
  } else sub = t('panel.subAway', { wait, owner: ownerName })
  const head =
    task.status === 'done' ? t('panel.accepted') : task.status === 'cancelled' ? t('panel.cancelled') : mine ? t('panel.youHave') : h ? t('panel.hasBall', { name: h.name }) : t('panel.nobody')
  const long = mine && !closed && !task.ball.waitingClientSince && heatOf(task.ball.move, task.ball.heldSince) === 'burn'

  return (
    <div className={'ball' + (mine && !closed ? ' is-me' : '')}>
      <span className="av lg" style={{ background: personColor(h?.id) }}>
        {letterOf(h?.name)}
      </span>
      <div className="who2">
        <b className="bidi">{head}</b>
        {!closed && (
          <span className={`mv mv-${mk}`}>
            <i />
            {t(`mv.${mk}`)}
          </span>
        )}
        {!closed && task.ball.round > 1 && <span className="rnd">{t('round', { n: task.ball.round })}</span>}
        <small>
          {sub}
          {long && <span className="long"> {t('panel.long')}</span>}
        </small>
      </div>
      <div className="bacts">
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
        {!a.open && data.can.reopen && (
          <button className="btn" onClick={a.reopen}>
            {t('act.reopen')}
          </button>
        )}
        {a.open && (
          <button className="ib" aria-label={t('act.more')} aria-expanded={menu} onClick={() => setMenu(!menu)}>
            <Icon name="more" />
          </button>
        )}
        {menu && (
          <>
            <div className="gt-scrim" onClick={() => setMenu(false)} />
            <div className="mmenu" role="menu" onClick={() => setMenu(false)}>
              {a.canPassOn && (
                <button role="menuitem" onClick={a.pass}>
                  <Icon name="arrow" sm />
                  {task.ball.move === 'review' ? t('act.passReview') : t('act.forward')}
                </button>
              )}
              {a.isAway && data.can.pass && (
                <button role="menuitem" onClick={a.pass}>
                  <Icon name="arrow" sm />
                  {t('act.pass')}
                </button>
              )}
              {a.canAsk && (
                <button role="menuitem" onClick={a.ask}>
                  <Icon name="ask" sm />
                  {t('act.ask')}
                </button>
              )}
              {a.canTake && (
                <button role="menuitem" onClick={a.take}>
                  <Icon name="hand" sm />
                  {t('act.take')}
                </button>
              )}
              {data.can.table && (
                <button role="menuitem" onClick={() => void toggleTable(task.id, !task.ball.onTable)}>
                  <Icon name="fire" sm />
                  {task.ball.onTable ? t('tbl.off') : t('tbl.on')}
                </button>
              )}
              {a.canClient && (
                <button role="menuitem" onClick={a.toggleClient}>
                  <Icon name="clock" sm />
                  {task.ball.waitingClientSince ? t('act.clientReplied') : t('act.waitClient')}
                </button>
              )}
              {data.can.cancel && (
                <button role="menuitem" className="danger" onClick={a.cancel}>
                  <Icon name="cancel" sm />
                  {t('act.cancel')}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Checklist({ task, canEdit }: { task: TaskFull['task']; canEdit: boolean }) {
  const qc = useQueryClient()
  const key = ['v2', 'checklist', task.id]
  const q = useQuery({
    queryKey: key,
    queryFn: () => api<{ items: CheckItem[] }>(`/api/v1/tasks/${task.id}/checklist`, inProject(task.project!.id)).then((r) => r.items),
    enabled: Boolean(task.project),
  })
  const toggle = useMutation({
    mutationFn: (i: CheckItem) =>
      api(`/api/v1/tasks/${task.id}/checklist/${i.id}`, { method: 'PATCH', body: JSON.stringify({ done: !i.done }), ...inProject(task.project!.id) }),
    onMutate: (i) => qc.setQueryData<CheckItem[]>(key, (old) => old?.map((x) => (x.id === i.id ? { ...x, done: !x.done } : x))),
    onSettled: () => void qc.invalidateQueries({ queryKey: key }),
  })
  if (!q.data?.length) return null
  return (
    <div className="cl">
      {q.data.map((c) => (
        <button key={c.id} className={'cli' + (c.done ? ' on' : '')} disabled={!canEdit} onClick={() => toggle.mutate(c)} role="checkbox" aria-checked={c.done}>
          <span className={'box' + (c.done ? ' on' : '')}>{c.done && <Icon name="check" style={{ width: 12, height: 12, strokeWidth: 2.6 }} />}</span>
          <span className="bidi">{c.text}</span>
        </button>
      ))}
    </div>
  )
}

export const stripHtml = (s: string) =>
  s.includes('<')
    ? new DOMParser().parseFromString(s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n'), 'text/html').body.textContent?.trim() ?? ''
    : s
