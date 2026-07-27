// Кладём LICENSE из корня рядом с приложением и на экран установки.
//
// Копируем при сборке, а не держим вторую копию в репозитории: копия
// разошлась бы с оригиналом при первой же правке лицензии, и в установщик
// поехали бы вчерашние условия.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = path.resolve(here, '../../../LICENSE')
const dest = path.resolve(here, '../LICENSE.txt')

if (!fs.existsSync(src)) {
  console.error('LICENSE не найден в корне репозитория:', src)
  process.exit(1)
}

// NSIS показывает файл как есть — с CRLF он читается в блокноте установщика
const text = fs.readFileSync(src, 'utf8').replace(/\r?\n/g, '\r\n')
fs.writeFileSync(dest, text)
console.log('LICENSE.txt подготовлен для установщика')
