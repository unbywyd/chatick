import { Buffer } from 'node:buffer'
import sharp from 'sharp'
import { nanoid } from 'nanoid'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { s3Client, s3Bucket, S3_KEY_PREFIX } from './s3.js'
import { assertPublic } from './ssrf.js'

// Перенос чужой аватарки к нам (SPEC §8.50).
//
// Ссылку на чужой сервер хранить нельзя: у внешних систем аватары обычно лежат
// в приватном бакете, и вместо картинки получится битый значок. Плюс каждая
// такая ссылка — это утечка: их сервер видит, кто из наших смотрит на кого.
//
// Поэтому скачиваем, ужимаем и кладём в своё хранилище.

/**
 * Забрать картинку по ссылке и положить в наше хранилище.
 * null, если скачать не вышло: аватар не повод ронять создание человека.
 */
export async function adoptAvatar(userId: string, pictureUrl: string): Promise<{ url: string; key: string } | null> {
  try {
    // Адрес приходит снаружи — проверяем, что он ведёт в интернет, а не в нашу
    // внутреннюю сеть: иначе внешняя система заставит нас читать localhost.
    await assertPublic(new URL(pictureUrl))

    const res = await fetch(pictureUrl, { signal: AbortSignal.timeout(7000) })
    if (!res.ok) return null
    const raw = Buffer.from(await res.arrayBuffer())
    if (!raw.length || raw.length > 5 * 1024 * 1024) return null

    // sharp заодно проверяет, что это действительно картинка: подсунуть под
    // видом аватара что-то другое не выйдет.
    const buffer = await sharp(raw, { failOn: 'none' })
      .rotate()
      .resize(256, 256, { fit: 'cover' })
      .webp({ quality: 85 })
      .toBuffer()

    const key = `${S3_KEY_PREFIX}/avatars/${userId}-${nanoid(6)}.webp`
    await s3Client().send(
      new PutObjectCommand({ Bucket: s3Bucket(), Key: key, Body: buffer, ContentType: 'image/webp' }),
    )
    // Версия в адресе: иначе браузер отдаст старую картинку из кэша.
    const url = `${process.env.API_PUBLIC_URL || 'https://api.chatick.com'}/api/v1/auth/avatar/${userId}?v=${Date.now()}`
    return { url, key }
  } catch (e) {
    console.error('[avatar] не удалось забрать картинку:', e)
    return null
  }
}
