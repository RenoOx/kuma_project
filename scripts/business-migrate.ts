import 'dotenv/config'
import { createHash } from 'node:crypto'
import { nanoid } from 'nanoid'
import postgres from 'postgres'
import { z } from 'zod'
import { businessSettingsSchema } from '@/modules/business/business.settings.js'
import { fileConfigFor } from '@/modules/conversation/flowSource.js'

// Mueve la configuración de un negocio a OTRO negocio de la MISMA base.
//
// Nació del traspaso de Instituto Tecmin (2026-10-02): el negocio donde se
// configuró todo pasó a ser el banco de pruebas, y el real es uno nuevo, con su
// propio número de WhatsApp. Copiar a mano doce servicios con sus ids internos
// es justo el tipo de trabajo donde se pierde uno.
//
// Qué copia: los settings (servicios con sus ids —que son lo que ata cada foto a
// su servicio—, horarios, días especiales, formas de pago, identidad de Emma,
// mensajes, tipo de negocio y nicho), la dirección, el link de Maps, la zona
// horaria y la base de conocimiento.
//
// Qué NO copia, a propósito:
// - Los números de WhatsApp (del bot y del dueño): el destino ya tiene los suyos,
//   y pisarlos lo dejaría hablando por el número del origen.
// - panel_token: el link del panel ES la credencial, y cada negocio tiene la suya.
// - conversationFlow (el flujo guardado): para un negocio con archivo lo provee
//   el archivo, y arrastrar un flujo viejo escondería que el archivo no aplica.
// - botPaused: es estado operativo del origen, no configuración.
// - Clientes, conversaciones, mensajes, citas, etiquetas y credenciales de Google.
// - El material (service_media): sus archivos viven en S3 bajo una ruta que
//   empieza con el id del negocio, y `keyBelongsTo` le niega a un negocio leer la
//   ruta de otro. Copiar solo las filas daría galerías que fallan al mandarse, así
//   que el script las LISTA para volver a subirlas desde el panel y no las copia.
//
// Seguridad: sin --apply no escribe nada. La base la verifica guard-db-env, y el
// script vuelve a leer su marcador. Los settings se validan contra
// businessSettingsSchema ANTES de escribir: si no pasan, aborta sin tocar nada.
//
// Uso:
//   npm run business:migrate:prod -- --from <idOrigen> --to <idDestino>
//   npm run business:migrate:prod -- --from <idOrigen> --to <idDestino> --apply

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)

/** Lo que se deja afuera de los settings al copiarlos. Ver el comentario de arriba. */
const SETTINGS_OMITTED = ['conversationFlow', 'botPaused'] as const

type Row = Record<string, unknown>

function out(line = ''): void {
  process.stdout.write(`${line}\n`)
}

function fail(message: string): never {
  out(`✗ ${message}`)
  out('No se escribió nada.')
  process.exit(1)
}

function hashOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)
}

function flag(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? null : (process.argv[i + 1] ?? null)
}

function describe(value: unknown): string {
  if (value === null || value === undefined || value === '') return '(vacío)'
  return String(value)
}

async function main(): Promise<void> {
  const parsed = z
    .object({ from: idSchema, to: idSchema })
    .safeParse({ from: flag('from'), to: flag('to') })
  if (!parsed.success) fail('Uso: business-migrate --from <idOrigen> --to <idDestino> [--apply]')
  const { from, to } = parsed.data
  if (from === to) fail('Origen y destino son el mismo negocio.')

  const apply = process.argv.includes('--apply')
  const replaceKb = process.argv.includes('--replace-kb')

  const url = process.env.DATABASE_URL
  if (!url) fail('Falta DATABASE_URL (lo pone run-with-db según el entorno).')

  const sql = postgres(url, { max: 1, connect_timeout: 10 })

  try {
    const [marker] = await sql<{ label: string }[]>`select label from _env_marker limit 1`
    if (!marker?.label) fail('La base no tiene marcador de entorno (_env_marker).')
    out(`Base: ${marker.label}`)
    out(apply ? 'Modo: APLICAR (escribe)' : 'Modo: simulación (no escribe nada)')
    out()

    const [source] = await sql<Row[]>`select * from businesses where id = ${from}`
    const [target] = await sql<Row[]>`select * from businesses where id = ${to}`
    if (!source) fail(`No existe el negocio de origen ${from}.`)
    if (!target) fail(`No existe el negocio de destino ${to}.`)

    // Los settings se validan como los va a leer Emma. Un origen inválido se
    // copiaría tal cual y el destino quedaría roto igual que él.
    const sourceSettings = businessSettingsSchema.safeParse(source.settings)
    if (!sourceSettings.success) {
      fail(
        `Los settings del origen no son válidos: ${sourceSettings.error.issues
          .map((i) => i.path.join('.'))
          .join(', ')}`,
      )
    }

    const raw = source.settings as Record<string, unknown>
    const settings: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(raw)) {
      if (!(SETTINGS_OMITTED as readonly string[]).includes(key)) settings[key] = value
    }
    const checked = businessSettingsSchema.safeParse(settings)
    if (!checked.success) {
      fail(
        `Lo que se copiaría no pasa la validación: ${checked.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join(' · ')}`,
      )
    }

    const kb = await sql<Row[]>`select * from knowledge_base where business_id = ${from}`
    const targetKb = await sql<Row[]>`select id from knowledge_base where business_id = ${to}`
    if (targetKb.length > 0 && !replaceKb) {
      fail(
        `El destino ya tiene ${targetKb.length} entradas de base de conocimiento. Revisalas y, si querés reemplazarlas por las del origen, corré de nuevo con --replace-kb.`,
      )
    }

    const media = await sql<Row[]>`
      select * from service_media where business_id = ${from}
      order by owner_kind, service_id, display_order`

    // Qué cambia en la fila del negocio. ownerName solo si el destino no tiene:
    // el dueño del negocio nuevo puede ser otra persona.
    const rowPatch: Row = {
      settings,
      address: source.address,
      google_maps_url: source.google_maps_url,
      timezone: source.timezone,
      updated_at: new Date(),
    }
    const takesOwnerName = !target.owner_name && !!source.owner_name
    if (takesOwnerName) rowPatch.owner_name = source.owner_name

    out(`Origen:  ${describe(source.name)}  (${from})`)
    out(`Destino: ${describe(target.name)}  (${to})`)
    out()
    out('── Lo que se copia ──')
    out(`  settings: ${hashOf(settings)}  (sin ${SETTINGS_OMITTED.join(', ')})`)
    out(
      `    tipo de negocio: ${describe(checked.data.flowType)} · nicho: ${describe(
        checked.data.niche,
      )} · servicios: ${checked.data.services.length}`,
    )
    for (const service of checked.data.services) {
      out(`      · ${service.name}  [${service.id ?? 'sin id'}]`)
    }
    out(`  dirección:   ${describe(source.address)}`)
    out(`  link Maps:   ${describe(source.google_maps_url)}`)
    out(`  zona horaria: ${describe(source.timezone)}`)
    out(
      `  nombre del dueño: ${takesOwnerName ? describe(source.owner_name) : `se mantiene el del destino (${describe(target.owner_name)})`}`,
    )
    out(
      `  base de conocimiento: ${kb.length} entradas${targetKb.length > 0 ? ` (reemplazan ${targetKb.length} del destino)` : ''}`,
    )
    out()
    out('── Lo que NO se toca ──')
    out(`  WhatsApp del bot:   destino ${describe(target.whatsapp_number)} (sin cambios)`)
    out(`  WhatsApp del dueño: destino ${describe(target.owner_whatsapp_number)} (sin cambios)`)
    out('  link del panel, clientes, conversaciones, mensajes, citas y etiquetas')
    if (!target.owner_whatsapp_number) {
      out()
      out('⚠ El destino NO tiene número de dueño cargado.')
      out('  Sin él, las capturas de pago, los DNI y las escaladas no le llegan a nadie.')
      out('  Se carga desde el admin antes de prender las campañas.')
    }
    out()
    out('── Fotos para volver a subir desde el panel del destino ──')
    if (media.length === 0) {
      out('  (el origen no tiene material cargado)')
    } else {
      const byOwner = new Map<string, Row[]>()
      for (const m of media) {
        const key = `${String(m.owner_kind)}|${String(m.service_id)}`
        byOwner.set(key, [...(byOwner.get(key) ?? []), m])
      }
      const serviceName = new Map(
        checked.data.services.flatMap((s) => (s.id ? [[s.id, s.name] as const] : [])),
      )
      const WHERE: Record<string, string> = {
        service: 'Servicios → el servicio → Fotos',
        node: 'Asistente → Conversación → el paso → Material de este paso',
        fixedMessage: 'Asistente → Fotos de tus mensajes automáticos',
      }
      // Un mensaje fijo cuyo id ya no está en el archivo (o que dejó de declarar
      // `images`) tiene fotos huérfanas: nadie las borra cuando el archivo cambia
      // (ver "Sin barrido de huérfanos" en CLAUDE.md). Volver a subirlas sería
      // trabajo que no se manda nunca.
      const file = fileConfigFor(from)
      const obsolete = (kind: string, ownerId: string): boolean =>
        kind === 'fixedMessage' && !!file && file.fixedMessages[ownerId]?.images !== true
      let stale = 0
      for (const [key, items] of byOwner) {
        const [kind = '', ownerId = ''] = key.split('|')
        const label = kind === 'service' ? (serviceName.get(ownerId) ?? ownerId) : ownerId
        if (obsolete(kind, ownerId)) {
          stale += items.length
          out(`  ${label}  — ✗ YA NO SE USA, no la subas (${items.length})`)
          continue
        }
        out(`  ${label}  (${items.length} ${items.length === 1 ? 'archivo' : 'archivos'})`)
        out(`    dónde: ${WHERE[kind] ?? kind}`)
        items.forEach((m, i) => {
          out(`    ${i + 1}. ${String(m.filename ?? '(sin nombre)')}  [${String(m.type)}]`)
        })
      }
      if (stale > 0) {
        out()
        out(`  (${stale} archivos del origen ya no los usa el archivo del negocio)`)
      }
    }
    out()

    if (!apply) {
      out('Simulación: no se escribió nada. Para aplicarlo, agregá --apply.')
      return
    }

    await sql.begin(async (tx) => {
      await tx`update businesses set ${tx(rowPatch)} where id = ${to}`
      if (targetKb.length > 0) await tx`delete from knowledge_base where business_id = ${to}`
      if (kb.length > 0) {
        // Ids nuevos: los del origen siguen existiendo en esta misma base.
        const copies = kb.map((entry) => ({ ...entry, id: nanoid(), business_id: to }))
        await tx`insert into knowledge_base ${tx(copies)}`
      }
    })

    const [written] = await sql<Row[]>`select settings from businesses where id = ${to}`
    const same = hashOf(written?.settings) === hashOf(settings)
    out(`✓ Aplicado. settings del destino: ${same ? 'idénticos a lo copiado' : '✗ DISTINTOS'}`)
    if (!same) out('  Revisá la fila del destino antes de seguir.')
    out('Falta: subir las fotos listadas arriba desde el panel del destino.')
  } finally {
    await sql.end()
  }
}

main().catch((cause: unknown) => {
  out(`Error: ${cause instanceof Error ? cause.message : String(cause)}`)
  process.exitCode = 1
})
