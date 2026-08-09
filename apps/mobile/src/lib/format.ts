import i18n from '../i18n'

// Форматирование для списков. Держим в одном месте: часы и даты показываются
// на нескольких экранах, и разные написания одного и того же читаются как
// разные данные.
//
// Числа и даты — через Intl с текущей локалью: в иврите свои формы
// множественного числа, а порядок «9 авг» и «Aug 9» зависит от языка.

/**
 * Часы за период — крупным числом в шапке: «16ч».
 *
 * Округляем ВВЕРХ до часа. За месяц минуты не значат ничего: «15ч 12м» — это
 * три единицы измерения там, где человек хочет знать порядок величины, а
 * «15:12» обещает точность до минуты, которой в месячном итоге нет. Вверх, а
 * не к ближайшему, потому что начатый час уже отработан.
 *
 * Единица берётся из словаря, а НЕ из Intl. Сначала здесь стоял
 * Intl.NumberFormat со style: 'unit' — в Node он даёт правильные «שע׳», но
 * Hermes на устройстве собран без полных данных ICU и молча отдаёт
 * английское «h». На экране это выглядело как «15h 12m» посреди иврита:
 * ошибки нет, исключения нет, просто чужой язык.
 */
export function formatHours(minutes: number): string {
  const m = Math.max(0, minutes)
  const h = Math.ceil(m / 60)
  return `${h}${i18n.t('mobile.hourShort')}`
}

/**
 * Минуты → «7ч 30м». Для списков записей, где минуты существенны: там речь
 * об одном отрезке работы, а не об итоге за месяц.
 */
export function formatHm(minutes: number): string {
  const m = Math.max(0, Math.round(minutes))
  const h = Math.floor(m / 60)
  const rest = m % 60
  const hUnit = i18n.t('mobile.hourShort')
  const mUnit = i18n.t('mobile.minuteShort')
  if (h === 0) return `${rest}${mUnit}`
  if (rest === 0) return `${h}${hUnit}`
  return `${h}${hUnit} ${rest}${mUnit}`
}

/**
 * Секунды → «1:05:09» для идущего таймера.
 *
 * Всегда слева направо, даже в иврите: время — это порядковая запись, и в
 * RTL-окружении группы цифр переставились бы местами (Rule 5 руководства).
 */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(sec).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/**
 * «2 мин назад». Для давнего — дата: «14 июля» в этом году и с годом дальше.
 *
 * Относительное время удобно, пока речь о часах; для прошлого месяца «43200
 * минут назад» человеку не говорит ничего.
 */
export function ago(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diff = Math.floor((Date.now() - then) / 1000)
  const t = i18n.t.bind(i18n)

  if (diff < 60) return t('mobile.justNow')
  if (diff < 3600) return t('mobile.minutesAgo', { count: Math.floor(diff / 60) })
  if (diff < 86400) return t('mobile.hoursAgo', { count: Math.floor(diff / 3600) })
  if (diff < 7 * 86400) return t('mobile.daysAgo', { count: Math.floor(diff / 86400) })

  const d = new Date(then)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString(i18n.language || 'en', {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}
