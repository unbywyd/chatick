import type { LocaleCode } from './i18n'

/**
 * Тексты лендинга. Пишем то, что работает сегодня, и ровно так, как работает:
 * бэкап — раз в сутки в ваше хранилище, а не «каждую секунду»; лицензия —
 * BSL, поэтому «код на GitHub», а не «open source»; бесплатно — на время беты.
 * Сроки жара — те же, что в приложении (util.ts, HEAT): делать 3/5 дней,
 * проверить или ответить — 1/2 дня.
 */
export type HeatKey = 'warm' | 'hot' | 'burn' | 'client'

export type LandCopy = {
  nav: { how: string; heat: string; dev: string; own: string; download: string; signin: string; lang: string }
  hero: {
    eyebrow: string
    h1a: string
    h1b: string
    lead: string
    start: string
    askAi: string
    note: string
    /** Люди за столом в шапке, по местам; последний — «вы» */
    people: string[]
    heat: Record<'warm' | 'hot' | 'burn', string>
    held: string
    moves: { do: string; review: string; answer: string }
    passTo: string
    scene: string
  }
  ask: { kick: string; title: string; steps: string[]; prompt: string; copy: string; copied: string; gpt: string; claude: string }
  rules: { title: string; text: string }[]
  heat: { title: string; sub: string; items: { key: HeatKey; title: string; text: string; clock: string }[] }
  ways: {
    title: string
    ui: { k: string; title: string; text: string; task: string; person: string; project: string }
    dev: { k: string; title: string; text: string; comment: string; note: string }
  }
  own: {
    kick: string
    title: string
    code: { title: string; text: string; link: string }
    backup: { title: string; text: string; badge: string }
    self: { title: string; text: string; link: string }
  }
  download: {
    title: string
    sub: string
    winStore: string
    mac: string
    macArm: string
    macIntel: string
    web: string
    webSub: string
    macNote: string
    winDirect: string
  }
  products: { title: string; sub: string; ungic: string; vexel: string; skey: string }
  final: { title: string; start: string }
  foot: { backed: string; built: string; changelog: string; forAi: string; integration: string; privacy: string; terms: string; contact: string }
}

const en: LandCopy = {
  nav: { how: 'How it works', heat: 'Heat', dev: 'For developers', own: 'Your data', download: 'Download', signin: 'Sign in', lang: 'Language' },
  hero: {
    eyebrow: 'Task tracking, without the limbo',
    h1a: 'Every task is a ball.',
    h1b: 'Know who’s holding it.',
    lead: 'Every task in Chatick sits with one person and one move — do, review or answer. Pass it on with a note. Nothing waits in between.',
    start: 'Start free',
    askAi: 'Ask your AI what this is',
    note: 'Free during the beta · Code on GitHub · Runs on your own server too',
    people: ['Ori', 'Itai', 'Maya', 'Ron', 'You'],
    heat: { warm: 'Warm', hot: 'Hot', burn: 'Burning' },
    held: 'held',
    moves: { do: 'doing', review: 'review', answer: 'question' },
    passTo: 'Pass the ball to {name}',
    scene: 'A round table seen from above. Five people sit around it, and the ball lies in front of whoever’s move it is.',
  },
  ask: {
    kick: 'Hand this to your assistant',
    title: 'Don’t read about it. Ask your AI.',
    steps: ['Copy the line', 'Paste it to your assistant', 'It explains Chatick — and connects itself if you ask'],
    prompt: 'Read https://chatick.com/ai.txt and explain in plain words what Chatick is, whether it fits my team, and how to connect yourself to it.',
    copy: 'Copy prompt',
    copied: 'Copied — now paste it',
    gpt: 'Open in ChatGPT',
    claude: 'Open in Claude',
  },
  rules: [
    { title: 'One holder.', text: 'A task is always in someone’s hands. Never “in progress” with nobody on it.' },
    { title: 'One move.', text: 'Do it, review it, or answer a question. The status follows the move.' },
    { title: 'A note with every pass.', text: 'What’s done, what’s next. The next person starts from your note, not from scratch.' },
  ],
  heat: {
    title: 'The longer it sits, the hotter it gets.',
    sub: 'Heat is time in one person’s hands. You feel your own ball. Everyone sees what’s stuck.',
    items: [
      { key: 'warm', title: 'Warm', text: 'Just landed. Doing it — under 3 days; a review or a question — under a day.', clock: '00:42:10' },
      { key: 'hot', title: 'Hot', text: 'Someone is waiting on you: 3 days of doing, or a day on a review or a question.', clock: '1d 03:20' },
      { key: 'burn', title: 'Burning', text: 'Pass it, or say why not: 5 days of doing, or 2 on a review or a question.', clock: '5d 04:12' },
      { key: 'client', title: 'Waiting on the client', text: 'The ball is outside the team. A pause, not a fire — the clock counts the wait.', clock: '2d 06:00' },
    ],
  },
  ways: {
    title: 'Two ways in. Both take seconds.',
    ui: {
      k: 'PMs & QA',
      title: 'One screen. Throw, catch, react.',
      text: 'Type the task, tag who and where, hit Enter — it lands in their hands. Your three most urgent sit on the table, with everyone involved around it.',
      task: 'Fix review cards on mobile',
      person: '@ori',
      project: '#vpure',
    },
    dev: {
      k: 'Developers',
      title: 'Never open it. Your AI passes for you.',
      text: 'Chatick speaks MCP — add it by address in Claude, Claude Code or Cursor. Your AI picks up, passes and answers from where you already work: as you, within your rights.',
      comment: '# done — hand it to QA',
      note: 'Zones live. Check on mobile.',
    },
  },
  own: {
    kick: 'Yours to keep',
    title: 'Your data stays yours. Even if we disappear.',
    code: {
      title: 'Code on GitHub.',
      text: 'Every line is public. Read it, audit it, run it for your team — the licence lets any organisation use it internally.',
      link: 'View on GitHub →',
    },
    backup: {
      title: 'A backup every day.',
      text: 'Connect your own S3 or R2 bucket and Chatick puts a full archive of the company there daily, keeping a week of copies. Export everything in one file anytime.',
      badge: 'Daily · 7 copies',
    },
    self: {
      title: 'Run it yourself.',
      text: 'Install Chatick on your own server and stop depending on us. Same app, your machine, no limit on people.',
      link: 'Self-hosting →',
    },
  },
  download: {
    title: 'Get the app.',
    sub: 'The same workspace in the browser and on your desktop — the tray keeps the timer and notifications one click away.',
    winStore: 'Get it from Microsoft Store',
    mac: 'Download for macOS',
    macArm: 'Apple Silicon',
    macIntel: 'Intel',
    web: 'Open in the browser',
    webSub: 'app.chatick.com — nothing to install',
    macNote: 'The Mac build isn’t signed by Apple yet: a certificate costs money, and Chatick has no sponsors. First launch: right-click the app → Open → Open.',
    winDirect: 'Store blocked on your machine? Direct download (.exe)',
  },
  products: {
    title: 'Our products',
    sub: 'From the same team.',
    ungic: 'A wild machine built to replace Figma for developers: your AI designs and prototypes the app.',
    vexel: 'Any illustrations, generated in sets — every picture in one style.',
    skey: 'API keys and passwords for your AI: it uses them, but never sees them.',
  },
  final: { title: 'Pick up the ball.', start: 'Start free' },
  foot: {
    backed: 'Backed by',
    built: 'Built by',
    changelog: 'Changelog',
    forAi: 'For AI assistants',
    integration: 'Integration',
    privacy: 'Privacy',
    terms: 'Terms',
    contact: 'Contact',
  },
}

const ru: LandCopy = {
  nav: { how: 'Как устроено', heat: 'Жар', dev: 'Разработчикам', own: 'Ваши данные', download: 'Скачать', signin: 'Войти', lang: 'Язык' },
  hero: {
    eyebrow: 'Задачи без подвешенного состояния',
    h1a: 'Каждая задача — мяч.',
    h1b: 'Видно, у кого он.',
    lead: 'Каждая задача в Chatick лежит у одного человека с одним ходом: сделать, проверить или ответить. Передайте её дальше с запиской — между руками ничего не зависает.',
    start: 'Начать бесплатно',
    askAi: 'Спросить свой ИИ, что это',
    note: 'Бесплатно на время беты · Код на GitHub · Можно поставить на свой сервер',
    people: ['Ори', 'Итай', 'Майя', 'Рон', 'Вы'],
    heat: { warm: 'Тепло', hot: 'Жарко', burn: 'Горит' },
    held: 'лежит',
    moves: { do: 'делает', review: 'проверка', answer: 'вопрос' },
    passTo: 'Передать мяч: {name}',
    scene: 'Круглый стол сверху. Вокруг пять человек, мяч лежит перед тем, чей сейчас ход.',
  },
  ask: {
    kick: 'Отдайте это ассистенту',
    title: 'Не читайте. Спросите свой ИИ.',
    steps: ['Скопируйте строку', 'Вставьте её ассистенту', 'Он объяснит, что это, — и подключится сам, если попросите'],
    prompt: 'Прочитай https://chatick.com/ai.txt и объясни простыми словами, что такое Chatick, подходит ли он моей команде и как тебе к нему подключиться.',
    copy: 'Скопировать',
    copied: 'Скопировано — вставьте ассистенту',
    gpt: 'Открыть в ChatGPT',
    claude: 'Открыть в Claude',
  },
  rules: [
    { title: 'Один держатель.', text: 'Задача всегда у кого-то в руках. Никаких «в работе», где никто не работает.' },
    { title: 'Один ход.', text: 'Сделать, проверить или ответить на вопрос. Статус следует за ходом.' },
    { title: 'Записка к каждой передаче.', text: 'Что сделано и что дальше. Следующий начинает с вашей записки, а не с нуля.' },
  ],
  heat: {
    title: 'Чем дольше лежит, тем горячее.',
    sub: 'Жар — это время в одних руках. Свой мяч вы чувствуете сами, а что застряло — видят все.',
    items: [
      { key: 'warm', title: 'Тепло', text: 'Только что пришла. Делать — меньше 3 дней, проверить или ответить — меньше дня.', clock: '00:42:10' },
      { key: 'hot', title: 'Жарко', text: 'Вас уже ждут: 3 дня работы или день на проверке и вопросе.', clock: '1д 03:20' },
      { key: 'burn', title: 'Горит', text: 'Передайте или скажите, почему нет: 5 дней работы или 2 дня на проверке и вопросе.', clock: '5д 04:12' },
      { key: 'client', title: 'Ждём клиента', text: 'Мяч вне команды. Это пауза, а не пожар — часы считают ожидание.', clock: '2д 06:00' },
    ],
  },
  ways: {
    title: 'Два входа. Оба — за секунды.',
    ui: {
      k: 'Менеджеры и QA',
      title: 'Один экран. Бросить, поймать, ответить.',
      text: 'Напишите задачу, отметьте кому и куда, Enter — она уже у человека. Три самые срочные лежат на столе, а вокруг — все, кто в них участвует.',
      task: 'Поправить карточки ревью на мобиле',
      person: '@ори',
      project: '#vpure',
    },
    dev: {
      k: 'Разработчики',
      title: 'Можно не открывать. ИИ передаст за вас.',
      text: 'Chatick говорит на MCP — добавьте его по адресу в Claude, Claude Code или Cursor. ИИ берёт задачу, передаёт и отвечает прямо оттуда, где вы работаете: от вашего имени и в ваших правах.',
      comment: '# готово — отдаю в QA',
      note: 'Зоны на проде. Проверь на мобиле.',
    },
  },
  own: {
    kick: 'Ваше и останется вашим',
    title: 'Данные остаются у вас. Даже если нас не станет.',
    code: {
      title: 'Код на GitHub.',
      text: 'Каждая строка открыта: читайте, проверяйте, разворачивайте для своей команды — лицензия разрешает любой организации пользоваться им у себя.',
      link: 'Открыть GitHub →',
    },
    backup: {
      title: 'Бэкап каждый день.',
      text: 'Подключите своё хранилище S3 или R2 — раз в сутки Chatick кладёт туда полный архив компании и держит копии за неделю. Выгрузить всё одним файлом можно в любой момент.',
      badge: 'Раз в сутки · 7 копий',
    },
    self: {
      title: 'Поставьте у себя.',
      text: 'Установите Chatick на свой сервер и не зависьте от нас. То же приложение, ваша машина, без ограничения на число людей.',
      link: 'Как поставить →',
    },
  },
  download: {
    title: 'Скачайте приложение.',
    sub: 'То же рабочее место в браузере и на компьютере — в трее таймер и уведомления в одном клике.',
    winStore: 'Скачать из Microsoft Store',
    mac: 'Скачать для macOS',
    macArm: 'Apple Silicon',
    macIntel: 'Intel',
    web: 'Открыть в браузере',
    webSub: 'app.chatick.com — ставить ничего не нужно',
    macNote: 'Сборка для Mac пока не подписана Apple: сертификат стоит денег, а у Chatick нет спонсоров. Первый запуск: правый клик по приложению → Открыть → Открыть.',
    winDirect: 'Магазин закрыт на вашей машине? Прямая загрузка (.exe)',
  },
  products: {
    title: 'Наши продукты',
    sub: 'От той же команды.',
    ungic: 'Безумная машина, которая заменит программистам Figma: ваш ИИ рисует и собирает прототип приложения.',
    vexel: 'Любые иллюстрации пакетами — все картинки в одном стиле.',
    skey: 'API-ключи и пароли для вашего ИИ: он ими пользуется, но никогда их не видит.',
  },
  final: { title: 'Возьмите мяч.', start: 'Начать бесплатно' },
  foot: {
    backed: 'При поддержке',
    built: 'Разработка',
    changelog: 'Что нового',
    forAi: 'Для ИИ-ассистентов',
    integration: 'Интеграция',
    privacy: 'Конфиденциальность',
    terms: 'Условия',
    contact: 'Связаться',
  },
}

const he: LandCopy = {
  nav: { how: 'איך זה עובד', heat: 'חום', dev: 'למפתחים', own: 'המידע שלכם', download: 'הורדה', signin: 'כניסה', lang: 'שפה' },
  hero: {
    eyebrow: 'משימות בלי מצב תלוי באוויר',
    h1a: 'כל משימה היא כדור.',
    h1b: 'רואים אצל מי הוא.',
    lead: 'כל משימה ב־Chatick נמצאת אצל אדם אחד עם מהלך אחד: לבצע, לבדוק או לענות. מעבירים הלאה עם פתק — ושום דבר לא נתקע באמצע.',
    start: 'להתחיל בחינם',
    askAi: 'לשאול את ה־AI מה זה',
    note: 'חינם בתקופת הבטא · הקוד ב־GitHub · אפשר גם על שרת משלכם',
    people: ['אורי', 'איתי', 'מאיה', 'רון', 'את/ה'],
    heat: { warm: 'חמים', hot: 'חם', burn: 'בוער' },
    held: 'מחכה',
    moves: { do: 'בביצוע', review: 'בדיקה', answer: 'שאלה' },
    passTo: 'להעביר את הכדור: {name}',
    scene: 'שולחן עגול מלמעלה. סביבו חמישה אנשים, והכדור מונח מול מי שהתור שלו.',
  },
  ask: {
    kick: 'תנו את זה לעוזר שלכם',
    title: 'לא לקרוא. לשאול את ה־AI.',
    steps: ['להעתיק את השורה', 'להדביק אותה לעוזר', 'הוא יסביר מה זה — ויתחבר בעצמו אם תבקשו'],
    prompt: 'קרא את https://chatick.com/ai.txt והסבר במילים פשוטות מה זה Chatick, האם הוא מתאים לצוות שלי ואיך אתה מתחבר אליו.',
    copy: 'להעתיק',
    copied: 'הועתק — עכשיו להדביק',
    gpt: 'לפתוח ב־ChatGPT',
    claude: 'לפתוח ב־Claude',
  },
  rules: [
    { title: 'מחזיק אחד.', text: 'משימה תמיד בידיים של מישהו. אין „בעבודה” כשאף אחד לא עובד עליה.' },
    { title: 'מהלך אחד.', text: 'לבצע, לבדוק או לענות על שאלה. הסטטוס הולך אחרי המהלך.' },
    { title: 'פתק עם כל העברה.', text: 'מה נעשה ומה הלאה. הבא בתור מתחיל מהפתק, לא מאפס.' },
  ],
  heat: {
    title: 'ככל שהמשימה מחכה יותר — היא חמה יותר.',
    sub: 'חום הוא זמן בידיים של אדם אחד. את הכדור שלכם מרגישים בעצמכם, ומה שנתקע — כולם רואים.',
    items: [
      { key: 'warm', title: 'חמים', text: 'רק הגיעה. ביצוע — פחות מ־3 ימים; בדיקה או שאלה — פחות מיום.', clock: '00:42:10' },
      { key: 'hot', title: 'חם', text: 'מישהו כבר מחכה: 3 ימי ביצוע, או יום על בדיקה או שאלה.', clock: '1d 03:20' },
      { key: 'burn', title: 'בוער', text: 'להעביר, או להסביר למה לא: 5 ימי ביצוע, או יומיים על בדיקה או שאלה.', clock: '5d 04:12' },
      { key: 'client', title: 'מחכים ללקוח', text: 'הכדור מחוץ לצוות. הפסקה, לא שריפה — השעון סופר את ההמתנה.', clock: '2d 06:00' },
    ],
  },
  ways: {
    title: 'שתי דרכים פנימה. שתיהן לוקחות שניות.',
    ui: {
      k: 'מנהלים ו־QA',
      title: 'מסך אחד. לזרוק, לתפוס, להגיב.',
      text: 'כותבים משימה, מתייגים למי ואיפה, Enter — והיא כבר אצלו. שלוש הדחופות ביותר מונחות על השולחן, וסביבו כל המעורבים.',
      task: 'לתקן כרטיסי ביקורת במובייל',
      person: '@אורי',
      project: '#vpure',
    },
    dev: {
      k: 'מפתחים',
      title: 'לא צריך לפתוח. ה־AI מעביר בשבילכם.',
      text: 'Chatick מדבר MCP — מוסיפים אותו לפי כתובת ב־Claude, ‏Claude Code או Cursor. ה־AI לוקח משימה, מעביר ועונה ישר מהמקום שבו אתם עובדים: בשמכם ובהרשאות שלכם.',
      comment: '# done — hand it to QA',
      note: 'Zones live. Check on mobile.',
    },
  },
  own: {
    kick: 'שלכם ונשאר שלכם',
    title: 'המידע נשאר אצלכם. גם אם אנחנו ניעלם.',
    code: {
      title: 'הקוד ב־GitHub.',
      text: 'כל שורה פתוחה: לקרוא, לבדוק, להריץ לצוות שלכם — הרישיון מתיר לכל ארגון להשתמש בו לצרכים פנימיים.',
      link: 'ל־GitHub ←',
    },
    backup: {
      title: 'גיבוי כל יום.',
      text: 'מחברים אחסון S3 או R2 משלכם, ופעם ביום Chatick שומר שם ארכיון מלא של החברה ומחזיק עותקים לשבוע. ייצוא של הכול לקובץ אחד — בכל רגע.',
      badge: 'פעם ביום · 7 עותקים',
    },
    self: {
      title: 'להריץ אצלכם.',
      text: 'מתקינים את Chatick על שרת משלכם ומפסיקים להיות תלויים בנו. אותה אפליקציה, המכונה שלכם, בלי הגבלה על מספר האנשים.',
      link: 'איך מתקינים ←',
    },
  },
  download: {
    title: 'להוריד את האפליקציה.',
    sub: 'אותה סביבת עבודה בדפדפן ובמחשב — במגש המערכת הטיימר וההתראות במרחק קליק.',
    winStore: 'להוריד מ־Microsoft Store',
    mac: 'להוריד ל־macOS',
    macArm: 'Apple Silicon',
    macIntel: 'Intel',
    web: 'לפתוח בדפדפן',
    webSub: 'app.chatick.com — בלי להתקין כלום',
    macNote: 'הגרסה ל־Mac עדיין לא חתומה על ידי Apple: תעודה עולה כסף, ול־Chatick אין ספונסרים. בהפעלה הראשונה: קליק ימני על האפליקציה ← פתח ← פתח.',
    winDirect: 'החנות חסומה אצלכם? הורדה ישירה (‎.exe)',
  },
  products: {
    title: 'המוצרים שלנו',
    sub: 'מאותו צוות.',
    ungic: 'מכונה מטורפת שנועדה להחליף את Figma למפתחים: ה-AI שלכם מעצב ובונה אבטיפוס לאפליקציה.',
    vexel: 'כל איור שתרצו, בחבילות — כל התמונות באותו סגנון.',
    skey: 'מפתחות API וסיסמאות ל-AI שלכם: הוא משתמש בהם, אבל אף פעם לא רואה אותם.',
  },
  final: { title: 'לתפוס את הכדור.', start: 'להתחיל בחינם' },
  foot: {
    backed: 'בתמיכת',
    built: 'פותח על ידי',
    changelog: 'מה חדש',
    forAi: 'לעוזרי AI',
    integration: 'אינטגרציה',
    privacy: 'פרטיות',
    terms: 'תנאים',
    contact: 'צור קשר',
  },
}

export const copy: Record<LocaleCode, LandCopy> = { en, ru, he }
