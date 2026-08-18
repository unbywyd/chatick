import { eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { feedback, platformSettings, users } from '../db/schema.js'
import { sendFeedbackMail } from './mails.js'

/**
 * Репорты от ассистента: чего не хватило, что сломалось, о чём попросил человек.
 *
 * Смысл в том, что ассистент упирается в границы API там, где человек их даже
 * не замечает: он пробует сделать то, о чём попросили, получает 404 на
 * несуществующую ручку — и на этом всё заканчивается молча. Такие тупики
 * нигде не всплывают, потому что человек видит лишь «не получилось».
 *
 * Пишем в ту же таблицу, что и форму «Связаться с нами»: это тот же поток
 * входящего, и разводить два списка значило бы читать два места. Отличает их
 * поле source — репорты ассистента читают иначе, он пишет чаще и с другой
 * стороны.
 */

export const REPORT_KINDS = ['missing', 'bug', 'request', 'docs'] as const
export type ReportKind = (typeof REPORT_KINDS)[number]

/** Вид репорта → тема обращения. Тем меньше, чем видов: они и так про разное. */
const TOPIC_OF: Record<ReportKind, 'bug' | 'feature' | 'other'> = {
  missing: 'feature', // не хватило ручки или поля
  bug: 'bug', // повело себя не так, как описано
  request: 'feature', // человек попросил то, чего нет
  docs: 'other', // инструкция врёт или непонятна
}

/**
 * Вид репорта словами — для письма.
 *
 * Тема письма показывает тему обращения (bug/feature/other), и видов в неё не
 * помещается: docs и missing оба приходили как «Other» и «Feature request».
 * Отличить «инструкция врёт» от «человек попросил фичу» можно было, только
 * прочитав текст целиком.
 */
const KIND_LABEL: Record<ReportKind, string> = {
  request: 'человек попросил то, чего нет',
  bug: 'повело себя не так, как описано',
  missing: 'не хватило ручки или поля',
  docs: 'инструкция врёт или непонятна',
}

/** Сколько репортов с одного туннеля в час. */
const HOURLY_LIMIT = 5

async function adminList(): Promise<string[]> {
  const rows = await db
    .select({ key: platformSettings.key, value: platformSettings.value })
    .from(platformSettings)
    .where(eq(platformSettings.key, 'feedback.admins'))
  return (rows[0]?.value ?? '')
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)
}

export type ReportInput = {
  kind: ReportKind
  /** Что произошло — своими словами, без выдумки. */
  body: string
  /** Что пытались сделать: без этого «не хватает ручки» нечем воспроизвести. */
  context?: string
  /** Кто работал: репорт подписывается им, отвечать тоже ему. */
  user: { id: string; name: string; email: string }
  /** Проект, если он был выбран — помогает понять, о чём речь. */
  projectId?: string | null
  clientName?: string
}

export type ReportResult =
  | { ok: true; id: string }
  | { ok: false; error: string; status: 400 | 429 }

/**
 * Принять репорт.
 *
 * Ограничение частоты считается по человеку, а не по IP: ассистент ходит с
 * сервера, и по адресу все туннели слились бы в один. Пять в час — потолок,
 * за которым это уже не наблюдение, а поток.
 */
export async function submitAssistantReport(input: ReportInput): Promise<ReportResult> {
  const body = input.body.trim()
  // Нижняя граница выше, чем у формы: «не работает» от ассистента бесполезнее,
  // чем от человека — переспросить его потом будет некому.
  if (body.length < 30) {
    return { ok: false, error: 'Describe what happened in at least a sentence or two', status: 400 }
  }
  if (body.length > 5000) return { ok: false, error: 'Report is too long', status: 400 }

  const [{ recent }] = (await db
    .select({ recent: sql<number>`count(*)::int` })
    .from(feedback)
    .where(
      sql`${feedback.userId} = ${input.user.id} and ${feedback.source} = 'assistant' and ${feedback.createdAt} > now() - interval '1 hour'`,
    )) as [{ recent: number }]
  if (recent >= HOURLY_LIMIT) {
    return { ok: false, error: 'Too many reports in the last hour — send the rest later', status: 429 }
  }

  const topic = TOPIC_OF[input.kind]
  const [row] = await db
    .insert(feedback)
    .values({
      topic,
      source: 'assistant',
      body,
      email: input.user.email,
      name: input.user.name,
      userId: input.user.id,
      meta: JSON.stringify({
        kind: input.kind,
        context: input.context?.slice(0, 2000) ?? '',
        projectId: input.projectId ?? '',
        client: input.clientName ?? '',
      }),
    })
    .returning()

  void notify(row!.id, topic, body, input)
  return { ok: true, id: row!.id }
}

/** Письмо тем же адресатам, что и обычные обращения. */
async function notify(id: string, topic: 'bug' | 'feature' | 'other', body: string, input: ReportInput) {
  const list = await adminList()
  if (!list.length) return

  const admins = await db.query.users.findMany({ where: inArray(users.email, list) })
  const localeOf = (mail: string) => admins.find((a) => a.email === mail)?.locale ?? null

  // В теле письма — и то, что пытались сделать: без этого репорт «не хватает
  // ручки» приходится разбирать переспросами, а спросить уже не у кого.
  // Вид репорта — первой строкой письма.
  //
  // Тема письма показывает ТЕМУ обращения (bug/feature/other), а видов
  // четыре: docs и missing оба приходили как «Other» и «Feature request», и
  // отличить «инструкция врёт» от «человек попросил фичу» можно было только
  // прочитав текст целиком. В базе kind лежит, в письме его не было.
  const head = `${input.kind} — ${KIND_LABEL[input.kind]}`
  const text = input.context?.trim()
    ? `${head}\n\n${body}\n\n— что пытались сделать —\n${input.context.trim()}`
    : `${head}\n\n${body}`

  for (const to of list) {
    void sendFeedbackMail({
      to,
      locale: localeOf(to),
      id,
      topic,
      body: text,
      name: `${input.user.name} (через ассистента${input.clientName ? `: ${input.clientName}` : ''})`,
      email: input.user.email,
      registered: true,
      hasScreenshot: false,
    })
  }
}
