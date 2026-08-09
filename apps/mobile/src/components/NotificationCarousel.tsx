import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import type { InboxItem, Project } from '../lib/api'
import { ago } from '../lib/format'
import { Avatar } from './Avatar'
import { Txt } from './Txt'
import { theme } from '../theme'

// Карусель уведомлений (SPEC §4.4).
//
// Показывает только моё непрочитанное — то, что меня затронуло. Чужая
// активность в проекте сюда не попадает: иначе лента растёт от чужой работы,
// и человек перестаёт её читать вовсе.
//
// На карточке: от кого, что произошло, когда — и снизу, отдельной строкой,
// лого и имя проекта, чтобы не гадать, откуда это.

export function NotificationCarousel({
  items,
  projects,
  onOpen,
}: {
  items: InboxItem[]
  projects: Project[]
  onOpen?: (item: InboxItem) => void
}) {
  const { t } = useTranslation()

  if (items.length === 0) {
    return (
      <View style={s.emptyBox}>
        <Txt style={s.empty}>{t('mobile.noNewNotifications')}</Txt>
      </View>
    )
  }

  const byId = new Map(projects.map((p) => [p.id, p]))

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={s.scroll}
      contentContainerStyle={s.content}
      // Карточки шире экрана: край следующей виден и подсказывает, что список
      // листается вбок.
      decelerationRate="fast"
      snapToInterval={CARD + 10}
      snapToAlignment="start"
    >
      {items.map((n) => {
        const project = byId.get(n.projectId)
        return (
          <Pressable key={n.id} style={s.card} onPress={() => onOpen?.(n)}>
            <View style={s.head}>
              <Avatar
                name={n.actor?.name ?? t('mobile.assistant')}
                logoUrl={n.actor?.avatarUrl ?? null}
                size={26}
                round
              />
              {/* Имя человека — чужой текст (Rule 3). */}
              <Txt auto style={s.actor} numberOfLines={1}>
                {n.actor?.name ?? t('mobile.assistant')}
              </Txt>
              <Txt style={s.time}>{ago(n.createdAt)}</Txt>
            </View>

            {/* Заголовок и текст уведомления приходят с сервера на языке
                проекта — направление их собственное. */}
            <Txt auto style={s.title} numberOfLines={1}>
              {n.title}
            </Txt>
            {n.summary ? (
              <Txt auto style={s.summary} numberOfLines={2}>
                {n.summary}
              </Txt>
            ) : null}

            <View style={s.foot}>
              <Avatar
                name={project?.name ?? n.projectName}
                logoUrl={project?.logoUrl ?? null}
                color={project?.color}
                size={18}
              />
              <Txt auto style={s.project} numberOfLines={1}>
                {n.projectName}
              </Txt>
            </View>
          </Pressable>
        )
      })}
    </ScrollView>
  )
}

const CARD = 250

const s = StyleSheet.create({
  // Карусель тянется от края до края, поэтому отрицательные поля гасят
  // отступы родителя: обрезанная карточка у края читается как продолжение.
  scroll: { marginHorizontal: -20, marginTop: 4 },
  content: { paddingHorizontal: 20, gap: 10 },
  card: {
    width: CARD,
    backgroundColor: theme.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 12,
    gap: 6,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  actor: { flex: 1, color: theme.fg, fontSize: 13, fontWeight: '600' },
  time: { color: theme.muted, fontSize: 11 },
  title: { color: theme.fg, fontSize: 14, fontWeight: '600' },
  summary: { color: theme.muted, fontSize: 13, lineHeight: 18 },
  foot: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginTop: 2,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: theme.border,
  },
  project: { flex: 1, color: theme.muted, fontSize: 12 },
  emptyBox: {
    backgroundColor: theme.card,
    borderRadius: 16,
    paddingVertical: 18,
    alignItems: 'center',
    marginTop: 4,
  },
  empty: { color: theme.muted, fontSize: 14 },
})
