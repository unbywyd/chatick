import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HEROES } from './heroes-list.js'

/**
 * Герои стола: каталог сервера (heroes-list.ts), манифест клиента
 * (apps/app/src/v2/heroes.json) и картинки в public/heroes — одно и то же.
 * Расхождение значит: сервер раздаст героя, которого клиент не нарисует, или
 * клиент покажет героя, которого сервер не примет при выборе в профиле.
 */
const app = join(import.meta.dirname, '../../../app')
const manifest = JSON.parse(readFileSync(join(app, 'src/v2/heroes.json'), 'utf8')) as { slug: string; skip?: boolean; w?: number; h?: number }[]
const read = (p: string) => readFileSync(join(import.meta.dirname, p), 'utf8')

describe('каталог героев', () => {
  it('сервер и клиент знают одних и тех же героев', () => {
    expect([...HEROES]).toEqual(manifest.filter((h) => !h.skip).map((h) => h.slug))
  })

  it('слаги уникальны — они хранятся у людей в базе', () => {
    expect(new Set(manifest.map((h) => h.slug)).size).toBe(manifest.length)
  })

  it('у каждого героя есть картинка и размеры', () => {
    for (const h of manifest.filter((x) => !x.skip)) {
      expect(existsSync(join(app, `public/heroes/${h.slug}.webp`)), h.slug).toBe(true)
      expect(h.w && h.h, `${h.slug}: нет размеров — сцена не впишет героя`).toBeTruthy()
    }
  })

  it('стол и мяч каждого цвета на месте', () => {
    expect(existsSync(join(app, 'public/table/table.webp'))).toBe(true)
    // сцена берёт мяч по состоянию: heatOf (warm/hot/burn) — и для своего хода, и для чужого; ждём клиента (client)
    for (const k of ['warm', 'hot', 'burn', 'client']) expect(existsSync(join(app, `public/table/ball-${k}.webp`)), k).toBe(true)
  })
})

describe('раздача и выбор', () => {
  it('героя выдают при входе и людям за столом', () => {
    const auth = read('../routes/auth.ts')
    const me = auth.indexOf("auth.get('/me'")
    expect(auth.slice(me, me + 600)).toMatch(/ensureHeroes\(\[sub\]\)/)
    const ball = read('../routes/ball.ts')
    expect(ball).toMatch(/export async function tableScenes/)
    expect(ball.slice(ball.indexOf('export async function tableScenes'))).toMatch(/ensureHeroes\(everyone\)/)
  })

  it('без повторов: берём из реже всего занятых в компаниях человека', () => {
    const lib = read('./heroes.ts')
    expect(lib).toMatch(/const pool = HEROES\.filter\(\(h\) => \(use\.get\(h\) \?\? 0\) === min\)/)
  })

  it('в профиле принимается только герой из каталога', () => {
    const auth = read('../routes/auth.ts')
    expect(auth).toMatch(/if \(!isHero\(hero\)\) return c\.json\(\{ error: 'Unknown hero' \}, 400\)/)
  })
})
