import postgres from 'postgres'
import { readFileSync } from 'node:fs'
const env=Object.fromEntries(readFileSync('.env','utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#'))
  .map(l=>{const i=l.indexOf('=');return[l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^["']|["']$/g,'')]}))
for(const k of Object.keys(env)) process.env[k]=env[k]
const { resolveStorage, getObjectStream } = await import('./dist/lib/s3.js')
const sql=postgres(env.DATABASE_URL,{ssl:env.DATABASE_URL.includes('sslmode=require')?'require':false,onnotice:()=>{}})
const [f]=await sql`
  select f.name, f.mime, f.key, f.project_id, f.size from files f
  join messages m on m.id=f.message_id
  where m.mode='ai' and f.mime like 'image/%' and f.deleted_at is null
  order by f.created_at desc limit 1`
if(!f){console.log('картинок в ai-диалоге нет');process.exit(0)}
console.log('открываю:', f.name, '|', f.mime, '|', f.size, 'байт')
const storage = await resolveStorage(f.project_id)
const { body } = await getObjectStream(storage, f.key)
const chunks=[]; for await (const c of body) chunks.push(Buffer.from(c))
const b64 = Buffer.concat(chunks).toString('base64')
console.log('прочитано:', chunks.length && Buffer.concat(chunks).length, 'байт | base64:', b64.length, 'символов')
console.log('=> view_image вернёт картинку модели:', b64.length>100 ? 'ДА' : 'нет')
await sql.end()
