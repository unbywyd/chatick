import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveMime, mimeFromName, GENERIC_MIME } from './mime.js'

/**
 * Вложения открываются и показываются миниатюрой — независимо от того,
 * назвал ли загрузчик тип файла.
 *
 * На проде лежали 36 картинок `.png` с типом octet-stream (мост шлёт байты
 * без типа), и всё, что решает «это картинка» по mime, их не узнавало: ни
 * сетка миниатюр в карточке, ни лайтбокс, ни фильтр в файлах. Человек видел
 * иконку файла и «скачать» там, где у соседнего файла была картинка.
 */

const api = (p: string) => readFileSync(join(import.meta.dirname, '..', p), 'utf8').replace(/\r\n/g, '\n')
const app = (p: string) => readFileSync(join(import.meta.dirname, '../../../app/src', p), 'utf8').replace(/\r\n/g, '\n')

describe('тип по имени, когда загрузчик его не назвал', () => {
  it('пустой и octet-stream уступают расширению', () => {
    expect(resolveMime('', '13.png')).toBe('image/png')
    expect(resolveMime(undefined, 'scan.PDF')).toBe('application/pdf')
    expect(resolveMime(GENERIC_MIME, 'photo.JPEG')).toBe('image/jpeg')
    expect(resolveMime(GENERIC_MIME, 'notes.md')).toBe('text/markdown')
  })

  it('названный тип побеждает имя', () => {
    // image/webp у файла .png после пережатия — правда о байтах, имя — история.
    expect(resolveMime('image/webp', 'shot.png')).toBe('image/webp')
  })

  it('неизвестное расширение — честное «не знаю», а не выдумка', () => {
    expect(resolveMime('', 'archive.xyz')).toBe(GENERIC_MIME)
    expect(resolveMime('', 'README')).toBe(GENERIC_MIME)
    expect(mimeFromName('a.tar.gz')).toBeNull()
  })
})

describe('все три пути загрузки идут через одно правило', () => {
  it('в API не осталось «file.type || octet-stream»', () => {
    // Путей три: интерфейс/мост (files.ts), файлы ресурсов через мост
    // (bridge.ts) и из интерфейса (resources.ts). Правило, выписанное трижды,
    // разошлось бы — как разошлось со статусами.
    //
    // Саботаж: вернуть `file.type || 'application/octet-stream'` — тест падает.
    const left: string[] = []
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && e.name !== 'mime.ts') {
          readFileSync(p, 'utf8').split(/\r?\n/).forEach((l, i) => {
            if (l.includes("file.type || 'application/octet-stream'")) left.push(`${p}:${i + 1}`)
          })
        }
      }
    }
    walk(join(import.meta.dirname, '..'))
    expect(left, `тип всё ещё кладётся без разбора имени:\n${left.join('\n')}`).toEqual([])
    for (const f of ['routes/files.ts', 'routes/bridge.ts', 'routes/resources.ts']) {
      expect(api(f), `${f} не зовёт resolveMime`).toContain('resolveMime(file.type, file.name)')
    }
  })

  it('у файлов ресурсов настоящий тип — только в базе, объект остаётся обезличенным', () => {
    // Файлы ресурсов лежат в хранилище ШИФРОТЕКСТОМ (см. resource-files.test.ts):
    // объект — не картинка и не pdf, а байты, и подписывать его настоящим типом
    // значило бы врать и подсказывать, что внутри. Тип нужен после
    // расшифровки — для этого он в базе. Первая версия этой правки поставила
    // resolveMime и в ContentType объекта; сторож шифротекста это поймал.
    for (const f of ['routes/bridge.ts', 'routes/resources.ts']) {
      expect(api(f), `${f}: объект в хранилище подписан настоящим типом`).toContain("ContentType: 'application/octet-stream'")
      expect(api(f), `${f}: в базе тип не разбирается по имени`).toContain('mime: resolveMime(file.type, file.name)')
    }
  })
})

describe('клиент узнаёт картинку и без типа', () => {
  const viewer = app('components/files/FileViewer.tsx')

  it('kindOf смотрит на расширение, как для видео и звука', () => {
    // Саботаж: вернуть `if (m.startsWith('image/')) return 'image'` — тест падает.
    expect(viewer).toContain("if (m.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic', 'avif', 'bmp'].includes(ext)) return 'image'")
    expect(viewer).toContain('export function isImage(file: { name: string; mime: string }): boolean')
  })

  it('списки спрашивают у isImage, а не у mime напрямую', () => {
    // Семь мест решали это сами и одинаково ошибались. Локальные File (f.type)
    // не в счёт: там тип ставит браузер по расширению.
    const left: string[] = []
    const root = join(import.meta.dirname, '../../../app/src')
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e.name) && e.name !== 'FileViewer.tsx') {
          readFileSync(p, 'utf8').split(/\r?\n/).forEach((l, i) => {
            if (l.includes(".mime.startsWith('image/')")) left.push(`${p}:${i + 1}`)
          })
        }
      }
    }
    walk(root)
    expect(left, `свои проверки «это картинка»:\n${left.join('\n')}`).toEqual([])
    for (const f of ['components/tabs/tasks/TaskDrawer.tsx', 'components/chat/ChatPanel.tsx', 'components/tabs/tasks/TaskComments.tsx']) {
      expect(app(f), `${f} не использует isImage`).toContain('isImage(')
    }
  })
})
