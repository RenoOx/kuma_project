import {
  CONFIRM_SUMMARY,
  CORRECT_FIELD,
  defineNode,
  ESCALATE,
  SAVE_DATA,
  to,
} from './building-blocks.js'
import type { NodeBranch } from './types.js'

// The nodes only a business that sells gets: the institute, the certification.
// Never import appointments.nodes.ts from here — the two flow types stay apart
// so a change for one cannot reach the other.

export const SALES_NODES = [
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
      example: '¿Qué dato querés cambiar? (nombre, fecha, hora…)',
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

// Shipped WITH the preset rather than left for the owner to draw: a selling
// business that opens the panel for the first time should already close, and a
// route is the one part of a flow they have no way to guess is missing.
export const SALES_ENTRY_BRANCH: NodeBranch = {
  id: 'ruta-cierre',
  when: 'El cliente eligió un servicio concreto y quiere avanzar, inscribirse o comprarlo.',
  to: 'collect_data',
}
