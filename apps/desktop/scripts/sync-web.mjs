// Копирует собранный веб внутрь десктопа — нужно только для LOAD_MODE='bundled'.
// В обычном режиме приложение грузит app.chatick.com и эта папка не участвует.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = path.resolve(here, '../../app/dist')
const dest = path.resolve(here, '../web')

if (!fs.existsSync(src)) {
  console.error('Сначала соберите веб: pnpm --filter @chatick/app build')
  process.exit(1)
}

fs.rmSync(dest, { recursive: true, force: true })
fs.cpSync(src, dest, { recursive: true })

// Панель раздаётся с сайта, чтобы её правки доезжали без переустановки —
// но вшитая копия остаётся запасной на случай, когда сети нет. Держим их
// одинаковыми: разошедшиеся версии дают неповторимые баги «у меня работает».
const panelSrc = path.resolve(here, '../panel.html')
const panelPublic = path.resolve(here, '../../app/public/panel.html')
fs.copyFileSync(panelSrc, panelPublic)
console.log('панель синхронизирована с public/')
console.log(`web скопирован: ${src} -> ${dest}`)
