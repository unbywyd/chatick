import { describe, it, expect } from 'vitest'
import { mergeProfile } from './job-title.js'

// Должность: компания задаёт, проект переопределяет.
//
// Ошибка здесь тихая и обидная: человек пишет должность у компании, она не
// доезжает в проекты — и ассистент продолжает не знать, кто перед ним. Или
// наоборот: компанийное значение затирает то, что специально задали в проекте.

describe('пустое в проекте наследует компанию', () => {
  it('обе строки берутся у компании', () => {
    expect(mergeProfile({ jobTitle: '', responsibility: '' }, { jobTitle: 'Backend developer', responsibility: 'API' }))
      .toEqual({ jobTitle: 'Backend developer', responsibility: 'API' })
  })

  it('пробелы — это тоже «не задано»', () => {
    // Иначе случайный пробел в поле выключил бы наследование навсегда, и
    // человек искал бы причину, глядя на визуально пустую строку.
    expect(mergeProfile({ jobTitle: '   ', responsibility: '' }, { jobTitle: 'Designer', responsibility: '' }).jobTitle)
      .toBe('Designer')
  })

  it('нет записи в проекте — тоже наследуем', () => {
    expect(mergeProfile(null, { jobTitle: 'QA engineer', responsibility: '' }).jobTitle).toBe('QA engineer')
  })
})

describe('заполненное в проекте сильнее', () => {
  it('должность проекта побеждает компанийную', () => {
    // Саботаж: поменять порядок в mergeProfile — и то, что специально задали
    // в проекте, молча затрётся общим значением.
    expect(
      mergeProfile({ jobTitle: 'Release manager', responsibility: '' }, { jobTitle: 'Backend developer', responsibility: '' })
        .jobTitle,
    ).toBe('Release manager')
  })

  it('поля разрешаются независимо', () => {
    // Обычный случай: должность общая, а зона ответственности своя в проекте.
    expect(
      mergeProfile(
        { jobTitle: '', responsibility: 'Releases and deploys' },
        { jobTitle: 'Backend developer', responsibility: 'API' },
      ),
    ).toEqual({ jobTitle: 'Backend developer', responsibility: 'Releases and deploys' })
  })
})

describe('когда задавать нечего', () => {
  it('пусто с обеих сторон — пустая строка, не undefined', () => {
    // Пустая строка читается одинаково везде; undefined ломал бы вывод и
    // сравнения на стороне интерфейса.
    expect(mergeProfile(null, null)).toEqual({ jobTitle: '', responsibility: '' })
  })

  it('нет компании — остаётся значение проекта', () => {
    expect(mergeProfile({ jobTitle: 'DevOps', responsibility: '' }, null).jobTitle).toBe('DevOps')
  })

  it('результат обрезан по краям', () => {
    // В контекст ассистента и в интерфейс уходит ровно то, что видит человек.
    expect(mergeProfile({ jobTitle: '  Product owner  ', responsibility: '' }, null).jobTitle).toBe('Product owner')
  })
})
