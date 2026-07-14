import { db } from '@/db/client.js'
import {
  appointments,
  conversations,
  customers,
  googleCredentials,
  messages,
} from '@/db/schema/index.js'
import { and, count, desc, eq, gte, max } from 'drizzle-orm'

export async function getGoogleConnectedEmail(businessId: string): Promise<string | null> {
  const rows = await db
    .select({ connectedEmail: googleCredentials.connectedEmail })
    .from(googleCredentials)
    .where(eq(googleCredentials.businessId, businessId))
    .limit(1)
  return rows[0]?.connectedEmail ?? null
}

export async function deleteGoogleCredential(businessId: string): Promise<void> {
  await db.delete(googleCredentials).where(eq(googleCredentials.businessId, businessId))
}

// ── Business list stats ───────────────────────────────────────────────────────

export interface BusinessStats {
  customerCount: number
  conversationCount: number
  appointmentCount: number
  lastMessageAt: Date | null
}

export async function getAllBusinessesStats(): Promise<Map<string, BusinessStats>> {
  const [custRows, convRows, apptRows, msgRows] = await Promise.all([
    db
      .select({ businessId: customers.businessId, n: count() })
      .from(customers)
      .groupBy(customers.businessId),
    db
      .select({ businessId: conversations.businessId, n: count() })
      .from(conversations)
      .groupBy(conversations.businessId),
    db
      .select({ businessId: appointments.businessId, n: count() })
      .from(appointments)
      .groupBy(appointments.businessId),
    db
      .select({ businessId: messages.businessId, at: max(messages.createdAt) })
      .from(messages)
      .groupBy(messages.businessId),
  ])

  const map = new Map<string, BusinessStats>()
  const get = (id: string): BusinessStats => {
    if (!map.has(id)) {
      map.set(id, { customerCount: 0, conversationCount: 0, appointmentCount: 0, lastMessageAt: null })
    }
    return map.get(id)!
  }

  for (const r of custRows) get(r.businessId).customerCount = Number(r.n)
  for (const r of convRows) get(r.businessId).conversationCount = Number(r.n)
  for (const r of apptRows) get(r.businessId).appointmentCount = Number(r.n)
  for (const r of msgRows) get(r.businessId).lastMessageAt = r.at ?? null

  return map
}

// ── Business detail ───────────────────────────────────────────────────────────

export interface RecentCustomer {
  id: string
  name: string | null
  phone: string
  lastSeenAt: Date | null
  createdAt: Date
}

export interface RecentAppointment {
  id: string
  service: string
  scheduledAt: Date
  status: string
  customerName: string | null
  customerPhone: string
}

export interface BusinessDetailStats {
  recentCustomers: RecentCustomer[]
  recentAppointments: RecentAppointment[]
  messagesToday: number
  messagesThisWeek: number
  appointmentsThisWeek: number
  googleConnectedEmail: string | null
}

export async function getBusinessDetail(businessId: string): Promise<BusinessDetailStats> {
  const now = new Date()
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const weekStart = new Date(startOfDay)
  weekStart.setDate(startOfDay.getDate() - 6)

  const [
    recentCustomers,
    rawAppointments,
    [todayRow],
    [weekRow],
    [apptWeekRow],
    gcRows,
  ] = await Promise.all([
    db
      .select({
        id: customers.id,
        name: customers.name,
        phone: customers.phone,
        lastSeenAt: customers.lastSeenAt,
        createdAt: customers.createdAt,
      })
      .from(customers)
      .where(eq(customers.businessId, businessId))
      .orderBy(desc(customers.createdAt))
      .limit(20),

    db
      .select({
        id: appointments.id,
        service: appointments.service,
        scheduledAt: appointments.scheduledAt,
        status: appointments.status,
        customerName: customers.name,
        customerPhone: customers.phone,
      })
      .from(appointments)
      .leftJoin(customers, eq(appointments.customerId, customers.id))
      .where(eq(appointments.businessId, businessId))
      .orderBy(desc(appointments.scheduledAt))
      .limit(10),

    db
      .select({ n: count() })
      .from(messages)
      .where(and(eq(messages.businessId, businessId), gte(messages.createdAt, startOfDay))),

    db
      .select({ n: count() })
      .from(messages)
      .where(and(eq(messages.businessId, businessId), gte(messages.createdAt, weekStart))),

    db
      .select({ n: count() })
      .from(appointments)
      .where(and(eq(appointments.businessId, businessId), gte(appointments.scheduledAt, weekStart))),

    db
      .select({ connectedEmail: googleCredentials.connectedEmail })
      .from(googleCredentials)
      .where(eq(googleCredentials.businessId, businessId))
      .limit(1),
  ])

  return {
    recentCustomers,
    recentAppointments: rawAppointments.map((r) => ({
      id: r.id,
      service: r.service,
      scheduledAt: r.scheduledAt,
      status: r.status,
      customerName: r.customerName ?? null,
      customerPhone: r.customerPhone ?? '',
    })),
    messagesToday: Number(todayRow?.n ?? 0),
    messagesThisWeek: Number(weekRow?.n ?? 0),
    appointmentsThisWeek: Number(apptWeekRow?.n ?? 0),
    googleConnectedEmail: gcRows[0]?.connectedEmail ?? null,
  }
}
