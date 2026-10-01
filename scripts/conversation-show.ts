import { z } from 'zod'
import { queryClient } from '@/db/client.js'

// Una conversación de un negocio tal como pasó: cada mensaje, quién lo dijo, las
// herramientas que llamó Emma con sus datos y lo que le respondieron, y en qué
// paso quedó. Para diagnosticar con datos reales en vez de adivinar desde una
// captura.
//
// Solo lectura, en tres capas: todo corre dentro de una transacción READ ONLY
// (Postgres rechaza cualquier escritura), cada consulta filtra por el
// business_id recibido, y en prod conviene correrlo con el usuario de solo
// lectura (PROD_READONLY_DATABASE_URL). Los teléfonos salen enmascarados: son
// datos de clientes reales.
//
// Uso (siempre por el guard, nunca directo):
//   npm run conversation:show:prod -- <businessId>                    la última
//   npm run conversation:show:prod -- <businessId> --last 3           las 3 últimas
//   npm run conversation:show:prod -- <businessId> --search "texto"   la última que lo contiene
//   npm run conversation:show:prod -- <businessId> --phone 986547823  por teléfono (termina en)
//   ... --messages 80   cuántos mensajes (los más recientes; default 60)

const argsSchema = z.object({
  businessId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  last: z.coerce.number().int().min(1).max(20).default(1),
  search: z.string().min(2).max(200).optional(),
  phone: z
    .string()
    .regex(/^\+?\d{4,15}$/)
    .optional(),
  messages: z.coerce.number().int().min(1).max(500).default(60),
})

type Args = z.infer<typeof argsSchema>

interface ConversationRow {
  id: string
  state: string
  status: string
  emma_enabled: boolean
  last_ms: number | null
  phone: string | null
  name: string | null
}

interface MessageRow {
  role: string
  sender_type: string
  content: string
  tool_calls: unknown
  tool_call_id: string | null
  created_ms: number
}

interface ToolCall {
  id?: string
  function?: { name?: string; arguments?: string }
}

function out(line = ''): void {
  process.stdout.write(`${line}\n`)
}

function parseArgs(argv: string[]): Args {
  const [businessId, ...rest] = argv
  const flags: Record<string, string> = {}
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i]
    const value = rest[i + 1]
    if (key?.startsWith('--') && value !== undefined) {
      flags[key.slice(2)] = value
      i++
    }
  }
  const parsed = argsSchema.safeParse({ businessId, ...flags })
  if (!parsed.success) {
    out(`Argumentos inválidos: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`)
    out(
      'Uso: conversation-show <businessId> [--last N | --search "texto" | --phone dígitos] [--messages N]',
    )
    process.exit(1)
  }
  return parsed.data
}

// "+51986547823" → "+51 9•• ••• 823": alcanza para distinguir clientes sin
// dejar el número completo en una terminal o un log.
function maskPhone(phone: string | null): string {
  if (!phone) return '—'
  const digits = phone.replace(/\D/g, '')
  if (digits.length < 6) return '•••'
  return `+${digits.slice(0, 2)} ${digits[2]}•• ••• ${digits.slice(-3)}`
}

// Las fechas llegan como milisegundos desde la consulta: el cliente de la base
// devuelve los timestamps como texto, y en ese formato ("…+00") Date no los lee.
function when(ms: number | null, timezone: string): string {
  if (ms === null) return '—'
  return new Intl.DateTimeFormat('es-PE', {
    timeZone: timezone,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(ms))
}

function indent(text: string, prefix = '    '): string {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n')
}

function preview(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… (+${text.length - max})`
}

function speaker(row: MessageRow): string {
  if (row.role === 'user') return 'CLIENTE'
  if (row.role === 'tool') return 'RESULTADO'
  if (row.role === 'assistant') return row.sender_type === 'human' ? 'DUEÑO' : 'EMMA'
  return row.role.toUpperCase()
}

function printMessage(row: MessageRow, timezone: string): void {
  const calls = Array.isArray(row.tool_calls) ? (row.tool_calls as ToolCall[]) : []
  out(`[${when(row.created_ms, timezone)}] ${speaker(row)}`)
  if (row.content.trim() !== '') {
    // Los resultados de tools son JSON largos: alcanza con el comienzo.
    out(indent(row.role === 'tool' ? preview(row.content, 400) : row.content))
  }
  for (const call of calls) {
    out(`    → ${call.function?.name ?? '?'} ${call.function?.arguments ?? ''}`)
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  // READ ONLY: la base misma rechaza cualquier escritura dentro de este bloque.
  await queryClient.begin('read only', async (sql) => {
    const [business] = await sql<{ name: string; timezone: string }[]>`
      select name, timezone from businesses where id = ${args.businessId}`
    if (!business) {
      out(`No existe el negocio ${args.businessId}`)
      return
    }

    const conversations = await sql<ConversationRow[]>`
      select c.id, c.state, c.status, c.emma_enabled, (extract(epoch from c.last_message_at) * 1000)::float8 as last_ms, cu.phone, cu.name
      from conversations c
      left join customers cu on cu.id = c.customer_id and cu.business_id = c.business_id
      where c.business_id = ${args.businessId}
        and c.type = 'customer'
        ${args.phone ? sql`and cu.phone like ${`%${args.phone.replace(/^\+/, '')}`}` : sql``}
        ${
          args.search
            ? sql`and exists (
                select 1 from messages m
                where m.conversation_id = c.id
                  and m.business_id = ${args.businessId}
                  and m.content ilike ${`%${args.search}%`})`
            : sql``
        }
      order by c.last_message_at desc nulls last
      limit ${args.last}`

    out(`${business.name}  (${args.businessId})`)
    if (conversations.length === 0) {
      out('Ninguna conversación coincide.')
      return
    }

    for (const conv of conversations) {
      out()
      out(`══ Conversación ${conv.id} ══`)
      out(
        `Cliente: ${conv.name ?? 'sin nombre'} ${maskPhone(conv.phone)} · paso: ${conv.state} · estado: ${conv.status} · Emma: ${conv.emma_enabled ? 'prendida' : 'APAGADA'} · último: ${when(conv.last_ms, business.timezone)}`,
      )

      // Los N más recientes, mostrados en orden.
      const rows = await sql<MessageRow[]>`
        select role, sender_type, content, tool_calls, tool_call_id, created_ms from (
          select role, sender_type, content, tool_calls, tool_call_id, created_at,
                 (extract(epoch from created_at) * 1000)::float8 as created_ms
          from messages
          where conversation_id = ${conv.id} and business_id = ${args.businessId}
          order by created_at desc
          limit ${args.messages}
        ) recent
        order by created_at asc`
      out()
      for (const row of rows) printMessage(row, business.timezone)
    }
  })
}

main()
  .catch((cause: unknown) => {
    out(`Error: ${cause instanceof Error ? cause.message : String(cause)}`)
    process.exitCode = 1
  })
  .finally(async () => {
    await queryClient.end()
  })
