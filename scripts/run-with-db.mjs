// scripts/run-with-db.mjs
// Helper to set DATABASE_URL from a source env var (TEST_DATABASE_URL or 
// PROD_DATABASE_URL) and then exec the given command. Lets us swap DBs 
// for drizzle-kit without fighting Windows shell quoting.
import { spawn } from 'node:child_process'

const sourceVar = process.env.DATABASE_URL_FROM
if (!sourceVar) {
  console.error('DATABASE_URL_FROM not set. Expected TEST_DATABASE_URL or PROD_DATABASE_URL.')
  process.exit(1)
}

const url = process.env[sourceVar]
if (!url) {
  console.error(`Source variable ${sourceVar} is empty or missing in .env`)
  process.exit(1)
}

const [cmd, ...args] = process.argv.slice(2)
if (!cmd) {
  console.error('No command provided to run-with-db.mjs')
  process.exit(1)
}

console.log(`[run-with-db] Using ${sourceVar} as DATABASE_URL`)
console.log(`[run-with-db] Host: ${new URL(url).host}`)

const child = spawn(cmd, args, {
  env: { ...process.env, DATABASE_URL: url },
  stdio: 'inherit',
  shell: true,
})

child.on('exit', (code) => process.exit(code ?? 0))