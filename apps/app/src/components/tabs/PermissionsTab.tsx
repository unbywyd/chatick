import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Switch } from '@/components/ui/switch'

// SPEC §4.3: per-user пермишены; синхронизированы с ИИ в чате
const TASK_PERMISSIONS = [
  'tasks.create',
  'tasks.edit',
  'tasks.delete',
  'tasks.changeStatus',
  'credentials.read',
  'credentials.manage',
] as const
type Perm = (typeof TASK_PERMISSIONS)[number]

type Member = {
  id: string
  role: 'owner' | 'admin' | 'member'
  permissions: Record<Perm, boolean>
  user: { id: string; name: string; email: string; avatarUrl: string | null }
}

export function PermissionsTab({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const { t } = useTranslation()
  const qc = useQueryClient()

  const members = useQuery({
    queryKey: ['project-members', projectId],
    queryFn: () => api<Member[]>(`/api/v1/projects/${projectId}/members`),
  })

  const setPerm = useMutation({
    mutationFn: ({ userId, perm, value }: { userId: string; perm: Perm; value: boolean }) =>
      api(`/api/v1/projects/${projectId}/members/${userId}/permissions`, {
        method: 'PATCH',
        body: JSON.stringify({ [perm]: value }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project-members', projectId] }),
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="text-xl font-bold tracking-tight">{t('perms.title')}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{t('perms.subtitle')}</p>

      <div className="mt-6 overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="border-b bg-secondary/50 text-start">
              <th className="px-4 py-2.5 text-start font-medium">{t('about.members')}</th>
              {TASK_PERMISSIONS.map((p) => (
                <th key={p} className="px-3 py-2.5 text-center text-xs font-medium text-muted-foreground">
                  {t(`perms.${p}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {members.data?.map((m) => {
              const isOwner = m.role === 'owner'
              return (
                <tr key={m.id} className="border-b last:border-0">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2.5">
                      {m.user.avatarUrl ? (
                        <img src={m.user.avatarUrl} alt="" className="size-7 rounded-full" referrerPolicy="no-referrer" />
                      ) : (
                        <span className="grid size-7 place-items-center rounded-full bg-secondary text-xs font-semibold">
                          {(m.user.name || m.user.email)[0]?.toUpperCase()}
                        </span>
                      )}
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{m.user.name || m.user.email}</span>
                        <span className="block text-xs text-muted-foreground">{t(`roles.${m.role}`)}</span>
                      </span>
                    </div>
                  </td>
                  {TASK_PERMISSIONS.map((p) => (
                    <td key={p} className="px-3 py-2.5 text-center">
                      <Switch
                        checked={m.permissions[p]}
                        disabled={!canEdit || isOwner /* владельцу не режем права */}
                        onCheckedChange={(v) => setPerm.mutate({ userId: m.user.id, perm: p, value: v })}
                      />
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">{t('perms.aiNote')}</p>
    </div>
  )
}
