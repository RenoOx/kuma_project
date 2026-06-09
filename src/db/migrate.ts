import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { logger } from '../config/logger.js'
import { db, queryClient } from './client.js'

async function main(): Promise<void> {
  logger.info('running migrations')
  await migrate(db, { migrationsFolder: './src/db/migrations' })
  logger.info('migrations complete')
  await queryClient.end()
}

main().catch(async (err) => {
  logger.fatal({ err }, 'migration failed')
  await queryClient.end({ timeout: 1 }).catch(() => undefined)
  process.exit(1)
})
