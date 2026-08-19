import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Check, ExternalLink, Link2, Plus, Search, X } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

// Ресурсы задачи: стенд, ключ, база.
//
// Задача ССЫЛАЕТСЯ на доступ, а не хранит его копию. Пока привязать было
// нечем, человек вставлял адрес и пароль прямо в описание — оттуда их читают
// все, кто видит задачу, и отозвать это уже нельзя. Ссылка решает, кому
// раскрыться, сама.
//
// Значений секретов здесь нет нигде: ни в списке, ни у кандидатов. Раскрыть
// значение можно только на самом ресурсе и только тому, кому он это позволяет.

type Resource = { id: string; name: string; url: string | null; icon?: string | null }

export function TaskResources({
  taskId,
  projectId,
  canEdit,
}: {
  taskId: string
  projectId: string
  canEdit: boolean
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [picking, setPicking] = useState(false)

  const q = useQuery({
    queryKey: ['task-resources', taskId],
    queryFn: () => api<{ items: Resource[] }>(`/api/v1/tasks/${taskId}/resources`, {}, 'project'),
  })

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['task-resources', taskId] })
    qc.invalidateQueries({ queryKey: ['task-resource-candidates', taskId] })
    // Список задач несёт ресурсы вместе со строкой — освежаем и его.
    qc.invalidateQueries({ queryKey: ['tasks', projectId] })
  }

  const add = useMutation({
    mutationFn: (ids: string[]) =>
      api(`/api/v1/tasks/${taskId}/resources`, { method: 'POST', body: JSON.stringify({ resourceIds: ids }) }, 'project'),
    onSuccess: refresh,
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const remove = useMutation({
    mutationFn: (resourceId: string) =>
      api(`/api/v1/tasks/${taskId}/resources/${resourceId}`, { method: 'DELETE' }, 'project'),
    onSuccess: refresh,
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const items = q.data?.items ?? []

  // Пусто и править нельзя — секции в карточке не место.
  if (!canEdit && !items.length) return null

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        {/* tabs.resources, а не свой ключ: вкладка уже называется этим словом,
            и второе имя для того же завтра разъедется. */}
        <h4 className="text-xs font-medium text-muted-foreground">{t('tabs.resources')}</h4>
        {canEdit && (
          <Button variant="ghost" size="sm" className="gap-1 text-xs" onClick={() => setPicking(true)}>
            <Plus className="size-3.5" />
            {t('taskResources.link')}
          </Button>
        )}
      </div>

      {!items.length && <p className="text-xs text-muted-foreground">{t('taskResources.empty')}</p>}

      <ul className="space-y-1">
        {items.map((r) => (
          <li key={r.id} className="group/res flex items-center gap-2 rounded-md border px-2 py-1.5">
            <a
              href={r.url ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
              // Куда ведёт — видно до клика: у ресурса с именем сам адрес в
              // строке не показан, и «Access test resource» ничего не говорит.
              title={r.url ?? undefined}
              className={cn(
                'flex min-w-0 flex-1 items-center gap-2 text-start text-sm transition-colors hover:text-brand-ink',
                !r.url && 'pointer-events-none',
              )}
            >
              <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{r.name || r.url}</span>
              {r.name && r.url && (
                <span className="ms-auto hidden max-w-[45%] shrink-0 truncate text-xs text-muted-foreground group-hover/res:inline">
                  {r.url}
                </span>
              )}
            </a>
            {canEdit && (
              <button
                type="button"
                title={t('taskResources.unlink')}
                onClick={() => remove.mutate(r.id)}
                className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/res:opacity-100"
              >
                <X className="size-3.5" />
              </button>
            )}
          </li>
        ))}
      </ul>

      {picking && (
        <ResourcePickerDialog
          taskId={taskId}
          onClose={() => setPicking(false)}
          onPick={(ids) => add.mutate(ids)}
          onCreated={refresh}
        />
      )}
    </section>
  )
}

/**
 * Выбор ресурса — и создание нового прямо здесь.
 *
 * Без создания по месту человек уходит на вкладку ресурсов, заводит его там и
 * должен вернуться в задачу. Обычно не возвращается: связь теряется ровно в
 * тот момент, когда её проще всего было поставить.
 */
function ResourcePickerDialog({
  taskId,
  onClose,
  onPick,
  onCreated,
}: {
  taskId: string
  onClose: () => void
  onPick: (ids: string[]) => void
  onCreated: () => void
}) {
  const { t } = useTranslation()
  const [q, setQ] = useState('')
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [saving, setSaving] = useState(false)

  // Поиск не дёргаем на каждую букву: между нажатиями ждём, иначе запрос
  // уходит на каждый символ.
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const id = setTimeout(() => setDebounced(q), 250)
    return () => clearTimeout(id)
  }, [q])

  const candidates = useQuery({
    queryKey: ['task-resource-candidates', taskId, debounced],
    queryFn: () =>
      api<{ items: Resource[] }>(
        `/api/v1/tasks/${taskId}/resources/candidates?q=${encodeURIComponent(debounced)}`,
        {},
        'project',
      ),
  })

  const toggle = (id: string) =>
    setChosen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  /** Создать ресурс и сразу привязать — ради этого диалог и открывали. */
  const createAndLink = async () => {
    const trimmed = name.trim()
    const address = url.trim()
    if (!trimmed && !address) return
    setSaving(true)
    try {
      const made = await api<{ id: string }>(
        '/api/v1/resources',
        {
          method: 'POST',
          // Секреты здесь не заводим: их место — на самом ресурсе, где видно
          // права и кому он раскрывается. Диалог привязки не должен становиться
          // ещё одним местом, куда вводят пароли.
          body: JSON.stringify({ name: trimmed, url: address || null, description: '' }),
        },
        'project',
      )
      onPick([made.id])
      onCreated()
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const items = candidates.data?.items ?? []

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-6" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b p-3">
          <h2 className="text-sm font-semibold">{t('taskResources.pickTitle')}</h2>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>

        {creating ? (
          <div className="space-y-3 p-3">
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">{t('taskResources.name')}</span>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus:border-brand"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">{t('taskResources.url')}</span>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                dir="ltr"
                spellCheck={false}
                placeholder="https://"
                className="w-full rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus:border-brand"
              />
            </label>
            {/* Прямо здесь, а не в подсказке после ошибки: пароль, попавший в
                задачу, назад уже не забрать. */}
            <p className="text-xs text-muted-foreground">{t('taskResources.secretHint')}</p>
            <div className="flex gap-2">
              <Button size="sm" disabled={saving || (!name.trim() && !url.trim())} onClick={createAndLink}>
                {t('taskResources.createAndLink')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="border-b p-2">
              <div className="relative">
                <Search className="absolute start-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  autoFocus
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={t('taskResources.search')}
                  className="w-full rounded-md border bg-background py-1.5 pe-2 ps-7 text-sm outline-none focus:border-brand"
                />
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {!items.length && (
                <p className="p-3 text-center text-xs text-muted-foreground">{t('taskResources.nothingFound')}</p>
              )}
              {items.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => toggle(r.id)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start transition-colors hover:bg-accent/50"
                >
                  <span
                    className={cn(
                      'grid size-4 shrink-0 place-items-center rounded border',
                      chosen.has(r.id) && 'border-brand bg-brand text-brand-ink',
                    )}
                  >
                    {chosen.has(r.id) && <Check className="size-3" />}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm">{r.name || r.url}</span>
                  {r.name && r.url && (
                    <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground">{r.url}</span>
                  )}
                </button>
              ))}
            </div>

            <div className="flex items-center justify-between gap-2 border-t p-3">
              <Button variant="ghost" size="sm" className="gap-1 text-xs" onClick={() => setCreating(true)}>
                <Plus className="size-3.5" />
                {t('taskResources.createNew')}
              </Button>
              <Button
                size="sm"
                className="gap-1"
                disabled={!chosen.size}
                onClick={() => {
                  onPick([...chosen])
                  onClose()
                }}
              >
                <Link2 className="size-3.5" />
                {t('taskResources.linkChosen', { count: chosen.size })}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}
