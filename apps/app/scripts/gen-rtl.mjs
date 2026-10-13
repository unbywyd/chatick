// Зеркальные правила для иврита (RTL) из стилей веба v2.
//
// Стили макета написаны физическими сторонами: padding:0 14px 0 6px,
// margin-left:auto, left:12px, border-left, text-align:left. В иврите это
// оставляло иконки и отступы «с той же стороны», что и в русском. Руками
// переписывать сотни правил на логические свойства — долго и легко
// пропустить; генератор находит несимметричные правила и пишет к каждому
// зеркальное под .app[dir='rtl'].
//
// Запуск: node scripts/gen-rtl.mjs  → src/v2/styles/rtl.css (файл не править
// руками — он перезаписывается).
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const postcss = require(require.resolve('postcss', { paths: [join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'node_modules', '.pnpm', 'postcss@8.5.22', 'node_modules')] }))

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'v2', 'styles')
const files = readdirSync(dir).filter((f) => f.endsWith('.css') && f !== 'rtl.css')

const split = (v) => postcss.list.space(v)
const SWAP = { left: 'right', right: 'left' }

function mirrorDecl(d, rule) {
  const p = d.prop
  const v = d.value
  const has = (q) => rule.nodes.some((n) => n.type === 'decl' && n.prop === q)
  const get = (q) => rule.nodes.find((n) => n.type === 'decl' && n.prop === q)?.value
  const out = []
  if (p === 'padding' || p === 'margin' || p === 'border-width' || p === 'border-color' || p === 'border-style') {
    const a = split(v)
    if (a.length === 4 && a[1] !== a[3]) out.push([p, `${a[0]} ${a[3]} ${a[2]} ${a[1]}`])
  } else if (/^(padding|margin)-(left|right)$/.test(p)) {
    const [, kind, side] = p.match(/^(padding|margin)-(left|right)$/)
    const other = `${kind}-${SWAP[side]}`
    if (has(other)) {
      if (get(other) !== v) out.push([p, get(other)], [other, v])
    } else out.push([p, kind === 'margin' && v === 'auto' ? '0' : '0'], [other, v])
  } else if (p === 'left' || p === 'right') {
    const other = SWAP[p]
    if (has(other)) {
      if (get(other) !== v) out.push([p, get(other)], [other, v])
    } else out.push([p, 'auto'], [other, v])
  } else if (/^border-(left|right)(-width|-color|-style)?$/.test(p)) {
    const m = p.match(/^border-(left|right)(.*)$/)
    const other = `border-${SWAP[m[1]]}${m[2]}`
    if (has(other)) {
      if (get(other) !== v) out.push([p, get(other)], [other, v])
    } else out.push([p, m[2] ? (m[2] === '-width' ? '0' : 'initial') : '0'], [other, v])
  } else if (p === 'border-radius') {
    const parts = v.split('/').map((x) => split(x.trim()))
    const flip = (a) => {
      if (a.length === 2) return [a[1], a[0]]
      if (a.length === 3) return [a[1], a[0], a[1], a[2]]
      if (a.length === 4) return [a[1], a[0], a[3], a[2]]
      return a
    }
    const f = parts.map(flip)
    const same = parts.every((x, i) => x.join(' ') === f[i].join(' '))
    if (!same) out.push([p, f.map((x) => x.join(' ')).join(' / ')])
  } else if (/^border-(top|bottom)-(left|right)-radius$/.test(p)) {
    const m = p.match(/^border-(top|bottom)-(left|right)-radius$/)
    const other = `border-${m[1]}-${SWAP[m[2]]}-radius`
    if (has(other)) {
      if (get(other) !== v) out.push([p, get(other)], [other, v])
    } else out.push([p, '0'], [other, v])
  } else if (p === 'text-align' && (v === 'left' || v === 'right')) {
    out.push([p, SWAP[v]])
  } else if (p === 'float' && (v === 'left' || v === 'right')) {
    out.push([p, SWAP[v]])
  }
  return out
}

function scope(sel) {
  return postcss.list
    .comma(sel)
    .map((s) => {
      if (/\[dir=/.test(s) || /^html\b|^body\b|^:root/.test(s)) return null
      if (s.startsWith(':where(.app)')) return s.replace(':where(.app)', ":where(.app[dir='rtl'])")
      if (/^\.app(?=[.:\s\[]|$)/.test(s)) return s.replace(/^\.app/, ".app[dir='rtl']")
      return `.app[dir='rtl'] ${s}`
    })
    .filter(Boolean)
    .join(',')
}

let count = 0
const out = postcss.root()
out.append(postcss.comment({ text: ' Сгенерировано scripts/gen-rtl.mjs из стилей v2 — не править руками. ' }))
for (const f of files) {
  const root = postcss.parse(readFileSync(join(dir, f), 'utf8'), { from: f })
  root.walkRules((rule) => {
    if (rule.parent?.type === 'atrule' && /keyframes/.test(rule.parent.name)) return
    const decls = []
    for (const n of rule.nodes) if (n.type === 'decl') decls.push(...mirrorDecl(n, rule))
    if (!decls.length) return
    const sel = scope(rule.selector)
    if (!sel) return
    const r = postcss.rule({ selector: sel })
    for (const [prop, value] of decls) r.append(postcss.decl({ prop, value }))
    count++
    // Внутри @media — в том же @media.
    let target = out
    let p = rule.parent
    const chain = []
    while (p && p.type === 'atrule') {
      chain.unshift(p)
      p = p.parent
    }
    for (const at of chain) {
      const wrap = postcss.atRule({ name: at.name, params: at.params })
      target.append(wrap)
      target = wrap
    }
    target.append(r)
  })
}
writeFileSync(join(dir, 'rtl.css'), out.toString())
console.log(`rtl.css: ${count} mirrored rules from ${files.join(', ')}`)
