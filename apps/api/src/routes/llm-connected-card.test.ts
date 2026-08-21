import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Подключённый ИИ показывается карточкой, а не развёрнутой формой.
 *
 * Форма со всеми полями висела всегда, даже когда всё уже настроено. По ней
 * читалось, будто сменить модель можно только заполнив заново и провайдера, и
 * ключ — которого на экране нет и никогда не будет: он сохранён и не
 * показывается. Люди так и понимали: «чтобы сменить модель, надо ввести всё
 * подряд».
 *
 * Теперь по умолчанию видно состояние, а поля появляются под конкретное
 * действие: сменить модель (инлайн) или сменить провайдера (форма целиком).
 */

const app = (f: string) => readFileSync(join(import.meta.dirname, '../../../app/src', f), 'utf8')
const company = app('components/company/LlmSettings.tsx')
const project = app('components/tabs/AiUsageTab.tsx')

describe('настройки ИИ компании: карточка вместо формы', () => {
  it('форма скрыта, пока подключение есть и его не меняют', () => {
    // Ключевое условие всего экрана: сломается — форма снова вылезет поверх
    // готовой настройки.
    expect(company).toMatch(/const showForm = isAdmin && \(!connected \|\| changing\)/)
  })

  it('модель меняется инлайн, без ключа и без остальной формы', () => {
    expect(company, 'нет режима правки модели').toMatch(/const \[editingModel, setEditingModel\] = useState\(false\)/)
    // Кнопка правки подставляет текущие значения: иначе инлайн-поле открылось
    // бы пустым и «применить» стёрло бы модель.
    expect(company).toMatch(/setModel\(status\.data!\.model \?\? ''\)[\s\S]{0,80}?setEditingModel\(true\)/)
  })

  it('смену провайдера начинают с чистых полей', () => {
    // У нового провайдера свой ключ и своя модель; подставлять старые — врать.
    expect(company).toMatch(/setModel\(''\)[\s\S]{0,80}?setApiKey\(''\)[\s\S]{0,80}?setChanging\(true\)/)
  })

  it('из правки можно выйти, не сохраняя', () => {
    // Без отмены выйти из режима было бы можно только сохранив — то есть никак.
    expect(company).toMatch(/const resetEdit = \(\) => \{/)
    expect(company, 'Escape не отменяет правку').toMatch(/e\.key === 'Escape'\) resetEdit\(\)/)
  })

  it('после сохранения возвращаемся к карточке', () => {
    // Иначе форма остаётся открытой и кажется, что ничего не применилось.
    expect(company).toMatch(/setEditingModel\(false\)[\s\S]{0,80}?setChanging\(false\)/)
  })

  it('галочка картинок обновляет тот же ключ, что и запрос статуса', () => {
    // Инвалидировался чужой ключ 'llm-status' — карточка оставалась со старым
    // значением до перезагрузки страницы.
    const vision = company.match(/const saveVision = useMutation\(\{[\s\S]*?\n  \}\)/)?.[0] ?? ''
    expect(vision, 'мутация vision не найдена').not.toBe('')
    expect(vision).toMatch(/queryKey: \['company-llm', companyId\]/)
    expect(vision, 'снова инвалидируется несуществующий ключ').not.toMatch(/'llm-status'/)
  })
})

describe('страница ИИ проекта: то же поведение', () => {
  it('свой ключ показан карточкой, пока его не меняют', () => {
    /**
     * Именно блок карточки, а не любое похожее условие: такое же стоит у
     * кнопки сохранения ниже, и regex без якоря ловил его — карточку можно
     * было выключить целиком, а тест оставался зелёным.
     */
    expect(project).toMatch(
      /\{source === 'custom' && cfg\?\.hasKey && !changingCustom && \([\s\S]{0,400}?<Check /,
    )
  })

  it('форма — только пока ключа нет либо провайдера меняют', () => {
    expect(project).toMatch(/source === 'custom' && cfg && \(!cfg\.hasKey \|\| changingCustom\)/)
  })

  it('двух кнопок сохранения рядом не бывает', () => {
    // У карточки своя «Применить»; общая кнопка внизу в этот момент лишняя.
    expect(project).toMatch(/isAdmin && !\(source === 'custom' && cfg\?\.hasKey && !changingCustom\)/)
  })

  it('после сохранения форма закрывается', () => {
    expect(project).toMatch(/setChangingCustom\(false\)[\s\S]{0,120}?queryKey: \['ai-config', projectId\]/)
  })
})
