import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Check, Plus, X } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { LanguagePicker } from '@/components/ui/language-picker'
import { cn } from '@/lib/utils'

// Первый вход: компания → первый проект → команда (SPEC §8.38).
//
// Состояние визарда НЕ храним — ни в localStorage, ни в базе. Каждый шаг
// создаёт настоящую сущность сразу, поэтому после перезагрузки шаг
// восстанавливается из самих данных: нет компании — первый, есть компания без
// проектов — второй. Отдельная запись «прогресс» могла бы разойтись с
// действительностью (компанию удалили, а прогресс говорит «пройдено») и врать
// человеку.
//
// Проект пропустить нельзя: без него внутри пусто и делать нечего. Команду —
// можно: работать в одиночку нормально, и запирать за приглашениями незачем.

type Step = 'company' | 'project' | 'team'

export function OnboardingWizard({
  step,
  companyId,
  projectId,
  onDone,
}: {
  step: Step
  /** есть на шагах project и team */
  companyId?: string
  /** есть на шаге team */
  projectId?: string
  /** визард закончен: перейти в проект (или в компанию, если пропустили) */
  onDone: (created: { companyId: string; projectId?: string }) => void
}) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const [name, setName] = useState('')
  // Язык проекта: на нём ИИ ведёт задачи и переписку. Задавать его потом
  // поздно — часть переписки уже уйдёт не на том языке. По умолчанию берём
  // язык интерфейса: он почти всегда и есть язык команды.
  const [language, setLanguage] = useState(() => (i18n.language || 'en').slice(0, 2))
  const [emails, setEmails] = useState<string[]>([])
  const [draft, setDraft] = useState('')

  const stepIndex = step === 'company' ? 1 : step === 'project' ? 2 : 3

  const createCompany = useMutation({
    mutationFn: (v: string) =>
      api<{ id: string }>('/api/v1/companies', { method: 'POST', body: JSON.stringify({ name: v }) }),
    onSuccess: (c) => {
      setName('')
      qc.invalidateQueries({ queryKey: ['companies'] })
      // Шаг переключится сам: компания появилась, проектов нет
      onDone({ companyId: c.id })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const createProject = useMutation({
    mutationFn: (v: string) =>
      api<{ id: string }>('/api/v1/projects', {
        method: 'POST',
        body: JSON.stringify({ companyId, name: v, aiConfig: { language } }),
      }),
    onSuccess: (p) => {
      setName('')
      qc.invalidateQueries({ queryKey: ['projects', companyId] })
      qc.invalidateQueries({ queryKey: ['companies'] })
      onDone({ companyId: companyId!, projectId: p.id })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const invite = useMutation({
    mutationFn: async (list: string[]) => {
      // По одному: сервер отвечает за каждое приглашение отдельно, и одна
      // опечатка в адресе не должна отменить остальные.
      const results = await Promise.allSettled(
        list.map((email) =>
          api(`/api/v1/companies/${companyId}/invites`, {
            method: 'POST',
            body: JSON.stringify({ email, role: 'member', projectId }),
          }),
        ),
      )
      const failed = results.filter((r) => r.status === 'rejected').length
      return { sent: results.length - failed, failed }
    },
    onSuccess: ({ sent, failed }) => {
      if (sent) toast.success(t('wizard.invitesSent', { count: sent }))
      if (failed) toast.error(t('wizard.invitesFailed', { count: failed }))
      onDone({ companyId: companyId!, projectId })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const addEmail = () => {
    const v = draft.trim().toLowerCase()
    if (!v) return
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) {
      toast.error(t('wizard.badEmail'))
      return
    }
    if (!emails.includes(v)) setEmails((prev) => [...prev, v])
    setDraft('')
  }

  const busy = createCompany.isPending || createProject.isPending || invite.isPending

  const submit = () => {
    if (step === 'company') return name.trim() && createCompany.mutate(name.trim())
    if (step === 'project') return name.trim() && createProject.mutate(name.trim())
    // Пустой список — то же, что «пропустить»: незачем заставлять жать другую кнопку
    if (!emails.length && !draft.trim()) return onDone({ companyId: companyId!, projectId })
    const list = draft.trim() ? [...emails, draft.trim().toLowerCase()] : emails
    invite.mutate(list)
  }

  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-xl flex-col justify-center py-10">
      {/* Три шага видно сразу: человек понимает, сколько осталось */}
      <div className="flex items-center gap-3">
        <div className="flex gap-1.5">
          {[1, 2, 3].map((i) => (
            <span
              key={i}
              className={cn('h-0.5 w-9 rounded-full transition-colors', i <= stepIndex ? 'bg-brand' : 'bg-border')}
            />
          ))}
        </div>
        <span className="text-[11px] uppercase tracking-widest text-muted-foreground">
          {t('wizard.stepOf', { current: stepIndex, total: 3 })}
        </span>
      </div>

      <h1 className="mt-8 text-3xl font-bold leading-tight tracking-tight sm:text-4xl">
        {t(`wizard.${step}.title`)}
      </h1>
      <p className="mt-4 text-base leading-relaxed text-muted-foreground">
        {t(`wizard.${step}.lead`)}{' '}
        <span className="font-medium text-foreground">{t(`wizard.${step}.leadStrong`)}</span>
      </p>

      <form
        className="mt-10"
        onSubmit={(e) => {
          e.preventDefault()
          if (!busy) submit()
        }}
      >
        {step === 'team' ? (
          <>
            <div className="flex gap-2">
              <input
                autoFocus
                type="email"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  // Enter добавляет адрес, а не отправляет форму: адресов обычно
                  // несколько, и каждый раз тянуться к кнопке утомительно.
                  if (e.key === 'Enter' || e.key === ',') {
                    e.preventDefault()
                    addEmail()
                  }
                }}
                placeholder={t('wizard.team.placeholder')}
                className="min-w-0 flex-1 border-0 border-b border-border bg-transparent pb-3 text-xl outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-brand sm:text-2xl"
              />
              <button
                type="button"
                onClick={addEmail}
                title={t('wizard.team.add')}
                className="cursor-pointer self-end rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <Plus className="size-5" />
              </button>
            </div>

            {emails.length > 0 && (
              <ul className="mt-4 flex flex-wrap gap-2">
                {emails.map((e) => (
                  <li
                    key={e}
                    className="inline-flex items-center gap-1.5 rounded-full border bg-secondary px-3 py-1 text-sm"
                  >
                    {e}
                    <button
                      type="button"
                      onClick={() => setEmails((prev) => prev.filter((x) => x !== e))}
                      className="cursor-pointer text-muted-foreground hover:text-foreground"
                    >
                      <X className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t(`wizard.${step}.placeholder`)}
            maxLength={80}
            className="w-full border-0 border-b border-border bg-transparent pb-3 text-2xl font-medium outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-brand sm:text-3xl"
          />
        )}

        <p className="mt-3 text-sm text-muted-foreground">{t(`wizard.${step}.hint`)}</p>

        {/* Язык проекта — второе, что важно знать до первой переписки */}
        {step === 'project' && (
          <div className="mt-7">
            <p className="text-sm font-medium">{t('wizard.project.language')}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('wizard.project.languageHint')}</p>
            <LanguagePicker value={language} onChange={setLanguage} className="mt-2 max-w-xs" />
          </div>
        )}

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Button
            variant="brand"
            type="submit"
            disabled={busy || (step !== 'team' && !name.trim())}
            className="h-11 gap-3 px-6 text-base"
          >
            {step === 'team' && (emails.length > 0 || draft.trim()) && <Check className="size-4" />}
            {t(`wizard.${step}.cta`)}
            <kbd className="rounded border border-current/30 px-1.5 py-0.5 text-[10px] font-semibold opacity-70">
              Enter
            </kbd>
          </Button>

          {/* Пропустить можно и проект, и команду.
              Раньше проект был обязателен — «без него внутри пусто». Но у
              компании, чьи проекты приходят из внешней системы, это заставляло
              заводить фиктивный проект только чтобы дойти до настроек и ключей. */}
          {step !== 'company' && (
            <button
              type="button"
              onClick={() => onDone({ companyId: companyId!, projectId })}
              className="cursor-pointer text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              {step === 'project' ? t('wizard.skipProject') : t('wizard.skip')}
            </button>
          )}
        </div>
      </form>

      <p className="mt-12 max-w-lg text-xs leading-relaxed text-muted-foreground">
        {t(`wizard.${step}.foot`)}
      </p>
    </div>
  )
}
