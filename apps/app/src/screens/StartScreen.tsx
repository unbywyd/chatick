import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Building2, ChevronRight, Plus, FolderKanban, Check, Mail, MoreVertical, Search, Settings, X } from 'lucide-react'
import { ProfileMenu } from '@/components/ProfileMenu'
import { Avatar } from '@/components/ui/avatar'
import { AvatarGroup } from '@/components/ui/avatar-group'
import { ProjectBadge } from '@/components/ui/project-badge'
import { CompanySwitcher } from '@/components/CompanySwitcher'
import type { Period } from '@/components/ui/period-picker'
import { DangerZone, DangerAction } from '@/components/company/DangerZone'
import { DeleteProjectDialog } from '@/components/DeleteProjectDialog'
import { useConfirm } from '@/components/ui/confirm'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { ProjectSettingsDialog } from '@/components/ProjectSettingsDialog'
import {
  api,
  logout,
  setProjectToken,
  getSessionToken,
  setReturnTo,
  type Company,
  type CompanyInvite,
  type ProjectListItem,
  type Me,
} from '@/lib/api'
import { cn } from '@/lib/utils'
import { STATUS_DOT } from '@/components/tabs/tasks/types'
import { Logo } from '@/components/Logo'
import { ThemeToggle } from '@/components/ThemeToggle'
import { LanguageSelect } from '@/components/LanguageSelect'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { TeamTab } from '@/components/company/TeamTab'
import { NotificationBell } from '@/components/NotificationBell'
import { OnboardingWizard } from '@/components/OnboardingWizard'
import { CompanyTimeTab } from '@/components/company/CompanyTimeTab'
import { ProjectInbox } from '@/components/ProjectInbox'
import { MyRecentTime } from '@/components/company/MyRecentTime'
import { CompanyTimeSettings } from '@/components/company/CompanyTimeSettings'
import { OverviewTab } from '@/components/company/OverviewTab'
import { LlmSettings } from '@/components/company/LlmSettings'
import { MailSettings } from '@/components/company/MailSettings'
import { CompanyStorageCard } from '@/components/company/CompanyStorageCard'
import { CompanyLocale } from '@/components/company/CompanyLocale'
import { CompanyProfile } from '@/components/company/CompanyProfile'
import { ApiKeysTab } from '@/components/company/ApiKeysTab'
import { IntegrationSettings } from '@/components/company/IntegrationSettings'
import { WebhooksSettings } from '@/components/company/WebhooksSettings'
import { CompanyConnectTab } from '@/components/company/CompanyConnectTab'
import { BackupTab } from '@/components/company/BackupTab'
import {
  ProjectSettingsForm,
  DEFAULT_AI_CONFIG,
  type ProjectSettings,
} from '@/components/ProjectSettingsForm'

// Страница компании: табы Проекты / Команда (SPEC §5)
export function StartScreen() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()
  // компания и таб — из URL: /start/:companyId/:companyTab (адресуемо, SPEC)
  const { companyId = null } = useParams()
  const [searchParams] = useSearchParams()
  const setCompanyId = (id: string | null) => navigate(id ? `/start/${id}` : '/start')
  /**
   * Явное «хочу завести компанию».
   *
   * Без него клик по кнопке уводил на /start, а эффект ниже тут же возвращал
   * обратно: у человека с ОДНОЙ компанией /start сам себя перенаправляет на
   * неё. Со стороны — «страница мигнула и ничего не произошло».
   */
  const goCreate = () => navigate('/start?new=1')

  useEffect(() => {
    if (!getSessionToken()) {
      setReturnTo(window.location.hash.slice(1) || '/start')
      navigate('/login', { replace: true })
    }
  }, [navigate])

  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/api/v1/auth/me') })
  const companiesQ = useQuery({
    queryKey: ['companies'],
    queryFn: () => api<{ companies: Company[]; invites: CompanyInvite[] }>('/api/v1/companies'),
  })

  // Единственную компанию открываем сразу — выбирать не из чего. Но НЕ когда
  // человек сам попросил экран создания: иначе кнопка «создать» бесконечно
  // возвращала бы его в ту самую компанию, из которой он ушёл.
  const wantsNew = searchParams.get('new') === '1'
  useEffect(() => {
    const list = companiesQ.data?.companies
    if (list && list.length === 1 && !companyId && !wantsNew) {
      navigate(`/start/${list[0]!.id}`, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companiesQ.data, companyId, wantsNew])

  useEffect(() => {
    if (me.error) {
      logout()
      navigate('/login', { replace: true })
    }
  }, [me.error, navigate])

  const company = companiesQ.data?.companies.find((c) => c.id === companyId)
  const [leaving, setLeaving] = useState<Company | null>(null)
  const [deletingCompany, setDeletingCompany] = useState<Company | null>(null)
  const confirm = useConfirm()

  const leave = useMutation({
    mutationFn: (id: string) => api(`/api/v1/companies/${id}/leave`, { method: 'POST' }),
    onSuccess: () => {
      toast.success(t('start.leftCompany'))
      qc.invalidateQueries({ queryKey: ['companies'] })
      navigate('/start', { replace: true })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  // Выход спрашиваем подтверждением: доступ к проектам компании пропадёт, и
  // вернуться можно будет только по новому приглашению.
  useEffect(() => {
    if (!leaving) return
    const c = leaving
    setLeaving(null)
    void confirm({
      title: t('start.leaveConfirm', { name: c.name }),
      description: t('start.leaveHint'),
      destructive: true,
      confirmLabel: t('start.leaveCompany'),
    }).then((ok) => ok && leave.mutate(c.id))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaving])

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <div className="flex items-center gap-3">
          <Logo />
          {company && (
            <>
              <span className="text-muted-foreground">/</span>
              {/* Переключатель вместо ссылки назад: менять компанию, уходя со
                  страницы, на которой работаешь, — лишний шаг. */}
              <CompanySwitcher
                companies={companiesQ.data?.companies ?? []}
                current={company}
                onSelect={setCompanyId}
                onCreate={goCreate}
                onLeave={setLeaving}
              />
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <LanguageSelect />
          <ThemeToggle />
          {/* Уведомления адресованы человеку, а не проекту: до входа в проект
              они приходили молча, и увидеть их было негде. */}
          <NotificationBell />
          {/* профиль (фото, имя, выход) доступен и до входа в проект — SPEC §8.19.
              companyId передаём, чтобы в меню был вход в настройки компании:
              без него пункт скрывался ровно там, где он нужнее всего — на
              стартовом экране, куда попадает компания с внешней системой.
              Если компания в адресе не выбрана, берём первую свою. */}
          <ProfileMenu
            me={me.data}
            companyId={company?.id ?? companiesQ.data?.companies[0]?.id}
            isAdmin={(company ?? companiesQ.data?.companies[0])?.myRole === 'admin'}
          />
        </div>
      </header>

      {/* шире, чем раньше: карточки проектов идут в две колонки */}
      {/* Прокрутка на всю ширину окна: ограниченный по ширине контейнер
          рисовал полосу посреди экрана. Содержимое центрируется внутри. */}
      {/* scrollbar-gutter: место под полосу прокрутки резервируется ВСЕГДА.
          Без него короткие вкладки (обзор, команда) полосы не имеют, длинные
          (проекты, настройки) имеют — и при переключении вся страница вместе
          с табами прыгает вправо на её ширину. */}
      <main className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <div className="mx-auto w-full max-w-6xl px-6 py-8">
        {!companyId ? (
          <CompanyPicker
            data={companiesQ.data}
            loading={companiesQ.isLoading}
            onSelect={setCompanyId}
            onChanged={() => qc.invalidateQueries({ queryKey: ['companies'] })}
          />
        ) : company ? (
          <CompanyHome
            company={company}
            meId={me.data?.id}
            onEntered={(id) => navigate(`/c/${company.id}/p/${id}`)}
            onDeleteCompany={setDeletingCompany}
          />
        ) : companiesQ.isLoading ? (
          <p className="py-16 text-center text-sm text-muted-foreground">…</p>
        ) : (
          // Компании в адресе нет среди своих: её удалили, из неё вышли или
          // ссылку прислали чужую. Пустая страница на это не отвечает — человек
          // видит чёрный экран и решает, что всё сломалось.
          <div className="grid min-h-[60vh] place-items-center p-6 text-center">
            <div className="max-w-sm">
              <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-secondary text-muted-foreground">
                <Building2 className="size-7" />
              </span>
              <h2 className="mt-4 text-base font-semibold">{t('start.companyGoneTitle')}</h2>
              <p className="mt-2 text-sm text-muted-foreground">{t('start.companyGoneText')}</p>
              <Button variant="brand" className="mt-5" onClick={goCreate}>
                {t('start.companyGoneCta')}
              </Button>
            </div>
          </div>
        )}
        </div>
      </main>

      {deletingCompany && (
        <DeleteProjectDialog
          kind="company"
          projectId={deletingCompany.id}
          projectName={deletingCompany.name}
          onClose={() => setDeletingCompany(null)}
          onDeleted={() => {
            setDeletingCompany(null)
            qc.invalidateQueries({ queryKey: ['companies'] })
            navigate('/start', { replace: true })
          }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Выбор/создание компании + инвайты
// ---------------------------------------------------------------------------

function CompanyPicker({
  data,
  loading,
  onSelect,
  onChanged,
}: {
  data?: { companies: Company[]; invites: CompanyInvite[] }
  loading: boolean
  onSelect: (id: string) => void
  onChanged: () => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState('')

  const createCompany = useMutation({
    mutationFn: (name: string) => api<Company>('/api/v1/companies', { method: 'POST', body: JSON.stringify({ name }) }),
    onSuccess: (c) => {
      toast.success(t('start.companyCreated'))
      onChanged()
      onSelect(c.id)
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const acceptInvite = useMutation({
    mutationFn: (token: string) =>
      api<{ ok: true; company: Company }>(`/api/v1/companies/invites/${token}/accept`, { method: 'POST' }),
    onSuccess: (r) => {
      toast.success(t('start.inviteAccepted'))
      onChanged()
      onSelect(r.company.id)
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  if (loading) return <p className="text-center text-sm text-muted-foreground">…</p>

  const companies = data?.companies ?? []
  // Своя компания — та, которую человек ЗАВЁЛ, а не та, где он админ.
  //
  // Админом делают и в чужой: позвали и повысили. Роль говорит о правах внутри
  // пространства, а не о том, чьё оно. По той же путанице кнопка «создать
  // компанию» вела в пустоту — сервер считает по createdById (isOwner), и
  // интерфейс должен считать так же.
  const ownCompanies = companies.filter((c) => c.isOwner)
  const guestCompanies = companies.filter((c) => !c.isOwner)
  const invites = data?.invites ?? []

  // Первый вход: ни компаний, ни приглашений — ведём визардом, а не пустым
  // экраном со строчкой формы. Шаг определяется данными, не памятью о нём.
  if (!companies.length && !invites.length) {
    return <OnboardingWizard step="company" onDone={({ companyId }) => onSelect(companyId)} />
  }

  return (
    <div className="space-y-8">
      <div>
        {/* «Ваша компания» врёт, когда их несколько, а на этой странице
            компанию выбирают — заголовок должен говорить именно об этом. */}
        <h1 className="text-xl font-bold tracking-tight">
          {companies.length > 1 ? t('start.pickCompanyTitle') : t('start.companyTitle')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {companies.length > 1 ? t('start.pickCompanySubtitle') : t('start.companySubtitle')}
        </p>
      </div>

      {invites.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground">{t('start.invitesTitle')}</h2>
          {invites.map((inv) => (
            <div key={inv.id} className="flex items-center justify-between rounded-lg border bg-card p-3">
              <div className="flex items-center gap-3">
                <Mail className="size-4 text-brand-ink" />
                <div>
                  <p className="text-sm font-medium">{inv.company.name}</p>
                  <p className="text-xs text-muted-foreground">{t(`roles.${inv.role}`)}</p>
                </div>
              </div>
              <Button variant="brand" size="sm" onClick={() => acceptInvite.mutate(inv.token)}>
                <Check className="size-3.5" />
                {t('start.accept')}
              </Button>
            </div>
          ))}
        </section>
      )}

      {/* Свои и чужие компании — разные вещи. В своей человек распоряжается
          людьми и проектами, в чужой он гость по приглашению; одним списком
          это различие терялось, а роль мелкой подписью читается не сразу. */}
      {[
        { key: 'own' as const, title: t('start.ownCompanies'), list: ownCompanies },
        { key: 'guest' as const, title: t('start.guestCompanies'), list: guestCompanies },
      ]
        .filter((g) => g.list.length > 0)
        .map((g) => (
          <section key={g.key} className="space-y-2">
            {/* Заголовок группы нужен, только когда групп две: с одной он
                повторяет заголовок страницы. */}
            {ownCompanies.length > 0 && guestCompanies.length > 0 && (
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{g.title}</h2>
            )}
            <div className="space-y-2">
              {g.list.map((c) => (
                <button
                  key={c.id}
                  onClick={() => onSelect(c.id)}
                  className="group flex w-full items-center gap-3 rounded-xl border bg-card p-3.5 text-start transition-colors hover:border-brand/50 hover:bg-accent"
                >
                  {c.logoUrl ? (
                    <img src={c.logoUrl} alt="" className="size-10 shrink-0 rounded-lg object-cover" />
                  ) : (
                    <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-secondary">
                      <Building2 className="size-4.5" />
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{c.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {t(`roles.${c.myRole}`)}
                      {typeof c.projectsCount === 'number' && (
                        <> · {t('start.projectsCount', { count: c.projectsCount })}</>
                      )}
                    </span>
                  </span>
                  {/* Стрелка: карточка ведёт внутрь, а не переключает что-то на месте. */}
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground rtl:rotate-180" />
                </button>
              ))}
            </div>
          </section>
        ))}

      {/* Своя компания одна: если она уже есть, форму не показываем — сервер
          всё равно откажет, а предлагать неисполнимое незачем. Участвовать в
          чужих можно в скольких угодно, туда попадают по приглашению. */}
      {/* Условие ОДНО с кнопкой в переключателе компаний (CompanySwitcher):
          там она показывается тому, у кого нет СВОЕЙ компании (isOwner), а
          здесь форма пряталась от любого, кто где-то админ. Признаки разные,
          и человек-админ-но-не-владелец видел кнопку, жал её, попадал сюда — а
          формы нет. Со стороны это выглядит как «кнопка не работает». */}
      {!companies.some((c) => c.isOwner) && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground">
            {companies.length ? t('start.orCreateCompany') : t('start.createFirstCompany')}
          </h2>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (name.trim()) createCompany.mutate(name.trim())
            }}
          >
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('start.companyName')} className="h-10" />
            <Button variant="brand" type="submit" disabled={!name.trim() || createCompany.isPending} className="h-10">
              <Plus className="size-4" />
              {t('start.create')}
            </Button>
          </form>
        </section>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Компания: табы Проекты / Команда
// ---------------------------------------------------------------------------

function CompanyHome({
  company,
  meId,
  onEntered,
  onDeleteCompany,
}: {
  company: Company
  meId?: string
  onDeleteCompany: (c: Company) => void
  onEntered: (projectId: string) => void
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  // таб компании — из URL: /start/:companyId/:companyTab (settings адресуем — на него ведёт чат без LLM)
  const { companyTab } = useParams()
  // Старые ссылки на /backup ведут в настройки, где он теперь и живёт:
  // адрес мог быть в закладке или в переписке.
  useEffect(() => {
    if (companyTab === 'backup') navigate(`/start/${company.id}/settings?s=backup`, { replace: true })
  }, [companyTab, company.id, navigate])

  const tab = (['overview', 'projects', 'team', 'time', 'connect', 'settings'] as const).includes(companyTab as never)
    ? (companyTab as 'overview' | 'projects' | 'team' | 'time' | 'connect' | 'settings')
    : 'overview'
  const canManage = company.myRole === 'admin' || company.myRole === 'manager'
  const isAdmin = company.myRole === 'admin'

  // Первый вход продолжается: компания есть, проектов нет. Ведём дальше тем же
  // визардом — пустой дашборд с семью вкладками и надписью «проектов пока нет»
  // не подсказывает, что делать.
  //
  // Шаг определяется данными, а не памятью о пройденном: projectsCount пришёл
  // с сервера, wizardProject держит только что созданный проект в этом сеансе.
  // Поэтому перезагрузка ничего не теряет.
  const [wizardProject, setWizardProject] = useState<string | null>(null)
  const [wizardDone, setWizardDone] = useState(false)
  // Визард идёт, пока проектов нет ИЛИ пока не пройден его последний шаг.
  //
  // Одного projectsCount мало: создав проект на втором шаге, мы обновляем
  // список компаний, счётчик становится единицей — и визард закрывался сам,
  // не показав приглашения. Признак «проектов нет» верно отвечает на вопрос
  // «нужен ли визард», но перестаёт отвечать на «идёт ли он прямо сейчас».
  const noProjects = (company.projectsCount ?? 0) === 0
  // Явный переход в настройки сильнее визарда: компания с внешней системой
  // идёт туда за ключами, и проектов у неё не будет вовсе — визард встречал
  // бы её на каждом заходе, не давая пройти дальше.
  const wantsSettings = tab === 'settings'
  const inWizard = !wizardDone && !wantsSettings && (noProjects || Boolean(wizardProject))

  if (canManage && inWizard) {
    return (
      <OnboardingWizard
        step={wizardProject ? 'team' : 'project'}
        companyId={company.id}
        projectId={wizardProject ?? undefined}
        onDone={({ projectId }) => {
          // Проект создан — идём к команде; команда пройдена или пропущена —
          // открываем сам проект, ради которого всё и затевалось.
          if (projectId && !wizardProject) {
            setWizardProject(projectId)
            return
          }
          setWizardDone(true)
          if (projectId) onEntered(projectId)
        }}
      />
    )
  }
  // доступ ко всей компании выдают те, кто ей управляет; бэкап — только админ
  const tabs = isAdmin
    ? (['overview', 'projects', 'team', 'time', 'connect', 'settings'] as const)
    : canManage
      ? (['overview', 'projects', 'team', 'time', 'connect', 'settings'] as const)
      : (['overview', 'projects', 'team', 'settings'] as const)

  return (
    <div className="space-y-6">
      {/* Что меня касается — до всего остального.
          Человек заходит на страницу компании и первым делом хочет знать, не
          ждёт ли его что-то. Полоса та же, что внутри проекта, только с именем
          проекта на карточке: здесь они вперемешку. */}
      <ProjectInbox projectId={null} companyId={company.id} />

      {/* Липкие табы: страница компании длинная (сводка, графики, списки), и
          переключиться, не прокрутив её обратно наверх, было нельзя.
          Фон обязателен — иначе содержимое просвечивает сквозь них при
          прокрутке. -mx-6/px-6 компенсируют отступ страницы, чтобы полоска
          снизу шла от края до края. */}
      {/* overflow-x-auto здесь НЕЛЬЗЯ: он создаёт и вертикальную прокрутку, а
          вместе с pt-8 внутри неё появляется что прокручивать — у полосы табов
          вырастал собственный скролл. Узкий экран разруливаем переносом
          (flex-wrap), а не прокруткой: табов немного. */}
      <nav className="sticky top-0 z-20 -mx-6 -mt-8 flex flex-wrap gap-1 border-b bg-background px-6 pb-0 pt-8">
        {tabs.map((key) => (
          <button
            key={key}
            onClick={() => navigate(key === 'overview' ? `/start/${company.id}` : `/start/${company.id}/${key}`)}
            className={cn(
              '-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors',
              tab === key
                ? 'border-brand text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t(`companyTabs.${key}`)}
          </button>
        ))}
      </nav>

      {tab === 'overview' ? (
        // Вход в проект (токен, правила чата) отрабатывает ProjectLayout —
        // здесь достаточно перейти по адресу.
        <OverviewTab
          companyId={company.id}
          onOpenProject={onEntered}
          // Фильтры едут в адресе: ссылку можно переслать, и вкладка «Часы»
          // прочитает их сама, даже если уже была смонтирована.
          onOpenReport={(userId, period) =>
            navigate(
              `/start/${company.id}/time?user=${encodeURIComponent(userId)}` +
                `&from=${encodeURIComponent(period.from)}&to=${encodeURIComponent(period.to)}`,
            )
          }
        />
      ) : tab === 'projects' ? (
        <ProjectsTab company={company} canManage={canManage} onEntered={onEntered} />
      ) : tab === 'team' ? (
        <TeamTab company={company} meId={meId} />
      ) : tab === 'time' && canManage ? (
        <>
          {/* Сводка сверху: за ней сюда и приходят — «сколько потрачено» и
              выгрузка. Свои записи ниже: они про «поправь мою строку», это
              разбор, а не чтение, и ради него не должно прокручиваться
              главное. */}
          <CompanyTimeTab companyId={company.id} />
          <MyRecentTime />
        </>
      ) : tab === 'connect' && canManage ? (
        <CompanyConnectTab company={company} />
      ) : (
        <CompanySettings company={company} isAdmin={isAdmin} onDeleteCompany={onDeleteCompany} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Настройки компании
// ---------------------------------------------------------------------------
//
// Секций стало столько, что до нужной приходилось прокручивать весь список, а
// «Опасная зона» оказывалась в одном потоке с обычными полями. Разложены по
// вкладкам, и вкладка живёт в адресе (?s=…): ссылкой на конкретную настройку
// делятся, а возврат из соседнего экрана не сбрасывает на первую.

const SETTINGS_TABS = ['company', 'time', 'ai', 'integration', 'backup', 'danger'] as const
type SettingsTab = (typeof SETTINGS_TABS)[number]

function CompanySettings({
  company,
  isAdmin,
  onDeleteCompany,
}: {
  company: Company
  isAdmin: boolean
  onDeleteCompany: (c: Company) => void
}) {
  const { t } = useTranslation()
  const [params, setParams] = useSearchParams()
  // Вкладки, до которых человеку нет доступа, не показываем — и в адресе они
  // тоже не срабатывают: иначе ссылка вела бы на пустоту.
  const tabs = SETTINGS_TABS.filter((k) => isAdmin || k === 'company' || k === 'time' || k === 'ai')
  const asked = params.get('s') as SettingsTab | null
  const tab: SettingsTab = asked && tabs.includes(asked) ? asked : 'company'

  const go = (key: SettingsTab) => {
    const p = new URLSearchParams(params)
    // Первая вкладка — состояние по умолчанию, и в адресе ей делать нечего.
    if (key === 'company') p.delete('s')
    else p.set('s', key)
    // replace: перебор вкладок не должен превращать кнопку «назад» в отмотку
    // по настройкам вместо возврата на прошлый экран.
    setParams(p, { replace: true })
  }

  return (
    <div className="space-y-6">
      <nav className="flex flex-wrap gap-1 border-b">
        {tabs.map((key) => (
          <button
            key={key}
            onClick={() => go(key)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm transition-colors',
              tab === key ? 'border-brand font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t(`companySettings.${key}`)}
          </button>
        ))}
      </nav>

      {tab === 'company' && (
        <>
          <CompanyProfile companyId={company.id} name={company.name} logoUrl={company.logoUrl} isAdmin={isAdmin} />
          <CompanyLocale companyId={company.id} current={company.locale ?? 'en'} isAdmin={isAdmin} />
          {/* Хранилище компании: проекты наследуют его, если не задали своё. */}
          {isAdmin && <CompanyStorageCard companyId={company.id} />}
        </>
      )}

      {tab === 'time' && <CompanyTimeSettings companyId={company.id} />}
      {/* Бэкап переехал сюда из верхнего ряда: его открывают раз в месяц, а
          место в главном меню занимал наравне с ежедневным. */}
      {tab === 'backup' && <BackupTab company={company} />}

      {tab === 'ai' && (
        <>
          <LlmSettings companyId={company.id} isAdmin={company.myRole === 'admin'} />
          {/* Своя почта: письма сотрудникам уходят с домена компании. Только
              админу — это доступ к отправке от её имени. */}
          {isAdmin && <MailSettings companyId={company.id} isAdmin={isAdmin} />}
        </>
      )}

      {/* Интеграция: ключи для внешней системы. Только админу — ключ даёт
          доступ ко всей компании. */}
      {tab === 'integration' && isAdmin && (
        <>
          <IntegrationSettings companyId={company.id} isAdmin={isAdmin} current={company} />
          <WebhooksSettings companyId={company.id} isAdmin={isAdmin} />
          <div className="rounded-xl border bg-card p-4">
            <ApiKeysTab companyId={company.id} isAdmin={isAdmin} />
          </div>
        </>
      )}

      {/* Необратимое — своей вкладкой: рядом с обычными настройками до него
          дотягивались случайно. */}
      {tab === 'danger' && isAdmin && (
        <DangerZone>
          <DangerAction
            title={t('start.deleteCompany')}
            description={t('danger.deleteCompanyHint')}
            actionLabel={t('start.deleteCompany')}
            onAction={() => onDeleteCompany(company)}
          />
        </DangerZone>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Таб «Проекты»: поиск + список + создание с конфигурацией (SPEC §4)
// ---------------------------------------------------------------------------


/** Время как в списке чатов: сегодня — часы, вчера — словом, дальше — дата. */
function relTime(iso: string, locale: string): string {
  const d = new Date(iso)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-1, 'day')
  return d.toLocaleDateString(locale, { day: 'numeric', month: 'short' })
}

// Обзор проекта в списке (SPEC §8.26): общий прогресс + отдельно мои задачи.
// Свой процент важнее общего — по нему видно, сколько осталось лично тебе.
function ProjectStats({ stats }: { stats: NonNullable<ProjectListItem['stats']> }) {
  const { t } = useTranslation()
  const myLeft = stats.myTotal - stats.myDone

  return (
    <span className="mt-1.5 block space-y-1">
      <span className="flex items-center gap-2">
        <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-secondary">
          <span
            className="block h-full rounded-full bg-brand transition-all"
            style={{ width: `${stats.progress}%` }}
          />
        </span>
        {/* процент явно: менеджеру нужен показатель по проекту одним взглядом */}
        <span className="shrink-0 text-[11px] font-semibold tabular-nums">{stats.progress}%</span>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {stats.tasksDone}/{stats.tasksTotal}
        </span>
      </span>

      {/* разбивка по статусам — что в работе, что ждёт ревью, что не начато */}
      <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
        {/* Кружки берут цвет из общего словаря статусов: раньше здесь были
            свои bg-sky-500 и bg-violet-500, и после смены палитры проект на
            стартовом экране светился не теми цветами, что его же задачи. */}
        {stats.tasksInProgress > 0 && (
          <span className="inline-flex items-center gap-1">
            <span className={cn('size-1.5 rounded-full', STATUS_DOT.in_progress)} />
            {t('tasks.status.in_progress')}: {stats.tasksInProgress}
          </span>
        )}
        {stats.tasksReview > 0 && (
          <span className="inline-flex items-center gap-1">
            <span className={cn('size-1.5 rounded-full', STATUS_DOT.review)} />
            {t('tasks.status.review')}: {stats.tasksReview}
          </span>
        )}
        {stats.tasksTodo > 0 && (
          <span className="inline-flex items-center gap-1">
            <span className={cn('size-1.5 rounded-full', STATUS_DOT.todo)} />
            {t('tasks.status.todo')}: {stats.tasksTodo}
          </span>
        )}
      </span>

      <span className="block text-[11px] text-muted-foreground">
        {stats.myTotal === 0
          ? t('start.statsNoMine')
          : myLeft === 0
            ? t('start.statsMineDone')
            : t('start.statsMine', { left: myLeft, total: stats.myTotal, pct: stats.myProgress })}
      </span>
    </span>
  )
}

function ProjectsTab({
  company,
  canManage,
  onEntered,
}: {
  company: Company
  canManage: boolean
  onEntered: (projectId: string) => void
}) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<ProjectSettings>({ name: '', about: '', chatRules: '', aiConfig: DEFAULT_AI_CONFIG })
  const [rulesModal, setRulesModal] = useState<{ projectId: string; projectName: string; chatRules: string } | null>(null)
  const [settingsFor, setSettingsFor] = useState<{ id: string; name: string; owner: boolean } | null>(null)
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null)

  const projectsQ = useQuery({
    queryKey: ['projects', company.id],
    queryFn: () => api<ProjectListItem[]>(`/api/v1/projects?companyId=${company.id}`),
  })

  const filtered = useMemo(() => {
    const list = projectsQ.data ?? []
    const needle = q.trim().toLowerCase()
    return needle ? list.filter((p) => p.name.toLowerCase().includes(needle)) : list
  }, [projectsQ.data, q])

  // Админ/менеджер компании видит все проекты, но участником не является.
  // Позволяем добавить себя — иначе такой проект невозможно открыть.
  const join = useMutation({
    mutationFn: async (projectId: string) => {
      const me = await api<Me>('/api/v1/auth/me')
      await api(`/api/v1/projects/${projectId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: me.id, role: 'admin' }),
      })
      return projectId
    },
    onSuccess: (projectId) => {
      qc.invalidateQueries({ queryKey: ['projects', company.id] })
      enter.mutate({ projectId })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const createProject = useMutation({
    mutationFn: (v: ProjectSettings) =>
      api<{ id: string }>('/api/v1/projects', {
        method: 'POST',
        body: JSON.stringify({ companyId: company.id, ...v }),
      }),
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ['projects', company.id] })
      setCreating(false)
      setForm({ name: '', about: '', chatRules: '', aiConfig: DEFAULT_AI_CONFIG })
      enter.mutate({ projectId: p.id, acceptRules: true })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })

  const enter = useMutation({
    mutationFn: ({ projectId, acceptRules }: { projectId: string; acceptRules?: boolean }) =>
      api<{ token: string; project: { id: string } }>(`/api/v1/projects/${projectId}/enter`, {
        method: 'POST',
        body: JSON.stringify({ acceptRules: acceptRules ?? false }),
      }),
    onSuccess: (r) => {
      setProjectToken(r.token)
      onEntered(r.project.id)
    },
    onError: (e: unknown, vars) => {
      const err = e as { status?: number; body?: { needRulesAccept?: boolean; chatRules?: string; projectName?: string } }
      if (err.status === 428 && err.body?.needRulesAccept) {
        setRulesModal({ projectId: vars.projectId, projectName: err.body.projectName ?? '', chatRules: err.body.chatRules ?? '' })
      } else {
        toast.error(e instanceof Error ? e.message : String(e))
      }
    },
  })

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('start.searchProjects')} className="ps-9" />
        </div>
        {/* Компания решила, что проекты приходят из внешней системы — кнопки
            быть не должно. Сервер такой запрос всё равно отклонит, но человеку
            незачем это выяснять нажатием. */}
        {canManage && !creating && !company.projectsViaApiOnly && (
          <Button variant="brand" onClick={() => setCreating(true)}>
            <Plus className="size-4" />
            {t('start.createProject')}
          </Button>
        )}
      </div>

      {/* Создание проекта — полная форма с правилами и конфигом ИИ */}
      {creating && (
        <div className="rounded-xl border bg-card p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-base font-bold">{t('projectForm.createTitle')}</h2>
            <Button variant="ghost" size="icon" onClick={() => setCreating(false)}>
              <X className="size-4" />
            </Button>
          </div>
          <ProjectSettingsForm value={form} onChange={setForm} />
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setCreating(false)}>
              {t('rules.decline')}
            </Button>
            <Button variant="brand" disabled={!form.name.trim() || createProject.isPending} onClick={() => createProject.mutate(form)}>
              {t('start.create')}
            </Button>
          </div>
        </div>
      )}

      {/*
        Карточки, а не строки: список проектов растёт, и вертикальная простыня
        заставляет читать всё подряд. Сетка даёт беглый обзор, а логотип и цвет
        работают как якорь — нужный проект находишь, не вчитываясь в названия.
        Внутри карточки порядок прежний (SPEC §8.29): кто, о чём последнее
        сообщение, сколько непрочитанных, как идут задачи.
      */}
      {projectsQ.isLoading && <p className="px-2 py-3 text-sm text-muted-foreground">…</p>}

      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {filtered.map((p) => {
          const unread = p.stats?.unread ?? 0
          return (
            <li key={p.id}>
              <div
                className={cn(
                  'flex h-full flex-col gap-3 rounded-xl border bg-card p-4 transition-colors',
                  p.isMember ? 'cursor-pointer hover:border-brand/50 hover:bg-accent' : 'opacity-70',
                )}
                onClick={() => p.isMember && enter.mutate({ projectId: p.id })}
              >
                <div className="flex items-start gap-3">
                  <ProjectBadge name={p.name} color={p.color} logoUrl={p.logoUrl} size={44} />

                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className={cn('truncate text-sm', unread > 0 ? 'font-bold' : 'font-semibold')}>{p.name}</span>
                      {unread > 0 && (
                        <span className="ms-auto grid min-w-5 shrink-0 place-items-center rounded-full bg-brand px-1.5 py-0.5 text-[10px] font-bold text-brand-foreground">
                          {unread > 99 ? '99+' : unread}
                        </span>
                      )}
                      {/* Настройки и удаление — под тремя точками: на карточке
                          им не место, а искать их внутри проекта не всегда удобно. */}
                      {(p.myRole === 'owner' || canManage) && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              onClick={(e) => e.stopPropagation()}
                              className={cn(
                                'shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground',
                                unread > 0 ? '' : 'ms-auto',
                              )}
                            >
                              <MoreVertical className="size-4" />
                            </button>
                          </DropdownMenuTrigger>
                          {/* Удаления здесь нет: оно живёт в опасной зоне
                              настроек, куда просто так не заходят. */}
                          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                            <DropdownMenuItem onSelect={() => // Админ компании удаляет любой её проект — так же, как решает сервер.
                              setSettingsFor({ id: p.id, name: p.name, owner: p.myRole === 'owner' || canManage })}>
                              <Settings className="size-4" />
                              {t('tabs.settings')}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <AvatarGroup members={p.members ?? []} total={p.memberCount} size={22} />
                      {p.lastMessage && (
                        <span className="ms-auto shrink-0 text-[11px] text-muted-foreground">
                          {relTime(p.lastMessage.at, i18n.language)}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Последнее сообщение — в две строки: в карточке места больше,
                    чем в строке, и обрывать его на полуслове незачем. */}
                <p className="line-clamp-2 min-h-8 text-xs text-muted-foreground">
                  {p.lastMessage ? (
                    <>
                      <span className="text-foreground/70">{p.lastMessage.author}:</span> {p.lastMessage.text}
                    </>
                  ) : p.isMember ? (
                    t('start.noMessages')
                  ) : (
                    t('start.notMember')
                  )}
                </p>

                {/* прогресс проекта — тонкой полосой внизу карточки */}
                {p.isMember && (p.stats?.tasksTotal ?? 0) > 0 && (
                  <div className="mt-auto flex items-center gap-2">
                    <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-secondary">
                      <span
                        className="block h-full rounded-full bg-brand transition-all"
                        style={{ width: `${p.stats!.progress}%` }}
                      />
                    </span>
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                      {p.stats!.tasksDone}/{p.stats!.tasksTotal}
                      {p.stats!.myTotal - p.stats!.myDone > 0 &&
                        ` · ${t('start.mineShort', { n: p.stats!.myTotal - p.stats!.myDone })}`}
                    </span>
                  </div>
                )}

                {/* Админ/менеджер видит все проекты компании, но не состоит в них */}
                {!p.isMember && canManage && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-auto w-full"
                    disabled={join.isPending}
                    onClick={(e) => {
                      e.stopPropagation()
                      join.mutate(p.id)
                    }}
                  >
                    {t('start.joinProject')}
                  </Button>
                )}
              </div>
            </li>
          )
        })}
      </ul>

      {!projectsQ.isLoading && filtered.length === 0 && (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {q ? t('start.nothingFound') : t('start.noProjects')}
        </p>
      )}

      {settingsFor && (
        <ProjectSettingsDialog
          projectId={settingsFor.id}
          onClose={() => setSettingsFor(null)}
          onDelete={
            settingsFor.owner
              ? () => {
                  setDeleting({ id: settingsFor.id, name: settingsFor.name })
                  setSettingsFor(null)
                }
              : undefined
          }
        />
      )}

      {deleting && (
        <DeleteProjectDialog
          projectId={deleting.id}
          projectName={deleting.name}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null)
            qc.invalidateQueries({ queryKey: ['projects', company.id] })
          }}
        />
      )}

      {rulesModal && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-6">
          <div className="w-full max-w-md rounded-xl border bg-card p-6 shadow-xl">
            <h2 className="text-lg font-bold">{t('rules.title', { project: rulesModal.projectName })}</h2>
            <p className="mt-3 whitespace-pre-wrap rounded-md bg-secondary p-3 text-sm">
              {rulesModal.chatRules || t('rules.empty')}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setRulesModal(null)}>
                {t('rules.decline')}
              </Button>
              <Button
                variant="brand"
                onClick={() => {
                  enter.mutate({ projectId: rulesModal.projectId, acceptRules: true })
                  setRulesModal(null)
                }}
              >
                {t('rules.accept')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
