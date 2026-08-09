import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { visionEnabled } from './vision.js'
import { messages, projects, sandboxMessages, users } from '../db/schema.js'
import { projectLlm, complete, completeStream, completeWithTools } from './llm.js'
import { buildMemoryContext, buildTeamContext, memoryTools } from './memory.js'

// ИИ-диспетчер (SPEC §5.5): оценка сообщений группы (PASS/HOLD) и sandbox-диалог.
// Все ответы модели — строгий JSON; парсинг устойчив к ```json обёрткам.

type AiConfig = {
  mode?: 'observer' | 'assistant' | 'moderator'
  language?: string
  answerRepeats?: boolean
}

const LANG_NAMES: Record<string, string> = { en: 'English', ru: 'Russian', he: 'Hebrew' }

/**
 * Язык, на котором ИИ пишет задачи и документы проекта.
 *
 * aiConfig.language — отдельная настройка, и у проекта, созданного через API
 * внешней системы, её нет. Раньше пустое значение молча превращалось в
 * английский: израильская компания заводила проект, а ИИ в чате требовал
 * писать по-английски.
 *
 * Поэтому пустое — не «английский», а «наследую»: язык проекта, затем язык
 * компании. Тот же порядок, что у писем.
 */
async function aiLang(ai: AiConfig, projectId: string): Promise<string> {
  if (ai.language) return LANG_NAMES[ai.language] ?? ai.language
  const { localeFor } = await import('./locale.js')
  return LANG_NAMES[await localeFor({ projectId })] ?? 'English'
}

function parseJson<T>(text: string | null): T | null {
  if (!text) return null
  const clean = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')
  try {
    return JSON.parse(clean) as T
  } catch {
    // модели (особенно deepseek) кладут неэкранированные кавычки внутрь строк:
    // {"reason":"слово "Ямина" запрещено"} — чиним посимвольно: кавычка закрывает строку
    // только если за ней структурный символ, иначе экранируем
    try {
      let out = ''
      let inString = false
      for (let i = 0; i < clean.length; i++) {
        const ch = clean[i]!
        if (ch === '"' && clean[i - 1] !== '\\') {
          if (!inString) {
            inString = true
            out += ch
          } else {
            // конец строки только если дальше структурный символ
            const rest = clean.slice(i + 1).match(/^\s*[:,}\]]/)
            if (rest) {
              inString = false
              out += ch
            } else {
              out += '\\"' // внутренняя кавычка — экранируем
            }
          }
        } else {
          out += ch
        }
      }
      return JSON.parse(out) as T
    } catch {
      console.error('[dispatcher] bad JSON from LLM:', text.slice(0, 200))
      return null
    }
  }
}

/**
 * Ответ ИИ в личном режиме («ИИ»-таб чата): полный доступ к памяти и инструментам,
 * CRUD задач — строго в пределах пермишенов автора (SPEC §5.6).
 */
export async function aiChatReply(
  projectId: string,
  userId: string,
  userMessage: string,
  /**
   * Картинки к сообщению. Пусто — обычный текстовый ответ.
   *
   * Решение принято на сервере ДО вызова: сюда они доходят, только если
   * человек прямо попросил посмотреть. Промптом такое не удержать — картинка,
   * уехавшая в запрос, уже увидена и уже оплачена.
   */
  images: { mediaType: string; base64: string }[] = [],
): Promise<string | null> {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) })
  if (!project) return null
  const cfg = await projectLlm(projectId, 'chat')
  if (!cfg) return null

  const ai = JSON.parse(project.aiConfig || '{}') as AiConfig
  const visionOn = await visionEnabled(projectId)
  const lang = await aiLang(ai, projectId)
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) })
  const team = await buildTeamContext(projectId) // кто за что отвечает (SPEC §8.12)
  const { tools, handlers } = memoryTools(projectId, userId)

  // контекст = история ЭТОГО ai-диалога (не групповой чат — его ИИ читает сам через read_chat)
  const dialog = await db
    .select({ msg: messages })
    .from(messages)
    .where(
      and(
        eq(messages.projectId, projectId),
        eq(messages.mode, 'ai'),
        // диалог юзера: его сообщения + адресованные ему ответы ИИ
        sql`(${messages.authorId} = ${userId} or ${messages.recipientId} = ${userId})`,
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(20)
  const dialogText = dialog
    .reverse()
    .map((r) => `${r.msg.authorId ? user?.name ?? 'User' : 'You'}: ${r.msg.text}`)
    .join('\n')

  return completeWithTools(cfg, {
    system: [
      `You are the AI assistant of the project "${project.name}". PROJECT LANGUAGE: ${lang}.`,
      `You are talking privately with ${user?.name ?? 'a member'}.`,
      // «Можно на их языке» — это разрешение, а не указание: инструкции вокруг
      // все на английском, и модель соскальзывает на него же. Человек пишет
      // по-русски и получает ответ по-английски.
      `ANSWER IN THE LANGUAGE THE USER WROTE IN. They write Russian — you answer Russian; Hebrew — Hebrew. Do not switch to English because these instructions are in English. This applies to every reply, including short ones and error explanations.`,
      // Вопросы, оставшиеся без ответа (SPEC §8.49).
      //
      // Менеджер на звонке получает вопрос от клиента, ответить на который не
      // может: нужен разработчик, а он недоступен. Вопрос уходит в переписку и
      // теряется там до следующего звонка, где всплывает снова.
      //
      // ПРЕДЛАГАЕМ, а не создаём молча: вопросы в чате звучат постоянно, и
      // задача из каждого превратила бы доску в свалку. Решает человек.
      `UNANSWERED QUESTIONS. When someone asks something you cannot answer from the project data — it needs a person's knowledge, a decision, or access you do not have — say so plainly, then OFFER to record it as a task for whoever is likely to know.`,
      `Only create the task if they agree. Do not create it on your own: questions come up constantly in chat, and a task per question would bury the real ones.`,
      `When they agree: check list_sprints for an existing group for questions and use it, or create one with create_sprint. Then create_task — title states the question, description holds the context (who asked, why it matters, what is blocked), assignee is the person whose responsibility fits it best from the team context above. Leave it unassigned only if nobody obviously fits.`,
      `Never invent an answer to avoid the offer — a wrong answer repeated to a client is worse than "I asked the team".`,
      `CRITICAL: all PROJECT ARTIFACTS you create or edit — task titles & descriptions, resource names & descriptions, comments, sprint names — MUST be written in the project language (${lang}), regardless of the language the user asked in. Translate the user's intent into ${lang} for these. Only the conversational reply may be in the user's language.`,
      team,
      project.chatRules ? `Chat rules: "${project.chatRules}"` : '',
      'Tools: read_chat, summaries & full-history search; files (list_files, attach_file_to_task, delete_file); task CRUD — create/update_task edit ANY task field (title, description, assignee, due date, estimate, priority, status, sprint); review_task (AI critique); sprints (list_sprints, create_sprint); task comments (add_task_comment writes ON BEHALF OF the user; list_task_comments reads them); resources (list/create/update/delete_resource, add_resource_secret); documents (list_documents, read_document, create_document, update_document, append_to_document, delete_document); project journal — list_notes/read_note search solutions, decisions and contradictions (scope=company searches the whole company), create_note/update_note write them ON BEHALF OF the user when asked to save or record something, note_to_task turns a note into a task; time tracking — start_timer/stop_timer/list_timers run the user\'s timer, log_time records work after the fact, time_report answers \"how much did I work\".',
      // Оформление ответа.
      //
      // Модель по умолчанию пишет сплошным текстом или, наоборот, вываливает
      // таблицу там, где хватило бы строки. И то и другое читать трудно:
      // ответ на «сколько записей» не должен требовать разглядывания.
      //
      // Таблицы теперь отображаются (подключён GFM), поэтому просить их можно —
      // но именно там, где есть что сравнивать по столбцам.
      'FORMATTING. Your reply is rendered as markdown: tables, lists, headings and code blocks all display properly. Use them, but only where they earn their place.',
      'Tables — for several items compared across the SAME fields (rows from a database, tasks with status and owner). Put the columns that answer the question first, and leave out the ones that do not. A table of one row is a sentence; write the sentence.',
      'Lists — for enumerations of three or more. Two things fit in a sentence.',
      'Bold — for the answer itself, not for decoration. If everything is bold, nothing is.',
      'Code style for identifiers, table and column names, ids, SQL and file paths: `users.email`, `TASK-42`.',
      'Blank line between paragraphs, table rows on their own lines — markdown needs real line breaks, and a table crammed onto one line renders as a row of pipes.',
      'Do not open with "Sure!" or restate the question. Lead with the answer, then the detail.',
      'Never dump a whole result set because it is available. Show what was asked, say how many there are in total, and offer the rest.',
      // Новые инструменты — иначе модель о них не знает и отвечает «у меня нет
      // доступа», хотя доступ есть.
      'DEPENDENCIES: get_blockers shows what holds the WHOLE project — which tasks block others and who owns them. get_task_blockers is the same for one task. link_tasks records that a task waits for others. Report chains, not totals: "TASK-82 blocks five screens, all waiting on Elisha" is actionable, "22 tasks are blocked" is not.',
      'DATABASE: the project may have a real database attached. list_databases shows which tables you may read; call it before querying. query_database runs a SELECT — read-only, the database itself rejects any change. This is a customer\'s production data: read what the question needs, and never paste personal data (names, emails, phones) into tasks or messages where it outlives the conversation.',
      images.length
        ? 'IMAGES: the user attached image(s) and asked you to look. Describe what is actually there — do not guess at what you cannot make out, say that part is unclear.'
        : visionOn
          ? 'IMAGES: if the user mentions a picture but you were given none, it is because they did not ask you to look at it. Say so and tell them to ask explicitly ("посмотри скрин", "look at this") — do not pretend you saw it.'
          : 'IMAGES: image recognition is TURNED OFF for this company, so you cannot see attachments at all. If the user shows you a picture, say plainly that you cannot see it and that an owner or admin can turn it on in Company settings → AI → "Image recognition". Do not guess at the contents, and do not pretend you looked.',
      // Файлы, показанные ассистенту, живут сутки и исчезают. Человек об этом
      // не знает — сказать должен ассистент, иначе он решит, что файл в проекте.
      'OLDER IMAGES: you are given images only from the last half hour. If the user refers to a picture you were not given — "the one I sent earlier", "that screenshot again" — call list_chat_images to see what is there, then view_image with the exact file name. Do not tell them the image is missing without looking first.',
      'ATTACHED FILES in this private chat are TEMPORARY: they are deleted within a day unless saved. When the user shows you something worth keeping, ask whether to save it into the project — keep_attached_file saves, discard_attached_file removes it now. Do not save on your own: most screenshots are shown once and never needed again.',
      'DOCUMENTS: read_document returns a CHUNK — it tells you the total length and the next offset. For long documents call it repeatedly with increasing offset until you have what you need. To add text use append_to_document (never resend a whole long document).',
      'You can edit any editable field of a task on request. When assigning, use the person the TEAM section says is responsible for that area (assign by name). Use list_sprints for valid names; create_sprint if a new one is needed.',
      'When CREATING a task, ALWAYS set estimateMinutes — your best estimate of how long it takes assuming the person works WITH an AI assistant (so estimates are realistic and usually shorter). If truly unsure, still give a rough estimate.',
      'Do NOT assume chat contents — read them with tools when needed.',
      'All actions are permission-checked per user — if a tool returns PERMISSION DENIED, politely explain the user lacks that permission.',
      'CONFIRMATION RULE: NEVER update or delete anything (tasks, resources, files, comments, sprints) without the user\'s EXPLICIT confirmation in this conversation. Creating a new item from a clear request is fine, but for any update_* / delete_* / change_task_status action first state exactly what you will change and ask the user to confirm; only proceed after they clearly say yes. If the user was already explicit ("delete TASK-5", "set status to done"), that counts as confirmation.',
      'RESOURCES: if the user shares a useful link or credentials/passwords/API keys, offer to save them with create_resource (secrets are encrypted and never readable back). Pass the source message id when it came from chat.',
      'TASK CONTEXT: when the user references a specific task and/or a file and writes a note or update, do NOT post it to the group chat. Instead offer TWO options: (a) create a new task, or (b) add a comment to the referenced task via add_task_comment (attaching the file with attach_file_to_task if one was mentioned). Ask which they prefer unless they were explicit.',
      'Be concise.',
    ]
      .filter(Boolean)
      .join('\n'),
    user: `${dialogText ? `OUR CONVERSATION SO FAR:\n${dialogText}\n\n` : ''}USER'S MESSAGE:\n${userMessage}`,
    tools,
    handlers,
    maxTokens: 1500,
  })
}

async function recentContext(projectId: string, excludeId: string, limit = 15): Promise<string> {
  const rows = await db
    .select({ msg: messages, author: users })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.authorId))
    .where(and(eq(messages.projectId, projectId), eq(messages.mode, 'group'), eq(messages.status, 'delivered')))
    .orderBy(desc(messages.createdAt))
    .limit(limit)
  return rows
    .reverse()
    .filter((r) => r.msg.id !== excludeId)
    .map((r) => `${r.author?.name ?? 'AI'}: ${r.msg.text}`)
    .join('\n')
}

function dispatcherSystem(project: { chatRules: string }, ai: AiConfig, authorName: string, lang: string): string {
  return [
    `You are the AI dispatcher of a team project chat. PROJECT LANGUAGE: ${lang} — the chat is conducted ONLY in it.`,
    `Author of the incoming message: ${authorName}.`,
    ai.mode === 'moderator'
      ? 'Mode: MODERATOR — hold messages that are unclear, off-topic, duplicate already-answered questions, or violate the rules.'
      : 'Mode: ASSISTANT — be permissive with content; hold ONLY messages that clearly violate the rules, are off-topic, or impossible to understand. When unsure, PASS.',
    `LANGUAGE RULE (always enforced): if the message is NOT in ${lang}, HOLD it and provide a faithful ${lang} translation as the suggestion (mark it good to send).`,
    project.chatRules ? `Chat rules set by the team: "${project.chatRules}"` : 'No special chat rules.',
    '',
    // Обращение к человеку, который читает на другом языке (SPEC §5.5).
    //
    // «Таль, как дела?» написано на языке проекта, правил не нарушает — и
    // уходило в чат как есть. Таль читает на иврите: сообщение адресовано ему,
    // но написано не для него, и упоминания нет — уведомление не придёт.
    //
    // Держим и предлагаем готовый вариант: на его языке, с @[Имя](id).
    // Переписывать за человека нельзя — он сам выберет, отправлять ли.
    'ADDRESSING A TEAMMATE. If the message is aimed at a specific person (starts with their name, asks them something, tells them to do something) and the TEAM list says they read another language — HOLD it.',
    'The suggestion is that same message written in THEIR language, opening with @[Name](id) taken from the TEAM list. Keep the meaning exactly; do not add politeness the author did not write. Mark it good to send.',
    'If they read the project language, a plain name is fine — but still HOLD when there is no @[Name](id) mention at all, and suggest the same text with the mention added, so they actually get notified.',
    // Поручение, брошенное в чат (SPEC §8.49 — тот же мотив, что у вопросов).
    //
    // «Артём, там надо проверить функцию» — это работа, а не разговор. В чате
    // она тонет: через день никто не помнит, договорились или нет.
    //
    // Предлагаем задачу, но НЕ создаём: в чате такое звучит постоянно, и
    // задача из каждой реплики завалила бы доску. Решает человек.
    'WORK ASSIGNED IN CHAT. If the message asks someone to do something — check, fix, add, look into, remind, prepare — it is work, and work said in chat gets lost. HOLD it, set "work":true, and say so briefly.',
    'Do NOT create anything: you are the dispatcher and you have no such power here. The author will decide in the private sandbox that opens next; your job is only to stop the message and name what you noticed.',
    'Say who the work seems to be for. Keep the suggestion as the chat message itself (with the mention), not as a task description.',
    'Judge ONLY the incoming message below — the recent chat is context, NOT the subject of evaluation.',
    'Decide: PASS (deliver to the group as-is) or HOLD (needs a private clarification with the author).',
    'Be sparing: HOLD only on the grounds listed above. Ordinary talk, answers, jokes, status updates and thanks all PASS. When unsure, PASS — a message stopped for nothing costs the author more than one that slipped through.',
    'Respond with ONLY JSON:',
    '{"verdict":"pass"} or {"verdict":"hold","reason":"<short reason in the AUTHOR\'S language>","questions":"<what to clarify, author\'s language>","suggestion":"<improved message in the PROJECT language, or empty>","work":<true only when the message asks someone to do something>}',
    'Keep reason/questions to 1-2 sentences. Suggestion must preserve the author\'s meaning.',
    'IMPORTANT: output valid JSON — escape any double quotes inside string values as \\".',
  ].join('\n')
}

export type Verdict =
  // unchecked=true означает «проверка НЕ отработала» (сбой LLM), а не «сообщение чистое»
  | { verdict: 'pass'; unchecked?: boolean }
  // work=true — «это поручение»: только тогда есть смысл звать модель за
  // карточкой задач. Иначе каждый придержанный пустяк стоил бы лишнего вызова.
  | { verdict: 'hold'; reason: string; questions?: string; suggestion?: string; work?: boolean }

/**
 * Оценка входящего группового сообщения.
 * Fail-open по решению продукта: сбой ИИ не должен блокировать общение команды.
 * Но такой пропуск помечается unchecked — тихая деградация недопустима.
 */
export async function evaluateMessage(messageId: string): Promise<Verdict> {
  const msg = await db.query.messages.findFirst({ where: eq(messages.id, messageId) })
  if (!msg) return { verdict: 'pass' }
  const project = await db.query.projects.findFirst({ where: eq(projects.id, msg.projectId) })
  if (!project) return { verdict: 'pass' }

  const ai = JSON.parse(project.aiConfig || '{}') as AiConfig
  // observer не фильтрует вовсе
  if ((ai.mode ?? 'assistant') === 'observer') return { verdict: 'pass' }

  const cfg = await projectLlm(msg.projectId, 'dispatcher')
  if (!cfg) return { verdict: 'pass' }

  const author = msg.authorId ? await db.query.users.findFirst({ where: eq(users.id, msg.authorId) }) : null
  // трёхслойная память (SPEC §5.6): оглавление саммари + последнее саммари + живой хвост
  const context = await buildMemoryContext(msg.projectId)
  // Язык проекта — с наследованием от компании, если у ИИ он не задан.
  const dispatcherLang = await aiLang(ai, msg.projectId)

  const raw = await complete(cfg, {
    system: dispatcherSystem(project, ai, author?.name ?? 'Unknown', dispatcherLang),
    user: `${context}\n\nINCOMING MESSAGE (judge only this):\n${msg.text}`,
    // Ответ содержит reason/questions/suggestion на языке автора. Кириллица и
    // иврит съедают в разы больше токенов, чем латиница, и при 500 JSON
    // обрывался на середине — вердикт hold терялся, сообщение уходило без
    // проверки. Ограничивает только ДЛИНУ ОТВЕТА (не контекст), а ответ здесь
    // короткий — 2000 хватает с большим запасом даже для длинных suggestion.
    maxTokens: 2000,
  })

  // Сбой LLM (нет ответа) — это НЕ «сообщение чистое». Чат не блокируем, но
  // помечаем сообщение как непроверенное, иначе тихая деградация выглядит
  // как работающая модерация: правила нарушаются, а никто не знает почему.
  if (raw === null) {
    console.error(`[dispatcher] LLM unavailable for project ${msg.projectId} — message passed UNCHECKED`)
    return { verdict: 'pass', unchecked: true }
  }

  const parsed = parseJson<Verdict>(raw)
  if (!parsed || (parsed.verdict !== 'pass' && parsed.verdict !== 'hold')) {
    // Ответ мог оборваться по лимиту токенов на середине строки. Вердикт и
    // причина обычно уже пришли — вытаскиваем их, вместо того чтобы пропускать
    // нарушение только потому, что не закрылась кавычка.
    if (raw && /"verdict"\s*:\s*"hold"/.test(raw)) {
      const reason = raw.match(/"reason"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1]
      const questions = raw.match(/"questions"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1]
      const unescape = (s?: string) => s?.replace(/\\"/g, '"').replace(/\\n/g, '\n')
      return {
        verdict: 'hold',
        reason:
          unescape(reason) ??
          'The AI flagged this message but the details were lost. Please rephrase or ask the AI below.',
        ...(questions ? { questions: unescape(questions) } : {}),
        // work стоит в JSON последним и при обрыве теряется первым — а без него
        // поручение открывает sandbox без карточки задач, ради которой его и
        // придержали.
        ...(/"work"\s*:\s*true/.test(raw) ? { work: true } : {}),
      }
    }
    // так же вытаскиваем усечённый pass, чтобы не помечать его «без проверки»
    if (raw && /"verdict"\s*:\s*"pass"/.test(raw)) return { verdict: 'pass' }

    console.error(
      `[dispatcher] unparseable verdict for project ${msg.projectId} — message passed UNCHECKED. Raw: ${String(raw).slice(0, 300)}`,
    )
    return { verdict: 'pass', unchecked: true }
  }
  return parsed
}

/**
 * Ответ ИИ в sandbox-диалоге: помогает довести сообщение, предлагает варианты.
 * onChunk — стриминг «text»-части ответа для постепенной печати (SPEC: streaming).
 */
/** Задача, предложенная к созданию. Поля — минимум, остальное человек допишет в трекере. */
export type ProposedTask = {
  title: string
  description?: string
  /** Имя из ростера команды; сопоставляется при исполнении, здесь ещё не id. */
  assignee?: string
  estimateMinutes?: number
}

export async function sandboxReply(
  messageId: string,
  onChunk?: (delta: string) => void,
): Promise<{
  text: string
  suggestion: string | null
  approved: boolean
  /** Непусто — ИИ предлагает завести задачи вместо реплики в чат. */
  tasks: ProposedTask[]
} | null> {
  const msg = await db.query.messages.findFirst({ where: eq(messages.id, messageId) })
  if (!msg) return null
  const project = await db.query.projects.findFirst({ where: eq(projects.id, msg.projectId) })
  if (!project) return null
  const cfg = await projectLlm(msg.projectId, 'dispatcher')
  if (!cfg) return null

  const ai = JSON.parse(project.aiConfig || '{}') as AiConfig
  const lang = await aiLang(ai, msg.projectId)
  const history = await db.query.sandboxMessages.findMany({
    where: eq(sandboxMessages.messageId, messageId),
    orderBy: (t, { asc }) => [asc(t.createdAt)],
  })
  const context = await recentContext(msg.projectId, msg.id, 10)
  // Кто в команде, на каком языке читает и какой у него id — тем же составом,
  // что видел диспетчер. Без этого предложить «на иврите и с упоминанием» здесь
  // невозможно: имена из сообщения не с чем сопоставить.
  const team = await buildTeamContext(msg.projectId)

  // формат под стриминг: свободный ответ (стримится) → маркеры с вариантом
  const system = [
    `You help an author finalize a held chat message. Project language: ${lang}.`,
    project.chatRules ? `Chat rules: "${project.chatRules}"` : '',
    team,
    'Talk to the author in THEIR language. Be brief and practical.',
    'When the message is aimed at a teammate, the version you suggest must open with @[Name](id) from the TEAM list — that mention is what notifies them — and be written in the language that person reads.',
    'Format your response EXACTLY like this:',
    '<your reply to the author>',
    'Then, if you have a message version ready for the group chat (project language, rules respected), add:',
    '---SUGGESTION---',
    '<the message version>',
    '---APPROVED--- (add this line ONLY if the version is good to send as-is)',
    // Задача вместо реплики (SPEC §8.49).
    //
    // «Артём, надо проверить функцию» — это работа. Сказанная в чат, она живёт
    // до следующего экрана прокрутки; заведённая — до того, как её сделают.
    //
    // Только ПРЕДЛАГАЕМ: создаст сервер, когда человек нажмёт кнопку. Модель
    // здесь не исполняет ничего — иначе созданное определялось бы тем, как она
    // поняла разговор, а не тем, что человек увидел в карточке.
    'If the held message is work asked of someone, ALSO offer to turn it into tasks. Add:',
    '---TASKS---',
    '[{"title":"...","description":"...","assignee":"<name from TEAM>","estimateMinutes":60}]',
    `Rules for that JSON: a plain array, nothing after it. Titles and descriptions in ${lang} (the project language) — they live in the tracker, not in this conversation.`,
    'Split into SEVERAL tasks only when the message really asks for separate pieces of work that could be done by different people or finished at different times. One request is one task — splitting it to look thorough gives the team a board full of fragments.',
    'estimateMinutes is your honest guess assuming the person works with an AI assistant. Omit assignee only when nobody in TEAM obviously fits.',
    'Offer tasks ONCE, in the reply where you first notice the work. If the author already declined them, or the conversation has moved on to wording the message, do not add the block again.',
    'Do not repeat the task list in your text reply — the author sees it as a card with buttons. Just say briefly that you can create it.',
  ]
    .filter(Boolean)
    .join('\n')
  const user = [
    `Group chat context:\n${context || '(empty)'}`,
    `Original held message:\n${msg.text}`,
    `Sandbox conversation so far:`,
    ...history.map((h) => `${h.role === 'user' ? 'Author' : 'You'}: ${h.text}`),
  ].join('\n\n')

  let streamedPastMarker = false
  let buffer = ''
  const raw = await completeStream(
    cfg,
    // ответ ищется по маркеру ---SUGGESTION---: обрыв до него теряет всё,
            // а не просто укорачивает
            { system, user, maxTokens: 2500 },
    (delta) => {
      if (streamedPastMarker || !onChunk) return
      buffer += delta
      // Стримится только реплика автору. Обрываем на ЛЮБОМ маркере: карточка
      // задач — это JSON, и печатать его человеку незачем.
      const idx =
        [buffer.indexOf('---SUGGESTION---'), buffer.indexOf('---TASKS---')].filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? -1
      if (idx >= 0) {
        streamedPastMarker = true
        const before = buffer.slice(0, idx)
        // дослать хвост до маркера (сколько ещё не ушло)
        const sentLen = buffer.length - delta.length
        if (before.length > sentLen) onChunk(before.slice(sentLen))
      } else {
        onChunk(delta)
      }
    },
  )
  if (!raw) return null

  // Маркеры могут прийти в любом порядке: сначала отделяем задачи, потом вариант.
  const [beforeTasks, tasksPart] = raw.split('---TASKS---')
  const [textPart, rest] = (beforeTasks ?? '').split('---SUGGESTION---')
  const approved = rest?.includes('---APPROVED---') ?? false
  const suggestion = rest?.replace('---APPROVED---', '').trim() || null

  // Задачи могли уехать ПЕРЕД ---SUGGESTION--- — тогда вариант лежит в их хвосте.
  let tasksRaw = tasksPart ?? null
  let suggestionOut = suggestion
  let approvedOut = approved
  if (tasksRaw?.includes('---SUGGESTION---')) {
    const [json, tail] = tasksRaw.split('---SUGGESTION---')
    tasksRaw = json ?? null
    const tailApproved = tail?.includes('---APPROVED---') ?? false
    const tailSuggestion = tail?.replace('---APPROVED---', '').trim() || null
    if (tailSuggestion) {
      suggestionOut = tailSuggestion
      approvedOut = tailApproved
    }
  }

  return {
    text: (textPart ?? '').trim(),
    suggestion: suggestionOut,
    approved: Boolean(approvedOut && suggestionOut),
    tasks: parseProposedTasks(tasksRaw),
  }
}

/**
 * Задачи из хвоста ответа. Кривой JSON — не повод терять всю реплику:
 * вернём пустой список, разговор останется, карточки просто не будет.
 */
export function parseProposedTasks(raw: string | null): ProposedTask[] {
  if (!raw?.trim()) return []
  const parsed = parseJson<unknown>(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''))
  if (!Array.isArray(parsed)) {
    if (raw.trim()) console.error('[sandbox] unreadable TASKS block:', raw.slice(0, 200))
    return []
  }
  return parsed
    .filter((t): t is Record<string, unknown> => Boolean(t) && typeof t === 'object')
    .map((t) => ({
      title: String(t.title ?? '').trim().slice(0, 300),
      description: typeof t.description === 'string' ? t.description.slice(0, 10_000) : undefined,
      assignee: typeof t.assignee === 'string' && t.assignee.trim() ? t.assignee.trim() : undefined,
      estimateMinutes:
        typeof t.estimateMinutes === 'number' && Number.isFinite(t.estimateMinutes) && t.estimateMinutes > 0
          ? Math.round(t.estimateMinutes)
          : undefined,
    }))
    .filter((t) => t.title)
    // Больше семи — это уже не разбиение, а измельчение: карточку такой длины
    // не читают, а принимают целиком, не глядя.
    .slice(0, 7)
}
