import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { inProject } from '../data'
import { useUi } from '../ui'
import { Icon } from '../Icon'
import { ProjectLogo } from '../ProjectLogo'
import { letterOf, personColor, shortProject } from '../util'
import { Combo } from './Combo'
import { ensureReleasesOn, httpStatus, vkeys, type useVersionsData } from './data'

type Data = ReturnType<typeof useVersionsData>
type Member = { role: string; user: { id: string; name: string; email: string; avatarUrl: string | null } }
type Plat = 'ios' | 'android' | 'both'
type Prof = 'preview' | 'production'

/**
 * «Запросить сборку» и «Новая версия» — одно окно в двух режимах.
 *
 * Запрос: задача человеку + версия + связь, одной ручкой сервера
 * (/releases/request — там либо всё, либо ничего). «Обе платформы» — два
 * запроса: у сервера одна версия на платформу, и сборка под каждую — своя
 * работа, поэтому и задач две.
 *
 * Новая версия: та же форма без исполнителя — версия, которую завели руками
 * (собрали не через Expo или до подключения вебхука).
 */
export function BuildModal({ data, mode, initial, onClose, onDone }: { data: Data; mode: 'request' | 'new'; initial: string | null; onClose: () => void; onDone: (projectId: string) => void }) {
  const { t } = useTranslation('v2')
  const { flash } = useUi()
  const qc = useQueryClient()
  const [pid, setPid] = useState<string | null>(initial)
  const [who, setWho] = useState<string | null>(null)
  const [plat, setPlat] = useState<Plat>('ios')
  const [prof, setProf] = useState<Prof>('preview')
  const lastApp = (id: string | null) => data.rows.find((r) => r.project.id === id && r.appName)?.appName ?? ''
  const [app, setApp] = useState(() => lastApp(initial))
  const [ver, setVer] = useState('')
  const [need, setNeed] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const isReq = mode === 'request'
  const p = data.projects.find((x) => x.id === pid) ?? null

  const members = useQuery({
    queryKey: vkeys.members(pid ?? ''),
    queryFn: () => api<Member[]>(`/api/v1/projects/${pid}/members`),
    enabled: isReq && Boolean(pid),
    staleTime: 60_000,
  })
  const people = members.data ?? []
  const whoM = people.find((m) => m.user.id === who) ?? null

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const send = useMutation({
    mutationFn: async () => {
      const projectId = pid!
      await ensureReleasesOn(projectId, data.onSet.has(projectId))
      const plats = plat === 'both' ? (['ios', 'android'] as const) : ([plat] as const)
      const tasks: string[] = []
      for (const bt of plats) {
        const body = { version: ver.trim(), appName: app.trim() || null, buildType: bt, buildProfile: prof }
        if (isReq) {
          const r = await api<{ task: { number: string } }>('/api/v1/releases/request', {
            method: 'POST',
            body: JSON.stringify({ ...body, assigneeId: who, comment: need.trim() || undefined }),
            ...inProject(projectId),
          })
          tasks.push(r.task.number)
        } else {
          await api('/api/v1/releases', { method: 'POST', body: JSON.stringify({ ...body, notes: need.trim() || null }), ...inProject(projectId) })
        }
      }
      return { projectId, tasks }
    },
    onSuccess: ({ projectId, tasks }) => {
      void qc.invalidateQueries({ queryKey: vkeys.all })
      if (isReq) void qc.invalidateQueries({ queryKey: ['v2', 'ball'] })
      flash(isReq ? t('versions.rq.done', { name: whoM?.user.name ?? '', task: tasks.join(', ') }) : t('versions.rq.doneNew', { ver: ver.trim() }))
      onDone(projectId)
    },
    onError: (e) => {
      // Часть запросов могла пройти (вторая платформа упала) — список перечитываем в любом случае.
      if (pid) void qc.invalidateQueries({ queryKey: vkeys.all })
      setErr(httpStatus(e) === 403 ? t('versions.err.rights') : (e as Error).message || t('versions.err.generic'))
    },
  })

  const ready = Boolean(pid) && Boolean(ver.trim()) && (!isReq || Boolean(who))
  const result = !isReq ? (ver.trim() ? '' : t('versions.rq.needVer')) : whoM ? t(plat === 'both' ? 'versions.rq.willGetBoth' : 'versions.rq.willGet', { name: whoM.user.name }) : t('versions.rq.chooseWho')

  const projectOpts = data.projects.map((x) => ({ id: x.id, label: shortProject(x.name), search: x.name, icon: <ProjectLogo project={x} size="sm" /> }))
  const withBuilds = projectOpts.filter((o) => data.onSet.has(o.id))
  const rest = projectOpts.filter((o) => !data.onSet.has(o.id))

  const av = (id: string | null, name: string) => (
    <span className="av pcav" style={{ background: id ? personColor(id) : 'var(--soft)' }}>
      {id ? letterOf(name) : ''}
    </span>
  )

  return (
    <div className="mwrap mwrap-top" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={isReq ? t('versions.rq.title') : t('versions.rq.titleNew')}>
        <div className="mh">
          <div style={{ minWidth: 0, flex: 1 }}>
            <h3>{isReq ? t('versions.rq.title') : t('versions.rq.titleNew')}</h3>
            <div className="s" style={{ whiteSpace: 'normal' }}>
              {isReq ? t('versions.rq.sub') : t('versions.rq.subNew')}
            </div>
          </div>
          <button className="ib" aria-label={t('versions.rq.close')} onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>

        <div>
          <div className="lbl">{t('versions.rq.project')}</div>
          <Combo
            value={pid}
            curIcon={p ? <ProjectLogo project={p} size="sm" /> : <span className="logo sm" style={{ background: 'var(--soft)' }} />}
            curLabel={p ? shortProject(p.name) : t('versions.combo.choose')}
            aria={t('versions.combo.projectAria', { name: p ? shortProject(p.name) : '' })}
            groups={[
              { head: t('versions.combo.withBuilds'), opts: withBuilds },
              { head: t('versions.combo.all', { n: rest.length }), opts: rest },
            ]}
            findPh={t('versions.combo.find', { n: data.projects.length })}
            noneText={(q) => t('versions.combo.none', { q })}
            onPick={(id) => {
              setPid(id)
              setWho(null)
              setErr(null)
              if (!app.trim() || app === lastApp(pid)) setApp(lastApp(id))
            }}
          />
        </div>

        {isReq && (
          <div>
            <div className="lbl">{t('versions.rq.who')}</div>
            <Combo
              value={who}
              curIcon={av(whoM?.user.id ?? null, whoM?.user.name ?? '')}
              curLabel={whoM?.user.name ?? t('versions.combo.chooseWho')}
              aria={t('versions.combo.whoAria', { name: whoM?.user.name ?? '' })}
              groups={[
                {
                  opts: people.map((m) => ({
                    id: m.user.id,
                    label: m.user.name,
                    search: m.user.email,
                    icon: av(m.user.id, m.user.name),
                    sub: m.role === 'owner' || m.role === 'admin' ? t('versions.combo.lead') : '',
                  })),
                },
              ]}
              findPh={t('versions.combo.findPerson', { n: people.length })}
              noneText={(q) => (members.isLoading ? t('versions.combo.loading') : t('versions.combo.nonePerson', { q }))}
              onPick={setWho}
            />
          </div>
        )}

        <div className="two">
          <div>
            <div className="lbl">{t('versions.rq.plat')}</div>
            <div className="seg" style={{ display: 'flex' }} role="radiogroup">
              {(['ios', 'android', 'both'] as const).map((k) => (
                <button key={k} className={plat === k ? 'on' : ''} role="radio" aria-checked={plat === k} style={{ flex: 1, justifyContent: 'center' }} onClick={() => setPlat(k)}>
                  {t(`versions.plat.${k}`)}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="lbl">{t('versions.rq.prof')}</div>
            <div className="seg" style={{ display: 'flex' }} role="radiogroup">
              {(['preview', 'production'] as const).map((k) => (
                <button key={k} className={prof === k ? 'on' : ''} role="radio" aria-checked={prof === k} style={{ flex: 1, justifyContent: 'center' }} onClick={() => setProf(k)}>
                  {t(`versions.prof.${k}`)}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="two">
          <input className="nin bidi" value={app} onChange={(e) => setApp(e.target.value)} placeholder={t('versions.rq.app')} aria-label={t('versions.rq.appAria')} maxLength={80} />
          <input className="nin" value={ver} onChange={(e) => setVer(e.target.value)} placeholder={t('versions.rq.ver')} aria-label={t('versions.rq.ver')} maxLength={50} dir="ltr" />
        </div>
        <input
          className="nin bidi"
          value={need}
          onChange={(e) => setNeed(e.target.value)}
          placeholder={isReq ? t('versions.rq.need') : t('versions.rq.notes')}
          aria-label={isReq ? t('versions.rq.needAria') : t('versions.rq.notes')}
          maxLength={2000}
        />

        {err && (
          <div className="need" role="alert">
            <Icon name="info" />
            {err}
          </div>
        )}

        <div className="mf">
          <div className="res">{result}</div>
          <button className="btn" onClick={onClose}>
            {t('versions.rq.cancel')}
          </button>
          <button className={'btn-acc' + (ready && !send.isPending ? '' : ' dis')} onClick={() => ready && !send.isPending && send.mutate()}>
            <Icon name={isReq ? 'plane' : 'plus'} />
            {isReq ? t('versions.rq.send') : t('versions.rq.create')}
          </button>
        </div>
      </div>
    </div>
  )
}
