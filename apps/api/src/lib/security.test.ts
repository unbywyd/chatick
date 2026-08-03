import { describe, expect, it } from 'vitest'
import { isPrivateIp } from './ssrf.js'
import { sign, verify, newSecret } from './webhooks.js'
import { safePath } from './enter-link.js'
import { nameFromUrl } from './site-icon.js'

// Тесты на то, где ошибка дороже всего: защита от SSRF, подписи вебхуков и
// проверка путей перехода. Всё это молчаливые механизмы — сломавшись, они не
// падают, а просто перестают защищать, и заметить это по интерфейсу нельзя.

describe('SSRF: куда серверу ходить нельзя', () => {
  it('запрещает петлевые и внутренние адреса', () => {
    for (const ip of [
      '127.0.0.1',
      '127.1.2.3',
      '0.0.0.0',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // метаданные облака — главная цель такой атаки
      '100.64.0.1', // CGNAT
      '::1',
      'fc00::1',
      'fe80::1',
      '::ffff:127.0.0.1', // v4 внутри v6 — обход «в лоб»
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true)
    }
  })

  it('пропускает обычные публичные адреса', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '148.251.137.162', '2606:4700::1111']) {
      expect(isPrivateIp(ip), ip).toBe(false)
    }
  })

  it('считает мусор небезопасным, а не безопасным', () => {
    // Неразобранный адрес должен трактоваться в пользу запрета: пропустить
    // непонятное опаснее, чем отказать.
    for (const junk of ['', 'не-адрес', '1.2.3']) {
      expect(isPrivateIp(junk), junk).toBe(true)
    }
  })
})

describe('Подпись вебхуков', () => {
  const secret = newSecret()
  const body = JSON.stringify({ event: 'task.created', data: { taskId: 't1' } })
  const ts = 1_700_000_000

  it('своя подпись проходит', () => {
    expect(verify(secret, body, ts, sign(secret, body, ts))).toBe(true)
  })

  it('чужой секрет не проходит', () => {
    expect(verify(newSecret(), body, ts, sign(secret, body, ts))).toBe(false)
  })

  it('подменённое тело не проходит', () => {
    const other = JSON.stringify({ event: 'task.created', data: { taskId: 'ПОДМЕНА' } })
    expect(verify(secret, other, ts, sign(secret, body, ts))).toBe(false)
  })

  it('подменённое время не проходит', () => {
    // Время внутри подписи — иначе перехваченный запрос повторяли бы вечно.
    expect(verify(secret, body, ts + 1, sign(secret, body, ts))).toBe(false)
  })
})

describe('Ссылка входа: куда можно вести', () => {
  it('принимает внутренние пути', () => {
    expect(safePath('/start')).toBe('/start')
    expect(safePath('/p/abc/tasks')).toBe('/p/abc/tasks')
  })

  it('отвергает чужие адреса', () => {
    // Полный адрес превратил бы ссылку в открытый редиректор: человек видит
    // настоящий домен Chatick и уходит на подделку.
    expect(safePath('https://evil.example.com')).toBeNull()
    expect(safePath('//evil.example.com')).toBeNull()
    expect(safePath('javascript:alert(1)')).toBeNull()
    expect(safePath('http://evil.com/p/1')).toBeNull()
  })

  it('отвергает пустое', () => {
    expect(safePath('')).toBeNull()
    expect(safePath(null)).toBeNull()
    expect(safePath(undefined)).toBeNull()
  })
})

describe('Имя ресурса из ссылки', () => {
  it('берёт домен без www', () => {
    expect(nameFromUrl('https://www.figma.com/')).toBe('figma.com')
    expect(nameFromUrl('https://jira.acme.com')).toBe('jira.acme.com')
  })

  it('добавляет последний кусок пути, чтобы различать проекты', () => {
    expect(nameFromUrl('https://github.com/acme/repo')).toBe('github.com/repo')
  })

  it('не падает на мусоре', () => {
    expect(nameFromUrl('это не ссылка')).toBe('')
  })
})
