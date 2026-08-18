import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Bell, Bot, Building2, Camera, Check, Info, Keyboard, LogOut, Pencil, Plug, SlidersHorizontal, User, Users, X, Bug } from 'lucide-react'
import { api, API_URL, getSessionToken, setSessionToken, setProjectToken, type Me } from '@/lib/api'
import { Avatar } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { useConfirm } from '@/components/ui/confirm'
import { ConnectDialog } from '@/screens/ConnectScreen'
import { AboutDialog } from '@/components/AboutDialog'
import { BugReportDialog } from '@/components/BugReportDialog'
import { ProjectSettingsDialog } from '@/components/ProjectSettingsDialog'
import { DeleteProjectDialog } from '@/components/DeleteProjectDialog'
import { LanguageSelect } from '@/components/LanguageSelect'
import { ThemeToggle } from '@/components/ThemeToggle'

// Меню профиля в шапке (SPEC §8.19): аватар → профиль (смена фото/имени),
// уведомления, ИИ и расходы (только admin), выход с подтверждением.
export function ProfileMenu({
  me,
  projectId,
  projectName,
  companyId,
  isAdmin,
}: {
  me?: Me
  projectId?: string
  /** Нужно для подтверждения удаления: человек вводит имя проекта. */
  projectName?: string
  companyId?: string
  isAdmin?: boolean
}) {
  const [connectOpen, setConnectOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)

  // ?about=1 в адресе — так «О проекте» открывается из трея и по прямой
  // ссылке, а не только кликом по этому меню.
  const [params, setParams] = useSearchParams()
  useEffect(() => {
    if (params.get('about') !== '1') return
    setAboutOpen(true)
    const next = new URLSearchParams(params)
    next.delete('about')
    setParams(next, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.get('about')])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [bugOpen, setBugOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const { t } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const confirm = useConfirm()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(me?.name ?? '')
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const refreshMe = () => qc.invalidateQueries({ queryKey: ['me'] })

  const saveName = async () => {
    if (!name.trim() || name.trim() === me?.name) {
      setEditing(false)
      return
    }
    try {
      await api('/api/v1/auth/me', { method: 'PATCH', body: JSON.stringify({ name: name.trim() }) })
      toast.success(t('profile.saved'))
      setEditing(false)
      refreshMe()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  const uploadAvatar = async (file: File) => {
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      // эндпоинт требует session-токен (профиль — не проектная сущность);
      // на стартовом экране project-токена вообще нет
      const res = await fetch(`${API_URL}/api/v1/auth/me/avatar`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getSessionToken()}` },
        body: fd,
      })
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText)
      toast.success(t('profile.photoUpdated'))
      refreshMe()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
    }
  }

  const logout = async () => {
    if (!(await confirm({ title: t('profile.logoutConfirm'), confirmLabel: t('profile.logout'), destructive: true }))) return
    setProjectToken(null)
    setSessionToken(null)
    // Кэш чистим целиком: в нём лежат компании, проекты и профиль ушедшего
    // человека. Следующий увидел бы их до первого ответа сервера.
    qc.clear()
    // replace, а не push: иначе адрес компании остаётся в истории, и после
    // входа под другим аккаунтом приложение возвращается на неё — а у нового
    // человека такой компании нет. Он видит «Компания недоступна», хотя сам
    // никуда не переходил: в десктопе адресной строки не видно, и понять,
    // откуда взялся чужой маршрут, невозможно.
    navigate('/login', { replace: true })
  }

  return (
    <>
    <DropdownMenu onOpenChange={(o) => !o && setEditing(false)}>
      <DropdownMenuTrigger asChild>
        <button className="rounded-full outline-none ring-offset-2 ring-offset-background transition-shadow focus-visible:ring-2 focus-visible:ring-ring" title={me?.name}>
          <Avatar name={me?.name} src={me?.avatarUrl} size={28} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {/* Шапка профиля */}
        <div className="flex items-center gap-3 p-2">
          <div className="relative">
            <Avatar name={me?.name} src={me?.avatarUrl} size={44} />
            <button
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              title={t('profile.changePhoto')}
              className="absolute -bottom-1 -end-1 grid size-5 place-items-center rounded-full border bg-background text-muted-foreground hover:text-foreground"
            >
              <Camera className="size-3" />
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                if (e.target.files?.[0]) uploadAvatar(e.target.files[0])
                e.target.value = ''
              }}
            />
          </div>
          <div className="min-w-0 flex-1">
            {editing ? (
              <div className="flex items-center gap-1">
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter') saveName()
                    if (e.key === 'Escape') setEditing(false)
                  }}
                  onKeyDownCapture={(e) => e.stopPropagation()}
                  className="h-7 w-full rounded border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
                <button onClick={saveName} className="text-brand-ink"><Check className="size-4" /></button>
                <button onClick={() => setEditing(false)} className="text-muted-foreground"><X className="size-4" /></button>
              </div>
            ) : (
              <button className="group flex items-center gap-1.5" onClick={() => { setName(me?.name ?? ''); setEditing(true) }}>
                <span className="truncate text-sm font-semibold">{me?.name || me?.email}</span>
                <Pencil className="size-3 text-muted-foreground opacity-0 group-hover:opacity-100" />
              </button>
            )}
            <p className="truncate text-xs text-muted-foreground">{me?.email}</p>
          </div>
        </div>

        <DropdownMenuSeparator />

        {/* Настройки компании: язык, ключи API, вебхуки, связь с внешней
            системой. Раньше попасть туда можно было только через список
            проектов — а компании, у которой проекты приходят снаружи, идти
            в этот список незачем и не за чем. */}
        {companyId && (
          <DropdownMenuItem onSelect={() => navigate(`/start/${companyId}/settings`)}>
            <Building2 className="size-4" />
            {t('profile.companySettings')}
          </DropdownMenuItem>
        )}

        {/* Настройки проекта и состав команды — сюда, вкладками они не были
            нужны: в настройки заходят изредка, а команду смотрят из профиля. */}
        {projectId && isAdmin && (
          <DropdownMenuItem onSelect={() => setSettingsOpen(true)}>
            <SlidersHorizontal className="size-4" />
            {t('profile.projectSettings')}
          </DropdownMenuItem>
        )}
        {projectId && (
          <DropdownMenuItem onSelect={() => navigate(`/c/${companyId}/p/${projectId}/team`)}>
            <Users className="size-4" />
            {t('profile.projectTeam')}
          </DropdownMenuItem>
        )}

        {projectId && (
          <DropdownMenuItem onSelect={() => navigate(`/c/${companyId}/p/${projectId}/notifications`)}>
            <Bell className="size-4" />
            {t('tabs.notifications')}
          </DropdownMenuItem>
        )}
        {projectId && isAdmin && (
          <DropdownMenuItem onSelect={() => navigate(`/c/${companyId}/p/${projectId}/ai`)}>
            <Bot className="size-4" />
            {t('tabs.ai')}
          </DropdownMenuItem>
        )}

        {/* Профиль отдельной страницей: правка имени рядом с «Выйти» — это
            промах ценой выхода из аккаунта. В меню остаётся вход. */}
        <DropdownMenuItem onSelect={() => navigate('/settings/profile')}>
          <User className="size-4" />
          {t('profile.title')}
        </DropdownMenuItem>

        {/* Системные уведомления — про приложение, поэтому без привязки
            к проекту, в отличие от подписок на события */}
        <DropdownMenuItem onSelect={() => navigate('/settings/notifications')}>
          <Bell className="size-4" />
          {t('notif.system')}
        </DropdownMenuItem>

        {projectId && (
          <DropdownMenuItem onSelect={() => navigate(`/c/${companyId}/p/${projectId}/shortcuts`)}>
            <Keyboard className="size-4" />
            {t('shortcuts.title')}
          </DropdownMenuItem>
        )}

        {/* Подключение внешнего ИИ — настройка пользователя, а не проекта,
            поэтому доступна из любого места (SPEC §8.27). Модалкой, а не
            отдельным экраном: уводить из проекта ради ввода кода незачем. */}
        <DropdownMenuItem onSelect={() => setConnectOpen(true)}>
          <Plug className="size-4" />
          {t('connect.menuItem')}
        </DropdownMenuItem>

        {companyId && (
          <DropdownMenuItem onSelect={() => navigate(`/start/${companyId}`)}>
            <Building2 className="size-4" />
            {t('sidebar.companySettings')}
          </DropdownMenuItem>
        )}

        <DropdownMenuSeparator />

        {/* Язык и тема — здесь же: отдельное меню-гамбургер рядом было лишним */}
        <div className="flex items-center justify-between gap-2 px-2 py-1.5">
          <span className="text-xs text-muted-foreground">{t('project.language')}</span>
          <LanguageSelect />
        </div>
        <div className="flex items-center justify-between gap-2 px-2 py-1.5">
          <span className="text-xs text-muted-foreground">{t('project.theme')}</span>
          <ThemeToggle />
        </div>

        <DropdownMenuSeparator />
        {/* «О проекте» здесь же, где связь с нами: искать это в отдельном
            разделе никто не станет. */}
        {/* Сообщить о проблеме — отдельным пунктом, а не внутри «О проекте»:
            про баг сообщают в момент, когда он случился. */}
        <DropdownMenuItem onSelect={() => setBugOpen(true)}>
          <Bug className="size-4" />
          {t('bug.title')}
        </DropdownMenuItem>

        <DropdownMenuItem onSelect={() => setAboutOpen(true)}>
          <Info className="size-4" />
          {t('about.title')}
        </DropdownMenuItem>

        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={logout} className="text-destructive focus:text-destructive">
          <LogOut className="size-4" />
          {t('profile.logout')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    {connectOpen && <ConnectDialog onClose={() => setConnectOpen(false)} />}
    {aboutOpen && <AboutDialog me={me} onClose={() => setAboutOpen(false)} />}
    {bugOpen && <BugReportDialog me={me} onClose={() => setBugOpen(false)} />}
    {settingsOpen && projectId && (
      <ProjectSettingsDialog
        projectId={projectId}
        onClose={() => setSettingsOpen(false)}
        // Раньше сюда onDelete не передавали, и в настройках, открытых изнутри
        // проекта, удаления просто не было — в отличие от того же диалога из
        // списка проектов. Человек искал кнопку там, где её быть и не могло.
        onDelete={
          isAdmin && projectName
            ? () => {
                setSettingsOpen(false)
                setDeleting(true)
              }
            : undefined
        }
      />
    )}
    {deleting && projectId && projectName && (
      <DeleteProjectDialog
        projectId={projectId}
        projectName={projectName}
        onClose={() => setDeleting(false)}
        onDeleted={() => {
          setDeleting(false)
          // Проекта больше нет — оставаться на его экране некуда.
          navigate('/start', { replace: true })
        }}
      />
    )}
    </>
  )
}
