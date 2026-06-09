import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '../config/env.js'
import { logger } from '../config/logger.js'
import * as schema from './schema/index.js'

const isDev = env.NODE_ENV === 'development'

export const queryClient = postgres(env.DATABASE_URL, {
  max: 10,
  onnotice: (notice) => {
    logger.debug({ notice }, 'postgres notice')
  },
})

export const db = drizzle(queryClient, {
  schema,
  logger: isDev
    ? {
        logQuery: (query, params) => {
          logger.debug({ query, params }, 'drizzle query')
        },
      }
    : false,
})

export type Db = typeof db
export type Schema = typeof schema
