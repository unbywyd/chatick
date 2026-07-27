import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// Журнал версий читается из CHANGELOG.md в корне репозитория (SPEC §8.37).
//
// Файл, а не база: требование «нельзя поднять версию без описания» проверяемо
// только тогда, когда журнал лежит рядом с кодом и правится тем же коммитом.
// Сборка сверяет верхнюю запись с package.json и падает при расхождении —
// забыть описание невозможно, а не просто нежелательно.

/**
 * Корень репозитория. Ищем вверх по каталогам, а не считаем шаги: при сборке
 * модуль оказывается в dist, и жёсткий путь промахивается мимо корня.
 */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, 'CHANGELOG.md')) && existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  // Запасной вариант — каталог, из которого запущена сборка
  return process.cwd().includes('apps') ? resolve(process.cwd(), '../..') : process.cwd()
}

const ROOT = repoRoot()

export type ReleaseSection = { title: string; items: string[] }
export type Release = { version: string; date: string; sections: ReleaseSection[] }

/** Версия продукта — одна на всё: её показывают и в приложении, и на сайте. */
export function productVersion(): string {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { version?: string }
  return pkg.version ?? '0.0.0'
}

export function parseChangelog(): Release[] {
  const md = readFileSync(resolve(ROOT, 'CHANGELOG.md'), 'utf8')
  const releases: Release[] = []
  let release: Release | null = null
  let section: ReleaseSection | null = null

  for (const raw of md.split('\n')) {
    const line = raw.trimEnd()

    // «## 0.2.0 — 2026-07-28» — тире может быть любым, люди пишут по-разному
    const head = line.match(/^##\s+(\d+\.\d+\.\d+)\s*[—–-]\s*(.+)$/)
    if (head) {
      release = { version: head[1]!, date: head[2]!.trim(), sections: [] }
      releases.push(release)
      section = null
      continue
    }

    const sub = line.match(/^###\s+(.+)$/)
    if (sub && release) {
      section = { title: sub[1]!.trim(), items: [] }
      release.sections.push(section)
      continue
    }

    const item = line.match(/^[-*]\s+(.+)$/)
    if (item && release) {
      // Без подраздела — складываем в общий, чтобы запись не потерялась
      if (!section) {
        section = { title: '', items: [] }
        release.sections.push(section)
      }
      section.items.push(item[1]!.trim())
      continue
    }

    // Продолжение пункта с переносом строки
    if (release && section && section.items.length && /^\s{2,}\S/.test(raw)) {
      section.items[section.items.length - 1] += ' ' + line.trim()
    }
  }

  return releases
}

/**
 * Сверка версии с журналом. Вызывается при сборке лендинга.
 *
 * Падать здесь — намеренно: версия без описания доезжает до людей молча, и
 * заметить это потом некому.
 */
export function assertChangelogMatchesVersion(): Release[] {
  const releases = parseChangelog()
  const version = productVersion()

  if (!releases.length) {
    throw new Error('CHANGELOG.md пуст: у версии должно быть описание, иначе релиз уедет молча.')
  }
  const top = releases[0]!
  if (top.version !== version) {
    throw new Error(
      `Версия ${version} из package.json не описана в CHANGELOG.md — вверху там ${top.version}.\n` +
        `Добавьте запись «## ${version} — ГГГГ-ММ-ДД» с описанием изменений.`,
    )
  }
  const empty = top.sections.every((s) => s.items.length === 0)
  if (!top.sections.length || empty) {
    throw new Error(`Запись ${version} в CHANGELOG.md пустая: опишите, что изменилось.`)
  }
  return releases
}
