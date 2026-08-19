import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { env } from '../env.js'

// AES-256-GCM: конфиденциальность + целостность (подмена шифротекста в БД детектится).
// Формат хранения: base64(nonce[12] | ciphertext | authTag[16])
// Ключ — 32 байта hex из ENCRYPTION_KEY, живёт только в .env.

function key(): Buffer {
  const k = Buffer.from(env.ENCRYPTION_KEY, 'hex')
  if (k.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes hex (64 chars)')
  return k
}

export function encrypt(plaintext: string): string {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), nonce)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]).toString('base64')
}

export function decrypt(stored: string): string {
  const buf = Buffer.from(stored, 'base64')
  const nonce = buf.subarray(0, 12)
  const tag = buf.subarray(buf.length - 16)
  const ct = buf.subarray(12, buf.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key(), nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}

/**
 * То же самое для двоичных данных.
 *
 * encrypt() выше принимает строку и отдаёт base64 — для пароля это удобно, а
 * для файла означало бы гонять его через utf8 и base64 туда-обратно, раздувая
 * на треть и ломаясь на любом байте, который не складывается в валидный
 * символ. Здесь тот же AES-256-GCM и тот же ключ, но вход и выход — байты.
 *
 * Формат: nonce[12] | ciphertext | authTag[16] — как и у строкового варианта,
 * только без base64-обёртки. GCM даёт не только скрытность, но и целостность:
 * подменённый в хранилище байт не расшифруется, а не отдастся мусором.
 */
export function encryptBytes(plain: Buffer): Buffer {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), nonce)
  const ct = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([nonce, ct, cipher.getAuthTag()])
}

export function decryptBytes(stored: Buffer): Buffer {
  // Меньше, чем nonce + tag, — это не наш файл, а обрезок. Расшифровка такого
  // упала бы где-то внутри с невнятной ошибкой; лучше сказать прямо.
  if (stored.length < 12 + 16) throw new Error('Encrypted blob is too short to be valid')
  const nonce = stored.subarray(0, 12)
  const tag = stored.subarray(stored.length - 16)
  const ct = stored.subarray(12, stored.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key(), nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()])
}
