import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Версию можно поправить, а не заводить вторую.
 *
 * Разбор живого случая (WhatIDog, 1.0.5): вебхук EAS не дошёл, ссылки на
 * сборке не оказалось — и поставить её было НЕГДЕ. Ни в мосту (там был только
 * POST и смена стадии), ни в интерфейсе (поле buildPageUrl отдавалось наружу,
 * но принять его не умела ни одна схема).
 *
 * Обходом заводили вторую версию поверх первой. Цена видна в данных: вебхук
 * потом пишет в ОДНУ из двух строк, вторая остаётся мёртвой — «в Expo зелёная
 * галочка, а у нас непонятно что».
 */

const read = (p: string) => readFileSync(join(import.meta.dirname, p), 'utf8').replace(/\r\n/g, '\n')
const bridge = read('./bridge.ts')
const web = read('./releases.ts')

describe('ссылку можно поставить руками, когда вебхук не дошёл', () => {
  it('у моста есть правка версии', () => {
    // Саботаж: убрать ручку — вернётся обход через вторую версию.
    expect(bridge, 'PATCH версии в мосту не найден').toMatch(/bridgeRoute\.patch\('\/releases\/:id'/)
  })

  it('обе ссылки принимаются: и артефакт, и страница сборки', () => {
    // buildPageUrl отдавался наружу с самого начала, но задать его было
    // нельзя — ровно то поле, которое ставит вебхук.
    const at = bridge.indexOf("bridgeRoute.patch('/releases/:id'")
    const fn = bridge.slice(at, bridge.indexOf('\n})', at))
    expect(fn, 'страницу сборки задать нельзя').toMatch(/patch\.buildPageUrl/)
    expect(fn, 'ссылку на артефакт задать нельзя').toMatch(/patch\.referenceUrl/)

    for (const field of ['buildPageUrl', 'referenceUrl']) {
      expect(web, `веб-API не принимает ${field}`).toMatch(new RegExp(`${field}: z\\.string\\(\\)`))
    }
  })

  it('стадия через правку не двигается', () => {
    // У неё своя ручка, требующая комментарий. Пустив статус сюда, мы обошли
    // бы это правило — история переходов перестала бы объяснять, почему
    // версию двигали.
    //
    // Саботаж: добавить 'status' в список полей — правка станет тихим
    // способом переставить стадию без объяснения.
    const at = bridge.indexOf('const RELEASE_PATCH_FIELDS')
    expect(at, 'список полей правки не найден').toBeGreaterThan(-1)
    const line = bridge.slice(at, bridge.indexOf('\n', at))
    expect(line, 'стадию можно двигать в обход комментария').not.toMatch(/'status'/)
  })
})

describe('имя приложения не теряется', () => {
  it('мост записывает appName при создании версии', () => {
    // Поле принимали (оно в RELEASE_FIELDS), но в базу НЕ писали — оттого у
    // всех версий, заведённых через мост, app_name пуст. Проверено на живых
    // данных: десять версий WhatIDog, у всех null.
    //
    // Это не косметика: по appName вебхук отличает сборки двух приложений
    // одного проекта. Без него они неразличимы.
    //
    // Саботаж: убрать строку — имя снова начнёт молча пропадать.
    const at = bridge.indexOf("bridgeRoute.post('/releases'")
    expect(at, 'создание версии не найдено').toBeGreaterThan(-1)
    const fn = bridge.slice(at, bridge.indexOf('\n})', at))
    expect(fn, 'appName принимается, но не сохраняется').toMatch(/appName: typeof b\.appName === 'string'/)
  })
})
