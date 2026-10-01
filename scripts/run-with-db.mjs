// scripts/run-with-db.mjs
// Helper to set DATABASE_URL from a source env var (PROD_DATABASE_URL) and
// then exec the given command. Lets us swap DBs for drizzle-kit without
// fighting Windows shell quoting.
import { spawn } from 'node:child_process'

const sourceList = process.env.DATABASE_URL_FROM
if (!sourceList) {
  console.error('DATABASE_URL_FROM not set. Expected PROD_DATABASE_URL.')
  process.exit(1)
}

// Admite una lista separada por comas y usa la primera que esté definida: así
// un script de lectura prefiere PROD_READONLY_DATABASE_URL (usuario de solo
// lectura) y cae a PROD_DATABASE_URL si todavía no se creó.
const candidates = sourceList.split(',').map((name) => name.trim())
const sourceVar = candidates.find((name) => process.env[name])
const url = sourceVar ? process.env[sourceVar] : undefined
if (!sourceVar || !url) {
  console.error(`None of ${candidates.join(', ')} is set in .env`)
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
