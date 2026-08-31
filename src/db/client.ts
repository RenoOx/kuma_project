import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '../config/env.js'
import { logger } from '../config/logger.js'
import * as schema from './schema/index.js'

const isDev = env.NODE_ENV === 'development'

// Single source for every environment. There is no separate test database:
// the DB-backed suite was removed, so nothing here runs against a throwaway
// DB any more. A test that imports this module would connect to whatever
// DATABASE_URL points at — write one only if that is what you mean.
const databaseUrl = env.DATABASE_URL

if (!databaseUrl) {
  throw new Error(`Missing DATABASE_URL for NODE_ENV=${env.NODE_ENV}`)
}

export const queryClient = postgres(databaseUrl, {
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

// Tx is the transaction handle Drizzle passes to `db.transaction(callback)`.
// Extracted from the callback signature so it stays correct across Drizzle
// version bumps without hand-importing internal types.
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

// Executor is anything that can run queries: the singleton db or an active tx.
// Repo functions accept `exec: Executor = db` as the last optional parameter,
// so services that open a transaction can pass `tx` to keep all writes atomic.
export type Executor = Db | Tx
