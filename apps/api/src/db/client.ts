import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '../env.js'
import * as schema from './schema.js'

// Single shared connection pool. postgres.js manages pooling internally.
const sql = postgres(env.DATABASE_URL, {
  max: 10,
  ssl: env.DATABASE_URL.includes('sslmode=no-verify') ? { rejectUnauthorized: false } : undefined,
  onnotice: () => {},
})

export const db = drizzle(sql, { schema })
export { sql }
