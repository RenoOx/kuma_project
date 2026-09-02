import { z } from 'zod'
import { logger } from '@/config/logger.js'
import type { Customer, PaymentVerification } from '@/db/schema/index.js'
import * as appointmentRepo from '@/modules/appointment/appointment.repo.js'
import * as appointmentService from '@/modules/appointment/appointment.service.js'
import * as paymentVerificationService from '@/modules/appointment/paymentVerification.service.js'
import * as businessService from '@/modules/business/business.service.js'
import type { BotPausedState } from '@/modules/business/business.settings.js'
import * as conversationRepo from '@/modules/conversation/conversation.repo.js'
import * as conversationService from '@/modules/conversation/conversation.service.js'
import * as customerRepo from '@/modules/customer/customer.repo.js'
import * as messageRepo from '@/modules/message/message.repo.js'
import * as messageService from '@/modules/message/message.service.js'
import * as clientRegistry from '@/modules/whatsapp/clientRegistry.js'
import { sendWithPresence } from '@/modules/whatsapp/outbound.js'
import * as ownerNotifier from '@/modules/whatsapp/ownerNotifier.js'
import { formatDateTimeForDisplay, formatTimeForDisplay } from '@/shared/datetime.js'
import { formatPersonName } from '@/shared/name.js'
import { normalizePhone } from '@/shared/phone.js'
import { generateDailyReportText } from './dailyReport.js'
import type { OwnerContext, OwnerToolExecutionResult } from './ownerAssistant.types.js'
import { dayRangeInTimezone } from './timezone.js'

const dailySummaryArgs = z.object({
  date_iso: z.string().optional(),
})

const appointmentsArgs = z.object({
  date_from: z.string(),
  date_to: z.string(),
})

const pauseBotArgs = z.object({
  reason: z.string().optional(),
  until_iso: z.string().optional(),
})

const resumeBotArgs = z.object({}).strict()

const appointmentIdArgs = z.object({
  appointment_id: z.string().min(1),
  reason: z.string().optional(),
})

const rescheduleArgs = z.object({
  appointment_id: z.string().min(1),
  suggested_datetime: z.string().min(1),
  message: z.string().optional(),
})

const replyToCustomerArgs = z.object({
  customer_phone: z.string().min(1),
  message: z.string().min(1),
})

const paymentDecisionArgs = z.object({
  customer_phone: z.string().min(1),
  // Set when the owner named someone ("confirma la de Juan"). Cross-checked
  // against the row before anything is approved — see namesMatch.
  customer_name: z.string().optional(),
  reason: z.string().optional(),
})

// Every patient name the owner reads goes through here. A null means WhatsApp
// never gave us a push name AND the patient never booked through Emma since
// she started asking — there is no other source to fall back to, so we say so
// instead of handing the model a bare null it renders as "null".
function displayName(raw: string | null): string {
  return formatPersonName(raw) ?? '(sin nombre)'
}

function malformedArgs(toolName: string, parseError: z.ZodError): OwnerToolExecutionResult {
  const summary = parseError.issues
    .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
    .join('; ')
  return {
    result: JSON.stringify({
      error: 'invalid_args',
      instruction: 'Los argumentos enviados no son válidos. Revisá el formato y reintentá.',
      details: summary,
    }),
    error: `invalid_args:${toolName}`,
  }
}

async function buildDailySummary(
  ctx: OwnerContext,
  dateISO: string,
): Promise<OwnerToolExecutionResult> {
  const range = dayRangeInTimezone(dateISO, ctx.businessTimezone)
  if (!range) {
    return {
      result: JSON.stringify({
        error: 'invalid_date',
        instruction: 'No pude calcular el rango horario de esa fecha.',
      }),
      error: 'invalid_date',
    }
  }
  const [userMessages, appointmentsCreated, appointmentsToday, escalations] = await Promise.all([
    messageRepo.countUserMessagesInRange(ctx.businessId, range.start, range.end),
    appointmentRepo.countCreatedInRange(ctx.businessId, range.start, range.end),
    appointmentRepo.listScheduledInRange(ctx.businessId, range.start, range.end, 20),
    conversationRepo.countRecentEscalatedCustomerConversations(
      ctx.businessId,
      new Date(Date.now() - 24 * 60 * 60 * 1000),
    ),
  ])

  return {
    result: JSON.stringify({
      date: dateISO,
      timezone: ctx.businessTimezone,
      messages_received: userMessages,
      appointments_created_today: appointmentsCreated,
      // Already rendered in the business's wall clock. Handing the model a raw
      // UTC ISO made it do the conversion itself, and it showed the owner the
      // UTC hour or a 24h time for an appointment they think of as "8pm".
      appointments_for_today: appointmentsToday.map((a) => ({
        time: formatTimeForDisplay(a.scheduledAt, ctx.businessTimezone),
        service: a.service,
        customer_name: displayName(a.customerName),
        customer_phone: a.customerPhone,
        status: a.status,
      })),
      pending_escalations_last_24h: escalations,
    }),
  }
}

async function buildAppointmentsList(
  ctx: OwnerContext,
  args: { date_from: string; date_to: string },
): Promise<OwnerToolExecutionResult> {
  const startRange = dayRangeInTimezone(args.date_from, ctx.businessTimezone)
  const endRange = dayRangeInTimezone(args.date_to, ctx.businessTimezone)
  if (!startRange || !endRange) {
    return {
      result: JSON.stringify({ error: 'invalid_date', instruction: 'No pude calcular el rango.' }),
      error: 'invalid_date',
    }
  }
  const rows = await appointmentRepo.listScheduledInRange(
    ctx.businessId,
    startRange.start,
    endRange.end,
    20,
  )
  return {
    result: JSON.stringify({
      from: args.date_from,
      to: args.date_to,
      count: rows.length,
      instruction:
        'Los horarios ya vienen en la zona horaria del negocio y en formato 12h. Copialos tal cual — no los conviertas ni los pases a 24h. El campo id es interno: nunca se lo muestres al dueño.',
      appointments: rows.map((r) => ({
        id: r.id,
        // Wall clock of the business, not UTC. See the note in buildDailySummary.
        when: formatDateTimeForDisplay(r.scheduledAt, ctx.businessTimezone),
        time: formatTimeForDisplay(r.scheduledAt, ctx.businessTimezone),
        service: r.service,
        duration_minutes: r.durationMinutes,
        customer_name: displayName(r.customerName),
        customer_phone: r.customerPhone,
        status: r.status,
      })),
    }),
  }
}

async function pauseBot(
  ctx: OwnerContext,
  args: { reason?: string; until_iso?: string },
): Promise<OwnerToolExecutionResult> {
  const state: BotPausedState = {
    paused: true,
    pausedAt: new Date().toISOString(),
    ...(args.until_iso ? { until: args.until_iso } : {}),
    ...(args.reason ? { reason: args.reason } : {}),
  }
  const updated = await businessService.updateSettings(ctx.businessId, { botPaused: state })
  if (!updated.ok) {
    return {
      result: JSON.stringify({ error: updated.error.code, instruction: updated.error.userMessage }),
      error: updated.error.code,
    }
  }
  return {
    result: JSON.stringify({
      status: 'paused',
      paused_at: state.pausedAt,
      until: state.until ?? null,
      reason: state.reason ?? null,
    }),
  }
}

async function resumeBot(ctx: OwnerContext): Promise<OwnerToolExecutionResult> {
  const updated = await businessService.updateSettings(ctx.businessId, { botPaused: null })
  if (!updated.ok) {
    return {
      result: JSON.stringify({ error: updated.error.code, instruction: updated.error.userMessage }),
      error: updated.error.code,
    }
  }
  return { result: JSON.stringify({ status: 'resumed' }) }
}

async function sendDailyReportNow(ctx: OwnerContext): Promise<OwnerToolExecutionResult> {
  const reportText = await generateDailyReportText(ctx.businessId)
  // Not recorded in the owner thread: this runs inside the assistant's tool
  // loop, so the row would land between the assistant turn carrying the
  // tool_calls and its tool result and make the next request invalid. The
  // report still reaches the transcript through this tool's own result.
  const sent = await ownerNotifier.notifyOwner(ctx.businessId, reportText, {
    recordInOwnerThread: false,
  })
  if (!sent.ok) {
    return {
      result: JSON.stringify({
        status: 'error',
        instruction: 'No pude enviar el reporte ahora. Intentá de nuevo en un momento.',
        error: sent.error.code,
      }),
      error: sent.error.code,
    }
  }
  return {
    result: JSON.stringify({
      status: 'sent',
      instruction:
        'Reporte enviado al dueño exitosamente. Confirmale al dueño que el push ya salió.',
    }),
  }
}

// ── Gestión de solicitudes ───────────────────────────────────────────────────
//
// Thin layer by design: every status transition, every calendar update and the
// message to the patient happen inside appointmentService. All this does is
// turn the outcome into something the model can act on.

function readableSlot(scheduledAt: Date, timezone: string): string {
  return formatDateTimeForDisplay(scheduledAt, timezone)
}

// Failure here is NOT the same as "the action failed": the appointment already
// changed status. The model has to tell the owner both halves of that.
function notifyWarning(result: { patientNotified: boolean; patientNotifyError?: string }): string {
  return result.patientNotified
    ? 'Se notificó al paciente por WhatsApp.'
    : `ATENCIÓN: el cambio quedó guardado pero NO se pudo avisar al paciente (${result.patientNotifyError ?? 'error desconocido'}). Decíselo al dueño para que lo contacte por su cuenta.`
}

async function listPending(ctx: OwnerContext): Promise<OwnerToolExecutionResult> {
  const result = await appointmentService.listPendingAppointments(ctx.businessId)
  if (!result.ok) {
    return {
      result: JSON.stringify({ error: result.error.code, instruction: result.error.userMessage }),
      error: result.error.code,
    }
  }

  // Captures waiting on the owner are requests too, and under the deposit gate
  // they are the ONLY record of one: book_appointment is refused on the customer
  // side, so nothing exists in `appointments` until the owner approves. Listing
  // appointments alone answered "no hay solicitudes pendientes" with two
  // captures sitting in the owner's thread.
  const payments = await paymentVerificationService.listOpenByBusiness(ctx.businessId)
  if (!payments.ok) {
    return {
      result: JSON.stringify({
        error: payments.error.code,
        instruction: payments.error.userMessage,
      }),
      error: payments.error.code,
    }
  }

  const total = result.data.length + payments.data.length
  if (total === 0) {
    return { result: JSON.stringify({ count: 0, message: 'No hay solicitudes pendientes' }) }
  }

  return {
    result: JSON.stringify({
      count: total,
      // The id travels alongside each row because the follow-up tools key on it,
      // but it is internal plumbing — the owner should never see it in a reply.
      instruction:
        'Presentá estas solicitudes al dueño en una lista corta con nombre, servicio y horario. NUNCA le muestres el campo id: es interno, usalo solo para llamar las otras tools. ' +
        'Las de `pending` son solicitudes de cita ya creadas: se resuelven con confirm_appointment o reject_appointment usando su `id`. ' +
        'Las de `pending_payments` son capturas de pago esperando el visto bueno del dueño y TODAVÍA NO tienen cita creada: se resuelven con approve_payment o reject_payment usando su `customer_phone`, nunca con confirm_appointment. ' +
        'Si hay más de una en total, preguntale al dueño a cuál se refiere antes de actuar — no elijas vos.',
      pending: result.data.map((a) => ({
        id: a.id,
        customer_name: displayName(a.customerName),
        customer_phone: a.customerPhone,
        service: a.service,
        when: readableSlot(a.scheduledAt, ctx.businessTimezone),
      })),
      pending_payments: payments.data.map((v) => ({
        customer_name: displayName(v.customerName),
        customer_phone: v.customerPhone,
        service: v.service,
        when: readableSlot(v.scheduledAt, ctx.businessTimezone),
        ...(v.depositAmount ? { deposit_amount: v.depositAmount } : {}),
      })),
    }),
  }
}

async function confirmPending(
  ctx: OwnerContext,
  args: { appointment_id: string },
): Promise<OwnerToolExecutionResult> {
  const result = await appointmentService.confirmAppointment({
    businessId: ctx.businessId,
    appointmentId: args.appointment_id,
  })
  if (!result.ok) {
    return {
      result: JSON.stringify({ error: result.error.code, instruction: result.error.userMessage }),
      error: result.error.code,
    }
  }
  return {
    result: JSON.stringify({
      status: 'confirmed',
      instruction: `Cita confirmada. ${notifyWarning(result.data)}`,
    }),
  }
}

async function rejectPending(
  ctx: OwnerContext,
  args: { appointment_id: string; reason?: string },
): Promise<OwnerToolExecutionResult> {
  const result = await appointmentService.rejectAppointment({
    businessId: ctx.businessId,
    appointmentId: args.appointment_id,
    ...(args.reason ? { reason: args.reason } : {}),
  })
  if (!result.ok) {
    return {
      result: JSON.stringify({ error: result.error.code, instruction: result.error.userMessage }),
      error: result.error.code,
    }
  }
  return {
    result: JSON.stringify({
      status: 'rejected',
      instruction: `Solicitud rechazada. ${notifyWarning(result.data)}`,
    }),
  }
}

async function reschedule(
  ctx: OwnerContext,
  args: { appointment_id: string; suggested_datetime: string; message?: string },
): Promise<OwnerToolExecutionResult> {
  const result = await appointmentService.rescheduleAppointment({
    businessId: ctx.businessId,
    appointmentId: args.appointment_id,
    suggestedDatetimeISO: args.suggested_datetime,
    ...(args.message ? { message: args.message } : {}),
  })
  if (!result.ok) {
    return {
      result: JSON.stringify({ error: result.error.code, instruction: result.error.userMessage }),
      error: result.error.code,
    }
  }
  return {
    result: JSON.stringify({
      status: 'rescheduled',
      new_when: readableSlot(result.data.replacement.scheduledAt, ctx.businessTimezone),
      instruction: `Se le propuso el nuevo horario al paciente y quedó como solicitud pendiente hasta que él responda. ${notifyWarning(result.data)}`,
    }),
  }
}

async function cancel(
  ctx: OwnerContext,
  args: { appointment_id: string; reason?: string },
): Promise<OwnerToolExecutionResult> {
  const result = await appointmentService.cancelAppointment({
    businessId: ctx.businessId,
    appointmentId: args.appointment_id,
    ...(args.reason ? { reason: args.reason } : {}),
  })
  if (!result.ok) {
    return {
      result: JSON.stringify({ error: result.error.code, instruction: result.error.userMessage }),
      error: result.error.code,
    }
  }
  return {
    result: JSON.stringify({
      status: 'cancelled',
      instruction: `Cita cancelada. ${notifyWarning(result.data)}`,
    }),
  }
}

// ── Verificación de pagos ────────────────────────────────────────────────────
//
// The owner's half of the deposit flow. A capture arrives, the booking is
// withheld, and one of these two turns that hold into a decision.
//
// Keyed on the patient's PHONE rather than on a verification id, for the same
// reason reply_to_customer is: the phone is what the 💰 card put in front of
// the owner, and it is what the model can read back out of its own thread. An
// id would have to be shown to the owner first, which is the one thing the
// prompt tells it never to do.

// Loose name comparison for the cross-check below: case, surrounding space and
// accents are noise here ("jose" for "José"), and the owner routinely says only
// a first name for a row filed under the full one. Substring either way covers
// "Juan" vs "Juan Pérez" without letting two different people match.
function normalizeForMatch(raw: string): string {
  // NFD splits "é" into "e" plus a combining mark; dropping every code point in
  // the combining-marks block leaves the base letters, so "jose" matches "José".
  // Written as a filter rather than a regex character class: the literal range
  // would put bare combining marks in the source, which Biome flags and editors
  // mangle.
  return Array.from(raw.toLowerCase().trim().normalize('NFD'))
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0
      return code < 0x0300 || code > 0x036f
    })
    .join('')
}

// Undecidable when either side is blank — an empty `customer_name` from the
// model, or a row filed without a usable one. Undecidable is NOT a mismatch:
// refusing there would block the ordinary single-capture flow over a missing
// field, so the check simply does not apply and the phone stands on its own.
function namesMatch(said: string, onFile: string): boolean {
  const a = normalizeForMatch(said)
  const b = normalizeForMatch(onFile)
  if (!a || !b) return true
  return a === b || a.includes(b) || b.includes(a)
}

/**
 * Resolves "the capture this owner is talking about" from a phone number.
 *
 * Both failure modes are answered in words the model can pass on, because both
 * are things the owner can act on: a wrong number, or a decision that arrived
 * after the request was already closed.
 *
 * `expectedName` is the safety net for the case the phone alone cannot catch.
 * The owner thread is one per business, so the model picks the phone out of
 * whichever 💰 card it can still see — and a wrong pick books the appointment
 * for the wrong patient and sends THEM the confirmation, with nothing to
 * detect it afterwards. When the owner named someone, that name has to agree
 * with the row before anything is written.
 */
async function loadOpenVerification(
  ctx: OwnerContext,
  rawPhone: string,
  expectedName?: string,
): Promise<
  | { ok: true; verification: PaymentVerification; customer: Customer }
  | { ok: false; failure: OwnerToolExecutionResult }
> {
  const phone = normalizePhone(rawPhone)
  if (!phone) {
    return {
      ok: false,
      failure: {
        result: JSON.stringify({
          error: 'invalid_phone',
          instruction: 'Ese teléfono no es válido. Pedile al dueño de qué paciente se trata.',
        }),
        error: 'invalid_phone',
      },
    }
  }

  const customer = await customerRepo.findByPhone(ctx.businessId, phone)
  if (!customer) {
    return {
      ok: false,
      failure: {
        result: JSON.stringify({
          error: 'customer_not_found',
          instruction:
            'No encontré a ningún paciente con ese número en este negocio. Decíselo al dueño y pedile que confirme el teléfono.',
        }),
        error: 'customer_not_found',
      },
    }
  }

  const conversation = await conversationService.getOrCreateOpen(ctx.businessId, customer.id)
  if (!conversation.ok) {
    return {
      ok: false,
      failure: {
        result: JSON.stringify({
          error: conversation.error.code,
          instruction: 'No pude abrir la conversación con ese paciente. Avisale al dueño.',
        }),
        error: conversation.error.code,
      },
    }
  }

  const verification = await paymentVerificationService.findOpenByConversation(
    ctx.businessId,
    conversation.data.id,
  )
  if (!verification) {
    return {
      ok: false,
      failure: {
        result: JSON.stringify({
          error: 'no_pending_verification',
          instruction:
            'Ese paciente no tiene ningún comprobante esperando verificación ahora mismo. Decíselo al dueño en una línea; si igual quiere mandarle un mensaje, usá reply_to_customer.',
        }),
        error: 'no_pending_verification',
      },
    }
  }

  // The phone got us a row; the name says whether it is the RIGHT row. Refusing
  // is the only safe answer: approving books a real appointment for whoever
  // this phone belongs to and sends them the confirmation, and nothing
  // downstream would ever notice it went to the wrong patient.
  if (expectedName !== undefined && !namesMatch(expectedName, verification.customerName)) {
    return {
      ok: false,
      failure: {
        result: JSON.stringify({
          error: 'name_mismatch',
          said_by_owner: expectedName,
          on_file: displayName(verification.customerName),
          instruction:
            'El comprobante de ese teléfono está a nombre de otra persona, así que NO lo apruebes ni lo rechaces. Llamá list_pending_appointments y preguntale al dueño a cuál de las solicitudes se refiere.',
        }),
        error: 'name_mismatch',
      },
    }
  }

  return { ok: true, verification, customer }
}

async function approvePayment(
  ctx: OwnerContext,
  args: { customer_phone: string; customer_name?: string },
): Promise<OwnerToolExecutionResult> {
  const loaded = await loadOpenVerification(ctx, args.customer_phone, args.customer_name)
  if (!loaded.ok) return loaded.failure

  const result = await paymentVerificationService.approve({
    businessId: ctx.businessId,
    verificationId: loaded.verification.id,
  })
  if (!result.ok) {
    return {
      result: JSON.stringify({ error: result.error.code, instruction: result.error.userMessage }),
      error: result.error.code,
    }
  }

  const { appointment } = result.data
  return {
    result: JSON.stringify({
      status: 'approved',
      customer_name: displayName(loaded.customer.name),
      service: appointment?.service ?? loaded.verification.service,
      when: readableSlot(
        appointment?.scheduledAt ?? loaded.verification.scheduledAt,
        ctx.businessTimezone,
      ),
      instruction: `Pago aprobado y cita agendada. ${notifyWarning(result.data)} Confirmáselo al dueño en una línea, nombrando al paciente y el horario.`,
    }),
  }
}

async function rejectPayment(
  ctx: OwnerContext,
  args: { customer_phone: string; customer_name?: string; reason?: string },
): Promise<OwnerToolExecutionResult> {
  const loaded = await loadOpenVerification(ctx, args.customer_phone, args.customer_name)
  if (!loaded.ok) return loaded.failure

  const result = await paymentVerificationService.reject({
    businessId: ctx.businessId,
    verificationId: loaded.verification.id,
    ...(args.reason ? { reason: args.reason } : {}),
  })
  if (!result.ok) {
    return {
      result: JSON.stringify({ error: result.error.code, instruction: result.error.userMessage }),
      error: result.error.code,
    }
  }

  return {
    result: JSON.stringify({
      status: 'rejected',
      customer_name: displayName(loaded.customer.name),
      instruction: `Comprobante rechazado, no se agendó nada y ya le pedí al paciente que la reenvíe. ${notifyWarning(result.data)}`,
    }),
  }
}

/**
 * Relays the owner's words to a patient, as Emma.
 *
 * The message is persisted in the PATIENT's conversation, not the owner thread:
 * without that the patient answers something Emma has no memory of saying, and
 * her next reply reads as a non sequitur. It also goes out with the same
 * anti-ban timing as any other customer-facing message — this leaves on the
 * business's number like everything else.
 */
async function replyToCustomer(
  ctx: OwnerContext,
  args: { customer_phone: string; message: string },
): Promise<OwnerToolExecutionResult> {
  const phone = normalizePhone(args.customer_phone)
  if (!phone) {
    return {
      result: JSON.stringify({
        error: 'invalid_phone',
        instruction: 'Ese teléfono no es válido. Pedile al dueño que te diga a quién responderle.',
      }),
      error: 'invalid_phone',
    }
  }

  const customer = await customerRepo.findByPhone(ctx.businessId, phone)
  if (!customer) {
    return {
      result: JSON.stringify({
        error: 'customer_not_found',
        instruction:
          'No encontré a ningún paciente con ese número en este negocio. Decíselo al dueño y pedile que confirme el teléfono.',
      }),
      error: 'customer_not_found',
    }
  }

  const conversation = await conversationService.getOrCreateOpen(ctx.businessId, customer.id)
  if (!conversation.ok) {
    return {
      result: JSON.stringify({
        error: conversation.error.code,
        instruction: 'No pude abrir la conversación con ese paciente. Avisale al dueño.',
      }),
      error: conversation.error.code,
    }
  }

  const client = clientRegistry.getClient(ctx.businessId)
  if (!client) {
    return {
      result: JSON.stringify({
        error: 'whatsapp_client_unavailable',
        instruction:
          'WhatsApp no está conectado ahora mismo, así que el mensaje NO se envió. Decíselo al dueño con todas las letras.',
      }),
      error: 'whatsapp_client_unavailable',
    }
  }

  const jid = `${phone.replace('+', '')}@s.whatsapp.net`
  try {
    await sendWithPresence({
      businessId: ctx.businessId,
      jid,
      text: args.message,
      send: (to, text) => client.sendMessage(to, text),
    })
  } catch (cause) {
    logger.error(
      { err: cause, businessId: ctx.businessId, jid },
      'reply_to_customer failed to send',
    )
    return {
      result: JSON.stringify({
        error: 'send_failed',
        instruction:
          'No pude enviarle el mensaje al paciente. Decíselo al dueño para que lo contacte por su cuenta.',
      }),
      error: 'send_failed',
    }
  }

  // Persisted only after a successful send: a transcript entry for a message
  // that never left would make Emma reference something the patient never got.
  const persisted = await messageService.append({
    businessId: ctx.businessId,
    conversationId: conversation.data.id,
    role: 'assistant',
    content: args.message,
  })
  if (!persisted.ok) {
    logger.warn(
      { businessId: ctx.businessId, code: persisted.error.code },
      'reply_to_customer sent but could not be recorded in the transcript',
    )
  }

  return {
    result: JSON.stringify({
      status: 'sent',
      customer_name: displayName(customer.name),
      instruction:
        'El mensaje ya le llegó al paciente. Confirmáselo al dueño en una línea, nombrando al paciente.',
    }),
  }
}

export async function executeOwnerTool(
  name: string,
  args: unknown,
  ctx: OwnerContext,
): Promise<OwnerToolExecutionResult> {
  try {
    if (name === 'get_daily_summary') {
      const parsed = dailySummaryArgs.safeParse(args)
      if (!parsed.success) return malformedArgs(name, parsed.error)
      return await buildDailySummary(ctx, parsed.data.date_iso ?? ctx.currentDate)
    }
    if (name === 'get_appointments') {
      const parsed = appointmentsArgs.safeParse(args)
      if (!parsed.success) return malformedArgs(name, parsed.error)
      return await buildAppointmentsList(ctx, parsed.data)
    }
    if (name === 'pause_bot') {
      const parsed = pauseBotArgs.safeParse(args)
      if (!parsed.success) return malformedArgs(name, parsed.error)
      return await pauseBot(ctx, parsed.data)
    }
    if (name === 'send_daily_report_now') {
      const parsed = resumeBotArgs.safeParse(args)
      if (!parsed.success) return malformedArgs(name, parsed.error)
      return await sendDailyReportNow(ctx)
    }
    if (name === 'resume_bot') {
      const parsedResume = resumeBotArgs.safeParse(args)
      if (!parsedResume.success) return malformedArgs(name, parsedResume.error)
      return await resumeBot(ctx)
    }
    if (name === 'list_pending_appointments') {
      return await listPending(ctx)
    }
    if (name === 'confirm_appointment') {
      const parsed = appointmentIdArgs.safeParse(args)
      if (!parsed.success) return malformedArgs(name, parsed.error)
      return await confirmPending(ctx, parsed.data)
    }
    if (name === 'reject_appointment') {
      const parsed = appointmentIdArgs.safeParse(args)
      if (!parsed.success) return malformedArgs(name, parsed.error)
      return await rejectPending(ctx, parsed.data)
    }
    if (name === 'reschedule_appointment') {
      const parsed = rescheduleArgs.safeParse(args)
      if (!parsed.success) return malformedArgs(name, parsed.error)
      return await reschedule(ctx, parsed.data)
    }
    if (name === 'cancel_appointment') {
      const parsed = appointmentIdArgs.safeParse(args)
      if (!parsed.success) return malformedArgs(name, parsed.error)
      return await cancel(ctx, parsed.data)
    }
    if (name === 'approve_payment') {
      const parsed = paymentDecisionArgs.safeParse(args)
      if (!parsed.success) return malformedArgs(name, parsed.error)
      return await approvePayment(ctx, parsed.data)
    }
    if (name === 'reject_payment') {
      const parsed = paymentDecisionArgs.safeParse(args)
      if (!parsed.success) return malformedArgs(name, parsed.error)
      return await rejectPayment(ctx, parsed.data)
    }
    if (name === 'reply_to_customer') {
      const parsed = replyToCustomerArgs.safeParse(args)
      if (!parsed.success) return malformedArgs(name, parsed.error)
      return await replyToCustomer(ctx, parsed.data)
    }
    return {
      result: JSON.stringify({ error: `Unknown tool: ${name}` }),
      error: 'unknown_tool',
    }
  } catch (cause) {
    logger.error({ tool: name, args, err: cause }, 'owner tool executor threw unexpectedly')
    return {
      result: JSON.stringify({ error: 'La herramienta falló en este momento.' }),
      error: cause instanceof Error ? cause.message : 'unknown',
    }
  }
}
