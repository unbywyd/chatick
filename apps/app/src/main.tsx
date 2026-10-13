import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter, Routes, Route, Navigate, useLocation, useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Compass } from 'lucide-react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { api, getSessionToken } from '@/lib/api'
import { Button } from '@/components/ui/button'
import './index.css'
import './i18n'
import { useDesktopSync, usePresence } from './hooks/useDesktop'
import { GrantRequestDialog, type GrantRequest } from '@/components/GrantRequestDialog'
import { useSystemNotifications } from './hooks/useSystemNotifications'
import { UpdateBanner } from './components/UpdateBanner'
import { NotifyPermissionPrompt } from './components/NotifyPermissionPrompt'
import { ThemeProvider } from './providers/theme'
import { ConfirmProvider } from './components/ui/confirm'
import { EnterScreen } from './screens/EnterScreen'
import { PublicShareScreen } from './screens/PublicShareScreen'
import { ImageViewer } from './components/ImageViewer'
import { Shell, StartRedirect } from './v2/Shell'
import { legacyTarget } from './v2/legacy'
import { TasksView } from './v2/tasks/TasksView'
import { TaskPage, TaskNew } from './v2/task/TaskPage'
import { DocsView, NotesView } from './v2/docs/DocsView'
import { TimeView } from './v2/time/TimeView'
import { ResourcesView } from './v2/library/ResourcesView'
import { FilesView } from './v2/library/FilesView'
import { HistoryView } from './v2/library/HistoryView'
import { TeamView } from './v2/team/TeamView'
import { Welcome } from './v2/company/Welcome'
import { VersionsView } from './v2/versions/VersionsView'
import { CompanyView } from './v2/company/CompanyView'
import { SettingsView } from './v2/settings/SettingsView'
import { NotificationsView } from './v2/settings/NotificationsView'
import { LoginScreenV2, CodeScreenV2, AuthCallbackV2, InviteV2, ConsentV2, NewCompanyV2, CompaniesV2 } from './v2/auth/AuthScreens'

// HashRouter — единый роутинг для веба и Electron (file://) без доп. настроек.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      /**
       * Не повторять то, что не станет лучше от повтора.
       *
       * По умолчанию react-query бьётся трижды с нарастающей задержкой. Для
       * упавшей сети это разумно, для 401 — нет: токена не появится оттого,
       * что мы спросили ещё раз. Человек, открывший ссылку без входа, получал
       * 18 запросов вместо 9, красную простыню в консоли и восемь секунд
       * «загрузки» вместо мгновенного экрана входа (замерено по HAR).
       *
       * 5xx и обрыв связи по-прежнему повторяем дважды — там повтор помогает.
       */
      retry: (count, error) => {
        const status = (error as { status?: number } | null)?.status
        if (status && status >= 400 && status < 500) return false
        return count < 2
      },
      /**
       * Данные не протухают в ту же секунду, когда пришли.
       *
       * По умолчанию react-query считает ответ устаревшим сразу же и лезет за
       * ним заново при каждом монтировании компонента. На переходе между
       * проектами это означало десятки запросов за одними и теми же данными:
       * список проектов, компании, состояние таймера, счётчики. Приходило то
       * же самое, но пока запрос летел, интерфейс успевал моргнуть — сайдбар
       * и таймер пропадали и появлялись на каждом клике.
       *
       * Тридцать секунд — не «данные устарели», а «за это время их не могли
       * изменить незаметно для нас». Всё, что меняется чаще, обновляется не
       * этим механизмом: у живых списков есть свой refetchInterval, а после
       * действий человека мы явно зовём invalidateQueries — staleTime его не
       * отменяет. Там, где нужна другая свежесть, значение переопределяется
       * на самом запросе.
       */
      staleTime: 30_000,
    },
  },
})

/**
 * Список «Мои задачи» обновляется вместе со списком задач проекта.
 *
 * Панель показывает задачи ВСЕХ проектов компании и живёт на своём ключе.
 * Значит ни одна из четырнадцати точек, где сбрасывается ['tasks', projectId],
 * её не задевала: человек закрывал задачу, она исчезала из списка проекта и
 * оставалась в панели до следующего опроса — до минуты.
 *
 * Дописывать вторую строчку в каждую из четырнадцати точек — гарантия забыть
 * одну, а забытая проявится не сразу. Поэтому правило одно и здесь: кто
 * трогает задачи проекта, тот трогает и мои.
 */
queryClient.getQueryCache().subscribe((event) => {
  if (event.type !== 'updated' || event.action?.type !== 'invalidate') return
  if (event.query.queryKey[0] !== 'tasks') return
  void queryClient.invalidateQueries({ queryKey: ['my-tasks'] })
})

/** Хук требует роутер, поэтому вызываем его из компонента внутри HashRouter. */
function DesktopSync() {
  useDesktopSync()
  usePresence()
  // Системные уведомления — и в браузере, и в Electron.
  useSystemNotifications()

  /**
   * Просьба ассистента одобрить его код.
   *
   * Живёт здесь, а не на экране подключения: просьба приходит когда угодно, а
   * человек в этот момент смотрит на задачи или чат. Экран, до которого надо
   * дойти самому, означал бы, что ассистент ждёт таймаута.
   */
  const [grant, setGrant] = useState<GrantRequest | null>(null)
  useEffect(() => {
    const bridge = window.chatickDesktop
    if (!bridge?.onGrantRequest) return
    return bridge.onGrantRequest((p) => setGrant(p))
  }, [])

  if (!grant) return null
  return (
    <GrantRequestDialog
      request={grant}
      onDone={(approved) => {
        window.chatickDesktop?.grantResult?.({ id: grant.id, approved })
        setGrant(null)
      }}
    />
  )
}

/**
 * Старый адрес проекта `/p/:id` — без компании (до SPEC §8.45).
 *
 * Письма с такими ссылками уже разосланы и лежат в почтовых ящиках; починка
 * генератора спасает только будущие. Здесь узнаём компанию по проекту и
 * уводим на нынешний адрес — человек из письма попадает туда, куда шёл.
 *
 * Не нашли (нет доступа, проект удалён) — на список проектов: там ему хотя бы
 * объяснят, а белый экран не объясняет ничего.
 */
function LegacyProjectRedirect() {
  const { id } = useParams()
  const { data, isError } = useQuery({
    queryKey: ['legacy-project', id],
    queryFn: () => api<{ companyId: string }>(`/api/v1/projects/${id}`),
    enabled: Boolean(id),
    retry: false,
  })
  if (isError) return <Navigate to="/start" replace />
  if (!data) return null
  return <Navigate to={`/c/${data.companyId}?p=${encodeURIComponent(id ?? '')}`} replace />
}

/**
 * Старый адрес первой версии — в адрес v2. Чем переводить — v2/legacy.ts
 * (там же сказано, почему такие ссылки нельзя просто выбросить).
 */
function LegacyRedirect() {
  const { pathname, search } = useLocation()
  let last: string | null = null
  try {
    last = localStorage.getItem('chatick_v2_company')
  } catch {
    last = null
  }
  const to = legacyTarget(pathname, search, last)
  return to ? <Navigate to={to} replace /> : <NotFoundScreen />
}

/**
 * Адрес, которого нет.
 *
 * Роутер, не найдя маршрут, не рисует НИЧЕГО — человек видит белый экран и
 * решает, что сломался продукт. Так выглядела ссылка из старого письма, но
 * причин попасть сюда больше: опечатка в адресе, ссылка на удалённое, старая
 * закладка.
 *
 * Кнопка ведёт туда, где человек точно не застрянет: вошедшего — к проектам,
 * остальных — на вход. Отправлять незалогиненного «к проектам» значит показать
 * ему форму входа под заголовком «страница не найдена».
 */
function NotFoundScreen() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const signedIn = Boolean(getSessionToken())
  return (
    <div className="grid h-dvh place-items-center p-6 text-center">
      <div className="max-w-sm">
        <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-secondary text-muted-foreground">
          <Compass className="size-7" />
        </span>
        <h2 className="mt-4 text-base font-semibold">{t('notFound.title')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t('notFound.text')}</p>
        <Button variant="brand" className="mt-5" onClick={() => navigate(signedIn ? '/start' : '/login')}>
          {signedIn ? t('notFound.cta') : t('notFound.ctaLogin')}
        </Button>
      </div>
    </div>
  )
}

// Обёртки: тянут контекст layout'а (Outlet) и параметры URL


createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <ConfirmProvider>
          <HashRouter>
            {/* связь с десктопной оболочкой: трей, бейдж, уведомления.
                В браузере хук не делает ничего. */}
            <DesktopSync />
            {/* Новая версия приехала — предлагаем перезагрузиться, а не ждём,
                пока человек догадается сделать это сам. */}
            <UpdateBanner />
            {/* Без разрешения браузер молчит, а попросить его было негде */}
            <NotifyPermissionPrompt />
            <Routes>
              <Route path="/" element={<LoginScreenV2 />} />
              <Route path="/enter" element={<EnterScreen />} />
              <Route path="/login" element={<LoginScreenV2 />} />
              <Route path="/login/code" element={<CodeScreenV2 />} />
              <Route path="/new-company" element={<NewCompanyV2 />} />
              <Route path="/companies" element={<CompaniesV2 />} />
              <Route path="/auth" element={<AuthCallbackV2 />} />
              {/* приём приглашения по ссылке из письма */}
              <Route path="/invite/:token" element={<InviteV2 />} />
              {/* подключение внешнего ИИ (Claude Code) — SPEC §8.27 */}
              <Route path="/connect" element={<ConsentV2 />} />
              {/* публичная ссылка: открывается без входа — SPEC §8.34 */}
              <Route path="/s/:slug" element={<PublicShareScreen />} />
              {/* Компания и её табы адресуемы: /start/:companyId/(projects|team|settings) */}
              {/* уведомления — глобальная страница: они приходят из всех
                  проектов сразу, и разбирают их тоже сразу все */}
              <Route path="/inbox" element={<LegacyRedirect />} />
              {/* системные уведомления — настройка программы, не проекта */}
              <Route path="/settings/notifications" element={<LegacyRedirect />} />
              <Route path="/settings/profile" element={<LegacyRedirect />} />
              {/* v2: один экран на компанию, проекты — фильтр сверху. */}
              <Route path="/start" element={<StartRedirect />} />
              <Route path="/onboarding" element={<LegacyRedirect />} />
              <Route path="/c/:companyId" element={<Shell />}>
                <Route index element={<TasksView />} />
                <Route path="task/new" element={<TaskNew />} />
                <Route path="task/:taskId" element={<TaskPage />} />
                <Route path="docs/*" element={<DocsView />} />
                <Route path="notes/*" element={<NotesView />} />
                <Route path="time/*" element={<TimeView />} />
                <Route path="resources/*" element={<ResourcesView />} />
                <Route path="files/*" element={<FilesView />} />
                <Route path="versions/*" element={<VersionsView />} />
                <Route path="history" element={<HistoryView />} />
                <Route path="team" element={<TeamView />} />
                <Route path="welcome" element={<Welcome />} />
                <Route path="company/*" element={<CompanyView />} />
                <Route path="settings/:tab?" element={<SettingsView />} />
                <Route path="notifications" element={<NotificationsView />} />
              </Route>
              <Route path="/start/:companyId" element={<LegacyRedirect />} />
              <Route path="/start/:companyId/:companyTab" element={<LegacyRedirect />} />
              {/* Компания в адресе: контекст известен до загрузки проекта.
                  Пока он грузился, шапка подставляла первую компанию из
                  списка — человек видел чужое название над своим проектом. */}
              {/* Старый адрес проекта, без компании.
                  Такие ссылки разосланы в письмах «вас добавили в проект» и
                  живут в чужих почтовых ящиках вечно — маршрут убрать нельзя,
                  иначе человек снова получит белый экран. Узнаём компанию и
                  переводим на нынешний адрес. */}
              <Route path="/p/:id" element={<LegacyProjectRedirect />} />
              {/* Экраны проекта первой версии убраны: старые адреса — в v2 (v2/legacy.ts). */}
              <Route path="/c/:companyId/p/:id/*" element={<LegacyRedirect />} />
              {/* Всё остальное. Без этого неизвестный адрес давал пустой
                  экран: роутер не находит маршрут и не рисует ничего, а
                  человек видит белую страницу вместо объяснения. */}
              <Route path="*" element={<NotFoundScreen />} />
            </Routes>
          </HashRouter>
        </ConfirmProvider>
        {/* Один на всё приложение: картинки приходят из текста задач,
            документов и заметок — вешать просмотр в каждом месте значит
            однажды забыть про одно из них. */}
        <ImageViewer />
        {/* Тоасты в токенах темы (richColors игнорирует тему и светит белым
            в тёмном интерфейсе). Снизу справа — чтобы не перекрывать шапку. */}
        <Toaster
          position="bottom-right"
          duration={3000}
          gap={8}
          offset={16}
          toastOptions={{
            unstyled: true,
            classNames: {
              toast:
                'group pointer-events-auto flex w-full items-center gap-2.5 rounded-lg border border-border bg-card px-3.5 py-2.5 text-sm text-card-foreground shadow-lg',
              title: 'font-medium',
              description: 'text-muted-foreground',
              icon: 'shrink-0',
              actionButton: 'ms-auto rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground',
              cancelButton: 'ms-auto rounded-md bg-secondary px-2 py-1 text-xs font-medium',
              closeButton: 'border-border bg-card text-muted-foreground',
              success: '[&_[data-icon]]:text-brand-ink',
              error: 'border-destructive/40 [&_[data-icon]]:text-destructive',
              warning: '[&_[data-icon]]:text-amber-500',
              info: '[&_[data-icon]]:text-muted-foreground',
            },
          }}
        />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
)
