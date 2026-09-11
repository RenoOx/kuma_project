import type { AppointmentStatus, Qualification } from '../lib/constants.js'

// The wire shapes the panel API answers with. Hand-written rather than shared
// with the server: the two build with different tsconfigs and module
// resolutions, and importing across that boundary would drag the whole backend
// into the browser bundle. The cost is that a change to panel.repo's return
// types has to be mirrored here — which is why these live in one file.

export interface Paged<T> {
  data: T[]
  total: number
  page: number
}

export interface PanelMe {
  id: string
  name: string
  niche: string
  ownerName: string | null
  timezone: string
  /** Null for a business with no settings yet — the calendar then shades nothing. */
  operatingHours: OperatingHours | null
}

/** One day of the weekly schedule. Null means closed that day. */
export interface DayHours {
  open: string
  close: string
  break?: { start: string; end: string }
}

export type DayKey =
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday'
  | 'sunday'

export type OperatingHours = Record<DayKey, DayHours | null>

export interface PanelHealth {
  connected: boolean
  status?: string
  lastEventAt: string | null
  downSince?: string
}

export interface UpdatesMarker {
  hasUpdates: boolean
  lastUpdate: string | null
}

export interface ConversationListItem {
  id: string
  customerId: string | null
  customerName: string | null
  /** Names this number has booked under, newest booking first. */
  appointmentNames: string[]
  phone: string
  qualification: Qualification
  status: string
  lastMessageAt: string | null
  lastMessagePreview: string
  humanTakeoverAt: string | null
}

export type SenderType = 'customer' | 'bot' | 'human'

export interface PanelMessage {
  id: string
  senderType: SenderType
  content: string
  createdAt: string
}

export interface MessagePage extends Paged<PanelMessage> {
  qualification: Qualification
}

/**
 * A message the panel has drawn but the server has not confirmed.
 *
 * Carried in the same list as the real ones so the chat renders one sequence:
 * the alternative is a second array below the transcript, which drifts out of
 * order the moment anything else arrives.
 */
export interface PendingMessage extends PanelMessage {
  pending: true
  failed?: boolean
}

export type ChatMessage = PanelMessage | PendingMessage

export function isPending(message: ChatMessage): message is PendingMessage {
  return 'pending' in message
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

export interface AppointmentsResponse {
  data: PanelAppointment[]
  /** Every pending appointment the business has, not only those in range. */
  pendingCount: number
}

/**
 * What the four appointment actions answer with.
 *
 * `patientNotified` is the part that matters to the owner: the status always
 * changes, but the WhatsApp to the customer can fail on its own, and the panel
 * has to be able to say so instead of implying the customer was told.
 */
export interface AppointmentActionResult {
  success: boolean
  status: AppointmentStatus
  patientNotified?: boolean
  patientNotifyError?: string
}

// ── Dashboard ────────────────────────────────────────────────────────────────

export interface PanelStats {
  conversations: number
  appointments: number
  /** Seconds between a customer's message and Emma's answer. */
  avgResponseTime: number
  /** Whole percent of conversations that ended in an appointment (0-100). */
  conversionRate: number
  prevConversations: number
  prevAppointments: number
}

export type QualificationBreakdown = Record<Qualification, number>

export interface ActivityPoint {
  date: string
  conversations: number
}

export type StatsPeriod = 'today' | 'week' | 'month'

// ── Customers ────────────────────────────────────────────────────────────────

export interface CustomerListItem {
  id: string
  name: string | null
  /** Names this number has booked under, newest booking first. */
  appointmentNames: string[]
  phone: string
  lastSeenAt: string | null
  conversationCount: number
  appointmentCount: number
  /** WhatsApp has flagged the number as dead: Emma will not send to it. */
  unreachable: boolean
}

export interface CustomerRecord {
  id: string
  name: string | null
  phone: string
  lastSeenAt: string | null
  whatsappUnreachableAt: string | null
  createdAt: string
}

export interface CustomerDetail {
  customer: CustomerRecord
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
    qualification: Qualification
    status: string
    lastMessageAt: string | null
  }>
}
