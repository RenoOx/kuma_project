import { config as loadDotenv } from 'dotenv'
import { defineConfig } from 'drizzle-kit'

loadDotenv()

const isTest = process.env.NODE_ENV === 'test'
const databaseUrl = isTest ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL

if (!databaseUrl) {
  throw new Error(
    `Missing ${isTest ? 'TEST_DATABASE_URL' : 'DATABASE_URL'} for drizzle-kit (NODE_ENV=${process.env.NODE_ENV ?? 'undefined'})`,
  )
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dbCredentials: {
    url: databaseUrl,
  },
  strict: true,
  verbose: true,
})