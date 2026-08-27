// Поднять сохранённые уровни «чтение» до «запись» у участников.
//
// Умолчания роли member сменились: раньше ресурсы и версии стояли на чтении,
// теперь пишет во всех областях. Умолчания действуют на тех, у кого своих
// уровней нет, — а сохранённый явно «read» сильнее умолчания и остаётся.
//
//   node scripts/raise-member-levels.mjs                # показать, что изменится
//   node scripts/raise-member-levels.mjs --apply        # записать
//   node scripts/raise-member-levels.mjs --company=<id> # только одна компания
//
// Трогает ТОЛЬКО значение 'read' и только у member: 'none' — это осознанный
// запрет, его поднимать нельзя, а у owner/admin уровни и так полные.
//
// Старый плоский формат ({"resources.manage":false}) не трогаем вовсе: он
// умеет лишь ПОВЫШАТЬ уровень над умолчанием и никогда не понижает — такие
// записи выправились сами вместе со сменой умолчаний.
import postgres from 'postgres'
import { readFileSync } from 'node:fs'

const apply = process.argv.includes('--apply')
const companyArg = process.argv.find((a) => a.startsWith('--company='))?.slice(10)

const url = (readFileSync(new URL('../.env', import.meta.url), 'utf8').match(/^DATABASE_URL=(.+)$/m) ?? [])[1]
if (!url) throw new Error('DATABASE_URL не найден в apps/api/.env')

const DOMAINS = ['tasks', 'files', 'resources', 'documents', 'notes', 'releases']
const sql = postgres(url, { max: 1 })

const rows = await sql.unsafe(`
  SELECT pm.id, pm.permissions, pm.role, u.name AS user_name, p.name AS project_name, c.name AS company_name
  FROM project_members pm
  JOIN projects p ON p.id = pm.project_id
  JOIN companies c ON c.id = p.company_id
  JOIN users u ON u.id = pm.user_id
  WHERE pm.role = 'member'${companyArg ? ` AND c.id = '${companyArg}'` : ''}
`)

let changed = 0
for (const r of rows) {
  let parsed
  try {
    parsed = JSON.parse(r.permissions || '{}')
  } catch {
    continue
  }
  const next = { ...parsed }
  const raised = []
  for (const d of DOMAINS) {
    if (next[d] === 'read') {
      next[d] = 'write'
      raised.push(d)
    }
  }
  if (!raised.length) continue
  changed++
  console.log(`${r.company_name} / ${r.project_name} / ${r.user_name}: ${raised.join(', ')} → write`)
  if (apply) await sql.unsafe(`UPDATE project_members SET permissions = $1 WHERE id = $2`, [JSON.stringify(next), r.id])
}

console.log(apply ? `\nЗаписано: ${changed}` : `\nБудет изменено: ${changed} (запуск с --apply)`)
await sql.end()
