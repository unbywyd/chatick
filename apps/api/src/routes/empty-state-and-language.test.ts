import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Пустая доска задач и язык проекта.
 *
 * Оба про одно: правило, записанное словами там, где его могут не прочитать,
 * правилом не является.
 */

const CRLF = new RegExp(String.fromCharCode(13) + String.fromCharCode(10), 'g')
const LF = String.fromCharCode(10)
const app = (p: string) =>
  readFileSync(join(import.meta.dirname, '../../../app/src/', p), 'utf8').replace(CRLF, LF)
const bridge = readFileSync(join(import.meta.dirname, 'bridge.ts'), 'utf8').replace(CRLF, LF)
const empty = app('components/tabs/tasks/TasksEmptyState.tsx')
const tab = app('components/tabs/TasksTab.tsx')
const loc = (l: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, `../../../app/src/i18n/locales/${l}.json`), 'utf8'))

describe('пустая доска объясняет, что делать', () => {
  it('показывается только на пустом проекте без фильтров', () => {
    // Под фильтром пусто — другой разговор: там нужен сброс, а не рассказ
    // о подключении ассистента.
    //
    // Саботаж: убрать !hasFilters — тест падает.
    expect(tab, 'плашка не привязана к пустому списку').toContain("(tasksQ.data ?? []).length === 0 && !hasFilters")
  })

  it('на пустом проекте не рисуем пустые колонки под плашкой', () => {
    // Иначе под объяснением висят «Здесь пусто» ×5 — ровно то, что заменяли.
    expect(tab, 'список рисуется на пустом проекте').toContain("{view === 'list' && (tasksQ.data ?? []).length > 0 &&")
    expect(tab, 'таблица рисуется на пустом проекте').toContain("{view === 'table' && (tasksQ.data ?? []).length > 0 &&")
  })

  it('предлагает оба пути, а не только ручной', () => {
    // Создать руками умеет любой трекер. Подключить своего ассистента — то,
    // ради чего Chatick и сделан, и об этом на пустом экране не было сказано
    // ничего.
    expect(empty, 'нет ручного создания').toContain('tasks.emptyManualTitle')
    expect(empty, 'нет пути через ассистента').toContain('tasks.emptyAiTitle')
  })

  it('строка для ассистента берётся из того же места, что на «Подключении»', () => {
    // Два источника одной строки однажды разойдутся, и человек скопирует
    // адрес, по которому никто не отвечает.
    //
    // Саботаж: захардкодить адрес — тест падает.
    expect(empty, 'префикс взят не из общего перевода').toContain("t('connect.pastePrefix')")
    expect(empty, 'адрес моста не из API_URL').toContain('API_URL.replace(')
    expect(empty, 'адрес захардкожен').not.toContain('https://api.chatick.com')
  })

  it('строку дают копировать, а не открывать ссылкой', () => {
    // Её вставляют в чужое окно (Claude Code, ChatGPT), а не в браузер.
    expect(empty, 'нет копирования').toContain('navigator.clipboard.writeText(inviteLine)')
  })

  it('переведена на три языка', () => {
    for (const l of ['en', 'ru', 'he']) {
      const t = loc(l).tasks
      for (const k of ['emptyTitle', 'emptyLead', 'emptyManualTitle', 'emptyManualHint', 'emptyAiTitle', 'emptyAiHint', 'emptyAiCopy']) {
        expect(t?.[k], `${l}: нет ключа tasks.${k}`).toBeTruthy()
      }
    }
  })
})

describe('язык проекта проверяется в ответе, а не только в гайде', () => {
  it('создание задачи возвращает замечание о языке', () => {
    // Правило «пиши на языке проекта» записано в гайде дважды и в описании
    // инструмента ещё раз — и всё равно нарушается: в ивритском проекте
    // лежит 15 задач по-русски из 112. Описание модель может не прочитать,
    // а ответ на свой же вызов читает всегда.
    //
    // Саботаж: убрать warning из ответа — тест падает.
    expect(bridge, 'нет определения письменности').toContain('function scriptOf(')
    expect(bridge, 'нет замечания о языке').toContain('function languageNotice(')
    expect(bridge, 'замечание не попадает в ответ').toContain('...(langNotice ? { warning: langNotice } : {})')
  })

  it('это замечание, а не отказ', () => {
    // Письменность не даёт уверенности, которой хватило бы, чтобы
    // заблокировать работу: цитата, имя собственное, кусок кода — законные
    // поводы написать иначе. Отказ здесь стоил бы дороже ошибки.
    //
    // Саботаж: сделать 400 при несовпадении языка — тест падает.
    const at = bridge.indexOf('function languageNotice(')
    const body = bridge.slice(at, bridge.indexOf('const taskView', at))
    expect(body, 'несовпадение языка блокирует создание').not.toContain('c.json')
    expect(body, 'замечание не возвращается строкой').toContain('return `Project language is')
  })

  it('латиница не вызывает ложных замечаний', () => {
    // Под латиницей десятки языков: отличить английский от испанского по
    // буквам нельзя, а ошибочное замечание хуже молчания.
    //
    // Саботаж: начать判判 латиницу — тест падает.
    const at = bridge.indexOf('function scriptOf(')
    const body = bridge.slice(at, bridge.indexOf('function languageNotice', at))
    expect(body, 'латиница попала в определение').not.toContain('a-zA-Z')
    expect(body, 'порог считается не среди нелатинских').toContain('top / nonLatin')
  })
})
