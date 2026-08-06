import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Check, Info, Search, X } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { StatusBadge } from './StatusBadge'
import type { LinkedTask } from './TaskBlockedMark'

// Выбор задач для связи.
//
// Показываем ТОЛЬКО допустимых кандидатов: уже связанные и те, что зависят от
// текущей, сервер отфильтровывает сам. Дать выбрать заведомо запрещённое и
// ответить отказом — худший вид подсказки: человек уже принял решение.

export function TaskPickerDialog({
  taskId,
  side,
  onClose,
  onPick,
}: {
  taskId: string
  /** blockers — кого мы ждём; blocking — кто ждёт нас. */
  side: 'blockers' | 'blocking'
  onClose: () => void
  onPick: (ids: string[]) => void
}) {
  const { t } = useTranslation()
  const [q, setQ] = useState('')
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  // Поиск не дёргаем на каждую букву: список приезжает целиком и фильтруется
  // сервером, но между нажатиями клавиш ждём — иначе запрос на символ.
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const id = setTimeout(() => setDebounced(q), 250)
    return () => clearTimeout(id)
  }, [q])

  const candidates = useQuery({
    queryKey: ['blocker-candidates', taskId, side, debounced],
    queryFn: () =>
      api<{ items: LinkedTask[] }>(
        `/api/v1/tasks/${taskId}/blockers/candidates?side=${side}&q=${encodeURIComponent(debounced)}`,
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

  const items = candidates.data?.items ?? []

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-6" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b p-3">
          <h2 className="text-sm font-semibold">{t('blockers.pickTitle')}</h2>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>

        <div className="border-b p-2">
          <div className="relative">
            <Search className="absolute start-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('blockers.pickSearch')}
              className="w-full rounded-md border bg-transparent py-1.5 pe-2 ps-7 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {candidates.isLoading && <p className="p-3 text-center text-xs text-muted-foreground">…</p>}
          {!candidates.isLoading && !items.length && (
            <p className="p-4 text-center text-xs leading-relaxed text-muted-foreground">{t('blockers.pickEmpty')}</p>
          )}
          {items.map((x) => {
            const on = chosen.has(x.id)
            return (
              <button
                key={x.id}
                type="button"
                onClick={() => toggle(x.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start transition-colors',
                  on ? 'bg-accent' : 'hover:bg-accent/60',
                )}
              >
                <span
                  className={cn(
                    'grid size-4 shrink-0 place-items-center rounded border',
                    on ? 'border-brand bg-brand text-brand-foreground' : 'border-muted-foreground/40',
                  )}
                >
                  {on && <Check className="size-3" />}
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{x.number}</span>
                <span className="min-w-0 flex-1 truncate text-sm">{x.title}</span>
                <StatusBadge status={x.status} size="sm" withIcon={false} />
              </button>
            )
          })}
        </div>

        {/* Почему список короче, чем кажется — говорим прямо, а не молчим. */}
        {items.length > 0 && (
          <p className="flex items-start gap-1.5 border-t px-3 py-2 text-[11px] leading-snug text-muted-foreground">
            <Info className="mt-px size-3 shrink-0" />
            {t('blockers.cycleHint')}
          </p>
        )}

        <div className="flex justify-end gap-2 border-t p-3">
          <Button variant="outline" onClick={onClose}>
            {t('files.cancel')}
          </Button>
          <Button
            variant="brand"
            disabled={!chosen.size}
            onClick={() => {
              onPick([...chosen])
              onClose()
            }}
          >
            {t('blockers.pickAdd', { count: chosen.size })}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
