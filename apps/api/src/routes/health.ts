import { Hono } from 'hono'
import { sql } from '../db/client.js'

export const health = new Hono()

health.get('/', async (c) => {
  let db = 'ok'
  try {
    await sql`select 1`
  } catch {
    db = 'down'
  }
  return c.json({ status: db === 'ok' ? 'ok' : 'degraded', db, ts: new Date().toISOString() })
})
