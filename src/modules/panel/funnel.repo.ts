import { and, asc, count, desc, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm'
import type { FunnelStage } from '@/config/businesses/define.js'
import { db, type Executor } from '@/db/client.js'
import {
  conversations,
  conversationTags,
  customers,
  events,
  messages,
  tags as tagsTable,
} from '@/db/schema/index.js'
import {
  buildFunnel,
  type FunnelStep,
  fixedMessageIdsOf,
  type QualificationOutcome,
} from '@/modules/panel/funnel.js'
import { QUALIFICATION_TAGS } from '@/modules/tag/tag.types.js'
import { formatPersonName } from '@/shared/name.js'
import { isLidPhone } from '@/shared/phone.js'

// El embudo de ventas del panel (Dashboard), para negocios de venta con `funnel`
// en su archivo. Mismo contrato que panel.repo: TODA consulta filtra por
// business_id, sin excepción — un embudo es la lista de clientes de un negocio.
//
// La cohorte son las conversaciones de clientes creadas en el período. Lo de
// "para atender" es el estado ACTUAL (lo que hay que mirar hoy), no el del período.

const CUSTOMER_THREAD = eq(conversations.type, 'customer')
const ATTENTION_LIMIT = 50

export interface FunnelPendingItem {
  conversationId: string
  customerName: string | null
  phone: string
  /** El "teléfono" son los dígitos de su LID: WhatsApp no dio el número. */
  phoneHidden: boolean
  /** Horas desde que mandó la foto pedida y Emma se pausó. */
  hoursWaiting: number | null
}

export interface FunnelEscalatedItem {
  conversationId: string
  customerName: string | null
  phone: string
  /** El "teléfono" son los dígitos de su LID: WhatsApp no dio el número. */
  phoneHidden: boolean
  reason: string | null
  escalatedAt: string | null
}

export interface FunnelReport {
  steps: FunnelStep[]
  pendingValidation: FunnelPendingItem[]
  escalated: FunnelEscalatedItem[]
  signals: {
    /** Veces que Emma pasó un chat a una persona. */
    escalations: number
    /** Veces que el portero frenó una escalada sin motivo real. */
    escalationsBlocked: number
    /** Veces que Emma no pudo responder (OpenAI no contestó a tiempo). */
    unanswered: number
    /** Audios o notas de voz recibidos. */
    audios: number
  }
}

export async function getFunnel(
  businessId: string,
  from: Date,
  to: Date,
  stages: readonly FunnelStage[],
  exec: Executor = db,
): Promise<FunnelReport> {
  const cohort = exec
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.businessId, businessId),
        CUSTOMER_THREAD,
        gte(conversations.createdAt, from),
        lt(conversations.createdAt, to),
      ),
    )

  const qualificationNames = Object.values(QUALIFICATION_TAGS).map((t) => t.name)
  const outcomeByName = new Map<string, QualificationOutcome>(
    Object.entries(QUALIFICATION_TAGS).map(([key, t]) => [t.name, key as QualificationOutcome]),
  )

  const [cohortRows, toolRows, photoRows, tagRows, eventRows, blockedRows] = await Promise.all([
    cohort,
    // Solo las filas que pueden tener un mensaje fijo; el detalle se parsea en
    // funnel.ts, porque los argumentos vienen como un string con JSON adentro.
    exec
      .select({ conversationId: messages.conversationId, toolCalls: messages.toolCalls })
      .from(messages)
      .where(
        and(
          eq(messages.businessId, businessId),
          eq(messages.role, 'assistant'),
          isNotNull(messages.toolCalls),
          sql`${messages.toolCalls}::text like '%send_fixed_message%'`,
          inArray(messages.conversationId, cohort),
        ),
      ),
    exec
      .selectDistinct({ conversationId: events.conversationId })
      .from(events)
      .where(
        and(
          eq(events.businessId, businessId),
          eq(events.type, 'emma_paused_on_image'),
          inArray(events.conversationId, cohort),
        ),
      ),
    exec
      .select({ conversationId: conversationTags.conversationId, name: tagsTable.name })
      .from(conversationTags)
      .innerJoin(tagsTable, eq(tagsTable.id, conversationTags.tagId))
      .where(
        and(
          eq(tagsTable.businessId, businessId),
          inArray(tagsTable.name, qualificationNames),
          inArray(conversationTags.conversationId, cohort),
        ),
      ),
    exec
      .select({
        type: events.type,
        format: sql<string | null>`${events.payload}->>'format'`,
        n: count(),
      })
      .from(events)
      .where(
        and(
          eq(events.businessId, businessId),
          inArray(events.type, ['escalation', 'emma_unanswered', 'unsupported_media']),
          gte(events.createdAt, from),
          lt(events.createdAt, to),
        ),
      )
      .groupBy(events.type, sql`${events.payload}->>'format'`),
    // El rechazo del portero queda como resultado de herramienta (role 'tool').
    exec
      .select({ n: count() })
      .from(messages)
      .where(
        and(
          eq(messages.businessId, businessId),
          eq(messages.role, 'tool'),
          sql`${messages.content} like '%escalation_not_warranted%'`,
          gte(messages.createdAt, from),
          lt(messages.createdAt, to),
        ),
      ),
  ])

  const fixedSent = new Map<string, Set<string>>()
  for (const row of toolRows) {
    const ids = fixedMessageIdsOf(row.toolCalls)
    if (ids.length === 0) continue
    const set = fixedSent.get(row.conversationId) ?? new Set<string>()
    for (const id of ids) set.add(id)
    fixedSent.set(row.conversationId, set)
  }

  // Si una conversación tuviera dos etiquetas, el resultado (Pagó / No pagó)
  // gana sobre "Por validar".
  const qualification = new Map<string, QualificationOutcome>()
  for (const row of tagRows) {
    const outcome = outcomeByName.get(row.name)
    if (!outcome) continue
    const current = qualification.get(row.conversationId)
    if (current && current !== 'pending') continue
    qualification.set(row.conversationId, outcome)
  }

  const steps = buildFunnel({
    stages,
    conversationIds: cohortRows.map((r) => r.id),
    fixedSent,
    sentPhoto: new Set(photoRows.flatMap((r) => (r.conversationId ? [r.conversationId] : []))),
    qualification,
  })

  let escalations = 0
  let unanswered = 0
  let audios = 0
  for (const row of eventRows) {
    if (row.type === 'escalation') escalations += row.n
    else if (row.type === 'emma_unanswered') unanswered += row.n
    else if (row.format === 'audio' || row.format === 'voice_note') audios += row.n
  }

  const [pendingValidation, escalated] = await Promise.all([
    getPendingValidation(businessId, exec),
    getEscalatedInWindow(businessId, from, to, exec),
  ])

  return {
    steps,
    pendingValidation,
    escalated,
    signals: { escalations, escalationsBlocked: blockedRows[0]?.n ?? 0, unanswered, audios },
  }
}

// Los chats que hoy tienen "Por validar": mandaron la foto pedida y nadie marcó
// Pagó / No pagó todavía. Los que más esperan, primero.
async function getPendingValidation(
  businessId: string,
  exec: Executor,
): Promise<FunnelPendingItem[]> {
  const pausedAt = sql<string | null>`(
    select max(${events.createdAt}) from ${events}
    where ${events.businessId} = ${businessId}
      and ${events.conversationId} = ${conversations.id}
      and ${events.type} = 'emma_paused_on_image'
  )`
  const rows = await exec
    .select({
      conversationId: conversations.id,
      customerName: customers.name,
      phone: customers.phone,
      waJid: customers.waJid,
      pausedAt,
    })
    .from(conversationTags)
    .innerJoin(tagsTable, eq(tagsTable.id, conversationTags.tagId))
    .innerJoin(conversations, eq(conversations.id, conversationTags.conversationId))
    .innerJoin(customers, eq(customers.id, conversations.customerId))
    .where(
      and(
        eq(tagsTable.businessId, businessId),
        eq(conversations.businessId, businessId),
        eq(customers.businessId, businessId),
        eq(tagsTable.name, QUALIFICATION_TAGS.pending.name),
      ),
    )
    .orderBy(asc(pausedAt))
    .limit(ATTENTION_LIMIT)

  const now = Date.now()
  return rows.map((r) => ({
    conversationId: r.conversationId,
    customerName: formatPersonName(r.customerName),
    phone: r.phone,
    phoneHidden: isLidPhone(r.phone, r.waJid),
    hoursWaiting:
      r.pausedAt === null
        ? null
        : Math.max(0, Math.floor((now - new Date(r.pausedAt).getTime()) / 3_600_000)),
  }))
}

// Los chats escalados con actividad en el período, con el motivo de la última
// escalada. Un escalado viejo deja de importar: tras 24 h sin mensajes el
// cliente abre una conversación nueva.
async function getEscalatedInWindow(
  businessId: string,
  from: Date,
  to: Date,
  exec: Executor,
): Promise<FunnelEscalatedItem[]> {
  const reason = sql<string | null>`(
    select ${events.payload}->>'reason' from ${events}
    where ${events.businessId} = ${businessId}
      and ${events.conversationId} = ${conversations.id}
      and ${events.type} = 'escalation'
    order by ${events.createdAt} desc
    limit 1
  )`
  const escalatedAt = sql<string | null>`(
    select max(${events.createdAt}) from ${events}
    where ${events.businessId} = ${businessId}
      and ${events.conversationId} = ${conversations.id}
      and ${events.type} = 'escalation'
  )`
  const rows = await exec
    .select({
      conversationId: conversations.id,
      customerName: customers.name,
      phone: customers.phone,
      waJid: customers.waJid,
      reason,
      escalatedAt,
    })
    .from(conversations)
    .innerJoin(customers, eq(customers.id, conversations.customerId))
    .where(
      and(
        eq(conversations.businessId, businessId),
        eq(customers.businessId, businessId),
        CUSTOMER_THREAD,
        eq(conversations.status, 'escalated'),
        gte(conversations.lastMessageAt, from),
        lt(conversations.lastMessageAt, to),
      ),
    )
    .orderBy(desc(conversations.lastMessageAt))
    .limit(ATTENTION_LIMIT)

  return rows.map((r) => ({
    conversationId: r.conversationId,
    customerName: formatPersonName(r.customerName),
    phone: r.phone,
    phoneHidden: isLidPhone(r.phone, r.waJid),
    reason: r.reason,
    escalatedAt: r.escalatedAt === null ? null : new Date(r.escalatedAt).toISOString(),
  }))
}
