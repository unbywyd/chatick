import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Сводка молчит для тех, кто не заходит; себя в компанию не приглашают.
 */

const CRLF = new RegExp(String.fromCharCode(13) + String.fromCharCode(10), 'g')
const LF = String.fromCharCode(10)
const read = (p: string) => readFileSync(join(import.meta.dirname, p), 'utf8').replace(CRLF, LF)

const digest = read('digest.ts')
const companies = read('../routes/companies.ts')
const team = read('../../../app/src/components/company/TeamTab.tsx')
const loc = (l: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, `../../../app/src/i18n/locales/${l}.json`), 'utf8'))

describe('сводка не преследует того, кто не заходит', () => {
  it('есть порог бездействия', () => {
    // На проде нашёлся адрес, получавший письмо про ОДНО непрочитанное больше
    // месяца подряд: последний заход 21 августа. Это то, на что жмут «спам».
    //
    // Саботаж: убрать проверку — тест падает.
    expect(digest, 'порога бездействия нет').toContain('DIGEST_INACTIVE_MS')
    expect(digest, 'порог не применяется').toContain('if (idleMs > DIGEST_INACTIVE_MS)')
  })

  it('порог — неделя, а не двое суток', () => {
    // Двое суток заткнули бы ПЯТЕРЫХ из шести получателей, включая тех, кто
    // работает каждую неделю: люди работают рывками, и одни выходные уже
    // перекрывают 48 часов. Проверено на живых данных.
    //
    // Саботаж: вернуть 48 часов — тест падает.
    expect(digest, 'порог не недельный').toContain('DIGEST_INACTIVE_MS = 7 * 24 * 60 * 60 * 1000')
  })

  it('активность считается по всем следам, включая мост', () => {
    // Отдельного «последнего визита» в базе нет. Команда работает через
    // ассистента: руками в интерфейс заходят реже, чем ассистент ходит в API
    // от их имени, — без моста активные выглядели бы заброшенными.
    //
    // Саботаж: убрать bridge_sessions — тест падает.
    const at = digest.indexOf('async function lastActivityAt')
    const body = digest.slice(at, digest.indexOf('export async function sendDailyDigests', at))
    for (const src of ['last_seen_group_at', 'read_at', 'activity_log', 'time_entries', 'bridge_sessions']) {
      expect(body, `след ${src} не учтён`).toContain(src)
    }
  })

  it('«ни разу не заходил» тоже молчит', () => {
    // Зарегистрировался и не сделал ничего — такому тем более не пишем.
    expect(digest, 'отсутствие следов не обрабатывается').toContain('seenAt ? Date.now() - seenAt.getTime() : Infinity')
  })

  it('запрос активности один, а не четыре', () => {
    // Дайджест идёт по всем получателям: лишние обращения множатся на их число.
    const at = digest.indexOf('async function lastActivityAt')
    const body = digest.slice(at, digest.indexOf('export async function sendDailyDigests', at))
    expect((body.match(/db\.execute/g) ?? []).length, 'активность берётся несколькими запросами').toBe(1)
  })

  it('письма по событию порог не затрагивает', () => {
    // Приглашение, код входа, отчёт — человек ждёт их прямо сейчас. Молчание
    // там означало бы, что он не может войти.
    //
    // Саботаж: позвать lastActivityAt из mails.ts — тест падает.
    const mails = read('mails.ts')
    expect(mails, 'порог бездействия просочился в письма по событию').not.toContain('DIGEST_INACTIVE_MS')
    expect(mails, 'порог бездействия просочился в письма по событию').not.toContain('lastActivityAt')
  })
})

describe('себя и своих в компанию не приглашают', () => {
  it('сервер отказывает на собственный адрес', () => {
    // Письмо уходило, ссылка вела на «принять приглашение», принимать было
    // нечего. На живых данных такое нашлось.
    //
    // Саботаж: убрать проверку — тест падает.
    expect(companies, 'себя пригласить всё ещё можно').toContain("error: 'You are already in this company'")
  })

  it('сервер отказывает на того, кто уже в компании', () => {
    expect(companies, 'повторное приглашение участника разрешено').toContain("error: 'This person is already in the company'")
  })

  it('клиент предупреждает до нажатия', () => {
    // Сервер тоже отказывает — правило должно жить там, где его не обойти, —
    // но человек к моменту отказа уже нажал и ждал ответа.
    //
    // Саботаж: убрать inviteProblem — тест падает.
    expect(team, 'клиент не проверяет заранее').toContain('const inviteProblem')
    expect(team, 'отправка идёт при известной ошибке').toContain('if (email.trim() && !inviteProblem) invite.mutate()')
  })

  it('кнопка гаснет вместе с объяснением, а не молча', () => {
    // Неактивная кнопка без надписи — это «не работает», а не «нельзя».
    expect(team, 'кнопка не блокируется').toContain('Boolean(inviteProblem)')
    expect(team, 'причина не показана').toContain('{inviteProblem && <p')
  })

  it('переведено на три языка', () => {
    for (const l of ['en', 'ru', 'he']) {
      for (const k of ['inviteSelf', 'inviteAlreadyMember']) {
        expect(loc(l).team?.[k], `${l}: нет ключа team.${k}`).toBeTruthy()
      }
    }
  })
})
