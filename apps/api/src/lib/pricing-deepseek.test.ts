import { describe, it, expect } from 'vitest'
import { DEFAULT_PRICING } from './ai-usage.js'
import { env } from '../env.js'

/**
 * Цены DeepSeek — не справочная величина, а предохранитель.
 *
 * По ним считается costUsd, по нему — исчерпан ли пробный бюджет компании
 * (AI_TRIAL_BUDGET_USD). Пробная модель у нас как раз дипсиковская, поэтому
 * заниженная цена означает буквально: раздать больше бесплатных токенов, чем
 * обещано, и заметить это по счёту от провайдера.
 *
 * Прошлые числа занижали выход втрое (0.42 против 1.32) — проба тратила
 * втрое больше денег, чем показывала. Тестов на прайс не было вовсе.
 *
 * Сверено с прайсом DeepSeek 21.08.2026.
 */

// Дневная ставка: ночная ровно вдвое дешевле, одним числом обе не выразить.
const PEAK = {
  'deepseek-v4-flash': { in: 0.44, out: 1.32 },
  'deepseek-v4-pro': { in: 1.32, out: 3.96 },
} as const

describe('прайсинг DeepSeek', () => {
  it('совпадает с пиковой ставкой провайдера', () => {
    for (const [model, price] of Object.entries(PEAK)) {
      expect(DEFAULT_PRICING[model], `${model} пропала из прайса`).toBeDefined()
      expect(DEFAULT_PRICING[model], model).toEqual(price)
    }
  })

  it('берётся дорогая ставка, а не дешёвая', () => {
    // Ночная цена ровно вдвое ниже. Попадание сюда значит, что кто-то взял
    // off-peak — и пробный бюджет молча удвоился.
    for (const [model, price] of Object.entries(PEAK)) {
      expect(DEFAULT_PRICING[model]!.out, `${model}: похоже на ночную ставку`).not.toBeCloseTo(price.out / 2, 5)
      expect(DEFAULT_PRICING[model]!.in, `${model}: похоже на ночную ставку`).not.toBeCloseTo(price.in / 2, 5)
    }
  })

  it('у пробной модели цена есть — иначе лимит не работает', () => {
    /**
     * Без цены costFor вернёт null, такой вызов не попадёт в сумму трат, и
     * пробный период станет безлимитным. Молча: ошибки не будет нигде.
     */
    const trial = env.AI_TRIAL_MODEL
    expect(DEFAULT_PRICING[trial], `у пробной модели ${trial} нет цены — пробный бюджет не ограничен`).toBeDefined()
  })
})
