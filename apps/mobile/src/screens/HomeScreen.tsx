import { useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  api,
  type Company,
  type InboxResponse,
  type Me,
  type Project,
  type RunningEntry,
} from '../lib/api'
import { theme } from '../theme'
import { Avatar } from '../components/Avatar'
import { Txt } from '../components/Txt'
import { TimerButton } from '../components/TimerButton'
import { NotificationCarousel } from '../components/NotificationCarousel'
import { ago, formatHours, ltrValue } from '../lib/format'
import { IconBell, IconChevronRight, IconPlus } from '../components/icons'

// Главный экран (SPEC §4.4).
//
// Порядок сверху вниз: полоса компании → шапка (аватар · часы · таймер ·
// колокольчик) → карусель уведомлений → проекты.
//
// Всё, что показано, — про меня: мои часы, мои уведомления, мои проекты.
// Чужая активность сюда не попадает и счётчики от неё не растут.

export function HomeScreen({
  me,
  company,
  onSwitchCompany,
  onLogout,
}: {
  me: Me | null
  company: Company
  onSwitchCompany: () => void
  onLogout: () => void
}) {
  const insets = useSafeAreaInsets()
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [refreshing, setRefreshing] = useState(false)

  const projectsQ = useQuery({
    queryKey: ['projects', company.id],
    queryFn: () => api<Project[]>(`/api/v1/projects?companyId=${encodeURIComponent(company.id)}`),
  })

  const inboxQ = useQuery({
    queryKey: ['inbox'],
    queryFn: () => api<InboxResponse>('/api/v1/inbox?onlyUnread=1&limit=30'),
  })

  const runningQ = useQuery({
    queryKey: ['running'],
    queryFn: () => api<{ items: RunningEntry[] }>('/api/v1/my/time/running'),
    // Таймер идёт и без нас: если его остановили в вебе или в трее, кнопка
    // здесь не должна показывать ход часов до следующего открытия экрана.
    refetchInterval: 60_000,
  })

  // Часы за текущий месяц. Границы считаем на устройстве в местном поясе —
  // человек спрашивает «сколько я наработал в этом месяце» про свой календарь.
  const monthFrom = useMemo(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
  }, [])

  const hoursQ = useQuery({
    queryKey: ['my-hours', monthFrom],
    queryFn: () => api<{ totalMinutes: number }>(`/api/v1/my/time/summary?from=${monthFrom}`),
  })

  const refresh = async () => {
    setRefreshing(true)
    await Promise.all([projectsQ.refetch(), inboxQ.refetch(), runningQ.refetch(), hoursQ.refetch()])
    setRefreshing(false)
  }

  const running = runningQ.data?.items?.[0] ?? null
  const unread = inboxQ.data?.unreadTotal ?? 0
  const unreadByProject = inboxQ.data?.unreadByProject ?? {}
  const projects = projectsQ.data ?? []
  // Создавать проекты может руководство компании. Нет права — нет и кнопки:
  // обещать действие, которое сервер отклонит, хуже, чем не обещать.
  const canCreate = company.myRole === 'admin' || company.myRole === 'manager'

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      {/* Полоса компании — над шапкой, самой верхней строкой. */}
      <Pressable style={s.companyBar} onPress={onSwitchCompany}>
        {/* Имя компании — чужой текст: направление отдаём платформе. */}
        <Txt auto style={s.companyName} numberOfLines={1}>
          {company.name}
        </Txt>
        <View style={s.companySwitch}>
          <Txt style={s.companySwitchText}>{t('start.changeCompany')}</Txt>
          <IconChevronRight size={13} color={theme.muted} />
        </View>
      </Pressable>

      <View style={s.header}>
        {/* Аватар, часы и таймер — одна группа: всё это про меня и про мою
            работу. Кнопка пуска стоит вплотную к часам, потому что запускают
            её ради них; у колокольчика с ней общего нет. */}
        <Pressable
          onPress={onLogout}
          accessibilityRole="button"
          accessibilityLabel={t('start.logout')}
        >
          <Avatar name={me?.name || me?.email || '?'} logoUrl={me?.avatarUrl ?? null} size={38} round />
        </Pressable>

        {/* Часы за месяц — крупным числом: это главная цифра экрана.
            Ошибку показываем прочерком, а не нулём: «0» — правдоподобное
            значение, и человек поверит, что не наработал ничего, вместо
            того чтобы понять, что данные не пришли. */}
        <Pressable style={s.hours} hitSlop={8} accessibilityRole="button">
          <Txt ltr style={[s.hoursValue, hoursQ.isError && s.hoursOff]}>
            {hoursQ.isPending || hoursQ.isError ? '—' : formatHours(hoursQ.data?.totalMinutes ?? 0)}
          </Txt>
          <Txt style={s.hoursLabel}>{hoursQ.isError ? t('mobile.noData') : t('mobile.perMonth')}</Txt>
        </Pressable>

        <TimerButton running={running} projects={projects} onChanged={() => void qc.invalidateQueries()} />

        <View style={s.headerSpacer} />

        <Pressable
          style={s.bell}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('inbox.title')}
        >
          <IconBell size={22} color={theme.fg} />
          {unread > 0 ? (
            <View style={s.badge}>
              {/* Счётчик — цифры: всегда слева направо (Rule 5). */}
              <Txt ltr style={s.badgeText}>
                {unread > 99 ? '99+' : unread}
              </Txt>
            </View>
          ) : null}
        </Pressable>
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={[s.scrollContent, { paddingBottom: insets.bottom + 24 }]}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={theme.muted} />
        }
      >
        <NotificationCarousel items={inboxQ.data?.items ?? []} projects={projects} />

        <View style={s.projectsHead}>
          <Txt style={s.sectionTitle}>{t('mobile.projects')}</Txt>
          {projects.length > 0 ? <Txt ltr style={s.count}>{projects.length}</Txt> : null}
        </View>

        {projectsQ.isPending ? (
          <ActivityIndicator color={theme.brand} style={s.loader} />
        ) : projects.length === 0 ? (
          <Txt style={s.empty}>
            {canCreate ? t('mobile.projectsEmptyCanCreate') : t('mobile.projectsEmpty')}
          </Txt>
        ) : (
          projects.map((p) => (
            <ProjectRow key={p.id} project={p} unread={unreadByProject[p.id] ?? 0} />
          ))
        )}

        {canCreate ? (
          <Pressable style={s.create}>
            <IconPlus size={19} color={theme.brandFg} />
            <Txt style={s.createText}>{t('mobile.createProject')}</Txt>
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  )
}

function ProjectRow({ project, unread }: { project: Project; unread: number }) {
  const { t } = useTranslation()
  const last = project.lastMessage
  return (
    <Pressable style={s.row}>
      <Avatar name={project.name} logoUrl={project.logoUrl ?? null} color={project.color} size={48} />
      <View style={s.rowText}>
        {/* Имя проекта и текст сообщения пишет человек — направление их
            собственное, и прибивать его нельзя (Rule 3). */}
        <Txt auto style={s.rowName} numberOfLines={1}>
          {project.name}
        </Txt>
        <Txt auto style={s.rowLast} numberOfLines={1}>
          {/* Имя автора и текст пишут разные люди на разных языках. Имя
              изолируем: латинское имя перед ивритским сообщением иначе
              перескакивает в конец строки. */}
          {last ? `${ltrValue(last.author)}: ${last.text}` : t('mobile.noMessages')}
        </Txt>
      </View>
      <View style={s.rowRight}>
        {unread > 0 ? (
          <View style={s.badgeSolid}>
            <Txt ltr style={s.badgeText}>{unread > 99 ? '99+' : unread}</Txt>
          </View>
        ) : null}
        {last ? <Txt style={s.rowAgo}>{ago(last.at)}</Txt> : null}
      </View>
    </Pressable>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  companyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  companyName: { color: theme.muted, fontSize: 13, fontWeight: '600', flex: 1 },
  companySwitch: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  companySwitchText: { color: theme.muted, fontSize: 13 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  headerSpacer: { flex: 1 },
  // Часы прижаты к аватару, а таймер — к часам: три элемента об одном.
  hours: { gap: 0 },
  // Главная цифра экрана. Табличные цифры, чтобы число не дёргалось при
  // смене значения, и отрицательный трекинг — крупные цифры иначе рыхлые.
  hoursValue: {
    color: theme.fg,
    fontSize: 26,
    fontWeight: '700',
    letterSpacing: -0.7,
    fontVariant: ['tabular-nums'],
    lineHeight: 30,
  },
  // Прочерк вместо числа — приглушённо: это отсутствие данных, а не значение.
  hoursOff: { color: theme.muted },
  hoursLabel: { color: theme.muted, fontSize: 11, lineHeight: 13 },
  bell: { padding: 6 },
  badge: {
    position: 'absolute',
    top: 0,
    right: 0,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: theme.danger,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  badgeSolid: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: theme.danger,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 20, gap: 10 },
  projectsHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  sectionTitle: { color: theme.fg, fontSize: 20, fontWeight: '700' },
  count: { color: theme.muted, fontSize: 14 },
  loader: { marginTop: 24 },
  empty: { color: theme.muted, fontSize: 14, lineHeight: 20, marginTop: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: theme.card,
    borderRadius: 16,
    padding: 12,
  },
  rowText: { flex: 1, gap: 3 },
  rowName: { color: theme.fg, fontSize: 16, fontWeight: '600' },
  rowLast: { color: theme.muted, fontSize: 13 },
  rowRight: { alignItems: 'flex-end', gap: 6 },
  rowAgo: { color: theme.muted, fontSize: 11 },
  create: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: theme.brand,
    borderRadius: 999,
    paddingVertical: 16,
    marginTop: 8,
  },
  createText: { color: theme.brandFg, fontSize: 16, fontWeight: '700' },
})
