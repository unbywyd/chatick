import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Сохранение настроек ИИ: смена одной модели.
 *
 * История бага в двух шагах. Сначала кнопка «Проверить и сохранить» требовала
 * ключ, которого нет на экране (сохранённый мы не показываем) — она просто не
 * включалась. Кнопку починили, а такую же проверку внутри onSubmit — забыли.
 * Стало хуже: кнопка активна, форма отправляется, обработчик молча ничего не
 * делает. Нажатие без ошибки, без спиннера, без следа.
 *
 * Отсюда три вещи, которые здесь заперты: условие сохранения ОДНО на кнопку и
 * на отправку; ключ обязателен только пока не сохранён; причина отказа от
 * провайдера доходит до человека, а не тонет в консоли сервера.
 */

const ui = readFileSync(join(import.meta.dirname, '../../../app/src/components/company/LlmSettings.tsx'), 'utf8')
const route = readFileSync(join(import.meta.dirname, 'companies.ts'), 'utf8')
const llm = readFileSync(join(import.meta.dirname, '../lib/llm.ts'), 'utf8')

describe('настройки ИИ: сохранение модели', () => {
  it('кнопка и отправка формы решают одним и тем же условием', () => {
    // Разойдись они снова — вернётся клик в пустоту.
    expect(ui, 'onSubmit проверяет что-то своё вместо общего условия').toMatch(
      /onSubmit=\{[\s\S]*?if \(canSave\) save\.mutate\(\)/,
    )
    expect(ui, 'кнопка проверяет что-то своё вместо общего условия').toMatch(/disabled=\{!canSave\}/)
  })

  it('ключ обязателен только пока он не сохранён', () => {
    const cond = ui.match(/const canSave =[\s\S]*?\n\n/)?.[0] ?? ''
    expect(cond, 'условие canSave не найдено').not.toBe('')
    // Именно «или»: есть новый ключ ИЛИ уже настроено.
    expect(cond).toMatch(/Boolean\(apiKey\) \|\| Boolean\(status\.data\?\.configured\)/)
  })

  it('vision уходит на сервер вместе с моделью', () => {
    // Сервер пишет `llmVision: vision === true`: не пришло поле — выключил.
    // Без этого сохранение модели гасило только что включённую галочку.
    const body = route.match(/llmVision: vision === true/)
    expect(body, 'сервер больше не выключает vision — проверь, актуален ли тест').not.toBeNull()
    expect(ui, 'форма не шлёт vision, сервер его выключит').toMatch(/body: JSON\.stringify\(\{[\s\S]*?vision,[\s\S]*?\}\)/)
  })

  it('причина отказа от провайдера доходит до человека', () => {
    // Голое «проверьте ключ и модель» не отличает «модели нет» от «ключ протух».
    expect(llm, 'testLlm снова отдаёт голый boolean').toMatch(
      /testLlm\([\s\S]*?\): Promise<\{ ok: true \} \| \{ ok: false; reason: string \}>/,
    )
    expect(route, 'ручка не передаёт причину наружу').toMatch(/c\.json\(\{ error: check\.reason \}, 422\)/)
  })
})
