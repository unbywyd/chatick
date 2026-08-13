import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { buildTypeOf, eventComment, stageForStatus, verifyExpoSignature } from './expo-webhook.js'

// Приём сборок из Expo.
//
// Ручка публичная и двигает релизы, поэтому главное здесь — подпись. Формат
// сверен с документацией Expo: заголовок expo-signature, HMAC-SHA1 от СЫРОГО
// тела, префикс «sha1=».

describe('подпись вебхука', () => {
  const secret = 'super-secret-at-least-16-chars'
  const body = '{"status":"finished","platform":"ios"}'
  const good = `sha1=${createHmac('sha1', secret).update(body).digest('hex')}`

  it('настоящая подпись принимается', () => {
    expect(verifyExpoSignature(body, good, secret)).toBe(true)
  })

  it('чужой секрет отвергается', () => {
    expect(verifyExpoSignature(body, good, 'another-secret-16-chars!')).toBe(false)
  })

  it('изменённое тело отвергается', () => {
    // Ровно то, ради чего подпись и нужна: подменить платформу нельзя.
    expect(verifyExpoSignature('{"status":"finished","platform":"android"}', good, secret)).toBe(false)
  })

  it('без заголовка — отказ, а не пропуск', () => {
    expect(verifyExpoSignature(body, undefined, secret)).toBe(false)
  })

  it('подпись без префикса sha1= не принимается', () => {
    const bare = createHmac('sha1', secret).update(body).digest('hex')
    expect(verifyExpoSignature(body, bare, secret)).toBe(false)
  })
})

describe('разбор события', () => {
  it('платформы EAS отображаются в наши типы сборки', () => {
    expect(buildTypeOf('ios')).toBe('ios')
    expect(buildTypeOf('android')).toBe('android')
    // Неизвестную платформу пропускаем, а не пишем мусор в поле, по которому
    // строится сводка «что в проде».
    expect(buildTypeOf('web')).toBeNull()
    expect(buildTypeOf(undefined)).toBeNull()
  })

  it('стадию двигаем только на успешной сборке', () => {
    expect(stageForStatus('ios', 'finished')).toBe('building')
    // errored не откатывает: человек мог уже отметить TestFlight руками.
    expect(stageForStatus('ios', 'errored')).toBeNull()
    expect(stageForStatus('ios', 'in-progress')).toBeNull()
  })

  it('падение сборки объясняется в ленте', () => {
    const c = eventComment({ status: 'errored', error: { message: 'Gradle build failed' } })
    expect(c).toContain('Gradle build failed')
  })
})
