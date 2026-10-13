// Герои стола (v2) из набора VexelKit — в приложение.
//
// Набор ведёт пользователь в студии VexelKit: добавил героев — запускаем
//   skey run --only VEXELKIT -- node scripts/heroes-sync.mjs
// Скрипт берёт все готовые картинки набора, обрезает прозрачные поля, кладёт
// WebP в apps/app/public/heroes/<slug>.webp и обновляет два манифеста:
// apps/app/src/v2/heroes.json (картинки для клиента) и apps/api/src/lib/heroes-list.ts
// (допустимые герои для сервера). Тест heroes.test.ts сверяет их между собой.
//
// Слаг героя хранится у людей в базе, поэтому у уже известной картинки он не
// меняется никогда: соответствие «картинка VexelKit → слаг» живёт в манифесте.
// Новой картинке слаг даётся из её названия — поправьте его в манифесте руками,
// если вышло неудачно, ДО того как героя кому-то раздали.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const PACK = process.env.HEROES_PACK ?? '79fb9c16-9ffe-4608-95b9-33334ea678db'
const KEY = process.env.VEXELKIT
if (!KEY) throw new Error('VEXELKIT is not set: skey run --only VEXELKIT -- node scripts/heroes-sync.mjs')
const H = { authorization: `Bearer ${KEY}` }

const here = dirname(fileURLToPath(import.meta.url))
const appDir = join(here, '../../app')
const outDir = join(appDir, 'public/heroes')
const appManifest = join(appDir, 'src/v2/heroes.json')
const apiManifest = join(here, '../src/lib/heroes-list.ts')

/** Уже известные герои: id картинки → слаг. */
const known = existsSync(appManifest) ? JSON.parse(readFileSync(appManifest, 'utf8')) : []
const byImage = new Map(known.map((h) => [h.image, h]))
const taken = new Set(known.map((h) => h.slug))

const STOP = new Set(['a', 'an', 'the', 'in', 'on', 'with', 'and', 'of', 'cute', 'old', 'wise', 'adorable', 'friendly', 'stylish', 'small', 'little', 'character', 'sitting', 'seated', 'resting', 'leaning', 'forward', 'chair', 'armchair', 'angry', 'happy', 'cheerful', 'cartoon', 'toy', 'plush', 'red', 'green', 'blue', 'pink', 'grey', 'gray', 'orange', 'brown', 'purple', 'yellow', 'black', 'white', 'at', 'table'])
function slugFor(title) {
  const words = (title || 'hero').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w))
  const base = words[0] || 'hero'
  let s = base
  for (let i = 2; taken.has(s); i++) s = `${base}-${i}`
  taken.add(s)
  return s
}

const pack = await (await fetch(`https://vexelkit.com/api/v1/packs/${PACK}`, { headers: H })).json()
if (pack.error) throw new Error(`${pack.error}: ${pack.message}`)
mkdirSync(outDir, { recursive: true })

const out = []
for (const im of [...(pack.images ?? [])].sort((a, b) => a.position - b.position)) {
  if (im.status !== 'ready' || !im.id) continue
  const prev = byImage.get(im.id)
  // Дубль или неудачный — помечен в манифесте "skip": true и в приложение не идёт.
  if (prev?.skip) {
    out.push(prev)
    continue
  }
  const slug = prev?.slug ?? slugFor(im.title)
  const res = await fetch(`https://vexelkit.com/api/v1/images/${im.id}/download?format=png`, { headers: H })
  if (!res.ok) {
    console.log('skip', im.id, res.status)
    if (prev) out.push(prev)
    continue
  }
  // Поля по альфе — герой должен начинаться ровно там, где начинается картинка:
  // по нижнему краю (рукам) он прикладывается к бортику стола.
  const buf = await sharp(Buffer.from(await res.arrayBuffer()))
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 8 })
    .resize({ width: 360 })
    .webp({ quality: 86, effort: 6 })
    .toBuffer()
  writeFileSync(join(outDir, `${slug}.webp`), buf)
  const meta = await sharp(buf).metadata()
  out.push({ slug, image: im.id, title: im.title ?? '', w: meta.width, h: meta.height })
  console.log(prev ? 'updated' : 'NEW    ', slug.padEnd(12), meta.width, 'x', meta.height, im.title ?? '')
}

// Раньше известный герой пропал из набора — не выбрасываем: он уже может быть у людей.
for (const h of known) if (!out.some((x) => x.slug === h.slug)) {
  console.log('kept (not in pack anymore)', h.slug)
  out.push(h)
}

writeFileSync(appManifest, JSON.stringify(out, null, 2) + '\n')
writeFileSync(
  apiManifest,
  `// Сгенерировано scripts/heroes-sync.mjs — руками не править: слаги берутся из apps/app/src/v2/heroes.json.\nexport const HEROES = ${JSON.stringify(out.filter((h) => !h.skip).map((h) => h.slug))} as const\n`,
)
console.log(`${out.filter((h) => !h.skip).length} heroes (+${out.filter((h) => h.skip).length} skipped) → ${outDir}`)
