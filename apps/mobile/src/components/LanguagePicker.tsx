import { useState } from 'react'
import { Modal, Pressable, StyleSheet, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { LOCALES, type LocaleCode } from '../i18n'
import { useChangeLanguage } from '../i18n/useChangeLanguage'
import { Txt } from './Txt'
import { IconCheck, IconGlobe } from './icons'
import { theme } from '../theme'

// Переключатель языка.
//
// Доступен с первого экрана, до входа: человек, открывший приложение впервые,
// должен иметь возможность прочитать его на своём языке, а не после того, как
// разберётся с чужим.
//
// Смена мгновенная, в том числе между языками разного направления: его задаёт
// DirectionProvider через свойство direction, а не нативный флаг с
// перезагрузкой. Предупреждение о перезапуске убрано — перезапуска нет.

export function LanguagePicker({ compact = false }: { compact?: boolean }) {
  const { t, i18n } = useTranslation()
  const change = useChangeLanguage()
  const [open, setOpen] = useState(false)

  const current = LOCALES.find((l) => l.code === i18n.language) ?? LOCALES[0]

  const pick = async (code: LocaleCode) => {
    setOpen(false)
    await change(code)
  }

  return (
    <>
      <Pressable
        style={[s.trigger, compact && s.triggerCompact]}
        onPress={() => setOpen(true)}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={t('mobile.language')}
      >
        <IconGlobe size={14} color={theme.muted} />
        <Txt style={s.triggerText}>{current.label}</Txt>
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={s.backdrop} onPress={() => setOpen(false)}>
          <View style={s.sheet}>
            <Txt style={s.title}>{t('mobile.language')}</Txt>
            {LOCALES.map((l) => (
              <Pressable key={l.code} style={s.item} onPress={() => void pick(l.code)}>
                <Txt style={[s.itemText, l.code === current.code && s.itemActive]}>{l.label}</Txt>
                {l.code === current.code ? <IconCheck size={17} color={theme.brand} /> : null}
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>

    </>
  )
}

const s = StyleSheet.create({
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.border,
  },
  triggerCompact: { paddingHorizontal: 9, paddingVertical: 5 },
  triggerText: { color: theme.muted, fontSize: 13, fontWeight: '600' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', padding: 32 },
  sheet: { backgroundColor: theme.card, borderRadius: 18, padding: 18, gap: 6, width: '100%', maxWidth: 340 },
  title: { color: theme.muted, fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 4 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 13 },
  itemText: { flex: 1, color: theme.fg, fontSize: 17 },
  itemActive: { color: theme.brand, fontWeight: '700' },
})
