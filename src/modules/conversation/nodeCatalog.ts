import type { BusinessSettings } from '@/modules/business/business.settings.js'
import { activeServices } from '@/modules/business/business.settings.js'

// The closed catalogue of conversation nodes.
//
// This is the brick box. A business does not write a flow: it composes one by
// picking nodes from here, in order, and overriding their wording. Everything
// that decides BEHAVIOUR — which tools a node offers, which triggers move it,
// what it guards — lives in the blueprint and is ours. Everything that decides
// WORDING is overridable by the owner.
//
// A node can only offer tools the executor can run, and can only advance on a
// trigger something in the code emits. That is not a limitation of the design,
// it is the whole point of it: the flow that was configurable before this
// module had six declared triggers nobody emitted, and a sales business that
// answered once and then went silent forever.

// The fields every node carries. Rendered into the system prompt as the LAST
// block, where an instruction weighs most.
export interface ConversationNode {
  objective: string
  steps: string[]
  edgeCases: string[]
  example: string
  /**
   * The owner's own note for this step. Never set by a blueprint — it exists
   * only to carry what they wrote, appended AFTER the steps rather than
   * replacing them.
   *
   * The distinction is the whole reason this field exists instead of making
   * `steps` editable: the steps are the motor. An owner who could rewrite
   * show_availability's steps could delete "SIEMPRE consultá la disponibilidad
   * real del día pedido", and Emma would start inventing hours.
   */
  extraInstructions?: string
}

// Config a node cannot work without. Checked by validateFlow BEFORE a
// composition is stored, so "the owner saved a flow that cannot run" stops
// being a thing that reaches a customer.
export type NodeRequirement =
  | 'deposit_configured'
  | 'services_configured'
  | 'collect_fields_configured'

// Where an exit leads. 'next' is resolved by the compiler to whatever node the
// owner put after this one — that is the linear part, and it is why the owner
// never writes an edge. Anything else is a fixed jump declared here; the
// compiler drops it when its target is not in the composition.
export type ExitTarget = 'next' | { node: string }

/** A route the OWNER wrote, as opposed to the fixed exits a blueprint declares. */
export interface NodeBranch {
  /**
   * What the model names when it takes this route. Stable and short: it goes in
   * the prompt and comes back in a tool call, so it has to survive being
   * retyped by a language model.
   */
  id: string
  /** The owner's words for when this route applies. Rendered into the prompt. */
  when: string
  /** Id of the step this leads to. Dropped by the compiler if it is not in the flow. */
  to: string
}

export interface NodeBlueprint {
  id: string
  /** Shown in the panel's Conversación card. */
  label: string
  /** Why this node is not always offered, in the owner's words. */
  hint: string
  node: ConversationNode
  /** Tool names the LLM may reach for here. Must exist in KUMA_TOOL_NAMES. */
  tools: string[]
  /** trigger → where it leads. */
  exits: Record<string, ExitTarget>
  /** Refuses entry unless the trigger carries evidence that satisfies it. */
  entryGuard?: 'booking_intent'
  requires?: NodeRequirement[]
  /** Cannot be removed from a composition, and cannot be reordered. */
  mandatory?: boolean
}

// Tool name constants, so a rename breaks the build here rather than silently
// offering a tool the executor does not know.
const ESCALATE = 'escalate_to_human'
const PENDING_CONFIRM = 'confirm_pending_appointment'
const SERVICE_MEDIA = 'send_service_media'
const CHECK_AVAILABILITY = 'check_availability'
const BOOK = 'book_appointment'
const REQUEST_IMAGE = 'request_image'
const SHOW_SERVICES = 'show_services'
const SAVE_DATA = 'save_customer_data'
const CONFIRM_SUMMARY = 'confirm_summary'
const CORRECT_FIELD = 'correct_field'
/**
 * The one generic emitter.
 *
 * Every other exit in this catalogue fires because a specific thing happened —
 * a booking was made, a capture arrived, the owner approved. That is what keeps
 * `validateFlow`'s promise honest, and it is also why an owner could never add a
 * route of their own: there was no code path to fire it.
 *
 * This tool is that code path. The owner writes the CONDITION in their own words
 * and the model decides whether it holds; the executor checks the branch it
 * named against the ones the step actually declares. So the trigger still has a
 * real emitter and the target is still one the compiler resolved — the guarantee
 * survives, and the owner gets to draw the route.
 */
const ADVANCE_FLOW = 'advance_flow'

const to = (node: string): ExitTarget => ({ node })

/**
 * Shared by the two nodes that put services in front of a customer.
 *
 * The distinction it draws — catalogue versus detail — is the one CLAUDE.md
 * already documents and the prompt body already states. What was missing was
 * having it in the node block, which is the last thing the model reads and
 * therefore the thing it follows when the two disagree.
 */
const MEDIA_STEP =
  'Si nombrás UN servicio con su detalle —porque lo pidió o porque se lo estás recomendando— y ese servicio está marcado [con material], mandá el material en este mismo turno. Listar el catálogo no cuenta: ahí van solo nombre y precio.'

/**
 * Every trigger something in this codebase actually emits, with the emitter.
 *
 * Hand-maintained on purpose: there is no way to introspect "does any code path
 * produce this string", and the alternative — trusting the flow definition —
 * is exactly what let six triggers sit in the state machine for months routing
 * nowhere. validateFlow refuses any composition that depends on a trigger
 * missing from this set, so adding an exit without its emitter fails loudly at
 * save time instead of quietly at 2am in a customer's chat.
 */
export const EMITTED_TRIGGERS: ReadonlyMap<string, string> = new Map([
  ['customer_message', 'llm.service.ts — every inbound customer message'],
  ['asks_availability', 'toolExecutor.ts — check_availability'],
  ['appointment_booked', 'toolExecutor.ts — book_appointment / confirm_pending_appointment'],
  ['deposit_required', 'toolExecutor.ts — the deposit gate'],
  ['payment_capture_received', 'handler.ts — customer image received'],
  ['payment_received', 'handler.ts — customer image received (sales)'],
  ['payment_approved', 'paymentVerification.service.ts — owner approved'],
  ['payment_rejected', 'paymentVerification.service.ts — owner rejected'],
  ['services_listed', 'toolExecutor.ts — show_services'],
  ['data_complete', 'toolExecutor.ts — save_customer_data'],
  ['summary_confirmed', 'toolExecutor.ts — confirm_summary'],
  ['correction_requested', 'toolExecutor.ts — confirm_summary (customer said no)'],
  ['field_corrected', 'toolExecutor.ts — correct_field'],
  ['route_selected', 'toolExecutor.ts — advance_flow'],
])

/**
 * The trigger every owner-written route fires.
 *
 * One trigger for all of them, with the branch travelling as evidence rather
 * than as its own trigger name. The alternative — a trigger per route — would
 * put owner-typed strings into EMITTED_TRIGGERS, which is the registry of what
 * the CODE can fire, and would turn a hand-maintained safety net into a list
 * anyone can append to.
 */
export const ROUTE_TRIGGER = 'route_selected'

/** The tool a step gets automatically once the owner gives it a route. */
export const ROUTE_TOOL = ADVANCE_FLOW

// Universal exit. Added by the compiler to every node, so no blueprint declares
// it and no owner can remove it.
export const IDLE_TRIGGER = 'inactive_24h'

/**
 * The bricks, in the order the panel lists them.
 *
 * `idle`, `greeting` and `confirmed` are mandatory: a conversation has to start
 * somewhere and end somewhere, and a flow whose first node can be removed is a
 * flow that can be saved with no entry point.
 */
export const NODE_CATALOG: ReadonlyArray<NodeBlueprint> = [
  {
    id: 'idle',
    label: 'Reposo',
    hint: 'El punto de partida. No le habla al cliente.',
    mandatory: true,
    tools: [PENDING_CONFIRM, ESCALATE],
    node: { objective: '', steps: [], edgeCases: [], example: '' },
    exits: { customer_message: 'next' },
  },

  {
    id: 'greeting',
    label: 'Saludo inicial',
    hint: 'Siempre primero: es por donde entra toda conversación nueva.',
    mandatory: true,
    tools: [SHOW_SERVICES, CHECK_AVAILABILITY, SERVICE_MEDIA, PENDING_CONFIRM, ESCALATE],
    node: {
      objective: 'Dar la bienvenida e identificar la intención del cliente.',
      steps: [
        'Saludá usando el nombre del asistente y del negocio.',
        'Preguntá en qué podés ayudar.',
      ],
      edgeCases: [
        'Cliente que regresa (ya conversó antes): reconocelo si podés.',
        'Cliente que llega molesto o con una queja: tono empático, ofrecé derivarlo.',
        'Cliente que manda solo "hola": respondé y preguntá qué necesita.',
      ],
      example: '¡Hola! Soy Emma, asistente de Clínica Dental Sonrisa. ¿En qué puedo ayudarte hoy?',
    },
    exits: {
      // Fires on the customer's next message: the greeting is one turn, and the
      // thread moves on by itself rather than waiting for an intent nothing
      // reports. This is the exit whose absence kept sales parked in greeting.
      customer_message: 'next',
      services_listed: to('listado_servicios'),
      asks_availability: to('show_availability'),
      appointment_booked: to('confirmed'),
    },
  },

  {
    id: 'informing',
    label: 'Asesoría',
    hint: 'Entender qué busca el cliente antes de mandarle todo el catálogo.',
    tools: [SHOW_SERVICES, CHECK_AVAILABILITY, SERVICE_MEDIA, PENDING_CONFIRM, ESCALATE],
    node: {
      objective: 'Entender qué busca el cliente ANTES de enviarle todo el catálogo.',
      steps: [
        'Leé lo que el cliente pide.',
        '¿Busca un servicio puntual, información general, o quiere agendar directo?',
        'Si está claro, mostrale los servicios que corresponden. Si es vago, hacé una pregunta de clarificación.',
        // The global rule covers recommending, but it lives in the body and this
        // node's objective pulls the other way ("ANTES de enviarle todo el
        // catálogo"). A recommendation IS the detail of one service, and the
        // block the model reads last has to say so.
        MEDIA_STEP,
      ],
      edgeCases: [
        'Cliente que dice "quiero una cita" directo: no le listes el catálogo, andá al grano.',
        'Cliente que pregunta precios sin decir de qué: pedile que elija primero.',
        'Cliente que pregunta algo fuera del alcance: respondé si podés, derivá si no.',
      ],
      example: '¡Claro! ¿Buscás algo en particular o te cuento sobre nuestros servicios?',
    },
    exits: {
      services_listed: 'next',
      asks_availability: to('show_availability'),
      appointment_booked: to('confirmed'),
    },
  },

  {
    id: 'listado_servicios',
    label: 'Listado de servicios',
    hint: 'Mostrar los servicios que aplican, con su material adjunto.',
    requires: ['services_configured'],
    tools: [SHOW_SERVICES, SERVICE_MEDIA, CHECK_AVAILABILITY, PENDING_CONFIRM, ESCALATE],
    node: {
      objective: 'Mostrar los servicios relevantes con su material asociado.',
      steps: [
        'Filtrá los servicios según lo que pidió el cliente.',
        'Enviá nombre, descripción y precio de cada uno.',
        // Replaces "Si el servicio tiene material cargado, enviálo", which read
        // as applying to every row of a list the model had just been told to
        // send whole — the one case where the material must NOT go.
        MEDIA_STEP,
        'Preguntá si quiere avanzar o saber más de alguno.',
      ],
      edgeCases: [
        'Servicio sin material: mandá solo texto.',
        'Cliente que pide un servicio que no existe: ofrecé los más parecidos.',
        'Varios servicios: uno por uno, no todo junto.',
      ],
      example:
        'Limpieza dental — S/ 80. Incluye evaluación y aplicación de flúor. ¿Te gustaría agendar?',
    },
    exits: {
      asks_availability: to('show_availability'),
      appointment_booked: to('confirmed'),
    },
  },

  {
    id: 'show_availability',
    label: 'Disponibilidad',
    hint: 'Solo si el negocio agenda: muestra horarios y toma la reserva.',
    requires: ['services_configured'],
    tools: [
      CHECK_AVAILABILITY,
      BOOK,
      SHOW_SERVICES,
      SERVICE_MEDIA,
      PENDING_CONFIRM,
      REQUEST_IMAGE,
      ESCALATE,
    ],
    node: {
      objective: 'Mostrar horarios libres y cerrar la reserva.',
      // These carry the availability tree that used to be written twice in the
      // global prompt body — once as "Flujo de reserva PASO 1-2" and again as
      // APPOINTMENTS_ONLY_AVAILABILITY_BLOCK — and was sent in every message of
      // every conversation, including those waiting on a payment capture. Steps
      // and not edgeCases on purpose: the owner can override edge cases, and
      // this is the mechanics, not a special case.
      steps: [
        'Si no dijo el día o el servicio, preguntá eso primero y recién después consultá disponibilidad.',
        'SIEMPRE consultá la disponibilidad real del día pedido. Nunca respondas solo con el horario general de apertura ("abrimos de 9 a 8").',
        'Ubicá cuál de los tres casos es, en este orden:',
        'ATAJO — dio una hora exacta ("a las 10", "puede ser 3pm"): no listes nada. Si esa hora está libre, confirmá y pedí el nombre. Si no, ofrecé las dos más cercanas. ✅ "Sí, las 10:00am está libre 😊 ¿A nombre de quién agendo la cita?" ❌ mostrarle todos los tramos: ya te dijo las 10.',
        'ELIGIÓ UN TRAMO o dio una preferencia ("en la mañana", "después de las 3"): listá TODOS los horarios exactos de ese tramo, sin recortar. ✅ "En la mañana tengo: 8:00am, 8:30am, 9:00am, 9:30am, 10:00am, 10:30am, 11:00am, 11:30am y 12:00pm. ¿Cuál prefieres?"',
        'PREGUNTÓ POR EL DÍA sin hora ni preferencia: solo acá presentás los TRAMOS y preguntás cuál le acomoda. ✅ "Para mañana tengo de *8:00am a 12:30pm* y de *2:00pm a 5:00pm*. ¿Qué horario te acomoda mejor?"',
        'Recién cuando ya eligió horario, preguntá el nombre: "¿A nombre de quién agendo la cita?". NUNCA antes, NUNCA el de WhatsApp, NUNCA inventado.',
        'Con servicio + horario + nombre, agendá. Si el negocio pide adelanto, la herramienta te va a rechazar pidiéndolo: eso es lo esperado y deja registrado el horario elegido.',
      ],
      edgeCases: [
        'Cliente que quiere un horario ocupado: ofrecé los más cercanos.',
        'Cliente que pide un servicio que requiere evaluación: guialo a una consulta de diagnóstico y seguí el flujo normal desde ahí.',
        'Cliente que no se decide: ofrecé dos o tres opciones concretas, no la agenda entera.',
        'Si un tramo tiene un solo horario, decilo como hora puntual y no como rango.',
        'Si no hay ningún horario libre ese día, decilo y ofrecé otra fecha.',
        'Si el cliente cambia de horario o de servicio después de haber agendado, volvé a agendar con los datos nuevos: si no, queda registrado el horario viejo.',
      ],
      example: 'Para el jueves tengo 10:00am, 11:30am y 4:00pm. ¿Cuál te queda mejor?',
    },
    exits: {
      // Always await_payment, never 'next': in a flow with no deposit nodes the
      // edge is dropped instead of landing wherever the owner happened to put
      // the following node.
      deposit_required: to('await_payment'),
      appointment_booked: to('confirmed'),
      services_listed: to('listado_servicios'),
    },
  },

  {
    id: 'await_payment',
    label: 'Métodos de pago',
    hint: 'Solo si pedís adelanto o cobrás por adelantado.',
    requires: ['deposit_configured'],
    // Withholds confirm_pending_appointment on purpose: it does not pass the
    // deposit gate, so offering it here would let a customer close a booking
    // without ever sending the capture this node exists to wait for.
    tools: [REQUEST_IMAGE, BOOK, ESCALATE],
    entryGuard: 'booking_intent',
    node: {
      objective: 'Presentar las opciones de pago y esperar el comprobante.',
      // Was "PASO 4 — Adelanto" in the global body, sent to every business in
      // every state, including the ones that charge no deposit at all. The rule
      // about never naming money before having the name stays in the body, in
      // "Orden para cobrar el adelanto", because it has to hold in the states
      // BEFORE this one — which is exactly where it gets broken.
      steps: [
        'Decile el monto y listá los métodos configurados con sus datos.',
        'Este es el primer momento de la conversación en que podés nombrar dinero.',
        'Pedí la captura del comprobante directamente, sin preguntar si quiere mandarla. ✅ "Mandame la captura cuando pagues 😊" ❌ "¿Te gustaría que te pida la captura?"',
        'NO le digas que la cita quedó agendada ni que la solicitud fue enviada: todavía no hay nada agendado.',
      ],
      edgeCases: [
        'Cliente que no tiene ese método: ofrecé las alternativas configuradas.',
        'Cliente que pregunta si puede pagar presencial: respondé según la configuración.',
        'Cliente que manda una imagen que no es comprobante: pedile que reenvíe la correcta.',
        'Cliente que dice "ya pagué" pero no manda nada: pedile la captura con amabilidad. Sin captura no avanzás.',
        'Cliente que cambia de horario o de servicio acá: volvé a agendar con los datos nuevos antes de seguir con el pago.',
      ],
      example:
        'Para confirmar tu cita necesitás un adelanto de S/ 50. Podés pagar por Yape al 987654321. Mandame la captura cuando lo hagas.',
    },
    exits: {
      payment_capture_received: 'next',
      payment_received: 'next',
      appointment_booked: to('confirmed'),
      asks_availability: to('show_availability'),
    },
  },

  {
    id: 'await_payment_verification',
    label: 'Verificación de pago',
    hint: 'Solo si pedís adelanto: el dueño revisa el comprobante.',
    requires: ['deposit_configured'],
    // Offers nothing but escalation, and the exclusions are the point: the way
    // out of this node is not the customer's to take.
    tools: [ESCALATE],
    node: {
      objective: 'Sostener la espera mientras el dueño revisa el comprobante.',
      steps: [
        'Confirmá que recibiste el comprobante.',
        'Decile que está en verificación y que le confirmás en un momento.',
        'NO confirmes la cita, NO hables de horarios y NO pidas otra captura.',
      ],
      edgeCases: [
        'Cliente que pregunta cuánto falta: repetí que está en verificación, sin prometer un horario.',
        'Cliente que manda otra captura: agradecé, no abras un segundo pedido.',
      ],
      example:
        '¡Recibí tu comprobante! El encargado lo está verificando y te confirmo apenas esté listo.',
    },
    exits: {
      payment_approved: 'next',
      // The rejection needs booking_intent evidence to pass await_payment's
      // guard; paymentVerification.service hands it over because the rejected
      // row still holds the frozen service, slot and name.
      payment_rejected: to('await_payment'),
    },
  },

  {
    id: 'collect_data',
    label: 'Captura de datos',
    hint: 'Pide los campos que configuraste, uno por uno.',
    requires: ['collect_fields_configured'],
    tools: [SAVE_DATA, ESCALATE],
    node: {
      objective: 'Recoger la información que el negocio necesita del cliente.',
      steps: [
        'Pedí cada campo configurado, uno a la vez y nunca todos de golpe.',
        'Validá el formato donde aplique (correo, teléfono, fecha).',
        'Cuando los tengas todos, guardalos.',
      ],
      edgeCases: [
        'Cliente que da varios datos en un mensaje: tomá los que puedas y pedí solo lo que falte.',
        'Dato con formato inválido: pedilo de nuevo con amabilidad, explicando qué falta.',
      ],
      example: '¡Perfecto! ¿A nombre de quién lo registro?',
    },
    exits: { data_complete: 'next' },
  },

  {
    id: 'confirmacion',
    label: 'Confirmación',
    hint: 'Le lee al cliente el resumen antes de cerrar.',
    tools: [CONFIRM_SUMMARY, ESCALATE],
    node: {
      objective: 'Verificar que todo es correcto antes de cerrar.',
      steps: [
        'Mostrá el resumen completo: servicio, fecha, hora, datos y monto si aplica.',
        'Preguntá si está todo bien.',
      ],
      edgeCases: [
        'Cliente que confirma con variaciones ("sí", "ok", "dale", "perfecto"): tomalo como afirmativo.',
        'Cliente que dice que no sin aclarar qué: preguntá qué dato hay que corregir.',
      ],
      example:
        'Te queda así:\nServicio: Limpieza dental\nFecha: jueves 25 de septiembre\nHora: 3:00pm\nNombre: Juan Pérez\n\n¿Está todo correcto?',
    },
    exits: {
      // Always 'confirmed', never 'next', for the same reason show_availability
      // names await_payment outright: 'next' is POSITIONAL, and correccion_datos
      // has to sit next to this node to be readable in the panel. With 'next',
      // a customer who said "sí, está todo bien" was sent to the correction step.
      summary_confirmed: to('confirmed'),
      correction_requested: to('correccion_datos'),
    },
  },

  {
    id: 'correccion_datos',
    label: 'Corrección de datos',
    hint: 'Deja cambiar un dato sin volver a pedir todo.',
    tools: [CORRECT_FIELD, ESCALATE],
    node: {
      objective: 'Permitir corregir un dato sin recapturar todo.',
      steps: [
        'Preguntá QUÉ dato quiere cambiar. No pidas todos de nuevo.',
        'Recibí el dato corregido y guardalo.',
        'Volvé al resumen.',
      ],
      edgeCases: ['Cliente que quiere cambiar varios datos: uno a la vez.'],
      example: '¿Qué dato querés cambiar? (nombre, fecha, hora…)',
    },
    exits: { field_corrected: to('confirmacion') },
  },

  {
    id: 'confirmed',
    label: 'Despedida',
    hint: 'El cierre. Va último cuando existe: un negocio solo informativo no cierra nada.',
    tools: [PENDING_CONFIRM, ESCALATE],
    node: {
      objective: 'Cerrar la conversación con el cliente tranquilo.',
      steps: ['Confirmá lo acordado.', 'Despedite con calidez y sin prometer de más.'],
      edgeCases: [
        'Cliente que vuelve a preguntar algo después de la despedida: retomá la conversación con naturalidad.',
        'Cliente que no responde: no le escribas de nuevo.',
      ],
      example: '¡Listo! Tu cita quedó confirmada para el jueves 25 a las 3:00pm. ¡Te esperamos!',
    },
    // The returning customer. Nothing closes a conversation and the open thread
    // is reused, so without this a customer who booked once would stay parked
    // here for good — and a barbershop's customers all come back.
    exits: { customer_message: to('greeting') },
  },
]

export const NODE_BY_ID: ReadonlyMap<string, NodeBlueprint> = new Map(
  NODE_CATALOG.map((n) => [n.id, n]),
)

/** Whether the business config a node depends on is actually there. */
export function requirementMet(req: NodeRequirement, settings: BusinessSettings | null): boolean {
  if (!settings) return false
  switch (req) {
    case 'deposit_configured':
      return settings.requiresDeposit
    case 'services_configured':
      return activeServices(settings).length > 0
    case 'collect_fields_configured':
      return settings.collectDataFields.length > 0
  }
}
