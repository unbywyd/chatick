import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Clock } from 'lucide-react'
import { api } from '@/lib/api'
import { EntryList } from '@/components/tabs/TimeTab'

// Мои последние записи — на странице компании, под общей сводкой.
//
// Список тот же самый, что на странице проекта: тот же компонент, та же
// группировка по дням с итогом за день, та же правка на месте. Своя вёрстка
// здесь означала бы два списка одних и тех же записей, которые разойдутся на
// первой же правке, — и человеку пришлось бы держать в голове два разных
// экрана для одного дела.
//
// Разница ровно одна: вместо задачи — проект, и его можно сменить. Это и есть
// «перекинуть часы», которых на уровне компании иначе не сделать.

type Entry = {
  id: string
  userId: string
  user: { id: string; name: string; avatarUrl: string | null } | null
  task: { id: string; number: string; title: string } | null
  description: string
  startedAt: string
  endedAt: string | null
  running: boolean
  minutes: number | null
  autoStopped: boolean
  projectId?: string
  projectName?: string
}

type Recent = { items: Entry[]; projects: { id: string; name: string }[] }

export function MyRecentTime() {
  const { t } = useTranslation()

  const recent = useQuery({
    queryKey: ['my-time-recent'],
    queryFn: () => api<Recent>('/api/v1/my/time/recent?limit=10'),
  })

  // Пустой список не рисуем вовсе: заголовок над пустотой отвечает не на тот
  // вопрос, а статистика ниже и так покажет, что часов нет.
  if (!recent.isLoading && !recent.data?.items.length) return null

  return (
    <section className="mt-8">
      <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
        <Clock className="size-4" />
        {t('myTime.title')}
      </h2>
      <EntryList
        projectId={null}
        items={recent.data?.items ?? []}
        loading={recent.isLoading}
        projects={recent.data?.projects ?? []}
      />
    </section>
  )
}
