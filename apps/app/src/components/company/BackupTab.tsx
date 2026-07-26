import { useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { AlertTriangle, CloudUpload, Download, HardDriveDownload, Upload } from 'lucide-react'
import { api, API_URL, getSessionToken, type Company, type ProjectListItem } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { useConfirm } from '@/components/ui/confirm'

// Экспорт / импорт компании (SPEC §8.28).
// Смысл вкладки — снять вопрос «а если сервис пропадёт»: данные забираются
// целиком и возвращаются обратно без потерь.

type Summary = {
  projects: number
  tasks: number
  documents: number
  messages: number
  files: number
  filesBytes: number
  storage: { projectsWithOwnStorage: number; projectsTotal: number; canUploadToOwnStorage: boolean }
}

const fmtBytes = (n: number) => {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

export function BackupTab({ company }: { company: Company }) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const [password, setPassword] = useState('')
  const [importPassword, setImportPassword] = useState('')
  const [targetProject, setTargetProject] = useState('')
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const summary = useQuery({
    queryKey: ['backup-summary', company.id],
    queryFn: () => api<Summary>(`/api/v1/backup/${company.id}/summary`),
  })
  const projects = useQuery({
    queryKey: ['projects', company.id],
    queryFn: () => api<ProjectListItem[]>(`/api/v1/projects?companyId=${company.id}`),
  })

  // скачивание идёт через fetch: нужен заголовок авторизации
  const download = async () => {
    setBusy(true)
    try {
      const res = await fetch(`${API_URL}/api/v1/backup/${company.id}/export`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getSessionToken()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ includeSecrets: Boolean(password), password: password || undefined }),
      })
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText)
      const blob = await res.blob()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `chatick-backup-${company.name.replace(/[^\w-]+/g, '_')}-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(a.href)
      toast.success(t('backup.downloaded'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const toStorage = useMutation({
    mutationFn: () =>
      api<{ key: string; bytes: number }>(`/api/v1/backup/${company.id}/backup-to-storage`, {
        method: 'POST',
        body: JSON.stringify({ projectId: targetProject, password: password || undefined }),
      }),
    onSuccess: (r) => toast.success(t('backup.uploaded', { size: fmtBytes(r.bytes) })),
    onError: (e: unknown) => {
      const err = e as { body?: { hint?: string }; message?: string }
      toast.error(err.body?.hint ?? err.message ?? String(e))
    },
  })

  const runImport = async (file: File) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(await file.text())
    } catch {
      toast.error(t('backup.notABackup'))
      return
    }
    const ok = await confirm({
      title: t('backup.importConfirmTitle'),
      description: t('backup.importConfirmText'),
      confirmLabel: t('backup.importAction'),
    })
    if (!ok) return

    setBusy(true)
    try {
      const r = await api<{ companyId: string; created: Record<string, number>; warnings: string[] }>(
        '/api/v1/backup/import',
        { method: 'POST', body: JSON.stringify({ backup: parsed, password: importPassword || undefined }) },
      )
      const total = Object.entries(r.created)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ')
      toast.success(t('backup.imported'))
      if (r.warnings?.length) r.warnings.forEach((w) => toast.warning(w))
      console.info('[backup] imported:', total)
      // компания новая — перечитываем список
      setTimeout(() => window.location.reload(), 1200)
    } catch (e) {
      const err = e as { body?: { needPassword?: boolean; error?: string }; message?: string }
      toast.error(err.body?.needPassword ? t('backup.needPassword') : (err.body?.error ?? err.message ?? String(e)))
    } finally {
      setBusy(false)
    }
  }

  const s = summary.data
  const ownStorage = s?.storage.canUploadToOwnStorage ?? false

  return (
    <div className="space-y-5">
      <div>
        <h2 className="flex items-center gap-2 text-base font-bold">
          <HardDriveDownload className="size-4" />
          {t('backup.title')}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('backup.subtitle')}</p>
      </div>

      {/* Что внутри архива */}
      <section className="rounded-xl border bg-card p-4">
        <h3 className="text-sm font-semibold">{t('backup.contents')}</h3>
        {s ? (
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-3">
            {(
              [
                ['projects', s.projects],
                ['tasks', s.tasks],
                ['documents', s.documents],
                ['messages', s.messages],
                ['files', `${s.files} (${fmtBytes(s.filesBytes)})`],
              ] as const
            ).map(([key, value]) => (
              <div key={key} className="flex items-baseline justify-between gap-2 border-b border-dashed pb-1">
                <dt className="text-muted-foreground">{t(`backup.item.${key}`)}</dt>
                <dd className="font-medium tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">…</p>
        )}
        <p className="mt-3 text-xs text-muted-foreground">{t('backup.filesNote')}</p>
      </section>

      {/* Пароль для секретов */}
      <section className="rounded-xl border bg-card p-4">
        <h3 className="text-sm font-semibold">{t('backup.secretsTitle')}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{t('backup.secretsHint')}</p>
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t('backup.passwordPlaceholder')}
          className="mt-3 max-w-sm"
        />
        {password.length > 0 && password.length < 8 && (
          <p className="mt-1 text-xs text-destructive">{t('backup.passwordShort')}</p>
        )}
      </section>

      {/* Скачать */}
      <section className="rounded-xl border bg-card p-4">
        <h3 className="text-sm font-semibold">{t('backup.downloadTitle')}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{t('backup.downloadHint')}</p>
        <Button variant="brand" className="mt-3" disabled={busy} onClick={download}>
          <Download className="size-4" />
          {t('backup.downloadAction')}
        </Button>
      </section>

      {/* В своё хранилище */}
      <section className="rounded-xl border bg-card p-4">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <CloudUpload className="size-4" />
          {t('backup.storageTitle')}
        </h3>
        {ownStorage ? (
          <>
            <p className="mt-1 text-xs text-muted-foreground">{t('backup.storageHint')}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Select value={targetProject || 'none'} onValueChange={(v) => setTargetProject(v === 'none' ? '' : v)}>
                <SelectTrigger className="w-auto min-w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('backup.pickProject')}</SelectItem>
                  {(projects.data ?? []).map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="outline" disabled={!targetProject || toStorage.isPending} onClick={() => toStorage.mutate()}>
                <CloudUpload className="size-4" />
                {t('backup.uploadAction')}
              </Button>
            </div>
          </>
        ) : (
          // Главное сообщение вкладки: пока хранилище наше, бэкап лежит у нас
          <div className="mt-2 flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
            <p className="text-xs">{t('backup.noOwnStorage')}</p>
          </div>
        )}
      </section>

      {/* Импорт */}
      <section className="rounded-xl border bg-card p-4">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <Upload className="size-4" />
          {t('backup.importTitle')}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">{t('backup.importHint')}</p>
        <Input
          type="password"
          value={importPassword}
          onChange={(e) => setImportPassword(e.target.value)}
          placeholder={t('backup.importPasswordPlaceholder')}
          className="mt-3 max-w-sm"
        />
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            if (e.target.files?.[0]) void runImport(e.target.files[0])
            e.target.value = ''
          }}
        />
        <Button variant="outline" className="mt-3" disabled={busy} onClick={() => fileRef.current?.click()}>
          <Upload className="size-4" />
          {t('backup.importAction')}
        </Button>
      </section>
    </div>
  )
}
