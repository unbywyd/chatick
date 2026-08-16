import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Мастер-доступ: туннель ко ВСЕМ проектам человека, во всех его компаниях.
//
// Он опаснее остальных: одна утечка задевает не только владельца токена, но и
// чужие компании, где он просто участник. Поэтому проверяем не «работает ли»,
// а то, что его нельзя выдать молча и нельзя потерять из виду:
//
//  1. область приходит от человека и никогда не подставляется клиентом;
//  2. три вида области взаимоисключающие — «и проект, и всё сразу» не бывает;
//  3. выданный мастер виден в списке подключений и его есть чем закрыть;
//  4. никакой путь подтверждения не выбирает мастер за человека сам.

const here = import.meta.dirname
const read = (p: string) => readFileSync(join(here, p), 'utf8')

const auth = read('bridge-auth.ts')
const authRoute = read('../routes/auth.ts')
const bridgeRoute = read('../routes/bridge.ts')

const app = (p: string) => readFileSync(join(here, '../../../app/src', p), 'utf8')
const panel = readFileSync(join(here, '../../../desktop/panel.html'), 'utf8')
const mcpIndex = readFileSync(join(here, '../../../mcp/src/index.ts'), 'utf8')
const mcpAuth = readFileSync(join(here, '../../../mcp/src/auth.ts'), 'utf8')

describe('область выдаёт человек, а не клиент', () => {
  // Ключевое свойство: ассистент не может выписать себе мастер-доступ. Он
  // получает код, а что этим кодом открыть — решают на стороне человека.
  it('MCP не умеет просить область — только код', () => {
    const connect = mcpIndex.slice(mcpIndex.indexOf("'chatick_connect'"), mcpIndex.indexOf("'chatick_finish_connect'"))
    expect(connect).toMatch(/inputSchema:\s*\{\s*\}/)
    expect(connect).not.toMatch(/all:\s*true/)
  })

  it('MCP не шлёт область при запросе одобрения у приложения', () => {
    const ask = mcpAuth.slice(mcpAuth.indexOf('async function askDesktopToApprove'))
    const body = ask.slice(0, ask.indexOf('signal:'))
    expect(body).not.toMatch(/all|companyId|projectId/)
  })
})

describe('три вида области взаимоисключающие', () => {
  it('approveUserCode принимает ровно одну форму', () => {
    // Union из трёх вариантов с never на остальных полях: «и проект, и всё
    // сразу» не собирается даже случайно.
    const sig = auth.slice(auth.indexOf('export async function approveUserCode'), auth.indexOf('const code = await lookupUserCode'))
    expect(sig).toMatch(/\{ projectId: string; companyId\?: never; all\?: never \}/)
    expect(sig).toMatch(/\{ companyId: string; projectId\?: never; all\?: never \}/)
    expect(sig).toMatch(/\{ all: true; projectId\?: never; companyId\?: never \}/)
  })

  it('ручка требует code и одно из трёх', () => {
    const h = authRoute.slice(authRoute.indexOf("auth.post('/bridge/approve'"), authRoute.indexOf("auth.post('/bridge/deny'"))
    expect(h).toMatch(/body\.all === true/)
    // Мастер не требует членства: он открывает лишь то, где человек и так
    // состоит, а членство проверяется на каждом запросе отдельно.
    expect(h).toMatch(/approveUserCode\(code, sub, \{ all: true \}\)/)
  })

  it('пустая область — это «ещё не подтверждено», а не мастер', () => {
    // Без отдельного признака мастер был бы неотличим от неподтверждённого
    // кода: у обоих пустые projectId и companyId.
    expect(auth).toMatch(/if \(!row\.scopeAll && !row\.projectId && !row\.companyId\) return \{ status: 'pending' \}/)
  })
})

describe('клиент узнаёт, что именно ему открыли', () => {
  it('device flow отдаёт область словом', () => {
    // Иначе мастер приходит без project — как компанейский туннель — и
    // клиент занижает то, что человек открыл.
    // Режем до СЛЕДУЮЩЕЙ ручки, а не до первого «})»: внутри обработчика их
    // несколько — ранние выходы с ошибками, — и срез по первому обрывался на
    // проверке deviceCode, не доходя до ответа. Пока файл был с CRLF, «})\n»
    // не находилось вовсе и тест проходил вхолостую.
    const from = bridgeRoute.indexOf("bridgeRoute.post('/device/poll'")
    const next = bridgeRoute.indexOf('bridgeRoute.', from + 20)
    expect(bridgeRoute.slice(from, next)).toMatch(/scope: .*scopeAll \? 'all'/)
  })

  it('MCP различает мастер и компанию в ответе человеку', () => {
    expect(mcpIndex).toMatch(/function scopeWords/)
    expect(mcpIndex).toMatch(/master access/)
    // Старая формулировка называла мастер «company-wide» — прямая неправда.
    const words = mcpIndex.slice(mcpIndex.indexOf('function scopeWords'))
    expect(words.slice(0, words.indexOf('}\n'))).toMatch(/kind === 'all'/)
  })

  it('MCP переживает токен, сохранённый до появления мастера', () => {
    // У старых файлов поля kind нет; считать их мастером нельзя.
    const k = mcpAuth.slice(mcpAuth.indexOf('function kindOf'))
    expect(k.slice(0, k.indexOf('}\n'))).toMatch(/s\.kind \?\? \(s\.projectId \? 'project' : 'company'\)/)
  })
})

describe('выданный мастер видно и есть чем закрыть', () => {
  it('вкладка компании показывает мастер-туннели', () => {
    // Мастер не привязан к компании: фильтр по company.id прятал бы его, и
    // закрыть выданное отсюда было бы негде.
    expect(app('components/company/CompanyConnectTab.tsx')).toMatch(/s\.scope === 'all' \|\| s\.company\?\.id === company\.id/)
  })

  it('панель в трее подписывает мастер отдельно от компании', () => {
    expect(panel).toMatch(/c\.scope === 'all'/)
  })
})

describe('мастер не выбирается за человека', () => {
  it('панель никогда не выделяет мастер-строку сама', () => {
    // Строка стоит первой; автовыбор по индексу открыл бы всё одним нажатием
    // «Разрешить».
    const auto = panel.slice(panel.indexOf('if (!connect.target)'))
    expect(auto.slice(0, auto.indexOf('}\n'))).toMatch(/find\(\(x\) => x\.key\[0\] !== 'a'\)/)
  })

  it('окно подтверждения требует явного выбора', () => {
    const dlg = app('components/GrantRequestDialog.tsx')
    expect(dlg).toMatch(/if \(!target && !masterMode\) return/)
    expect(dlg).toMatch(/disabled=\{\(!target && !masterMode\) \|\| busy\}/)
  })

  it('мастер отменяет выбранную цель, а не дополняет её', () => {
    // Отправить цель вместе с all значило бы сузить то, что человек открыл
    // целиком.
    const dlg = app('components/GrantRequestDialog.tsx')
    const body = dlg.slice(dlg.indexOf('body: JSON.stringify({'))
    expect(body.slice(0, body.indexOf('}),'))).toMatch(/masterMode\s*\?\s*\{ all: true \}/)
  })
})
