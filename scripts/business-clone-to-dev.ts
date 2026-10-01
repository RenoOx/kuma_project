import 'dotenv/config'
import { createHash, randomBytes } from 'node:crypto'
import postgres from 'postgres'
import { z } from 'zod'

// Copia la configuración de un negocio de PROD a DEV, para probarlo con lo que
// corre de verdad (Instituto Tecmin, test masivo de 2026-09-30).
//
// Qué copia: la fila del negocio (settings con servicios y precios, horarios,
// dirección, prompt), su base de conocimiento y las filas de su material
// (service_media). Qué NO copia: clientes, conversaciones, mensajes, citas,
// credenciales de Google ni la sesión de WhatsApp.
//
// Tres cosas cambian a propósito en la copia:
// - Número del bot: +999… (negocio de prueba). El arranque lo salta, así que
//   esta copia nunca abre una sesión de WhatsApp con el número real.
// - Número del dueño: otro +999… — los avisos al dueño no pueden llegarle a la
//   persona real desde un entorno de prueba.
// - panel_token: uno nuevo; el link de prod no puede abrir la copia.
//
// El material copia solo las FILAS: sus s3Key apuntan al bucket de prod y en
// dev no existen (buckets separados, ver CLAUDE.md), así que bajarlas desde dev
// falla. Sirve para saber QUÉ fotos tiene cada mensaje; borrar huérfanos en dev
// no puede tocar prod, porque corre contra emma-media-dev.
//
// Seguridad: la base destino la verifica guard-db-env (--expect dev) y este
// script vuelve a leer su marcador; la de origen se lee con su propio marcador
// (tiene que decir PRODUCTION) y dentro de una transacción READ ONLY.
//
// Uso: npm run business:clone:dev -- <businessId>

const argsSchema = z.object({ businessId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) })

// Fijos para que correr el script dos veces deje la misma copia.
const TEST_BOT_NUMBER = '+999700000001'
const TEST_OWNER_NUMBER = '+999700000002'

function out(line = ''): void {
  process.stdout.write(`${line}\n`)
}

function fail(message: string): never {
  out(`✗ ${message}`)
  out('No se copió nada.')
  process.exit(1)
}

function hashOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)
}

async function markerOf(sql: postgres.Sql): Promise<string> {
  const rows = await sql<{ label: string }[]>`select label from _env_marker limit 1`
  return rows[0]?.label ?? ''
}

type Row = Record<string, unknown>

async function main(): Promise<void> {
  const parsed = argsSchema.safeParse({ businessId: process.argv[2] })
  if (!parsed.success) fail('Uso: business-clone-to-dev <businessId>')
  const { businessId } = parsed.data

  const sourceUrl = process.env.PROD_READONLY_DATABASE_URL ?? process.env.PROD_DATABASE_URL
  const targetUrl = process.env.DATABASE_URL
  if (!sourceUrl || !targetUrl) fail('Faltan PROD_DATABASE_URL o DATABASE_URL en .env')
  if (sourceUrl === targetUrl) fail('Origen y destino son la misma base.')

  const source = postgres(sourceUrl, { max: 1, connect_timeout: 10 })
  const target = postgres(targetUrl, { max: 1, connect_timeout: 10 })

  try {
    const sourceLabel = await markerOf(source)
    const targetLabel = await markerOf(target)
    if (!sourceLabel.includes('PRODUCTION')) fail(`El origen no es prod: "${sourceLabel}"`)
    if (!targetLabel.includes('DEV')) fail(`El destino no es dev: "${targetLabel}"`)
    out(`Origen:  ${sourceLabel}`)
    out(`Destino: ${targetLabel}`)

    // Todo lo de prod se lee adentro de READ ONLY: la base rechaza cualquier escritura.
    const snapshot = await source.begin('read only', async (sql) => {
      const [business] = await sql<Row[]>`select * from businesses where id = ${businessId}`
      const kb = await sql<Row[]>`select * from knowledge_base where business_id = ${businessId}`
      const media = await sql<Row[]>`select * from service_media where business_id = ${businessId}`
      return { business, kb, media }
    })
    if (!snapshot.business) fail(`No existe el negocio ${businessId} en prod.`)

    const taken = await target<Row[]>`
      select id from businesses where whatsapp_number = ${TEST_BOT_NUMBER} and id <> ${businessId}`
    if (taken.length > 0)
      fail(`El número de prueba ${TEST_BOT_NUMBER} ya lo usa otro negocio en dev.`)

    const business: Row = {
      ...snapshot.business,
      whatsapp_number: TEST_BOT_NUMBER,
      owner_whatsapp_number: TEST_OWNER_NUMBER,
      panel_token: randomBytes(24).toString('hex'),
      updated_at: new Date(),
    }

    await target.begin(async (sql) => {
      const [exists] = await sql<Row[]>`select id from businesses where id = ${businessId}`
      if (exists) {
        // Se reemplaza solo la config: los clientes y conversaciones de prueba
        // que ya haya en dev quedan como están.
        await sql`update businesses set ${sql(business, 'name', 'whatsapp_number', 'timezone', 'system_prompt', 'settings', 'owner_whatsapp_number', 'owner_name', 'address', 'google_maps_url', 'updated_at')} where id = ${businessId}`
      } else {
        await sql`insert into businesses ${sql(business)}`
      }
      await sql`delete from knowledge_base where business_id = ${businessId}`
      await sql`delete from service_media where business_id = ${businessId}`
      if (snapshot.kb.length > 0) await sql`insert into knowledge_base ${sql(snapshot.kb)}`
      if (snapshot.media.length > 0) await sql`insert into service_media ${sql(snapshot.media)}`
    })

    // La prueba de que la copia es idéntica: el mismo hash de settings a los dos lados.
    const [copied] = await target<Row[]>`select settings from businesses where id = ${businessId}`
    const sourceHash = hashOf(snapshot.business.settings)
    const targetHash = hashOf(copied?.settings)
    const byKind = new Map<string, number>()
    for (const m of snapshot.media) {
      const kind = String(m.owner_kind)
      byKind.set(kind, (byKind.get(kind) ?? 0) + 1)
    }

    out()
    out(`Copiado ${String(snapshot.business.name)} (${businessId})`)
    out(
      `  settings  prod ${sourceHash}  ·  dev ${targetHash}  ${sourceHash === targetHash ? '✓ idénticos' : '✗ DISTINTOS'}`,
    )
    out(`  base de conocimiento: ${snapshot.kb.length} filas`)
    out(
      `  material: ${snapshot.media.length} filas (${[...byKind].map(([k, n]) => `${k}: ${n}`).join(', ') || 'ninguna'})`,
    )
    for (const m of snapshot.media) {
      out(
        `    · ${String(m.owner_kind)} ${String(m.service_id)} — ${String(m.type)} ${String(m.filename ?? '')}`,
      )
    }
    out(`  bot ${TEST_BOT_NUMBER} · dueño ${TEST_OWNER_NUMBER} (de prueba, sin WhatsApp)`)
  } finally {
    await source.end()
    await target.end()
  }
}

main().catch((cause: unknown) => {
  out(`Error: ${cause instanceof Error ? cause.message : String(cause)}`)
  process.exitCode = 1
})
