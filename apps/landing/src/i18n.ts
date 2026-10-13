export const LOCALES = [
  { code: 'en', label: 'English', dir: 'ltr', path: '/' },
  { code: 'ru', label: 'Русский', dir: 'ltr', path: '/ru/' },
  { code: 'he', label: 'עברית', dir: 'rtl', path: '/he/' },
] as const

export type LocaleCode = (typeof LOCALES)[number]['code']

/**
 * Общие строки сайта: заголовки страниц и страница /integration.
 * Тексты самого лендинга — в copy.ts.
 */
type Dict = {
  meta: { title: string; description: string }
  integrate: {
    tag: string
    title: string
    subtitle: string
    points: string[]
    cta: string
    ctaAi: string
    ctaAiNote: string
    /** Тексты самой страницы /integration */
    page: {
      lead: string
      whoTitle: string
      whoTheirs: string
      whoOurs: string
      keysTitle: string
      keysBody: string
      keysScopes: string
      stepsTitle: string
      steps: string[]
      linksTitle: string
      linksBody: string
      hooksTitle: string
      hooksBody: string
      signinTitle: string
      signinBody: string
      askAi: string
      askAiHint: string
    }
  }
}

export const dict: Record<LocaleCode, Dict> = {
  en: {
    meta: {
      title: 'Chatick — every task is a ball. Know who’s holding it.',
      description: 'Task tracking where every task sits with one person and one move — do, review or answer. Pass it on with a note; heat shows what’s stuck. Your AI assistant works in it through MCP.',
    },
    integrate: {
      tag: 'For companies with their own system',
      title: 'Keep your system. Move the work here.',
      subtitle:
        'You already have projects, clients, deadlines and reporting. Chatick takes tasks, time, chat and documents — your system stays the source of truth, and the two talk over an API.',
      points: [
        'Projects and people come from your system. We never invent them.',
        'Your reporting keeps working: tasks and hours are readable back at any moment.',
        'One click moves a person from your system straight into a project — no second sign-in.',
        'Events reach you the moment they happen, so your dashboards do not poll us.',
      ],
      cta: 'How the integration works',
      ctaAi: 'Give this to your AI',
      ctaAiNote: 'Copies the machine-readable guide. If the clipboard fails, it lives at ',
      page: {
        lead: 'This page is for a company that already has its own system and does not want to give it up. Below: what lives where, how master keys work, and how to connect the two.',
        whoTitle: 'Who owns what',
        whoTheirs: 'Projects, clients, deadlines, budgets, reporting — your system. Chatick does not touch them.',
        whoOurs: 'Tasks and checklists, time tracking, chat, files, documents, notes — Chatick.',
        keysTitle: 'Master keys',
        keysBody:
          'A company admin creates a key in company settings. It is shown once: only its fingerprint is stored, and nobody can recover it later. Revoking is immediate — the check runs on every request, not on expiry. Every call is logged.',
        keysScopes:
          'A key carries scopes: users:write, projects:write, read:all. A read-only key cannot create anything — that is the point.',
        stepsTitle: 'How to connect',
        steps: [
          'The admin issues a key in company settings and hands it to your developer.',
          'Your system pushes projects. Sending the same one twice updates it instead of duplicating.',
          'Your system pushes people. Up to 500 per call; one bad record does not sink the rest.',
          'Your reporting reads tasks, hours and summaries back whenever it needs them.',
        ],
        linksTitle: 'Moving between the systems',
        linksBody:
          'Ask our API for a link and a person lands straight in the project — they already signed in on your side. The link lives five minutes and works once. In the other direction, set your project URL template once and a button appears in the project header.',
        hooksTitle: 'Webhooks',
        hooksBody:
          'Instead of polling us, receive an event when a task is created, reassigned or changes status. Every request is signed; verify the signature so nobody else can send you invented events.',
        signinTitle: 'How people sign in',
        signinBody:
          'You never manage their passwords — Chatick has none. Google, a code by email, or the one-time link. All three lead to the same account. We never call your system to authenticate: if it goes down, people already working keep working.',
        askAi: 'Ask your AI instead of reading',
        askAiHint:
          'The link below is written for machines. Give it to Claude, ChatGPT or whatever your team uses — it will explain the integration in your own terms and write the requests for you.',
      },
    },
  },
  ru: {
    meta: {
      title: 'Chatick — каждая задача как мяч. Видно, у кого он.',
      description: 'Трекер задач, где каждая задача у одного человека с одним ходом: сделать, проверить или ответить. Передача — с запиской, жар показывает, что застряло. Ваш ИИ-ассистент работает в нём через MCP.',
    },
    integrate: {
      tag: 'Для компаний со своей системой',
      // «Оставьте свою систему» читалось наоборот — как «покиньте её».
      // Здесь смысл обратный: система остаётся у вас, переезжает только работа.
      title: 'Ваша система остаётся. Работа переезжает.',
      subtitle:
        'У вас уже есть проекты, клиенты, сроки и отчётность. Chatick берёт задачи, время, чат и документы — источником правды остаётся ваша система, а связываются они по API.',
      points: [
        'Проекты и люди приходят из вашей системы. Мы их не выдумываем.',
        'Ваша отчётность продолжает работать: задачи и часы можно прочитать обратно в любой момент.',
        'Переход из вашей системы в проект — одним нажатием, без второго входа.',
        'События приходят к вам сразу, и вашим дашбордам не нужно опрашивать нас.',
      ],
      cta: 'Как устроена интеграция',
      ctaAi: 'Отдайте это своему ИИ',
      ctaAiNote: 'Скопирует машинную инструкцию. Если буфер не сработал — она лежит по адресу ',
      page: {
        lead: 'Эта страница — для компании, у которой уже есть своя система и которая не хочет от неё отказываться. Ниже: что где живёт, как работают мастер-ключи и как связать одно с другим.',
        whoTitle: 'Что где живёт',
        whoTheirs: 'Проекты, клиенты, сроки, бюджеты, отчётность — ваша система. Chatick их не трогает.',
        whoOurs: 'Задачи и чек-листы, учёт времени, чат, файлы, документы, заметки — Chatick.',
        keysTitle: 'Мастер-ключи',
        keysBody:
          'Ключ создаёт админ компании в её настройках. Показывается он один раз: в базе остаётся только отпечаток, восстановить ключ потом невозможно. Отзыв мгновенный — проверка идёт на каждом запросе, а не по истечении срока. Каждый вызов попадает в журнал.',
        keysScopes:
          'У ключа есть права: users:write, projects:write, read:all. Ключ «только чтение» ничего создать не сможет — ради этого разделение и сделано.',
        stepsTitle: 'Как подключиться',
        steps: [
          'Админ выпускает ключ в настройках компании и передаёт вашему разработчику.',
          'Ваша система отправляет проекты. Повторная отправка того же проекта обновляет его, а не плодит копии.',
          'Ваша система отправляет людей. До 500 за раз; одна плохая запись не уносит остальные.',
          'Ваша отчётность читает обратно задачи, часы и сводки, когда ей нужно.',
        ],
        linksTitle: 'Переходы между системами',
        linksBody:
          'Попросите у нашего API ссылку — и человек окажется прямо в проекте: у вас он уже вошёл, спрашивать второй раз незачем. Ссылка живёт пять минут и срабатывает один раз. В обратную сторону: один раз задайте шаблон адреса проекта, и в шапке появится кнопка.',
        hooksTitle: 'Вебхуки',
        hooksBody:
          'Вместо того чтобы опрашивать нас, получайте событие в момент, когда задачу создали, переназначили или закрыли. Каждый запрос подписан — проверяйте подпись, чтобы никто посторонний не слал вам выдуманные события.',
        signinTitle: 'Как входят люди',
        signinBody:
          'Их паролями вы не управляете — у Chatick паролей нет. Google, код на почту или одноразовая ссылка. Все три пути ведут в один аккаунт. Мы никогда не обращаемся к вашей системе при входе: если она недоступна, уже работающие люди продолжают работать.',
        askAi: 'Спросите свой ИИ вместо чтения',
        askAiHint:
          'Ссылка ниже написана для машин. Отдайте её Claude, ChatGPT или тому, чем пользуется ваша команда — он объяснит интеграцию вашими словами и напишет запросы за вас.',
      },
    },
  },
  he: {
    meta: {
      title: 'Chatick — כל משימה היא כדור. רואים אצל מי הוא.',
      description: 'ניהול משימות שבו כל משימה אצל אדם אחד עם מהלך אחד: לבצע, לבדוק או לענות. מעבירים עם פתק, והחום מראה מה נתקע. עוזר ה־AI שלכם עובד בו דרך MCP.',
    },
    integrate: {
      tag: 'לחברות עם מערכת משלהן',
      // Как и в русском: «השאירו» звучало как «бросьте её». Переформулировано
      // утверждением — система остаётся, переезжает работа.
      title: 'המערכת שלכם נשארת. העבודה עוברת לכאן.',
      subtitle:
        'כבר יש לכם פרויקטים, לקוחות, לוחות זמנים ודוחות. Chatick לוקח משימות, זמן, צ׳אט ומסמכים — מקור האמת נשאר אצלכם, והשתיים מדברות דרך API.',
      points: [
        'פרויקטים ואנשים מגיעים מהמערכת שלכם. אנחנו לא ממציאים אותם.',
        'הדוחות שלכם ממשיכים לעבוד: אפשר לקרוא בחזרה משימות ושעות בכל רגע.',
        'מעבר מהמערכת שלכם ישר לפרויקט — בלחיצה אחת, בלי כניסה שנייה.',
        'אירועים מגיעים אליכם מיד, והדשבורדים שלכם לא צריכים לתשאל אותנו.',
      ],
      cta: 'איך האינטגרציה עובדת',
      ctaAi: 'תנו את זה ל-AI שלכם',
      ctaAiNote: 'מעתיק את המדריך המכונה. אם ההעתקה לא עבדה — הוא נמצא בכתובת ',
      page: {
        lead: 'העמוד הזה מיועד לחברה שכבר יש לה מערכת משלה ולא רוצה לוותר עליה. כאן: מה חי איפה, איך עובדים מפתחות ראשיים, ואיך מחברים בין השתיים.',
        whoTitle: 'מה חי איפה',
        whoTheirs: 'פרויקטים, לקוחות, לוחות זמנים, תקציבים ודוחות — המערכת שלכם. Chatick לא נוגע בהם.',
        whoOurs: 'משימות ורשימות בדיקה, מעקב זמן, צ׳אט, קבצים, מסמכים והערות — Chatick.',
        keysTitle: 'מפתחות ראשיים',
        keysBody:
          'את המפתח יוצר מנהל החברה בהגדרות. הוא מוצג פעם אחת: בבסיס הנתונים נשמרת רק טביעת האצבע, ואי אפשר לשחזר אותו. הביטול מיידי — הבדיקה רצה בכל בקשה, לא לפי תוקף. כל קריאה נרשמת ביומן.',
        keysScopes:
          'למפתח יש הרשאות: users:write, projects:write, read:all. מפתח לקריאה בלבד לא יוכל ליצור דבר — בשביל זה ההפרדה.',
        stepsTitle: 'איך מתחברים',
        steps: [
          'המנהל מנפיק מפתח בהגדרות החברה ומעביר למפתח שלכם.',
          'המערכת שלכם שולחת פרויקטים. שליחה חוזרת של אותו פרויקט מעדכנת אותו ולא יוצרת כפילות.',
          'המערכת שלכם שולחת אנשים. עד 500 בבקשה; רשומה שגויה אחת לא מפילה את השאר.',
          'הדוחות שלכם קוראים בחזרה משימות, שעות וסיכומים מתי שצריך.',
        ],
        linksTitle: 'מעבר בין המערכות',
        linksBody:
          'בקשו מה-API שלנו קישור — והאדם יגיע ישר לפרויקט: אצלכם הוא כבר מחובר, אין טעם לשאול פעמיים. הקישור תקף חמש דקות ופועל פעם אחת. בכיוון ההפוך: הגדירו פעם אחת את תבנית הכתובת, ובכותרת הפרויקט יופיע כפתור.',
        hooksTitle: 'Webhooks',
        hooksBody:
          'במקום לתשאל אותנו, קבלו אירוע ברגע שמשימה נוצרה, הוקצתה מחדש או שינתה סטטוס. כל בקשה חתומה — אמתו את החתימה כדי שאף אחד לא ישלח לכם אירועים מומצאים.',
        signinTitle: 'איך אנשים נכנסים',
        signinBody:
          'אתם לא מנהלים את הסיסמאות שלהם — ל-Chatick אין סיסמאות. Google, קוד למייל או הקישור החד-פעמי. שלושת המסלולים מובילים לאותו חשבון. אנחנו אף פעם לא פונים למערכת שלכם בכניסה: אם היא לא זמינה, מי שכבר עובד ממשיך לעבוד.',
        askAi: 'שאלו את ה-AI שלכם במקום לקרוא',
        askAiHint:
          'הקישור למטה נכתב למכונות. תנו אותו ל-Claude, ל-ChatGPT או למה שהצוות שלכם משתמש בו — הוא יסביר את האינטגרציה במילים שלכם ויכתוב את הבקשות עבורכם.',
      },
    },
  },
}
