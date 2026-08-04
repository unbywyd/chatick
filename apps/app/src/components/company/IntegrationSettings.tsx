import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Link2, Lock, Users } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'

// Связь с внешней системой (SPEC-INTEGRATION §5).
//
// Всё, что нужно, чтобы две системы узнали друг о друге: как она называется,
// по какому адресу открывать в ней проект и откуда берутся проекты.
//
// Название и шаблон — настройки, а не код: интеграция остаётся универсальной,
// в исходниках нет ни слова про конкретного заказчика.

export function IntegrationSettings({
  companyId,
  isAdmin,
  current,
}: {
  companyId: string
  isAdmin: boolean
  current: {
    externalSystemName?: string | null
    externalProjectUrl?: string | null
    projectsViaApiOnly?: boolean
    membersViaApiOnly?: boolean
  }
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()

  const [name, setName] = useState(current.externalSystemName ?? '')
  const [url, setUrl] = useState(current.externalProjectUrl ?? '')
  const [apiOnly, setApiOnly] = useState(Boolean(current.projectsViaApiOnly))
  const [membersApiOnly, setMembersApiOnly] = useState(Boolean(current.membersViaApiOnly))

  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api(`/api/v1/companies/${companyId}/integration`, { method: 'PATCH', body: JSON.stringify(patch) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['companies'] })
      toast.success(t('projectForm.saved'))
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  return (
    <section className="rounded-xl border bg-card p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Link2 className="size-4 text-muted-foreground" />
        {t('integration.title')}
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">{t('integration.subtitle')}</p>

      <div className="mt-4 space-y-4">
        <div>
          <label className="mb-1.5 block text-xs font-medium">{t('integration.systemName')}</label>
          <Input
            value={name}
            disabled={!isAdmin}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('integration.systemNamePlaceholder')}
          />
          <p className="mt-1 text-xs text-muted-foreground">{t('integration.systemNameHint')}</p>
        </div>

        <div>
          <label className="mb-1.5 block text-xs font-medium">{t('integration.urlTemplate')}</label>
          <Input
            value={url}
            disabled={!isAdmin}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://atlas.example.com/projects/{externalId}"
            spellCheck={false}
          />
          {/* Про {externalId} говорим до сохранения, а не ошибкой после:
              без него ссылка вела бы все проекты в одно место. */}
          <p className="mt-1 text-xs text-muted-foreground">{t('integration.urlTemplateHint')}</p>
        </div>

        {/* Переключатель, а не нативный чекбокс: во всём приложении такие
            настройки выглядят одинаково, и один выбивающийся элемент читается
            как недоделка. */}
        <label className="flex cursor-pointer items-start justify-between gap-3 rounded-lg border border-dashed p-3">
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 text-sm font-medium">
              <Lock className="size-3.5 text-muted-foreground" />
              {t('integration.apiOnly')}
            </span>
            <span className="mt-0.5 block text-xs text-muted-foreground">{t('integration.apiOnlyHint')}</span>
          </span>
          <Switch checked={apiOnly} onCheckedChange={setApiOnly} disabled={!isAdmin} className="mt-0.5 shrink-0" />
        </label>

        {/* То же для людей. Отдельным переключателем: проекты снаружи бывают и
            без внешнего кадрового учёта — обратное тоже. */}
        <label className="flex cursor-pointer items-start justify-between gap-3 rounded-lg border border-dashed p-3">
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 text-sm font-medium">
              <Users className="size-3.5 text-muted-foreground" />
              {t('integration.membersApiOnly')}
            </span>
            <span className="mt-0.5 block text-xs text-muted-foreground">{t('integration.membersApiOnlyHint')}</span>
          </span>
          <Switch
            checked={membersApiOnly}
            onCheckedChange={setMembersApiOnly}
            disabled={!isAdmin}
            className="mt-0.5 shrink-0"
          />
        </label>

        {isAdmin && (
          <div className="flex justify-end">
            <Button
              variant="brand"
              size="sm"
              disabled={save.isPending}
              onClick={() =>
                save.mutate({
                  externalSystemName: name.trim() || null,
                  externalProjectUrl: url.trim() || null,
                  projectsViaApiOnly: apiOnly,
                  membersViaApiOnly: membersApiOnly,
                })
              }
            >
              {t('projectForm.save')}
            </Button>
          </div>
        )}
      </div>
    </section>
  )
}
