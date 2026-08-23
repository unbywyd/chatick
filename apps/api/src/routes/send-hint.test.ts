import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Плейсхолдер называет клавишу отправки.
 *
 * Отправляет Ctrl/Cmd+Enter, а голый Enter переносит строку. Комбинацию не
 * угадывают: человек жмёт Enter, получает перенос и не понимает, почему
 * сообщение не уходит. В поле об этом не было ни слова.
 */

const appDir = join(import.meta.dirname, '../../../app/src')
const composer = readFileSync(join(appDir, 'components/chat/Composer.tsx'), 'utf8')
const panel = readFileSync(join(appDir, 'components/chat/ChatPanel.tsx'), 'utf8')
const ru = JSON.parse(readFileSync(join(appDir, 'i18n/locales/ru.json'), 'utf8'))

describe('подсказка про отправку', () => {
  it('отправляет именно Ctrl/Cmd+Enter', () => {
    // Если комбинацию сменят, подсказка станет враньём — тест напомнит.
    expect(composer).toMatch(/event\.key === 'Enter' && \(event\.ctrlKey \|\| event\.metaKey\)/)
  })

  it('плейсхолдер называет клавишу', () => {
    for (const k of ['placeholderGroup', 'placeholderAi']) {
      expect(ru.chat[k], `${k} без подсказки про Enter`).toMatch(/\{\{key\}\}\+Enter/)
    }
  })

  it('клавиша подставляется по платформе', () => {
    // На Mac это ⌘: писать там «Ctrl» — называть комбинацию, которой нет.
    // Именно в плейсхолдере: объявить помощник и не позвать его — то же
    // самое, что писать «Ctrl» всем подряд.
    expect(panel, 'клавиша в плейсхолдере задана жёстко').toMatch(
      /placeholder=\{[\s\S]{0,300}?\{ key: sendKeyLabel\(\) \}/,
    )
    expect(panel).toMatch(/Mac\|iPhone\|iPad/)
  })
})
