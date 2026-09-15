import type { AppointmentStatus, TagColor } from '../lib/constants.js'

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
  /** The owner's own labels on this thread. */
  tags: PanelTag[]
  status: string
  lastMessageAt: string | null
  lastMessagePreview: string
  /** Non-null while a person is holding the thread; Emma stays out until it clears. */
  humanTakeoverAt: string | null
  /** False when the owner switched Emma off for this chat specifically. */
  emmaEnabled: boolean
}

export interface PanelTag {
  id: string
  name: string
  color: TagColor
  createdAt: string
}

export type SenderType = 'customer' | 'bot' | 'human'

export interface PanelMessage {
  id: string
  senderType: SenderType
  content: string
  createdAt: string
}

export interface MessagePage extends Paged<PanelMessage> {
  humanTakeoverAt: string | null
  emmaEnabled: boolean
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

export interface PanelOverview {
  openConversations: number
  upcomingAppointments: number
  handledByOwner: number
  awaitingReply: number
}

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
    status: string
    lastMessageAt: string | null
  }>
}

// ── Settings (Config screen) ─────────────────────────────────────────────────
//
// Mirrors BusinessSettings in src/modules/business/business.settings.ts. Only
// the fields the config screen reads or writes are spelled out; `services` and
// the deposit fields ride along untouched and are typed loosely, because this
// screen must round-trip them without claiming to understand them.

export type Niche = 'dental' | 'barberia' | 'estetica' | 'salud' | 'general'
export type AppointmentMode = 'appointments_only' | 'hybrid'
export type BookingMode = 'direct' | 'requires_approval'

export interface SpecialDay {
  /** YYYY-MM-DD. */
  date: string
  /** Null means closed that date. */
  hours: DayHours | null
  label?: string
}

export interface PostBookingSettings {
  reminders: boolean
  confirmationReply: boolean
  postCareFollowUp: boolean
  recallAfterDays: number | null
  followUpAbandoned: boolean
}

export interface PanelService {
  name: string
  /** Null when the service has no fixed length; the slot grid decides. */
  durationMinutes: number | null
  priceMin: number | null
  priceMax: number | null
  requiresEvaluation: boolean
  referenceUrl?: string
  active: boolean
}

export type DepositMethod = 'yape' | 'plin' | 'transferencia' | 'efectivo'

export interface DepositPaymentMethod {
  method: DepositMethod
  number?: string
  label?: string
}

export interface BusinessSettingsView {
  niche: Niche
  appointmentMode: AppointmentMode
  bookingMode: BookingMode
  forwardImages: boolean
  requiresDeposit: boolean
  /** Free text on purpose: "S/ 20", "el 50%" are both things owners say. */
  depositAmount?: string
  depositPaymentMethods: DepositPaymentMethod[]
  services: PanelService[]
  slotDurationMinutes: number
  minBookingNoticeMinutes?: number
  operatingHours: OperatingHours
  specialDays?: SpecialDay[]
  postBooking: PostBookingSettings
}

export interface PanelSettings {
  name: string
  ownerName: string | null
  address: string | null
  googleMapsUrl: string | null
  timezone: string
  whatsappNumber: string
  /** Null when the business has never been configured. The UI says so rather than inventing defaults. */
  settings: BusinessSettingsView | null
  /** Field paths keeping the stored settings from validating. Empty when `settings` is non-null. */
  invalidFields: string[]
}

export interface GeneralPatch {
  name?: string
  ownerName?: string | null
  address?: string | null
  googleMapsUrl?: string
  timezone?: string
  niche?: Niche
  appointmentMode?: AppointmentMode
}

export interface BookingPatch {
  bookingMode?: BookingMode
  slotDurationMinutes?: number
  minBookingNoticeMinutes?: number
  forwardImages?: boolean
  postBooking?: PostBookingSettings
}

export interface PanelIntegrations {
  whatsapp: {
    connected: boolean
    status: string | null
    number: string
    lastEventAt: string | null
  }
  googleCalendar: {
    connected: boolean
    connectedAt: string | null
  }
}

// ── Services, payments and knowledge base ────────────────────────────────────

export interface PaymentsPatch {
  requiresDeposit?: boolean
  depositAmount?: string
  depositPaymentMethods?: DepositPaymentMethod[]
}

export type KbCategory = 'politicas' | 'informacion_general' | 'promociones'
export type KbSendMode = 'always' | 'on_request' | 'trigger_based'
export type KbAttachmentType = 'none' | 'link' | 'image' | 'pdf' | 'video'

export interface KnowledgeEntry {
  id: string
  title: string
  category: KbCategory
  content: string
  attachmentType: KbAttachmentType
  attachmentUrl: string | null
  sendMode: KbSendMode
  triggerKeywords: string[] | null
  active: boolean
  createdAt: string
  updatedAt: string
}

/** Create and patch share a shape; the server demands content+category on create. */
export interface KnowledgeInput {
  title?: string
  category?: KbCategory
  content?: string
  attachmentType?: KbAttachmentType
  attachmentUrl?: string | null
  sendMode?: KbSendMode
  triggerKeywords?: string[] | null
  active?: boolean
}
