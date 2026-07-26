import sharp from 'sharp'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Иконки трея и приложения из фирменных логотипов (SPEC §8.33).
//
//   node scripts/make-icons.mjs
//
// Источники в logos/:
//   light-logo.png — белый пузырь, зелёная галочка, без подложки
//   dark-logo.png  — то же чёрным
//   logo.png       — версия на чёрной скруглённой плашке
//
// Логотипы нарисованы под мелкий размер (толстые штрихи), поэтому ничего не
// перерисовываем — только масштабируем. В трее значок конкурирует за внимание
// с чужими: если он не занимает всё поле, читается как более мелкий при том же
// размере файла, поэтому масштабируем впритык.

const here = dirname(fileURLToPath(import.meta.url))
const assets = join(here, '..', 'assets')
const logos = join(here, '..', '..', '..', 'logos')

async function render(name, source, size, recolor) {
  const img = sharp(join(logos, source)).resize(size, size, {
    fit: 'contain',
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })

  if (!recolor) {
    await writeFile(join(assets, name), await img.png().toBuffer())
    console.log(`  ${name.padEnd(22)} ${size}×${size}  ← ${source}`)
    return
  }

  // Идущий таймер должен читаться боковым зрением. tint() красит всё разом и
  // разницы почти не даёт, поэтому перекрашиваем только пузырь, оставляя
  // галочку прежней: значок узнаётся, а состояние видно.
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const [r, g, b] = recolor
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 16) continue
    // галочка — зелёная; всё остальное непрозрачное и есть пузырь
    const isCheck = data[i + 1] > 140 && data[i] < 170 && data[i + 2] < 120
    if (isCheck) continue
    data[i] = r
    data[i + 1] = g
    data[i + 2] = b
  }
  const out = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer()
  await writeFile(join(assets, name), out)
  console.log(`  ${name.padEnd(22)} ${size}×${size}  ← ${source}  (пузырь перекрашен)`)
}

// Трей Windows — панель тёмная, значок белый. Светлая тема панели встречается
// редко, но для неё держим чёрный вариант рядом: main.cjs выберет по теме ОС.
await render('tray.png', 'light-logo.png', 32)
await render('tray-light.png', 'dark-logo.png', 32) // для СВЕТЛОЙ панели — тёмный значок
await render('tray-active.png', 'light-logo.png', 32, [0xd4, 0xf2, 0x28])
await render('tray-active-light.png', 'dark-logo.png', 32, [0x6b, 0x7f, 0x14])

// Иконка приложения — с плашкой: у неё свой фон, скругление там к месту.
await render('icon.png', 'logo.png', 256)

// Точка непрочитанных на кнопке в панели задач. Тот же цвет, что рисует
// withDot() в трее: две точки об одном и том же не должны различаться.
// Красный, а не брендовый: лайм в трее уже занят под идущий таймер.
await writeFile(
  join(assets, 'badge.png'),
  await sharp({
    create: { width: 32, height: 32, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      {
        input: Buffer.from(
          // Windows растягивает наложение на угол кнопки — рисуем точку
          // поменьше, иначе она перекрывает сам значок.
          `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
             <circle cx="21" cy="11" r="10" fill="#e5484d"/>
           </svg>`,
        ),
        top: 0,
        left: 0,
      },
    ])
    .png()
    .toBuffer(),
)
console.log('  badge.png              32×32  (точка непрочитанных)')

console.log('Готово.')
