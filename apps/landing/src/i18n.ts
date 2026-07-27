export const LOCALES = [
  { code: 'en', label: 'English', dir: 'ltr', path: '/' },
  { code: 'ru', label: 'Русский', dir: 'ltr', path: '/ru/' },
  { code: 'he', label: 'עברית', dir: 'rtl', path: '/he/' },
] as const

export type LocaleCode = (typeof LOCALES)[number]['code']

type Feature = { title: string; text: string }

type Dict = {
  meta: { title: string; description: string }
  nav: { start: string }
  hero: {
    title1: string
    titleAccent: string
    title2: string
    subtitle: string
    cta: string
    ctaSecondary: string
    note: string
  }
  pain: { title: string; items: Feature[] }
  solution: { title: string; subtitle: string; items: Feature[] }
  workspace: { title: string; subtitle: string; items: Feature[] }
  bridge: {
    tag: string
    title: string
    subtitle: string
    points: string[]
    security: string
  }
  ask: {
    tag: string
    title: string
    subtitle: string
    prompt: string
    copy: string
    copied: string
    hint: string
  }
  how: { title: string; steps: Feature[] }
  /** Доверие: безопасность, бэкапы, надёжность, бесплатность */
  trust: { title: string; subtitle: string; items: Feature[] }
  /** Кто это сделал */
  author: { tag: string; title: string; text: string; sites: string }
  /** Скачивание десктопных версий */
  download: {
    title: string
    subtitle: string
    windows: string
    mac: string
    linux: string
    soon: string
    web: string
    mobileSoon: string
  }
  /** Отзывы */
  reviews: {
    title: string
    subtitle: string
    empty: string
    leave: string
    name: string
    role: string
    email: string
    rating: string
    text: string
    send: string
    sent: string
    failed: string
    cancel: string
  }
  /** Контактная форма */
  contact: {
    title: string
    subtitle: string
    name: string
    email: string
    topic: string
    topics: { question: string; bug: string; feature: string; other: string }
    message: string
    send: string
    sent: string
    failed: string
    support: string
  }
  /** Сообщения кастомной валидации форм */
  formErrors: { required: string; email: string; short: string }
  cta: { title: string; subtitle: string; button: string }
  footer: {
    rights: string
    forAi: string
    terms: string
    privacy: string
    changelog: string
    github: string
    madeBy: string
  }
}

// Промпт, который пользователь копирует и вставляет в свой ИИ.
// Ссылка ведёт на машиночитаемую страницу /ai.txt — её читает сам ИИ.
const PROMPT = {
  en: 'Read https://chatick.com/ai.txt and tell me in plain words what Chatick is, whether it fits my team, and how to connect you to it.',
  ru: 'Прочитай https://chatick.com/ai.txt и расскажи простыми словами, что такое Chatick, подойдёт ли он моей команде и как подключить тебя к нему.',
  he: 'קרא את https://chatick.com/ai.txt וספר לי במילים פשוטות מה זה Chatick, האם זה מתאים לצוות שלי, ואיך לחבר אותך אליו.',
}

export const dict: Record<LocaleCode, Dict> = {
  en: {
    meta: {
      title: 'Chatick — the workspace your AI can actually run',
      description:
        'Team chat with an AI dispatcher, tasks, collaborative documents, files and access — in one place. Connect Claude Code and let it work in your project as you.',
    },
    nav: { start: 'Get started' },
    hero: {
      title1: 'Your project.',
      titleAccent: ' One chat.',
      title2: ' Zero chaos.',
      subtitle:
        'Chat, tasks, documents and files in one workspace — with an AI dispatcher that keeps order, and an open bridge so your own AI assistant can work here too.',
      cta: 'Get started',
      ctaSecondary: 'Ask your AI about us',
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
      title: 'An AI dispatcher sits in the middle',
      subtitle: 'Every message passes through the project AI before it reaches the team.',
      items: [
        { title: 'Live translation', text: 'Everyone writes in their language. Everyone reads in theirs.' },
        { title: 'No repeated questions', text: 'If the answer already exists in the chat, tasks or files — the AI answers instead of pinging people.' },
        { title: 'Statuses become tasks', text: '“Done with the login page” updates the task instead of flooding the chat.' },
        { title: 'Your own model', text: 'Bring your own key — Anthropic, OpenAI, Google, DeepSeek — or use ours. Costs are visible per project.' },
      ],
    },
    workspace: {
      title: 'A full workspace, not just a chat',
      subtitle: 'Everything a project needs, next to the conversation that drives it.',
      items: [
        { title: 'Tasks', text: 'Sprints, priorities, estimates, comments, drag & drop, Excel import/export — and live updates for everyone.' },
        { title: 'Documents', text: 'A rich editor with tables and images, real-time co-editing with cursors, version history and public share links.' },
        { title: 'Files', text: 'Attach from chat, tasks or clipboard. Images optimised automatically. Your own S3/R2 if you want no limits.' },
        { title: 'Access & secrets', text: 'Credentials encrypted at rest, revealed only on demand and always audited.' },
        { title: 'History & restore', text: 'Who did what, searchable and kept. Deleted by mistake? Restore it within a week.' },
        { title: 'Notifications', text: 'One bell across all projects, grouped and clickable. Email arrives once a day as a digest — never per event.' },
      ],
    },
    bridge: {
      tag: 'For developers',
      title: 'Plug your AI assistant straight into the project',
      subtitle:
        'Claude Code — or any assistant that can read docs and call HTTP — connects to Chatick and works inside your project: reads tasks, creates them, writes documents, uploads files.',
      points: [
        'One line to paste. Your assistant reads the guide and connects itself.',
        'You approve access in the browser — no token ever goes through your chat.',
        'It acts as you, within your permissions, and every action lands in the project history under your name.',
        'A connection is a tunnel: close it and the access is gone.',
      ],
      security: 'No permanent tokens. Nothing to leak.',
    },
    ask: {
      tag: 'The lazy way',
      title: 'Don’t feel like reading? Ask your AI.',
      subtitle:
        'Copy this and paste it into Claude, ChatGPT or whatever you use. It will read our page for machines and explain Chatick in your own terms.',
      prompt: PROMPT.en,
      copy: 'Copy prompt',
      copied: 'Copied — now paste it into your AI',
      hint: 'The link goes to a plain-text page written for AI, not for humans.',
    },
    how: {
      title: 'How it works',
      steps: [
        { title: 'Create a project', text: 'A project is a group. Invite your team — the chat and workspace are ready.' },
        { title: 'Talk as usual', text: 'The AI dispatcher quietly translates, deduplicates and turns talk into tasks.' },
        { title: 'Bring your own AI', text: 'Connect Claude Code and let it do the work directly in the project.' },
      ],
    },
    cta: {
      title: 'Make your project the single source of truth',
      subtitle: 'Web today. Desktop for Windows & macOS next.',
      button: 'Open Chatick',
    },
    trust: {
      title: 'Built to be trusted with your team’s work',
      subtitle: 'The unglamorous parts, done properly — losing someone’s work once is enough to lose them.',
      items: [
        { title: 'Free, and honestly so', text: 'No card, no trial countdown, no seats to count. Every project gets room for real work, and the limits are stated plainly instead of hidden in a plan comparison.' },
        { title: 'Backed up, not hoped for', text: 'The database is backed up on a schedule and the copies are encrypted. Deleted documents and notes stay recoverable for seven days — a mistaken click is not the end of the story.' },
        { title: 'Encrypted where it matters', text: 'Everything travels over HTTPS. Credentials kept in Resources are encrypted before they reach the database, and access inside a project is decided by roles.' },
        { title: 'Dangerous things ask twice', text: 'Deleting a project or a company wipes everything belonging to it, files included. So it lives in a clearly marked danger zone, needs confirmation, and emails every member afterwards.' },
        { title: 'Servers in the EU', text: 'Data sits on servers in Germany. Export it or delete it whenever you like — the privacy page names exactly who else processes it.' },
        { title: 'Nothing hidden in the log', text: 'Every release is written down before it ships; the build refuses to run otherwise. What changed is always readable on the changelog page.' },
      ],
    },
    author: {
      tag: 'Who built this',
      title: 'One developer who writes code all day, every day',
      text: 'Fifteen years of building software, and hands-on familiarity with just about every tool teams are asked to live in. Chatick is what was left after removing everything those tools add and nobody uses.',
      sites: 'More work:',
    },
    download: {
      title: 'Use it wherever you work',
      subtitle: 'The same workspace in the browser and on your desktop, with a tray panel that keeps the timer and your notifications one click away.',
      windows: 'Download for Windows',
      mac: 'Download for macOS',
      linux: 'Download for Linux',
      soon: 'Coming soon',
      web: 'Open in browser',
      mobileSoon: 'Mobile apps are on the roadmap.',
    },
    reviews: {
      title: 'What people say',
      subtitle: 'Reviews are read before they appear here.',
      empty: 'No reviews published yet. Yours could be the first.',
      leave: 'Leave a review',
      name: 'Your name',
      role: 'Role (optional)',
      email: 'Email',
      rating: 'Rating',
      text: 'Your review',
      send: 'Send review',
      sent: 'Thank you — your review will appear here once it has been read.',
      failed: 'Could not send. Please try again, or write to support@chatick.com.',
      cancel: 'Cancel',
    },
    contact: {
      title: 'Get in touch',
      subtitle: 'Questions, bugs, ideas — all of it reaches a person, not a queue.',
      name: 'Your name',
      email: 'Email',
      topic: 'Topic',
      topics: { question: 'Question', bug: 'Bug report', feature: 'Feature idea', other: 'Something else' },
      message: 'Message',
      send: 'Send message',
      sent: 'Sent — thank you. You will get an answer by email.',
      failed: 'Could not send. Please write to support@chatick.com instead.',
      support: 'Or email us directly:',
    },
    formErrors: {
      required: 'This field is required',
      email: 'Enter a valid email',
      short: 'At least {n} characters',
    },
    footer: {
      rights: 'All rights reserved.',
      forAi: 'For AI assistants',
      terms: 'Terms',
      privacy: 'Privacy',
      changelog: 'Changelog',
      github: 'Source on GitHub',
      madeBy: 'Built by',
    },
  },

  ru: {
    meta: {
      title: 'Chatick — рабочее пространство, в котором может работать ваш ИИ',
      description:
        'Чат команды с ИИ-диспетчером, задачи, совместные документы, файлы и доступы — в одном месте. Подключите Claude Code, и он будет работать в проекте от вашего имени.',
    },
    nav: { start: 'Начать' },
    hero: {
      title1: 'Ваш проект.',
      titleAccent: ' Один чат.',
      title2: ' Ноль хаоса.',
      subtitle:
        'Чат, задачи, документы и файлы в одном пространстве — с ИИ-диспетчером, который наводит порядок, и открытым мостом, чтобы здесь мог работать и ваш собственный ИИ-ассистент.',
      cta: 'Начать',
      ctaSecondary: 'Спросите свой ИИ о нас',
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
      title: 'В середине стоит ИИ-диспетчер',
      subtitle: 'Каждое сообщение проходит через ИИ проекта, прежде чем дойти до команды.',
      items: [
        { title: 'Перевод на лету', text: 'Каждый пишет на своём языке. Каждый читает на своём.' },
        { title: 'Без повторных вопросов', text: 'Если ответ уже есть в переписке, задачах или файлах — ИИ ответит сам, не дёргая людей.' },
        { title: 'Статусы становятся задачами', text: '«Доделал страницу логина» обновляет задачу, а не флудит в чат.' },
        { title: 'Своя модель', text: 'Подключите свой ключ — Anthropic, OpenAI, Google, DeepSeek — или используйте наш. Расходы видны по каждому проекту.' },
      ],
    },
    workspace: {
      title: 'Это рабочее пространство, а не просто чат',
      subtitle: 'Всё, что нужно проекту, рядом с разговором, который им движет.',
      items: [
        { title: 'Задачи', text: 'Спринты, приоритеты, оценки, комментарии, перетаскивание, импорт и экспорт в Excel — и живые обновления у всех сразу.' },
        { title: 'Документы', text: 'Богатый редактор с таблицами и картинками, совместное редактирование с курсорами, история версий и публичные ссылки.' },
        { title: 'Файлы', text: 'Прикрепляйте из чата, задач или буфера обмена. Картинки оптимизируются сами. Своё S3/R2 — если не нужны лимиты.' },
        { title: 'Доступы и секреты', text: 'Пароли шифруются, раскрываются только по запросу и всегда попадают в аудит.' },
        { title: 'История и восстановление', text: 'Кто что делал — с поиском и навсегда. Удалили по ошибке? Вернёте в течение недели.' },
        { title: 'Уведомления', text: 'Один колокольчик на все проекты, сгруппированный и кликабельный. Почта приходит раз в сутки сводкой, а не на каждый чих.' },
      ],
    },
    bridge: {
      tag: 'Для разработчиков',
      title: 'Подключите своего ИИ-ассистента прямо к проекту',
      subtitle:
        'Claude Code — или любой ассистент, умеющий читать документацию и делать HTTP-запросы — подключается к Chatick и работает внутри вашего проекта: читает задачи, создаёт их, пишет документы, загружает файлы.',
      points: [
        'Одна строка, которую нужно вставить. Ассистент сам прочитает инструкцию и подключится.',
        'Доступ вы подтверждаете в браузере — токен никогда не проходит через чат.',
        'Он действует от вашего имени, в границах ваших прав, и всё попадает в историю проекта под вашим именем.',
        'Подключение — это туннель: закрыли, и доступа больше нет.',
      ],
      security: 'Никаких постоянных токенов. Утекать нечему.',
    },
    ask: {
      tag: 'Ленивый способ',
      title: 'Читать лень? Спросите свой ИИ.',
      subtitle:
        'Скопируйте и вставьте в Claude, ChatGPT или что вы используете. Он прочитает нашу страницу для машин и объяснит, что такое Chatick, вашими словами.',
      prompt: PROMPT.ru,
      copy: 'Скопировать промпт',
      copied: 'Скопировано — вставьте в свой ИИ',
      hint: 'Ссылка ведёт на текстовую страницу, написанную для ИИ, а не для людей.',
    },
    how: {
      title: 'Как это работает',
      steps: [
        { title: 'Создайте проект', text: 'Проект — это группа. Пригласите команду, и чат с пространством готовы.' },
        { title: 'Общайтесь как обычно', text: 'ИИ-диспетчер незаметно переводит, убирает дубли и превращает разговор в задачи.' },
        { title: 'Подключите свой ИИ', text: 'Подключите Claude Code, и он будет делать работу прямо в проекте.' },
      ],
    },
    cta: {
      title: 'Сделайте проект единым источником правды',
      subtitle: 'Веб уже сегодня. Десктоп для Windows и macOS — следом.',
      button: 'Открыть Chatick',
    },
    trust: {
      title: 'Сделан так, чтобы ему можно было доверить работу',
      subtitle: 'Скучные вещи сделаны честно — потерять чужую работу достаточно один раз.',
      items: [
        { title: 'Бесплатно и честно', text: 'Без карты, без таймера пробного периода, без подсчёта мест. Каждому проекту — место под реальную работу, а лимиты названы прямо, а не спрятаны в сравнении тарифов.' },
        { title: 'Бэкапы, а не надежда', text: 'База копируется по расписанию, копии зашифрованы. Удалённые документы и заметки можно вернуть семь дней — случайный клик не конец истории.' },
        { title: 'Шифруется там, где важно', text: 'Всё идёт по HTTPS. Доступы, сложенные в «Ресурсы», шифруются до того, как попадут в базу, а доступ внутри проекта определяют роли.' },
        { title: 'Опасное переспрашивает', text: 'Удаление проекта или компании стирает всё их содержимое вместе с файлами — поэтому живёт в красной зоне, требует подтверждения и рассылает письма всем участникам.' },
        { title: 'Серверы в ЕС', text: 'Данные лежат в Германии. Их можно выгрузить или удалить в любой момент, а на странице приватности перечислено, кто ещё их обрабатывает.' },
        { title: 'Ничего не прячется', text: 'Каждая версия описана до выпуска — иначе сборка просто не пройдёт. Что изменилось, всегда видно в журнале версий.' },
      ],
    },
    author: {
      tag: 'Кто это сделал',
      title: 'Один разработчик, который пишет код целыми днями',
      text: 'Пятнадцать лет в разработке и рабочее знакомство почти со всеми программами, в которых заставляют жить команды. Chatick — это то, что осталось после удаления всего, чем никто не пользуется.',
      sites: 'Другие работы:',
    },
    download: {
      title: 'Работайте там, где удобно',
      subtitle: 'Одно и то же рабочее место в браузере и на компьютере, с панелью в трее: таймер и уведомления в одном клике.',
      windows: 'Скачать для Windows',
      mac: 'Скачать для macOS',
      linux: 'Скачать для Linux',
      soon: 'Скоро',
      web: 'Открыть в браузере',
      mobileSoon: 'Мобильные приложения — в планах.',
    },
    reviews: {
      title: 'Что говорят',
      subtitle: 'Отзывы читают перед публикацией.',
      empty: 'Отзывов пока нет. Ваш может стать первым.',
      leave: 'Оставить отзыв',
      name: 'Ваше имя',
      role: 'Должность (необязательно)',
      email: 'Почта',
      rating: 'Оценка',
      text: 'Отзыв',
      send: 'Отправить',
      sent: 'Спасибо — отзыв появится здесь после прочтения.',
      failed: 'Не отправилось. Попробуйте ещё раз или напишите на support@chatick.com.',
      cancel: 'Отмена',
    },
    contact: {
      title: 'Связаться',
      subtitle: 'Вопросы, баги, идеи — всё попадает к человеку, а не в очередь.',
      name: 'Ваше имя',
      email: 'Почта',
      topic: 'Тема',
      topics: { question: 'Вопрос', bug: 'Ошибка', feature: 'Идея', other: 'Другое' },
      message: 'Сообщение',
      send: 'Отправить',
      sent: 'Отправлено — спасибо. Ответ придёт на почту.',
      failed: 'Не отправилось. Напишите, пожалуйста, на support@chatick.com.',
      support: 'Или напишите напрямую:',
    },
    formErrors: {
      required: 'Обязательное поле',
      email: 'Введите корректную почту',
      short: 'Минимум {n} символов',
    },
    footer: {
      rights: 'Все права защищены.',
      forAi: 'Для ИИ-ассистентов',
      terms: 'Условия',
      privacy: 'Приватность',
      changelog: 'Журнал версий',
      github: 'Исходный код на GitHub',
      madeBy: 'Сделано',
    },
  },

  he: {
    meta: {
      title: 'Chatick — סביבת העבודה שה-AI שלכם באמת יכול להפעיל',
      description:
        'צ׳אט צוות עם מנהל AI, משימות, מסמכים משותפים, קבצים והרשאות — במקום אחד. חברו את Claude Code והוא יעבוד בפרויקט בשמכם.',
    },
    nav: { start: 'להתחיל' },
    hero: {
      title1: 'הפרויקט שלכם.',
      titleAccent: ' צ׳אט אחד.',
      title2: ' אפס בלגן.',
      subtitle:
        'צ׳אט, משימות, מסמכים וקבצים בסביבה אחת — עם מנהל AI ששומר על הסדר, וגשר פתוח כדי שגם עוזר ה-AI שלכם יוכל לעבוד כאן.',
      cta: 'להתחיל',
      ctaSecondary: 'שאלו את ה-AI שלכם עלינו',
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
      title: 'מנהל AI יושב באמצע',
      subtitle: 'כל הודעה עוברת דרך ה-AI של הפרויקט לפני שהיא מגיעה לצוות.',
      items: [
        { title: 'תרגום בזמן אמת', text: 'כל אחד כותב בשפה שלו. כל אחד קורא בשפה שלו.' },
        { title: 'בלי שאלות חוזרות', text: 'אם התשובה כבר קיימת בצ׳אט, במשימות או בקבצים — ה-AI עונה במקום להטריד אנשים.' },
        { title: 'סטטוסים הופכים למשימות', text: '«סיימתי את דף ההתחברות» מעדכן את המשימה במקום להציף את הצ׳אט.' },
        { title: 'המודל שלכם', text: 'חברו מפתח משלכם — Anthropic, OpenAI, Google, DeepSeek — או השתמשו בשלנו. העלויות גלויות לכל פרויקט.' },
      ],
    },
    workspace: {
      title: 'סביבת עבודה מלאה, לא רק צ׳אט',
      subtitle: 'כל מה שפרויקט צריך, ליד השיחה שמניעה אותו.',
      items: [
        { title: 'משימות', text: 'ספרינטים, עדיפויות, הערכות זמן, תגובות, גרירה, ייבוא וייצוא לאקסל — ועדכונים חיים לכולם.' },
        { title: 'מסמכים', text: 'עורך עשיר עם טבלאות ותמונות, עריכה משותפת עם סמנים, היסטוריית גרסאות וקישורים ציבוריים.' },
        { title: 'קבצים', text: 'צרפו מהצ׳אט, מהמשימות או מהלוח. תמונות עוברות אופטימיזציה אוטומטית. S3/R2 משלכם — ללא מגבלות.' },
        { title: 'הרשאות וסודות', text: 'סיסמאות מוצפנות, נחשפות רק לפי בקשה ותמיד נרשמות ביומן.' },
        { title: 'היסטוריה ושחזור', text: 'מי עשה מה — עם חיפוש ולתמיד. מחקתם בטעות? אפשר לשחזר תוך שבוע.' },
        { title: 'התראות', text: 'פעמון אחד לכל הפרויקטים, מקובץ וניתן ללחיצה. מייל מגיע פעם ביום כסיכום, לא על כל אירוע.' },
      ],
    },
    bridge: {
      tag: 'למפתחים',
      title: 'חברו את עוזר ה-AI שלכם ישירות לפרויקט',
      subtitle:
        'Claude Code — או כל עוזר שיודע לקרוא תיעוד ולבצע בקשות HTTP — מתחבר ל-Chatick ועובד בתוך הפרויקט שלכם: קורא משימות, יוצר אותן, כותב מסמכים, מעלה קבצים.',
      points: [
        'שורה אחת להדביק. העוזר יקרא את ההוראות ויתחבר בעצמו.',
        'אתם מאשרים את הגישה בדפדפן — הטוקן לעולם לא עובר בצ׳אט.',
        'הוא פועל בשמכם, בגבולות ההרשאות שלכם, והכול נרשם בהיסטוריית הפרויקט תחת שמכם.',
        'חיבור הוא מנהרה: סוגרים אותה — והגישה נעלמת.',
      ],
      security: 'בלי טוקנים קבועים. אין מה לדלוף.',
    },
    ask: {
      tag: 'הדרך העצלה',
      title: 'אין כוח לקרוא? שאלו את ה-AI שלכם.',
      subtitle:
        'העתיקו והדביקו ב-Claude, ב-ChatGPT או במה שאתם משתמשים. הוא יקרא את הדף שלנו למכונות ויסביר מה זה Chatick במילים שלכם.',
      prompt: PROMPT.he,
      copy: 'העתקת הפרומפט',
      copied: 'הועתק — הדביקו ב-AI שלכם',
      hint: 'הקישור מוביל לדף טקסט שנכתב עבור AI, לא עבור בני אדם.',
    },
    how: {
      title: 'איך זה עובד',
      steps: [
        { title: 'צרו פרויקט', text: 'פרויקט הוא קבוצה. הזמינו את הצוות — הצ׳אט וסביבת העבודה מוכנים.' },
        { title: 'דברו כרגיל', text: 'מנהל ה-AI מתרגם, מסנן כפילויות והופך שיחה למשימות — בשקט.' },
        { title: 'חברו AI משלכם', text: 'חברו את Claude Code והוא יבצע את העבודה ישירות בפרויקט.' },
      ],
    },
    cta: {
      title: 'הפכו את הפרויקט למקור אמת אחד',
      subtitle: 'זמין בדפדפן היום. גרסת דסקטופ ל-Windows ו-macOS בקרוב.',
      button: 'לפתוח את Chatick',
    },
    trust: {
      title: 'נבנה כדי שאפשר יהיה להפקיד בו את העבודה',
      subtitle: 'החלקים המשעממים נעשו כמו שצריך — לאבד עבודה פעם אחת זה מספיק.',
      items: [
        { title: 'חינם, באמת', text: 'בלי כרטיס אשראי, בלי שעון ניסיון ובלי לספור משתמשים. לכל פרויקט יש מקום לעבודה אמיתית, והמגבלות נאמרות בפירוש.' },
        { title: 'גיבוי, לא תקווה', text: 'מסד הנתונים מגובה באופן קבוע והעותקים מוצפנים. מסמכים ופתקים שנמחקו ניתנים לשחזור שבעה ימים.' },
        { title: 'הצפנה במקום שחשוב', text: 'הכל עובר ב-HTTPS. אישורי גישה מוצפנים לפני שהם מגיעים למסד הנתונים, והגישה בפרויקט נקבעת לפי תפקידים.' },
        { title: 'פעולות מסוכנות שואלות פעמיים', text: 'מחיקת פרויקט או חברה מוחקת גם את הקבצים — לכן זה דורש אישור ושולח הודעה לכל החברים.' },
        { title: 'שרתים באיחוד האירופי', text: 'הנתונים שמורים בגרמניה. אפשר לייצא או למחוק אותם בכל רגע.' },
        { title: 'שום דבר לא מוסתר', text: 'כל גרסה מתועדת לפני שהיא יוצאת — אחרת הבנייה פשוט נכשלת.' },
      ],
    },
    author: {
      tag: 'מי בנה את זה',
      title: 'מפתח אחד שכותב קוד כל היום',
      text: 'חמש עשרה שנות פיתוח והיכרות מעשית עם כמעט כל כלי שצוותים נדרשים לחיות בו. Chatick הוא מה שנשאר אחרי שמסירים את כל מה שאיש לא משתמש בו.',
      sites: 'עבודות נוספות:',
    },
    download: {
      title: 'עבדו איפה שנוח לכם',
      subtitle: 'אותו מרחב עבודה בדפדפן ובמחשב, עם לוח במגש המערכת.',
      windows: 'הורדה ל-Windows',
      mac: 'הורדה ל-macOS',
      linux: 'הורדה ל-Linux',
      soon: 'בקרוב',
      web: 'פתחו בדפדפן',
      mobileSoon: 'אפליקציות לנייד בתוכניות.',
    },
    reviews: {
      title: 'מה אומרים',
      subtitle: 'חוות הדעת נקראות לפני פרסום.',
      empty: 'עדיין אין חוות דעת. שלכם יכולה להיות הראשונה.',
      leave: 'כתיבת חוות דעת',
      name: 'השם שלכם',
      role: 'תפקיד (רשות)',
      email: 'אימייל',
      rating: 'דירוג',
      text: 'חוות הדעת',
      send: 'שליחה',
      sent: 'תודה — חוות הדעת תופיע כאן לאחר קריאה.',
      failed: 'השליחה נכשלה. נסו שוב או כתבו ל-support@chatick.com.',
      cancel: 'ביטול',
    },
    contact: {
      title: 'צרו קשר',
      subtitle: 'שאלות, תקלות ורעיונות — הכל מגיע לאדם.',
      name: 'השם שלכם',
      email: 'אימייל',
      topic: 'נושא',
      topics: { question: 'שאלה', bug: 'תקלה', feature: 'רעיון', other: 'אחר' },
      message: 'הודעה',
      send: 'שליחה',
      sent: 'נשלח — תודה. תשובה תגיע באימייל.',
      failed: 'השליחה נכשלה. כתבו ל-support@chatick.com.',
      support: 'או כתבו ישירות:',
    },
    formErrors: {
      required: 'שדה חובה',
      email: 'הזינו אימייל תקין',
      short: 'לפחות {n} תווים',
    },
    footer: {
      rights: 'כל הזכויות שמורות.',
      forAi: 'לעוזרי AI',
      terms: 'תנאי שימוש',
      privacy: 'פרטיות',
      changelog: 'יומן גרסאות',
      github: 'קוד ב-GitHub',
      madeBy: 'נבנה על ידי',
    },
  },
}
