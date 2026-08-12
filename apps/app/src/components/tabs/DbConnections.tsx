import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Check, Copy, Database, Loader2, Play, Plus, RefreshCw, Search, Trash2, TriangleAlert } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useConfirm } from '@/components/ui/confirm'

// Подключения к внешним БД проекта (шаг 1: только чтение).
//
// Живёт внутри «Ресурсов», а не отдельной вкладкой: база — такой же ресурс
// проекта, как доступ к Figma или серверу. Отдельная вкладка ради фичи, которая
// у большинства проектов выключена, — лишний шум в панели у всех.

type Conn = {
  id: string
  name: string
  kind: 'postgres' | 'mysql'
  host: string
  database: string
  writeEnabled: boolean
  checkedAt: string | null
  lastError: string | null
  tablesTotal: number
  tablesReadable: number
}

type TableInfo = {
  schema: string
  table: string
  columns: { name: string; type: string }[]
  canRead: boolean
  canWrite: boolean
  hiddenColumns: string[]
}

export function DbConnections({ projectId }: { projectId: string }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const [adding, setAdding] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)

  const q = useQuery({
    queryKey: ['db-connections', projectId],
    // Фича выключена — сервер отвечает 404, и это норма, а не ошибка.
    retry: false,
    queryFn: () =>
      api<{ items: Conn[]; outboundIp: string; canManage: boolean }>('/api/v1/db-connections', {}, 'project'),
  })

  // Выключена или недоступна — секции просто нет.
  if (q.isError || !q.data) return null

  const { items, outboundIp, canManage } = q.data
  const refresh = () => qc.invalidateQueries({ queryKey: ['db-connections', projectId] })

  return (
    <section className="mt-6 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <Database className="size-3.5" />
          {t('db.title')}
          {items.length > 0 && <span className="tabular-nums text-muted-foreground">({items.length})</span>}
        </h3>
        {canManage && !adding && (
          <Button variant="ghost" size="sm" className="gap-1 text-xs" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" />
            {t('db.add')}
          </Button>
        )}
      </div>

      {!items.length && !adding && <p className="text-xs text-muted-foreground">{t('db.empty')}</p>}

      {adding && <AddForm projectId={projectId} outboundIp={outboundIp} onDone={() => { setAdding(false); refresh() }} />}

      {items.map((c) => (
        <div key={c.id} className="rounded-lg border">
          <div className="flex items-center gap-2 px-3 py-2">
            <Database className="size-3.5 shrink-0 text-muted-foreground" />
            <button
              type="button"
              onClick={() => setOpenId(openId === c.id ? null : c.id)}
              className="flex min-w-0 flex-1 items-baseline gap-2 text-start"
            >
              <span className="truncate text-sm font-medium">{c.name}</span>
              <span className="truncate text-[11px] text-muted-foreground">
                {c.kind} · {c.host}/{c.database}
              </span>
            </button>
            {/* Сколько таблиц открыто. Ноль — читать нечего, и это видно сразу. */}
            <span
              className={cn(
                'shrink-0 rounded px-1.5 py-0.5 text-[11px] tabular-nums',
                c.tablesReadable ? 'bg-brand/15 text-brand-ink' : 'bg-secondary text-muted-foreground',
              )}
              title={t('db.readableHint')}
            >
              {c.tablesReadable}/{c.tablesTotal}
            </span>
            {canManage && (
              <button
                type="button"
                title={t('files.delete')}
                onClick={async () => {
                  if (await confirm({ title: t('db.deleteConfirm', { name: c.name }), destructive: true, confirmLabel: t('files.delete') })) {
                    await api(`/api/v1/db-connections/${c.id}`, { method: 'DELETE' }, 'project')
                    refresh()
                  }
                }}
                className="shrink-0 rounded p-1 text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
              </button>
            )}
          </div>

          {c.lastError && (
            <p className="flex items-start gap-1.5 border-t px-3 py-1.5 text-[11px] text-destructive">
              <TriangleAlert className="mt-px size-3 shrink-0" />
              {c.lastError}
            </p>
          )}

          {openId === c.id && <ConnectionDetail conn={c} canManage={canManage} onChanged={refresh} />}
        </div>
      ))}
    </section>
  )
}

/** Форма подключения. Наш адрес показываем сразу — его надо открыть у себя. */
function AddForm({ projectId, outboundIp, onDone }: { projectId: string; outboundIp: string; onDone: () => void }) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'postgres' | 'mysql'>('postgres')
  const [dsn, setDsn] = useState('')
  const [copied, setCopied] = useState(false)

  const create = useMutation({
    mutationFn: () =>
      api('/api/v1/db-connections', { method: 'POST', body: JSON.stringify({ name, kind, dsn }) }, 'project'),
    onSuccess: () => {
      toast.success(t('db.added'))
      onDone()
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('db.namePlaceholder')} className="flex-1" />
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as 'postgres' | 'mysql')}
          className="rounded-md border bg-background px-2 text-sm"
        >
          <option value="postgres">PostgreSQL</option>
          <option value="mysql">MySQL</option>
        </select>
      </div>
      <Input
        value={dsn}
        onChange={(e) => setDsn(e.target.value)}
        placeholder="postgres://user:password@host:5432/dbname"
        className="font-mono text-xs"
      />

      {/* Без этого адреса подключиться нельзя: чужая БД закрыта снаружи, и
          первое, обо что спотыкаются, — «почему не коннектится». */}
      <div className="flex items-center gap-2 rounded-md bg-secondary/60 px-2 py-1.5 text-[11px]">
        <span className="text-muted-foreground">{t('db.ipHint')}</span>
        <code className="font-mono font-semibold">{outboundIp}</code>
        <button
          type="button"
          onClick={async () => {
            await navigator.clipboard.writeText(outboundIp).catch(() => {})
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
          className="ms-auto rounded p-0.5 text-muted-foreground hover:text-foreground"
        >
          {copied ? <Check className="size-3 text-brand-ink" /> : <Copy className="size-3" />}
        </button>
      </div>

      <p className="text-[11px] leading-snug text-muted-foreground">{t('db.readOnlyNote')}</p>

      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onDone}>
          {t('files.cancel')}
        </Button>
        <Button variant="brand" size="sm" disabled={!name.trim() || !dsn.trim() || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
          {t('db.connect')}
        </Button>
      </div>
    </div>
  )
}

/** Таблицы и пробный запрос. */
function ConnectionDetail({ conn, canManage, onChanged }: { conn: Conn; canManage: boolean; onChanged: () => void }) {
  const { t } = useTranslation()
  const [tables, setTables] = useState<TableInfo[] | null>(null)
  // Поиск по таблицам: у базы их бывает полсотни, и глазами нужную не найти.
  const [tq, setTq] = useState('')
  const [sqlText, setSqlText] = useState('')
  const [result, setResult] = useState<{ columns: string[]; rows: Record<string, unknown>[]; truncated: boolean; ms: number } | null>(null)

  const scan = useMutation({
    mutationFn: () => api<{ tables: TableInfo[] }>(`/api/v1/db-connections/${conn.id}/introspect`, { method: 'POST' }, 'project'),
    onSuccess: (r) => {
      setTables(r.tables)
      onChanged()
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const toggle = useMutation({
    mutationFn: (v: { schema: string; table: string; canRead: boolean }) =>
      api(`/api/v1/db-connections/${conn.id}/tables`, { method: 'PATCH', body: JSON.stringify(v) }, 'project'),
    onSuccess: onChanged,
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  /**
   * Отметить/снять/инвертировать пачкой.
   *
   * Одним запросом, а не циклом по таблицам: полсотни обращений подряд
   * успевают разойтись с тем, что человек видит на экране. И действует на
   * НАЙДЕННЫЕ поиском таблицы — «снять все» при активном фильтре означает
   * «снять найденные», иначе фильтр был бы ловушкой.
   */
  const bulk = useMutation({
    mutationFn: (canRead: boolean | 'invert') =>
      api<{ readable: number; total: number }>(
        `/api/v1/db-connections/${conn.id}/tables/bulk`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            canRead,
            tables: shown.map((x) => ({ schema: x.schema, table: x.table })),
          }),
        },
        'project',
      ),
    onSuccess: () => {
      setTables((cur) =>
        cur?.map((x) =>
          shownKeys.has(`${x.schema}.${x.table}`)
            ? { ...x, canRead: pending === 'invert' ? !x.canRead : (pending as boolean) }
            : x,
        ) ?? null,
      )
      onChanged()
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })
  const [pending, setPending] = useState<boolean | 'invert'>(false)
  const applyBulk = (v: boolean | 'invert') => {
    setPending(v)
    bulk.mutate(v)
  }

  const run = useMutation({
    mutationFn: () =>
      api<{ columns: string[]; rows: Record<string, unknown>[]; truncated: boolean; ms: number }>(
        `/api/v1/db-connections/${conn.id}/read`,
        { method: 'POST', body: JSON.stringify({ sql: sqlText }) },
        'project',
      ),
    onSuccess: setResult,
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  // Ищем и по имени таблицы, и по схеме: в чужой базе таблицы часто разложены
  // по схемам, и «найти всё из billing» — обычный запрос.
  const needle = tq.trim().toLowerCase()
  const shown = (tables ?? []).filter(
    (x) => !needle || x.table.toLowerCase().includes(needle) || x.schema.toLowerCase().includes(needle),
  )
  const shownKeys = new Set(shown.map((x) => `${x.schema}.${x.table}`))

  return (
    <div className="space-y-3 border-t p-3">
      {canManage && (
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="gap-1.5 text-xs" disabled={scan.isPending} onClick={() => scan.mutate()}>
            {scan.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            {t('db.scan')}
          </Button>
          <span className="text-[11px] text-muted-foreground">{t('db.scanHint')}</span>
        </div>
      )}

      {tables && (
        <>
          <div className="flex items-center gap-1.5">
            <div className="relative min-w-0 flex-1">
              <Search className="absolute start-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
              <input
                value={tq}
                onChange={(e) => setTq(e.target.value)}
                placeholder={t('db.searchTables')}
                className="w-full rounded-md border bg-transparent py-1 pe-2 ps-6 text-xs outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            {canManage && (
              <>
                {/* Три действия вместо одной галочки «выбрать всё»: снять,
                    отметить и инвертировать — разные намерения, и «инвертировать»
                    после поиска экономит больше всего кликов. */}
                <Button variant="outline" size="sm" className="h-7 px-2 text-[11px]" disabled={bulk.isPending} onClick={() => applyBulk(true)}>
                  {t('db.selectAll')}
                </Button>
                <Button variant="outline" size="sm" className="h-7 px-2 text-[11px]" disabled={bulk.isPending} onClick={() => applyBulk(false)}>
                  {t('db.selectNone')}
                </Button>
                <Button variant="outline" size="sm" className="h-7 px-2 text-[11px]" disabled={bulk.isPending} onClick={() => applyBulk('invert')} title={t('db.invertHint')}>
                  {t('db.invert')}
                </Button>
              </>
            )}
          </div>
          {/* Сколько нашлось и сколько открыто — чтобы «снять все» не оказалось
              неожиданностью при активном фильтре. */}
          <p className="text-[11px] text-muted-foreground">
            {t('db.foundTables', { shown: shown.length, total: tables.length, readable: tables.filter((x) => x.canRead).length })}
          </p>
        <div className="max-h-64 space-y-0.5 overflow-y-auto rounded-md border p-1.5">
          {shown.length === 0 && <p className="px-1.5 py-2 text-xs text-muted-foreground">{t('start.nothingFound')}</p>}
          {shown.map((tb) => {
            const full = tb.schema === 'public' ? tb.table : `${tb.schema}.${tb.table}`
            return (
              <label
                key={full}
                className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs transition-colors hover:bg-accent"
              >
                <input
                  type="checkbox"
                  checked={tb.canRead}
                  disabled={!canManage}
                  onChange={(e) => {
                    setTables((cur) => cur?.map((x) => (x.table === tb.table && x.schema === tb.schema ? { ...x, canRead: e.target.checked } : x)) ?? null)
                    toggle.mutate({ schema: tb.schema, table: tb.table, canRead: e.target.checked })
                  }}
                  className="size-3.5"
                />
                <span className="font-mono">{full}</span>
                <span className="truncate text-[10px] text-muted-foreground">
                  {tb.columns.length} {t('db.columns')}
                </span>
              </label>
            )
          })}
        </div>

          {/* Явное завершение настройки.
              Галочки сохраняются сразу, но по одному этому не понять,
              закончен конфиг или нет: панель просто висит открытой. Кнопка
              закрывает список и подводит итог — сколько таблиц открыто. */}
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">
              {tables.filter((x) => x.canRead).length > 0
                ? t('db.readyHint', { count: tables.filter((x) => x.canRead).length })
                : t('db.noneSelectedHint')}
            </span>
            <Button variant="brand" size="sm" className="h-7 gap-1.5 px-2.5 text-xs" onClick={() => { setTables(null); setTq('') }}>
              <Check className="size-3.5" />
              {t('db.doneSelecting')}
            </Button>
          </div>
        </>
      )}

      {/* Пробный запрос — чтобы человек убедился, что видно то, что нужно, а
          не выяснял это через ассистента. */}
      {conn.tablesReadable > 0 && (
        <div className="space-y-2">
          <textarea
            value={sqlText}
            onChange={(e) => setSqlText(e.target.value)}
            placeholder="select * from ... limit 10"
            rows={2}
            className="w-full rounded-md border bg-transparent px-2 py-1.5 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
          />
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="gap-1.5 text-xs" disabled={!sqlText.trim() || run.isPending} onClick={() => run.mutate()}>
              {run.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
              {t('db.run')}
            </Button>
            <span className="text-[11px] text-muted-foreground">{t('db.readOnlyNote')}</span>
          </div>

          {result && (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-[11px]">
                <thead className="border-b bg-secondary/50">
                  <tr>
                    {result.columns.map((col) => (
                      <th key={col} className="px-2 py-1 text-start font-medium">{col}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, i) => (
                    <tr key={i} className="border-b last:border-0">
                      {result.columns.map((col) => (
                        <td key={col} className="max-w-[16rem] truncate px-2 py-1 font-mono">
                          {row[col] === null ? <span className="text-muted-foreground">null</span> : String(row[col])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="px-2 py-1 text-[10px] text-muted-foreground">
                {t('db.rowsInfo', { count: result.rows.length, ms: result.ms })}
                {result.truncated && ` · ${t('db.truncated')}`}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
