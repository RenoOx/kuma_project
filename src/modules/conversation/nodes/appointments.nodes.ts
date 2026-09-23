import {
  BOOK,
  CHECK_AVAILABILITY,
  defineNode,
  ESCALATE,
  PENDING_CONFIRM,
  REQUEST_IMAGE,
  SERVICE_MEDIA,
  SHOW_SERVICES,
  to,
} from './building-blocks.js'

// The nodes only a business that books appointments gets: the clinic, the
// barbershop, the salon. Never import sales.nodes.ts from here — the two flow
// types stay apart so a change for one cannot reach the other.

export const APPOINTMENT_NODES = [
  defineNode({
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
  }),

  defineNode({
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
  }),

  defineNode({
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
  }),
]

export const PRESET_APPOINTMENTS = [
  'idle',
  'greeting',
  'informing',
  'listado_servicios',
  'show_availability',
  'confirmed',
]

export const PRESET_APPOINTMENTS_DEPOSIT = [
  'idle',
  'greeting',
  'informing',
  'listado_servicios',
  'show_availability',
  'await_payment',
  'await_payment_verification',
  'confirmed',
]
