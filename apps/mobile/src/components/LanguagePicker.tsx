import { useRef, useState } from 'react'
import { Modal, Pressable, StyleSheet, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { LOCALES, type LocaleCode } from '../i18n'
import { useChangeLanguage } from '../i18n/useChangeLanguage'
import { Txt } from './Txt'
import { theme } from '../theme'

// Переключатель языка.
//
// Доступен с первого экрана, до входа: человек, открывший приложение впервые,
// должен иметь возможность прочитать его на своём языке, а не после того, как
// разберётся с чужим.
//
// Смена направления письма требует перезапуска (Rule 6), поэтому о нём
// предупреждаем заранее — иначе приложение «само закрылось».

export function LanguagePicker({ compact = false }: { compact?: boolean }) {
  const { t, i18n } = useTranslation()
  const change = useChangeLanguage()
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState<LocaleCode | null>(null)
  // Ответ на вопрос «перезапустить?» приходит из обработчика кнопки, а не из
  // рендера, поэтому держим продолжение в ref, а не в состоянии.
  const resolveRef = useRef<((v: boolean) => void) | null>(null)

  const current = LOCALES.find((l) => l.code === i18n.language) ?? LOCALES[0]

  const pick = async (code: LocaleCode) => {
    setOpen(false)
    await change(code, {
      onDirectionChange: () =>
        new Promise<boolean>((resolve) => {
          // Показываем предупреждение своим экраном, а не Alert: Alert не
          // переводится вместе с приложением и выглядит чужеродно.
          resolveRef.current = resolve
          setConfirming(code)
        }),
    })
  }

  const answer = (ok: boolean) => {
    const resolve = resolveRef.current
    resolveRef.current = null
    setConfirming(null)
    resolve?.(ok)
  }

  return (
    <>
      <Pressable style={[s.trigger, compact && s.triggerCompact]} onPress={() => setOpen(true)} hitSlop={10}>
        <Txt style={s.triggerText}>{current.label}</Txt>
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={s.backdrop} onPress={() => setOpen(false)}>
          <View style={s.sheet}>
            <Txt style={s.title}>{t('mobile.language')}</Txt>
            {LOCALES.map((l) => (
              <Pressable key={l.code} style={s.item} onPress={() => void pick(l.code)}>
                <Txt style={[s.itemText, l.code === current.code && s.itemActive]}>{l.label}</Txt>
                {l.code === current.code ? <Txt style={s.check}>✓</Txt> : null}
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>

      <Modal visible={confirming !== null} transparent animationType="fade">
        <View style={s.backdrop}>
          <View style={s.sheet}>
            <Txt style={s.warn}>{t('mobile.restartForDirection')}</Txt>
            <View style={s.actions}>
              <Pressable style={s.ghostBtn} onPress={() => answer(false)}>
                <Txt style={s.ghostText}>{t('common.cancel')}</Txt>
              </Pressable>
              <Pressable style={s.primaryBtn} onPress={() => answer(true)}>
                <Txt style={s.primaryText}>{t('mobile.continue')}</Txt>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </>
  )
}

const s = StyleSheet.create({
  trigger: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: theme.border },
  triggerCompact: { paddingHorizontal: 8, paddingVertical: 4 },
  triggerText: { color: theme.muted, fontSize: 13, fontWeight: '600' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', padding: 32 },
  sheet: { backgroundColor: theme.card, borderRadius: 18, padding: 18, gap: 6, width: '100%', maxWidth: 340 },
  title: { color: theme.muted, fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 4 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 13 },
  itemText: { flex: 1, color: theme.fg, fontSize: 17 },
  itemActive: { color: theme.brand, fontWeight: '700' },
  check: { color: theme.brand, fontSize: 16 },
  warn: { color: theme.fg, fontSize: 15, lineHeight: 21 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 14 },
  ghostBtn: { flex: 1, borderWidth: 1, borderColor: theme.border, borderRadius: 999, paddingVertical: 13, alignItems: 'center' },
  ghostText: { color: theme.fg, fontSize: 15, fontWeight: '600' },
  primaryBtn: { flex: 1, backgroundColor: theme.brand, borderRadius: 999, paddingVertical: 13, alignItems: 'center' },
  primaryText: { color: theme.brandFg, fontSize: 15, fontWeight: '700' },
})
