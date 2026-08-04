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
  /** Честное предупреждение: продукт ещё сырой */
  beta: { badge: string; note: string; warn: string }
  hero: {
    title1: string
    titleAccent: string
    title2: string
    subtitle: string
    cta: string
    ctaSecondary: string
    note: string
    /** Подпись к снимку продукта в шапке — для читалок и когда картинка не загрузилась */
    shotAlt: string
    /** Оживший момент в шапке: реплика в чате становится задачей */
    demo: {
      /** Что происходит — одной фразой, для читалок и reduced-motion */
      alt: string
      chatLabel: string
      author: string
      message: string
      taskLabel: string
      taskTitle: string
      assignee: string
      due: string
      status: string
    }
    /** Полоса под кнопками: экспорт, открытый код, бэкапы */
    trust: string[]
  }
  pain: { title: string; items: Feature[] }
  solution: { title: string; subtitle: string; items: Feature[] }
  workspace: { title: string; subtitle: string; items: Feature[] }
  /** Секция с графиками: раньше повторяла заголовок workspace дважды на странице */
  numbers: { title: string; subtitle: string }
  /** Блок на главной для компаний со своей системой + страница интеграции */
  integrate: {
    tag: string
    title: string
    subtitle: string
    points: string[]
    cta: string
    ctaAi: string
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
  trust: { title: string; subtitle: string; noLock: Feature; items: Feature[] }
  /** Кто стоит за проектом: заказчик-спонсор, разработчик, сам продукт */
  behind: {
    tag: string
    title: string
    subtitle: string
    sponsor: { role: string; motto: string; text: string }
    /** Дочерняя студия разработки StartPlan — стоит внутри карточки заказчика */
    anyapp: { role: string; text: string }
    dev: { role: string; text: string }
    product: { role: string; text: string }
  }
  /** Скачивание десктопных версий */
  download: {
    title: string
    subtitle: string
    windows: string
    mac: string
    linux: string
    /** Маки бывают двух архитектур, и файл нужен разный */
    macArm: string
    macIntel: string
    soon: string
    web: string
    mobileSoon: string
    /** короткая подпись для кнопки в шапке */
    heroWin: string
    /** Приложения пока без подписи — говорим об этом сами, до установки */
    unsignedTitle: string
    unsignedText: string
    howTo: string
    howToClose: string
    step1: string
    step2: string
    step3: string
    sourceHint: string
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
    ph: { name: string; email: string; message: string }
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
      title: 'Chatick — the workspace your coding assistant can actually work in',
      description:
        'Built for developers: connect Claude Code and let it run tasks, read the project history, answer in chat and see who did what. Plus files, collaborative docs, time tracking and backups.',
    },
    nav: { start: 'Get started' },
    beta: { badge: 'Beta', note: 'Chatick is in beta: it works, it is used daily, and things still change and occasionally break.', warn: 'Beta software. Expect rough edges, and please report anything broken — every report is read.' },
    hero: {
      title1: 'Where your',
      titleAccent: ' coding assistant',
      title2: ' joins the team',
      subtitle:
        'Built for developers. Connect Claude Code to your project and it works there as you: creates and closes tasks, reads the whole history, answers in chat, sees what everyone has been doing.',
      cta: 'Get started',
      ctaSecondary: 'Ask your AI about us',
      note: 'Free while in beta',
      shotAlt:
        'Chatick on a desktop: project chat, tasks with sprints, the tray panel with notifications, team notes and time reports',
      demo: {
        alt: 'In the project chat someone writes “the login page breaks on Safari”. Chatick turns the message into a task: assigned to Dana, due Friday, status To do.',
        chatLabel: 'Project chat',
        author: 'Ilya',
        message: 'the login page breaks on Safari',
        taskLabel: 'Task created',
        taskTitle: 'Fix login page on Safari',
        assignee: 'Dana',
        due: 'Friday',
        status: 'To do',
      },
      trust: ['Open source', 'Free', 'Reliable: backups, export & import'],
    },
    pain: {
      title: 'Sound familiar?',
      items: [
        { title: 'Your AI is blind to the project', text: 'It writes great code and knows nothing about the task, the thread where it was agreed, or who is waiting for it.' },
        { title: 'You are the copy-paste layer', text: 'Pasting the task in, pasting the result back, restating the context every session.' },
        { title: 'History dies at the scroll limit', text: 'The decision was made two months ago in a chat nobody can search anymore. So it gets made again, differently.' },
        { title: 'Two sources of truth', text: 'Tasks live in a tracker, the real conversation happens in a messenger. Nothing matches.' },
      ],
    },
    solution: {
      title: 'Your assistant works inside the project',
      subtitle: 'Not a chatbot bolted onto a tracker — a connection that gives your AI the same access you have.',
      items: [
        { title: 'It runs the tasks', text: 'Creates, updates, closes, assigns, breaks a task into a checklist, comments — through the bridge, with your permissions, under your name.' },
        { title: 'It reads the whole history', text: 'The chat is compressed into per-day summaries; your assistant searches them, finds the right period and pulls up the exact words. Nothing is ever deleted.' },
        { title: 'It sees who did what', text: 'The project log is open to it: who changed which task, when a file was deleted, what happened while you were away.' },
        { title: 'It answers in the chat', text: 'Replies to the team, attaches builds, posts what it finished — as a participant, not as a tool you narrate for.' },
      ],
    },
    workspace: {
      title: 'And a real workspace around it',
      subtitle: 'Everything the project needs, next to the conversation that drives it — and all of it reachable by your assistant.',
      items: [
        { title: 'Several companies at once', text: 'Work across companies and projects in parallel, in one window and one tray panel. Your assistant can hold them all or just one — you choose at connection time.' },
        { title: 'Tasks & checklists', text: 'Sprints, priorities, estimates, comments, drag & drop, Excel import/export. A task splits into checklist items your AI can fill in and tick off.' },
        { title: 'Documents, co-edited', text: 'Rich editor with tables and images, real-time editing with live cursors, version history and public links.' },
        { title: 'File manager', text: 'Attach from chat, tasks or clipboard. Images optimised automatically; originals kept only when you ask. Your own S3/R2 if you want no limits.' },
        { title: 'Resources & secrets', text: 'Links, panels and credentials in one place, encrypted at rest and revealed only on demand. The AI can save them, and can never read the values back.' },
        { title: 'Notes for the team — and the AI', text: 'Decisions, solutions, contradictions and reminders as a searchable journal. Mark a solution company-wide and other projects find it before debugging it twice.' },
        { title: 'Time tracking', text: 'Timers and after-the-fact entries, reports by person, task and day, with export. Your assistant can start, stop and report on them.' },
        { title: 'Backups & export', text: 'Scheduled encrypted backups, seven days of undo, and full export whenever you want. Nothing here is held hostage.' },
      ],
    },
    numbers: {
      title: 'The numbers are already there',
      subtitle: 'Hours, tasks and activity add up as you work — no separate reporting ritual, and your assistant can read them too.',
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
    bridge: {
      tag: 'The bridge',
      title: 'One line, and your assistant is part of the project',
      subtitle:
        'Claude Code — or any assistant that can read docs and call HTTP — connects to Chatick and works there: tasks, checklists, chat, files, documents, notes, time, and the full compressed history.',
      points: [
        'One line to paste. Your assistant reads the guide and connects itself — no SDK, no integration to write.',
        'You approve access in the browser — no token ever goes through your chat.',
        'It acts as you, within your permissions, and every action lands in the project history under your name.',
        'Connect to one project, a whole company, or everything you have access to.',
        'A connection is a tunnel: close it and the access is gone.',
      ],
      security: 'No permanent tokens. Nothing to leak. It can never do more than you can.',
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
        { title: 'Create a project', text: 'A project is a group. Invite your team — chat, tasks, files and documents are ready.' },
        { title: 'Connect your assistant', text: 'Paste one line into Claude Code. It reads the guide, you approve access in the browser, and it starts working in the project.' },
        { title: 'Work as usual', text: 'You write code, it handles the project around it — tasks, answers, history. The chat AI meanwhile translates, deduplicates and turns talk into tasks.' },
      ],
    },
    cta: {
      title: 'Give your assistant somewhere to work',
      subtitle: 'Web today. Desktop for Windows & macOS next.',
      button: 'Open Chatick',
    },
    trust: {
      title: 'Built to be trusted with your team’s work',
      subtitle: 'The unglamorous parts, done properly — losing someone’s work once is enough to lose them.',
      noLock: { title: 'No lock-in, by design', text: 'Export and import everything, whenever you want. The source code is open: if you like the system, run it on your own servers — and if we ever stop maintaining it, nothing you built here dies with us.' },
      items: [
        { title: 'Free, and honestly so', text: 'No card, no trial countdown, no seats to count. Every project gets room for real work, and the limits are stated plainly instead of hidden in a plan comparison.' },
        { title: 'Backed up, not hoped for', text: 'The database is backed up on a schedule and the copies are encrypted. Deleted documents and notes stay recoverable for seven days — a mistaken click is not the end of the story.' },
        { title: 'Encrypted where it matters', text: 'Everything travels over HTTPS. Credentials kept in Resources are encrypted before they reach the database, and access inside a project is decided by roles.' },
        { title: 'Dangerous things ask twice', text: 'Deleting a project or a company wipes everything belonging to it, files included. So it lives in a clearly marked danger zone, needs confirmation, and emails every member afterwards.' },
        { title: 'Servers in the EU', text: 'Data sits on servers in Germany. Export it or delete it whenever you like — the privacy page names exactly who else processes it.' },
        { title: 'Nothing hidden in the log', text: 'Every release is written down before it ships; the build refuses to run otherwise. What changed is always readable on the changelog page.' },
      ],
    },
    behind: {
      tag: 'Behind this project',
      title: 'Who is behind Chatick',
      subtitle: 'A client who pays for it, a developer who writes it, and a product both of them use.',
      sponsor: {
        role: 'Client and sponsor',
        motto: 'Building people, creating entrepreneurs',
        text: 'StartPlan is an Israeli startup consultancy with more than ten years behind it. Its founders have helped raise hundreds of millions of shekels for the companies they backed. Chatick is built for them, and paid for by them.',
      },
      anyapp: {
        role: 'Their development studio',
        text: 'AnyApp is StartPlan’s subsidiary: an Israeli studio building mobile apps for Android and iOS and web systems, the whole way from spec to launch. Dozens of products shipped, and founders who have made the Forbes 30 Under 30 Israel list.',
      },
      dev: {
        role: 'Development',
        text: 'One developer, fifteen years of building software, writing Chatick daily and using it to run the work on Chatick itself.',
      },
      product: {
        role: 'The product',
        text: 'Open source and free while in beta. Everything on this page is running today — nothing here is a mockup of something planned.',
      },
    },
    download: {
      title: 'Use it wherever you work',
      subtitle: 'The same workspace in the browser and on your desktop, with a tray panel that keeps the timer and your notifications one click away.',
      windows: 'Download for Windows',
      mac: 'Download for macOS',
      linux: 'Download for Linux',
      macArm: 'Apple Silicon',
      macIntel: 'Intel',
      soon: 'Coming soon',
      web: 'Open in browser',
      mobileSoon: 'Mobile apps are on the roadmap.',
      heroWin: 'Download for Windows',
      unsignedTitle: 'The desktop builds are not signed yet',
      unsignedText: 'A code-signing certificate costs money, and Chatick is free with no sponsors behind it. Windows and your browser will warn you about the file. Nothing is hidden: the source is open, and you can build the same app yourself.',
      howTo: 'What to expect when installing',
      howToClose: 'Got it',
      step1: 'Your browser will say the file is downloaded rarely. Choose “Keep” — in Chrome it is hidden under the arrow next to the warning.',
      step2: 'Windows shows a blue SmartScreen window. Click “More info”, then “Run anyway”.',
      step3: 'After that it installs normally, and updates itself from then on.',
      sourceHint: 'Rather build it yourself? The full source is on GitHub.',
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
      ph: { name: 'Jane Cooper', email: 'you@company.com', message: 'What happened, or what would you like to see?' },
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
      title: 'Chatick — рабочее пространство, в котором работает ваш ассистент',
      description:
        'Сделано для разработчиков: подключите Claude Code, и он ведёт задачи, читает всю историю проекта, отвечает в чате и видит, кто что делал. Плюс файлы, совместные документы, трекер времени и бэкапы.',
    },
    nav: { start: 'Начать' },
    beta: { badge: 'Бета', note: 'Chatick в бете: он работает и используется каждый день, но всё ещё меняется и иногда ломается.', warn: 'Бета-версия. Возможны шероховатости — пишите о поломках, каждое сообщение читают.' },
    hero: {
      title1: 'Место, где ваш',
      titleAccent: ' ИИ-ассистент',
      title2: ' работает в команде',
      subtitle:
        'Сделано для разработчиков. Подключите Claude Code к проекту — и он работает в нём от вашего имени: заводит и закрывает задачи, читает всю историю, отвечает в чате, видит, кто чем занимался.',
      cta: 'Начать',
      ctaSecondary: 'Спросите свой ИИ о нас',
      note: 'Бесплатно на время беты',
      shotAlt:
        'Chatick на рабочем столе: чат проекта, задачи со спринтами, панель в трее с уведомлениями, заметки команды и отчёты по времени',
      demo: {
        alt: 'В чате проекта пишут «страница входа ломается в Safari». Chatick превращает реплику в задачу: исполнитель Дана, срок пятница, статус «К выполнению».',
        chatLabel: 'Чат проекта',
        author: 'Илья',
        message: 'страница входа ломается в Safari',
        taskLabel: 'Задача создана',
        taskTitle: 'Починить вход в Safari',
        assignee: 'Дана',
        due: 'Пятница',
        status: 'К выполнению',
      },
      trust: ['Открытый код', 'Бесплатно', 'Надёжно: бэкапы, экспорт и импорт'],
    },
    pain: {
      title: 'Знакомо?',
      items: [
        { title: 'Ассистент не видит проект', text: 'Пишет отличный код и ничего не знает о задаче, о треде, где её обсудили, и о том, кто её ждёт.' },
        { title: 'Вы работаете буфером обмена', text: 'Вставить задачу, вставить результат обратно, каждый раз заново пересказывать контекст.' },
        { title: 'История кончается на скролле', text: 'Решение приняли два месяца назад в переписке, которую уже не найти. И его принимают заново — по-другому.' },
        { title: 'Два источника правды', text: 'Задачи — в трекере, настоящий разговор — в мессенджере. Ничего не сходится.' },
      ],
    },
    solution: {
      title: 'Ассистент работает внутри проекта',
      subtitle: 'Не чат-бот, приделанный к трекеру, а подключение, дающее вашему ИИ те же доступы, что есть у вас.',
      items: [
        { title: 'Ведёт задачи', text: 'Создаёт, меняет, закрывает, назначает, разбивает задачу на чек-лист, комментирует — через мост, в границах ваших прав и под вашим именем.' },
        { title: 'Читает всю историю', text: 'Переписка свёрнута в саммари по дням: ассистент ищет по ним, находит нужный период и поднимает точные слова. Ничего не удаляется.' },
        { title: 'Видит, кто что делал', text: 'Журнал проекта открыт ему: кто менял задачу, когда удалили файл, что происходило, пока вас не было.' },
        { title: 'Отвечает в чате', text: 'Пишет команде, прикладывает сборки, сообщает, что доделал — как участник, а не инструмент, за который вы пересказываете.' },
      ],
    },
    workspace: {
      title: 'И полноценное пространство вокруг',
      subtitle: 'Всё, что нужно проекту, рядом с разговором, который им движет, — и всё это доступно ассистенту.',
      items: [
        { title: 'Несколько компаний сразу', text: 'Работайте в нескольких компаниях и проектах параллельно — в одном окне и одной панели в трее. Ассистента можно подключить ко всему сразу или к одному проекту.' },
        { title: 'Задачи и чек-листы', text: 'Спринты, приоритеты, оценки, комментарии, перетаскивание, импорт и экспорт в Excel. Задача разбивается на пункты, которые ИИ может заполнить и отметить.' },
        { title: 'Документы вдвоём', text: 'Богатый редактор с таблицами и картинками, совместное редактирование с курсорами, история версий и публичные ссылки.' },
        { title: 'Файловый менеджер', text: 'Прикрепляйте из чата, задач или буфера обмена. Картинки оптимизируются сами, оригиналы — только если попросите. Своё S3/R2, если не нужны лимиты.' },
        { title: 'Ресурсы и секреты', text: 'Ссылки, панели и пароли в одном месте: шифруются и раскрываются только по запросу. ИИ может их сохранять и никогда не может прочитать значения.' },
        { title: 'Заметки команде и ИИ', text: 'Решения, находки, противоречия и напоминания — журнал с поиском. Отметьте решение общим для компании, и другие проекты найдут его раньше, чем начнут отлаживать заново.' },
        { title: 'Учёт времени', text: 'Таймеры и записи задним числом, отчёты по людям, задачам и дням, экспорт. Ассистент умеет запускать, останавливать и отчитываться.' },
        { title: 'Бэкапы и экспорт', text: 'Резервные копии по расписанию и зашифрованные, неделя на отмену удаления и полный экспорт в любой момент. Ничего здесь не держат в заложниках.' },
      ],
    },
    numbers: {
      title: 'Цифры уже собраны',
      subtitle: 'Часы, задачи и активность копятся по ходу работы — без отдельного ритуала отчётности. Ассистент их тоже читает.',
    },
    integrate: {
      tag: 'Для компаний со своей системой',
      title: 'Оставьте свою систему. Перенесите работу.',
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
    bridge: {
      tag: 'Мост',
      title: 'Одна строка — и ассистент внутри проекта',
      subtitle:
        'Claude Code — или любой ассистент, умеющий читать документацию и делать HTTP-запросы — подключается к Chatick и работает там: задачи, чек-листы, чат, файлы, документы, заметки, время и вся сжатая история.',
      points: [
        'Одна строка, которую нужно вставить. Ассистент сам прочитает инструкцию и подключится — без SDK и без интеграции, которую надо писать.',
        'Доступ вы подтверждаете в браузере — токен никогда не проходит через чат.',
        'Он действует от вашего имени, в границах ваших прав, и всё попадает в историю проекта под вашим именем.',
        'Подключить можно к одному проекту, ко всей компании или ко всему, к чему у вас есть доступ.',
        'Подключение — это туннель: закрыли, и доступа больше нет.',
      ],
      security: 'Никаких постоянных токенов. Утекать нечему. Больше вас он не может.',
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
      noLock: { title: 'Никакой привязки — намеренно', text: 'Экспорт и импорт всего в любой момент. Исходный код открыт: понравилась система — разверните её на своих серверах. Даже если мы когда-нибудь перестанем её поддерживать, всё, что вы здесь построили, останется с вами.' },
      items: [
        { title: 'Бесплатно и честно', text: 'Без карты, без таймера пробного периода, без подсчёта мест. Каждому проекту — место под реальную работу, а лимиты названы прямо, а не спрятаны в сравнении тарифов.' },
        { title: 'Бэкапы, а не надежда', text: 'База копируется по расписанию, копии зашифрованы. Удалённые документы и заметки можно вернуть семь дней — случайный клик не конец истории.' },
        { title: 'Шифруется там, где важно', text: 'Всё идёт по HTTPS. Доступы, сложенные в «Ресурсы», шифруются до того, как попадут в базу, а доступ внутри проекта определяют роли.' },
        { title: 'Опасное переспрашивает', text: 'Удаление проекта или компании стирает всё их содержимое вместе с файлами — поэтому живёт в красной зоне, требует подтверждения и рассылает письма всем участникам.' },
        { title: 'Серверы в ЕС', text: 'Данные лежат в Германии. Их можно выгрузить или удалить в любой момент, а на странице приватности перечислено, кто ещё их обрабатывает.' },
        { title: 'Ничего не прячется', text: 'Каждая версия описана до выпуска — иначе сборка просто не пройдёт. Что изменилось, всегда видно в журнале версий.' },
      ],
    },
    behind: {
      tag: 'Кто за этим стоит',
      title: 'Кто стоит за Chatick',
      subtitle: 'Заказчик, который его оплачивает, разработчик, который его пишет, и продукт, которым пользуются оба.',
      sponsor: {
        role: 'Заказчик и спонсор',
        motto: 'Растим людей, создаём предпринимателей',
        text: 'StartPlan — израильская консалтинговая компания для стартапов, за плечами больше десяти лет. Её основатели помогли привлечь сотни миллионов шекелей компаниям, которые поддерживали. Chatick делается для них и на их деньги.',
      },
      anyapp: {
        role: 'Их студия разработки',
        text: 'AnyApp — дочерняя компания StartPlan: израильская студия, которая делает мобильные приложения для Android и iOS и веб-системы — полный цикл от спецификации до запуска. Десятки выпущенных продуктов, а основатели попадали в список Forbes «30 Under 30 Israel».',
      },
      dev: {
        role: 'Разработка',
        text: 'Один разработчик, пятнадцать лет в профессии. Пишет Chatick каждый день и ведёт в нём же работу над самим Chatick.',
      },
      product: {
        role: 'Продукт',
        text: 'Открытый код, бесплатно на время беты. Всё, что на этой странице, работает уже сегодня — здесь нет макетов того, что только запланировано.',
      },
    },
    download: {
      title: 'Работайте там, где удобно',
      subtitle: 'Одно и то же рабочее место в браузере и на компьютере, с панелью в трее: таймер и уведомления в одном клике.',
      windows: 'Скачать для Windows',
      mac: 'Скачать для macOS',
      linux: 'Скачать для Linux',
      macArm: 'Apple Silicon',
      macIntel: 'Intel',
      soon: 'Скоро',
      web: 'Открыть в браузере',
      mobileSoon: 'Мобильные приложения — в планах.',
      heroWin: 'Скачать для Windows',
      unsignedTitle: 'Сборки для рабочего стола пока без подписи',
      unsignedText: 'Сертификат для подписи стоит денег, а Chatick бесплатен и без спонсоров. Windows и браузер предупредят вас об этом файле. Скрывать нечего: исходники открыты, и такое же приложение вы можете собрать сами.',
      howTo: 'Что будет при установке',
      howToClose: 'Понятно',
      step1: 'Браузер скажет, что файл скачивают редко. Выберите «Сохранить» — в Chrome это спрятано под стрелкой рядом с предупреждением.',
      step2: 'Windows покажет синее окно SmartScreen. Нажмите «Подробнее», затем «Выполнить в любом случае».',
      step3: 'Дальше установка обычная, а обновления приложение ставит само.',
      sourceHint: 'Хотите собрать сами? Исходники целиком лежат на GitHub.',
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
      ph: { name: 'Анна Смирнова', email: 'you@company.com', message: 'Что случилось или чего не хватает?' },
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
      title: 'Chatick — סביבת העבודה שבה עוזר הקוד שלכם באמת עובד',
      description:
        'נבנה למפתחים: חברו את Claude Code והוא מנהל משימות, קורא את כל היסטוריית הפרויקט, עונה בצ׳אט ורואה מי עשה מה. בנוסף קבצים, מסמכים משותפים, מעקב זמן וגיבויים.',
    },
    nav: { start: 'להתחיל' },
    beta: { badge: 'בטא', note: 'Chatick בגרסת בטא: הוא עובד ומשמש מדי יום, אך עדיין משתנה ולעיתים נשבר.', warn: 'גרסת בטא. ייתכנו תקלות — דווחו עליהן, כל דיווח נקרא.' },
    hero: {
      title1: 'המקום שבו',
      titleAccent: ' עוזר ה-AI שלכם',
      title2: ' עובד עם הצוות',
      subtitle:
        'נבנה למפתחים. חברו את Claude Code לפרויקט והוא עובד בו בשמכם: פותח וסוגר משימות, קורא את כל ההיסטוריה, עונה בצ׳אט ורואה במה כולם עסקו.',
      cta: 'להתחיל',
      ctaSecondary: 'שאלו את ה-AI שלכם עלינו',
      note: 'חינם בתקופת הבטא',
      shotAlt:
        'Chatick על שולחן העבודה: צ׳אט הפרויקט, משימות עם ספרינטים, פאנל המגש עם התראות, הערות הצוות ודוחות זמן',
      demo: {
        alt: 'בצ׳אט הפרויקט כותבים «דף ההתחברות נשבר ב-Safari». Chatick הופך את ההודעה למשימה: אחראית דנה, יעד יום שישי, סטטוס «לביצוע».',
        chatLabel: 'צ׳אט הפרויקט',
        author: 'איליה',
        message: 'דף ההתחברות נשבר ב-Safari',
        taskLabel: 'נוצרה משימה',
        taskTitle: 'לתקן את דף ההתחברות ב-Safari',
        assignee: 'דנה',
        due: 'יום שישי',
        status: 'לביצוע',
      },
      trust: ['קוד פתוח', 'חינם', 'אמין: גיבויים, ייצוא ויבוא'],
    },
    pain: {
      title: 'נשמע מוכר?',
      items: [
        { title: 'ה-AI שלכם עיוור לפרויקט', text: 'כותב קוד מצוין ולא יודע דבר על המשימה, על השיחה שבה סוכמה, או על מי שמחכה לה.' },
        { title: 'אתם שכבת ההעתק-הדבק', text: 'להדביק את המשימה פנימה, להדביק את התוצאה בחזרה, ולספר מחדש את ההקשר בכל שיחה.' },
        { title: 'ההיסטוריה נגמרת בגלילה', text: 'ההחלטה התקבלה לפני חודשיים בצ׳אט שאי אפשר לחפש בו. אז מקבלים אותה שוב — אחרת.' },
        { title: 'שני מקורות אמת', text: 'המשימות במערכת אחת, השיחה האמיתית במסנג׳ר. שום דבר לא מסתנכרן.' },
      ],
    },
    solution: {
      title: 'העוזר שלכם עובד בתוך הפרויקט',
      subtitle: 'לא צ׳אט-בוט שהודבק למערכת משימות, אלא חיבור שנותן ל-AI שלכם בדיוק את ההרשאות שיש לכם.',
      items: [
        { title: 'מנהל את המשימות', text: 'פותח, מעדכן, סוגר, מקצה, מפרק משימה לרשימת בדיקה ומגיב — דרך הגשר, בגבול ההרשאות שלכם ובשמכם.' },
        { title: 'קורא את כל ההיסטוריה', text: 'הצ׳אט נדחס לסיכומים יומיים; העוזר מחפש בהם, מוצא את התקופה ומעלה את המילים המדויקות. שום דבר לא נמחק.' },
        { title: 'רואה מי עשה מה', text: 'יומן הפרויקט פתוח לו: מי שינה איזו משימה, מתי נמחק קובץ, מה קרה בזמן שלא הייתם.' },
        { title: 'עונה בצ׳אט', text: 'משיב לצוות, מצרף בילדים, מדווח מה סיים — כמשתתף, לא ככלי שאתם מתווכים עבורו.' },
      ],
    },
    workspace: {
      title: 'ומסביב — סביבת עבודה אמיתית',
      subtitle: 'כל מה שפרויקט צריך, ליד השיחה שמניעה אותו — והכול נגיש גם לעוזר שלכם.',
      items: [
        { title: 'כמה חברות במקביל', text: 'עבדו בכמה חברות ופרויקטים בו-זמנית, בחלון אחד ובפאנל אחד במגש. את העוזר אפשר לחבר לכולם או לפרויקט אחד — אתם בוחרים בזמן החיבור.' },
        { title: 'משימות ורשימות בדיקה', text: 'ספרינטים, עדיפויות, הערכות זמן, תגובות, גרירה, ייבוא וייצוא לאקסל. משימה מתפרקת לפריטים שה-AI יכול למלא ולסמן.' },
        { title: 'מסמכים בעריכה משותפת', text: 'עורך עשיר עם טבלאות ותמונות, עריכה בזמן אמת עם סמנים חיים, היסטוריית גרסאות וקישורים ציבוריים.' },
        { title: 'מנהל קבצים', text: 'צרפו מהצ׳אט, מהמשימות או מהלוח. תמונות עוברות אופטימיזציה אוטומטית, מקור נשמר רק אם ביקשתם. S3/R2 משלכם — ללא מגבלות.' },
        { title: 'משאבים וסודות', text: 'קישורים, פאנלים וסיסמאות במקום אחד: מוצפנים ונחשפים רק לפי בקשה. ה-AI יכול לשמור אותם ולעולם לא לקרוא את הערכים.' },
        { title: 'הערות לצוות ול-AI', text: 'החלטות, פתרונות, סתירות ותזכורות כיומן עם חיפוש. סמנו פתרון כמשותף לחברה, ופרויקטים אחרים ימצאו אותו לפני שיאתרו את אותו באג מחדש.' },
        { title: 'מעקב זמן', text: 'טיימרים ורישום בדיעבד, דוחות לפי אנשים, משימות וימים, עם ייצוא. העוזר יודע להפעיל, לעצור ולדווח.' },
        { title: 'גיבויים וייצוא', text: 'גיבויים מתוזמנים ומוצפנים, שבוע לביטול מחיקה וייצוא מלא בכל רגע. שום דבר כאן לא מוחזק כבן ערובה.' },
      ],
    },
    numbers: {
      title: 'המספרים כבר כאן',
      subtitle: 'שעות, משימות ופעילות מצטברים תוך כדי עבודה — בלי טקס דיווח נפרד, והעוזר שלכם קורא אותם גם.',
    },
    integrate: {
      tag: 'לחברות עם מערכת משלהן',
      title: 'השאירו את המערכת שלכם. העבירו לכאן את העבודה.',
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
    bridge: {
      tag: 'הגשר',
      title: 'שורה אחת — והעוזר שלכם בתוך הפרויקט',
      subtitle:
        'Claude Code — או כל עוזר שיודע לקרוא תיעוד ולבצע בקשות HTTP — מתחבר ל-Chatick ועובד שם: משימות, רשימות בדיקה, צ׳אט, קבצים, מסמכים, הערות, זמן וכל ההיסטוריה הדחוסה.',
      points: [
        'שורה אחת להדביק. העוזר יקרא את ההוראות ויתחבר בעצמו — בלי SDK ובלי אינטגרציה שצריך לכתוב.',
        'אתם מאשרים את הגישה בדפדפן — הטוקן לעולם לא עובר בצ׳אט.',
        'הוא פועל בשמכם, בגבולות ההרשאות שלכם, והכול נרשם בהיסטוריית הפרויקט תחת שמכם.',
        'אפשר לחבר לפרויקט אחד, לחברה שלמה או לכל מה שיש לכם גישה אליו.',
        'חיבור הוא מנהרה: סוגרים אותה — והגישה נעלמת.',
      ],
      security: 'בלי טוקנים קבועים. אין מה לדלוף. הוא לעולם לא יכול יותר מכם.',
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
        { title: 'צרו פרויקט', text: 'פרויקט הוא קבוצה. הזמינו את הצוות — צ׳אט, משימות, קבצים ומסמכים מוכנים.' },
        { title: 'חברו את העוזר', text: 'הדביקו שורה אחת ב-Claude Code. הוא קורא את ההוראות, אתם מאשרים בדפדפן, והוא מתחיל לעבוד בפרויקט.' },
        { title: 'עבדו כרגיל', text: 'אתם כותבים קוד, הוא מטפל בפרויקט סביבו — משימות, תשובות, היסטוריה. ובינתיים ה-AI של הצ׳אט מתרגם, מסנן כפילויות והופך שיחה למשימות.' },
      ],
    },
    cta: {
      title: 'תנו לעוזר שלכם מקום לעבוד בו',
      subtitle: 'זמין בדפדפן היום. גרסת דסקטופ ל-Windows ו-macOS בקרוב.',
      button: 'לפתוח את Chatick',
    },
    trust: {
      title: 'נבנה כדי שאפשר יהיה להפקיד בו את העבודה',
      subtitle: 'החלקים המשעממים נעשו כמו שצריך — לאבד עבודה פעם אחת זה מספיק.',
      noLock: { title: 'בלי נעילה — בכוונה', text: 'ייצוא וייבוא של הכל, בכל רגע. הקוד פתוח: אהבתם את המערכת — הריצו אותה על השרתים שלכם. גם אם אי פעם נפסיק לתחזק אותה, כל מה שבניתם כאן יישאר אצלכם.' },
      items: [
        { title: 'חינם, באמת', text: 'בלי כרטיס אשראי, בלי שעון ניסיון ובלי לספור משתמשים. לכל פרויקט יש מקום לעבודה אמיתית, והמגבלות נאמרות בפירוש.' },
        { title: 'גיבוי, לא תקווה', text: 'מסד הנתונים מגובה באופן קבוע והעותקים מוצפנים. מסמכים ופתקים שנמחקו ניתנים לשחזור שבעה ימים.' },
        { title: 'הצפנה במקום שחשוב', text: 'הכל עובר ב-HTTPS. אישורי גישה מוצפנים לפני שהם מגיעים למסד הנתונים, והגישה בפרויקט נקבעת לפי תפקידים.' },
        { title: 'פעולות מסוכנות שואלות פעמיים', text: 'מחיקת פרויקט או חברה מוחקת גם את הקבצים — לכן זה דורש אישור ושולח הודעה לכל החברים.' },
        { title: 'שרתים באיחוד האירופי', text: 'הנתונים שמורים בגרמניה. אפשר לייצא או למחוק אותם בכל רגע.' },
        { title: 'שום דבר לא מוסתר', text: 'כל גרסה מתועדת לפני שהיא יוצאת — אחרת הבנייה פשוט נכשלת.' },
      ],
    },
    behind: {
      tag: 'מי עומד מאחורי זה',
      title: 'מי עומד מאחורי Chatick',
      subtitle: 'לקוח שמממן, מפתח שכותב, ומוצר ששניהם עובדים בו.',
      sponsor: {
        role: 'לקוח ונותן חסות',
        motto: 'בונים אנשים, יוצרים יזמים',
        text: 'StartPlan היא חברת ייעוץ ישראלית לסטארטאפים עם יותר מעשר שנות ניסיון. מייסדיה סייעו לגייס מאות מיליוני שקלים עבור החברות שליוו. Chatick נבנה עבורם ובמימונם.',
      },
      anyapp: {
        role: 'סטודיו הפיתוח שלהם',
        text: 'AnyApp היא חברת הבת של StartPlan: סטודיו ישראלי שמפתח אפליקציות מובייל ל-Android ול-iOS ומערכות ווב — מהאפיון ועד ההשקה. עשרות מוצרים שיצאו לאוויר, ומייסדים שנכנסו לרשימת Forbes «30 Under 30 Israel».',
      },
      dev: {
        role: 'פיתוח',
        text: 'מפתח אחד, חמש עשרה שנות פיתוח. כותב את Chatick מדי יום ומנהל בו את העבודה על Chatick עצמו.',
      },
      product: {
        role: 'המוצר',
        text: 'קוד פתוח, חינם בתקופת הבטא. כל מה שבעמוד הזה עובד היום — אין כאן הדמיות של דברים שרק מתוכננים.',
      },
    },
    download: {
      title: 'עבדו איפה שנוח לכם',
      subtitle: 'אותו מרחב עבודה בדפדפן ובמחשב, עם לוח במגש המערכת.',
      windows: 'הורדה ל-Windows',
      mac: 'הורדה ל-macOS',
      linux: 'הורדה ל-Linux',
      macArm: 'Apple Silicon',
      macIntel: 'Intel',
      soon: 'בקרוב',
      web: 'פתחו בדפדפן',
      mobileSoon: 'אפליקציות לנייד בתוכניות.',
      heroWin: 'הורדה ל-Windows',
      unsignedTitle: 'גרסאות שולחן העבודה עדיין ללא חתימה',
      unsignedText: 'תעודת חתימה עולה כסף, ו-Chatick חינמי וללא נותני חסות. Windows והדפדפן יזהירו אתכם על הקובץ. אין מה להסתיר: הקוד פתוח, ואפשר לבנות את אותה אפליקציה בעצמכם.',
      howTo: 'מה יקרה בהתקנה',
      howToClose: 'הבנתי',
      step1: 'הדפדפן יאמר שהקובץ מורד לעיתים רחוקות. בחרו «שמירה» — ב-Chrome זה מוסתר מתחת לחץ שליד האזהרה.',
      step2: 'Windows יציג חלון SmartScreen כחול. לחצו «מידע נוסף» ואז «הפעל בכל זאת».',
      step3: 'מכאן ההתקנה רגילה, והאפליקציה מתעדכנת מעצמה.',
      sourceHint: 'מעדיפים לבנות בעצמכם? הקוד המלא נמצא ב-GitHub.',
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
      ph: { name: 'דנה לוי', email: 'you@company.com', message: 'מה קרה או מה חסר לכם?' },
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
