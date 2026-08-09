import { useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTranslation } from 'react-i18next'
import { api, type Project, type RunningEntry } from '../lib/api'
import { projectToken, RulesRequired } from '../lib/project-token'
import { formatClock } from '../lib/format'
import { Avatar } from './Avatar'
import { Txt } from './Txt'
import { useDirection } from '../lib/direction'
import { IconPause, IconPlay, IconSearch } from './icons'
import { theme } from '../theme'

// Кнопка таймера в шапке (SPEC §4.4).
//
// Два состояния:
//  — покой: кнопка «плей», нажатие открывает шторку выбора проекта;
//  — ход: лого проекта, кнопка «пауза» и тикающие часы.
//
// Часы считаются от startedAt, а не накоплением в интервале: если приложение
// свернуть, таймеры в фоне останавливаются, и накопленное отстанет от правды.
// Вычитание дат переживает и сворачивание, и перезапуск.

export function TimerButton({
  running,
  projects,
  onChanged,
}: {
  running: RunningEntry | null
  projects: Project[]
  onChanged: () => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  // Пересчитываем раз в секунду, только когда часы идут.
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [running])

  const seconds = running ? Math.floor((Date.now() - new Date(running.startedAt).getTime()) / 1000) : 0
  // tick только заставляет перерисоваться; значение берётся из времени старта.
  void tick

  const project = running ? projects.find((p) => p.id === running.projectId) : null

  const stop = async () => {
    if (!running || busy) return
    setBusy(true)
    setError(null)
    try {
      const token = await projectToken(running.projectId)
      await api(`/api/v1/time/${encodeURIComponent(running.id)}/stop`, { method: 'POST' }, token)
      onChanged()
    } catch {
      setError(t('mobile.stopFailed'))
    } finally {
      setBusy(false)
    }
  }

  const start = async (p: Project, description: string) => {
    setBusy(true)
    setError(null)
    try {
      const token = await projectToken(p.id)
      await api(
        '/api/v1/time/start',
        { method: 'POST', body: JSON.stringify({ projectId: p.id, description }) },
        token,
      )
      setOpen(false)
      onChanged()
    } catch (e) {
      // Правила чата не приняты — принять их можно только там, где виден их
      // текст. Отправлять человека в веб ради запуска таймера незачем, но и
      // молча согласиться за него нельзя.
      setError(e instanceof RulesRequired ? t('mobile.acceptRulesFirst') : t('mobile.startFailed'))
    } finally {
      setBusy(false)
    }
  }

  if (running) {
    return (
      <Pressable style={s.live} onPress={() => void stop()} disabled={busy}>
        <Avatar
          name={project?.name ?? running.projectName}
          logoUrl={project?.logoUrl ?? null}
          color={project?.color}
          size={22}
        />
        {/* Часы — цифры: в RTL группы иначе переставятся местами (Rule 5). */}
        <Txt ltr style={s.clock}>
          {formatClock(seconds)}
        </Txt>
        {busy ? (
          <ActivityIndicator size="small" color={theme.brandFg} />
        ) : (
          <IconPause size={15} color={theme.brandFg} />
        )}
      </Pressable>
    )
  }

  return (
    <>
      <Pressable style={s.idle} onPress={() => setOpen(true)} hitSlop={8}>
        {/* Знак «пуск» указывает вперёд — в RTL это другая сторона; компонент
            отражает его сам. */}
        <IconPlay size={15} color={theme.brand} />
      </Pressable>

      <PickerSheet
        open={open}
        projects={projects}
        busy={busy}
        error={error}
        onClose={() => {
          setOpen(false)
          setError(null)
        }}
        onPick={(p, d) => void start(p, d)}
      />
    </>
  )
}

function PickerSheet({
  open,
  projects,
  busy,
  error,
  onClose,
  onPick,
}: {
  open: boolean
  projects: Project[]
  busy: boolean
  error: string | null
  onClose: () => void
  onPick: (p: Project, description: string) => void
}) {
  const insets = useSafeAreaInsets()
  const { t } = useTranslation()
  // Поле ввода само за раскладкой не следует — направление задаём явно и из
  // языка приложения (I18nManager.isRTL на устройстве бывает несогласован).
  const { textAlign } = useDirection()
  const [q, setQ] = useState('')
  const [what, setWhat] = useState('')
  const inputRef = useRef<TextInput>(null)

  // Трекать можно только там, где состоишь: сервер иначе ответит 403.
  const mine = projects.filter((p) => p.isMember)
  const found = q.trim()
    ? mine.filter((p) => p.name.toLowerCase().includes(q.trim().toLowerCase()))
    : mine

  return (
    <Modal visible={open} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={s.backdrop} onPress={onClose} />
      <View style={[s.sheet, { paddingBottom: insets.bottom + 16 }]}>
        <View style={s.grabber} />
        <Txt style={s.sheetTitle}>{t('mobile.whatWorkingOn')}</Txt>

        <TextInput
          ref={inputRef}
          style={[s.field, { textAlign }]}
          value={what}
          onChangeText={setWhat}
          placeholder={t('mobile.descriptionOptional')}
          placeholderTextColor={theme.muted}
          maxLength={500}
        />

        {mine.length > 6 ? (
          <View style={s.searchRow}>
            <IconSearch size={17} color={theme.muted} style={s.searchIcon} />
            <TextInput
              style={[s.field, s.searchField]}
              value={q}
              onChangeText={setQ}
              placeholder={t('projSwitch.search')}
              placeholderTextColor={theme.muted}
            />
          </View>
        ) : null}

        {error ? <Txt style={s.error}>{error}</Txt> : null}

        <ScrollView style={s.list} keyboardShouldPersistTaps="handled">
          {found.length === 0 ? (
            <Txt style={s.empty}>
              {mine.length === 0 ? t('mobile.notMemberAnywhere') : t('mobile.nothingFound')}
            </Txt>
          ) : (
            found.map((p) => (
              <Pressable key={p.id} style={s.item} disabled={busy} onPress={() => onPick(p, what.trim())}>
                <Avatar name={p.name} logoUrl={p.logoUrl ?? null} color={p.color} size={36} />
                <Txt auto style={s.itemName} numberOfLines={1}>
                  {p.name}
                </Txt>
                {busy ? (
                  <ActivityIndicator size="small" color={theme.muted} />
                ) : (
                  <IconPlay size={14} color={theme.brand} />
                )}
              </Pressable>
            ))
          )}
        </ScrollView>
      </View>
    </Modal>
  )
}

const s = StyleSheet.create({
  idle: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    borderColor: theme.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchRow: { justifyContent: 'center' },
  // Иконка лежит поверх поля у начала строки: start, а не left,
  // иначе в иврите она окажется поверх текста.
  searchIcon: { position: 'absolute', start: 13, zIndex: 1 },
  searchField: { paddingStart: 40 },
  live: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    backgroundColor: theme.brand,
    borderRadius: 999,
    // start/end вместо left/right: намерение читается прямо (Rule 1).
    // Со стороны лого отступ меньше: круглый значок сам добавляет воздуха,
    // и равные поля выглядели бы съехавшими.
    paddingStart: 6,
    paddingEnd: 13,
    paddingVertical: 6,
  },
  // Табличные цифры: без них секунды меняют ширину и плашка дёргается.
  clock: {
    color: theme.brandFg,
    fontSize: 15,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    letterSpacing: -0.2,
  },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: {
    backgroundColor: theme.card,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 20,
    paddingTop: 10,
    gap: 10,
    maxHeight: '75%',
  },
  grabber: { width: 40, height: 4, borderRadius: 2, backgroundColor: theme.border, alignSelf: 'center' },
  sheetTitle: { color: theme.fg, fontSize: 19, fontWeight: '700', marginTop: 6 },
  field: {
    backgroundColor: theme.cardSoft,
    borderRadius: 12,
    color: theme.fg,
    fontSize: 15,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  list: { marginTop: 4 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  itemName: { flex: 1, color: theme.fg, fontSize: 16 },
  itemPlay: { color: theme.brand, fontSize: 14 },
  empty: { color: theme.muted, fontSize: 14, paddingVertical: 20, textAlign: 'center' },
  error: { color: theme.danger, fontSize: 13 },
})
