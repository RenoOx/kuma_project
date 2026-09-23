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
  /**
   * False for a business that only sells (flowType 'sales').
   *
   * The shell hides everything that exists to manage appointments — the Agenda
   * screen, the booking rules, Google Calendar — because an institute selling
   * courses has no slots, no reminders and no calendar to sync. The hours stay:
   * they decide when Emma answers, which every business has.
   */
  booksAppointments: boolean
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

export type SlotWarningCode =
  | 'closed_day'
  | 'outside_hours'
  | 'break_overlap'
  | 'slot_too_soon'
  | 'overlap'

/** Written server-side for the owner to read. Rendered verbatim. */
export interface SlotWarning {
  code: SlotWarningCode
  message: string
}

export interface CreateAppointmentPayload {
  /** One of the two is required: an existing contact, or a phone to create one. */
  customerId?: string
  phone?: string
  customerName?: string
  service: string
  /** Wall clock in the business's timezone. */
  date: string
  time: string
  notes?: string
  notifyCustomer: boolean
  /** Second attempt, after the owner read the warnings and said "igual". */
  force: boolean
}

/**
 * Two outcomes, one status code.
 *
 * A slot that breaks a rule is not an error — the owner may book through it —
 * so the warnings come back on the happy path and the caller branches on
 * `created`, instead of catching an exception to drive a normal step of the flow.
 */
export type CreateAppointmentResult =
  | { created: false; warnings: SlotWarning[] }
  | {
      created: true
      warnings: SlotWarning[]
      appointmentId: string
      status: AppointmentStatus
      scheduledAt: string
      customerId: string
      patientNotified: boolean
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
  /**
   * What this customer answered in the capture step, keyed by the field name
   * the owner configured. Empty for a business that collects nothing.
   */
  collectedData: Record<string, string>
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
  /**
   * Stable id, minted server-side on the first save. Absent on a service being
   * created right now, which is why uploading a file waits for the first save:
   * every file hangs off this id.
   */
  id?: string
  name: string
  /** What it is, in the owner's words. Absent until they write one. */
  description?: string
  /**
   * How the owner groups their catalogue: "Nivel inicial", "Uñas".
   *
   * Emma reads it next to the name, and once two services carry different ones
   * she lists the catalogue grouped instead of flat.
   */
  category?: string
  /** Null when the service has no fixed length; the slot grid decides. */
  durationMinutes: number | null
  priceMin: number | null
  priceMax: number | null
  requiresEvaluation: boolean
  referenceUrl?: string
  active: boolean
}

export type ServiceMediaType = 'image' | 'pdf' | 'audio' | 'video'

/** One stored file of a service, as the panel renders it. Never the S3 key. */
export interface ServiceMediaView {
  id: string
  serviceId: string
  type: ServiceMediaType
  filename: string | null
  mimetype: string
  sizeBytes: number
  displayOrder: number
  /** Presigned and short-lived. Null when this one object could not be signed. */
  url: string | null
}

export type PaymentProofStatus = 'pending' | 'approved' | 'rejected' | 'superseded'

/** One deposit capture and what the owner decided about it. */
export interface PaymentProof {
  id: string
  service: string
  scheduledAt: string
  depositAmount: string | null
  customerName: string
  status: PaymentProofStatus
  createdAt: string
  resolvedAt: string | null
  rejectionReason: string | null
  /**
   * Presigned, expires in an hour. Null for a capture that predates the archive,
   * or one whose upload failed — the decision is still worth showing.
   */
  proofUrl: string | null
}

export type DepositMethod = 'yape' | 'plin' | 'transferencia' | 'efectivo'

export interface DepositPaymentMethod {
  method: DepositMethod
  number?: string
  label?: string
}

export type AssistantGender = 'femenino' | 'masculino' | 'neutro'
export type AssistantTone = 'formal' | 'amigable' | 'profesional_cercano'
/** Vende / Agenda / Ambas. Derived server-side from flowType + appointmentMode. */
export type AssistantFunction = 'agenda' | 'vende' | 'ambas'
export type OutOfHoursBehavior = 'keep_talking' | 'greet_and_capture'

export interface AssistantSettings {
  name: string
  gender: AssistantGender
  tone: AssistantTone
  businessDescription?: string
  contactInfo?: string
  customInstructions?: string
}

/**
 * The owner's message templates. Every one optional, and absent means "use the
 * wording built into Emma" — which is why clearing a textarea is a real action
 * and not the same as writing an empty message.
 */
export interface ConfigurableMessages {
  greeting?: string
  farewell?: string
  handoff?: string
  outOfHours?: string
  fallback?: string
  paymentReceived?: string
  /** Stored but not consumed yet — the confirmation carries the real slot. */
  paymentApproved?: string
  paymentRejected?: string
  /** Stored but not consumed yet: reminderTexts.ts is still the source. */
  reminder24h?: string
  reminder2h?: string
}

export interface BusinessSettingsView {
  niche: Niche
  appointmentMode: AppointmentMode
  assistant: AssistantSettings
  messages: ConfigurableMessages
  collectDataFields: string[]
  outOfHoursEnabled: boolean
  outOfHoursBehavior: OutOfHoursBehavior
  escalationAttempts: number
  cancellationKeyword: string
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
  /**
   * Whether the deploy has S3 credentials. False disables the photo upload with
   * an explanation instead of letting the owner pick a file and hit a 500.
   */
  mediaConfigured: boolean
  /**
   * Sent by the server rather than derived here, so the mapping between one
   * control and the two fields behind it lives in one place. Null when the
   * business has no valid settings yet.
   */
  assistantFunction: AssistantFunction | null
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

/** Both fields are replaced whole — see the schemas in settings.merge.ts. */
export interface IdentityPatch {
  assistant?: AssistantSettings
  assistantFunction?: AssistantFunction
}

export interface MessagesPatch {
  messages?: ConfigurableMessages
}

export interface FlowPatch {
  collectDataFields?: string[]
  outOfHoursEnabled?: boolean
  outOfHoursBehavior?: OutOfHoursBehavior
  escalationAttempts?: number
  cancellationKeyword?: string
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

// ── Conversación ─────────────────────────────────────────────────────────────
//
// Mirrors what GET /settings/conversation/catalog serves. Hand-written like the
// rest of this file: the two builds use different tsconfigs, so importing the
// server's types would drag the server into the browser bundle.

/** One brick, as the panel is allowed to see it. */
export interface ConversationNodeOption {
  id: string
  label: string
  hint: string
  /** Fixed. Shown so the owner knows what the step is for, never editable. */
  objective: string
  /** Fixed. This is the motor — the owner reads it, the code owns it. */
  steps: string[]
  defaultEdgeCases: string[]
  defaultExample: string
  /** Cannot be removed or reordered. */
  mandatory: boolean
  /** False when this business lacks the configuration the node needs. */
  available: boolean
  requires: string[]
  /**
   * The fixed exits this step declares, keyed by trigger, exactly as the
   * blueprint holds them.
   *
   * `'next'` is POSITIONAL — it means "whatever step the owner put after this
   * one" — so it can only be resolved against a composition. `{ node }` is a
   * fixed jump, kept only when that step is in the flow. Both rules live in
   * `lib/flowGraph.ts`, mirroring the server's `resolveExit`.
   *
   * Read-only. The owner authors routes (`ConversationBranch`), never these.
   */
  exits: Record<string, ConversationExitTarget>
}

/** Where a fixed exit leads. Mirrors `ExitTarget` in nodeCatalog.ts. */
export type ConversationExitTarget = 'next' | { node: string }

/**
 * A route the owner drew out of a step.
 *
 * The only edge anybody outside the compiler authors. `when` is read by Emma to
 * decide whether the route applies; `id` is what she answers with and the owner
 * never sees it.
 */
export interface ConversationBranch {
  id: string
  when: string
  to: string
}

/** What the owner overrode for one node. Absent keys mean "use the default". */
export interface ConversationNodeOverride {
  /** Renames the step in this panel. The id is what the flow actually runs on. */
  label?: string
  edgeCases?: string[]
  example?: string
  /**
   * The owner's note for this step. Added after the steps, never replacing
   * them — the steps are the motor and stay with the code.
   */
  extraInstructions?: string
  /** At most four: past a handful Emma stops choosing and starts guessing. */
  branches?: ConversationBranch[]
}

export interface ConversationFlow {
  nodes: string[]
  overrides: Record<string, ConversationNodeOverride>
}

export interface ConversationCatalog {
  nodes: ConversationNodeOption[]
  /** The flow running right now: a repo file, the owner's composition, or the derived preset. */
  current: ConversationFlow
  /** True when Vamvu manages this flow from a repo file: shown, never editable here. */
  managedByFile: boolean
}
