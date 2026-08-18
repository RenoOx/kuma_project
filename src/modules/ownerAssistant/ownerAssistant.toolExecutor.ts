import { logger } from '@/config/logger.js'
import * as appointmentRepo from '@/modules/appointment/appointment.repo.js'
import * as appointmentService from '@/modules/appointment/appointment.service.js'
import * as businessService from '@/modules/business/business.service.js'
import type { BotPausedState } from '@/modules/business/business.settings.js'
import * as conversationRepo from '@/modules/conversation/conversation.repo.js'
import * as messageRepo from '@/modules/message/message.repo.js'
import { z } from 'zod'
import { generateDailyReportText } from './dailyReport.js'
import * as ownerNotifier from '@/modules/whatsapp/ownerNotifier.js'
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
      result: JSON.stringify({ error: 'invalid_date', instruction: 'No pude calcular el rango horario de esa fecha.' }),
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
      appointments_for_today: appointmentsToday.map((a) => ({
        time: a.scheduledAt.toISOString(),
        service: a.service,
        customer_name: a.customerName,
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
      appointments: rows.map((r) => ({
        id: r.id,
        scheduled_at: r.scheduledAt.toISOString(),
        service: r.service,
        duration_minutes: r.durationMinutes,
        customer_name: r.customerName,
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
  const sent = await ownerNotifier.notifyOwner(ctx.businessId, reportText)
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
  try {
    return new Intl.DateTimeFormat('es-PE', {
      timeZone: timezone,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(scheduledAt)
  } catch {
    return scheduledAt.toISOString()
  }
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

  if (result.data.length === 0) {
    return { result: JSON.stringify({ count: 0, message: 'No hay solicitudes pendientes' }) }
  }

  return {
    result: JSON.stringify({
      count: result.data.length,
      // The id travels alongside each row because the follow-up tools key on it,
      // but it is internal plumbing — the owner should never see it in a reply.
      instruction:
        'Presentá estas solicitudes al dueño en una lista corta con nombre, teléfono, servicio y horario. NUNCA le muestres el campo id: es interno, usalo solo para llamar las otras tools.',
      pending: result.data.map((a) => ({
        id: a.id,
        customer_name: a.customerName ?? '(sin nombre)',
        customer_phone: a.customerPhone,
        service: a.service,
        when: readableSlot(a.scheduledAt, ctx.businessTimezone),
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
