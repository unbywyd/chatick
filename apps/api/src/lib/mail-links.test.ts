import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { projectPath, projectUrl } from './links.js'

// Ссылки на проект в письмах и наружу.
//
// Адрес проекта включает компанию: /c/<company>/p/<project> (SPEC §8.45).
// Маршрута /p/<id> во фронте нет — роутер не находит путь и не рисует НИЧЕГО.
// Человек, пришедший по такой ссылке из письма, видит белый экран и решает,
// что сломался продукт.
//
// Ошибка тихая: письмо уходит, доставляется, выглядит правильно, и узнать о
// ней можно только от получателя. Поэтому проверяем не поведение, а исходники —
// формат ссылки должен собираться общей функцией, а не руками по месту.

const read = (p: string) => readFileSync(join(import.meta.dirname, p), 'utf8')

describe('сборка адреса проекта', () => {
  it('включает компанию', () => {
    expect(projectPath('c1', 'p1')).toBe('/c/c1/p/p1')
    expect(projectPath('c1', 'p1', '/tasks')).toBe('/c/c1/p/p1/tasks')
  })

  it('полный адрес — с хэшем: роутер во фронте хэшевый', () => {
    expect(projectUrl('https://app.chatick.com', 'c1', 'p1')).toBe('https://app.chatick.com/#/c/c1/p/p1')
  })

  it('не удваивает слэш, когда хвост уже с ним', () => {
    expect(projectPath('c1', 'p1', '/tasks')).toBe(projectPath('c1', 'p1', 'tasks'))
  })

  it('query-хвост цепляется без слэша', () => {
    expect(projectPath('c1', 'p1', '?msg=m1')).toBe('/c/c1/p/p1?msg=m1')
  })
})

describe('никто не собирает адрес проекта руками', () => {
  // Каждый файл, который когда-либо строил ссылку на проект. Регексп ищет
  // именно старый формат `/p/<что-то>` там, где перед ним нет `/c/<company>`.
  const FILES = [
    'mails.ts',
    'mail-added.ts',
    'reminders.ts',
    '../routes/bridge.ts',
    '../routes/ext.ts',
    '../db/seed-inbox.ts',
    '../db/seed-notifications.ts',
  ]

  for (const f of FILES) {
    it(`${f} — без /p/<id> в обход projectPath`, () => {
      // Комментарии выкидываем: в них старый формат упоминается нарочно —
      // объяснить, что было сломано. Ищем именно код.
      const src = read(f)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
      // строки и шаблоны вида `/p/${...}` или '/p/<id>' — то, чем ссылка
      // собиралась до появления компании в адресе
      const bad = src.match(/["'`]\/p\/\$?\{?/g)
      expect(bad, `в ${f} остался старый формат ссылки`).toBeNull()
    })
  }
})

describe('письмо «вас добавили в проект»', () => {
  const src = read('mails.ts')
  const all = src.slice(src.indexOf('export async function sendAddedToProjectMail'))
  // только тело этой функции: дальше в файле есть другие письма, и их
  // правильные ссылки маскировали бы поломку в этой
  const body = all.slice(0, all.indexOf('\n}\n') + 1)

  it('ведёт на адрес с компанией', () => {
    // Именно здесь была поломка: ссылка строилась как `/#/p/<id>` — маршрута
    // с таким видом во фронте нет, и человек из письма видел белый экран.
    expect(body).toMatch(/url: projectUrl\(/)
  })

  it('компанию берёт у проекта, а не оставляет пустой', () => {
    expect(body).toMatch(/companyOf\(p\.projectId\)/)
  })

  it('уходит с почты компании, а не с нашей', () => {
    // письмо про их проект «от Chatick» читается как чужое
    expect(body).toMatch(/projectId: p\.projectId/)
  })
})

describe('ссылка, которую мост отдаёт человеку', () => {
  const src = read('../routes/bridge.ts')
  const fn = src.slice(src.indexOf('async function appPathOf'))

  it('строится общим projectPath', () => {
    expect(fn.slice(0, 600)).toMatch(/projectPath\(companyId/)
  })

  it('компанию берёт у проекта, а не выдумывает', () => {
    expect(fn.slice(0, 600)).toMatch(/companyOf\(projectId\)/)
  })
})
