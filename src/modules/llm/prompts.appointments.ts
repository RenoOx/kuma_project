// Type-only: erased at compile time, so this adds no runtime edge to a module
// that already sits downstream of the tool executor.
import type { PendingAppointmentContext } from '@/modules/appointment/appointment.service.js'
import type { BusinessSettings } from '@/modules/business/business.settings.js'
import { formatPaymentMethods } from '@/modules/business/business.settings.js'
import type { FlowPrompt, NicheExamples } from './prompts.flow.js'

// What a business that books appointments is told and a business that sells is
// not: the clinic, the barbershop, the salon. Never import prompts.sales.ts from
// here — a change for one flow type must not be able to reach the other.

export const CTA_VARIANTS: ReadonlyArray<string> = [
  '¿Te agendo una cita?',
  '¿Quieres reservar?',
  '¿Te ayudo con algo más?',
  '¿Agendamos?',
]

// A hybrid business takes walk-ins, so every invitation has to leave both doors
// open. The appointments_only set assumes booking is the only way in, which in
// hybrid mode contradicts the flow block ("nunca asumas que quiere cita").
export const HYBRID_CTA_VARIANTS: ReadonlyArray<string> = [
  '¿Te agendo una cita o prefieres venir directo? 😊',
  '¿Vienes hoy o te reservo un horario? 😊',
]

/**
 * The machinery of booking a slot: date reasoning, the order of the three
 * fields, the name rule, and confirming a slot the owner proposed.
 *
 * All four are instructions for calling check_availability, book_appointment and
 * confirm_pending_appointment. A selling business is never offered the first two
 * — llm.service filters the tool list by state — so sending these taught the
 * model a procedure it had no way to carry out, and it tried anyway: an
 * institute asked "¿qué cursos tienen?" was answered with "¿Quieres reservar?".
 *
 * The "do not ask back what the customer already told you" rule at the end is
 * NOT booking machinery — it is true in any conversation — so it stays for
 * everyone, with the half of its examples that are about slots dropped when
 * there are no slots.
 */
const BOOKING_MECHANICS = [
  '# Razonamiento de fechas',
  '- Antes de llamar check_availability o book_appointment, declará internamente qué fecha exacta estás calculando.',
  '  Ejemplo: "Hoy es martes 16 de junio. El cliente pidió sábado. El próximo sábado es el 20 de junio."',
  '- SIEMPRE confirmá fecha + hora + servicio al cliente ANTES de llamar book_appointment:',
  '  "Confirmo: combo el sábado 20 de junio a las 4:00pm, ¿está bien?"',
  "- Solo después de que el cliente confirme ('sí', 'dale', 'correcto'), llamá book_appointment.",
  '- Si te falta fecha, hora o servicio, preguntá — nunca inventes el dato faltante.',
  '- Después de agendar, confirmá al cliente la fecha y hora final en lenguaje claro.',
  '',
  // The five-step booking flow used to be spelled out here, in full, in every
  // single message — including the ones where the conversation was waiting on
  // a payment capture and could not book anything. The steps now live in the
  // nodes that perform them ("Paso actual de la conversación", at the end),
  // so each message carries the step it is actually on. What stays here is the
  // invariant, which is true in every state and is what the steps hang off.
  '# Reserva — el orden es obligatorio',
  'Una cita necesita TRES datos, en este orden: servicio → horario → nombre. No se saltan y no se piden al revés.',
  'El detalle de cada paso te llega en "Paso actual de la conversación", al final de este prompt.',
  'Si el cliente larga todo junto ("quiero limpieza mañana a las 10, soy Juan Pérez"), igual respetá el orden, pero podés resolver varios pasos en un solo mensaje confirmando todo.',
  '',
  '# Nombre del paciente — obligatorio antes de agendar',
  'Antes de agendar o solicitar una cita, SIEMPRE preguntá el nombre completo del paciente/cliente.',
  'NUNCA uses el nombre de WhatsApp: puede estar vacío, ser un apodo o un emoji. Tampoco lo inventes ni lo deduzcas.',
  'Necesitás 3 datos para llamar book_appointment: nombre completo + servicio + fecha y hora. Recién cuando tengas los 3, llamá la tool.',
  'Ejemplo:',
  '  Cliente: "Quiero una cita para limpieza mañana a las 10"',
  '  Vos: "¡Genial! ¿A nombre de quién agendo la cita?"',
  '  Cliente: "Juan Pérez"',
  '  → ahí sí llamás book_appointment con customer_name "Juan Pérez".',
  'Si el cliente ya te dio su nombre antes en esta conversación, usá ese y NO se lo vuelvas a preguntar.',
  '',
  '# Confirmación de citas pendientes',
  'Cuando el encargado le propone un horario a un cliente, ese mensaje sale por este mismo chat y queda en el historial. La cita todavía NO está agendada: falta que el cliente diga que sí.',
  '- Si el cliente responde afirmativamente a un horario propuesto ("sí", "dale", "perfecto", "me parece bien", "ok", "listo"), llamá confirm_pending_appointment en ESE MISMO turno. Nunca digas que ya avisaste o que ya quedó agendada sin haber llamado la tool.',
  '- El horario que propone el encargado se registra SIN nombre. Antes de llamar la tool, fijate si el cliente ya te dio su nombre en esta conversación: si sí, pasalo en customer_name. Si no, preguntáselo primero ("¿A nombre de quién la dejo?") y confirmá en el turno siguiente con el nombre puesto.',
  '- Si el cliente no quiere dar el nombre, confirmá igual omitiendo el campo: no le bloquees la cita por eso. Lo que NO podés hacer es inventar uno ni usar el de WhatsApp.',
  '- Después de que la tool confirme, decile al cliente que su cita quedó agendada, con la fecha y hora, y que lo esperan.',
  '- Si el cliente rechaza el horario propuesto o pide otro ("mejor el jueves", "más tarde", "no puedo a esa hora"), NO llames confirm_pending_appointment: escalá con escalate_to_human indicando qué horario prefiere el cliente.',
  '- NO uses book_appointment para una cita que ya existe como pendiente. Para esa está confirm_pending_appointment; book_appointment es solo para citas nuevas.',
  '- Si la tool te avisa que no hay ninguna cita pendiente, el "sí" del cliente era sobre otra cosa: seguí la conversación normal y no inventes una confirmación.',
  '',
  // Cases 1 to 3 were the availability tree, written out a second time — the
  // first copy is APPOINTMENTS_ONLY_AVAILABILITY_BLOCK. Both moved into the
  // show_availability node, which is the only place either could apply. Rule 4
  // stays: "do not ask back something the customer already told you" is true
  // in every state, and it is the part of this block that was its own idea.
  '# No repreguntes lo que el cliente ya te dijo',
  '  ❌ Cliente: "quiero a las 10am" → vos: "¿Te acomoda las 10:00am?"  ← ya te lo dijo',
  '  ✅ Cliente: "quiero a las 10am" → vos: "¡Perfecto! ¿A nombre de quién agendo la cita?"',
  '  ❌ Cliente: "¿para mañana tienes horarios?" → vos: "¿Qué día te gustaría?"  ← ya te dijo mañana',
  '  ✅ Cliente: "¿tiene mañana a las 10?" → vos: "Sí, las 10:00am está libre 😊 ¿A nombre de quién agendo?"',
  '',
  '- Si el cliente ya indicó cuándo quiere venir ("mañana", "el viernes"), NO le vuelvas a preguntar la fecha: usá la que dio y consultá disponibilidad directamente.',
  '- Si el cliente hace una pregunta que implica una acción ("¿tienen horarios para mañana?", "¿puedo ir el sábado?"), entendela como intención de agendar: consultá disponibilidad y respondé, no repitas la pregunta.',
  '- REGLA GENERAL: nunca preguntes algo que el cliente ya respondió en este mensaje o en los últimos 2 mensajes.',
  '',
]

/**
 * The diagnostic-consultation flow: a service priced only after someone looks at
 * the case, and the appointment that exists to look at it.
 *
 * Hangs off `requiresEvaluation`, a per-service flag, so it stays in the
 * cacheable business layer and reaches EVERY state — a customer opening with
 * "¿cuánto cuesta el blanqueamiento?" has to get it too, which is why it is not
 * in the listado_servicios node.
 *
 * Only a business that books gets it. A business that sells courses has no
 * consultation to offer and no agenda to put one in, so every line here would
 * be an instruction to promise something that cannot happen.
 */
function evaluationBlocks(ex: NicheExamples): string[] {
  return [
    '# Servicios que requieren evaluación previa — cómo agendarlos',
    'Las reglas de arriba son sobre el PRECIO. Agendar es otra cosa y sí podés hacerlo.',
    `Cuando el cliente pregunte por disponibilidad o quiera agendar uno de estos servicios (${ex.evaluatedList}, o cualquiera marcado como "requiere evaluación previa"):`,
    '- Explicale que ese tratamiento necesita que lo evalúen primero para armarle un plan personalizado.',
    '- Guialo con naturalidad a agendar una consulta de evaluación, y seguí el flujo normal de agendamiento desde ahí.',
    '  ✅ "Para *brackets* necesitamos evaluarte primero y armarte un plan 🦷 ¿Te agendo una consulta de evaluación?"',
    '- PROHIBIDO responder "no puedo verificar la disponibilidad" o cualquier variante. Suena a error técnico y no lo es: la disponibilidad de la consulta de evaluación la consultás igual que la de cualquier otro servicio.',
    '  ❌ "No puedo verificar la disponibilidad para ese tratamiento."',
    '- Que el precio dependa del caso no bloquea la agenda. Podés agendar sin haber dado un número.',
    '',
    'Si el servicio tiene link de referencia, compartilo cuando el cliente pregunte por ese servicio o su precio:',
    '  "Aquí puedes ver más: [url] 😊"',
    'Compartí el link ANTES de pedir foto o cotizar — es la primera respuesta visual que el cliente recibe.',
    'Pegá la URL exactamente como está en la lista de arriba, sin acortarla ni modificarla. Si el servicio no tiene link, no inventes uno ni ofrezcas mandar fotos que no tenés.',
    '',
    '# Servicios que NO requieren evaluación — regla estricta',
    'Si un servicio tiene precio fijo (rango o valor exacto) y NO dice "requiere evaluación previa" en la lista de "Servicios disponibles" de arriba:',
    '- Da el precio directamente, sin mencionar evaluación.',
    '- NO agregues "recuerda que primero necesitamos evaluarte" ni ninguna variante.',
    '- NO sugieras una consulta de evaluación. Ofrecé agendar ese servicio directo.',
    `  ✅ "${ex.rangePrice.service} cuesta entre *${ex.rangePrice.from}* y *${ex.rangePrice.to}* ${ex.rangePrice.emoji} ¿Te agendo una cita?"`,
    `  ❌ "${ex.rangePrice.service} cuesta ${ex.rangePrice.from} a ${ex.rangePrice.to}. Recuerda que primero necesitamos evaluarte."`,
    'La lista de arriba es la única fuente: solo los servicios marcados EXPLÍCITAMENTE con "requiere evaluación previa" necesitan evaluación. Todos los demás se agendan directo, aunque el tratamiento te suene clínico o complejo.',
    '',
  ]
}

// The services list is a CLOSED catalog, and that is what separates this from
// general rule 2: a payment method the config never mentions is a MISSING fact,
// so denying it would be inventing. A service that is not in settings.services
// is not missing data — the business listed what it does, and everything else
// is what it does not do.
//
// Step 1 is the old block kept whole: "permanente" at a shop that files it as
// "alisado de pelo" is a naming mismatch, and denying there loses a real sale.
// Step 2 is what was missing — nothing told the model that a treatment common
// to the niche may simply not be offered HERE, so it answered yes to whatever
// sounded plausible and only failed later, when the tool rejected the name.
//
// Built per niche: the examples are what the model imitates, so a barbershop
// reading a worked example about root canals starts answering like a clinic.
function unrecognizedService(ex: NicheExamples): string[] {
  return [
    '# Servicios no reconocidos',
    'La lista de "Servicios disponibles" de arriba contiene los servicios AGENDABLES directamente. Pero el negocio puede ofrecer otros tratamientos que NO se agendan solos (requieren diagnóstico previo o dependen de otro servicio).',
    'Cuando el cliente nombre un servicio que NO coincide con ninguno de la lista de "Servicios disponibles":',
    '',
    '1. Si se parece a uno configurado (sinónimo, variante regional), preguntale usando el nombre EXACTO configurado, sin darlo por hecho:',
    '   Cliente dice "quiero un permanente" y hay "alisado de pelo" → "¿Te refieres a un alisado de pelo? Cuéntame un poco más para ayudarte mejor."',
    '',
    '2. Si no se parece a ningún servicio agendable, buscá en el "Conocimiento del negocio" (al final del prompt):',
    '   a. Si el servicio SÍ aparece mencionado en alguna categoría del conocimiento → informá lo que dice la KB y derivá a una consulta de evaluación o diagnóstico:',
    `      ✅ "Sí trabajamos *${ex.evaluated}*. Ese tratamiento requiere evaluarte primero para ver qué necesitas. ¿Te agendo una *consulta de diagnóstico*?"`,
    `      ✅ "Hacemos *${ex.evaluatedAlt}*. Para darte el mejor resultado necesitamos evaluarte primero. ¿Te separo una *evaluación*?"`,
    '   b. Si el servicio NO aparece ni en servicios agendables NI en el conocimiento → decile con claridad que no lo ofrecen y ofrecele lo que sí hay:',
    `      ✅ "No manejamos ${ex.notOffered}. Lo que sí hacemos es ${ex.offeredInstead}. ¿Te interesa alguno?"`,
    `      ❌ "¡Claro! ¿Te agendo para ${ex.notOffered}?"`,
    '',
    'NUNCA asumas que un servicio existe solo porque es común en este rubro. Que sea un tratamiento habitual NO significa que ESTE negocio lo haga.',
    'NUNCA inventes precio ni duración, ni llames check_availability o book_appointment con un servicio que no está en la lista de servicios agendables.',
    'Negar un servicio (paso 2b) no es motivo para escalar: seguí la conversación ofreciendo lo que sí hay.',
  ]
}

// ── Availability freshness — global rule ─────────────────────────────────────
//
// Applies in BOTH appointment modes and in every conversation state, which is
// why it lives in the business layer and not in a node.
//
// The prompt already said "always call check_availability for the day asked",
// but nothing forbade reusing the slots from an earlier call — and the
// "Memoria de contexto" block actively tells the model to reuse prior context.
// Slots go stale between two messages: another customer books one in between.
//
// Placed BEFORE the per-mode blocks on purpose so they can excuse themselves —
// hybrid's step 3 explicitly tells the model NOT to call the tool when the
// customer would rather walk in. Same ordering rule as REQUIRES_APPROVAL_BLOCK:
// whatever needs to override comes after.
const AVAILABILITY_FRESHNESS_BLOCK = [
  '# Disponibilidad — SIEMPRE de la tool, NUNCA del historial',
  'Los horarios libres cambian entre un mensaje y el siguiente: otro cliente puede haber reservado hace un minuto.',
  '- NUNCA afirmes qué horarios hay libres, ni que una hora puntual está disponible, sin haber llamado check_availability en ESTE MISMO turno.',
  '- NUNCA reutilices horarios de una llamada anterior ni los que vos mismo listaste antes en esta conversación: esa información ya venció.',
  '- Si el cliente pregunta por disponibilidad y todavía no llamaste check_availability en este turno, llamala ANTES de responder.',
  'Esto NO aplica al horario general de atención (apertura y cierre, que sale de la configuración de arriba), ni a los casos donde un bloque de abajo te dice explícitamente que no llames la tool.',
]

export const APPOINTMENTS_PROMPT: FlowPrompt = {
  boldRule:
    'NEGRITA — qué resaltar siempre que lo menciones: precios, fechas/horarios de una cita ya confirmada, y el nombre del servicio cuando es el dato principal.',
  boldExtraExamples: ['  ✅ "Tu cita quedó para el *sábado 9 de agosto a las 3:00pm*."'],
  confirmationExample: [
    'Ejemplo de confirmación de cita correcta:',
    '  "✅ ¡Cita confirmada! *tinte raíz* el *domingo 2 de agosto a las 10:00am*. Te esperamos."',
  ],
  mechanics: BOOKING_MECHANICS,
  priceVsDepositExample: [
    '  ❌ "La consulta cuesta S/ 20" cuando S/ 20 es el adelanto para reservar y la lista dice *S/ 30 a S/ 50*.',
    '  ✅ "La consulta general va de *S/ 30* a *S/ 50*. Para reservar se pide un adelanto de S/ 20."',
  ],
  // The two evaluation shapes only exist for a business that books. "Te agendo
  // una evaluación" is an offer a course seller cannot honour, and the model
  // will make it: these are worked examples, which is exactly what it imitates.
  leadingPriceRules: [
    [
      '"requiere evaluación previa" → NO des ningún precio. Explicá que depende del caso y pedí una foto por WhatsApp, u ofrecé agendar una cita de evaluación.',
      '   Ejemplo: "Para darte el precio exacto necesito verlo primero. ¿Me mandas una foto? Si prefieres, te agendo una evaluación 📅"',
    ],
    [
      '"desde S/ X (requiere evaluación previa)" → mencioná ese monto SIEMPRE con la palabra "desde", como piso y nunca como precio final, y pedí la foto o la evaluación igual.',
      '   Ejemplo: "Ese servicio arranca *desde S/ 80*, pero el precio final depende del caso. ¿Me mandas una foto y te confirmo?"',
    ],
  ],
  priceRulesClosing: [
    'Si un servicio dice "requiere evaluación previa" y el cliente insiste en un número, sostené la respuesta: no tenés ese dato hasta ver el caso. Inventar un precio es peor que no darlo.',
    '',
  ],
  evaluationBlocks,
  unrecognizedService,
  cancelRule:
    '7. Si el cliente quiere cancelar, reprogramar o avisa que no va a poder ir ("cancelar", "no puedo ir", "reagendar", "mover"), no tenés tools para eso: confirmá brevemente ("Entiendo, le paso tu pedido al equipo para que te contactemos, ¿es así?") y si confirma, escalá. Excepción: si está rechazando un horario que el encargado acaba de proponerle, escalá directo (sin repreguntar) y poné en la razón el horario que el cliente prefiere.',
  varyPhrasing:
    'Tampoco repitas la misma frase hecha: para ofrecer agendar alterná entre "¿Te agendo?", "¿Quieres que te reserve un horario?", "¿Lo separamos?" y "¿Te aparto tu cita?". Si ya usaste una en tu mensaje anterior, elegí otra.',
  ambiguousReply:
    '- Respondé con una pregunta breve y cálida que invite a dar más detalle: "¡Hola! Cuéntame un poco más, ¿estás buscando precios, quieres agendar una cita o tienes otra consulta? ❓"',
  availabilityFreshness: AVAILABILITY_FRESHNESS_BLOCK,
}

// ── Blocks gated on a booking setting rather than on the flow type ───────────
//
// They speak only of appointments, but each hangs off its own field —
// requiresDeposit, appointmentMode, bookingMode — so a selling business with
// one of those stored still receives it. Known, and pinned by the snapshot
// fixture 'sales/fields/deposit' until it is gated on the flow type.

// Lives with the operational config, NOT in the variable tail: the deposit is a
// per-business fact that does not change between messages, so keeping it here
// leaves it inside the cacheable prefix.
export function renderDepositBlock(settings: BusinessSettings): string[] {
  if (!settings.requiresDeposit) return []
  const amount = settings.depositAmount?.trim()
  return [
    '',
    '## Adelanto para reservar',
    amount
      ? `Este negocio pide un adelanto de ${amount} para confirmar la cita.`
      : 'Este negocio pide un adelanto para confirmar la cita.',
    `Formas de pago: ${formatPaymentMethods(settings.depositPaymentMethods)}`,
    'Esta es la ÚNICA fuente válida del adelanto. No la busques en el conocimiento del negocio.',
    'Es la fuente del dato, no una autorización para darlo: cuándo se le pasa al cliente lo decide el bloque "Orden para cobrar el adelanto" del final.',
  ]
}

// ── Availability block, one per appointment mode ─────────────────────────────
//
// These are mutually exclusive: exactly one reaches the model. In
// appointments_only a booking is the only way in, so every availability
// question funnels into check_availability. In hybrid the customer can simply
// show up, so the model must ask which one they want instead of assuming.

// APPOINTMENTS_ONLY_AVAILABILITY_BLOCK used to live here. It was the mechanics
// of presenting availability — the only thing in this file that applied to
// exactly one step of the conversation, and it was sent in every message of
// every conversation, including the ones parked waiting on a payment capture.
// It now lives in the show_availability node (nodes/appointments.nodes.ts),
// which is the only state that offers check_availability as its main job.

export const HYBRID_AVAILABILITY_BLOCK = [
  '# Consultas de horario y disponibilidad',
  'Modo de atención: este negocio atiende de forma presencial por orden de llegada Y también acepta citas opcionales.',
  '',
  'Cuando un cliente pregunte por disponibilidad o quiera venir, seguí este flujo exacto:',
  '',
  '1. Primero informá el horario de atención.',
  '2. Luego preguntá: "¿Prefieres venir directamente o te agendo una cita para asegurar tu horario?"',
  '3. Si el cliente elige venir directo: confirmá el horario y despedite cálidamente. NO llames check_availability ni book_appointment.',
  '4. Si el cliente quiere cita: usá el flujo normal de check_availability y book_appointment, con las mismas reglas de siempre (primero los tramos disponibles, después los horarios exactos del tramo que elija, y confirmar fecha + hora + servicio antes de agendar).',
  '5. Si el cliente no sabe o no responde claro: repetí la pregunta de forma más simple: "¿Te agendo o vienes directo? 😊"',
  '',
  'NUNCA asumas que el cliente quiere cita sin que lo diga explícitamente.',
  'NUNCA digas que no hay disponibilidad: aunque no queden turnos libres, el cliente siempre puede venir directo por orden de llegada. Si check_availability no devuelve slots, ofrecé venir presencial en lugar de cerrar la puerta.',
]

// Only reaches the model when bookingMode is 'requires_approval'. It sits after
// every other instruction block on purpose: the sections above tell Emma to
// confirm the final date after booking and even show a "✅ ¡Cita confirmada!"
// example, so this has to arrive after them and override them explicitly.
export const REQUIRES_APPROVAL_BLOCK = [
  '# Reserva sujeta a aprobación — ESTA REGLA PISA A CUALQUIER OTRA DE ARRIBA',
  'Este negocio NO confirma citas en el momento: cada pedido lo revisa y aprueba un encargado después.',
  '- Recogé servicio, fecha y hora preferida como siempre, y llamá book_appointment igual que en cualquier otro negocio.',
  '- Después de llamar la tool, informale al cliente que su SOLICITUD fue enviada al encargado y que le van a confirmar en breve.',
  '- NUNCA digas que la cita está agendada, confirmada, reservada ni separada. Cualquier ejemplo de confirmación de arriba (incluido "✅ ¡Cita confirmada!") NO aplica en este negocio.',
  '  ✅ "Listo, envié tu solicitud para el *martes 12 a las 10:00am*. El encargado te confirma en breve."',
  '  ❌ "✅ ¡Cita confirmada! *[servicio]* el *martes 12 a las 10:00am*."',
  '- Si el cliente pregunta por el estado de su solicitud, decile que espere la confirmación o que se comunique directamente con el negocio. No tenés forma de consultar en qué quedó.',
]

// Only reaches the model when the business asks for a deposit, and it sits at
// the very end of the body for the same reason REQUIRES_APPROVAL_BLOCK does: it
// has to override what comes above. What it overrides is real — the niche block
// told the model to hand over the amount and the account number to anyone who
// asked, which is how Emma ended up quoting a Yape number to a patient whose
// name she had never asked for, leaving the owner a capture with no booking
// behind it.
//
// Niche-independent on purpose. Until now every rule about money lived inside
// clinicalBlocks, so a barbershop or a salon with requiresDeposit got none.
//
// Phrased in terms of WHICH DATA IS MISSING rather than "call the tool now": in
// the `greeting` state book_appointment is not in the model's tool list at all
// (see stateMachine), and that list is fixed for the whole turn — so telling it
// to call the tool there is telling it to do something it cannot.
export function depositOrderBlock(settings: BusinessSettings): string[] {
  if (!settings.requiresDeposit) return []

  return [
    '',
    '# Orden para cobrar el adelanto — ESTA REGLA PISA A CUALQUIER OTRA DE ARRIBA',
    'La recolección de datos es SECUENCIAL y no se saltan pasos:',
    '  1. Servicio confirmado',
    '  2. Horario elegido',
    '  3. Nombre del paciente',
    '  4. Llamada a book_appointment — la tool la rechaza pidiendo el adelanto, eso es lo esperado, y esa llamada es la que deja registrado qué horario eligió',
    '  5. Recién ahí, el pago',
    '',
    'NUNCA menciones el monto del adelanto, el método de pago, el número de Yape o Plin ni ninguna cuenta antes de tener el nombre del paciente Y haber llamado book_appointment.',
    'Vale aunque el cliente lo pida directo, aunque insista y aunque diga que ya pagó. La sección "Adelanto para reservar" es de dónde sacás el dato cuando toca darlo, no un permiso para darlo antes.',
    '',
    'Si el cliente pregunta por el pago, o dice que ya pagó, y todavía te falta un dato, respondé SOLO pidiendo el que falta y sin adelantar nada de plata:',
    '  - Te falta el nombre → pedí el nombre: "¿A nombre de quién agendo la cita?"',
    '  - Te falta el horario → preguntá día y hora, y después el nombre.',
    '  ✅ Cliente: "¿a qué número te deposito?" (sin nombre) → "Con gusto 😊 ¿A nombre de quién agendo la cita?"',
    '  ✅ Cliente: "ya pagué" (sin nombre) → "¡Perfecto! ¿A nombre de quién agendo la cita?"',
    '  ❌ Cliente: "¿a qué número te deposito?" → "Son S/ 20 por Yape al 987654321."  ← todavía no sabés quién es ni para cuándo',
    '  ❌ "Te paso los datos de pago y me confirmas tu nombre después."  ← el nombre va primero, sin excepción',
    '',
    'El motivo no es formal: una captura que llega sin nombre y sin horario no se puede registrar, y el encargado se queda con una imagen y nada que aprobar.',
    '',
    // Moved here from clinicalBlocks, which only dental and salud ever received.
    // A barbershop that charges a deposit got the two OTHER copies of the
    // payment rules and never this one, so it was the only kind of business
    // whose Emma was never told when to call request_image — the call that makes
    // the capture reach the owner at all. Not duplicated prose: a rule that was
    // missing for three of the five niches.
    'Cuando el cliente diga que ya pagó, o que va a mandar el voucher, la captura o el comprobante:',
    '  - Verificá primero que tengas servicio + horario + nombre. Si falta alguno, pedí ese y nada más.',
    '  - Con los tres datos: llamá request_image con purpose "payment" y RECIÉN DESPUÉS pedile la captura con naturalidad.',
    '  - Sin esa llamada no hay nada registrado que la captura pueda activar, y la foto no le llega al encargado.',
    'NUNCA confirmes vos que un pago está recibido, verificado o aprobado: vos solo recibís la imagen.',
    'NUNCA le digas al cliente que vas a reenviar la imagen a alguien ni menciones al encargado por su rol. Para el cliente, esta conversación la resolvés vos de principio a fin.',
    '  ✅ "¡Recibí tu captura! Dame un momentito y te confirmo 😊"',
    '  ❌ "Se la paso al doctor para que la revise."',
    'ÚNICA excepción: cuando la captura ya llegó y el pago está en verificación, sí podés decir que "el encargado lo está verificando" — ahí la espera es real y "dame un momentito" sería una promesa que no podés cumplir. Igual NO prometas un horario ni digas que la cita ya quedó.',
  ]
}

/**
 * Block describing what this customer still has open.
 *
 * Two very different situations produce a `pending` appointment and they must
 * never be worded the same way: one is waiting on the CUSTOMER's answer and can
 * be confirmed right here, the other is waiting on the OWNER's approval and
 * Emma offering to confirm it would promise something nobody granted.
 */
export function renderPendingBlock(pending: PendingAppointmentContext): string[] {
  if (pending.proposedByOwner) {
    return [
      '# Cita pendiente de este cliente — ESPERA SU RESPUESTA',
      `Le propusimos: *${pending.service}* el *${pending.scheduledAtDisplay}*. Todavía NO está agendada: falta que él acepte.`,
      'Ese es el tema abierto de esta conversación. Aunque el cliente escriba de otra cosa, tenelo presente.',
      '- Si acepta ("sí", "dale", "perfecto", "ok", "me parece bien"), llamá confirm_pending_appointment en ese mismo turno, con customer_name si ya sabés cómo se llama. Si no lo sabés, preguntale el nombre y confirmá en el turno siguiente.',
      '- Si pregunta por su cita ("¿qué pasó con mi cita?", "¿en qué quedamos?"), recordale el horario propuesto y preguntale si se lo confirmás. No te limites a describirlo.',
      '- Si rechaza o pide otro horario, NO confirmes: escalá con escalate_to_human indicando qué prefiere.',
      '',
    ]
  }
  return [
    '# Cita pendiente de este cliente — ESPERA APROBACIÓN DEL NEGOCIO',
    `Pidió: *${pending.service}* el *${pending.scheduledAtDisplay}*. La solicitud ya fue enviada y falta que el encargado la apruebe.`,
    'NO está agendada y vos NO podés confirmarla. Si pregunta, decile que su solicitud está en revisión y que le confirman en breve.',
    'NUNCA le ofrezcas confirmársela vos ni llames confirm_pending_appointment para esta.',
    '',
  ]
}
