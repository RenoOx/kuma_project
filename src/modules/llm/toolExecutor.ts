import { z } from 'zod'
import { logger } from '@/config/logger.js'
import * as appointmentService from '@/modules/appointment/appointment.service.js'
import * as businessService from '@/modules/business/business.service.js'
import {
  activeServices,
  type DepositPaymentMethod,
  findKnownService,
  findServicesByCategory,
  formatPaymentMethods,
  formatServicePrice,
  type Service,
  serviceCategories,
} from '@/modules/business/business.settings.js'
import { ROUTE_TRIGGER } from '@/modules/conversation/nodeCatalog.js'
import type { TransitionEvidence } from '@/modules/conversation/stateMachine.js'
import * as customerService from '@/modules/customer/customer.service.js'
import * as serviceMediaService from '@/modules/media/serviceMedia.service.js'
import { expectImage, expectImageKeepingPayment } from '@/modules/whatsapp/imageExpectation.js'
import { canSendServiceMedia } from '@/modules/whatsapp/sentServiceImages.js'
import { formatDateTimeForDisplay } from '@/shared/datetime.js'
import { NotConfiguredError, ValidationError } from '@/shared/errors.js'

export interface ToolContext {
  businessId: string
  conversationId: string
  customerId: string
  /**
   * The routes the CURRENT step declares.
   *
   * Passed in rather than re-resolved here: llm.service compiles the flow once
   * per turn, and a second resolution could disagree with the first if the
   * owner saved mid-turn. It is also the only thing that makes advance_flow
   * safe — without it the executor would have to take the model's word for
   * which routes exist.
   */
  branches?: ReadonlyArray<{ id: string; when: string; to: string }>
}

export interface ToolAttachment {
  // Resolved from the business's own stored media, never from anything the
  // model wrote: the model names a service, this layer turns that into a key.
  s3Key: string
  caption: string
  // Carried so the handler can record the send once it actually succeeded.
  serviceId: string
  /** Decides which Baileys method sends it. Sniffed at upload, never claimed. */
  type: 'image' | 'pdf' | 'audio' | 'video'
  mimetype: string
  /** What the customer sees the file called. The owner's name, not the storage id. */
  filename: string
}

export interface ToolExecutionResult {
  /**
   * Raises this turn's attachment ceiling, for a tool whose attachments are
   * cards rather than extras.
   *
   * Declared by the tool that produced them instead of inferred from its name
   * in llm.service: the reason the catalogue may send four is a property of what
   * it sends — one captioned image per service, one message each — and that is
   * knowledge this layer has and the loop does not.
   */
  maxAttachments?: number
  // Always a string: OpenAI requires tool messages to have string content.
  // For successful calls this is JSON-stringified data; for failures it's a
  // small JSON object with an error code + instruction the LLM can read.
  result: string
  // Set when the tool returned a Result.err or threw. Used for logs / metrics
  // but NOT what we send back to the LLM (that goes in `result`).
  error?: string
  // What just happened, in the state machine's vocabulary. This layer only
  // NAMES it: it never reads or writes conversation.state. llm.service applies
  // it, and conversation.service is the only thing that writes.
  //
  // Keyed on the OUTCOME, not on success — the deposit gate's refusal below is
  // an error result and still the most important transition in the booking flow.
  // Absent means nothing moved.
  trigger?: string
  // Proof for the entry guard of whatever state `trigger` leads to. Set only
  // where the proof is actually produced — the deposit gate, which freezes the
  // booking intent itself. Everywhere else its absence is the correct answer:
  // a trigger that cannot show the precondition does not get to walk the
  // conversation into a state that depends on it.
  evidence?: TransitionEvidence
  // Media this turn should carry, sent by the handler after the text reply.
  // Deliberately NOT part of `result`: the model decides that a photo helps, and
  // never sees the key or the URL behind it.
  attachments?: ToolAttachment[]
}

// Both optional: no argument means the whole catalogue, which is what the old
// `topic` string amounted to anyway.
const showServicesArgs = z.object({
  category: z.string().min(1).max(40).optional(),
  services: z.array(z.string().min(1)).max(12).optional(),
})

const saveCustomerDataArgs = z.object({
  fields: z.record(z.string(), z.string()),
})

const confirmSummaryArgs = z.object({
  confirmed: z.boolean(),
})

// The id is echoed back from the prompt, so it is bounded but not enumerated:
// which ids are valid depends on the step, and only context.branches knows.
const advanceFlowArgs = z.object({ branch: z.string().min(1).max(64) })

const correctFieldArgs = z.object({
  field: z.string().min(1),
  value: z.string().min(1),
})

const checkAvailabilityArgs = z.object({
  date_iso: z.string(),
  service: z.string(),
})

const bookAppointmentArgs = z.object({
  datetime_iso: z.string(),
  service: z.string(),
  customer_name: z.string(),
})

const confirmPendingArgs = z.object({
  customer_name: z.string().optional(),
})

const sendServiceMediaArgs = z.object({
  service: z.string(),
})

const requestImageArgs = z.object({
  purpose: z.enum(['payment', 'reference']),
})

const escalateArgs = z.object({
  reason: z.string(),
})

function malformedArgs(toolName: string, parseError: z.ZodError): ToolExecutionResult {
  const summary = parseError.issues
    .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
    .join('; ')
  return {
    result: JSON.stringify({
      error: 'invalid_args',
      instruction:
        'Los argumentos enviados a la herramienta no son válidos. Revisá el formato y volvé a llamarla.',
      details: summary,
    }),
    error: `invalid_args:${toolName}`,
  }
}

const NOT_CONFIGURED_CHECK_INSTRUCTION =
  'Este negocio aún no configuró sus horarios. Decile al cliente con honestidad que no tenés esa información todavía y ofrecele ayudarlo con otra cosa. NO escales, solo informá.'

const NOT_CONFIGURED_BOOK_INSTRUCTION =
  'No se puede agendar: el negocio aún no terminó la configuración. Llamá escalate_to_human porque es una acción que no podés completar.'

const PENDING_APPROVAL_INSTRUCTION =
  'La solicitud quedó registrada y ya se le envió al encargado. NO le digas al cliente que su cita está agendada, confirmada ni reservada: decile que su SOLICITUD fue enviada y que le van a confirmar en breve.'

// ── confirm_pending_appointment ──────────────────────────────────────────────
//
// Every branch below has the same job: keep Emma from announcing a confirmation
// that did not happen. She already says "listo, ya le avisé" on her own — that
// habit is exactly the bug this tool exists to fix.

const CONFIRMED_INSTRUCTION =
  'La cita quedó agendada. Confirmásela al cliente con calidez y con la fecha y hora de scheduled_at TAL CUAL (ya viene en la zona horaria del negocio y en 12h): "¡Listo! Tu cita quedó agendada para el {scheduled_at}. Te esperamos 😊". NO menciones al doctor, al encargado ni que avisaste a nadie: para el cliente esta conversación la resolvés vos.'

const NO_PENDING_INSTRUCTION =
  'Este cliente no tiene ninguna cita pendiente por confirmar, así que su mensaje se refería a otra cosa. Seguí la conversación con naturalidad. NO le digas que confirmaste, agendaste ni notificaste nada, y no vuelvas a llamar esta herramienta.'

const AWAITING_APPROVAL_INSTRUCTION =
  'La solicitud de este cliente sigue esperando respuesta del encargado: vos no podés darla por confirmada. Decile que su solicitud ya está enviada y que le confirman en breve. NO digas que quedó agendada y no vuelvas a llamar esta herramienta.'

const STALE_PENDING_INSTRUCTION =
  'Esa cita ya no está pendiente (la cancelaron o la gestionaron mientras tanto). Decile al cliente que hubo un cambio con ese horario y que le van a escribir para coordinar. NO afirmes que quedó agendada. Después llamá escalate_to_human con razón "el cliente aceptó un horario que ya no está disponible".'

const MISSING_NAME_INSTRUCTION =
  'Todavía no tenés el nombre del paciente. Preguntáselo antes de agendar: "¿A nombre de quién agendo la cita?". NO inventes un nombre, NO uses el nombre de WhatsApp, y no vuelvas a llamar esta herramienta hasta que el cliente te lo diga.'

// The tool schema marks customer_name required, which stops the model from
// omitting the field — but not from filling it with the WhatsApp push name or
// a placeholder just to satisfy it. A real name carries at least two letters,
// which "💕", "-", "." and "?" do not.
function isUsableName(raw: string): boolean {
  return (raw.match(/\p{L}/gu) ?? []).length >= 2
}

// What the model reads when the deposit gate refuses. It carries the amount and
// the payment details inline so the model can relay them without going back to
// the knowledge base, which is no longer the source for this.
function depositRequiredInstruction(
  amount: string | undefined,
  methods: DepositPaymentMethod[],
): string {
  const monto = amount?.trim() ? `de ${amount.trim()}` : 'previo'
  return [
    `Este negocio pide un adelanto ${monto} para confirmar la cita, y todavía no llegó ninguna captura de pago.`,
    `NO agendaste nada. Decile al cliente cuánto es el adelanto y cómo pagarlo: ${formatPaymentMethods(methods)}.`,
    'Después pedile la captura directamente, sin preguntarle si quiere mandarla.',
    'Este rechazo es lo esperado, no es un error: dejó registrado el horario, el servicio y el nombre, esperando la captura.',
    'Cuando la captura llegue, la cita NO se crea sola: el encargado revisa el pago y recién su visto bueno la agenda. Vos no tenés que hacer nada más en ese paso.',
    'No vuelvas a llamar book_appointment por tu cuenta. Única excepción: si el cliente cambia de horario o de servicio, llamala de nuevo con los datos nuevos — te la voy a rechazar igual, y así lo que queda registrado es lo último que el cliente eligió.',
    'NO le digas que su cita ya quedó agendada ni que la solicitud fue enviada: todavía no lo está.',
  ].join(' ')
}

// The tool now hands back the services themselves, so the instruction stops
// being "write whatever you remember" and becomes "write about THIS list". That
// is the whole point of the change: a rule asking the model to show part of a
// catalogue it can see in full is a suggestion, and it was being ignored.
const SHOW_SERVICES_INSTRUCTION =
  'Escribí UNA intro corta (una o dos líneas) y nada más. Los servicios de details.services son los únicos que podés nombrar en este turno — no agregues otros aunque los tengas en el catálogo. Los que traen ficha se están enviando solos con su foto, precio y detalle: NO los repitas en tu texto. De los que no traen ficha, poné una línea cada uno con nombre y precio. Cerrá invitando a elegir uno.'

const NO_SERVICES_IN_CATEGORY_INSTRUCTION =
  'Esa categoría existe pero no tiene servicios activos ahora. Decíselo con naturalidad y ofrecé las otras categorías que sí tienen.'

const UNKNOWN_SERVICE_INSTRUCTION =
  'Ese servicio no coincide con ninguno configurado (los tienes en details.availableServices). NO digas que no existe ni inventes precio/duración. Si alguno de los disponibles se parece conceptualmente a lo que pidió el cliente, preguntale si se refiere a ese usando su nombre exacto. Si ninguno se parece, hacé una pregunta abierta para entender qué busca. No vuelvas a llamar esta herramienta hasta que el cliente confirme el nombre exacto del servicio.'

// ── Service cards ────────────────────────────────────────────────────────────

/** Cards one turn may carry. See the comment on buildServiceCards. */
export const MAX_SERVICE_CARDS_PER_TURN = 4

/** Keeps a caption inside what WhatsApp shows without a "read more" fold. */
const MAX_CAPTION_CHARS = 400

/**
 * One card per service: its first file, captioned with its own details.
 *
 * A WhatsApp image carries a caption, so a card is ONE outbound message and not
 * two — which is the only reason "a block per course" is affordable at all. The
 * model writes a short intro and these carry the detail, instead of one wall of
 * text the customer scrolls past.
 *
 * **Capped at four, and the cap is about the queue, not about bans.** sendQueue
 * already enforces 25/minute and 200/hour per business with a 1–2.5s gap, and
 * that is what keeps the number safe. What a per-turn ceiling protects is
 * LATENCY: the lane is shared, so four cards are roughly eight seconds during
 * which another customer's reply waits. Beyond four the listing also stops
 * fitting on a phone screen, which is the same answer from the other direction.
 *
 * One file per service, never all of them: this is a catalogue, and a service
 * with a photo AND a price sheet would otherwise spend the whole turn by itself.
 * The rest stay reachable through send_service_media when the customer picks one.
 */
async function buildServiceCards(
  context: ToolContext,
  services: Service[],
): Promise<ToolAttachment[]> {
  const cards: ToolAttachment[] = []

  for (const service of services) {
    if (cards.length >= MAX_SERVICE_CARDS_PER_TURN) break
    // No id means no files and nothing to record the send against.
    if (!service.id) continue
    // The same repeat window a direct send goes through: a customer who asks
    // twice in five minutes gets the text, not the photos again.
    if (!canSendServiceMedia(context.conversationId, service.id)) continue

    const media = await serviceMediaService.listForOwner(context.businessId, 'service', service.id)
    const first = media[0]
    if (!first) continue
    // Audio carries no caption in WhatsApp, so a card made of one would arrive
    // with its price and detail nowhere. It stays available through
    // send_service_media, where the model writes the detail itself.
    if (first.type === 'audio') continue

    cards.push({
      s3Key: first.s3Key,
      caption: buildCardCaption(service),
      serviceId: service.id,
      type: first.type as ToolAttachment['type'],
      mimetype: first.mimetype,
      filename: first.filename ?? `${service.name}.${first.type}`,
    })
  }

  return cards
}

/**
 * What the customer reads under the photo.
 *
 * Name, price, then the description — in that order, because the first two are
 * what someone comparing courses scans for. Truncated at a word boundary rather
 * than mid-word: WhatsApp folds a long caption behind "read more" anyway, and a
 * sentence cut at a letter reads like a bug.
 */
function buildCardCaption(service: Service): string {
  const head = `*${service.name}* — ${formatServicePrice(service)}`
  const body = service.description?.trim()
  if (!body) return head

  const room = MAX_CAPTION_CHARS - head.length - 2
  const trimmed =
    body.length <= room ? body : `${body.slice(0, body.lastIndexOf(' ', room) + 1 || room).trim()}…`
  return `${head}\n${trimmed}`
}

// ── send_service_media ───────────────────────────────────────────────────────
//
// All three keep Emma from narrating the transport. The file leaves as its own
// WhatsApp message right after her text, so "te adjunto la foto" describes
// something the customer cannot see happening and reads as a bug when it lands
// a second later on its own.

const NO_SERVICE_MEDIA_INSTRUCTION =
  'Ese servicio no tiene material cargado, así que NO se envió nada. Describíselo con palabras y seguí la conversación con naturalidad. NO le digas que le mandaste un archivo ni que se lo vas a mandar, y no vuelvas a llamar esta herramienta para ese servicio.'

// Categorical, and it has to be: the old version banned three phrases in the
// first person ("te adjunto", "te lo mando", "mirá el archivo") and the model
// walked around the list — it wrote "Recibiste el material con más detalles
// sobre el curso", glued to the description. A ban written as examples is a ban
// on those examples.
// A TEST the model can run on its own draft, not a list it can walk around.
//
// The previous two versions were both bans by enumeration, and the model found a
// phrasing outside each list: first "Recibiste el material con más detalles"
// (second person, past), then "He enviado más información sobre el curso" (first
// person, present perfect). Every list of forbidden phrases is a permit for the
// next one. The rule is now a property the reply either has or does not — "does
// it still read if no file exists?" — with the examples kept only as
// illustration of a rule that no longer depends on them.
const SERVICE_MEDIA_SENT_INSTRUCTION =
  'El material sale solo, como mensajes aparte de WhatsApp. REGLA: tu respuesta tiene que poder leerse completa como si ningún archivo existiera. Antes de enviarla, releéla tapando el archivo: si alguna frase queda coja, sobra o promete algo que no está en el texto, reescribila. Eso descarta cualquier mención al archivo, en cualquier persona y cualquier tiempo verbal — mandar, haber mandado, enviar, adjuntar, compartir, que le llegue, que lo mire, que ahí tiene más detalles. El cliente lo ve llegar solo; contárselo suena a error. ❌ "He enviado más información" ❌ "Recibiste el material" ❌ "Te adjunto la info". ✅ escribí sobre el servicio y nada más.'

// Says it out loud, and that is the change: the old version suggested referring
// to the file ("referite a lo que ya tiene más arriba"), the model skipped it,
// and the customer got a reply indistinguishable from "this service has no
// photo". Two different silences, and only this one is a problem — a customer
// who cannot see the file needs to know it was sent, not to guess.
const MEDIA_ALREADY_SENT_INSTRUCTION =
  'Ya le mandaste el material de ese servicio hace un momento, así que no se volvió a enviar. DECÍSELO en tu respuesta: que se lo enviaste recién y preguntale si le llegó, para que no quede pensando que no existe. Después seguí con lo que te preguntó.'

// ── Presentación de la disponibilidad ────────────────────────────────────────
//
// Availability reaches the model as contiguous BLOCKS, not as a flat list of
// times. Two concrete options used to cross this boundary ("¿te va 8:00am o
// 8:30am?"), which reads as an ultimatum on a day that is actually wide open.
// Blocks let Emma answer the way a receptionist would — "tengo libre de 8:00am
// a 12:30pm" — and only drill into exact times once the patient narrows down.
//
// This stays a presentation concern and lives HERE, not in appointment.service:
// the domain result remains the plain truthful list of bookable instants.

interface AvailabilityBlock {
  /** Ready-to-speak label, e.g. "Disponible de 8:00am a 12:30pm". */
  range: string
  /** Every bookable instant inside this block, ISO with the business offset. */
  slots: string[]
}

// Order matters more than wording here. This is the LAST thing the model reads
// before composing, and it used to open with the unconditional "show the ranges
// and ask which one suits you" — so a patient who had already said "a las 10"
// got the whole day dumped back at them with a question attached. The condition
// now comes first: decide which case you are in, THEN follow that branch.
const AVAILABILITY_INSTRUCTION =
  'PRIMERO decidí en qué caso estás. ' +
  'CASO A — el cliente ya pidió una hora puntual ("¿tienes a las 4?", "mañana a las 10"): NO listes nada ni muestres rangos. Fijate si esa hora está en `slots`, decile sí o no, y si está, confirmá y avanzá al nombre. ' +
  'CASO B — el cliente ya eligió un tramo o dio una preferencia ("en la mañana", "después de las 3"): listá los horarios exactos de ESE tramo. ' +
  'CASO C — el cliente solo preguntó por el día, sin hora ni preferencia: recién ahí respondé con los `range` de cada tramo en lenguaje natural ("Tengo disponible de 8:00am a 12:30pm y de 2:00pm a 5:00pm") y preguntá cuál le acomoda. ' +
  'Los rangos son SOLO para el caso C. En A y B mostrarlos es devolverle al cliente una pregunta que ya respondió.'

// ── Horarios de hoy que ya pasaron ───────────────────────────────────────────
//
// The lead-time gate in checkAvailability is correct and timezone-independent:
// it compares absolute instants, so an 8:00am slot is gone by 10:36am no matter
// what zone the server runs in. What was missing is that it removed those slots
// SILENTLY.
//
// Handed a morning that simply isn't there, with the business's opening hours
// ("08:00 a 17:00") sitting in its system prompt, the model reconstructed the
// missing times and offered 8:00am at 10:36am. These notes travel WITH the
// data, the last thing read before composing the reply, and say out loud why
// the morning is gone.

function leadTimeNote(minNoticeMinutes: number): string {
  return (
    `Para hoy ya pasaron horarios: se requieren ${minNoticeMinutes} minutos de anticipación y availableBlocks YA excluye todo lo que quedó fuera. ` +
    'Ofrecé ÚNICAMENTE horarios que estén en availableBlocks. NO ofrezcas la hora de apertura del negocio ni ningún horario más temprano como si estuviera libre: ya no se puede reservar.'
  )
}

function dayOverInstruction(minNoticeMinutes: number): string {
  return (
    `Para hoy ya no queda ningún horario reservable: los que había ya pasaron o están dentro de los ${minNoticeMinutes} minutos de anticipación que necesita el negocio. Esto NO es que esté cerrado ni lleno.` +
    ' Decile al cliente que para hoy ya no hay cupo y ofrecele el día siguiente. Si acepta, llamá check_availability con esa fecha.' +
    ' NUNCA le ofrezcas un horario de hoy, ni siquiera el de apertura.'
  )
}

// checkAvailability builds each slot with the business's UTC offset already
// baked in, so the wall-clock time is a plain substring — no timezone math.
function wallClock(iso: string): string {
  return iso.slice(11, 16)
}

function addMinutes(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(':').map(Number)
  if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) return hhmm
  const total = h * 60 + m + minutes
  const hh = Math.floor(total / 60) % 24
  const mm = total % 60
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

// 12-hour form because that is how the prompt tells Emma to speak. Converting
// here rather than in the prompt keeps the model from doing clock arithmetic,
// which it gets wrong around noon and midnight.
function to12h(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) return hhmm
  const period = h < 12 ? 'am' : 'pm'
  const hour12 = h % 12 === 0 ? 12 : h % 12
  return `${hour12}:${String(m).padStart(2, '0')}${period}`
}

function makeBlock(slots: string[], slotDurationMinutes: number): AvailabilityBlock {
  const first = slots[0]
  const last = slots[slots.length - 1]
  // Unreachable: blocks are only built from a non-empty run.
  if (first === undefined || last === undefined) {
    return { range: 'Disponible', slots }
  }
  const from = to12h(wallClock(first))
  const to = to12h(addMinutes(wallClock(last), slotDurationMinutes))
  // A run of one slot is a point in time, not a window — saying "de 5:00pm a
  // 5:30pm" for a single opening invites the patient to ask for 5:15.
  const range = slots.length === 1 ? `Disponible a las ${from}` : `Disponible de ${from} a ${to}`
  return { range, slots }
}

/**
 * Folds a sorted list of bookable instants into contiguous blocks.
 *
 * Two slots are contiguous when exactly one grid step separates them. Anything
 * wider means something sits in between (a booking, the lunch break, closing
 * time) and starts a new block — which is why the caller has to pass the real
 * grid instead of inferring it from the gaps.
 */
export function groupIntoBlocks(slots: string[], slotDurationMinutes: number): AvailabilityBlock[] {
  if (slots.length === 0) return []

  const stepMs = slotDurationMinutes * 60_000
  const blocks: AvailabilityBlock[] = []
  let run: string[] = []

  for (const slot of slots) {
    const previous = run[run.length - 1]
    const breaksRun =
      previous !== undefined && new Date(slot).getTime() - new Date(previous).getTime() !== stepMs
    if (breaksRun) {
      blocks.push(makeBlock(run, slotDurationMinutes))
      run = []
    }
    run.push(slot)
  }
  if (run.length > 0) blocks.push(makeBlock(run, slotDurationMinutes))

  return blocks
}

export async function executeTool(
  name: string,
  args: unknown,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  try {
    if (name === 'check_availability') {
      const parsed = checkAvailabilityArgs.safeParse(args)
      if (!parsed.success) return malformedArgs(name, parsed.error)

      const r = await appointmentService.checkAvailability(
        context.businessId,
        parsed.data.date_iso,
        parsed.data.service,
      )
      if (!r.ok) {
        if (r.error instanceof NotConfiguredError) {
          return {
            result: JSON.stringify({
              error: 'not_configured',
              instruction: NOT_CONFIGURED_CHECK_INSTRUCTION,
            }),
            error: 'not_configured',
          }
        }
        if (r.error instanceof ValidationError) {
          return {
            result: JSON.stringify({
              error: 'unknown_service',
              instruction: UNKNOWN_SERVICE_INSTRUCTION,
              details: r.error.logContext,
            }),
            error: 'unknown_service',
          }
        }
        return {
          result: JSON.stringify({ error: r.error.code, userMessage: r.error.userMessage }),
          error: r.error.code,
        }
      }

      // Built explicitly rather than spread: the flat `availableSlots` list is
      // deliberately NOT forwarded, since every one of its entries already
      // appears inside a block and sending both doubles the token cost of an
      // open day for no gain.
      const blocks = groupIntoBlocks(r.data.availableSlots, r.data.slotDurationMinutes)
      const droppedByLeadTime = r.data.slotsDroppedByLeadTime > 0

      // Nothing left AND the reason is the clock: a different situation from a
      // closed day or a booked-out one, and the only one where the answer is
      // "hoy ya no, ¿te ofrezco mañana?".
      const dayIsOver = blocks.length === 0 && droppedByLeadTime

      return {
        result: JSON.stringify({
          ...(r.data.closedReason ? { closedReason: r.data.closedReason } : {}),
          availableBlocks: blocks,
          // Carried WITH the data on purpose. The two-step rule also lives in the
          // system prompt, but that sits thousands of tokens earlier while this
          // is the last thing read before composing the reply — and handed a bare
          // array of times, the model just lists them.
          instruction: dayIsOver
            ? dayOverInstruction(r.data.minNoticeMinutes)
            : droppedByLeadTime
              ? `${leadTimeNote(r.data.minNoticeMinutes)} ${AVAILABILITY_INSTRUCTION}`
              : AVAILABILITY_INSTRUCTION,
        }),
        // A closed or fully booked day still counts: the customer asked.
        trigger: 'asks_availability',
      }
    }

    if (name === 'book_appointment') {
      const parsed = bookAppointmentArgs.safeParse(args)
      if (!parsed.success) return malformedArgs(name, parsed.error)

      // Checked before anything is persisted: a booking filed under "." is
      // worse than no booking, because the owner reads that card and has no
      // idea who is coming.
      if (!isUsableName(parsed.data.customer_name)) {
        return {
          result: JSON.stringify({
            error: 'missing_customer_name',
            instruction: MISSING_NAME_INSTRUCTION,
          }),
          error: 'missing_customer_name',
        }
      }

      // The deposit gate. Enforced HERE and not in the prompt because the
      // prompt version did not hold: Emma asked for the capture and filed the
      // booking anyway, and the owner confirmed an appointment nobody paid for.
      //
      // A settings read failure leaves the gate OPEN on purpose: refusing every
      // booking because the settings lookup blipped is the worse failure.
      const settingsForDeposit = await businessService.getSettings(context.businessId)
      if (settingsForDeposit.ok && settingsForDeposit.data.requiresDeposit) {
        // Refused unconditionally, with no evidence check any more.
        //
        // The gate used to open as soon as a photo had been recorded in the
        // last 30 minutes. That was the best proxy available while the capture
        // itself filed the booking — but it is a proxy for "something arrived",
        // never for "the money is there", and Emma cannot tell the two apart
        // because she cannot see the image.
        //
        // Now a person can: the capture opens a payment_verification and the
        // owner rules on it, and THEIR approval is what books. So the one
        // customer-side path into a deposit booking is closed. Leaving it ajar
        // for "recent evidence" would hand back exactly the hole this whole
        // flow exists to close — the photo lands, the evidence check passes,
        // and the model books before anyone has looked at the money.
        const { depositAmount, depositPaymentMethods } = settingsForDeposit.data
        // Armed HERE rather than left to the model calling request_image: the
        // instruction below asks it to, but relying on that is the same bet
        // this gate exists to stop making. The booking the customer is paying
        // for rides along, because it does not exist in the database yet.
        expectImage(context.conversationId, 'payment', {
          service: parsed.data.service,
          scheduledAtISO: parsed.data.datetime_iso,
          amount: depositAmount?.trim() || null,
          customerName: parsed.data.customer_name,
        })
        return {
          result: JSON.stringify({
            error: 'deposit_required',
            deposit_amount: depositAmount ?? null,
            payment_methods: formatPaymentMethods(depositPaymentMethods),
            instruction: depositRequiredInstruction(depositAmount, depositPaymentMethods),
          }),
          error: 'deposit_required',
          trigger: 'deposit_required',
          // The proof for await_payment's entry guard, and this is the only
          // place in the codebase that can give it: the expectImage call above
          // just froze the service, the slot and the name this capture will pay
          // for, after isUsableName cleared the name.
          evidence: { bookingIntent: true },
        }
      }

      const r = await appointmentService.bookAppointment({
        businessId: context.businessId,
        customerId: context.customerId,
        service: parsed.data.service,
        datetimeISO: parsed.data.datetime_iso,
        customerName: parsed.data.customer_name,
      })
      if (!r.ok) {
        if (r.error instanceof NotConfiguredError) {
          return {
            result: JSON.stringify({
              error: 'not_configured',
              instruction: NOT_CONFIGURED_BOOK_INSTRUCTION,
            }),
            error: 'not_configured',
          }
        }
        // Slot-too-soon is a ValidationError SUBcode; match by code BEFORE
        // the generic ValidationError branch so the model gets the specific
        // instruction (with the configured lead-time minutes inlined).
        if (r.error instanceof ValidationError && r.error.code === 'slot_too_soon') {
          const minNoticeMinutes =
            (r.error.logContext as { minNoticeMinutes?: number }).minNoticeMinutes ?? 30
          return {
            result: JSON.stringify({
              error: 'slot_too_soon',
              instruction: `Ese horario ya pasó o está muy próximo. Decile al cliente que necesitamos al menos ${minNoticeMinutes} minutos de anticipación y ofrecele horarios futuros. Si necesita ver opciones, llamá check_availability.`,
              userMessage: r.error.userMessage,
              details: r.error.logContext,
            }),
            error: 'slot_too_soon',
          }
        }
        if (r.error instanceof ValidationError) {
          return {
            result: JSON.stringify({
              error: 'validation',
              instruction: UNKNOWN_SERVICE_INSTRUCTION,
              userMessage: r.error.userMessage,
              details: r.error.logContext,
            }),
            error: 'validation',
          }
        }
        return {
          result: JSON.stringify({ error: r.error.code, userMessage: r.error.userMessage }),
          error: r.error.code,
        }
      }
      // A business on bookingMode 'requires_approval' gets a `pending` row and
      // an owner push instead of a confirmed booking (both handled inside the
      // service). All this layer does is stop the model from announcing a
      // confirmation that nobody has given yet.
      const pendingApproval = r.data.status === 'pending'

      // Rendered here rather than shipped as a UTC ISO: handed the raw instant,
      // the model announced the booking in UTC or in 24h ("tu cita quedó a las
      // 20:00"). The business lookup is one extra read on a path that already
      // does several, and it is the only way to be right for a non-Lima tenant.
      const businessResult = await businessService.getById(context.businessId)
      const timezone = businessResult.ok ? businessResult.data.timezone : 'America/Lima'

      return {
        result: JSON.stringify({
          appointment_id: r.data.id,
          scheduled_at: formatDateTimeForDisplay(r.data.scheduledAt, timezone),
          service: r.data.service,
          status: r.data.status,
          duration_minutes: r.data.durationMinutes,
          ...(pendingApproval
            ? { instruction: PENDING_APPROVAL_INSTRUCTION }
            : {
                instruction:
                  'La hora en scheduled_at ya está en la zona horaria del negocio y en formato 12h. Confirmásela al cliente tal cual, sin convertirla ni pasarla a 24h.',
              }),
        }),
        // Fires for a 'pending' row too: from the flow's point of view the
        // booking step is done either way, and what is left is the owner's call.
        trigger: 'appointment_booked',
      }
    }

    if (name === 'confirm_pending_appointment') {
      // The appointment itself is found from the conversation's own customer, so
      // the model has nothing to get wrong there. The one optional argument is
      // the name: a slot the OWNER proposed is filed before anybody asked for
      // one, and without this the booking would keep reading as the WhatsApp
      // push name for the rest of its life.
      const parsed = confirmPendingArgs.safeParse(args)
      if (!parsed.success) return malformedArgs(name, parsed.error)

      // Same bar as book_appointment: a placeholder is worse than no name,
      // because a null still falls back to whatever the customer row knows.
      const offeredName = parsed.data.customer_name
      const r = await appointmentService.confirmPendingForCustomer({
        businessId: context.businessId,
        customerId: context.customerId,
        ...(offeredName && isUsableName(offeredName) ? { customerName: offeredName } : {}),
      })
      if (!r.ok) {
        if (r.error.code === 'no_pending_appointment') {
          return {
            result: JSON.stringify({
              error: 'no_pending_appointment',
              instruction: NO_PENDING_INSTRUCTION,
            }),
            error: 'no_pending_appointment',
          }
        }
        if (r.error.code === 'awaiting_owner_approval') {
          return {
            result: JSON.stringify({
              error: 'awaiting_owner_approval',
              instruction: AWAITING_APPROVAL_INSTRUCTION,
            }),
            error: 'awaiting_owner_approval',
          }
        }
        if (r.error.code === 'invalid_status_transition') {
          return {
            result: JSON.stringify({
              error: 'invalid_status_transition',
              instruction: STALE_PENDING_INSTRUCTION,
            }),
            error: 'invalid_status_transition',
          }
        }
        return {
          result: JSON.stringify({ error: r.error.code, userMessage: r.error.userMessage }),
          error: r.error.code,
        }
      }

      return {
        result: JSON.stringify({
          status: 'confirmed',
          service: r.data.appointment.service,
          scheduled_at: r.data.scheduledAtDisplay,
          instruction: CONFIRMED_INSTRUCTION,
        }),
        trigger: 'appointment_booked',
      }
    }

    if (name === 'send_service_media') {
      const parsed = sendServiceMediaArgs.safeParse(args)
      if (!parsed.success) return malformedArgs(name, parsed.error)

      const settings = await businessService.getSettings(context.businessId)
      if (!settings.ok) {
        return {
          result: JSON.stringify({
            error: 'not_configured',
            instruction: NOT_CONFIGURED_CHECK_INSTRUCTION,
          }),
          error: 'not_configured',
        }
      }

      // Resolved through the same matcher booking uses, so a deactivated service
      // is no more showable than it is bookable.
      const service = findKnownService(settings.data, parsed.data.service)
      if (!service) {
        return {
          result: JSON.stringify({
            error: 'unknown_service',
            instruction: UNKNOWN_SERVICE_INSTRUCTION,
            details: { availableServices: activeServices(settings.data).map((s) => s.name) },
          }),
          error: 'unknown_service',
        }
      }

      // The id is as necessary as the files: without it the send cannot be
      // recorded, and an unrecorded send is one that repeats on every turn.
      if (!service.id) {
        return {
          result: JSON.stringify({ error: 'no_media', instruction: NO_SERVICE_MEDIA_INSTRUCTION }),
          error: 'no_media',
        }
      }

      if (!canSendServiceMedia(context.conversationId, service.id)) {
        return {
          result: JSON.stringify({
            status: 'already_sent',
            instruction: MEDIA_ALREADY_SENT_INSTRUCTION,
          }),
        }
      }

      const media = await serviceMediaService.listForOwner(
        context.businessId,
        'service',
        service.id,
      )
      if (media.length === 0) {
        return {
          result: JSON.stringify({ error: 'no_media', instruction: NO_SERVICE_MEDIA_INSTRUCTION }),
          error: 'no_media',
        }
      }

      // Offered whole, in the owner's display_order. The turn's ceiling lives in
      // attachmentQueue, which is the only place the whole turn is visible —
      // cutting here would bound ONE service's files and call it a turn.
      //
      // So `sent` is what this service offers, not necessarily what goes out.
      // The model is told never to narrate the transport, so the difference
      // cannot reach the customer as a promise that was not kept.
      const selected = media

      return {
        result: JSON.stringify({
          status: 'media_sent',
          service: service.name,
          sent: selected.length,
          instruction: SERVICE_MEDIA_SENT_INSTRUCTION,
        }),
        attachments: selected.map((row) => ({
          s3Key: row.s3Key,
          // The service name alone, and only where WhatsApp renders a caption.
          // Emma's own text already carries the price and the pitch, and
          // repeating them under the file reads like two people answering the
          // same question.
          caption: service.name,
          serviceId: service.id as string,
          type: row.type as ToolAttachment['type'],
          mimetype: row.mimetype,
          filename: row.filename ?? `${service.name}.${row.type}`,
        })),
      }
    }

    if (name === 'request_image') {
      const parsed = requestImageArgs.safeParse(args)
      if (!parsed.success) return malformedArgs(name, parsed.error)

      // Arms the forwarding gate. Nothing is sent here — the model still has to
      // ask for the photo in its own words on the reply that follows.
      //
      // Keeps any payment context the deposit gate already stored: this call
      // routinely lands right after that refusal, and clobbering it would drop
      // the booking the capture is meant to unblock.
      expectImageKeepingPayment(context.conversationId, parsed.data.purpose)
      return {
        result: JSON.stringify({
          status: 'expecting_image',
          instruction:
            parsed.data.purpose === 'payment'
              ? 'Listo. Ahora pedile la captura del pago con naturalidad ("¿Me mandas la captura del pago?"). NO le digas que se la vas a reenviar a nadie ni menciones al doctor o al encargado: para el cliente esta conversación la resolvés vos.'
              : 'Listo. Ahora pedile la foto de referencia con naturalidad. NO le digas que se la vas a reenviar a nadie ni menciones al doctor o al encargado.',
        }),
        // No trigger, on either purpose. Arming the expectation is not a move in
        // the flow: the deposit gate emits deposit_required itself, at the moment
        // it actually refuses a booking and freezes the payment context. The model
        // can reach for this tool on its own, and letting that walk the
        // conversation into await_payment strands it there with no booking to pay
        // for and no capture on the way.
      }
    }

    if (name === 'escalate_to_human') {
      const parsed = escalateArgs.safeParse(args)
      if (!parsed.success) return malformedArgs(name, parsed.error)

      const r = await appointmentService.escalate({
        businessId: context.businessId,
        conversationId: context.conversationId,
        reason: parsed.data.reason,
      })
      if (!r.ok) {
        return {
          result: JSON.stringify({ error: r.error.code, userMessage: r.error.userMessage }),
          error: r.error.code,
        }
      }
      return { result: JSON.stringify({ status: 'escalated', reason: parsed.data.reason }) }
    }

    // ── Signalling tools ─────────────────────────────────────────────────────
    //
    // These four do almost nothing on their own: they exist so the flow has an
    // emitter for the step it is on. Before them, six triggers were declared in
    // the state machine and produced by nobody, which is how a conversation
    // could reach a node that had no way out of it.
    //
    // They are cheap on purpose. The model is already deciding "I am listing
    // services now" in order to write the reply; naming that decision costs one
    // tool call and turns it into a transition the code owns.

    if (name === 'show_services') {
      const parsed = showServicesArgs.safeParse(args)
      if (!parsed.success) return malformedArgs(name, parsed.error)

      const settingsResult = await businessService.getSettings(context.businessId)
      if (!settingsResult.ok) {
        // Unconfigured is not an error here: the prompt already tells the model
        // how to answer a business with no catalogue, and the transition still
        // has to happen or the conversation parks.
        return {
          result: JSON.stringify({
            status: 'not_configured',
            instruction:
              'Este negocio todavía no tiene servicios cargados. Respondé con honestidad y NO inventes servicios ni precios.',
          }),
          trigger: 'services_listed',
        }
      }
      const settings = settingsResult.data

      const { category, services: named } = parsed.data

      let selected = activeServices(settings)
      if (category) {
        const found = findServicesByCategory(settings, category)
        if (found === null) {
          // Same shape as send_service_media's unknown_service: hand back the
          // real list so the model picks again in this same turn instead of
          // guessing twice or telling the customer it does not exist.
          return {
            result: JSON.stringify({
              error: 'unknown_category',
              availableCategories: serviceCategories(settings),
              instruction:
                'Esa categoría no existe en el catálogo. Elegí una de details.availableCategories y volvé a llamar la herramienta en este mismo turno. Si ninguna corresponde, llamala sin category.',
            }),
            error: 'unknown_category',
          }
        }
        selected = found
      }
      if (named && named.length > 0) {
        const matched = named
          .map((n) => findKnownService(settings, n))
          .filter((s): s is NonNullable<typeof s> => s !== null)
        // Only narrows when something matched: a mistyped name must not turn
        // into an empty catalogue.
        if (matched.length > 0) selected = matched
      }

      if (selected.length === 0) {
        return {
          result: JSON.stringify({
            status: 'empty_category',
            category,
            availableCategories: serviceCategories(settings),
            instruction: NO_SERVICES_IN_CATEGORY_INSTRUCTION,
          }),
          trigger: 'services_listed',
        }
      }

      const cards = await buildServiceCards(context, selected)
      return {
        result: JSON.stringify({
          status: 'listed',
          ...(category ? { category } : {}),
          services: selected.map((s) => ({
            nombre: s.name,
            precio: formatServicePrice(s),
            descripcion: s.description ?? null,
            ficha: cards.some((c) => c.serviceId === s.id),
          })),
          instruction: SHOW_SERVICES_INSTRUCTION,
        }),
        ...(cards.length > 0
          ? { attachments: cards, maxAttachments: MAX_SERVICE_CARDS_PER_TURN }
          : {}),
        trigger: 'services_listed',
      }
    }

    if (name === 'save_customer_data') {
      const parsed = saveCustomerDataArgs.safeParse(args)
      if (!parsed.success) return malformedArgs(name, parsed.error)

      const settingsResult = await businessService.getSettings(context.businessId)
      const required = settingsResult.ok ? settingsResult.data.collectDataFields : []
      const missing = required.filter((field) => !parsed.data.fields[field]?.trim())
      if (missing.length > 0) {
        return {
          result: JSON.stringify({
            error: 'incomplete_data',
            missing,
            instruction: `Todavía faltan estos datos: ${missing.join(', ')}. Pedí el primero que falte y no vuelvas a llamar esta herramienta hasta tenerlos todos.`,
          }),
          error: 'incomplete_data',
        }
      }

      // Persisting the name here is what closes the gap CLAUDE.md lists: until
      // now a customer who told Emma their name and did not book kept whatever
      // WhatsApp push name they happened to have.
      const saved = await customerService.saveCollectedData(
        context.businessId,
        context.customerId,
        parsed.data.fields,
      )
      if (!saved.ok) {
        return {
          result: JSON.stringify({ error: saved.error.code, userMessage: saved.error.userMessage }),
          error: saved.error.code,
        }
      }

      return {
        result: JSON.stringify({ status: 'saved', fields: Object.keys(parsed.data.fields) }),
        trigger: 'data_complete',
      }
    }

    if (name === 'confirm_summary') {
      const parsed = confirmSummaryArgs.safeParse(args)
      if (!parsed.success) return malformedArgs(name, parsed.error)

      return {
        result: JSON.stringify({
          status: parsed.data.confirmed ? 'confirmed' : 'correction_requested',
          instruction: parsed.data.confirmed
            ? 'El cliente confirmó. Cerrá con la despedida.'
            : 'El cliente quiere corregir algo. Preguntale QUÉ dato quiere cambiar, uno solo, y no le pidas todos de nuevo.',
        }),
        trigger: parsed.data.confirmed ? 'summary_confirmed' : 'correction_requested',
      }
    }

    if (name === 'advance_flow') {
      const parsed = advanceFlowArgs.safeParse(args)
      if (!parsed.success) return malformedArgs(name, parsed.error)

      const branches = context.branches ?? []
      const chosen = branches.find((branch) => branch.id === parsed.data.branch)
      if (!chosen) {
        // Named rather than generic: the model gets the list back and can pick
        // again in the same turn instead of guessing twice.
        return {
          result: JSON.stringify({
            error: 'unknown_branch',
            available: branches.map((branch) => ({ id: branch.id, cuando: branch.when })),
            instruction:
              branches.length === 0
                ? 'Este paso no tiene rutas. No vuelvas a llamar esta herramienta acá.'
                : 'Ese id de ruta no existe en este paso. Usá uno de los de la lista, o seguí conversando si ninguno aplica.',
          }),
          error: 'unknown_branch',
        }
      }

      return {
        result: JSON.stringify({
          status: 'advanced',
          instruction:
            'La conversación avanzó. Seguí con el objetivo del paso nuevo, sin anunciarle al cliente que cambiaste de paso.',
        }),
        trigger: ROUTE_TRIGGER,
        // The branch travels as evidence because every route shares one trigger:
        // the trigger says "the owner's routing fired", this says which one.
        evidence: { branch: chosen.id },
      }
    }

    if (name === 'correct_field') {
      const parsed = correctFieldArgs.safeParse(args)
      if (!parsed.success) return malformedArgs(name, parsed.error)

      const saved = await customerService.saveCollectedData(
        context.businessId,
        context.customerId,
        {
          [parsed.data.field]: parsed.data.value,
        },
      )
      if (!saved.ok) {
        return {
          result: JSON.stringify({ error: saved.error.code, userMessage: saved.error.userMessage }),
          error: saved.error.code,
        }
      }

      return {
        result: JSON.stringify({
          status: 'corrected',
          field: parsed.data.field,
          instruction:
            'Dato corregido. Volvé a mostrarle el resumen completo con el cambio aplicado y preguntale si ahora está bien.',
        }),
        trigger: 'field_corrected',
      }
    }

    return {
      result: JSON.stringify({ error: `Unknown tool: ${name}` }),
      error: 'unknown_tool',
    }
  } catch (cause) {
    logger.error({ tool: name, args, err: cause }, 'tool executor threw unexpectedly')
    return {
      result: JSON.stringify({ error: 'La herramienta falló en este momento.' }),
      error: cause instanceof Error ? cause.message : 'unknown',
    }
  }
}
