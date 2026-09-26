import {
  CONFIRM_SUMMARY,
  CORRECT_FIELD,
  defineNode,
  ESCALATE,
  SAVE_DATA,
  to,
} from './building-blocks.js'
import type { CoreNodeId } from './core.nodes.js'
import type { NodeBranch, NodeExtension } from './types.js'

// The nodes only a business that sells gets: the institute, the certification.
// Never import appointments.nodes.ts from here — the two flow types stay apart
// so a change for one cannot reach the other.

export const SALES_NODES = [
  // Una asesoría para UN perfil de cliente, separada de la general. Nació del
  // instituto: el que ya opera maquinaria no ve cursos, ve la certificación de su
  // nivel. Vivía como un "si tiene experiencia…" dentro de Asesoría, compitiendo con
  // los pasos genéricos de ese nodo ("mostrale los servicios", "agendar directo") y
  // sin caja propia en el diagrama.
  //
  // Sin salidas fijas: se sale por la ruta que escribe el negocio ("quiere
  // avanzar" → captura). validateFlow exige que exista.
  defineNode({
    id: 'asesoria_perfil',
    label: 'Asesoría por perfil',
    hint: 'Para un tipo de cliente: una pregunta clave y la oferta que le corresponde.',
    requires: ['services_configured'],
    // Sin show_services a propósito: mandaría la ficha de TODAS las opciones y
    // este paso existe para ofrecer una sola. La lista ya está en el prompt.
    tools: [ESCALATE],
    node: {
      objective:
        'Con la respuesta del cliente a la pregunta clave, identificar la opción que le corresponde y ofrecérsela.',
      steps: [
        'Si todavía no tenés el dato que define la opción, preguntalo: las indicaciones de este paso dicen cuál es.',
        'Con ese dato, elegí UNA opción de la lista de servicios. Es una elección, no una cuenta: no sumes ni combines opciones.',
        'Ofrecé esa opción. Si este paso tiene un mensaje fijo para la oferta, mandalo con esa opción en lugar de escribirla con tus palabras.',
        'Preguntá si quiere avanzar.',
      ],
      edgeCases: [
        'Si no sabe el dato exacto, pedile una estimación.',
        'Si pregunta por otra opción que no es para su perfil, explicale en una línea por qué esta es la suya.',
      ],
      example: '¡Perfecto! Con eso, esta es la opción que va con tu perfil.',
    },
    exits: {},
  }),

  // Entre "ya eligió" y "dame tus datos". Nació porque antes de pedir el nombre
  // el negocio quiere mostrar lo que el cliente recibe al terminar — una
  // galería de fotos, no una foto sola — y eso es contenido, no un dato a
  // capturar: no le corresponde a collect_data.
  //
  // Mismo molde que asesoria_perfil: sin salidas fijas, sale por la ruta que
  // escribe el negocio. Vive en el catálogo para que cualquier venta pueda
  // usarlo, pero no entra al preset — es opt-in por archivo.
  defineNode({
    id: 'mostrar_beneficios',
    label: 'Beneficios',
    hint: 'Le muestra al cliente lo que recibe al terminar, antes de pedirle sus datos.',
    requires: ['services_configured'],
    tools: [ESCALATE],
    node: {
      objective:
        'Mostrarle lo que va a recibir al terminar lo que eligió, y confirmar que quiere seguir antes de pedirle sus datos.',
      steps: [
        'Mandá la galería de beneficios que corresponda con send_fixed_message.',
        'Preguntale si quiere continuar con la inscripción.',
      ],
      edgeCases: [
        'Si todavía no eligió nada concreto, volvé a preguntarle cuál quiere.',
        'Si pregunta algo más antes de seguir, respondé y volvé a invitarlo a continuar.',
      ],
      example: 'Esto es lo que vas a tener. ¿Seguimos con tu inscripción?',
    },
    exits: {},
  }),

  defineNode({
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
  }),

  defineNode({
    id: 'confirmacion',
    label: 'Confirmación',
    hint: 'Le lee al cliente el resumen antes de cerrar.',
    tools: [CONFIRM_SUMMARY, ESCALATE],
    node: {
      objective: 'Verificar que todo es correcto antes de cerrar.',
      // Decía "servicio, fecha, hora": un curso no tiene horario reservado, y el
      // modelo inventaba uno para llenar el resumen.
      steps: [
        'Mostrá el resumen completo: lo que eligió, los datos que registraste y el monto si aplica.',
        'Preguntá si está todo bien.',
      ],
      edgeCases: [
        'Cliente que confirma con variaciones ("sí", "ok", "dale", "perfecto"): tomalo como afirmativo.',
        'Cliente que dice que no sin aclarar qué: preguntá qué dato hay que corregir.',
      ],
      example:
        'Te queda así:\nCurso: Operación de maquinaria pesada — Básico\nNombre: Juan Pérez\nDNI: 45678912\nCorreo: juan@correo.com\n\n¿Está todo correcto?',
    },
    exits: {
      // Always 'confirmed', never 'next', for the same reason show_availability
      // names await_payment outright: 'next' is POSITIONAL, and correccion_datos
      // has to sit next to this node to be readable in the panel. With 'next',
      // a customer who said "sí, está todo bien" was sent to the correction step.
      summary_confirmed: to('confirmed'),
      correction_requested: to('correccion_datos'),
    },
  }),

  defineNode({
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
      example: '¿Qué dato querés cambiar? (nombre, DNI, correo…)',
    },
    exits: { field_corrected: to('confirmacion') },
  }),
]

// The selling flow, which for months was an alias of the informational one.
//
// What was missing was never the closing nodes — collect_data, confirmacion and
// correccion_datos have always been complete, with real emitters. It was the way
// IN: nothing in the code fired a trigger that led from the catalogue to the
// capture, and validateFlow rightly refused to pretend otherwise.
//
// The route tool is that way in. "The customer chose course X" has no slot in
// it, so it never needed the FrozenBooking that blocked this — which is why the
// exit out of listado_servicios is a route the model judges and not an event.
export const PRESET_SALES = [
  'idle',
  'greeting',
  'informing',
  'listado_servicios',
  'collect_data',
  'confirmacion',
  'correccion_datos',
  'confirmed',
]

/**
 * Lo que la venta le suma a los nodos core. Hoy solo el tono del saludo: el
 * ejemplo neutro de core sirve, pero uno que hable de cursos es lo que el modelo
 * imita mejor en un instituto. Las tools de core ya son las correctas para venta.
 */
export const SALES_CORE_EXTENSIONS: Partial<Record<CoreNodeId, NodeExtension>> = {
  greeting: {
    example: '¡Hola! Soy Emma, del instituto. ¿Te interesa algún curso en particular?',
  },
}

// Shipped WITH the preset rather than left for the owner to draw: a selling
// business that opens the panel for the first time should already close, and a
// route is the one part of a flow they have no way to guess is missing.
export const SALES_ENTRY_BRANCH: NodeBranch = {
  id: 'ruta-cierre',
  when: 'El cliente eligió un servicio concreto y quiere avanzar, inscribirse o comprarlo.',
  to: 'collect_data',
}
