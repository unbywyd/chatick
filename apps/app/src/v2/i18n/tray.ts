import i18n from '@/i18n'

/**
 * Строки панели в трее (v2). Своего i18n у панели нет: веб присылает ей
 * готовые подписи вместе с состоянием (hooks/useDesktop.ts → strings).
 * Тексты — из макета Tray.dc.html; то, что в v2 уже есть (ходы, «от кого»,
 * «вся компания», «сегодня»), берётся из общих ключей v2, а не дублируется.
 */
const ru = {
  tray: {
    mine: 'На мне',
    waiting: 'Ждут меня',
    all: 'Все',
    openInApp: 'Откроется в Chatick',
    emptyH: 'На тебе ничего',
    emptyP: 'Таймер работает и без задач. Новые появятся здесь.',
    inboxEmpty: 'Здесь появится то, что ждёт твоего ответа.',
    allNotes: 'Все уведомления в Chatick',
    loginH: 'Вход не выполнен',
    loginP: 'Войди в Chatick — и здесь появятся твои задачи и таймер.',
    loginBtn: 'Открыть Chatick и войти',
    startShort: 'Старт',
    idle: 'Таймер остановлен',
    account: 'Аккаунт',
    hours: 'Мои часы',
    profile: 'Профиль',
    notifySettings: 'Настройка уведомлений',
    connect: 'Подключить ассистента',
    back: 'Назад',
    done: 'Готово',
    sent: 'Отправлено',
    tasks_one: '{{count}} задача',
    tasks_few: '{{count}} задачи',
    tasks_many: '{{count}} задач',
    tasks_other: '{{count}} задачи',
  },
}

const en: typeof ru = {
  tray: {
    mine: 'On me',
    waiting: 'Waiting on me',
    all: 'All',
    openInApp: 'Opens in Chatick',
    emptyH: 'Nothing on you',
    emptyP: 'The timer works without tasks too. New ones will show up here.',
    inboxEmpty: 'Whatever is waiting for your reply will show up here.',
    allNotes: 'All notifications in Chatick',
    loginH: 'You’re not signed in',
    loginP: 'Sign in to Chatick and your tasks and timer will show up here.',
    loginBtn: 'Open Chatick and sign in',
    startShort: 'Start',
    idle: 'Timer stopped',
    account: 'Account',
    hours: 'My hours',
    profile: 'Profile',
    notifySettings: 'Notification settings',
    connect: 'Connect an assistant',
    back: 'Back',
    done: 'Done',
    sent: 'Sent',
    tasks_one: '{{count}} task',
    tasks_few: '{{count}} tasks',
    tasks_many: '{{count}} tasks',
    tasks_other: '{{count}} tasks',
  },
}

const he: typeof ru = {
  tray: {
    mine: 'עליי',
    waiting: 'מחכים לי',
    all: 'הכל',
    openInApp: 'ייפתח ב־Chatick',
    emptyH: 'אין עליך כלום',
    emptyP: 'הטיימר עובד גם בלי משימות. חדש יופיע כאן.',
    inboxEmpty: 'מה שמחכה לתשובה שלך יופיע כאן.',
    allNotes: 'כל ההתראות ב־Chatick',
    loginH: 'לא מחובר',
    loginP: 'התחבר ל־Chatick, והמשימות והטיימר שלך יופיעו כאן.',
    loginBtn: 'פתח את Chatick והתחבר',
    startShort: 'התחל',
    idle: 'הטיימר עצור',
    account: 'חשבון',
    hours: 'השעות שלי',
    profile: 'פרופיל',
    notifySettings: 'הגדרות התראות',
    connect: 'חיבור עוזר',
    back: 'חזרה',
    done: 'בוצע',
    sent: 'נשלח',
    tasks_one: 'משימה אחת',
    tasks_few: '{{count}} משימות',
    tasks_many: '{{count}} משימות',
    tasks_other: '{{count}} משימות',
  },
}

i18n.addResourceBundle('ru', 'v2', ru, true, true)
i18n.addResourceBundle('en', 'v2', en, true, true)
i18n.addResourceBundle('he', 'v2', he, true, true)
