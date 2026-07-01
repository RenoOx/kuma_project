// One-shot verifier: connects to PROD_DATABASE_URL and lists the
// appointments columns we expect after migration 0004. NOT wired into npm
// scripts on purpose — run via tsx inline when validating a prod migration.
import { config as loadDotenv } from 'dotenv'
import postgres from 'postgres'

loadDotenv()

const url = process.env.PROD_DATABASE_URL
if (!url) {
  // biome-ignore lint/suspicious/noConsoleLog: short-lived diagnostic script
  console.error('PROD_DATABASE_URL not set in .env')
  process.exit(1)
}

const sql = postgres(url, { max: 1 })

try {
  const rows = await sql<{ column_name: string; data_type: string; is_nullable: string }[]>`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'appointments'
      AND column_name IN ('reminder_24h_sent_at', 'reminder_2h_sent_at')
    ORDER BY column_name
  `
  // biome-ignore lint/suspicious/noConsoleLog: diagnostic output
  console.log(JSON.stringify(rows, null, 2))
  if (rows.length !== 2) {
    // biome-ignore lint/suspicious/noConsoleLog: diagnostic output
    console.error(`expected 2 reminder columns in prod, got ${rows.length}`)
    process.exit(2)
  }
} finally {
  await sql.end({ timeout: 1 }).catch(() => undefined)
}
