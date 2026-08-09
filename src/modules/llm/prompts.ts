import type { Business, KnowledgeBaseEntry, Message } from '@/db/schema/index.js'
import { formatServicePrice } from '@/modules/business/business.settings.js'
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

function dayOfWeekInTimezone(timezone: string): string {
  try {
    return new Intl.DateTimeFormat('es-PE', {
      timeZone: timezone,
      weekday: 'long',
    }).format(new Date())
  } catch {
    return ''
  }
}

export const GREETING_VARIANTS: ReadonlyArray<(businessName: string) => string> = [
  (name) => `👋 ¡Hola! Soy el asistente de ${name}. ¿En qué te puedo ayudar hoy?`,
  (name) => `¡Hola! 👋 Bienvenido a ${name}, ¿en qué te ayudo?`,
  (name) => `👋 ¡Hola! Gracias por escribirnos a ${name}. ¿Cómo puedo ayudarte?`,
  (name) => `¡Hola, qué gusto saludarte! 👋 Soy el asistente virtual de ${name}. ¿Qué necesitas?`,
  (name) => `👋 ¡Bienvenido a ${name}! Cuéntame, ¿en qué te puedo ayudar?`,
]

// randomFn es inyectable para tests deterministas; en producción usa Math.random.
export function pickGreeting(businessName: string, randomFn: () => number = Math.random): string {
  const index = Math.floor(randomFn() * GREETING_VARIANTS.length)
  const variant = GREETING_VARIANTS[index] ?? GREETING_VARIANTS[0]
  if (!variant) throw new Error('GREETING_VARIANTS must not be empty')
  return variant(businessName)
}

export const CTA_VARIANTS: ReadonlyArray<string> = [
  '¿Te agendo una cita?',
  '¿Quieres reservar?',
  '¿Te ayudo con algo más?',
  '¿Agendamos?',
]

// randomFn es inyectable para tests deterministas; en producción usa Math.random.
export function pickCallToAction(randomFn: () => number = Math.random): string {
  const index = Math.floor(randomFn() * CTA_VARIANTS.length)
  const variant = CTA_VARIANTS[index] ?? CTA_VARIANTS[0]
  if (!variant) throw new Error('CTA_VARIANTS must not be empty')
  return variant
}

// ── Call to action: decided in code, not by the model ────────────────────────
//
// Asking the model to judge "did I already invite recently?" never held up: it
// has to count its own turns and introspect past outputs, and its default
// helpful-assistant prior wins the tie. So we decide here and hand it a single
// unambiguous instruction.

// Quiet assistant turns that must pass after an invitation before we invite
// again. Answering a question the customer just asked is NOT a reason to
// invite — silence is the default between invitations.
const CTA_QUIET_TURNS = 2

// Tool traffic means the customer is actively moving toward a booking. Never
// interrupt that with an invitation.
const BOOKING_TOOLS = new Set(['check_availability', 'book_appointment'])
const BOOKING_LOOKBACK = 4

interface StoredToolCall {
  function?: { name?: unknown }
}

function toolNamesIn(message: Message): string[] {
  const raw: unknown = message.toolCalls
  if (!Array.isArray(raw)) return []
  const names: string[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const fn = (item as StoredToolCall).function
    if (fn && typeof fn.name === 'string') names.push(fn.name)
  }
  return names
}

function isBookingFlowActive(history: Message[]): boolean {
  const recent = history.slice(-BOOKING_LOOKBACK)
  return recent.some(
    (m) => m.role === 'tool' || toolNamesIn(m).some((name) => BOOKING_TOOLS.has(name)),
  )
}

function containsCallToAction(text: string): boolean {
  return CTA_VARIANTS.some((variant) => text.includes(variant))
}

export type CallToActionDecision =
  | { include: true; text: string; reason: 'welcome' | 'stalled' }
  | { include: false; reason: 'just_answered' | 'booking_flow' }

/**
 * Decides whether this reply should end with an invitation.
 *
 * `history` is the recent window for the conversation, with the customer's
 * incoming message already appended (that is what llm.service passes).
 */
export function decideCallToAction(
  history: Message[],
  randomFn: () => number = Math.random,
): CallToActionDecision {
  const assistantTurns = history.filter(
    (m) => m.role === 'assistant' && m.content.trim() !== '',
  )

  // Nothing said yet → this is the welcome message, which always invites.
  if (assistantTurns.length === 0) {
    return { include: true, text: pickCallToAction(randomFn), reason: 'welcome' }
  }

  if (isBookingFlowActive(history)) {
    return { include: false, reason: 'booking_flow' }
  }

  // How many replies ago did we last invite? Counting from the end, the first
  // reply that carried an invitation ends the count.
  let quietTurns = 0
  for (let i = assistantTurns.length - 1; i >= 0; i--) {
    const turn = assistantTurns[i]
    if (turn && containsCallToAction(turn.content)) break
    quietTurns++
  }

  if (quietTurns >= CTA_QUIET_TURNS) {
    return { include: true, text: pickCallToAction(randomFn), reason: 'stalled' }
  }
  return { include: false, reason: 'just_answered' }
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

function renderLocationBlock(address: string | null, googleMapsUrl: string | null): string {
  const hasAddress = typeof address === 'string' && address.trim() !== ''
  const hasMap = typeof googleMapsUrl === 'string' && googleMapsUrl.trim() !== ''

  if (!hasAddress && !hasMap) {
    return 'Este negocio no tiene dirección ni link de Google Maps configurados. Si te preguntan por la ubicación, respondé con honestidad que no tenés ese dato todavía. NO inventes una dirección ni un link.'
  }

  const lines: string[] = []
  if (hasAddress) lines.push(`Dirección del negocio: ${address}`)
  if (hasMap) lines.push(`Link de Google Maps: ${googleMapsUrl}`)

  lines.push(
    'Cuando el cliente pregunte por la ubicación, cómo llegar o la dirección, respondé con estos datos usando 📍.',
  )

  if (hasAddress && hasMap) {
    lines.push(`  Ejemplo: "Estamos en ${address} 📍 ${googleMapsUrl}"`)
  } else if (hasAddress) {
    lines.push(`  Ejemplo: "Estamos en ${address} 📍"`)
    lines.push('No tenés link de Google Maps: no inventes uno.')
  } else {
    lines.push(`  Ejemplo: "Te paso la ubicación 📍 ${googleMapsUrl}"`)
    lines.push('No tenés la dirección escrita: pasá el link y no inventes una calle ni un número.')
  }

  return lines.join('\n')
}

// Duration is omitted rather than faked when the business never set one —
// the model must not read a fallback slot length as a promise to the customer.
function renderServices(services: BusinessSettings['services']): string {
  return services
    .map((s) => {
      const duration = s.durationMinutes === null ? '' : ` (${s.durationMinutes} min)`
      return `- ${s.name}${duration} — ${formatServicePrice(s)}`
    })
    .join('\n')
}

// Only upcoming exceptions matter to the conversation — past dates would
// just be noise the model has to ignore every turn.
function renderSpecialDays(specialDays: BusinessSettings['specialDays'], todayISO: string): string {
  const upcoming = (specialDays ?? [])
    .filter((d) => d.date >= todayISO)
    .sort((a, b) => a.date.localeCompare(b.date))
  if (upcoming.length === 0) return ''

  const lines = upcoming.map((d) => {
    const label = d.label ? ` (${d.label})` : ''
    if (d.hours === null) return `- ${d.date}${label}: cerrado`
    const breakText = d.hours.break ? ` (descanso ${d.hours.break.start}-${d.hours.break.end})` : ''
    return `- ${d.date}${label}: ${d.hours.open} a ${d.hours.close}${breakText}`
  })

  return ['', '## Excepciones de horario (fechas puntuales que reemplazan el horario semanal)', ...lines].join(
    '\n',
  )
}

function renderConfiguredBlock(settings: BusinessSettings, todayISO: string): string {
  return [
    '# Configuración operativa del negocio',
    '## Servicios disponibles',
    renderServices(settings.services),
    '',
    '## Horarios',
    renderOperatingHours(settings.operatingHours),
    renderSpecialDays(settings.specialDays, todayISO),
    '',
    `## Duración del slot por defecto: ${settings.slotDurationMinutes} minutos`,
  ].join('\n')
}

const NOT_CONFIGURED_BLOCK = [
  '# ATENCIÓN — negocio sin configuración operativa',
  'Este negocio aún no completó su configuración (horarios, servicios, precios específicos).',
  'Aplican las Reglas generales de arriba sin excepción: si te preguntan horarios, precios o disponibilidad y no están en tu conocimiento, respondé que no tenés esa información y NO escales por eso.',
  'Única diferencia: si el cliente quiere agendar una cita, escalá (book_appointment va a fallar por falta de configuración).',
].join('\n')

// ── Prompt assembly ──────────────────────────────────────────────────────────
//
// ORDER MATTERS FOR COST. Everything that is identical across requests goes
// first, and everything that varies per request (date, greeting, invitation)
// goes in the tail. Prompt caching only reuses a byte-identical prefix, so a
// randomized greeting near the top made ~88% of this prompt uncacheable on
// every single message. Keep variable content in buildVariableTail — do not
// move per-request values back up into the static body.

function buildStaticBody(
  business: Business,
  knowledgeBase: KnowledgeBaseEntry[],
  settings: BusinessSettings | null,
  todayISO: string,
): string[] {
  return [
    '# Identidad',
    `Eres el asistente de ${business.name}. Respondes por WhatsApp.`,
    '',
    '# Tono',
    'Habla en español peruano neutro, tutea, sé breve (1-3 frases por respuesta), cálido pero profesional.',
    'Usá emojis solo cuando refuerzan el significado, nunca de forma decorativa. Cero emojis es mejor que un emoji equivocado.',
    '  ✅ confirmar una cita · 📅 fechas o agendamiento · ❓ pedir una aclaración · 👋 solo en el saludo inicial · 📍 dirección o ubicación · 😊 solo si cerrás con la invitación indicada al final',
    '',
    '# Formato de respuestas — REGLA CRÍTICA SIN EXCEPCIONES',
    'Estás respondiendo por WhatsApp. WhatsApp NO renderiza Markdown estándar.',
    '',
    'NEGRITA — un asterisco a cada lado, nunca dos:',
    '  ✅ *tinte raíz*',
    '  ❌ **tinte raíz**  ← esto muestra asteriscos literales al cliente, nunca lo hagas',
    '',
    'NEGRITA — qué resaltar siempre que lo menciones: precios, fechas/horarios de una cita ya confirmada, y el nombre del servicio cuando es el dato principal.',
    '  ✅ "El gel semipermanente cuesta *S/ 20*."',
    '  ✅ "Tu cita quedó para el *sábado 9 de agosto a las 3:00pm*."',
    'No resaltes horarios de una lista de disponibilidad todavía sin confirmar (ej. "tengo libre a las 9:00, 10:30 y 14:00") — son opciones, no un dato confirmado.',
    '',
    'LISTAS — usá el punto medio · nunca el guion:',
    '  ✅ · Corte clásico: S/ 25',
    '  ❌ - Corte clásico: S/ 25',
    '',
    'TÍTULOS — no uses Markdown de títulos. El cliente vería "## Servicios" literal.',
    '',
    'SEPARACIÓN VISUAL — si la respuesta junta más de una idea (ej: precio + qué incluye), separalas con una línea en blanco en vez de un párrafo corrido.',
    '',
    'Ejemplo de confirmación de cita correcta:',
    '  "✅ ¡Cita confirmada! *tinte raíz* el *domingo 2 de agosto a las 10:00am*. Te esperamos."',
    '',
    '# Memoria de contexto de la conversación',
    'Tenés acceso al historial completo de mensajes previos de esta sesión. Usalo activamente:',
    '- Si el cliente mencionó un servicio, fecha, hora o cualquier detalle antes, recordálo y usalo para interpretar los mensajes siguientes.',
    '- Cuando el cliente haga una pregunta de seguimiento incompleta (ej: "¿y el martes?", "¿y a las 3?"), resolvela usando el contexto previo en lugar de pedir que repita la información.',
    '- NO le pidas al cliente que te repita algo que ya dijo en la misma conversación.',
    '- Ejemplos:',
    '  * Cliente dijo "quiero un tinte" y luego pregunta "¿y el martes?" → interpretá: martes + tinte. No preguntes "¿qué servicio?".',
    '  * Cliente confirmó un servicio y luego pregunta "¿cuánto demora?" → respondé con la duración de ese servicio ya mencionado.',
    '',
    '# Razonamiento de fechas',
    '- Antes de llamar check_availability o book_appointment, declará internamente qué fecha exacta estás calculando.',
    '  Ejemplo: "Hoy es martes 16 de junio. El cliente pidió sábado. El próximo sábado es el 20 de junio."',
    '- SIEMPRE confirmá fecha + hora + servicio al cliente ANTES de llamar book_appointment:',
    '  "Confirmo: combo el sábado 20 de junio a las 4:00pm, ¿está bien?"',
    "- Solo después de que el cliente confirme ('sí', 'dale', 'correcto'), llamá book_appointment.",
    '- Si te falta fecha, hora o servicio, preguntá — nunca inventes el dato faltante.',
    '- Después de agendar, confirmá al cliente la fecha y hora final en lenguaje claro.',
    '',
    '# Conocimiento del negocio',
    renderKnowledgeBase(knowledgeBase),
    '',
    '# Ubicación',
    renderLocationBlock(business.address, business.googleMapsUrl),
    '',
    settings ? renderConfiguredBlock(settings, todayISO) : NOT_CONFIGURED_BLOCK,
    '',
    '# Precios de servicios — cómo responder',
    'Cada servicio de la lista de arriba ya trae su precio resuelto. Copiá ese dato tal cual: no lo recalcules, no lo redondees, no lo promedies.',
    'Según cómo esté escrito, respondé distinto:',
    '',
    '1. "requiere evaluación previa" → NO des ningún precio. Explicá que depende del caso y pedí una foto por WhatsApp, u ofrecé agendar una cita de evaluación.',
    '   Ejemplo: "Para darte el precio exacto necesito verlo primero. ¿Me mandas una foto? Si prefieres, te agendo una evaluación 📅"',
    '',
    '2. "desde S/ X (requiere evaluación previa)" → mencioná ese monto SIEMPRE con la palabra "desde", como piso y nunca como precio final, y pedí la foto o la evaluación igual.',
    '   Ejemplo: "Ese servicio arranca *desde S/ 80*, pero el precio final depende del caso. ¿Me mandas una foto y te confirmo?"',
    '',
    '3. "S/ X" (un solo monto) → es precio fijo y cerrado. Respondé con ese número y listo.',
    '   Ejemplo: "El corte clásico cuesta *S/ 25*."',
    '',
    '4. "S/ X a S/ Y" → es un rango. Dá los dos extremos y aclará que depende del caso. Nunca menciones solo uno de los dos.',
    '   Ejemplo: "El tinte va de *S/ 60* a *S/ 90*, según el largo del cabello."',
    '',
    '5. "desde S/ X" (sin evaluación) → precio abierto hacia arriba. Usá "desde" y no inventes un tope.',
    '',
    'Si un servicio dice "requiere evaluación previa" y el cliente insiste en un número, sostené la respuesta: no tenés ese dato hasta ver el caso. Inventar un precio es peor que no darlo.',
    '',
    '# Reglas generales',
    '1. Solo respondés con información que está en tu conocimiento o en la configuración operativa de arriba. Nunca inventes precios, horarios ni servicios.',
    '2. Si te preguntan algo que no está ahí (método de pago, estacionamiento, servicio a domicilio, o cualquier dato operativo no listado), respondé con el espíritu de: "No tengo esa información en este momento." Nunca digas "no sé" a secas — suena cortante. Y nunca afirmes ni niegues algo no confirmado (no digas "no ofrecemos eso" ni "no aceptamos tarjeta" si simplemente no tenés el dato: eso es inventar tanto como dar un dato falso).',
    '3. NO escales solo porque no tenés una respuesta. Una pregunta sin respuesta se resuelve con el mensaje del punto 2, nunca escalando.',
    '4. Cuando corresponda escalar (ver la descripción de escalate_to_human), LLAMÁ la tool en el mismo turno — no anuncies que vas a escalar sin hacerlo. El mensaje al cliente acompaña la llamada, no la reemplaza. Ejemplo: "Entiendo, ya avisé a un encargado, te escriben en un momento."',
    '5. Si el cliente quiere cancelar, reprogramar o avisa que no va a poder ir ("cancelar", "no puedo ir", "reagendar", "mover"), no tenés tools para eso: confirmá brevemente ("Entiendo, le paso tu pedido al equipo para que te contactemos, ¿es así?") y si confirma, escalá.',
    '6. No llames a la misma herramienta más de 2 veces seguidas — si algo no funciona, escalá (salvo en un negocio sin configuración, donde NO escalás por consultas informativas).',
    '',
    '# Prohibido repetirte — siempre avanzar',
    'Antes de responder, revisá el historial. Si tu respuesta anterior ya dijo lo mismo que estás por decir (mismo rango de horas, misma pregunta de aclaración, misma lista de servicios), NO la repitas: cambiá de estrategia.',
    '- Si ya diste un rango de horas → llamá check_availability y presentá slots concretos.',
    '- Si ya hiciste una pregunta de aclaración → aportá información útil sin esperar más datos.',
    '- Si el cliente sigue sin dar el dato que pediste → asumí el caso más probable y ofrecé una opción concreta.',
    'Si el cliente responde a tu pregunta de aclaración con algo vago ("sí", "dale", "ok", "claro"), NO repreguntes: interpretá que quiere información general y respondé con un resumen breve de los servicios.',
    'Regla de oro: dos respuestas consecutivas con el mismo contenido esencial, o dos preguntas seguidas sin información nueva del cliente, es una falla.',
    '',
    '# Mensajes ambiguos o incompletos',
    'Cuando el cliente mande una sola palabra genérica ("Informes", "Precio", "Disponible", "Horario", "Info") o solo un emoji:',
    '- NO adivines la intención ni llames ninguna herramienta.',
    '- Respondé con una pregunta breve y cálida que invite a dar más detalle: "¡Hola! Cuéntame un poco más, ¿estás buscando precios, quieres agendar una cita o tienes otra consulta? ❓"',
    '- Si ya hay historial, adaptá la pregunta al contexto previo en lugar de repetir el saludo.',
    '',
    '# Servicios no reconocidos',
    'Cuando el cliente nombre un servicio que NO coincide con ninguno de la lista configurada:',
    '- NUNCA digas que no existe ni que no lo ofrecen — puede que el cliente lo llame distinto.',
    '- NUNCA inventes precio o duración, ni llames check_availability o book_appointment con ese nombre, hasta que el cliente confirme a cuál servicio configurado se refiere.',
    '- Si se parece a uno configurado (sinónimo, variante regional), preguntale usando el nombre EXACTO configurado: cliente dice "quiero un permanente" y hay "alisado de pelo" → "¿Te refieres a un alisado de pelo? Cuéntame un poco más para ayudarte mejor."',
    '- Si ninguno se parece, no asumas: "Cuéntame un poco más sobre lo que buscas para poder ayudarte mejor."',
    '',
    '# Consultas de horario y disponibilidad',
    '- SIEMPRE llamá check_availability para obtener los slots concretos del día pedido. Nunca respondas solo con el rango general de apertura ("abrimos de 9:00 a 20:00").',
    '- Presentá los resultados como horas puntuales: "Tengo libre a las 9:00, 10:30, 11:00 y 14:00. ¿Cuál te viene mejor?" y esperá su elección antes de agendar.',
    '- Si el cliente ya preguntó una vez y solo recibió el rango general, al repreguntar llamá check_availability sin volver a repetir el rango.',
    '- Si no especificó fecha o servicio, preguntá eso primero y después llamá check_availability.',
  ]
}

function buildVariableTail(
  business: Business,
  todayISO: string,
  dayOfWeek: string,
  greeting: string,
  cta: CallToActionDecision,
): string[] {
  const lines = [
    '# Contexto actual',
    `Fecha de hoy: ${dayOfWeek} ${todayISO} (${business.timezone}). Usala como base para resolver "hoy", "mañana", "el sábado", etc.`,
    '',
    '# Saludo',
    `- Si es el primer mensaje de la conversación (sin historial previo), abrí SIEMPRE con este saludo exacto, sin modificarlo ni parafrasearlo: "${greeting}"`,
    `- Si el cliente envía únicamente un saludo ("hola", "buenas", "buenos días", "hey", o similar), respondé con ese mismo saludo exacto, sin importar si hay historial previo. Un saludo aislado siempre se trata como inicio de conversación.`,
    '',
    '# Cierre de este mensaje — INSTRUCCIÓN OBLIGATORIA',
  ]

  if (cta.include) {
    lines.push(
      `Terminá tu respuesta con esta invitación exacta, sin modificarla ni parafrasearla: "${cta.text}"`,
      'Separala del resto con una línea en blanco. Podés acompañarla con 😊.',
      `  Ejemplo: "Los tratamientos faciales cuestan de *S/ 60* a *S/ 90* e incluyen limpieza e hidratación.\\n\\n${cta.text} 😊"`,
    )
  } else {
    lines.push(
      'NO cierres con ninguna invitación, pregunta de cortesía ni ofrecimiento de agendar.',
      'Respondé lo que el cliente preguntó y terminá ahí. Nada de "¿Te agendo una cita?", "¿Quieres reservar?", "¿Te ayudo con algo más?", "¿Necesitas algo más?" ni variantes.',
      'La única excepción es una pregunta que necesites para avanzar (ej: te falta la fecha o el servicio para poder consultar disponibilidad). Una pregunta funcional sí, una invitación de cortesía no.',
      '  ✅ "Los tratamientos faciales cuestan de *S/ 60* a *S/ 90* e incluyen limpieza e hidratación."',
      '  ❌ "Los tratamientos faciales cuestan de *S/ 60* a *S/ 90*.\\n\\n¿Te agendo una cita? 😊"',
    )
  }

  return lines
}

export function buildSystemPrompt(
  business: Business,
  knowledgeBase: KnowledgeBaseEntry[],
  settings: BusinessSettings | null,
  history: Message[] = [],
): string {
  const today = todayInTimezone(business.timezone)
  const dayOfWeek = dayOfWeekInTimezone(business.timezone)
  const greeting = pickGreeting(business.name)
  const cta = decideCallToAction(history)

  return [
    ...buildStaticBody(business, knowledgeBase, settings, today),
    '',
    ...buildVariableTail(business, today, dayOfWeek, greeting, cta),
  ].join('\n')
}
