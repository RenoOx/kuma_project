import {
  defineNode,
  ESCALATE,
  MEDIA_STEP,
  SERVICE_MEDIA,
  SHOW_SERVICES,
  SHOW_SERVICES_STEP,
  to,
} from './building-blocks.js'

// The nodes every business gets, whatever it does. A change here reaches the
// clinic AND the institute — the snapshot tests are what show it.
//
// Split in two because the panel lists the catalogue in conversation order: the
// entry nodes come before the ones a flow type adds, and the farewell after.
//
// Solo declaran lo que sirve a cualquier negocio: tools comunes y ejemplos sin
// rubro. Lo de la agenda (check_availability, confirm_pending_appointment, las
// salidas hacia show_availability y los ejemplos de clínica) lo agrega
// appointments.nodes.ts con APPOINTMENT_CORE_EXTENSIONS.

export const CORE_ENTRY_NODES = [
  defineNode({
    id: 'idle',
    label: 'Reposo',
    hint: 'El punto de partida. No le habla al cliente.',
    mandatory: true,
    tools: [ESCALATE],
    node: { objective: '', steps: [], edgeCases: [], example: '' },
    exits: { customer_message: 'next' },
  }),

  defineNode({
    id: 'greeting',
    label: 'Saludo inicial',
    hint: 'Siempre primero: es por donde entra toda conversación nueva.',
    mandatory: true,
    tools: [SHOW_SERVICES, SERVICE_MEDIA, ESCALATE],
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
      example: '¡Hola! Soy Emma, la asistente del negocio. ¿En qué puedo ayudarte hoy?',
    },
    exits: {
      // Fires on the customer's next message: the greeting is one turn, and the
      // thread moves on by itself rather than waiting for an intent nothing
      // reports. This is the exit whose absence kept sales parked in greeting.
      customer_message: 'next',
      services_listed: to('listado_servicios'),
    },
  }),

  defineNode({
    id: 'informing',
    label: 'Asesoría',
    hint: 'Entender qué busca el cliente antes de mandarle todo el catálogo.',
    tools: [SHOW_SERVICES, SERVICE_MEDIA, ESCALATE],
    node: {
      objective: 'Entender qué busca el cliente ANTES de enviarle todo el catálogo.',
      steps: [
        'Leé lo que el cliente pide.',
        '¿Busca un servicio puntual, información general, o quiere agendar directo?',
        'Si está claro, mostrale los servicios que corresponden. Si es vago, hacé una pregunta de clarificación.',
        SHOW_SERVICES_STEP,
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
    },
  }),

  defineNode({
    id: 'listado_servicios',
    label: 'Listado de servicios',
    hint: 'Mostrar los servicios que aplican, con su material adjunto.',
    requires: ['services_configured'],
    tools: [SHOW_SERVICES, SERVICE_MEDIA, ESCALATE],
    node: {
      objective: 'Mostrar los servicios relevantes con su material asociado.',
      steps: [
        SHOW_SERVICES_STEP,
        // Was "Enviá nombre, descripción y precio de cada uno", which is what
        // produced the wall of text: with six-line descriptions the model did
        // exactly as told. The detail now travels in the card caption, where the
        // customer reads it under the photo instead of scrolling past it.
        'Tu texto es solo una intro corta. No repitas lo que ya va en las fichas.',
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
      example: '*Plan básico* — S/ 450. ¿Te cuento de qué se trata o preferís ver otro?',
    },
    // Sin salidas propias: en agenda sale por disponibilidad o reserva (lo agrega
    // la extensión de agenda); en venta, por la ruta que trae el preset.
    exits: {},
  }),
]

export const CORE_EXIT_NODES = [
  defineNode({
    id: 'confirmed',
    label: 'Despedida',
    hint: 'El cierre. Va último cuando existe: un negocio solo informativo no cierra nada.',
    tools: [ESCALATE],
    node: {
      objective: 'Cerrar la conversación con el cliente tranquilo.',
      steps: ['Confirmá lo acordado.', 'Despedite con calidez y sin prometer de más.'],
      edgeCases: [
        'Cliente que vuelve a preguntar algo después de la despedida: retomá la conversación con naturalidad.',
        'Cliente que no responde: no le escribas de nuevo.',
      ],
      example: '¡Listo! Quedó todo registrado. Cualquier duda, escribime por acá. ¡Gracias!',
    },
    // The returning customer. Nothing closes a conversation and the open thread
    // is reused, so without this a customer who booked once would stay parked
    // here for good — and a barbershop's customers all come back.
    exits: { customer_message: to('greeting') },
  }),
]

/** Nothing to book and nothing to charge: the business only answers questions. */
export const PRESET_INFO_ONLY = ['idle', 'greeting', 'informing', 'listado_servicios']

/** Los ids de los nodos core, para que una extensión solo pueda nombrar esos. */
export type CoreNodeId =
  | (typeof CORE_ENTRY_NODES)[number]['id']
  | (typeof CORE_EXIT_NODES)[number]['id']
