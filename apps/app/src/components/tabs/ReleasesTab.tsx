import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  ArrowRight,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  ChevronsUpDown,
  ExternalLink,
  Package,
  Pencil,
  Plus,
  Rocket,
  Search,
  Send,
  X,
} from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckItem,
} from '@/components/ui/dropdown-menu'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { Combobox } from '@/components/ui/combobox'
import { ExpoIntegration, ExpoMark } from '@/components/tabs/ExpoIntegration'
import { PeoplePicker } from '@/components/ui/people-picker'

// Версии проекта (SPEC §8.46).
//
// Экран отвечает на вопрос, который сейчас задают голосом: «какая версия в
// проде». Поэтому сводка стоит первой и читается без прокрутки, а список —
// уже под ней.

type StageTone = 'neutral' | 'testing' | 'waiting' | 'live'
type Stage = { key: string; label: string; live?: boolean; hint?: string; tone?: StageTone }

/**
 * Цвет стадии. Тон приходит с сервера — там он один на всю систему, чтобы
 * «ждём проверки» не оказалось жёлтым в списке и серым на странице.
 *
 * Смысл цветов: серый — идёт работа, синий — у тестировщиков, жёлтый — ждём
 * не себя (магазин проверяет), зелёный — доехало до людей.
 */
const STAGE_TONE: Record<StageTone, string> = {
  neutral: 'bg-muted text-muted-foreground',
  testing: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200',
  waiting: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  live: 'bg-brand font-medium text-brand-foreground',
}

/** Тон стадии по её ключу: сервер знает лестницу, клиент — только цвета. */
function toneOf(stages: Stage[], key: string, isLive: boolean): string {
  const tone = stages.find((s) => s.key === key)?.tone
  return STAGE_TONE[tone ?? (isLive ? 'live' : 'neutral')]
}

/**
 * Профили сборки. Ровно те, что у Expo по умолчанию.
 *
 * Отдельно от стадии: профиль отвечает «чем собрали», стадия — «куда доехало».
 * Одна и та же production-сборка проходит и TestFlight, и магазин.
 */
const BUILD_PROFILES = ['development', 'preview', 'production'] as const
type BuildTypeDef = { key: string; label: string; stages: Stage[] }

type Release = {
  id: string
  version: string
  appName: string | null
  buildType: string
  buildTypeLabel: string
  status: string
  statusLabel: string
  isLive: boolean
  owner: { id: string; name: string; avatarUrl: string | null } | null
  buildProfile: string | null
  referenceUrl: string | null
  buildPageUrl: string | null
  notes: string | null
  releasedAt: string | null
  tasks: { id: string; number: string; title: string; status: string }[]
  createdAt: string
}

type ReleaseEvent = {
  id: string
  status: string
  fromStatus: string | null
  statusLabel: string
  comment: string
  actor: { id: string; name: string; avatarUrl: string | null } | null
  createdAt: string
}

export function ReleasesTab({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [asking, setAsking] = useState(false)
  const [staging, setStaging] = useState<{ release: Release; status: string } | null>(null)
  // Фильтры: по типу сборки и по строке. Полсотни версий на четырёх
  // платформах — это уже список, в котором ищут, а не читают подряд.
  const [typeFilter, setTypeFilter] = useState('')
  const [q, setQ] = useState('')
  const navigate = useNavigate()
  const { companyId } = useParams()

  const list = useQuery({
    queryKey: ['releases', projectId],
    queryFn: () =>
      api<{
        items: Release[]
        live: Record<string, { version: string; appName: string | null; buildType: string; id: string }>
      }>('/api/v1/releases', {}, 'project'),
  })
  const types = useQuery({
    queryKey: ['release-build-types', projectId],
    queryFn: () => api<{ buildTypes: BuildTypeDef[] }>('/api/v1/releases/build-types', {}, 'project'),
    // Лестницы зашиты в код сервера и между запросами не меняются.
    staleTime: Infinity,
  })

  const byType = useMemo(() => new Map((types.data?.buildTypes ?? []).map((b) => [b.key, b])), [types.data])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (list.data?.items ?? []).filter((r) => {
      if (typeFilter && r.buildType !== typeFilter) return false
      if (!needle) return true
      // Ищем и по заметкам: «что вошло в 1.4» вспоминают словами, а не номером.
      return (
        r.version.toLowerCase().includes(needle) ||
        (r.notes ?? '').toLowerCase().includes(needle) ||
        r.tasks.some((t) => t.number.toLowerCase().includes(needle))
      )
    })
  }, [list.data, typeFilter, q])

  const patchRelease = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) =>
      api(`/api/v1/releases/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }, 'project'),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['releases', projectId] }),
    onError: (e: { message?: string }) => toast.error(e.message || t('common.error')),
  })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-2">
        <h2 className="text-sm font-semibold">{t('releases.title')}</h2>
        <div className="flex items-center gap-2">
          <ExpoIntegration projectId={projectId} canManage={canManage} />
        {canManage && (
          <div className="flex items-center gap-2">
            {/* Запросить — первым и заметнее: менеджер приходит сюда просить
                сборку, а регистрировать уже собранное — дело более редкое. */}
            <Button size="sm" className="gap-1" onClick={() => setAsking(true)}>
              <Send className="size-3.5" />
              {t('releases.request')}
            </Button>
            <Button size="sm" variant="outline" className="gap-1" onClick={() => setCreating(true)}>
              <Plus className="size-3.5" />
              {t('releases.create')}
            </Button>
          </div>
        )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {/* Сводка — то, ради чего открывают вкладку. Пустая не рисуется:
            рамка с надписью «пока ничего» отвечает не на тот вопрос. */}
        {Object.keys(list.data?.live ?? {}).length > 0 && (
          <div className="mb-4 rounded-lg border bg-brand/5 p-3">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
              <Rocket className="size-3.5" />
              {t('releases.liveNow')}
            </div>
            {/* Ключ в ответе — приложение + тип сборки, поэтому клиент и
                провайдер под одной платформой стоят рядом, а не затирают друг
                друга. Подпись — «Клиент · iOS», если приложений несколько. */}
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              {Object.entries(list.data!.live).map(([key, info]) => (
                <button
                  key={key}
                  onClick={() => navigate(`/c/${companyId}/p/${projectId}/releases/${info.id}`)}
                  className="text-start transition-opacity hover:opacity-70"
                >
                  <div className="text-[11px] text-muted-foreground">
                    {[info.appName, byType.get(info.buildType)?.label ?? info.buildType].filter(Boolean).join(' · ')}
                  </div>
                  <div className="text-sm font-semibold">{info.version}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Фильтры показываем, когда есть что фильтровать: на трёх версиях
            панель занимает место и не помогает. */}
        {(list.data?.items.length ?? 0) > 5 && (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="relative min-w-48 flex-1">
              <Search className="pointer-events-none absolute start-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t('releases.search')}
                className="h-8 ps-7 text-sm"
              />
            </div>
            <div className="inline-flex overflow-hidden rounded-md border">
              <button
                onClick={() => setTypeFilter('')}
                className={cn(
                  'px-2 py-1 text-xs transition-colors',
                  !typeFilter ? 'bg-primary text-primary-foreground' : 'hover:bg-accent',
                )}
              >
                {t('releases.allTypes')}
              </button>
              {/* Только те типы, что реально встречаются: кнопка на пустой
                  фильтр обещает результат, которого нет. */}
              {(types.data?.buildTypes ?? [])
                .filter((b) => (list.data?.items ?? []).some((r) => r.buildType === b.key))
                .map((b) => (
                  <button
                    key={b.key}
                    onClick={() => setTypeFilter(typeFilter === b.key ? '' : b.key)}
                    className={cn(
                      'border-s px-2 py-1 text-xs transition-colors',
                      typeFilter === b.key ? 'bg-primary text-primary-foreground' : 'hover:bg-accent',
                    )}
                  >
                    {b.label}
                  </button>
                ))}
            </div>
          </div>
        )}

        {list.isLoading ? (
          <div className="py-10 text-center text-sm text-muted-foreground">{t('common.loading')}</div>
        ) : list.isError ? (
          /* Ошибку не выдаём за пустоту: «версий пока нет» на упавшем запросе
             читается как факт о проекте, и человек идёт заводить вторую
             версию поверх существующей. */
          <div className="py-10 text-center text-sm text-muted-foreground">
            {(list.error as { message?: string } | null)?.message || t('common.error')}
          </div>
        ) : !filtered.length && list.data?.items.length ? (
          /* Отфильтровали в ноль — это не «версий нет»: иначе человек решит,
             что их и не заводили, и пойдёт создавать дубль. */
          <div className="py-10 text-center text-sm text-muted-foreground">{t('releases.nothingFound')}</div>
        ) : !list.data?.items.length ? (
          <div className="py-10 text-center">
            <Package className="mx-auto mb-2 size-8 text-muted-foreground/40" />
            <div className="text-sm text-muted-foreground">{t('releases.empty')}</div>
          </div>
        ) : (
          <ReleasesTable
            items={filtered}
            buildTypes={types.data?.buildTypes ?? []}
            canManage={canManage}
            locale={i18n.language}
            onOpen={(id) => navigate(`/c/${companyId}/p/${projectId}/releases/${id}`)}
            onOpenTask={(taskId) => navigate(`/c/${companyId}/p/${projectId}/tasks/${taskId}`)}
            onStage={(release, status) => setStaging({ release, status })}
            onPatch={(id, patch) => patchRelease.mutate({ id, patch })}
          />
        )}
      </div>

      {asking && (
        <RequestDialog
          projectId={projectId}
          buildTypes={types.data?.buildTypes ?? []}
          onClose={() => setAsking(false)}
          onDone={() => {
            setAsking(false)
            void qc.invalidateQueries({ queryKey: ['releases', projectId] })
          }}
        />
      )}
      {creating && (
        <CreateDialog
          projectId={projectId}
          buildTypes={types.data?.buildTypes ?? []}
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false)
            void qc.invalidateQueries({ queryKey: ['releases', projectId] })
          }}
        />
      )}
      {staging && (
        <StagePrompt
          release={staging.release}
          status={staging.status}
          statusLabel={
            (types.data?.buildTypes ?? [])
              .find((b) => b.key === staging.release.buildType)
              ?.stages.find((st) => st.key === staging.status)?.label ?? staging.status
          }
          projectId={projectId}
          onClose={() => setStaging(null)}
          onDone={() => {
            setStaging(null)
            void qc.invalidateQueries({ queryKey: ['releases', projectId] })
          }}
        />
      )}
    </div>
  )
}

type SortKey = 'app' | 'version' | 'buildType' | 'profile' | 'status' | 'created' | 'released' | 'tasks'
type SortDir = 'asc' | 'desc'

/**
 * Список версий таблицей, как задачи.
 *
 * Карточками он и читался хуже, и не давал главного: сравнить версии между
 * собой. «Что где сейчас» — вопрос про столбец, а не про десять карточек,
 * каждую из которых надо прочитать целиком.
 */
function ReleasesTable({
  items,
  buildTypes,
  canManage,
  locale,
  onOpen,
  onOpenTask,
  onStage,
  onPatch,
}: {
  items: Release[]
  buildTypes: BuildTypeDef[]
  canManage: boolean
  locale: string
  onOpen: (id: string) => void
  onOpenTask: (taskId: string) => void
  onStage: (release: Release, status: string) => void
  onPatch: (id: string, patch: Record<string, unknown>) => void
}) {
  const { t } = useTranslation()
  // Та же подпись, что на странице версии: сервер отдаёт английскую, интерфейс
  // переводит по ключу стадии.
  const stageLabel = (key: string, fallback: string) => t(`releases.stage.${key}`, { defaultValue: fallback })
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir } | null>(null)

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s?.key === key ? (s.dir === 'asc' ? { key, dir: 'desc' } : null) : { key, dir: 'asc' }))

  const sorted = useMemo(() => {
    // Без сортировки — как пришло с сервера: новые сверху.
    if (!sort) return items
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...items].sort((a, b) => {
      let d = 0
      switch (sort.key) {
        case 'app':
          d = (a.appName ?? '').localeCompare(b.appName ?? '')
          break
        case 'version':
          // Численно по частям: «1.10» больше «1.9», а по алфавиту — наоборот.
          d = compareVersions(a.version, b.version)
          break
        case 'buildType':
          d = a.buildTypeLabel.localeCompare(b.buildTypeLabel)
          break
        case 'profile':
          d = (a.buildProfile ?? '').localeCompare(b.buildProfile ?? '')
          break
        case 'status':
          // По месту в лестнице своей платформы: «дальше уехало» — вот порядок,
          // который человек имеет в виду, а не алфавит ключей.
          d = stageIndex(buildTypes, a) - stageIndex(buildTypes, b)
          break
        case 'created':
          d = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
          break
        case 'released':
          d = new Date(a.releasedAt ?? 0).getTime() - new Date(b.releasedAt ?? 0).getTime()
          break
        case 'tasks':
          d = a.tasks.length - b.tasks.length
          break
      }
      return d * dir
    })
  }, [items, sort, buildTypes])

  const cols: { key: SortKey; label: string; className?: string }[] = [
    { key: 'app', label: t('releases.appName') },
    { key: 'version', label: t('releases.version') },
    { key: 'buildType', label: t('releases.buildType') },
    { key: 'profile', label: t('releases.buildProfile'), className: 'hidden md:table-cell' },
    { key: 'status', label: t('releases.status') },
    { key: 'tasks', label: t('releases.linkedTasks') },
    // Когда собрали — отдельно от «когда выкатили»: это разные даты, и
    // расходятся они на недели. В таблице стояла только вторая, а она у
    // большинства версий пуста — колонка была прочерками, и узнать, когда
    // собрали, было негде.
    { key: 'created', label: t('releases.createdAt'), className: 'hidden sm:table-cell' },
    { key: 'released', label: t('releases.releasedAt'), className: 'hidden lg:table-cell' },
    // Автора в таблице нет намеренно: здесь смотрят, ЧТО за версия и где она,
    // а не кто её завёл. Автор остался на странице версии, где он и к месту.
  ]

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full min-w-[720px] text-sm">
        <thead>
          <tr className="border-b bg-muted/40 text-xs text-muted-foreground">
            {cols.map((col) => (
              <th key={col.key} className={cn('px-2 py-1.5 text-start font-medium', col.className)}>
                <button
                  className="inline-flex items-center gap-1 whitespace-nowrap hover:text-foreground"
                  onClick={() => toggleSort(col.key)}
                >
                  {col.label}
                  {sort?.key === col.key ? (
                    sort.dir === 'asc' ? (
                      <ChevronUp className="size-3" />
                    ) : (
                      <ChevronDown className="size-3" />
                    )
                  ) : (
                    <ChevronsUpDown className="size-3 opacity-40" />
                  )}
                </button>
              </th>
            ))}
            <th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const stages = buildTypes.find((b) => b.key === r.buildType)?.stages ?? []
            return (
              /* Строка целиком ведёт на версию: попадать в один короткий
                 номер мышью неудобно, а по строке промахнуться нельзя.
                 Ячейки со своими действиями (стадия, задачи, ссылка) гасят
                 всплытие сами — иначе клик по ним уводил бы со страницы. */
              <tr
                key={r.id}
                onClick={() => onOpen(r.id)}
                className="group/row cursor-pointer border-b last:border-0 hover:bg-accent/40"
              >
                <td className="whitespace-nowrap px-2 py-1.5 align-middle text-xs">
                  {r.appName || <span className="text-muted-foreground">—</span>}
                </td>
                <td className="px-2 py-1.5 align-middle">
                  <div className="flex items-center gap-1">
                    <span className="font-semibold group-hover/row:text-brand-ink">{r.version}</span>
                    {canManage && (
                      <EditField
                        title={t('releases.version')}
                        value={r.version}
                        onSave={(v) => onPatch(r.id, { version: v })}
                      />
                    )}
                  </div>
                </td>
                <td className="whitespace-nowrap px-2 py-1.5 align-middle text-xs text-muted-foreground">
                  {r.buildTypeLabel}
                </td>
                {/* Профиль правится на месте: он меняется чаще, чем номер
                    версии, и ради него ходить на страницу незачем. */}
                <td className="hidden whitespace-nowrap align-middle md:table-cell" onClick={(e) => e.stopPropagation()}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        disabled={!canManage}
                        title={canManage ? t('releases.buildProfile') : undefined}
                        className={cn(
                          'inline-flex w-full items-center gap-1 px-2 py-1.5 text-start text-xs text-muted-foreground',
                          canManage ? 'cursor-pointer hover:bg-accent/60' : 'cursor-default',
                        )}
                      >
                        {r.buildProfile
                          ? t(`releases.profile.${r.buildProfile}`, { defaultValue: r.buildProfile })
                          : '—'}
                        {canManage && <ChevronDown className="size-3 shrink-0" />}
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      {BUILD_PROFILES.map((p) => (
                        <DropdownMenuCheckItem
                          key={p}
                          checked={p === r.buildProfile}
                          onSelect={() => onPatch(r.id, { buildProfile: p })}
                        >
                          {t(`releases.profile.${p}`, { defaultValue: p })}
                        </DropdownMenuCheckItem>
                      ))}
                      <DropdownMenuCheckItem
                        checked={!r.buildProfile}
                        onSelect={() => onPatch(r.id, { buildProfile: null })}
                      >
                        {t('releases.profileNone')}
                      </DropdownMenuCheckItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </td>
                {/* Стадия правится на месте, но через окно с комментарием:
                    он обязателен, и молча сменить стадию нельзя — иначе
                    пропадёт ответ на «почему версия неделю висит». */}
                <td className="whitespace-nowrap align-middle" onClick={(e) => e.stopPropagation()}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        disabled={!canManage}
                        title={canManage ? t('releases.changeStage') : undefined}
                        className={cn(
                          'inline-flex w-full items-center gap-1 px-2 py-1.5 text-start',
                          canManage ? 'cursor-pointer hover:bg-accent/60' : 'cursor-default',
                        )}
                      >
                        <span className={cn('rounded px-1.5 py-0.5 text-[11px]', toneOf(stages, r.status, r.isLive))}>
                          {stageLabel(r.status, r.statusLabel)}
                        </span>
                        {/* Стрелка — единственное, что отличает «просто ярлык»
                            от «нажми меня». Без неё стадию не пробуют менять:
                            бейдж выглядит подписью, а не кнопкой. */}
                        {canManage && <ChevronDown className="size-3 shrink-0 text-muted-foreground" />}
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      {stages.map((s) => (
                        <DropdownMenuCheckItem
                          key={s.key}
                          checked={s.key === r.status}
                          onSelect={() => s.key !== r.status && onStage(r, s.key)}
                        >
                          {/* Пояснение рядом: «Internal track» и «TestFlight» —
                              слова из документации магазинов, и выбирать по ним
                              вслепую приходится тому, кто их не знает. */}
                          <span className="flex flex-col items-start">
                            <span>{stageLabel(s.key, s.label)}</span>
                            {s.hint && <span className="text-[11px] text-muted-foreground">{s.hint}</span>}
                          </span>
                        </DropdownMenuCheckItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </td>
                {/* Задачи кликабельны: связь без перехода — просто надпись. */}
                <td className="px-2 py-1.5 align-middle" onClick={(e) => e.stopPropagation()}>
                  <div className="flex flex-wrap gap-1">
                    {r.tasks.map((task) => (
                      <button
                        key={task.id}
                        onClick={() => onOpenTask(task.id)}
                        title={task.title}
                        className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-secondary-foreground hover:bg-brand hover:text-brand-foreground"
                      >
                        {task.number}
                      </button>
                    ))}
                    {!r.tasks.length && <span className="text-xs text-muted-foreground">—</span>}
                  </div>
                </td>
                {/* Дата И время: в один день собирают по нескольку раз, и
                    без времени две сборки 27-го неотличимы. */}
                <td className="hidden whitespace-nowrap px-2 py-1.5 align-middle text-xs text-muted-foreground sm:table-cell">
                  {new Date(r.createdAt).toLocaleDateString(locale)}
                  <span className="ms-1 opacity-70">
                    {new Date(r.createdAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </td>
                <td className="hidden whitespace-nowrap px-2 py-1.5 align-middle text-xs text-muted-foreground lg:table-cell">
                  {r.releasedAt ? new Date(r.releasedAt).toLocaleDateString(locale) : '—'}
                </td>
                {/* Только переход по ссылке. Правка переехала на страницу
                    версии: в таблице столбца ссылки нет, и карандаш здесь
                    правил вслепую — результата было не увидеть. */}
                <td className="px-2 py-1.5 align-middle">
                  <div className="flex items-center justify-end gap-2">
                    {/* Страница сборки в EAS: логи и статус. Отдельно от
                        артефакта — когда сборка упала, скачивать нечего, а
                        логи и есть то единственное, что нужно. */}
                    {r.buildPageUrl && (
                      <a
                        href={r.buildPageUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        title={t('expo.openBuild')}
                        onClick={(e) => e.stopPropagation()}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <ExpoMark className="size-3.5" />
                      </a>
                    )}
                    {r.referenceUrl && (
                      <a
                        href={r.referenceUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        title={r.referenceUrl}
                        onClick={(e) => e.stopPropagation()}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <ExternalLink className="size-3.5" />
                      </a>
                    )}
                    {/* Шеврон в конце строки: без него строка выглядит как
                        данные, а не как переход, и в неё не тыкают.
                        В иврите разворачиваем: стрелка вправо там указывает
                        назад, то есть ровно в обратную сторону от перехода. */}
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground/60 group-hover/row:text-brand-ink rtl:rotate-180" />
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** «1.10.0» больше «1.9.0»: сравниваем числами по частям, а не строкой. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.\-+]/)
  const pb = b.split(/[.\-+]/)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = parseInt(pa[i] ?? '', 10)
    const nb = parseInt(pb[i] ?? '', 10)
    if (Number.isNaN(na) || Number.isNaN(nb)) {
      const d = (pa[i] ?? '').localeCompare(pb[i] ?? '')
      if (d) return d
    } else if (na !== nb) return na - nb
  }
  return 0
}

/** Насколько далеко версия уехала по своей лестнице. */
function stageIndex(buildTypes: BuildTypeDef[], r: Release): number {
  const stages = buildTypes.find((b) => b.key === r.buildType)?.stages ?? []
  const i = stages.findIndex((s) => s.key === r.status)
  return i < 0 ? 0 : i
}

/**
 * Смена стадии из списка: стадию уже выбрали, осталось объяснить почему.
 *
 * Отдельным окном, а не сразу: комментарий обязателен на сервере, и без него
 * человек получил бы отказ уже после нажатия.
 */
function StagePrompt({
  release,
  status,
  statusLabel,
  onClose,
  onDone,
  projectId,
}: {
  release: Release
  status: string
  statusLabel: string
  projectId: string
  onClose: () => void
  onDone: () => void
}) {
  const { t } = useTranslation()
  const [comment, setComment] = useState('')
  const move = useMutation({
    mutationFn: () =>
      api(
        `/api/v1/releases/${release.id}/stage`,
        { method: 'POST', body: JSON.stringify({ status, comment: comment.trim() }) },
        'project',
      ),
    onSuccess: onDone,
    onError: (e: { message?: string }) => toast.error(e.message || t('common.error')),
  })

  return (
    <Overlay onClose={onClose} title={`${release.version} → ${statusLabel}`}>
      <label className="mb-1 block text-xs text-muted-foreground">{t('releases.commentRequired')}</label>
      <Input value={comment} onChange={(e) => setComment(e.target.value)} autoFocus />
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button disabled={!comment.trim() || move.isPending} onClick={() => move.mutate()}>
          {t('releases.moveStage')}
        </Button>
      </div>
    </Overlay>
  )
}

/**
 * Правка одного поля в поповере, а не инлайн-полем в ячейке.
 *
 * По той же причине, что у номеров задачи: поле, раскрывающееся прямо в узкой
 * колонке, раздвигает строку и уводит соседние ячейки, а попасть по нему
 * мышью почти нечем.
 */
function EditField({
  title,
  value,
  placeholder,
  onSave,
}: {
  title: string
  value: string
  placeholder?: string
  onSave: (next: string) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(value)

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) setDraft(value)
      }}
    >
      <PopoverTrigger asChild>
        <button
          title={t('common.edit')}
          // Карандаш гасит клик сам: строка целиком ведёт на версию, и правка
          // номера не должна уводить со списка.
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/row:opacity-100"
        >
          <Pencil className="size-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2" align="start">
        <label className="mb-1 block text-xs text-muted-foreground">{title}</label>
        <Input
          value={draft}
          placeholder={placeholder}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              onSave(draft)
              setOpen(false)
            }
            if (e.key === 'Escape') setOpen(false)
          }}
        />
        <div className="mt-2 flex justify-end gap-1">
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              onSave(draft)
              setOpen(false)
            }}
          >
            {t('common.save')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function RequestDialog({
  projectId,
  buildTypes,
  onClose,
  onDone,
}: {
  projectId: string
  buildTypes: BuildTypeDef[]
  onClose: () => void
  onDone: () => void
}) {
  const { t } = useTranslation()
  const [version, setVersion] = useState('')
  const [type, setType] = useState('')
  const [assigneeId, setAssigneeId] = useState('')
  const [appName, setAppName] = useState('')
  const [profile, setProfile] = useState('')
  const [comment, setComment] = useState('')

  const members = useQuery({
    queryKey: ['project-members', projectId],
    queryFn: () =>
      api<{ user: { id: string; name: string; avatarUrl: string | null } }[]>(
        `/api/v1/projects/${projectId}/members`,
      ),
  })

  const ask = useMutation({
    mutationFn: () =>
      api<{ task: { number: string }; release: { version: string } }>(
        '/api/v1/releases/request',
        {
          method: 'POST',
          body: JSON.stringify({
            version: version.trim(),
            appName: appName.trim(),
            buildType: type,
            assigneeId: assigneeId || null,
            buildProfile: profile || null,
            comment: comment.trim() || undefined,
          }),
        },
        'project',
      ),
    onSuccess: (r) => {
      // Говорим номер задачи: именно по нему человек потом ищет поручение.
      toast.success(t('releases.requested', { task: r.task.number }))
      onDone()
    },
    onError: (e: { message?: string }) => toast.error(e.message || t('common.error')),
  })

  return (
    <Overlay onClose={onClose} title={t('releases.request')}>
      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">{t('releases.whoBuilds')}</label>
          {/* PeoplePicker, а не Combobox: человека узнают по лицу быстрее, чем
              по строке, и в списке из двадцати это разница между «нашёл» и
              «прочитал двадцать имён». Поиск здесь тоже есть. */}
          <PeoplePicker
            people={(members.data ?? []).map((m) => ({
              id: m.user.id,
              name: m.user.name,
              avatarUrl: m.user.avatarUrl,
            }))}
            value={assigneeId ? [assigneeId] : []}
            onChange={(ids) => setAssigneeId(ids[0] ?? '')}
            placeholder={t('releases.pickPerson')}
            single
            clearLabel={t('releases.noAssignee')}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">{t('releases.buildType')}</label>
          <Combobox
            options={buildTypes.map((b) => ({
              value: b.key,
              label: b.label,
              hint: b.stages.map((st) => st.label).join(' → '),
            }))}
            value={type}
            onChange={setType}
            placeholder={t('releases.buildTypePick')}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">{t('releases.appName')}</label>
          <Input
            value={appName}
            onChange={(e) => setAppName(e.target.value)}
            placeholder={t('releases.appNameHint')}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">{t('releases.version')}</label>
          <Input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="1.4.0" />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            {t('releases.buildProfile')} <span className="text-muted-foreground/70">{t('releases.optional')}</span>
          </label>
          {/* Просят обычно конкретный профиль: «собери прод-билд» — это он и
              есть, и без поля это уезжает в свободный текст. */}
          <Combobox
            options={BUILD_PROFILES.map((p) => ({
              value: p,
              label: t(`releases.profile.${p}`, { defaultValue: p }),
            }))}
            value={profile}
            onChange={setProfile}
            placeholder={t('releases.profilePick')}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            {t('releases.whatToDo')} <span className="text-muted-foreground/70">{t('releases.optional')}</span>
          </label>
          <Input
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={t('releases.whatToDoHint')}
          />
        </div>
        {/* Что произойдёт — сказано до нажатия: действие создаёт две сущности
            сразу, и человек вправе знать это заранее, а не обнаружить после. */}
        <p className="rounded-md bg-muted/50 px-2 py-1.5 text-xs text-muted-foreground">
          {t('releases.requestExplain')}
        </p>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button disabled={!version.trim() || !appName.trim() || !type || ask.isPending} onClick={() => ask.mutate()}>
          {t('releases.request')}
        </Button>
      </div>
    </Overlay>
  )
}

function CreateDialog({
  projectId,
  buildTypes,
  onClose,
  onDone,
}: {
  projectId: string
  buildTypes: BuildTypeDef[]
  onClose: () => void
  onDone: () => void
}) {
  const { t } = useTranslation()
  const [version, setVersion] = useState('')
  const [appName, setAppName] = useState('')
  const [type, setType] = useState(buildTypes[0]?.key ?? 'other')
  const [referenceUrl, setReferenceUrl] = useState('')
  const [profile, setProfile] = useState('')
  const [notes, setNotes] = useState('')

  const create = useMutation({
    mutationFn: () =>
      api<Release>(
        '/api/v1/releases',
        {
          method: 'POST',
          body: JSON.stringify({
            version: version.trim(),
            appName: appName.trim(),
            buildType: type,
            referenceUrl: referenceUrl.trim() || null,
            buildProfile: profile || null,
            notes: notes.trim() || null,
          }),
        },
        'project',
      ),
    onSuccess: onDone,
    onError: (e: { message?: string }) => toast.error(e.message || t('common.error')),
  })

  return (
    <Overlay onClose={onClose} title={t('releases.create')}>
      <div className="space-y-3">
        <div>
          {/* Имя сборки первым: у проекта бывает несколько приложений, и
              «1.4.0» без ответа «чего именно» ничего не значит. */}
          <label className="mb-1 block text-xs text-muted-foreground">{t('releases.appName')}</label>
          <Input
            value={appName}
            onChange={(e) => setAppName(e.target.value)}
            placeholder={t('releases.appNameHint')}
            autoFocus
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">{t('releases.version')}</label>
          <Input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="1.4.0" />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">{t('releases.buildType')}</label>
          {/* Combobox, а не Select: типов сборки со временем станет больше, а
              искать в длинном списке глазами — то же, чего мы избегаем на
              остальных экранах. Поиск встроен и включается сам. */}
          <Combobox
            options={buildTypes.map((b) => ({ value: b.key, label: b.label, hint: b.stages.map((st) => st.label).join(' → ') }))}
            value={type}
            onChange={setType}
            placeholder={t('releases.buildTypePick')}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            {t('releases.buildProfile')} <span className="text-muted-foreground/70">{t('releases.optional')}</span>
          </label>
          <Combobox
            options={BUILD_PROFILES.map((p) => ({
              value: p,
              label: t(`releases.profile.${p}`, { defaultValue: p }),
            }))}
            value={profile}
            onChange={setProfile}
            placeholder={t('releases.profilePick')}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            {t('releases.reference')} <span className="text-muted-foreground/70">{t('releases.optional')}</span>
          </label>
          <Input value={referenceUrl} onChange={(e) => setReferenceUrl(e.target.value)} placeholder="https://…" />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            {t('releases.notes')} <span className="text-muted-foreground/70">{t('releases.optional')}</span>
          </label>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t('releases.notesHint')} />
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button disabled={!version.trim() || !appName.trim() || create.isPending} onClick={() => create.mutate()}>
          {t('releases.create')}
        </Button>
      </div>
    </Overlay>
  )
}

function Overlay({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl border bg-card p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{title}</h3>
          <button onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
