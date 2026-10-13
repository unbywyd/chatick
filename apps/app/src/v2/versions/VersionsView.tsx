import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useUi } from '../ui'
import { Icon } from '../Icon'
import { ProjectLogo } from '../ProjectLogo'
import { shortProject } from '../util'
import { Carousel } from '../tasks/TasksView'
import { useVersionsData, type Row } from './data'
import { platLabel, stageLabel } from './labels'
import { ConnectModal } from './ConnectModal'
import { BuildModal } from './BuildModal'
import { StageModal } from './StageModal'
import { ReleaseCard } from './ReleaseCard'
import '../i18n/versions'

type Plat = 'all' | 'ios' | 'android'
type StageF = 'work' | 'built' | 'live'
type Modal = { kind: 'cn' | 'request' | 'new' } | { kind: 'stage'; row: Row } | null

const SF: Record<StageF, (r: Row) => boolean> = {
  work: (r) => r.step < 2,
  built: (r) => r.step === 2,
  live: (r) => r.step === 3,
}

/**
 * Версии приложений (v2) — сборки всех проектов компании одним списком.
 *
 * Подключение Expo — одно общее окно для любого проекта, отдельной вкладки
 * «Версии» в проекте нет. Проекты сверху — фильтр, как во всех списках.
 */
export function VersionsView() {
  // Адрес версии: /versions/v/<проект>/<id> — открывает её карточку.
  const deep = /^v\/([^/]+)\/([^/]+)/.exec(useParams()['*'] ?? '')
  const navigate = useNavigate()
  const { search } = useLocation()
  const { t } = useTranslation('v2')
  const { companyId, base: appBase, project, setProject } = useUi()
  const data = useVersionsData(companyId)
  const deepRow = deep ? (data.rows.find((r) => r.id === deep[2]) ?? null) : null
  const [plat, setPlat] = useState<Plat>('all')
  const [stage, setStage] = useState<StageF | null>(null)
  const [modal, setModal] = useState<Modal>(null)

  const inP = (r: Row) => !project || r.project.id === project
  const base = data.rows.filter(inP).filter((r) => plat === 'all' || r.buildType === plat)
  const list = stage ? base.filter(SF[stage]) : base

  // Группа — приложение проекта; порядок — по самой свежей сборке.
  const groups: { key: string; rows: Row[] }[] = []
  for (const r of [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const key = r.project.id + ' ' + (r.appName ?? '')
    const g = groups.find((x) => x.key === key)
    if (g) g.rows.push(r)
    else groups.push({ key, rows: [r] })
  }

  const liveN = [...data.expoBy.values()].filter((e) => e.live).length
  const pickDefault = () => project ?? data.projects.find((p) => !data.expoBy.get(p.id)?.live)?.id ?? null

  return (
    <div className="wrap">
      <div className="rh">
        <div>
          <h1 className="head">{t('versions.head')}</h1>
          <p className="sub">{t('versions.sub')}</p>
        </div>
        <div className="rh-a">
          <button className="okchip" onClick={() => setModal({ kind: 'cn' })} title={t('versions.cnChip')}>
            {liveN > 0 && <Icon name="check" />}
            {liveN > 0 ? t('versions.cnSum', { count: liveN }) : t('versions.cnNone')}
            <Icon name="plus" sm />
          </button>
          <button className="btn-moss" onClick={() => setModal({ kind: 'request' })}>
            <Icon name="plane" />
            {t('versions.request')}
          </button>
          <button className="btn" onClick={() => setModal({ kind: 'new' })}>
            <Icon name="plus" />
            {t('versions.newVersion')}
          </button>
        </div>
      </div>

      <Carousel projects={data.projects} counts={data.rows} selected={project} onPick={setProject} />

      <div className="rbar">
        <div className="seg" role="tablist">
          {(['all', 'ios', 'android'] as const).map((k) => (
            <button key={k} className={plat === k ? 'on' : ''} role="tab" aria-selected={plat === k} onClick={() => setPlat(k)}>
              {t(`versions.plat.${k}`)}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        {(['work', 'built', 'live'] as const).map((k) => {
          const c = base.filter(SF[k]).length
          const on = stage === k
          return (
            <button key={k} className={'fx' + (on ? ' on' : '') + (!c && !on ? ' dim' : '')} aria-pressed={on} onClick={() => setStage(on ? null : k)}>
              {t(`versions.f.${k}`)}
              <span className="n">{c}</span>
            </button>
          )
        })}
      </div>

      <div className="sheet">
        {groups.map((g) => {
          const p = g.rows[0]!.project
          return (
            <div key={g.key}>
              <div className="vapp">
                <ProjectLogo project={p} size="sm" />
                <span className="bidi">{shortProject(p.name)}</span>
                <span className="vname bidi">{g.rows[0]!.appName || t('versions.noApp')}</span>
                <span className="n">{g.rows.length}</span>
              </div>
              {g.rows.map((r, i) => (
                <VRow
                  key={r.id}
                  r={r}
                  first={i === 0}
                  onStage={() => setModal({ kind: 'stage', row: r })}
                  onOpen={() => navigate(`${appBase}/versions/v/${r.project.id}/${r.id}${search}`)}
                />
              ))}
            </div>
          )
        })}
        {!data.loading && !groups.length && (
          <div className="none">{data.failed ? t('common.error') : data.rows.length ? t('versions.none') : t('versions.empty')}</div>
        )}
        {data.loading && !groups.length && <div className="none">{t('common.loading')}</div>}
      </div>

      {modal?.kind === 'cn' && <ConnectModal data={data} initial={pickDefault()} onClose={() => setModal(null)} />}
      {(modal?.kind === 'request' || modal?.kind === 'new') && (
        <BuildModal
          data={data}
          mode={modal.kind}
          initial={project}
          onClose={() => setModal(null)}
          onDone={(pid) => {
            setModal(null)
            setStage(null)
            setProject(pid)
          }}
        />
      )}
      {modal?.kind === 'stage' && <StageModal row={modal.row} buildTypes={data.buildTypes} onClose={() => setModal(null)} />}
      {deepRow && <ReleaseCard row={deepRow} buildTypes={data.buildTypes} onClose={() => navigate(`${appBase}/versions${search}`)} />}
    </div>
  )
}

function VRow({ r, first, onStage, onOpen }: { r: Row; first: boolean; onStage: () => void; onOpen: () => void }) {
  const { t, i18n } = useTranslation('v2')
  const { openTask } = useUi()
  const label = r.step === 0 ? t('versions.st.requested') : stageLabel(t, r.buildType, r.status, r.statusLabel)
  const dots = [0, 1, 2, 3].map((k) => (k < r.step ? 'done' : k === r.step ? (r.step === 1 ? 'run' : r.step === 3 ? 'done' : 'cur') : ''))
  const stCls = r.step === 3 ? 'live' : r.step < 2 ? 'wait' : ''
  const prof = r.buildProfile?.toLowerCase() ?? ''
  const note = r.notes?.split('\n')[0]?.trim() || (r.step === 0 && r.owner ? t('versions.requestedBy', { name: r.owner.name }) : r.appName || '')
  const at = new Date(r.updatedAt).toLocaleString(i18n.language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  // Версию без автора завёл вебхук — значит, её прислал Expo.
  const who = r.owner?.name ?? (r.buildPageUrl ? t('versions.expo') : '')
  return (
    <div className={'vrow' + (first ? ' first' : '')}>
      <span className="plat">{platLabel(r)}</span>
      <div className="vv" style={{ minWidth: 0 }}>
        <button className="vopen" dir="ltr" onClick={onOpen} title={t('versions.card.open')}>
          {r.version}
        </button>
        <span className="bidi" title={r.notes ?? undefined}>
          {note}
        </span>
      </div>
      {prof ? <span className={'prof' + (prof === 'production' ? ' prod' : '')}>{t(`versions.prof.${prof}`, { defaultValue: r.buildProfile! })}</span> : <span />}
      <button className="pipe" title={t('versions.pipeTitle')} aria-label={`${label}. ${t('versions.pipeTitle')}`} onClick={onStage}>
        {dots.map((c, k) => (
          <i key={k} className={c} />
        ))}
        <span className={stCls}>{label}</span>
      </button>
      <div className="vt">
        {r.tasks.map((tk) => (
          <button key={tk.id} className="tchip" title={tk.title} onClick={() => openTask(tk.id)}>
            {tk.number}
          </button>
        ))}
        {!r.tasks.length && '—'}
      </div>
      <div className="vd">
        {at}
        <small className="bidi">{who}</small>
      </div>
      <div className="vacts">
        {r.buildPageUrl && (
          <a className="ib" href={r.buildPageUrl} target="_blank" rel="noreferrer" aria-label={t('versions.openExpo')} title={t('versions.openExpo')}>
            <Icon name="external" />
          </a>
        )}
        {r.referenceUrl && (
          <a className="ib" href={r.referenceUrl} target="_blank" rel="noreferrer" aria-label={t('versions.download')} title={t('versions.download')}>
            <Icon name="download" />
          </a>
        )}
      </div>
    </div>
  )
}
