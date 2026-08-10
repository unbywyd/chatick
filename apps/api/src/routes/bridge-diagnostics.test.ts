import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Три вещи, которые ассистент узнаёт только когда уже потратил время впустую.
// Все три всплыли в один рабочий день, и все три — про ответ, который выглядит
// успешным и не говорит главного.

const src = readFileSync(join(import.meta.dirname, 'bridge.ts'), 'utf8')

describe('ссылка на задачу приходит готовой', () => {
  it('taskView отдаёт url, а не только id', () => {
    // Клиент собирал адрес сам и угадывал формат: /#/p/<id> без компании
    // выглядит правдоподобно, такого маршрута нет, и человек из ссылки
    // попадает на белый экран.
    const view = src.slice(src.indexOf('const taskView = ('), src.indexOf('/** Счётчики зависимостей'))
    expect(view).toMatch(/url: projectUrl\(/)
    // Через общую функцию, а не строкой по месту: формат адреса уже менялся
    // однажды, и собранный руками остался бы старым.
    expect(view).not.toMatch(/`\$\{.*\}\/#\/p\//)
  })

  it('компания запрашивается один раз на список, а не на каждую задачу', () => {
    // taskView зовут на каждую строку; запрос внутри превратился бы в полсотни
    // одинаковых на один ответ.
    expect(src).toMatch(/const listCompanyId = await companyOf\(scope\.projectId\)/)
    expect(src).toMatch(/const bulkCompanyId = await companyOf\(scope\.projectId\)/)
  })
})

describe('запись документа сообщает, что записалось', () => {
  it('все три ручки отдают totalChars', () => {
    // /append отдавал его с самого начала, а PATCH и POST молчали: ответ
    // «id + title» выглядит успехом при любом исходе, и ассистент докладывает
    // о сохранённом документе, в котором осталось прежнее содержимое.
    const writes = src.match(/totalChars/g) ?? []
    expect(writes.length, 'ожидаем totalChars в POST, PATCH и append').toBeGreaterThanOrEqual(3)
  })
})

describe('сломанный JSON называется своим именем', () => {
  it('тело читается через общий разбор, а не глотается молча', () => {
    // c.req.json().catch(() => ({})) превращал ошибку разбора в пустой объект,
    // и валидация сообщала «title is required» — про поле, которого в теле
    // никогда и не было. Искать шли не там.
    // Считаем по коду, а не по тексту файла: сам помощник цитирует старую
    // форму в комментарии, объясняя, от чего ушли.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n')
    expect(code).not.toMatch(/c\.req\.json\(\)\.catch\(\(\) => \(\{\}\)\)/)
    expect(src).toMatch(/async function readJson\(/)
  })

  it('ответ называет причину и показывает место', () => {
    const fn = src.slice(src.indexOf('async function readJson('), src.indexOf('function unknownFields'))
    expect(fn).toMatch(/Invalid JSON/)
    expect(fn).toMatch(/position \(\\d\+\)/)
    // Фрагмент показываем всегда: позицию сообщают не все версии V8, и без
    // запасного варианта подсказка была бы пустой ровно там, где нужна.
    expect(fn).toMatch(/raw\.slice\(0, 120\)/)
  })

  it('пустое тело остаётся пустым объектом, а не ошибкой', () => {
    // Многие ручки зовут разбор всегда, даже когда тело не обязательно:
    // отвечать 400 на пустой PATCH значило бы сломать их все.
    const fn = src.slice(src.indexOf('async function readJson('), src.indexOf('function unknownFields'))
    expect(fn).toMatch(/if \(!raw\.trim\(\)\) return \{ body: \{\} \}/)
  })
})
