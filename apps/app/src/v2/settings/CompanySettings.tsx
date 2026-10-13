import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, API_URL, getSessionToken } from '@/lib/api'
import { keys } from '../data'
import { useUi } from '../ui'
import { Icon } from '../Icon'
import { letterOf, timeAgo } from '../util'
import { Confirm, Sw, copyText, errText, fmtBytes, upload, useFail } from './parts'
import { CompanyDanger, CompanyIntegration, CompanyLocaleRow, CompanyTime, TaskAiRows } from './CompanyMore'

/**
 * Настройки компании (только админ): название и логотип, бэкап, ключ ИИ,
 * хранилище и почта, ключи API, вебхуки.
 *
 * Чего здесь нет, хотя было в макете: бэкапа на SFTP и Google Drive, частоты
 * «непрерывно / каждые 15 минут», своей локальной модели, кнопки «проверить
 * ключ». Сервер умеет S3-совместимое хранилище и копию раз в сутки, провайдеров
 * берём из его же списка.
 */
export function CompanySettings() {
  return (
    <>
      <CompanyProfile />
      <CompanyTime />
      <CompanyAi />
      <Backup />
      <StorageAndMail />
      <CompanyIntegration />
      <ApiKeys />
      <Webhooks />
      <CompanyDanger />
    </>
  )
}

/* ---------------- Компания ---------------- */

function CompanyProfile() {
  const { t } = useTranslation('v2')
  const { company, companyId, flash } = useUi()
  const qc = useQueryClient()
  const fail = useFail()
  const fileRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(company.name)
  const [askLogo, setAskLogo] = useState(false)
  useEffect(() => setName(company.name), [company.name])
  const refresh = () => void qc.invalidateQueries({ queryKey: keys.companies })
  const save = useMutation({
    mutationFn: (n: string) => api(`/api/v1/companies/${companyId}`, { method: 'PATCH', body: JSON.stringify({ name: n }) }),
    onSuccess: () => {
      refresh()
      flash(t('settings.saved'))
    },
    onError: fail,
  })
  const logo = useMutation({
    mutationFn: (f: File) => upload(`/api/v1/companies/${companyId}/logo`, f),
    onSuccess: () => {
      refresh()
      flash(t('settings.co.logoDone'))
    },
    onError: fail,
  })
  const dropLogo = useMutation({
    mutationFn: () => api(`/api/v1/companies/${companyId}/logo`, { method: 'DELETE' }),
    onSuccess: () => {
      setAskLogo(false)
      refresh()
    },
    onError: fail,
  })
  const trimmed = name.trim()
  const dirty = Boolean(trimmed && trimmed !== company.name)
  return (
    <section className="card sec">
      <h2>{t('settings.co.title')}</h2>
      <p className="d">{t('settings.co.sub')}</p>
      <div className="row first">
        <span className="l">{t('settings.co.logo')}</span>
        <div className="inl">
          <span className="bigav sq" style={{ background: '#2F6FEB' }}>
            {company.logoUrl ? <img src={company.logoUrl} alt="" /> : letterOf(company.name)}
          </span>
          <button className="btn sm" onClick={() => fileRef.current?.click()} disabled={logo.isPending}>
            {logo.isPending ? t('settings.uploading') : t('settings.upload')}
          </button>
          {company.logoUrl && !askLogo && (
            <button className="btn sm" onClick={() => setAskLogo(true)}>
              {t('settings.co.logoRemove')}
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) logo.mutate(f)
            }}
          />
        </div>
        {askLogo && (
          <Confirm
            text={t('settings.co.logoAsk')}
            yes={t('settings.co.logoRemove')}
            busy={dropLogo.isPending}
            onYes={() => dropLogo.mutate()}
            onNo={() => setAskLogo(false)}
          />
        )}
      </div>
      <div className="row">
        <span className="l">{t('settings.co.name')}</span>
        <div className="inl">
          <label className="f" style={{ width: 320 }}>
            <input
              className="bidi"
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && dirty && save.mutate(trimmed)}
              aria-label={t('settings.co.name')}
            />
          </label>
          {dirty && (
            <button className="btn sm pr" onClick={() => save.mutate(trimmed)} disabled={save.isPending}>
              {t('settings.save')}
            </button>
          )}
        </div>
      </div>
      <CompanyLocaleRow />
    </section>
  )
}

/* ---------------- Бэкап ---------------- */

type AutoBackup = { enabled: boolean; lastBackupAt: string | null; lastError: string | null; storageReady: boolean }
type BackupStorage = { separate: boolean; endpoint: string; region: string; bucket: string; hasKeys: boolean }
type Storage = { provider: 'platform' | 'custom'; endpoint: string; region: string; bucket: string; publicUrl: string; hasKeys: boolean }
type Summary = { projects: number; tasks: number; documents: number; messages: number; files: number; filesBytes: number }

const hostOf = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function useStorage(companyId: string) {
  return useQuery({ queryKey: ['v2', 'co-storage', companyId], queryFn: () => api<Storage>(`/api/v1/companies/${companyId}/storage`) })
}
function useSummary(companyId: string) {
  return useQuery({
    queryKey: ['v2', 'co-backup-summary', companyId],
    queryFn: () => api<Summary>(`/api/v1/backup/${companyId}/summary`),
    staleTime: 5 * 60_000,
  })
}

function Backup() {
  const { t, i18n } = useTranslation('v2')
  const { companyId, company, flash } = useUi()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const fail = useFail()
  const fileRef = useRef<HTMLInputElement>(null)
  const auto = useQuery({ queryKey: ['v2', 'co-auto-backup', companyId], queryFn: () => api<AutoBackup>(`/api/v1/companies/${companyId}/auto-backup`) })
  const bstore = useQuery({
    queryKey: ['v2', 'co-backup-storage', companyId],
    queryFn: () => api<BackupStorage>(`/api/v1/companies/${companyId}/backup-storage`),
  })
  const storage = useStorage(companyId)
  const summary = useSummary(companyId)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<{ name: string; data: Record<string, unknown> } | null>(null)
  const [pwd, setPwd] = useState('')
  // Секреты ресурсов в архив — только под паролем: без него сервер их не кладёт.
  const [withSecrets, setWithSecrets] = useState(false)
  const [expPwd, setExpPwd] = useState('')
  const [warnings, setWarnings] = useState<{ companyId: string; list: string[] } | null>(null)
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['v2', 'co-auto-backup', companyId] })
    void qc.invalidateQueries({ queryKey: ['v2', 'co-backup-storage', companyId] })
  }

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api(`/api/v1/companies/${companyId}/auto-backup`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
    onSuccess: (_d, v) => flash(v ? t('settings.backup.onDone') : t('settings.backup.offDone')),
    onError: fail,
    onSettled: refresh,
  })
  const now = useMutation({
    mutationFn: () => api<{ bytes?: number }>(`/api/v1/backup/${companyId}/backup-to-storage`, { method: 'POST', body: '{}' }),
    onSuccess: (r) => flash(r.bytes ? t('settings.backup.nowDoneSize', { size: fmtBytes(r.bytes, i18n.language) }) : t('settings.backup.nowDone')),
    onError: fail,
    onSettled: refresh,
  })
  const separateOff = useMutation({
    mutationFn: () => api(`/api/v1/companies/${companyId}/backup-storage`, { method: 'PUT', body: JSON.stringify({ separate: false }) }),
    onSuccess: () => flash(t('settings.saved')),
    onError: fail,
    onSettled: refresh,
  })
  const restore = useMutation({
    mutationFn: (b: { backup: Record<string, unknown>; password?: string }) =>
      api<{ companyId: string; warnings?: string[] }>('/api/v1/backup/import', { method: 'POST', body: JSON.stringify(b) }),
    onSuccess: (r) => {
      setPending(null)
      void qc.invalidateQueries({ queryKey: keys.companies })
      flash(t('settings.backup.restored'))
      // Есть что сказать (секреты пропущены, пароль не подошёл) — сначала это, потом переход.
      if (r.warnings?.length) setWarnings({ companyId: r.companyId, list: r.warnings })
      else navigate(`/c/${r.companyId}`)
    },
    onError: fail,
  })

  // Скачивание — своим fetch: нужен заголовок авторизации и ответ файлом.
  const download = async () => {
    setBusy(true)
    try {
      const res = await fetch(`${API_URL}/api/v1/backup/${companyId}/export`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getSessionToken()}`, 'content-type': 'application/json' },
        body: JSON.stringify(withSecrets ? { includeSecrets: true, password: expPwd } : {}),
      })
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText)
      const blob = await res.blob()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `chatick-backup-${company.name.replace(/[^\w-]+/g, '_')}-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(a.href)
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  const pick = async (f: File) => {
    try {
      const data = JSON.parse(await f.text()) as Record<string, unknown>
      if (!Array.isArray(data.projects)) throw new Error('shape')
      setPwd('')
      setPending({ name: f.name, data })
    } catch {
      flash(t('settings.backup.notBackup'))
    }
  }

  const a = auto.data
  const s = summary.data
  const target = bstore.data?.separate
    ? `S3 · ${hostOf(bstore.data.endpoint)} · ${bstore.data.bucket}`
    : storage.data?.provider === 'custom'
      ? `S3 · ${hostOf(storage.data.endpoint)} · ${storage.data.bucket}`
      : null
  const what = s ? t('settings.backup.what', { p: s.projects, tk: s.tasks, d: s.documents, m: s.messages }) : ''
  const state = !a ? 'off' : a.lastError ? 'bad' : a.enabled ? '' : 'off'
  return (
    <section className="card sec">
      <h2>
        {t('settings.backup.title')} <small>{t('settings.adminOnly')}</small>
      </h2>
      <p className="d">{t('settings.backup.sub')}</p>
      <div className={'bk' + (state ? ' ' + state : '')}>
        <span className="dot" />
        <div>
          <b>
            {!a
              ? t('common.loading')
              : a.lastError
                ? t('settings.backup.failedAt', { err: a.lastError })
                : a.enabled
                  ? a.lastBackupAt
                    ? t('settings.backup.last', { when: timeAgo(i18n.language, a.lastBackupAt) })
                    : t('settings.backup.noneYet')
                  : t('settings.backup.off')}
          </b>
          <small className="bidi">
            {a && !a.enabled && !a.storageReady ? t('settings.backup.needStorage') : [what, target].filter(Boolean).join(' · ')}
          </small>
        </div>
        {a?.storageReady && (
          <button className="btn sm" onClick={() => now.mutate()} disabled={now.isPending}>
            {now.isPending ? t('settings.backup.nowBusy') : t('settings.backup.now')}
          </button>
        )}
        <button className="btn sm" onClick={() => void download()} disabled={busy || (withSecrets && expPwd.length < 8)}>
          {busy ? t('settings.backup.downloading') : t('settings.backup.download')}
        </button>
      </div>
      <div className="row first">
        <span className="l">
          {t('coset.secrets')}
          <small>{t('coset.secretsHint')}</small>
        </span>
        <div className="inl">
          <Sw on={withSecrets} label={t('coset.secrets')} onChange={setWithSecrets} />
          {withSecrets && (
            <label className="f" style={{ width: 240 }}>
              <input type="password" value={expPwd} onChange={(e) => setExpPwd(e.target.value)} placeholder={t('coset.secretsPwd')} aria-label={t('coset.secretsPwd')} autoComplete="new-password" />
            </label>
          )}
        </div>
      </div>
      {warnings && (
        <div className="conf" role="alert" style={{ margin: '12px 0 0' }}>
          <span>
            {t('coset.restoredWarn')} {warnings.list.join(' · ')}
          </span>
          <button className="btn sm" onClick={() => navigate(`/c/${warnings.companyId}`)}>
            {t('coset.openRestored')}
          </button>
        </div>
      )}
      <div className="row">
        <span className="l">
          {t('settings.backup.where')}
          <small>{t('settings.backup.whereHint')}</small>
        </span>
        <div>
          <div className="inl">
            <span className="f ro" style={{ width: 340 }} dir="ltr">
              {target ?? t('settings.backup.noTarget')}
            </span>
            {!editing && (
              <button className="btn sm" onClick={() => setEditing(true)}>
                {bstore.data?.separate ? t('settings.change') : t('settings.backup.ownBucket')}
              </button>
            )}
            {bstore.data?.separate && !editing && (
              <button className="btn sm" onClick={() => separateOff.mutate()} disabled={separateOff.isPending || storage.data?.provider !== 'custom'}>
                {t('settings.backup.withFiles')}
              </button>
            )}
          </div>
          {editing && (
            <S3Form
              initial={bstore.data}
              withPublic={false}
              onCancel={() => setEditing(false)}
              onSave={(v) =>
                api(`/api/v1/companies/${companyId}/backup-storage`, { method: 'PUT', body: JSON.stringify({ separate: true, ...v }) }).then(() => {
                  setEditing(false)
                  refresh()
                  flash(t('settings.s3.ok'))
                })
              }
            />
          )}
        </div>
      </div>
      <div className="row">
        <span className="l">{t('settings.backup.freq')}</span>
        <div className="inl">
          <Sw on={Boolean(a?.enabled)} label={t('settings.backup.daily')} disabled={!a || toggle.isPending || (!a.enabled && !a.storageReady)} onChange={(v) => toggle.mutate(v)} />
          <span className="hint">{t('settings.backup.daily')}</span>
        </div>
      </div>
      <div className="row">
        <span className="l">
          {t('settings.backup.restore')}
          <small>{t('settings.backup.restoreHint')}</small>
        </span>
        <div className="inl">
          {!pending && (
            <button className="btn sm" style={{ justifySelf: 'start' }} onClick={() => fileRef.current?.click()}>
              {t('settings.backup.restoreBtn')}
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) void pick(f)
            }}
          />
        </div>
        {pending && (
          <div className="conf" role="alert" style={{ gridColumn: '1/-1' }}>
            <span className="bidi">{t('settings.backup.restoreAsk', { file: pending.name })}</span>
            {Boolean(pending.data.secretsEncrypted) && (
              <label className="f" style={{ width: 200, color: 'var(--ink)' }}>
                <input type="password" value={pwd} onChange={(e) => setPwd(e.target.value)} placeholder={t('settings.backup.pwd')} aria-label={t('settings.backup.pwd')} />
              </label>
            )}
            <button
              className="btn sm red"
              disabled={restore.isPending || (Boolean(pending.data.secretsEncrypted) && !pwd)}
              onClick={() => restore.mutate({ backup: pending.data, password: pwd || undefined })}
            >
              {restore.isPending ? t('settings.backup.restoring') : t('settings.backup.restoreYes')}
            </button>
            <button className="btn sm" onClick={() => setPending(null)}>
              {t('settings.cancel')}
            </button>
          </div>
        )}
      </div>
    </section>
  )
}

/** Поля S3-совместимого хранилища. Ключи не показываем никогда: пусто — «оставить прежние». */
function S3Form({
  initial,
  withPublic,
  onSave,
  onCancel,
}: {
  initial?: { endpoint: string; region: string; bucket: string; hasKeys: boolean; publicUrl?: string }
  withPublic: boolean
  onSave: (v: Record<string, string | undefined>) => Promise<unknown>
  onCancel: () => void
}) {
  const { t } = useTranslation('v2')
  const [v, setV] = useState({
    endpoint: initial?.endpoint ?? '',
    region: initial?.region && initial.region !== 'auto' ? initial.region : '',
    bucket: initial?.bucket ?? '',
    publicUrl: initial?.publicUrl ?? '',
    accessKey: '',
    secretKey: '',
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: e.target.value })
  const needKeys = !initial?.hasKeys
  const ok = v.endpoint.trim() && v.bucket.trim() && (!needKeys || (v.accessKey && v.secretKey))
  const submit = async () => {
    setBusy(true)
    setErr('')
    try {
      await onSave({
        endpoint: v.endpoint.trim(),
        region: v.region.trim() || undefined,
        bucket: v.bucket.trim(),
        ...(withPublic ? { publicUrl: v.publicUrl.trim() || undefined } : {}),
        accessKey: v.accessKey || undefined,
        secretKey: v.secretKey || undefined,
      })
    } catch (e) {
      setErr(errText(e, t('settings.failed')))
    } finally {
      setBusy(false)
    }
  }
  const field = (k: keyof typeof v, label: string, ph = '', type = 'text') => (
    <label>
      <span>{label}</span>
      <span className="f mono">
        <input type={type} value={v[k]} onChange={set(k)} placeholder={ph} dir="ltr" autoComplete="off" />
      </span>
    </label>
  )
  return (
    <div className="form">
      {field('endpoint', t('settings.s3.endpoint'), 'https://<account>.r2.cloudflarestorage.com')}
      <div className="two">
        {field('bucket', t('settings.s3.bucket'))}
        {field('region', t('settings.s3.region'), 'auto')}
      </div>
      {withPublic && field('publicUrl', t('settings.s3.public'), 'https://files.example.com')}
      <div className="two">
        {field('accessKey', t('settings.s3.access'), needKeys ? '' : t('settings.keep'), 'password')}
        {field('secretKey', t('settings.s3.secret'), needKeys ? '' : t('settings.keep'), 'password')}
      </div>
      <div className="hint">{t('settings.s3.hint')}</div>
      {err && <div className="err">{err}</div>}
      <div className="inl">
        <button className="btn sm pr" disabled={!ok || busy} onClick={() => void submit()}>
          {busy ? t('settings.s3.checking') : t('settings.s3.save')}
        </button>
        <button className="btn sm" onClick={onCancel}>
          {t('settings.cancel')}
        </button>
      </div>
    </div>
  )
}

/* ---------------- ИИ компании ---------------- */

type Llm = { configured: boolean; provider: string | null; model: string | null; vision: boolean; providers: { id: string; label: string; defaultModel: string }[] }

function CompanyAi() {
  const { t } = useTranslation('v2')
  const { companyId, flash } = useUi()
  const qc = useQueryClient()
  const fail = useFail()
  const q = useQuery({ queryKey: ['v2', 'co-llm', companyId], queryFn: () => api<Llm>(`/api/v1/companies/${companyId}/llm`) })
  const [prov, setProv] = useState<string | null>(null)
  const [key, setKey] = useState('')
  const [model, setModel] = useState<string | null>(null)
  const [changing, setChanging] = useState(false)
  const [askOff, setAskOff] = useState(false)
  const refresh = () => void qc.invalidateQueries({ queryKey: ['v2', 'co-llm', companyId] })
  const d = q.data
  const provider = prov ?? d?.provider ?? d?.providers[0]?.id ?? null
  const p = d?.providers.find((x) => x.id === provider)
  // Другой провайдер — другой ключ: старый к нему не подойдёт.
  const needKey = !d?.configured || provider !== d.provider || changing
  const curModel = model ?? (provider === d?.provider ? (d?.model ?? '') : '')
  const dirty = Boolean(key) || provider !== d?.provider || curModel !== (d?.model ?? '')
  const save = useMutation({
    mutationFn: () =>
      api(`/api/v1/companies/${companyId}/llm`, {
        method: 'PUT',
        // vision шлём всегда: без поля сервер его выключает.
        body: JSON.stringify({ provider, model: curModel.trim() || undefined, apiKey: key || undefined, vision: d?.vision ?? false }),
      }),
    onSuccess: () => {
      setKey('')
      setProv(null)
      setModel(null)
      setChanging(false)
      refresh()
      flash(t('settings.saved'))
    },
    onError: fail,
  })
  const vision = useMutation({
    mutationFn: (v: boolean) => api(`/api/v1/companies/${companyId}/llm/vision`, { method: 'PATCH', body: JSON.stringify({ vision: v }) }),
    onError: fail,
    onSettled: refresh,
  })
  const off = useMutation({
    mutationFn: () => api(`/api/v1/companies/${companyId}/llm`, { method: 'DELETE' }),
    onSuccess: () => {
      setAskOff(false)
      setProv(null)
      refresh()
    },
    onError: fail,
  })
  if (!d) return null
  const canSave = Boolean(provider) && (!needKey || key.length >= 8) && dirty && !save.isPending
  return (
    <section className="card sec">
      <h2>
        {t('settings.llm.title')} <small>{t('settings.adminOnly')}</small>
      </h2>
      <p className="d">{t('settings.llm.sub')}</p>
      <div className="row first">
        <span className="l">{t('settings.llm.provider')}</span>
        <div className="radio">
          {d.providers.map((x) => (
            <button key={x.id} className={provider === x.id ? 'on' : ''} aria-pressed={provider === x.id} onClick={() => setProv(x.id)}>
              {x.label}
            </button>
          ))}
        </div>
      </div>
      <div className="row">
        <span className="l">{t('settings.llm.key')}</span>
        <div className="inl">
          {needKey ? (
            <label className="f mono" style={{ width: 320 }}>
              <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={t('settings.llm.keyPh')} aria-label={t('settings.llm.key')} dir="ltr" autoComplete="off" />
            </label>
          ) : (
            <>
              <span className="f ro mono" style={{ width: 320 }}>
                ••••••••••••••• · {t('settings.llm.keySaved')}
              </span>
              <button className="btn sm" onClick={() => setChanging(true)}>
                {t('settings.llm.replace')}
              </button>
            </>
          )}
        </div>
      </div>
      <div className="row">
        <span className="l">
          {t('settings.llm.model')}
          <small>{t('settings.llm.modelHint')}</small>
        </span>
        <label className="f mono" style={{ width: 320 }}>
          <input value={curModel} onChange={(e) => setModel(e.target.value)} placeholder={p?.defaultModel ?? ''} aria-label={t('settings.llm.model')} dir="ltr" />
        </label>
      </div>
      {(dirty || changing) && (
        <div className="row">
          <span className="l" />
          <div className="inl">
            <button className="btn sm pr" disabled={!canSave} onClick={() => save.mutate()}>
              {t('settings.save')}
            </button>
            <button
              className="btn sm"
              onClick={() => {
                setKey('')
                setProv(null)
                setModel(null)
                setChanging(false)
              }}
            >
              {t('settings.cancel')}
            </button>
          </div>
        </div>
      )}
      <TaskAiRows />
      {d.configured && (
        <div className="row">
          <span className="l">
            {t('settings.llm.vision')}
            <small>{t('settings.llm.visionHint')}</small>
          </span>
          <div className="inl">
            <Sw on={d.vision} label={t('settings.llm.vision')} disabled={vision.isPending} onChange={(v) => vision.mutate(v)} />
            <span className="hint">{d.vision ? t('settings.llm.visionOn') : t('settings.llm.visionOff')}</span>
          </div>
        </div>
      )}
      {d.configured && (
        <div className="row">
          <span className="l" />
          {!askOff ? (
            <button className="btn sm" style={{ justifySelf: 'start' }} onClick={() => setAskOff(true)}>
              {t('settings.llm.off')}
            </button>
          ) : (
            <Confirm text={t('settings.llm.offAsk')} yes={t('settings.llm.off')} busy={off.isPending} onYes={() => off.mutate()} onNo={() => setAskOff(false)} />
          )}
        </div>
      )}
    </section>
  )
}

/* ---------------- Хранилище и почта ---------------- */

type Mail = {
  mailProvider: 'smtp' | 'sendgrid' | null
  mailFromEmail: string | null
  mailFromName: string | null
  mailReplyTo: string | null
  mailHost: string | null
  mailPort: number | null
  mailUser: string | null
  mailVerifiedAt: string | null
  hasPassword: boolean
  hasApiKey: boolean
}

function StorageAndMail() {
  const { t, i18n } = useTranslation('v2')
  const { companyId, flash } = useUi()
  const qc = useQueryClient()
  const fail = useFail()
  const storage = useStorage(companyId)
  const summary = useSummary(companyId)
  const mail = useQuery({ queryKey: ['v2', 'co-mail', companyId], queryFn: () => api<Mail>(`/api/v1/companies/${companyId}/mail`) })
  const [editS, setEditS] = useState(false)
  const [askPlatform, setAskPlatform] = useState(false)
  const [editM, setEditM] = useState(false)
  const [askMailOff, setAskMailOff] = useState(false)
  const refreshS = () => {
    void qc.invalidateQueries({ queryKey: ['v2', 'co-storage', companyId] })
    void qc.invalidateQueries({ queryKey: ['v2', 'co-auto-backup', companyId] })
  }
  const refreshM = () => void qc.invalidateQueries({ queryKey: ['v2', 'co-mail', companyId] })
  const toPlatform = useMutation({
    mutationFn: () => api(`/api/v1/companies/${companyId}/storage`, { method: 'PUT', body: JSON.stringify({ provider: 'platform' }) }),
    onSuccess: () => {
      setAskPlatform(false)
      flash(t('settings.saved'))
    },
    onError: fail,
    onSettled: refreshS,
  })
  const test = useMutation({
    mutationFn: () => api<{ sentTo: string }>(`/api/v1/companies/${companyId}/mail/test`, { method: 'POST' }),
    onSuccess: (r) => flash(t('settings.mail.testSent', { to: r.sentTo })),
    onError: fail,
    onSettled: refreshM,
  })
  const mailOff = useMutation({
    mutationFn: () => api(`/api/v1/companies/${companyId}/mail`, { method: 'PATCH', body: JSON.stringify({ provider: null }) }),
    onSuccess: () => setAskMailOff(false),
    onError: fail,
    onSettled: refreshM,
  })
  const st = storage.data
  const m = mail.data
  const custom = st?.provider === 'custom'
  return (
    <section className="card sec">
      <h2>
        {t('settings.sm.title')} <small>{t('settings.adminOnly')}</small>
      </h2>
      <p className="d">{t('settings.sm.sub')}</p>
      <div className="row first top">
        <span className="l">
          {t('settings.sm.files')}
          {summary.data && <small>{t('settings.sm.used', { size: fmtBytes(summary.data.filesBytes, i18n.language), n: summary.data.files })}</small>}
        </span>
        <div>
          <div className="inl">
            <span className="f ro" style={{ width: 340 }} dir={custom ? 'ltr' : undefined}>
              {!st ? '…' : custom ? `S3 · ${hostOf(st.endpoint)} · ${st.bucket}` : t('settings.sm.platform')}
            </span>
            {!editS && (
              <button className="btn sm" onClick={() => setEditS(true)}>
                {custom ? t('settings.change') : t('settings.sm.own')}
              </button>
            )}
            {custom && !editS && !askPlatform && (
              <button className="btn sm" onClick={() => setAskPlatform(true)}>
                {t('settings.sm.toPlatform')}
              </button>
            )}
          </div>
          {askPlatform && (
            <div style={{ marginTop: 10 }}>
              <Confirm text={t('settings.sm.toPlatformAsk')} yes={t('settings.sm.toPlatform')} busy={toPlatform.isPending} onYes={() => toPlatform.mutate()} onNo={() => setAskPlatform(false)} />
            </div>
          )}
          {editS && (
            <S3Form
              initial={custom ? st : undefined}
              withPublic
              onCancel={() => setEditS(false)}
              onSave={(v) =>
                api(`/api/v1/companies/${companyId}/storage`, { method: 'PUT', body: JSON.stringify({ provider: 'custom', ...v }) }).then(() => {
                  setEditS(false)
                  refreshS()
                  flash(t('settings.s3.ok'))
                })
              }
            />
          )}
        </div>
      </div>
      <div className="row top">
        <span className="l">
          {t('settings.mail.title')}
          <small>{t('settings.mail.hint')}</small>
        </span>
        <div>
          <div className="inl">
            <span className="f ro" style={{ width: 340 }} dir={m?.mailProvider ? 'ltr' : undefined}>
              {!m
                ? '…'
                : m.mailProvider === 'smtp'
                  ? `SMTP · ${m.mailHost ?? ''} · ${m.mailFromEmail ?? ''}`
                  : m.mailProvider === 'sendgrid'
                    ? `SendGrid · ${m.mailFromEmail ?? ''}`
                    : t('settings.mail.platform')}
            </span>
            {m?.mailProvider && (
              <span className={'tag' + (m.mailVerifiedAt ? '' : ' w')}>{m.mailVerifiedAt ? t('settings.mail.verified') : t('settings.mail.unverified')}</span>
            )}
          </div>
          {!editM && (
            <div className="inl" style={{ marginTop: 8 }}>
              {m?.mailProvider && (
                <button className="btn sm" onClick={() => test.mutate()} disabled={test.isPending}>
                  {t('settings.mail.test')}
                </button>
              )}
              <button className="btn sm" onClick={() => setEditM(true)}>
                {m?.mailProvider ? t('settings.change') : t('settings.mail.own')}
              </button>
              {m?.mailProvider && !askMailOff && (
                <button className="btn sm" onClick={() => setAskMailOff(true)}>
                  {t('settings.mail.toPlatform')}
                </button>
              )}
            </div>
          )}
          {askMailOff && (
            <div style={{ marginTop: 10 }}>
              <Confirm text={t('settings.mail.toPlatformAsk')} yes={t('settings.mail.toPlatform')} busy={mailOff.isPending} onYes={() => mailOff.mutate()} onNo={() => setAskMailOff(false)} />
            </div>
          )}
          {editM && m && (
            <MailForm
              initial={m}
              onCancel={() => setEditM(false)}
              onSave={(b) =>
                api(`/api/v1/companies/${companyId}/mail`, { method: 'PATCH', body: JSON.stringify(b) }).then(() => {
                  setEditM(false)
                  refreshM()
                  flash(t('settings.mail.saved'))
                })
              }
            />
          )}
        </div>
      </div>
    </section>
  )
}

function MailForm({ initial, onSave, onCancel }: { initial: Mail; onSave: (b: Record<string, unknown>) => Promise<unknown>; onCancel: () => void }) {
  const { t } = useTranslation('v2')
  const [v, setV] = useState({
    provider: (initial.mailProvider ?? 'smtp') as 'smtp' | 'sendgrid',
    fromEmail: initial.mailFromEmail ?? '',
    fromName: initial.mailFromName ?? '',
    replyTo: initial.mailReplyTo ?? '',
    host: initial.mailHost ?? '',
    port: String(initial.mailPort ?? 587),
    user: initial.mailUser ?? '',
    password: '',
    apiKey: '',
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: e.target.value })
  const same = initial.mailProvider === v.provider
  const hasSecret = v.provider === 'smtp' ? Boolean(v.password) || (same && initial.hasPassword) : Boolean(v.apiKey) || (same && initial.hasApiKey)
  const ok = v.fromEmail.includes('@') && (v.provider === 'sendgrid' || v.host.trim()) && hasSecret
  const submit = async () => {
    setBusy(true)
    setErr('')
    try {
      await onSave({
        provider: v.provider,
        fromEmail: v.fromEmail.trim(),
        fromName: v.fromName.trim(),
        replyTo: v.replyTo.trim(),
        ...(v.provider === 'smtp'
          ? { host: v.host.trim(), port: Number(v.port) || 587, user: v.user.trim(), password: v.password || undefined }
          : { apiKey: v.apiKey || undefined }),
      })
    } catch (e) {
      setErr(errText(e, t('settings.failed')))
    } finally {
      setBusy(false)
    }
  }
  const field = (k: keyof typeof v, label: string, ph = '', type = 'text') => (
    <label>
      <span>{label}</span>
      <span className="f">
        <input type={type} value={v[k]} onChange={set(k)} placeholder={ph} dir="ltr" autoComplete="off" />
      </span>
    </label>
  )
  return (
    <div className="form">
      <div className="radio">
        {(['smtp', 'sendgrid'] as const).map((p) => (
          <button key={p} className={v.provider === p ? 'on' : ''} aria-pressed={v.provider === p} onClick={() => setV({ ...v, provider: p })}>
            {p === 'smtp' ? 'SMTP' : 'SendGrid'}
          </button>
        ))}
      </div>
      <div className="two">
        {field('fromEmail', t('settings.mail.from'), 'no-reply@company.com')}
        {field('fromName', t('settings.mail.fromName'))}
      </div>
      {field('replyTo', t('settings.mail.replyTo'))}
      {v.provider === 'smtp' ? (
        <>
          <div className="two">
            {field('host', t('settings.mail.host'), 'smtp.company.com')}
            {field('port', t('settings.mail.port'), '587')}
          </div>
          <div className="two">
            {field('user', t('settings.mail.user'))}
            {field('password', t('settings.mail.password'), same && initial.hasPassword ? t('settings.keep') : '', 'password')}
          </div>
        </>
      ) : (
        field('apiKey', t('settings.mail.apiKey'), same && initial.hasApiKey ? t('settings.keep') : '', 'password')
      )}
      {err && <div className="err">{err}</div>}
      <div className="inl">
        <button className="btn sm pr" disabled={!ok || busy} onClick={() => void submit()}>
          {t('settings.save')}
        </button>
        <button className="btn sm" onClick={onCancel}>
          {t('settings.cancel')}
        </button>
      </div>
    </div>
  )
}

/* ---------------- Ключи API ---------------- */

type ApiKey = { id: string; name: string; prefix: string; scopes: string[]; allowedIps: string[]; lastUsedAt: string | null; createdAt: string }
const SCOPES = ['read:all', 'projects:write', 'users:write'] as const

function ApiKeys() {
  const { t, i18n } = useTranslation('v2')
  const { companyId, flash } = useUi()
  const qc = useQueryClient()
  const fail = useFail()
  const list = useQuery({ queryKey: ['v2', 'co-keys', companyId], queryFn: () => api<{ items: ApiKey[] }>(`/api/v1/companies/${companyId}/api-keys`).then((r) => r.items) })
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<string[]>(['read:all'])
  const [fresh, setFresh] = useState<string | null>(null)
  const [ask, setAsk] = useState<string | null>(null)
  const refresh = () => void qc.invalidateQueries({ queryKey: ['v2', 'co-keys', companyId] })
  const create = useMutation({
    mutationFn: () => api<{ key: string }>(`/api/v1/companies/${companyId}/api-keys`, { method: 'POST', body: JSON.stringify({ name: name.trim(), scopes }) }),
    onSuccess: (r) => {
      setFresh(r.key)
      setCreating(false)
      setName('')
      setScopes(['read:all'])
    },
    onError: fail,
    onSettled: refresh,
  })
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api/v1/companies/${companyId}/api-keys/${id}`, { method: 'DELETE' }),
    onSuccess: (_d, id) => {
      setAsk(null)
      flash(t('settings.keys.revoked', { name: list.data?.find((k) => k.id === id)?.name ?? '' }))
    },
    onError: fail,
    onSettled: refresh,
  })
  const items = list.data ?? []
  return (
    <section className="card sec">
      <h2>
        {t('settings.keys.title')} <small>{t('settings.adminOnly')}</small>
      </h2>
      <p className="d">{t('settings.keys.sub')}</p>
      {items.length > 0 && (
        <table className="keys">
          <thead>
            <tr>
              <th>{t('settings.keys.name')}</th>
              <th>{t('settings.keys.key')}</th>
              <th>{t('settings.keys.scopes')}</th>
              <th>{t('settings.keys.used')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((k) =>
              ask === k.id ? (
                <tr key={k.id}>
                  <td colSpan={5}>
                    <Confirm
                      text={t('settings.keys.ask', { name: k.name })}
                      yes={t('settings.keys.revoke')}
                      busy={revoke.isPending}
                      onYes={() => revoke.mutate(k.id)}
                      onNo={() => setAsk(null)}
                    />
                  </td>
                </tr>
              ) : (
                <tr key={k.id}>
                  <td className="bidi">{k.name}</td>
                  <td className="m">{k.prefix}…</td>
                  <td>{k.scopes.map((s) => t(`settings.keys.scope.${s.replace(":", "_")}`, { defaultValue: s })).join(', ')}</td>
                  <td>{k.lastUsedAt ? timeAgo(i18n.language, k.lastUsedAt) : t('settings.keys.never')}</td>
                  <td className="e">
                    <button className="btn sm" onClick={() => setAsk(k.id)}>
                      {t('settings.keys.revoke')}
                    </button>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      )}
      {list.isSuccess && !items.length && !fresh && <div className="hint">{t('settings.keys.none')}</div>}
      {fresh && (
        <div className="newkey">
          <span>{fresh}</span>
          <button
            className="btn sm"
            onClick={() =>
              void copyText(fresh).then((ok) => {
                flash(ok ? t('settings.keys.copied') : t('settings.copyFail'))
                if (ok) setFresh(null)
              })
            }
          >
            {t('settings.copy')}
          </button>
          <small>{t('settings.keys.once')}</small>
        </div>
      )}
      {creating ? (
        <div className="form">
          <label>
            <span>{t('settings.keys.name')}</span>
            <span className="f">
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder={t('settings.keys.namePh')} autoFocus />
            </span>
          </label>
          <div className="radio" role="group" aria-label={t('settings.keys.scopes')}>
            {SCOPES.map((s) => {
              const on = scopes.includes(s)
              return (
                <button key={s} className={on ? 'on' : ''} aria-pressed={on} onClick={() => setScopes(on ? scopes.filter((x) => x !== s) : [...scopes, s])}>
                  {t(`settings.keys.scope.${s.replace(":", "_")}`)}
                </button>
              )
            })}
          </div>
          <div className="inl">
            <button className="btn sm pr" disabled={!name.trim() || !scopes.length || create.isPending} onClick={() => create.mutate()}>
              {t('settings.keys.create')}
            </button>
            <button className="btn sm" onClick={() => setCreating(false)}>
              {t('settings.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <button className="btn sm" style={{ marginTop: 12 }} onClick={() => setCreating(true)}>
          <Icon name="plus" sm />
          {t('settings.keys.new')}
        </button>
      )}
    </section>
  )
}

/* ---------------- Вебхуки ---------------- */

type Webhook = { id: string; url: string; events: string[]; active: boolean; lastOkAt: string | null; lastFailAt: string | null; lastError: string | null }
const HOOK_EVENTS = ['task.created', 'task.status_changed', 'task.assigned'] as const

function Webhooks() {
  const { t, i18n } = useTranslation('v2')
  const { companyId, flash } = useUi()
  const qc = useQueryClient()
  const fail = useFail()
  const list = useQuery({ queryKey: ['v2', 'co-hooks', companyId], queryFn: () => api<{ items: Webhook[] }>(`/api/v1/companies/${companyId}/webhooks`).then((r) => r.items) })
  const [creating, setCreating] = useState(false)
  const [url, setUrl] = useState('')
  const [events, setEvents] = useState<string[]>([])
  const [fresh, setFresh] = useState<string | null>(null)
  const [ask, setAsk] = useState<string | null>(null)
  const refresh = () => void qc.invalidateQueries({ queryKey: ['v2', 'co-hooks', companyId] })
  const create = useMutation({
    mutationFn: () => api<{ secret: string }>(`/api/v1/companies/${companyId}/webhooks`, { method: 'POST', body: JSON.stringify({ url: url.trim(), events }) }),
    onSuccess: (r) => {
      setFresh(r.secret)
      setCreating(false)
      setUrl('')
      setEvents([])
    },
    onError: fail,
    onSettled: refresh,
  })
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/v1/companies/${companyId}/webhooks/${id}`, { method: 'DELETE' }),
    onSuccess: () => setAsk(null),
    onError: fail,
    onSettled: refresh,
  })
  const items = list.data ?? []
  const state = (w: Webhook) => {
    const ok = w.lastOkAt ? new Date(w.lastOkAt).getTime() : 0
    const bad = w.lastFailAt ? new Date(w.lastFailAt).getTime() : 0
    if (!ok && !bad) return <span className="tag g">{t('settings.hooks.idle')}</span>
    if (bad > ok)
      return (
        <span className="tag r" title={w.lastError ?? ''}>
          {t('settings.hooks.fail', { when: timeAgo(i18n.language, w.lastFailAt!) })}
        </span>
      )
    return <span className="tag">{t('settings.hooks.ok', { when: timeAgo(i18n.language, w.lastOkAt!) })}</span>
  }
  return (
    <section className="card sec">
      <h2>
        {t('settings.hooks.title')} <small>{t('settings.adminOnly')}</small>
      </h2>
      <p className="d">{t('settings.hooks.sub')}</p>
      {items.length > 0 && (
        <table className="keys">
          <thead>
            <tr>
              <th>{t('settings.hooks.url')}</th>
              <th>{t('settings.hooks.events')}</th>
              <th>{t('settings.hooks.state')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((w) =>
              ask === w.id ? (
                <tr key={w.id}>
                  <td colSpan={4}>
                    <Confirm text={t('settings.hooks.ask', { url: w.url })} yes={t('settings.hooks.remove')} busy={remove.isPending} onYes={() => remove.mutate(w.id)} onNo={() => setAsk(null)} />
                  </td>
                </tr>
              ) : (
                <tr key={w.id}>
                  <td className="m" style={{ wordBreak: 'break-all' }}>
                    {w.url}
                  </td>
                  <td>{w.events.length ? w.events.map((e) => t(`settings.hooks.ev.${e}`, { defaultValue: e })).join(', ') : t('settings.hooks.all')}</td>
                  <td>{state(w)}</td>
                  <td className="e">
                    <button className="btn sm" onClick={() => setAsk(w.id)}>
                      {t('settings.hooks.remove')}
                    </button>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      )}
      {list.isSuccess && !items.length && !fresh && <div className="hint">{t('settings.hooks.none')}</div>}
      {fresh && (
        <div className="newkey">
          <span>{fresh}</span>
          <button
            className="btn sm"
            onClick={() =>
              void copyText(fresh).then((ok) => {
                flash(ok ? t('settings.keys.copied') : t('settings.copyFail'))
                if (ok) setFresh(null)
              })
            }
          >
            {t('settings.copy')}
          </button>
          <small>{t('settings.hooks.once')}</small>
        </div>
      )}
      {creating ? (
        <div className="form">
          <label>
            <span>{t('settings.hooks.url')}</span>
            <span className="f mono">
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" dir="ltr" autoFocus />
            </span>
          </label>
          <div className="radio" role="group" aria-label={t('settings.hooks.events')}>
            {HOOK_EVENTS.map((e) => {
              const on = events.includes(e)
              return (
                <button key={e} className={on ? 'on' : ''} aria-pressed={on} onClick={() => setEvents(on ? events.filter((x) => x !== e) : [...events, e])}>
                  {t(`settings.hooks.ev.${e}`)}
                </button>
              )
            })}
          </div>
          <div className="hint">{t('settings.hooks.evHint')}</div>
          <div className="inl">
            <button className="btn sm pr" disabled={!/^https:\/\/\S+$/i.test(url.trim()) || create.isPending} onClick={() => create.mutate()}>
              {t('settings.hooks.create')}
            </button>
            <button className="btn sm" onClick={() => setCreating(false)}>
              {t('settings.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <button className="btn sm" style={{ marginTop: 12 }} onClick={() => setCreating(true)}>
          <Icon name="plus" sm />
          {t('settings.hooks.new')}
        </button>
      )}
    </section>
  )
}
