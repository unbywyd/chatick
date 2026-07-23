import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '../env.js'

// Migrations use a dedicated single connection (not the app pool).
const sql = postgres(env.DATABASE_URL, {
  max: 1,
  ssl: env.DATABASE_URL.includes('sslmode=no-verify') ? { rejectUnauthorized: false } : undefined,
})

const db = drizzle(sql)

console.log('Running migrations...')
await migrate(db, { migrationsFolder: './drizzle' })
console.log('✅ Migrations complete')
await sql.end()
