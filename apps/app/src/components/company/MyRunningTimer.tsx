import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Play, Square } from 'lucide-react'
import { api } from '@/lib/api'
import { toast } from 'sonner'
import { ProjectBadge } from '@/components/ui/project-badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

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

  /**
   * Куда запускать. Берём проекты из последних записей: человек почти всегда
   * продолжает то, чем занимался, а полный список из трёх десятков проектов
   * превращает одно нажатие в поиск.
   */
  const recent = useQuery({
    queryKey: ['my-time-recent'],
    queryFn: () => api<{ projects: { id: string; name: string }[] }>('/api/v1/my/time/recent?limit=10'),
    // Список нужен, только когда таймера нет: иначе кнопки запуска и не видно.
    enabled: !running.data?.items.length,
  })

  const start = useMutation({
    mutationFn: (projectId: string) =>
      api('/api/v1/my/time/start', { method: 'POST', body: JSON.stringify({ projectId, description: '' }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['my-time-running'] })
      qc.invalidateQueries({ queryKey: ['my-time-recent'] })
      qc.invalidateQueries({ queryKey: ['company-time'] })
    },
    // Сервер отвечает 409, когда таймер уже идёт: показываем его текст, он
    // называет проект, в котором надо сначала остановить.
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const projects = recent.data?.projects ?? []

  /**
   * Таймера нет — предлагаем запустить.
   *
   * Останавливать с главной уже умели, а запускать приходилось идти в проект:
   * несимметрично. Первый проект — кнопкой, остальные под стрелкой: почти
   * всегда продолжают последнее, и ради этого случая не должно быть выбора.
   */
  if (!items.length) {
    if (!projects.length) return null
    const first = projects[0]!
    return (
      <section className="flex min-w-0 flex-wrap items-center gap-2 py-2">
        <button
          type="button"
          onClick={() => start.mutate(first.id)}
          disabled={start.isPending}
          className="flex min-w-0 items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors hover:border-brand/60 hover:bg-accent disabled:opacity-50"
        >
          <Play className="size-3.5 shrink-0 fill-current text-brand-ink" />
          <span className="text-muted-foreground">{t('time.start')}</span>
          <span className="min-w-0 truncate font-medium" title={first.name}>{first.name}</span>
        </button>

        {projects.length > 1 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                title={t('time.start')}
                className="rounded-lg border px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                …
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {projects.slice(1).map((pr) => (
                <DropdownMenuItem key={pr.id} onSelect={() => start.mutate(pr.id)}>
                  <Play className="size-3 fill-current" />
                  <span className="truncate">{pr.name}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </section>
    )
  }

  return (
    <section className="space-y-2 py-2">
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
