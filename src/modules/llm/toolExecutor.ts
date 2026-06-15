import { logger } from '@/config/logger.js'
import * as appointmentService from '@/modules/appointment/appointment.service.js'
import { NotConfiguredError, ValidationError } from '@/shared/errors.js'
import { z } from 'zod'

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
      instruction: 'Los argumentos enviados a la herramienta no son válidos. Revisá el formato y volvé a llamarla.',
      details: summary,
    }),
    error: `invalid_args:${toolName}`,
  }
}

const NOT_CONFIGURED_CHECK_INSTRUCTION =
  'Este negocio aún no configuró sus horarios. Decile al cliente con honestidad que no tenés esa información todavía y ofrecele ayudarlo con otra cosa. NO escales, solo informá.'

const NOT_CONFIGURED_BOOK_INSTRUCTION =
  'No se puede agendar: el negocio aún no terminó la configuración. Llamá escalate_to_human porque es una acción que no podés completar.'

const UNKNOWN_SERVICE_INSTRUCTION =
  'Ese servicio no está en la lista de servicios del negocio. Informá al cliente cuáles SÍ hay (los tienes en details.availableServices) y ofrécele uno de los disponibles.'

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
      return { result: JSON.stringify(r.data) }
    }

    if (name === 'book_appointment') {
      const parsed = bookAppointmentArgs.safeParse(args)
      if (!parsed.success) return malformedArgs(name, parsed.error)

      const r = await appointmentService.bookAppointment({
        businessId: context.businessId,
        customerId: context.customerId,
        service: parsed.data.service,
        datetimeISO: parsed.data.datetime_iso,
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
      return {
        result: JSON.stringify({
          appointment_id: r.data.id,
          scheduled_at: r.data.scheduledAt.toISOString(),
          service: r.data.service,
          status: r.data.status,
          duration_minutes: r.data.durationMinutes,
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
