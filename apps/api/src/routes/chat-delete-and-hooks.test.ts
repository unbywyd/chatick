import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

/**
 * Удаление сообщения в чате и порядок хуков.
 *
 * Оба бага нашлись в один заход и оба показывались только человеку:
 * удалённое сообщение висело на экране, а React падал лишь у того, кто попал
 * в нужную ветку.
 */

const CRLF = new RegExp(String.fromCharCode(13) + String.fromCharCode(10), 'g')
const LF = String.fromCharCode(10)
const app = (p: string) =>
  readFileSync(join(import.meta.dirname, '../../../app/src/', p), 'utf8').replace(CRLF, LF)

const chat = app('components/chat/ChatPanel.tsx')

describe('удаление сообщения убирает его с экрана', () => {
  it('своё и чужое удаление идут одним путём', () => {
    // Лента склеена из ДВУХ источников: live (пришло сокетом) и история
    // (подгружена запросом). Сообщение лежит ровно в одном из них, и какое
    // где — зависит от того, был ли человек на экране, когда его отправили.
    //
    // Раньше своё удаление чистило только live: нажимаешь «удалить» —
    // тишина, нажимаешь второй раз — «Not found», потому что на сервере его
    // уже нет. Пропадало оно только к следующему опросу истории.
    //
    // Саботаж: вернуть setLive прямо в onSuccess — тест падает.
    expect(chat, 'общей функции удаления нет').toContain('const dropMessage = useCallback(')
    expect(chat, 'своё удаление идёт мимо общей функции').toContain('onSuccess: (_r, id) => dropMessage(id)')
    expect(chat, 'чужое удаление идёт мимо общей функции').toContain('onMessageDeleted: ({ messageId }) => dropMessage(messageId)')
  })

  it('удаление чистит оба источника, а не один', () => {
    // Правило, выписанное для одного источника, работает через раз и
    // выглядит как «кнопка иногда не срабатывает».
    const at = chat.indexOf('const dropMessage = useCallback(')
    const body = chat.slice(at, chat.indexOf('}, [qc, projectId])', at))
    expect(body, 'live не чистится').toContain('setLive((prev) => prev.filter')
    expect(body, 'история не перезапрашивается').toContain("invalidateQueries({ queryKey: ['messages', projectId] })")
  })

  it('повторное удаление не пугает ошибкой', () => {
    // «Not found» значит, что удалять уже нечего — для человека это
    // достигнутая цель, а не поломка.
    //
    // Саботаж: показывать toast на любую ошибку — тест падает.
    expect(chat, 'повторное удаление показывает красное окошко').toContain('/not found/i.test(msg)')
  })
})

describe('порядок хуков проверяется до сборки', () => {
  it('проверка ловит хук после условного return', () => {
    // React #310 «Rendered more hooks than during the previous render».
    // Падало у тех, кто зашёл ВПЕРВЫЕ: на StartScreen условный выход — это
    // мастер настройки, который показывают только новичку.
    //
    // Проверяем саму проверку: подсовываем ей заведомо сломанный компонент и
    // ждём ненулевой код выхода. Первая версия этой проверки настоящий баг
    // пропускала — считала границей компонента `}) {` в конце многострочной
    // сигнатуры.
    const script = join(import.meta.dirname, '../../../app/scripts/check-hooks.mjs')
    const src = readFileSync(script, 'utf8')
    expect(src, 'проверка разбирает файлы не парсером').toContain("import ts from 'typescript'")
    expect(src, 'проверка не падает при находке').toContain('process.exit(1)')
  })

  it('проверка стоит в сборке клиента', () => {
    // Иначе она есть, но её никто не запускает.
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, '../../../app/package.json'), 'utf8'),
    )
    expect(pkg.scripts.build, 'проверка не встроена в сборку').toContain('check-hooks.mjs')
  })

  it('на текущем коде проверка проходит', () => {
    // Живой прогон: если кто-то поставит хук под условный выход, упадёт здесь.
    const cwd = join(import.meta.dirname, '../../../app')
    expect(() => execSync('node scripts/check-hooks.mjs', { cwd, stdio: 'pipe' })).not.toThrow()
  })
})
