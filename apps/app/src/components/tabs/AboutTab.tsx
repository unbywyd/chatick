import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'

type Member = { id: string; role: string; user: { id: string; name: string; email: string; avatarUrl: string | null } }

export function AboutTab({
  project,
  loading,
}: {
  project?: { id: string; name: string; about: string; chatRules: string }
  loading: boolean
}) {
  const { t } = useTranslation()

  const members = useQuery({
    queryKey: ['project-members', project?.id],
    queryFn: () => api<Member[]>(`/api/v1/projects/${project!.id}/members`),
    enabled: Boolean(project?.id),
  })

  if (loading || !project) return <p className="p-6 text-sm text-muted-foreground">…</p>

  return (
    <div className="mx-auto max-w-2xl space-y-8 p-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">{project.name}</h1>
        <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
          {project.about || t('about.noDescription')}
        </p>
      </div>

      {project.chatRules && (
        <section>
          <h2 className="text-sm font-semibold">{t('about.rules')}</h2>
          <p className="mt-2 whitespace-pre-wrap rounded-md bg-secondary p-3 text-sm">{project.chatRules}</p>
        </section>
      )}

      <section>
        <h2 className="text-sm font-semibold">{t('about.members')}</h2>
        <ul className="mt-2 space-y-1.5">
          {members.data?.map((m) => (
            <li key={m.id} className="flex items-center gap-3 rounded-md border bg-card px-3 py-2">
              {m.user.avatarUrl ? (
                <img src={m.user.avatarUrl} alt="" className="size-7 rounded-full" referrerPolicy="no-referrer" />
              ) : (
                <span className="grid size-7 place-items-center rounded-full bg-secondary text-xs font-semibold">
                  {(m.user.name || m.user.email)[0]?.toUpperCase()}
                </span>
              )}
              <span className="flex-1 text-sm">{m.user.name || m.user.email}</span>
              <span className="text-xs text-muted-foreground">{t(`roles.${m.role}`)}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
