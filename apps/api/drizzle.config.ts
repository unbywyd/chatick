import { config } from 'dotenv'
config()

import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  // Тот же журнал, что у src/db/migrate.ts: старый помнит прежнюю нумерацию.
  migrations: { table: '__drizzle_migrations_v2', schema: 'drizzle' },
  verbose: true,
  strict: true,
})
