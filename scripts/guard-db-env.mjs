// scripts/guard-db-env.mjs
//
// Refuses to run a command against the wrong database, then execs it.
//
// The trap this closes is real and already sprung once: `npm run db:migrate:dev`
// only reads DATABASE_URL, so the `:dev` in its name guarantees nothing. On
// 2026-09-21 that variable pointed at production, and the only reason a
// migration did not land there was that somebody happened to look first.
//
// The check is the `_env_marker` table, which each database carries with a
// label naming itself. Somebody created it for exactly this and nothing read
// it — a safety net nobody checks is a safety net that does not exist.
//
// Usage:
//   node scripts/guard-db-env.mjs --expect dev  -- drizzle-kit migrate
//   node scripts/guard-db-env.mjs --expect prod -- drizzle-kit migrate
//
// FAILING CLOSED IS THE POINT. A database with no marker, an unreachable one,
// or a label nobody can parse all abort. The alternative — assuming it is
// probably dev — is the assumption that caused this.
// Loaded here and not left to the command we wrap: drizzle.config.ts calls
// loadDotenv() itself, so by the time drizzle-kit reads DATABASE_URL it exists —
// but this guard runs BEFORE that and would otherwise see nothing and abort on
// every invocation, which is a guard that teaches people to work around it.
import 'dotenv/config'
import { spawn } from 'node:child_process'
import postgres from 'postgres'

const argv = process.argv.slice(2)
const separator = argv.indexOf('--')
const flags = separator === -1 ? argv : argv.slice(0, separator)
const command = separator === -1 ? [] : argv.slice(separator + 1)

const expectIndex = flags.indexOf('--expect')
const expected = expectIndex === -1 ? null : flags[expectIndex + 1]

function die(message, detail) {
  console.error(`\n[guard-db-env] ✗ ${message}`)
  if (detail) console.error(`[guard-db-env]   ${detail}`)
  console.error('[guard-db-env] No se ejecutó nada.\n')
  process.exit(1)
}

if (expected !== 'dev' && expected !== 'prod') {
  die('Falta --expect dev|prod.')
}
if (command.length === 0) {
  die('Falta el comando después de `--`.')
}

const url = process.env.DATABASE_URL
if (!url) die('DATABASE_URL no está definida.')

let host
try {
  host = new URL(url).host
} catch {
  die('DATABASE_URL no es una URL válida.')
}

// Read-only, one connection, and a short timeout: this runs before every
// migration, so it must not be the thing that hangs.
const sql = postgres(url, { max: 1, connect_timeout: 10, idle_timeout: 5 })

let label
try {
  const exists = await sql`
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = '_env_marker'
  `
  if (exists.length === 0) {
    await sql.end()
    die(
      `La base ${host} no tiene la tabla _env_marker.`,
      'Sin marcador no hay forma de saber qué base es. Creala con: ' +
        `create table _env_marker (label text); insert into _env_marker values ('🟢 DEV — ...');`,
    )
  }
  const rows = await sql`select label from _env_marker limit 1`
  label = rows[0]?.label ?? ''
} catch (cause) {
  await sql.end().catch(() => {})
  die(`No se pudo leer _env_marker en ${host}.`, cause instanceof Error ? cause.message : '')
} finally {
  await sql.end().catch(() => {})
}

const upper = String(label).toUpperCase()
const isProd = upper.includes('PRODUCTION') || upper.includes('PROD')
const isDev = upper.includes('DEV')

// Both or neither means the label cannot be trusted to say which one it is.
if (isProd === isDev) {
  die(`El marcador de ${host} no es concluyente: "${label}".`)
}

const actual = isProd ? 'prod' : 'dev'
if (actual !== expected) {
  die(
    `Esperaba ${expected.toUpperCase()} y ${host} dice "${label}".`,
    expected === 'dev'
      ? 'Revisá DATABASE_URL en tu .env: tiene que apuntar a la base de desarrollo.'
      : 'Usá el script de prod, que toma la URL de PROD_DATABASE_URL.',
  )
}

console.log(`[guard-db-env] ✓ ${host} → "${label}"`)
console.log(`[guard-db-env] Ejecutando: ${command.join(' ')}\n`)

const [cmd, ...args] = command
const child = spawn(cmd, args, { stdio: 'inherit', shell: true })
child.on('exit', (code) => process.exit(code ?? 0))
