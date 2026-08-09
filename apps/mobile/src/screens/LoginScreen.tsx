import { useRef, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { signInWithGoogle } from '../lib/auth'
import { Logo } from '../components/Logo'
import { Txt } from '../components/Txt'
import { LanguagePicker } from '../components/LanguagePicker'
import { theme } from '../theme'

// Вход. Одна кнопка: она ведёт на наш экран входа в браузере, а там способов
// два — Google и код на почту.
//
// Кнопка НЕ блокируется на время ожидания: в браузере что-то могло пойти не
// так, и человек вправе начать заново, не дожидаясь десяти минут. В десктопе
// эта блокировка уже стоила залипшего экрана — повторять не будем.

export function LoginScreen({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation()
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Номер попытки: по нему прежний опрос понимает, что больше не нужен.
  const attempt = useRef(0)

  const start = async () => {
    const mine = ++attempt.current
    setError(null)
    setWaiting(true)
    try {
      const res = await signInWithGoogle(() => attempt.current !== mine)
      if (attempt.current !== mine) return
      if (res === 'ok') return onDone()
      if (res === 'denied') setError(t('mobile.signInDenied'))
      if (res === 'expired') setError(t('mobile.signInExpired'))
    } catch {
      if (attempt.current === mine) setError(t('mobile.signInError'))
    } finally {
      if (attempt.current === mine) setWaiting(false)
    }
  }

  const cancel = () => {
    attempt.current++
    setWaiting(false)
    setError(null)
  }

  // Заголовок с выделенным словом: ищем его в строке, а не режем перевод на
  // куски. Разбитый на три ключа заголовок невозможно перевести — порядок слов
  // в иврите и английском разный, и склейка даёт бессмыслицу.
  const title = t('mobile.heroTitle')
  const accent = t('mobile.heroTitleAccent')
  const at = title.indexOf(accent)

  return (
    <View style={s.root}>
      {/* Язык доступен до входа: человек должен прочитать первый экран на
          своём языке, а не после того, как разберётся с чужим. */}
      <View style={s.langRow}>
        <LanguagePicker compact />
      </View>

      <View style={s.top}>
        {/* Знак — первое, что человек видит. Без него экран читался как
            страница текста: непонятно даже, какое приложение открылось. */}
        <Logo size={34} />
        <Txt style={s.title}>
          {at >= 0 ? (
            <>
              {title.slice(0, at)}
              <Txt style={s.titleAccent}>{accent}</Txt>
              {title.slice(at + accent.length)}
            </>
          ) : (
            title
          )}
        </Txt>
        <Txt style={s.sub}>{t('mobile.heroSubtitle')}</Txt>
      </View>

      <View style={s.bottom}>
        {error ? <Txt style={s.error}>{error}</Txt> : null}

        {/* «Войти в Chatick», а не «Войти через Google».
            Кнопка ведёт не к Google, а на наш экран входа в браузере — там
            способов два: Google и код на почту, и второй у корпоративной
            почты часто единственный. Обещать один способ и показать другой
            экран хуже, чем назвать вещи своими именами. */}
        <Pressable style={s.btn} onPress={start}>
          {waiting ? <ActivityIndicator color={theme.brandFg} /> : null}
          <Txt style={s.btnText}>{waiting ? t('mobile.signInAgain') : t('mobile.signIn')}</Txt>
        </Pressable>

        {/* Сказать заранее, что откроется браузер: иначе переход выглядит как
            сбой — «меня выкинуло из приложения». */}
        <Txt style={s.hint}>{waiting ? t('mobile.signInWaiting') : t('mobile.signInHint')}</Txt>

        {waiting ? (
          <Pressable onPress={cancel} hitSlop={12}>
            <Txt style={s.cancel}>{t('common.cancel')}</Txt>
          </Pressable>
        ) : null}
      </View>
    </View>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg, paddingHorizontal: 24, justifyContent: 'space-between' },
  // Переключатель прижат к концу строки — в иврите это левый край, и RN
  // отзеркалит flex-end сам (Rule 2: руками не переворачиваем).
  langRow: { flexDirection: 'row', justifyContent: 'flex-end', paddingTop: 52 },
  // Блок опущен от верха и держится ближе к середине: с paddingTop: 120 текст
  // прижимался к статус-бару, а между ним и кнопкой оставалась пустота в две
  // трети экрана — экран читался как незагрузившийся.
  top: { flex: 1, justifyContent: 'center', gap: 20, paddingBottom: 40 },
  title: { color: theme.fg, fontSize: 40, fontWeight: '700', lineHeight: 46 },
  titleAccent: { color: theme.brand },
  // Отступ задаёт gap блока — свой marginTop сложился бы с ним вторым слоем.
  sub: { color: theme.muted, fontSize: 16, lineHeight: 22 },
  bottom: { paddingBottom: 56, gap: 12, alignItems: 'center' },
  error: { color: theme.danger, fontSize: 14, textAlign: 'center', marginBottom: 4 },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: theme.brand,
    borderRadius: 999,
    paddingVertical: 18,
    width: '100%',
  },
  btnText: { color: theme.brandFg, fontSize: 16, fontWeight: '700' },
  // Подсказка длиннее прежней и переносится — без центровки вторая строка
  // висела бы слева, а кнопка над ней стоит по центру.
  hint: { color: theme.muted, fontSize: 13, textAlign: 'center', lineHeight: 18 },
  cancel: { color: theme.muted, fontSize: 13, textDecorationLine: 'underline' },
})
