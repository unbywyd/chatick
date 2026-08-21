import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Переход из настроек проекта на страницу ИИ закрывает модалку.
 *
 * Была обычная ссылка: адрес менялся, а модалка оставалась поверх новой
 * страницы. Со стороны это читалось как «клик не сработал» — человек жал
 * ещё раз, и ничего снова не происходило.
 */

const app = (f: string) => readFileSync(join(import.meta.dirname, '../../../app/src', f), 'utf8')
const form = app('components/ProjectSettingsForm.tsx')
const dialog = app('components/ProjectSettingsDialog.tsx')

describe('ссылка на страницу ИИ из настроек проекта', () => {
  it('это действие, а не ссылка', () => {
    // <a href> ничего не знает о модалке и закрыть её не может.
    expect(form, 'вернулась ссылка вместо обработчика').not.toMatch(/aiPageHref/)
    expect(form).toMatch(/onClick=\{onOpenAiPage\}/)
  })

  it('переход закрывает модалку', () => {
    // Порядок важен: сначала закрыть, потом уйти.
    expect(dialog, 'переход не закрывает модалку').toMatch(
      /onOpenAiPage=\{[\s\S]{0,200}?onClose\(\)[\s\S]{0,120}?navigate\(`\/c\/\$\{companyId\}\/p\/\$\{projectId\}\/ai`\)/,
    )
  })
})
