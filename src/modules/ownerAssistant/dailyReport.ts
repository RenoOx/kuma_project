import * as appointmentRepo from '@/modules/appointment/appointment.repo.js'
import * as businessService from '@/modules/business/business.service.js'
import * as conversationRepo from '@/modules/conversation/conversation.repo.js'
import * as eventsRepo from '@/modules/events/events.repo.js'
import * as messageRepo from '@/modules/message/message.repo.js'
import { dayRangeInTimezone, shiftDateISO, todayInTimezone } from './timezone.js'

const TODAY_APPOINTMENTS_LIST_THRESHOLD = 5
const PENDING_ESCALATIONS_LIST_LIMIT = 3

function formatTimeLima(date: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('es-PE', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date)
  } catch {
    return date.toISOString().slice(11, 16)
  }
}

// Builds the structured daily report sent proactively to the business owner.
// Same data as get_daily_summary, but formatted as a WhatsApp message with
// asterisks for bold so the owner sees a clean glanceable summary.
export async function generateDailyReportText(businessId: string): Promise<string> {
  const businessResult = await businessService.getById(businessId)
  if (!businessResult.ok) {
    return `No pude generar el reporte: ${businessResult.error.userMessage}`
  }
  const business = businessResult.data
  const timezone = business.timezone

  const todayISO = todayInTimezone(timezone)
  const tomorrowISO = shiftDateISO(todayISO, 1)
  const todayRange = dayRangeInTimezone(todayISO, timezone)
  const tomorrowRange = dayRangeInTimezone(tomorrowISO, timezone)

  if (!todayRange || !tomorrowRange) {
    return `No pude calcular el rango horario para ${timezone}. Reporte cancelado.`
  }

  const escalationsSince = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const [
    messagesReceived,
    appointmentsCreated,
    appointmentsToday,
    appointmentsTomorrow,
    escalationsCount,
    escalationsList,
  ] = await Promise.all([
    messageRepo.countUserMessagesInRange(businessId, todayRange.start, todayRange.end),
    appointmentRepo.countCreatedInRange(businessId, todayRange.start, todayRange.end),
    appointmentRepo.listScheduledInRange(businessId, todayRange.start, todayRange.end, 20),
    appointmentRepo.listScheduledInRange(
      businessId,
      tomorrowRange.start,
      tomorrowRange.end,
      20,
    ),
    conversationRepo.countRecentEscalatedCustomerConversations(businessId, escalationsSince),
    conversationRepo.listRecentEscalatedCustomerConversations(
      businessId,
      escalationsSince,
      PENDING_ESCALATIONS_LIST_LIMIT,
    ),
  ])

  // For each listed escalation, look up the latest 'escalation' event's
  // reason. Small N (≤3), so the extra round-trips are acceptable.
  const reasons = await Promise.all(
    escalationsList.map((e) =>
      eventsRepo.findLatestEscalationReason(businessId, e.conversationId),
    ),
  )

  const lines: string[] = []
  lines.push(`📊 *Reporte de hoy* — ${todayISO}`)
  lines.push('')
  lines.push(`• Mensajes recibidos: ${messagesReceived}`)
  lines.push(`• Citas agendadas hoy: ${appointmentsCreated}`)
  lines.push(`• Citas para hoy: ${appointmentsToday.length}`)
  if (appointmentsToday.length > 0 && appointmentsToday.length <= TODAY_APPOINTMENTS_LIST_THRESHOLD) {
    for (const a of appointmentsToday) {
      const time = formatTimeLima(a.scheduledAt, timezone)
      const who = a.customerName?.trim() || a.customerPhone
      lines.push(`   - ${time} ${a.service} (${who})`)
    }
  }
  lines.push(`• Citas para mañana: ${appointmentsTomorrow.length}`)
  lines.push(`• Escalaciones pendientes (24h): ${escalationsCount}`)
  if (escalationsList.length > 0) {
    escalationsList.forEach((e, idx) => {
      const who = e.customerName?.trim() || e.customerPhone
      const reason = reasons[idx] ?? 'sin motivo'
      lines.push(`   - ${who}: ${reason}`)
    })
  }

  lines.push('')
  lines.push('¿Necesitás algo más?')
  return lines.join('\n')
}
