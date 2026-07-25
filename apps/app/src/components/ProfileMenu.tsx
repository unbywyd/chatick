import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Bell, Bot, Camera, Check, LogOut, Pencil, Plug, X } from 'lucide-react'
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

// Меню профиля в шапке (SPEC §8.19): аватар → профиль (смена фото/имени),
// уведомления, ИИ и расходы (только admin), выход с подтверждением.
export function ProfileMenu({ me, projectId, isAdmin }: { me?: Me; projectId?: string; isAdmin?: boolean }) {
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
    navigate('/login')
  }

  return (
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
                <button onClick={saveName} className="text-brand"><Check className="size-4" /></button>
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

        {projectId && (
          <DropdownMenuItem onSelect={() => navigate(`/p/${projectId}/notifications`)}>
            <Bell className="size-4" />
            {t('tabs.notifications')}
          </DropdownMenuItem>
        )}
        {projectId && isAdmin && (
          <DropdownMenuItem onSelect={() => navigate(`/p/${projectId}/ai`)}>
            <Bot className="size-4" />
            {t('tabs.ai')}
          </DropdownMenuItem>
        )}

        {/* Подключение внешнего ИИ — настройка пользователя, а не проекта,
            поэтому доступна из любого места (SPEC §8.27) */}
        <DropdownMenuItem onSelect={() => navigate('/connect')}>
          <Plug className="size-4" />
          {t('connect.menuItem')}
        </DropdownMenuItem>

        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={logout} className="text-destructive focus:text-destructive">
          <LogOut className="size-4" />
          {t('profile.logout')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
