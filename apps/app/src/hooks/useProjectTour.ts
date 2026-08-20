import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'

/**
 * Показывать ли вводный тур и как его закрыть.
 *
 * Признак живёт в базе, а не в браузере: человек заходит с рабочего компьютера
 * и с домашнего, и тур, привязанный к устройству, встретил бы его дважды.
 *
 * Закрытие и прохождение до конца — одно и то же событие. Человек ответил на
 * вопрос «нужно ли объяснять», и разница между «дослушал» и «понял с третьего
 * шага» нас не касается.
 */
export function useProjectTour() {
  const qc = useQueryClient()

  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api<{ id: string; tourSeen?: boolean }>('/api/v1/auth/me'),
    staleTime: 5 * 60_000,
  })

  const done = useMutation({
    mutationFn: () => api('/api/v1/auth/me/tour-seen', { method: 'POST' }),
    /**
     * Гасим тур сразу, не дожидаясь ответа сервера.
     *
     * Человек нажал «закрыть» — окно должно исчезнуть в тот же миг. Если
     * запрос не дойдёт, тур вернётся при следующем заходе: неприятно, но
     * гораздо лучше, чем окно, которое не закрывается по нажатию.
     */
    onMutate: () => {
      qc.setQueryData(['me'], (prev: unknown) =>
        prev && typeof prev === 'object' ? { ...prev, tourSeen: true } : prev,
      )
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['me'] }),
  })

  return {
    // Пока ответ не пришёл, тур не показываем: мигнуть им человеку, который
    // его уже проходил, хуже, чем показать на полсекунды позже.
    show: me.data?.tourSeen === false,
    finish: () => done.mutate(),
  }
}
