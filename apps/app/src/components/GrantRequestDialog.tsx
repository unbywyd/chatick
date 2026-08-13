import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Bot, Building2, FolderGit2 } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

/**
 * Ассистент просит доступ через установленное приложение.
 *
 * Здесь человек делает ровно то же, что на экране подключения, — выбирает
 * проект или компанию и одобряет, — но не переписывает код из чата: код
 * пришёл вместе с просьбой.
 *
 * Токен через это окно не проходит. Одобряется код, а токен ассистент
 * забирает у сервера сам, как в обычном device flow, — поэтому второго пути
 * выдачи доступа не появляется.
 */

type Company = { id: string; name: string }
type ProjectListItem = { id: string; name: string; isMember: boolean }

export type GrantRequest = { id: string; client: string; code: string }

export function GrantRequestDialog({
  request,
  onDone,
}: {
  request: GrantRequest
  /** approved — что ответить ассистенту. */
  onDone: (approved: boolean) => void
}) {
  const { t } = useTranslation()
  const [target, setTarget] = useState('')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [masterMode, setMasterMode] = useState(false)

  const companies = useQuery({
    queryKey: ['companies'],
    queryFn: () => api<{ companies: Company[] }>('/api/v1/companies'),
  })
  const companyIds = (companies.data?.companies ?? []).map((c) => c.id)
  const projects = useQuery({
    queryKey: ['connect-projects', companyIds.join(',')],
    enabled: companyIds.length > 0,
    queryFn: async () => {
      const lists = await Promise.all(
        companyIds.map((id) =>
          api<ProjectListItem[]>(`/api/v1/projects?companyId=${id}`)
            .then((list) => list.map((p) => ({ ...p, companyId: id })))
            .catch(() => [] as (ProjectListItem & { companyId: string })[]),
        ),
      )
      return lists.flat()
    },
  })

  const myCompanies = companies.data?.companies ?? []
  const myProjects = (projects.data ?? []).filter((p) => p.isMember)
  const companyNames = new Map(myCompanies.map((c) => [c.id, c.name]))

  // Компании и проекты — как на экране подключения. Компания это не «больше
  // прав»: туннель открывает ровно те проекты, где человек состоит, и с его
  // же правами, что проверяется на каждом запросе.
  //
  // Компанию подписываем ВСЕГДА, а не только при нескольких. Рядом стоит
  // строка «вся компания», и без подписи не видно, относятся ли проекты
  // к ней же: человек выдаёт доступ, не понимая границ.
  const allTargets = [
    ...myCompanies.map((c) => ({ key: `c:${c.id}`, name: c.name, sub: null as string | null, whole: true })),
    ...myProjects.map((p) => ({
      key: `p:${p.id}`,
      name: p.name,
      sub: companyNames.get((p as { companyId?: string }).companyId ?? '') ?? null,
      whole: false,
    })),
  ]

  // Список прокручиваемый, но прокруткой ищут плохо: на десятках проектов
  // нужный ищется глазами по всему списку. Поиск появляется тогда, когда
  // начинает быть нужен, и не мозолит глаза при трёх проектах.
  const needsSearch = allTargets.length > 7
  const needle = query.trim().toLowerCase()
  const targets = needle
    ? allTargets.filter((x) => `${x.name} ${x.sub ?? ''}`.toLowerCase().includes(needle))
    : allTargets

  // Одна цель — выбирать не из чего, ставим сразу: лишний клик по
  // единственной кнопке ничего не решает.
  //
  // Считаем по полному списку, а не по отфильтрованному: иначе запрос,
  // сузивший список до одной строки, выбирал бы её молча — человек нажал бы
  // «Разрешить», не заметив, что выбрано.
  useEffect(() => {
    if (!target && allTargets.length === 1) setTarget(allTargets[0]!.key)
  }, [target, allTargets])

  const approve = async () => {
    if (!target && !masterMode) return
    setBusy(true)
    try {
      await api('/api/v1/auth/bridge/approve', {
        method: 'POST',
        // Ключ несёт вид цели: «c:» — компания, «p:» — проект. Префикс надо
        // снять, иначе сервер ищет проект с таким id.
        //
        // Мастер-доступ идёт первым: при нём выбранная цель уже не значит
        // ничего, и отправить её вместе с ним — значит сузить то, что человек
        // осознанно открыл целиком.
        body: JSON.stringify({
          code: request.code,
          ...(masterMode
            ? { all: true }
            : target.startsWith('c:')
              ? { companyId: target.slice(2) }
              : { projectId: target.replace(/^p:/, '') }),
        }),
      })
      toast.success(t('connect.approved'))
      onDone(true)
    } catch (e) {
      // Отказ ассистенту, а не молчание: иначе он ждёт две минуты таймаута,
      // хотя ответ уже известен.
      toast.error(e instanceof Error ? e.message : String(e))
      onDone(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl border bg-card p-5 shadow-lg">
        <div className="flex items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-brand-soft text-brand-ink">
            <Bot className="size-5" />
          </span>
          <div className="min-w-0">
            <p className="font-semibold">{t('connect.grantTitle', { client: request.client })}</p>
            <p className="text-xs text-muted-foreground">{t('connect.grantSubtitle')}</p>
          </div>
        </div>

        {/* Мастер-доступ. Отдельным тумблером, а не строкой в списке: это не
            «ещё одна цель», а решение другого рода — открыть всё сразу,
            включая компании, куда позовут позже. */}
        <label className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-lg border bg-background p-2.5">
          <input
            type="checkbox"
            checked={masterMode}
            onChange={(e) => setMasterMode(e.target.checked)}
            className="mt-0.5 size-4 accent-brand"
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium">{t('connect.masterTitle')}</span>
            <span className="block text-xs text-muted-foreground">{t('connect.masterNote')}</span>
          </span>
        </label>

        <div className={cn('mt-4', masterMode && 'pointer-events-none opacity-40')}>
          <p className="text-sm font-medium">{t('connect.grantWhere')}</p>
          {needsSearch && (
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('connect.grantSearch')}
              className="mt-2 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-brand"
            />
          )}
          <div className="mt-2 max-h-64 space-y-1 overflow-y-auto">
          {targets.length === 0 && (
            // «Ничего не найдено» и «нет доступных проектов» — разные вещи:
            // второе при непустом поиске было бы прямой неправдой.
            <p className="text-sm text-muted-foreground">
              {needle ? t('connect.grantNoMatch') : t('connect.noTargets')}
            </p>
          )}
          {targets.map((x) => (
            <button
              key={x.key}
              onClick={() => setTarget(x.key)}
              className={cn(
                'flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-start text-sm transition-colors',
                target === x.key ? 'border-brand bg-accent' : 'hover:bg-accent/50',
              )}
            >
              {x.whole ? (
                <Building2 className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate">{x.name}</span>
              {x.sub && <span className="shrink-0 text-xs text-muted-foreground">{x.sub}</span>}
              {x.whole && <span className="shrink-0 text-xs text-muted-foreground">{t('connect.wholeCompany')}</span>}
            </button>
          ))}
          </div>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={() => onDone(false)} disabled={busy}>
            {t('connect.deny')}
          </Button>
          <Button variant="brand" onClick={approve} disabled={(!target && !masterMode) || busy}>
            {t('connect.allow')}
          </Button>
        </div>
      </div>
    </div>
  )
}
