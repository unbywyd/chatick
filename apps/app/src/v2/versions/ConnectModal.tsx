import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { inProject } from '../data'
import { useUi } from '../ui'
import { Icon } from '../Icon'
import { ProjectLogo } from '../ProjectLogo'
import { shortProject } from '../util'
import { Combo } from './Combo'
import { ensureReleasesOn, httpStatus, loadExpo, vkeys, type Expo, type useVersionsData } from './data'

type Data = ReturnType<typeof useVersionsData>

/**
 * «Подключить сборки» — один общий путь для любого проекта.
 *
 * Выбрали проект → сервер выдаёт адрес и секрет вебхука (тот же, что
 * у chatick_expo_connect: повторный запрос не меняет секрет и не ломает уже
 * настроенное) → текст с командой отдают ИИ, он выполняет её в папке
 * приложения. Узнать, что ИИ закончил, можно только по первой сборке: Expo
 * при создании вебхука к нам не стучится. Поэтому ждём честно — до первого
 * события, опрашивая сервер.
 */
export function ConnectModal({ data, initial, onClose }: { data: Data; initial: string | null; onClose: () => void }) {
  const { t } = useTranslation('v2')
  const { flash } = useUi()
  const qc = useQueryClient()
  const [pid, setPid] = useState<string | null>(initial)
  const [copied, setCopied] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const p = data.projects.find((x) => x.id === pid) ?? null
  const on = pid ? data.onSet.has(pid) : false

  const expo = useQuery({
    queryKey: vkeys.expo(pid ?? ''),
    queryFn: () => loadExpo(pid!),
    enabled: Boolean(pid) && on,
    // Пока сборок не было — спрашиваем раз в 5 секунд: ИИ мог уже всё
    // настроить, и человек ждёт, что окно это покажет.
    refetchInterval: (q) => (q.state.data?.connected && !q.state.data.live ? 5000 : false),
  })
  const st: Expo | undefined = pid ? expo.data : undefined

  // Первая сборка пришла, пока окно открыто, — об этом и ждал человек.
  const prev = useRef<{ pid: string | null; live: boolean }>({ pid, live: Boolean(st?.live) })
  useEffect(() => {
    const live = Boolean(st?.live)
    if (prev.current.pid === pid && !prev.current.live && live && p) {
      flash(t('versions.cn.connected', { name: shortProject(p.name) }))
      void qc.invalidateQueries({ queryKey: vkeys.all })
    }
    prev.current = { pid, live }
  }, [pid, st?.live, p, flash, t, qc])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const get = useMutation({
    mutationFn: async (projectId: string) => {
      await ensureReleasesOn(projectId, data.onSet.has(projectId))
      return api<Expo>('/api/v1/integrations/expo', { method: 'POST', ...inProject(projectId) })
    },
    onSuccess: (d, projectId) => {
      setErr(null)
      qc.setQueryData(vkeys.expo(projectId), d)
      void qc.invalidateQueries({ queryKey: vkeys.all })
    },
    onError: (e) => setErr(httpStatus(e) === 403 ? t('versions.err.rights') : t('versions.err.generic')),
  })

  // Отключить: секрет вебхука перестаёт действовать, новые сборки сюда не придут.
  const [offAsk, setOffAsk] = useState(false)
  const off = useMutation({
    mutationFn: (projectId: string) => api('/api/v1/integrations/expo', { method: 'DELETE', ...inProject(projectId) }),
    onSuccess: (_d, projectId) => {
      setOffAsk(false)
      void qc.invalidateQueries({ queryKey: vkeys.expo(projectId) })
      void qc.invalidateQueries({ queryKey: vkeys.all })
      flash(t('cn2.offDone'))
    },
    onError: (e) => setErr(httpStatus(e) === 403 ? t('versions.err.rights') : t('versions.err.generic')),
  })

  const cmd = st?.url && st.secret ? `eas webhook:create --event BUILD --url ${st.url} --secret ${st.secret}` : ''
  const prompt = cmd && p ? t('versions.cn.prompt', { name: shortProject(p.name), cmd, interpolation: { escapeValue: false } }) : ''

  const withBuilds = data.projects.filter((x) => data.expoBy.get(x.id)?.connected)
  const rest = data.projects.filter((x) => !data.expoBy.get(x.id)?.connected)
  const opt = (x: (typeof data.projects)[number]) => {
    const e = data.expoBy.get(x.id)
    return {
      id: x.id,
      label: shortProject(x.name),
      search: x.name,
      icon: <ProjectLogo project={x} size="sm" />,
      meta: e?.live ? t('versions.cn.metaOn') : e?.connected ? t('versions.cn.metaWait') : '',
    }
  }

  return (
    <div className="mwrap mwrap-top" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={t('versions.cn.title')}>
        <div className="mh">
          <div style={{ minWidth: 0, flex: 1 }}>
            <h3>{t('versions.cn.title')}</h3>
            <div className="s" style={{ whiteSpace: 'normal' }}>
              {t('versions.cn.sub')}
            </div>
          </div>
          <button className="ib" aria-label={t('versions.rq.close')} onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>

        <Combo
          value={pid}
          curIcon={p ? <ProjectLogo project={p} size="sm" /> : <span className="logo sm" style={{ background: 'var(--soft)' }} />}
          curLabel={p ? shortProject(p.name) : t('versions.combo.choose')}
          aria={t('versions.combo.projectAria', { name: p ? shortProject(p.name) : '' })}
          groups={[
            { head: t('versions.combo.withBuilds'), opts: withBuilds.map(opt) },
            { head: t('versions.combo.all', { n: rest.length }), opts: rest.map(opt) },
          ]}
          findPh={t('versions.combo.find', { n: data.projects.length })}
          noneText={(q) => t('versions.combo.none', { q })}
          onPick={(id) => {
            setPid(id)
            setCopied(false)
            setErr(null)
          }}
        />

        {st?.live && <div className="cn-done">{t('versions.cn.already')}</div>}

        {pid && (
          <div className="cn-box">
            <div className="cn-k">{t('versions.cn.k')}</div>
            {prompt ? (
              <div className="cn-p bidi" style={{ whiteSpace: 'pre-wrap', wordBreak: 'normal', overflowWrap: 'anywhere' }}>
                {prompt}
              </div>
            ) : (
              <div style={{ fontSize: 13.5, opacity: 0.8 }}>{t('versions.cn.pre')}</div>
            )}
            {prompt ? (
              <button
                className="btn-acc"
                onClick={() => {
                  void navigator.clipboard?.writeText(prompt).catch(() => {})
                  setCopied(true)
                }}
              >
                {copied ? t('versions.cn.copied') : t('versions.cn.copy')}
              </button>
            ) : (
              <button className={'btn-acc' + (get.isPending || (on && expo.isLoading) ? ' dis' : '')} onClick={() => pid && get.mutate(pid)}>
                {get.isPending ? t('versions.cn.getting') : t('versions.cn.get')}
              </button>
            )}
          </div>
        )}

        {err && (
          <div className="need" role="alert">
            <Icon name="info" />
            {err}
          </div>
        )}

        {st?.connected && (
          <div className={'cn-st' + (st.live ? ' ok' : '')} role="status">
            <span className="d" />
            {st.live ? t('versions.cn.ok') : t('versions.cn.wait')}
            {!st.live && <small style={{ whiteSpace: 'nowrap' }}>{t('versions.cn.waitHint')}</small>}
            {offAsk ? (
              <button className="mini danger on" style={{ marginInlineStart: 'auto' }} disabled={off.isPending} onClick={() => pid && off.mutate(pid)}>
                {t('cn2.offSure')}
              </button>
            ) : (
              <button className="mini" style={{ marginInlineStart: 'auto' }} onClick={() => setOffAsk(true)}>
                {t('cn2.off')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
