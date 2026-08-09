import { api, ApiError } from './api'

// Проектный токен.
//
// Ручки внутри проекта (в том числе трекер) требуют отдельный токен: сессионный
// они не принимают. Он выдаётся обменом на `/projects/:id/enter` и живёт 30
// дней, поэтому держим полученные в памяти — иначе каждый пуск таймера стоил
// бы лишнего запроса.
//
// Кэш живёт до перезапуска приложения намеренно: исключённому из проекта
// сервер всё равно откажет (requireProject проверяет членство в базе на каждом
// запросе), а сокращать срок здесь значит просто чаще ходить за тем же.

const cache = new Map<string, string>()

/** Правила чата не приняты — их надо показать до входа (SPEC §4.2). */
export class RulesRequired extends Error {
  constructor(
    public projectName: string,
    public chatRules: string,
  ) {
    super('rules required')
  }
}

export async function projectToken(projectId: string, acceptRules = false): Promise<string> {
  const hit = cache.get(projectId)
  if (hit && !acceptRules) return hit

  try {
    const res = await api<{ token: string }>(`/api/v1/projects/${encodeURIComponent(projectId)}/enter`, {
      method: 'POST',
      body: JSON.stringify({ acceptRules }),
    })
    cache.set(projectId, res.token)
    return res.token
  } catch (e) {
    // 428 — не ошибка связи, а требование показать правила чата. Их текст
    // лежит в теле ответа: без него экран правил показать нечего.
    if (e instanceof ApiError && e.status === 428) {
      throw new RulesRequired(
        (e.body.projectName as string) ?? '',
        (e.body.chatRules as string) ?? '',
      )
    }
    throw e
  }
}

export function forgetProjectToken(projectId: string): void {
  cache.delete(projectId)
}
