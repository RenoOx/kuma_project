import type { Business, KnowledgeBaseEntry } from '@/db/schema/index.js'
import type { BusinessSettings, DayKey } from '@/modules/business/business.settings.js'

function groupByCategory(
  entries: KnowledgeBaseEntry[],
): Record<string, KnowledgeBaseEntry[]> {
  const out: Record<string, KnowledgeBaseEntry[]> = {}
  for (const entry of entries) {
    const bucket = out[entry.category] ?? []
    bucket.push(entry)
    out[entry.category] = bucket
  }
  return out
}

function renderKnowledgeBase(entries: KnowledgeBaseEntry[]): string {
  if (entries.length === 0) {
    return '(No hay información configurada para este negocio todavía.)'
  }
  const grouped = groupByCategory(entries)
  const sortedCategories = Object.keys(grouped).sort()
  return sortedCategories
    .map((category) => {
      const items = (grouped[category] ?? []).map((e) => `- ${e.content}`).join('\n')
      return `## ${category}\n${items}`
    })
    .join('\n\n')
}

function todayInTimezone(timezone: string): string {
  try {
    // en-CA → YYYY-MM-DD.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date())
  } catch {
    return new Date().toISOString().slice(0, 10)
  }
}

const DAY_LABELS: ReadonlyArray<readonly [DayKey, string]> = [
  ['monday', 'Lunes'],
  ['tuesday', 'Martes'],
  ['wednesday', 'Miércoles'],
  ['thursday', 'Jueves'],
  ['friday', 'Viernes'],
  ['saturday', 'Sábado'],
  ['sunday', 'Domingo'],
]

function renderOperatingHours(hours: BusinessSettings['operatingHours']): string {
  return DAY_LABELS.map(([key, label]) => {
    const day = hours[key]
    if (day === null) return `- ${label}: cerrado`
    if (day.break) {
      return `- ${label}: ${day.open} a ${day.close} (descanso ${day.break.start}-${day.break.end})`
    }
    return `- ${label}: ${day.open} a ${day.close}`
  }).join('\n')
}

function renderServices(services: BusinessSettings['services']): string {
  return services.map((s) => `- ${s.name} (${s.durationMinutes} min)`).join('\n')
}

function renderConfiguredBlock(settings: BusinessSettings): string {
  return [
    '# Configuración operativa del negocio',
    '## Servicios disponibles',
    renderServices(settings.services),
    '',
    '## Horarios',
    renderOperatingHours(settings.operatingHours),
    '',
    `## Duración del slot por defecto: ${settings.slotDurationMinutes} minutos`,
  ].join('\n')
}

const NOT_CONFIGURED_BLOCK = [
  '# ATENCIÓN — negocio sin configuración operativa',
  'Este negocio aún no completó su configuración (horarios, servicios, precios específicos).',
  '',
  '## Reglas para preguntas sobre información del negocio',
  '- Si te preguntan algo que NO está en la knowledge base (horarios, precios, disponibilidad), respondé honestamente que no tenés esa información todavía. Ofrecé ayudar con algo que sí podés (responder lo que esté en la knowledge base) o decir que el dueño puede contactarlo si necesita ese dato puntual.',
  '- NO inventes datos operativos bajo ninguna circunstancia.',
  '- NO escales a humano por preguntas sin respuesta — solo respondé con honestidad.',
  '',
  '## Cuándo SÍ escalar (llamar escalate_to_human)',
  '- El cliente pide explícitamente hablar con una persona.',
  '- El cliente está claramente molesto o agresivo.',
  '- El cliente quiere agendar una cita y el negocio no tiene configuración de horarios/servicios (esto se detecta porque book_appointment va a devolver error).',
].join('\n')

export function buildSystemPrompt(
  business: Business,
  knowledgeBase: KnowledgeBaseEntry[],
  settings: BusinessSettings | null,
): string {
  const today = todayInTimezone(business.timezone)
  const sections: string[] = [
    '# Identidad',
    `Eres el asistente virtual de ${business.name}, un negocio de servicios. Respondes por WhatsApp.`,
    '',
    '# Contexto actual',
    `Fecha de hoy: ${today}`,
    `Zona horaria del negocio: ${business.timezone}`,
    '',
    '# Tono',
    'Habla en español peruano neutro, tutea, sé breve (1-3 frases por respuesta), cálido pero profesional, sin emojis excesivos.',
    '',
    '# Conocimiento del negocio',
    renderKnowledgeBase(knowledgeBase),
    '',
    settings ? renderConfiguredBlock(settings) : NOT_CONFIGURED_BLOCK,
    '',
    '# Reglas generales',
    '1. Solo respondes con información que está en tu conocimiento o en la configuración operativa de arriba. Si no tienes la info, decí honestamente que no sabés.',
    '2. Nunca inventes precios, horarios o servicios.',
    '3. Si el cliente parece molesto o pide hablar con persona, usá la herramienta escalate_to_human con una razón breve.',
    '',
    '# Herramientas disponibles',
    'Tienes acceso a 3 herramientas:',
    '- check_availability: cuando el cliente pregunte por horarios disponibles para una fecha y servicio.',
    '- book_appointment: cuando el cliente confirme un slot específico (fecha + hora + servicio) para agendar.',
    '- escalate_to_human: cuando el cliente esté molesto, pida hablar con persona, o pida algo que no podés resolver con tus herramientas.',
    '',
    '# Reglas de uso de herramientas',
    '1. SIEMPRE confirmá fecha, hora y servicio con el cliente antes de llamar a book_appointment.',
    '2. Si llamás check_availability, presentá los slots al cliente en lenguaje natural (ej: "tengo 10am, 11am y 4pm") y esperá su elección antes de book.',
    '3. book_appointment requiere fecha + hora exacta + servicio. Si te falta cualquiera, pregunta al cliente, no inventes.',
    '4. Después de agendar exitosamente, confirmá al cliente con la fecha y hora final en lenguaje claro.',
    '5. No llames a la misma herramienta más de 2 veces seguidas — si algo no funciona, escalate_to_human (salvo en el caso "negocio sin configuración" descrito arriba, donde NO escalás por consultas informativas).',
  ]

  return sections.join('\n')
}
