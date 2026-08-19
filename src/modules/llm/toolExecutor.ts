import { z } from 'zod'
import { logger } from '@/config/logger.js'
import * as appointmentService from '@/modules/appointment/appointment.service.js'
import * as businessService from '@/modules/business/business.service.js'
import { expectImage } from '@/modules/whatsapp/imageExpectation.js'
import { formatDateTimeForDisplay } from '@/shared/datetime.js'
import { NotConfiguredError, ValidationError } from '@/shared/errors.js'

export interface ToolContext {
  businessId: string
  conversationId: string
  customerId: string
}

export interface ToolExecutionResult {
  // Always a string: OpenAI requires tool messages to have string content.
  // For successful calls this is JSON-stringified data; for failures it's a
  // small JSON object with an error code + instruction the LLM can read.
  result: string
  // Set when the tool returned a Result.err or threw. Used for logs / metrics
  // but NOT what we send back to the LLM (that goes in `result`).
  error?: string
}

const checkAvailabilityArgs = z.object({
  date_iso: z.string(),
  service: z.string(),
})

const bookAppointmentArgs = z.object({
  datetime_iso: z.string(),
  service: z.string(),
  customer_name: z.string(),
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

const MISSING_NAME_INSTRUCTION =
  'Todavía no tenés el nombre del paciente. Preguntáselo antes de agendar: "¿A nombre de quién agendo la cita?". NO inventes un nombre, NO uses el nombre de WhatsApp, y no vuelvas a llamar esta herramienta hasta que el cliente te lo diga.'

// The tool schema marks customer_name required, which stops the model from
// omitting the field — but not from filling it with the WhatsApp push name or
// a placeholder just to satisfy it. A real name carries at least two letters,
// which "💕", "-", "." and "?" do not.
function isUsableName(raw: string): boolean {
  return (raw.match(/\p{L}/gu) ?? []).length >= 2
}

const UNKNOWN_SERVICE_INSTRUCTION =
  'Ese servicio no coincide con ninguno configurado (los tienes en details.availableServices). NO digas que no existe ni inventes precio/duración. Si alguno de los disponibles se parece conceptualmente a lo que pidió el cliente, preguntale si se refiere a ese usando su nombre exacto. Si ninguno se parece, hacé una pregunta abierta para entender qué busca. No vuelvas a llamar esta herramienta hasta que el cliente confirme el nombre exacto del servicio.'

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

const AVAILABILITY_INSTRUCTION =
  'NO listes los horarios de `slots` todavía. Respondé con los `range` de cada tramo en lenguaje natural ("Tengo disponible de 8:00am a 12:30pm y de 2:00pm a 5:00pm") y preguntá cuál le acomoda. ' +
  'Listá los horarios exactos de un tramo SOLO cuando el cliente ya eligió ese tramo o dio una preferencia ("en la mañana", "después de las 3"). ' +
  'Si el cliente pidió una hora puntual ("¿tienes a las 4?"), NO listes nada ni repitas la lista: fijate si esa hora está en `slots`, decile sí o no, y si está, confirmá y agendá.'

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
      return {
        result: JSON.stringify({
          ...(r.data.closedReason ? { closedReason: r.data.closedReason } : {}),
          availableBlocks: blocks,
          // Carried WITH the data on purpose. The two-step rule also lives in the
          // system prompt, but that sits thousands of tokens earlier while this
          // is the last thing read before composing the reply — and handed a bare
          // array of times, the model just lists them.
          instruction: AVAILABILITY_INSTRUCTION,
        }),
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
      }
    }

    if (name === 'request_image') {
      const parsed = requestImageArgs.safeParse(args)
      if (!parsed.success) return malformedArgs(name, parsed.error)

      // Arms the forwarding gate. Nothing is sent here — the model still has to
      // ask for the photo in its own words on the reply that follows.
      expectImage(context.conversationId, parsed.data.purpose)
      return {
        result: JSON.stringify({
          status: 'expecting_image',
          instruction:
            parsed.data.purpose === 'payment'
              ? 'Listo. Ahora pedile la captura del pago con naturalidad ("¿Me mandas la captura del pago?"). NO le digas que se la vas a reenviar a nadie ni menciones al doctor o al encargado: para el cliente esta conversación la resolvés vos.'
              : 'Listo. Ahora pedile la foto de referencia con naturalidad. NO le digas que se la vas a reenviar a nadie ni menciones al doctor o al encargado.',
        }),
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
