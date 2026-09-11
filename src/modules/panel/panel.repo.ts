import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gte,
  ilike,
  inArray,
  isNotNull,
  lt,
  lte,
  or,
  sql,
} from 'drizzle-orm'
import { db, type Executor } from '@/db/client.js'
import {
  type Appointment,
  type AppointmentStatus,
  appointments,
  type ConversationQualification,
  type Customer,
  conversations,
  customers,
  messages,
} from '@/db/schema/index.js'
import { toPanelDisplay } from '@/modules/message/messageDisplay.js'
import { appointmentName, formatPersonName } from '@/shared/name.js'

// Every query in this file filters on business_id, without exception — the
// panel is the one surface where a tenant leak would be handing one business
// another's customer list. That is a hard rule, not a convention: a query here
// that takes no businessId is a bug.
//
// Owner threads are excluded from everything customer-facing: they are Emma
// talking to the owner, and showing them in the owner's own inbox would be a
// conversation with themselves.
const CUSTOMER_THREAD = eq(conversations.type, 'customer')

export interface Page<T> {
  data: T[]
  total: number
  page: number
}

// ── Updates poll ─────────────────────────────────────────────────────────────

export interface UpdatesMarker {
  hasUpdates: boolean
  lastUpdate: string | null
}

/**
 * The cheap half of US-03: one aggregate the inbox polls every 5s, so the
 * expensive list query only runs when something actually moved.
 *
 * Both columns matter. max(last_message_at) misses a qualification change that
 * wrote no message (the transitions worker, a return-to-Emma), and updated_at
 * alone would miss nothing but is the newer column — taking the later of the
 * two catches both without assuming either is always set.
 */
export async function getUpdatesMarker(
  businessId: string,
  since: Date | null,
  exec: Executor = db,
): Promise<UpdatesMarker> {
  const [row] = await exec
    .select({
      // An aggregate through a raw template comes back as text, not a Date —
      // Drizzle only maps column types it can see, and max() hides them. Parsed
      // below rather than trusted, which is what made this return null.
      lastMessageAt: sql<string | null>`max(${conversations.lastMessageAt})`,
      lastUpdatedAt: sql<string | null>`max(${conversations.updatedAt})`,
    })
    .from(conversations)
    .where(and(eq(conversations.businessId, businessId), CUSTOMER_THREAD))

  const latest = [row?.lastMessageAt, row?.lastUpdatedAt]
    .map(toDate)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0]

  if (!latest) return { hasUpdates: false, lastUpdate: null }
  return {
    hasUpdates: since === null || latest.getTime() > since.getTime(),
    lastUpdate: latest.toISOString(),
  }
}

/** Accepts whatever the driver hands back for a timestamp: Date, text, or null. */
function toDate(value: Date | string | null | undefined): Date | null {
  if (value instanceof Date) return value
  if (typeof value !== 'string') return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

// ── Conversations ────────────────────────────────────────────────────────────

export interface ConversationListItem {
  id: string
  customerId: string | null
  customerName: string | null
  /** Names this number has booked under, newest booking first. See `appointmentNamesByCustomer`. */
  appointmentNames: string[]
  phone: string
  qualification: ConversationQualification
  status: string
  lastMessageAt: string | null
  lastMessagePreview: string
  humanTakeoverAt: string | null
}

export interface ConversationFilters {
  qualification?: ConversationQualification
  search?: string
  page: number
  limit: number
}

export async function listConversations(
  businessId: string,
  filters: ConversationFilters,
  exec: Executor = db,
): Promise<Page<ConversationListItem>> {
  const clauses = [eq(conversations.businessId, businessId), CUSTOMER_THREAD]
  if (filters.qualification) {
    clauses.push(eq(conversations.qualification, filters.qualification))
  }
  if (filters.search) {
    // Phone or a name the number has booked under — the two things the list
    // actually shows. `customers.name` is deliberately not searched: it holds
    // the WhatsApp push name and whatever Emma was last told, neither of which
    // appears on screen, so matching it would return rows with no visible
    // reason for being there.
    const term = `%${filters.search}%`
    const match = or(ilike(customers.phone, term), bookedUnderName(businessId, term, exec))
    if (match) clauses.push(match)
  }
  const where = and(...clauses)

  const [rows, [totalRow]] = await Promise.all([
    exec
      .select({
        id: conversations.id,
        customerId: conversations.customerId,
        name: customers.name,
        phone: customers.phone,
        qualification: conversations.qualification,
        status: conversations.status,
        lastMessageAt: conversations.lastMessageAt,
        humanTakeoverAt: conversations.humanTakeoverAt,
      })
      .from(conversations)
      .leftJoin(customers, eq(conversations.customerId, customers.id))
      .where(where)
      .orderBy(sql`${conversations.lastMessageAt} DESC NULLS LAST`)
      .limit(filters.limit)
      .offset((filters.page - 1) * filters.limit),
    exec
      .select({ n: count() })
      .from(conversations)
      .leftJoin(customers, eq(conversations.customerId, customers.id))
      .where(where),
  ])

  const [previews, names] = await Promise.all([
    lastMessagePreviews(
      businessId,
      rows.map((r) => r.id),
      exec,
    ),
    appointmentNamesByCustomer(
      businessId,
      rows.flatMap((r) => (r.customerId === null ? [] : [r.customerId])),
      exec,
    ),
  ])

  return {
    data: rows.map((r) => ({
      id: r.id,
      customerId: r.customerId,
      customerName: formatPersonName(r.name),
      appointmentNames: r.customerId === null ? [] : (names.get(r.customerId) ?? []),
      phone: r.phone ?? '',
      qualification: r.qualification,
      status: r.status,
      lastMessageAt: r.lastMessageAt?.toISOString() ?? null,
      lastMessagePreview: previews.get(r.id) ?? '',
      humanTakeoverAt: r.humanTakeoverAt?.toISOString() ?? null,
    })),
    total: Number(totalRow?.n ?? 0),
    page: filters.page,
  }
}

/**
 * Last visible message per conversation, in ONE query for the whole page.
 *
 * The obvious version — a query per row inside the map — is twenty round trips
 * for a screen that refreshes every five seconds. DISTINCT ON is Postgres doing
 * the same work once.
 *
 * 'tool' turns are excluded: they are the model's plumbing, and a preview
 * reading like a JSON blob of availability tells the owner nothing.
 */
async function lastMessagePreviews(
  businessId: string,
  conversationIds: string[],
  exec: Executor = db,
): Promise<Map<string, string>> {
  if (conversationIds.length === 0) return new Map()

  const rows = await exec
    .selectDistinctOn([messages.conversationId], {
      conversationId: messages.conversationId,
      content: messages.content,
    })
    .from(messages)
    .where(
      and(
        eq(messages.businessId, businessId),
        inArray(messages.conversationId, conversationIds),
        inArray(messages.role, ['user', 'assistant']),
        sql`length(trim(${messages.content})) > 0`,
      ),
    )
    .orderBy(messages.conversationId, desc(messages.createdAt))

  return new Map(rows.map((r) => [r.conversationId, toPanelDisplay(r.content)]))
}

export interface PanelMessage {
  id: string
  senderType: string
  content: string
  createdAt: string
}

/**
 * Which end of the transcript page 1 is.
 *
 * 'desc' is the default because a chat opens at the bottom: page 1 has to be
 * the LAST `limit` messages, and page 2 the ones before them, so "load earlier"
 * is just the next page. Ordering ascending from page 1 — the shape this had
 * first — opens every conversation on its oldest messages, which for a thread
 * of any length is the wrong end entirely.
 *
 * Either way the rows come back oldest-first, because that is the only order a
 * transcript renders in. The parameter picks WHICH slice, not how it reads.
 */
export type MessageOrder = 'asc' | 'desc'

export async function listMessages(
  businessId: string,
  conversationId: string,
  page: number,
  limit: number,
  order: MessageOrder = 'desc',
  exec: Executor = db,
): Promise<Page<PanelMessage>> {
  // Tool calls and system turns are Emma's internals. The owner wants the
  // conversation, not the transcript of how it was produced. An assistant turn
  // that only carried tool_calls has empty content and would render as a blank
  // bubble, so it is filtered out by length rather than by role.
  const where = and(
    eq(messages.businessId, businessId),
    eq(messages.conversationId, conversationId),
    inArray(messages.role, ['user', 'assistant']),
    sql`length(trim(${messages.content})) > 0`,
  )

  const [rows, [totalRow]] = await Promise.all([
    exec
      .select({
        id: messages.id,
        senderType: messages.senderType,
        content: messages.content,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(where)
      .orderBy(order === 'desc' ? desc(messages.createdAt) : asc(messages.createdAt))
      .limit(limit)
      .offset((page - 1) * limit),
    exec.select({ n: count() }).from(messages).where(where),
  ])

  // Same DESC + LIMIT + reverse pattern messageRepo.findRecentByConversation
  // uses: the index does the work, the reversal is free at this size.
  const chronological = order === 'desc' ? [...rows].reverse() : rows

  return {
    data: chronological.map((r) => ({
      id: r.id,
      senderType: r.senderType,
      content: toPanelDisplay(r.content),
      createdAt: r.createdAt.toISOString(),
    })),
    total: Number(totalRow?.n ?? 0),
    page,
  }
}

/** Tenant-scoped lookup. Returns null for another business's conversation. */
export async function findConversation(
  businessId: string,
  conversationId: string,
  exec: Executor = db,
): Promise<{
  id: string
  customerId: string | null
  qualification: ConversationQualification
} | null> {
  const [row] = await exec
    .select({
      id: conversations.id,
      customerId: conversations.customerId,
      qualification: conversations.qualification,
    })
    .from(conversations)
    .where(and(eq(conversations.businessId, businessId), eq(conversations.id, conversationId)))
    .limit(1)
  return row ?? null
}

// ── Stats ────────────────────────────────────────────────────────────────────

export interface PanelStats {
  conversations: number
  appointments: number
  avgResponseTime: number
  conversionRate: number
  prevConversations: number
  prevAppointments: number
}

export async function getStats(
  businessId: string,
  from: Date,
  to: Date,
  prevFrom: Date,
  exec: Executor = db,
): Promise<PanelStats> {
  const inWindow = and(
    eq(conversations.businessId, businessId),
    CUSTOMER_THREAD,
    gte(conversations.createdAt, from),
    lt(conversations.createdAt, to),
  )
  const inPrevWindow = and(
    eq(conversations.businessId, businessId),
    CUSTOMER_THREAD,
    gte(conversations.createdAt, prevFrom),
    lt(conversations.createdAt, from),
  )

  const [[convRow], [prevConvRow], [apptRow], [prevApptRow], respResult, convertedResult] =
    await Promise.all([
      exec.select({ n: count() }).from(conversations).where(inWindow),
      exec.select({ n: count() }).from(conversations).where(inPrevWindow),
      exec
        .select({ n: count() })
        .from(appointments)
        .where(
          and(
            eq(appointments.businessId, businessId),
            gte(appointments.createdAt, from),
            lt(appointments.createdAt, to),
          ),
        ),
      exec
        .select({ n: count() })
        .from(appointments)
        .where(
          and(
            eq(appointments.businessId, businessId),
            gte(appointments.createdAt, prevFrom),
            lt(appointments.createdAt, from),
          ),
        ),
      // Seconds between a customer turn and the reply that follows it in the
      // same conversation. The window function does the pairing in the database;
      // pulling every message out to pair them in JS would move the whole
      // transcript across the wire to compute one number.
      //
      // Gaps over an hour are dropped: that is a customer coming back the next
      // day, not Emma being slow, and a handful of them would swamp the average.
      exec.execute(sql`
        SELECT avg(gap) AS avg_seconds FROM (
          SELECT EXTRACT(EPOCH FROM (m.created_at - lag(m.created_at) OVER w)) AS gap,
                 lag(m.sender_type) OVER w AS prev_sender,
                 m.sender_type AS sender
          FROM messages m
          WHERE m.business_id = ${businessId}
            AND m.created_at >= ${from.toISOString()}::timestamptz
            AND m.created_at < ${to.toISOString()}::timestamptz
            AND m.role IN ('user', 'assistant')
          WINDOW w AS (PARTITION BY m.conversation_id ORDER BY m.created_at)
        ) paired
        WHERE prev_sender = 'customer' AND sender = 'bot' AND gap IS NOT NULL AND gap < 3600
      `),
      // Conversations in the window whose customer booked inside it. Counted per
      // conversation, not per appointment, or a customer who books twice would
      // push the rate over 100%.
      exec.execute(sql`
        SELECT count(DISTINCT c.id) AS n
        FROM conversations c
        JOIN appointments a
          ON a.customer_id = c.customer_id
         AND a.business_id = c.business_id
         AND a.created_at >= ${from.toISOString()}::timestamptz
         AND a.created_at < ${to.toISOString()}::timestamptz
        WHERE c.business_id = ${businessId}
          AND c.type = 'customer'
          AND c.created_at >= ${from.toISOString()}::timestamptz
          AND c.created_at < ${to.toISOString()}::timestamptz
      `),
    ])

  const totalConversations = Number(convRow?.n ?? 0)
  const converted = Number(readScalar(convertedResult, 'n') ?? 0)
  const avgSeconds = Number(readScalar(respResult, 'avg_seconds') ?? 0)

  return {
    conversations: totalConversations,
    appointments: Number(apptRow?.n ?? 0),
    avgResponseTime: Number.isFinite(avgSeconds) ? Math.round(avgSeconds) : 0,
    conversionRate:
      totalConversations === 0 ? 0 : Math.round((converted / totalConversations) * 100),
    prevConversations: Number(prevConvRow?.n ?? 0),
    prevAppointments: Number(prevApptRow?.n ?? 0),
  }
}

/**
 * Reads one column out of a raw `execute` result.
 *
 * postgres.js hands back an array-like of plain row objects while other drivers
 * wrap them in `.rows`, and Drizzle types the result loosely either way. This
 * is the type guard that keeps `any` out of the caller without pretending to
 * know which shape arrived.
 */
function readScalar(result: unknown, column: string): unknown {
  const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] })?.rows ?? [])
  const first = rows[0]
  if (first && typeof first === 'object' && column in first) {
    return (first as Record<string, unknown>)[column]
  }
  return null
}

export type QualificationBreakdown = Record<ConversationQualification, number>

export async function getQualificationBreakdown(
  businessId: string,
  exec: Executor = db,
): Promise<QualificationBreakdown> {
  const rows = await exec
    .select({ qualification: conversations.qualification, n: count() })
    .from(conversations)
    .where(and(eq(conversations.businessId, businessId), CUSTOMER_THREAD))
    .groupBy(conversations.qualification)

  // Every key present at zero rather than absent: the dashboard renders a tile
  // per state, and a missing key would collapse the row's layout.
  const breakdown: QualificationBreakdown = {
    new: 0,
    qualified: 0,
    needs_info: 0,
    appointment: 0,
    waiting: 0,
    lost: 0,
    human_takeover: 0,
  }
  for (const row of rows) {
    breakdown[row.qualification] = Number(row.n)
  }
  return breakdown
}

export interface ActivityPoint {
  date: string
  conversations: number
}

export async function getActivity(
  businessId: string,
  days: number,
  exec: Executor = db,
): Promise<ActivityPoint[]> {
  const since = new Date()
  since.setDate(since.getDate() - (days - 1))
  since.setHours(0, 0, 0, 0)

  const rows = await exec
    .select({
      day: sql<string>`to_char(${conversations.createdAt}, 'YYYY-MM-DD')`,
      n: count(),
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.businessId, businessId),
        CUSTOMER_THREAD,
        gte(conversations.createdAt, since),
      ),
    )
    .groupBy(sql`1`)

  // Days with no conversations are absent from the group-by and would leave the
  // line chart interpolating straight through them. Zero-filled here so the
  // chart draws what actually happened.
  const counts = new Map(rows.map((r) => [r.day, Number(r.n)]))
  const points: ActivityPoint[] = []
  for (let i = 0; i < days; i++) {
    const d = new Date(since)
    d.setDate(since.getDate() + i)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    points.push({ date: key, conversations: counts.get(key) ?? 0 })
  }
  return points
}

// ── Customers ────────────────────────────────────────────────────────────────

export interface CustomerListItem {
  id: string
  name: string | null
  /** Names this number has booked under, newest booking first. See `appointmentNamesByCustomer`. */
  appointmentNames: string[]
  phone: string
  lastSeenAt: string | null
  conversationCount: number
  appointmentCount: number
  unreachable: boolean
}

export async function listCustomers(
  businessId: string,
  search: string | undefined,
  page: number,
  limit: number,
  exec: Executor = db,
): Promise<Page<CustomerListItem>> {
  const clauses = [eq(customers.businessId, businessId)]
  if (search) {
    const term = `%${search}%`
    const match = or(ilike(customers.phone, term), bookedUnderName(businessId, term, exec))
    if (match) clauses.push(match)
  }
  const where = and(...clauses)

  const [rows, [totalRow]] = await Promise.all([
    exec
      .select({
        id: customers.id,
        name: customers.name,
        phone: customers.phone,
        lastSeenAt: customers.lastSeenAt,
        whatsappUnreachableAt: customers.whatsappUnreachableAt,
      })
      .from(customers)
      .where(where)
      // NULLS LAST so a customer who has never written does not outrank one who
      // wrote an hour ago.
      .orderBy(sql`${customers.lastSeenAt} DESC NULLS LAST`)
      .limit(limit)
      .offset((page - 1) * limit),
    exec.select({ n: count() }).from(customers).where(where),
  ])

  const ids = rows.map((r) => r.id)
  const [convCounts, apptCounts, names] = await Promise.all([
    countConversationsByCustomer(businessId, ids, exec),
    countAppointmentsByCustomer(businessId, ids, exec),
    appointmentNamesByCustomer(businessId, ids, exec),
  ])

  return {
    data: rows.map((r) => ({
      id: r.id,
      name: formatPersonName(r.name),
      appointmentNames: names.get(r.id) ?? [],
      phone: r.phone,
      lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
      conversationCount: convCounts.get(r.id) ?? 0,
      appointmentCount: apptCounts.get(r.id) ?? 0,
      unreachable: r.whatsappUnreachableAt !== null,
    })),
    total: Number(totalRow?.n ?? 0),
    page,
  }
}

// Two near-identical functions rather than one generic over the column: the
// tables have different types and threading them through a shared signature
// costs more in casts than the six lines it saves.
async function countConversationsByCustomer(
  businessId: string,
  customerIds: string[],
  exec: Executor,
): Promise<Map<string, number>> {
  if (customerIds.length === 0) return new Map()
  const rows = await exec
    .select({ customerId: conversations.customerId, n: count() })
    .from(conversations)
    .where(
      and(eq(conversations.businessId, businessId), inArray(conversations.customerId, customerIds)),
    )
    .groupBy(conversations.customerId)
  return new Map(rows.map((r) => [r.customerId ?? '', Number(r.n)]))
}

async function countAppointmentsByCustomer(
  businessId: string,
  customerIds: string[],
  exec: Executor,
): Promise<Map<string, number>> {
  if (customerIds.length === 0) return new Map()
  const rows = await exec
    .select({ customerId: appointments.customerId, n: count() })
    .from(appointments)
    .where(
      and(eq(appointments.businessId, businessId), inArray(appointments.customerId, customerIds)),
    )
    .groupBy(appointments.customerId)
  return new Map(rows.map((r) => [r.customerId, Number(r.n)]))
}

/**
 * The names each number has booked under, newest booking first.
 *
 * A phone is one WhatsApp account, not one person: the same number books for
 * "Juan Pérez" today and "María Pérez" next week, and both are real patients.
 * So the panel identifies a contact by its number and hangs these names off it
 * as labels, instead of pretending the last one to speak is who the number is.
 *
 * Reads `appointments.customer_name` with NO fallback to `customers.name`, on
 * purpose — `appointmentName()` has one, and using it here would let the
 * WhatsApp push name come back in through the side door dressed as a booking.
 * The cost is that bookings filed before that column existed, and slots the
 * owner proposed before anyone gave a name, contribute no label.
 *
 * One query for the whole page, like `lastMessagePreviews`: the inbox refreshes
 * every five seconds and a query per row would be twenty round trips each time.
 */
async function appointmentNamesByCustomer(
  businessId: string,
  customerIds: string[],
  exec: Executor = db,
): Promise<Map<string, string[]>> {
  if (customerIds.length === 0) return new Map()

  const rows = await exec
    .select({ customerId: appointments.customerId, name: appointments.customerName })
    .from(appointments)
    .where(
      and(
        eq(appointments.businessId, businessId),
        inArray(appointments.customerId, customerIds),
        isNotNull(appointments.customerName),
        sql`length(trim(${appointments.customerName})) > 0`,
      ),
    )
    .orderBy(desc(appointments.scheduledAt))

  const raw = new Map<string, Array<string | null>>()
  for (const row of rows) {
    const list = raw.get(row.customerId)
    if (list) list.push(row.name)
    else raw.set(row.customerId, [row.name])
  }
  return new Map([...raw].map(([customerId, list]) => [customerId, dedupeDisplayNames(list)]))
}

/**
 * Formats booking names for display and drops the repeats.
 *
 * Deduped on the formatted value, case-insensitively: "JUAN PEREZ" typed into
 * one booking and "Juan Pérez" into the next are one label to a reader, and
 * showing both would read as a bug. Input order is preserved, so callers that
 * pass newest-first get newest-first back.
 */
function dedupeDisplayNames(raw: Array<string | null>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of raw) {
    const display = formatPersonName(value)
    if (!display) continue
    const key = display.toLocaleLowerCase('es')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(display)
  }
  return out
}

/**
 * Search clause matching a customer whose bookings carry `term` as a name.
 *
 * Correlated on `customers.id`, so it composes with whatever else the caller is
 * filtering. Without it, searching the panel for "Juan Pérez" finds nobody the
 * moment names stop living on the contact — the owner sees the label on screen
 * and cannot search for it.
 */
function bookedUnderName(businessId: string, term: string, exec: Executor = db) {
  return exists(
    exec
      .select({ one: sql`1` })
      .from(appointments)
      .where(
        and(
          eq(appointments.businessId, businessId),
          eq(appointments.customerId, customers.id),
          ilike(appointments.customerName, term),
        ),
      ),
  )
}

export interface CustomerDetail {
  customer: Customer
  /** Names this number has booked under, newest booking first. */
  appointmentNames: string[]
  appointments: Array<{
    id: string
    service: string
    scheduledAt: string
    status: AppointmentStatus
    customerName: string | null
  }>
  conversations: Array<{
    id: string
    qualification: ConversationQualification
    status: string
    lastMessageAt: string | null
  }>
}

export async function getCustomerDetail(
  businessId: string,
  customerId: string,
  exec: Executor = db,
): Promise<CustomerDetail | null> {
  const [customer] = await exec
    .select()
    .from(customers)
    .where(and(eq(customers.businessId, businessId), eq(customers.id, customerId)))
    .limit(1)
  if (!customer) return null

  const [appts, convs] = await Promise.all([
    exec
      .select()
      .from(appointments)
      .where(and(eq(appointments.businessId, businessId), eq(appointments.customerId, customerId)))
      .orderBy(desc(appointments.scheduledAt)),
    exec
      .select({
        id: conversations.id,
        qualification: conversations.qualification,
        status: conversations.status,
        lastMessageAt: conversations.lastMessageAt,
      })
      .from(conversations)
      .where(
        and(eq(conversations.businessId, businessId), eq(conversations.customerId, customerId)),
      )
      .orderBy(sql`${conversations.lastMessageAt} DESC NULLS LAST`),
  ])

  return {
    customer,
    // Derived from the rows already in hand — `appts` is this customer's whole
    // history, newest first, which is exactly what the labels need.
    appointmentNames: dedupeDisplayNames(appts.map((a) => a.customerName)),
    appointments: appts.map((a) => ({
      id: a.id,
      service: a.service,
      scheduledAt: a.scheduledAt.toISOString(),
      status: a.status,
      customerName: formatPersonName(appointmentName(a, customer)),
    })),
    conversations: convs.map((c) => ({
      id: c.id,
      qualification: c.qualification,
      status: c.status,
      lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
    })),
  }
}

// ── Appointments ─────────────────────────────────────────────────────────────

export interface PanelAppointment {
  id: string
  customerId: string
  customerName: string | null
  customerPhone: string
  service: string
  scheduledAt: string
  durationMinutes: number
  status: AppointmentStatus
  notes: string | null
}

export async function listAppointments(
  businessId: string,
  from: Date,
  to: Date,
  exec: Executor = db,
): Promise<PanelAppointment[]> {
  const rows = await exec
    .select({
      appointment: appointments,
      customerName: customers.name,
      customerPhone: customers.phone,
    })
    .from(appointments)
    .leftJoin(customers, eq(appointments.customerId, customers.id))
    .where(
      and(
        eq(appointments.businessId, businessId),
        gte(appointments.scheduledAt, from),
        lte(appointments.scheduledAt, to),
      ),
    )
    .orderBy(asc(appointments.scheduledAt))

  return rows.map((r) => ({
    id: r.appointment.id,
    customerId: r.appointment.customerId,
    customerName: formatPersonName(
      appointmentName(r.appointment, { name: r.customerName ?? null }),
    ),
    customerPhone: r.customerPhone ?? '',
    service: r.appointment.service,
    scheduledAt: r.appointment.scheduledAt.toISOString(),
    durationMinutes: r.appointment.durationMinutes,
    status: r.appointment.status,
    notes: r.appointment.notes,
  }))
}

export async function countPendingAppointments(
  businessId: string,
  exec: Executor = db,
): Promise<number> {
  const [row] = await exec
    .select({ n: count() })
    .from(appointments)
    .where(and(eq(appointments.businessId, businessId), eq(appointments.status, 'pending')))
  return Number(row?.n ?? 0)
}

/** Tenant-scoped lookup, with the customer needed to message them. */
export async function findAppointmentWithCustomer(
  businessId: string,
  appointmentId: string,
  exec: Executor = db,
): Promise<{ appointment: Appointment; customer: Customer | null } | null> {
  const [row] = await exec
    .select({ appointment: appointments, customer: customers })
    .from(appointments)
    .leftJoin(customers, eq(appointments.customerId, customers.id))
    .where(and(eq(appointments.businessId, businessId), eq(appointments.id, appointmentId)))
    .limit(1)
  if (!row) return null
  return { appointment: row.appointment, customer: row.customer }
}
