import { logger } from '@/config/logger.js'
import * as appointmentRepo from '@/modules/appointment/appointment.repo.js'
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
