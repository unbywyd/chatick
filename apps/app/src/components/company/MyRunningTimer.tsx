import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Square } from 'lucide-react'
import { api } from '@/lib/api'
import { toast } from 'sonner'
import { ProjectBadge } from '@/components/ui/project-badge'

/**
 * Идущий таймер — вверху стартового экрана компании.
 *
 * Раньше остановить его можно было, только зайдя в проект: на телефоне это
 * несколько касаний, а вопрос «выключить забытый таймер» решается одним. Часы
 * при этом продолжают капать всё время, пока человек ищет нужный экран.
 *
 * Показываем ТОЛЬКО когда таймер идёт: полоса с надписью «ничего не запущено»
 * отвечала бы на вопрос, которого никто не задавал, и отодвигала бы вниз то,
 * ради чего сюда заходят.
 */

type Running = {
  id: string
  startedAt: string
  description: string
  projectId: string
  projectName: string
}

/** Сколько идёт: ЧЧ:ММ:СС. Секунды здесь уместны — человек смотрит на живой счётчик. */
function elapsed(from: string): string {
  const sec = Math.max(0, Math.floor((Date.now() - new Date(from).getTime()) / 1000))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function MyRunningTimer() {
  const { t } = useTranslation()
  const qc = useQueryClient()

  const running = useQuery({
    queryKey: ['my-time-running'],
    queryFn: () => api<{ items: Running[] }>('/api/v1/my/time/running'),
    // Опрос — страховка на случай, если таймер остановили из другого места.
    // Сам счётчик тикает локально, сеть для этого не нужна.
    refetchInterval: 60_000,
  })

  /**
   * Отдельный тик раз в секунду: без него счётчик обновлялся бы только при
   * перезапросе, то есть раз в минуту, и «живой» таймер выглядел бы стоящим.
   */
  const [, tick] = useState(0)
  const items = running.data?.items ?? []
  useEffect(() => {
    if (!items.length) return
    const id = window.setInterval(() => tick((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [items.length])

  const stop = useMutation({
    // endedAt = сейчас: та же правка, что делает кнопка «стоп» внутри проекта.
    mutationFn: (id: string) =>
      api(`/api/v1/my/time/${id}`, { method: 'PATCH', body: JSON.stringify({ endedAt: new Date().toISOString() }) }),
    onSuccess: () => {
      // Обновляем всё, что считает эти же записи: список, сводку, недавние.
      qc.invalidateQueries({ queryKey: ['my-time-running'] })
      qc.invalidateQueries({ queryKey: ['my-time-recent'] })
      qc.invalidateQueries({ queryKey: ['company-time'] })
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  if (!items.length) return null

  return (
    <section className="mb-4 space-y-2">
      {items.map((r) => (
        /* flex-wrap и min-w-0: длинное имя проекта не должно выдавливать
           кнопку «стоп» за край — ради неё блок и существует. */
        <div
          key={r.id}
          className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-brand/40 bg-brand/5 px-3 py-2"
        >
          <span className="relative flex size-2 shrink-0">
            {/* Пульсация: отличает идущий таймер от просто записи. */}
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand opacity-60" />
            <span className="relative inline-flex size-2 rounded-full bg-brand" />
          </span>

          <ProjectBadge name={r.projectName} size={20} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate text-sm" title={r.description || r.projectName}>
            <span className="font-medium">{r.projectName}</span>
            {r.description && <span className="text-muted-foreground"> · {r.description}</span>}
          </span>

          <span className="shrink-0 font-mono text-base tabular-nums">{elapsed(r.startedAt)}</span>

          <button
            type="button"
            onClick={() => stop.mutate(r.id)}
            disabled={stop.isPending}
            className="flex shrink-0 items-center gap-1.5 rounded-md bg-foreground px-2.5 py-1 text-xs font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            <Square className="size-3 fill-current" />
            {t('time.stop')}
          </button>
        </div>
      ))}
    </section>
  )
}
