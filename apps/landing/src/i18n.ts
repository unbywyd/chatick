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
  cta: { title: string; subtitle: string; button: string }
  footer: { rights: string; forAi: string }
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
    footer: { rights: 'All rights reserved.', forAi: 'For AI assistants' },
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
    footer: { rights: 'Все права защищены.', forAi: 'Для ИИ-ассистентов' },
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
    footer: { rights: 'כל הזכויות שמורות.', forAi: 'לעוזרי AI' },
  },
}
