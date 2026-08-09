import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Списки на иврите: маркер должен стоять рядом со СВОИМ текстом.
//
// Разбирался с реальным комментарием: четыре пункта на иврите и пятый —
// «heroku ps:scale web=1». Список брал направление по первому пункту (RTL),
// а unicode-bidi: plaintext разворачивал латинский пункт в LTR. Текст уезжал
// к правому краю, «1.» оставалась у левого, и между ними зияла пустота во всю
// строку — какой номер к какой строке, было уже не понять.
//
// Тонкость, из-за которой ошибка и живёт долго: plaintext разворачивает ТЕКСТ
// пункта, но не двигает его маркер — сторону маркера решает direction, а
// plaintext его не меняет. Поэтому лечится это не выравниванием, а dir="auto"
// на самом пункте.
//
// Тест лежит здесь, а не в apps/app: там нет vitest, а заводить его ради
// одного правила дороже, чем проверить те же два файла отсюда.

const APP = join(import.meta.dirname, '../../../app/src')
const css = readFileSync(join(APP, 'index.css'), 'utf8')
const ext = readFileSync(join(APP, 'components/ui/text-direction.ts'), 'utf8')

describe('направление пункта списка', () => {
  it('пункт получает dir="auto" по умолчанию', () => {
    // Именно на пункте, а не только на списке: список со смешанными языками
    // иначе разъезжается.
    expect(ext).toMatch(/const LIST_NODES = \[[^\]]*'listItem'/)
    expect(ext).toMatch(/renderHTML: \(attrs: Record<string, unknown>\) => \(\{ dir: attrs\.dir \?\? 'auto' \}\)/)
  })

  it('к пункту не применяется unicode-bidi: plaintext', () => {
    // plaintext перебил бы направление, заданное атрибутом, и маркер снова
    // остался бы у противоположного края.
    const rule = /:is\(p, h1, h2, h3, h4, h5, h6([^)]*)\)\s*\{\s*unicode-bidi: plaintext/
    const m = rule.exec(css)
    expect(m, 'правило с unicode-bidi: plaintext не найдено').not.toBeNull()
    expect(m![1], 'li вернулся в список plaintext — маркеры снова разъедутся').not.toMatch(/\bli\b/)
  })

  it('ручной выбор направления сильнее автоматического', () => {
    // Кнопка направления должна побеждать dir="auto", иначе исправить
    // неудачно определённый пункт станет нечем.
    expect(ext).toMatch(/attrs\.dir \?\? 'auto'/)
  })

  it('пункт списка по-прежнему правится кнопкой направления', () => {
    // listItem убран из NODES ради dir="auto" по умолчанию — но команда
    // обязана его учитывать, иначе кнопка перестанет действовать на пункты.
    expect(ext).toMatch(/const editable = \[\.\.\.NODES, 'listItem', 'taskItem'\]/)
  })
})
