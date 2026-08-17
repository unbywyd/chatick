import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Файл из чата → задача (SPEC §8.17).
//
// «Вот скриншот бага, заведи задачу» не работал в один ход, и причин было
// три: create_task не принимал вложения, list_chat_images отдавал только имя
// без id, а list_files временные файлы вообще не показывает. То есть id, без
// которого не приложить, нельзя было получить НИГДЕ.

const here = import.meta.dirname
const src = readFileSync(join(here, 'memory.ts'), 'utf8')

const handler = (name: string) => {
  const from = src.indexOf(`    ${name}: async`)
  if (from === -1) return ''
  // до следующего обработчика на том же уровне
  const next = src.indexOf('\n    },\n', from)
  return src.slice(from, next)
}

describe('id вложения теперь доступен', () => {
  it('list_chat_images отдаёт id', () => {
    // Без него attach_file_to_task и create_task требуют то, чего человек не
    // знает и что взять неоткуда.
    expect(handler('list_chat_images')).toMatch(/id: files\.id/)
    expect(handler('list_chat_images')).toMatch(/id=\$\{r\.id\}/)
  })

  it('и не только картинки', () => {
    // Лог, PDF и архив бросают не реже, а раньше ассистент отвечал, что
    // вложений нет вовсе.
    const h = handler('list_chat_images')
    expect(h).not.toMatch(/rows\.filter\(\(r\) => r\.mime\.startsWith\('image\/'\)\)/)
    // Но картинку по-прежнему видно как картинку: её можно открыть, остальное нет.
    expect(h).toMatch(/view_image can open it/)
  })

  it('чужие вложения в список не попадают', () => {
    // Чат с ассистентом личный.
    expect(handler('list_chat_images')).toMatch(/eq\(files\.uploadedById, actorUserId\)/)
  })
})

describe('create_task принимает вложения', () => {
  it('поле объявлено в схеме', () => {
    // Не объявленное поле модель не передаст, каким бы рабочим ни был код.
    const schema = src.slice(src.indexOf("name: 'create_task'"), src.indexOf("name: 'update_task'"))
    expect(schema).toMatch(/attachmentIds/)
    expect(schema).toMatch(/list_chat_images/)
  })

  it('права на файлы проверяются ДО создания задачи', () => {
    // Иначе задача заводится, файл не прикладывается, а человек читает отказ
    // и не понимает, что задача всё-таки создана.
    const h = handler('create_task')
    const perm = h.indexOf("'files.upload'")
    const create = h.indexOf('createOneTask(args)')
    expect(perm, 'проверка прав на месте').toBeGreaterThan(-1)
    expect(create, 'создание на месте').toBeGreaterThan(-1)
    expect(perm).toBeLessThan(create)
  })

  it('о неприложенном сообщается вслух', () => {
    // Молчаливая потеря выглядит как «приложил», а в задаче файла нет.
    expect(handler('create_task')).toMatch(/could not be attached/)
  })
})

describe('приложенный файл переживает уборку', () => {
  const fn = (() => {
    const from = src.indexOf('async function attachFilesToTask')
    return src.slice(from, src.indexOf('\n  }\n', from))
  })()

  it('pendingUntil снимается', () => {
    // Файл из чата временный и удаляется в течение суток. Приложенный и не
    // сохранённый исчез бы из задачи сам, оставив ссылку в никуда.
    expect(fn).toMatch(/pendingUntil: null/)
    expect(fn).toMatch(/taskId/)
  })

  it('берутся только свои файлы этого проекта', () => {
    // Подставленный чужой id не должен вытащить файл в задачу.
    expect(fn).toMatch(/eq\(files\.projectId, projectId\)/)
    expect(fn).toMatch(/eq\(files\.uploadedById, actorUserId\)/)
    expect(fn).toMatch(/isNull\(files\.deletedAt\)/)
  })

  it('возвращает имена приложенного, а не количество', () => {
    // Вызывающий должен сказать, ЧТО приложилось: «приложил 2 файла» не даёт
    // человеку проверить, те ли это файлы.
    expect(fn).toMatch(/return rows\.map\(\(r\) => r\.name\)/)
  })
})
