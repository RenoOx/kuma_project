// Exporta los datos crudos del reporte mensual de Instituto Tecmin desde PROD.
// Solo lectura: todo corre dentro de una transacción READ ONLY.
// Sin textos de mensajes ni teléfonos: solo tiempos, roles, eventos y etiquetas.
// Uso: node scripts/reporte-tecmin.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import postgres from 'postgres'

const BUSINESS_ID = '33doLX_tC9vrVnaJVfLvZ'
const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
const url = env.match(/^PROD_DATABASE_URL=(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '')
if (!url) throw new Error('Falta PROD_DATABASE_URL en .env')

const sql = postgres(url, { max: 1, connect_timeout: 20 })

const out = await sql.begin('read only', async (tx) => {
  const [marker] = await tx`select label from _env_marker`
  if (!String(marker?.label).includes('PRODUCTION')) throw new Error(`No es prod: ${marker?.label}`)

  const business = await tx`select id, name, created_at from businesses where id = ${BUSINESS_ID}`

  const conversations = await tx`
    select c.id, c.status, c.state, c.emma_enabled, c.created_at, c.last_message_at,
           (cu.phone like '+999%') as is_test
    from conversations c left join customers cu on cu.id = c.customer_id
    where c.business_id = ${BUSINESS_ID} and c.type = 'customer'`

  const messages = await tx`
    select conversation_id, role, sender_type, created_at,
           (attachments is not null) as has_attachments,
           (content like '[%') as bracket_marker,
           tool_calls
    from messages
    where business_id = ${BUSINESS_ID} and role in ('user','assistant')
    order by created_at`

  const events = await tx`
    select type, conversation_id, created_at,
           payload->>'reason' as reason, payload->>'state' as state,
           payload->>'step' as step, payload->>'count' as count,
           array(select jsonb_object_keys(payload)) as payload_keys
    from events where business_id = ${BUSINESS_ID}`

  const tags = await tx`
    select ct.conversation_id, t.name, ct.created_at
    from conversation_tags ct join tags t on t.id = ct.tag_id
    where t.business_id = ${BUSINESS_ID}`

  return { business, conversations, events, tags,
    messages: messages.map((m) => ({
      ...m,
      tool_calls: Array.isArray(m.tool_calls)
        ? m.tool_calls.map((t) => {
            let args = {}
            try { args = JSON.parse(t?.function?.arguments ?? '{}') } catch {}
            return { name: t?.function?.name, message: args.message ?? null }
          })
        : null,
    })) }
})

await sql.end()
mkdirSync(new URL('../reportes/', import.meta.url), { recursive: true })
const file = new URL(`../reportes/tecmin-${new Date().toISOString().slice(0, 10)}.json`, import.meta.url)
writeFileSync(file, JSON.stringify(out))
console.log(`Listo: ${out.conversations.length} conversaciones, ${out.messages.length} mensajes, ${out.events.length} eventos → ${file.pathname}`)
