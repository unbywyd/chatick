/**
 * Единственное место, которое знает адреса моста.
 *
 * Инструменты не пишут URL руками и не собирают строки запроса: они называют
 * ручку, а путь берётся отсюда. Это ответ на вопрос «как не разъехаться с
 * мостом»: разъехаться можно только здесь, в одном файле на двадцать строк,
 * и сверка при сборке ловит расхождение (scripts/check-bridge-guide.mjs).
 *
 * За сессию гайд отставал от кода дважды — оба раза молча, потому что копий
 * правды было две. Третья копия в MCP повторила бы это, да ещё и на чужой
 * машине, где никто не заметит.
 */

const BASE = process.env.CHATICK_API ?? 'https://api.chatick.com'

export class BridgeError extends Error {
  constructor(
    public status: number,
    message: string,
    public hint?: string,
  ) {
    super(message)
  }
}

/**
 * Что открыл человек.
 *
 * `kind` — не украшение для текста, а разные способы работать: при 'project'
 * проект уже выбран, при 'company' его дописывают из компании, при 'all' его
 * надо спросить у человека или взять из /x/projects. Без этого признака
 * мастер-туннель неотличим от компанейского — оба приходят без projectId.
 */
export type Scope = { token: string; projectId?: string | null; kind?: 'project' | 'company' | 'all' }

/**
 * Вызов ручки моста.
 *
 * `?project=` дописывается сам, когда токен компанейский: забыть его — самый
 * частый способ получить отказ, и человек в этой ошибке не виноват.
 */
export async function call<T = unknown>(
  scope: Scope,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  query?: Record<string, string | number | undefined>,
): Promise<T> {
  const url = new URL(`${BASE}/x${path}`)
  if (scope.projectId) url.searchParams.set('project', scope.projectId)
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v))
  }

  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${scope.token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    // JSON.stringify экранирует сам: обратный слэш в ивритском тексте больше
    // не ломает тело запроса, как это было при ручной сборке строки.
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  const text = await res.text()
  /**
   * Разбираем по тому, что пришло, а не вслепую.
   *
   * GET /guide отдаёт markdown, и слепой JSON.parse ронял вызов с
   * «Unexpected token '#'». Инструкция была недостижима через инструмент,
   * который сам же велит прочитать её первым делом.
   */
  const ct = res.headers.get('content-type') ?? ''
  const looksJson = ct.includes('json') || /^\s*[[{]/.test(text)
  const data: Record<string, unknown> = text && looksJson ? (JSON.parse(text) as Record<string, unknown>) : text ? { text } : {}

  if (!res.ok) {
    throw new BridgeError(
      res.status,
      (data.error as string) ?? `HTTP ${res.status}`,
      data.hint as string | undefined,
    )
  }
  return data as T
}

/** Сколько осталось туннелю — по этому числу решают, браться ли за длинное. */
export async function tunnelLeft(scope: Scope): Promise<number | null> {
  const res = await fetch(`${BASE}/x/projects`, { headers: { authorization: `Bearer ${scope.token}` } })
  const left = res.headers.get('x-tunnel-expires-in')
  return left ? Number(left) : null
}

export const apiBase = () => BASE
