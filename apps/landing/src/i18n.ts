export const LOCALES = [
  { code: 'en', label: 'English', dir: 'ltr', path: '/' },
  { code: 'ru', label: 'Русский', dir: 'ltr', path: '/ru/' },
  { code: 'he', label: 'עברית', dir: 'rtl', path: '/he/' },
] as const

export type LocaleCode = (typeof LOCALES)[number]['code']

type Dict = {
  meta: { title: string; description: string }
  nav: { start: string }
  hero: { title1: string; titleAccent: string; title2: string; subtitle: string; cta: string; note: string }
  pain: { title: string; items: { title: string; text: string }[] }
  solution: { title: string; subtitle: string; items: { title: string; text: string }[] }
  how: { title: string; steps: { title: string; text: string }[] }
  cta: { title: string; subtitle: string; button: string }
  footer: { rights: string }
}

export const dict: Record<LocaleCode, Dict> = {
  en: {
    meta: {
      title: 'Chatick — project workspace where chat is the interface',
      description:
        'One source of truth for your team: project chat with an AI dispatcher, tasks, files and credentials. Stop losing work in WhatsApp.',
    },
    nav: { start: 'Get started' },
    hero: {
      title1: 'Your project.',
      titleAccent: ' One chat.',
      title2: ' Zero chaos.',
      subtitle:
        'Chatick is a project workspace where the chat is the interface and an AI dispatcher keeps everything in order — translates, answers repeated questions, and turns status messages into task updates.',
      cta: 'Get started',
      note: 'Free while in beta',
    },
    pain: {
      title: 'Sound familiar?',
      items: [
        { title: 'Two sources of truth', text: 'Tasks live in a tracker, real talk happens in WhatsApp. Nothing matches.' },
        { title: 'Files vanish', text: 'Documents are sent to chats where nobody will ever find them again.' },
        { title: 'Same questions, again', text: '“What’s the status?” — asked five times a day, answered five times a day.' },
        { title: 'Language friction', text: 'The team writes in three languages and half the context gets lost.' },
      ],
    },
    solution: {
      title: 'Chatick fixes this with an AI dispatcher',
      subtitle: 'Every message passes through the project AI before it reaches the team.',
      items: [
        { title: 'Live translation', text: 'Everyone writes in their language. Everyone reads in theirs.' },
        { title: 'No repeated questions', text: 'If the answer already exists in the chat, tasks or files — the AI answers instead of pinging people.' },
        { title: 'Statuses become tasks', text: '“Done with the login page” updates the task instead of flooding the chat.' },
        { title: 'Everything in one place', text: 'Tasks, files and credentials live next to the chat — managed by chat.' },
      ],
    },
    how: {
      title: 'How it works',
      steps: [
        { title: 'Create a project', text: 'A project is a group. Invite your team — the chat and workspace are ready.' },
        { title: 'Talk as usual', text: 'The AI dispatcher quietly translates, deduplicates and routes.' },
        { title: 'Ask the project, not people', text: 'Statuses, files, decisions — the AI finds answers faster than a human replies.' },
      ],
    },
    cta: {
      title: 'Make your project the single source of truth',
      subtitle: 'Web today. Desktop for Windows & macOS next.',
      button: 'Open Chatick',
    },
    footer: { rights: 'All rights reserved.' },
  },
  ru: {
    meta: {
      title: 'Chatick — рабочее пространство проекта, где чат — интерфейс',
      description:
        'Единый источник правды для команды: чат проекта с ИИ-диспетчером, задачи, файлы и доступы. Хватит терять работу в WhatsApp.',
    },
    nav: { start: 'Начать' },
    hero: {
      title1: 'Ваш проект.',
      titleAccent: ' Один чат.',
      title2: ' Ноль хаоса.',
      subtitle:
        'Chatick — рабочее пространство проекта, где чат является интерфейсом, а ИИ-диспетчер наводит порядок: переводит, отвечает на повторные вопросы и превращает статусы в обновления задач.',
      cta: 'Начать',
      note: 'Бесплатно на время беты',
    },
    pain: {
      title: 'Знакомо?',
      items: [
        { title: 'Два источника правды', text: 'Задачи — в трекере, реальное общение — в WhatsApp. Ничего не сходится.' },
        { title: 'Файлы теряются', text: 'Документы шлют в чат, где их больше никто никогда не найдёт.' },
        { title: 'Одни и те же вопросы', text: '«Какой статус?» — спрашивают пять раз в день, отвечаешь пять раз в день.' },
        { title: 'Языковой барьер', text: 'Команда пишет на трёх языках, половина контекста теряется.' },
      ],
    },
    solution: {
      title: 'Chatick решает это ИИ-диспетчером',
      subtitle: 'Каждое сообщение проходит через ИИ проекта, прежде чем дойти до команды.',
      items: [
        { title: 'Перевод на лету', text: 'Каждый пишет на своём языке. Каждый читает на своём.' },
        { title: 'Без повторных вопросов', text: 'Если ответ уже есть в переписке, задачах или файлах — ИИ ответит сам, не дёргая людей.' },
        { title: 'Статусы становятся задачами', text: '«Доделал страницу логина» обновляет задачу, а не флудит в чат.' },
        { title: 'Всё в одном месте', text: 'Задачи, файлы и доступы живут рядом с чатом — и управляются через чат.' },
      ],
    },
    how: {
      title: 'Как это работает',
      steps: [
        { title: 'Создайте проект', text: 'Проект — это группа. Пригласите команду — чат и пространство готовы.' },
        { title: 'Общайтесь как обычно', text: 'ИИ-диспетчер незаметно переводит, убирает дубли и маршрутизирует.' },
        { title: 'Спрашивайте у проекта, а не у людей', text: 'Статусы, файлы, решения — ИИ находит ответ быстрее, чем человек отвечает.' },
      ],
    },
    cta: {
      title: 'Сделайте проект единым источником правды',
      subtitle: 'Веб уже сегодня. Десктоп для Windows и macOS — следом.',
      button: 'Открыть Chatick',
    },
    footer: { rights: 'Все права защищены.' },
  },
  he: {
    meta: {
      title: 'Chatick — סביבת עבודה לפרויקט שבה הצ׳אט הוא הממשק',
      description:
        'מקור אמת אחד לצוות: צ׳אט פרויקט עם מנהל AI, משימות, קבצים והרשאות. די לאבד עבודה בוואטסאפ.',
    },
    nav: { start: 'להתחיל' },
    hero: {
      title1: 'הפרויקט שלכם.',
      titleAccent: ' צ׳אט אחד.',
      title2: ' אפס בלגן.',
      subtitle:
        'Chatick היא סביבת עבודה לפרויקט שבה הצ׳אט הוא הממשק, ומנהל AI שומר על הסדר: מתרגם, עונה על שאלות חוזרות והופך עדכוני סטטוס לעדכוני משימות.',
      cta: 'להתחיל',
      note: 'חינם בתקופת הבטא',
    },
    pain: {
      title: 'נשמע מוכר?',
      items: [
        { title: 'שני מקורות אמת', text: 'המשימות במערכת אחת, השיחות האמיתיות בוואטסאפ. שום דבר לא מסתנכרן.' },
        { title: 'קבצים נעלמים', text: 'מסמכים נשלחים לצ׳אט ואף אחד לא ימצא אותם שוב.' },
        { title: 'אותן שאלות שוב ושוב', text: '«מה הסטטוס?» — שואלים חמש פעמים ביום, עונים חמש פעמים ביום.' },
        { title: 'מחסום שפה', text: 'הצוות כותב בשלוש שפות וחצי מההקשר הולך לאיבוד.' },
      ],
    },
    solution: {
      title: 'Chatick פותר את זה עם מנהל AI',
      subtitle: 'כל הודעה עוברת דרך ה-AI של הפרויקט לפני שהיא מגיעה לצוות.',
      items: [
        { title: 'תרגום בזמן אמת', text: 'כל אחד כותב בשפה שלו. כל אחד קורא בשפה שלו.' },
        { title: 'בלי שאלות חוזרות', text: 'אם התשובה כבר קיימת בצ׳אט, במשימות או בקבצים — ה-AI עונה במקום להטריד אנשים.' },
        { title: 'סטטוסים הופכים למשימות', text: '«סיימתי את דף ההתחברות» מעדכן את המשימה במקום להציף את הצ׳אט.' },
        { title: 'הכול במקום אחד', text: 'משימות, קבצים והרשאות חיים ליד הצ׳אט — ומנוהלים דרך הצ׳אט.' },
      ],
    },
    how: {
      title: 'איך זה עובד',
      steps: [
        { title: 'צרו פרויקט', text: 'פרויקט הוא קבוצה. הזמינו את הצוות — הצ׳אט וסביבת העבודה מוכנים.' },
        { title: 'דברו כרגיל', text: 'מנהל ה-AI מתרגם, מסנן כפילויות ומנתב — בשקט.' },
        { title: 'שאלו את הפרויקט, לא אנשים', text: 'סטטוסים, קבצים, החלטות — ה-AI מוצא תשובה מהר יותר מבן אדם.' },
      ],
    },
    cta: {
      title: 'הפכו את הפרויקט למקור אמת אחד',
      subtitle: 'זמין בדפדפן היום. גרסת דסקטופ ל-Windows ו-macOS בקרוב.',
      button: 'לפתוח את Chatick',
    },
    footer: { rights: 'כל הזכויות שמורות.' },
  },
}
