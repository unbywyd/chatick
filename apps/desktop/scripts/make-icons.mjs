import sharp from 'sharp'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Иконки трея и приложения из одного исходника (SPEC §8.33).
//
// В трее значок конкурирует за внимание с чужими: если рисунок не занимает
// всё поле, он читается как более мелкий, чем соседние, даже при том же
// размере файла. Поэтому viewBox подрезан вплотную к рисунку, а поля
// добавляем сами — ровно столько, сколько нужно, чтобы штрих не липнул к краю.

const here = dirname(fileURLToPath(import.meta.url))
const assets = join(here, '..', 'assets')

/** Галочка в пузыре. stroke — цвет контура, accent — цвет галочки. */
const bubble = (stroke, accent) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="2 2 44 44" fill="none">
  <path d="M24 4C12.4 4 3 12.7 3 23.5c0 5.4 2.4 10.3 6.2 13.8L8 44l8.4-3.2c2.4.7 4.9 1.2 7.6 1.2 11.6 0 21-8.7 21-19.5S35.6 4 24 4Z"
        stroke="${stroke}" stroke-width="4" stroke-linejoin="round"/>
  <path d="M15 24.5 21 30l12-12" stroke="${accent}" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`

/**
 * @param name    имя файла в assets
 * @param svg     исходник
 * @param size    сторона итоговой картинки
 * @param padding поля в пикселях с каждой стороны
 */
async function render(name, svg, size, padding) {
  const inner = size - padding * 2
  const drawn = await sharp(Buffer.from(svg)).resize(inner, inner).png().toBuffer()
  const out = await sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: drawn, top: padding, left: padding }])
    .png()
    .toBuffer()
  await writeFile(join(assets, name), out)
  console.log(`  ${name}  ${size}×${size}, рисунок ${inner}×${inner}`)
}

// В трее Windows значок живёт на тёмной панели — контур белый.
// Активный таймер подсвечиваем брендовым цветом целиком: разницу должно быть
// видно боковым зрением, а не при разглядывании.
await render('tray.png', bubble('#ffffff', '#d4f228'), 32, 1)
await render('tray-active.png', bubble('#d4f228', '#d4f228'), 32, 1)

// Иконка приложения — на своём фоне, поля ей не нужны совсем.
await render('icon.png', bubble('#ffffff', '#d4f228'), 256, 8)

console.log('\nГотово. Иконки пересобраны из favicon.svg.')
