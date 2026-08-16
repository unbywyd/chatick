import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Гашение уведомлений при открытии того, о чём они.
//
// Человек получил уведомление, зашёл через трей, открыл задачу, увидел её — а
// бейджи остались: и в трее, и на кнопке в панели задач Windows, и на вкладке
// «Мне», и напротив проекта в ней. Открытие задачи не гасило ничего вообще:
// гашение было только в инбоксе, у колокольчика и при клике ровно по строке
// уведомления.
//
// Счётчик, который показывает прочитанное, хуже отсутствующего: на него
// перестают смотреть. Поэтому проверяем все пути, которыми человек доходит до
// содержимого, а не только тот, что чинили последним.

const here = import.meta.dirname
const route = readFileSync(join(here, '../routes/inbox.ts'), 'utf8')
const app = join(here, '../../../app/src')
const tasksTab = readFileSync(join(app, 'components/tabs/TasksTab.tsx'), 'utf8')
const useDesktop = readFileSync(join(app, 'hooks/useDesktop.ts'), 'utf8')
const panel = readFileSync(join(here, '../../../desktop/panel.html'), 'utf8')
const main = readFileSync(join(here, '../../../desktop/main.cjs'), 'utf8')
const preloadPanel = readFileSync(join(here, '../../../desktop/preload-panel.cjs'), 'utf8')

const readRoute = route.slice(route.indexOf("inboxRoute.post(\n  '/read'"))

describe('ручка умеет гасить по сущности', () => {
  it('принимает entityType и entityId', () => {
    // По одному id гасить мало: на задачу их накапливается несколько —
    // назначили, упомянули, прокомментировали.
    expect(readRoute).toMatch(/entityType: z\.string\(\)\.optional\(\)/)
    expect(readRoute).toMatch(/entityId: z\.string\(\)\.optional\(\)/)
  })

  it('гасит только свои и только непрочитанные', () => {
    const branch = readRoute.slice(readRoute.indexOf('entityType && entityId'))
    const body = branch.slice(0, branch.indexOf('} else if'))
    expect(body).toMatch(/eq\(notifications\.userId, sub\)/)
    expect(body).toMatch(/isNull\(notifications\.readAt\)/)
  })

  it('оба поля обязательны вместе', () => {
    // Один entityType погасил бы все задачи разом.
    expect(readRoute).toMatch(/} else if \(entityType && entityId\) \{/)
  })

  it('прежние способы никуда не делись', () => {
    expect(readRoute).toMatch(/if \(all\)/)
    expect(readRoute).toMatch(/} else if \(projectId\)/)
    expect(readRoute).toMatch(/} else if \(ids\?\.length\)/)
  })
})

describe('открытие задачи гасит уведомления о ней', () => {
  it('запрос уходит при появлении taskId в адресе', () => {
    expect(tasksTab).toMatch(/entityType: 'task', entityId: openTaskId/)
  })

  it('считается открытием, а не закрытием', () => {
    // Эффект должен выходить рано, когда задачи нет: иначе закрытие карточки
    // слало бы запрос с пустым id.
    const eff = tasksTab.slice(tasksTab.indexOf("entityType: 'task'") - 400)
    expect(eff).toMatch(/if \(!openTaskId\) return/)
  })

  it('счётчики пересчитываются, иначе цифра остаётся старой', () => {
    const eff = tasksTab.slice(tasksTab.indexOf("entityType: 'task', entityId: openTaskId"))
    const tail = eff.slice(0, 600)
    expect(tail).toMatch(/queryKey: \['inbox'\]/)
    expect(tail).toMatch(/queryKey: \['sidebar-projects'\]/)
    expect(tail).toMatch(/queryKey: \['desktop-tasks'\]/)
  })
})

describe('переход в проект из панели гасит его уведомления', () => {
  it('панель передаёт проект, а не только ссылку', () => {
    // Под заголовком группы в «Мне» показаны все уведомления проекта, и уходя
    // по этой дорожке человек видит их все.
    expect(panel).toMatch(/window\.panel\.openProject\(/)
    expect(preloadPanel).toMatch(/openProject: \(link, projectId\)/)
  })

  it('главный процесс пробрасывает проект в веб', () => {
    const h = main.slice(main.indexOf("ipcMain.on('panel:open'"))
    expect(h.slice(0, h.indexOf('\n  })'))).toMatch(/projectId: typeof payload === 'string' \? null : payload\?\.projectId/)
  })

  it('веб гасит по проекту, когда id уведомления нет', () => {
    const h = useDesktop.slice(useDesktop.indexOf('const readBody ='))
    expect(h.slice(0, 300)).toMatch(/projectId\s*\n?\s*\?\s*\{ projectId \}/)
  })

  it('клик по конкретному уведомлению по-прежнему гасит одно', () => {
    // Иначе открытие одного уведомления обнуляло бы весь проект — человек
    // потерял бы то, чего не видел.
    const h = useDesktop.slice(useDesktop.indexOf('const readBody ='))
    expect(h.slice(0, 300)).toMatch(/notificationId\s*\n?\s*\?\s*\{ ids: \[notificationId\] \}/)
  })

  it('без обоих признаков запрос не уходит', () => {
    const h = useDesktop.slice(useDesktop.indexOf('const readBody ='))
    expect(h.slice(0, 400)).toMatch(/if \(!readBody\) return/)
  })
})

describe('бейджи считаются из одного источника', () => {
  it('трей и панель задач берут число из веба', () => {
    // Значит сброса счётчика в вебе достаточно: отдельно гасить бейдж
    // операционной системы не нужно, и рассинхрона между ними не будет.
    expect(useDesktop).toMatch(/unread: authed \? inbox\.data\?\.unreadTotal \?\? 0 : 0/)
    expect(main).toMatch(/const n = state\.unread/)
    expect(main).toMatch(/win\.setOverlayIcon\(/)
  })
})
