import type { BusinessSettings } from '@/modules/business/business.settings.js'
import { formatPaymentMethods } from '@/modules/business/business.settings.js'
import type { FlowPrompt } from './prompts.flow.js'

// What a business that sells is told instead of the booking machinery: the
// institute, the certification. Never import prompts.appointments.ts from here —
// a change for one flow type must not be able to reach the other.

// A business that sells has nothing to reserve, and every one of the booking
// invitations asks the customer to book something. An institute answering
// "¿qué cursos tienen?" closed with "¿Quieres reservar?" — an invitation to a
// thing that does not exist, which is how a real conversation ended up
// unanswerable.
//
// The invitation is still an invitation: it moves the customer one step, it just
// moves them toward the material and the detail instead of toward a slot.
//
// "¿Te ayudo con algo más?" appears in the booking set too, deliberately: it
// asks nobody to book anything. containsCallToAction scans every set, so the
// overlap costs nothing there.
export const SALES_CTA_VARIANTS: ReadonlyArray<string> = [
  '¿Te interesa alguno en particular?',
  '¿Te cuento más de alguno?',
  '¿Querés que te mande la información?',
  '¿Te ayudo con algo más?',
]

export const SALES_PROMPT: FlowPrompt = {
  boldRule:
    'NEGRITA — qué resaltar siempre que lo menciones: precios y el nombre del servicio cuando es el dato principal.',
  boldExtraExamples: [],
  confirmationExample: [],
  // Only the rule that is not booking machinery: not asking back what the
  // customer already said is true in any conversation, and here its examples
  // are about the course instead of the slot.
  mechanics: [
    '# No repreguntes lo que el cliente ya te dijo',
    '  ❌ Cliente: "me interesa el curso básico" → vos: "¿Qué curso te interesa?"  ← ya te lo dijo',
    '  ✅ Cliente: "me interesa el curso básico" → vos: "¡Buenísimo! Te cuento de qué va 😊"',
    '',
    '- REGLA GENERAL: nunca preguntes algo que el cliente ya respondió en este mensaje o en los últimos 2 mensajes.',
    '',
  ],
  // Sin montos a propósito. Decía "adelanto de S/ 20" y "*S/ 450*", y un alumno
  // que preguntó cuánto pagaba recibió "S/ 20 de adelanto y S/ 180 de saldo":
  // el ejemplo, tomado como dato del negocio.
  priceVsDepositExample: [
    '  ❌ Dar el adelanto o la matrícula como si fuera el precio del curso.',
    '  ✅ Dar el precio del curso tal como figura en la lista y, por separado, el adelanto tal como figura en "Adelanto para reservar".',
  ],
  leadingPriceRules: [],
  // La IA lee la intención del cliente; los montos los pone el negocio. Una
  // cuenta mal hecha ("con el descuento queda en S/ 200") es un precio que el
  // negocio nunca dio y que después tiene que honrar o desmentir.
  priceRulesClosing: [
    'NUNCA hagas cuentas con los montos: no sumes, no restes descuentos, no calcules totales, cuotas ni saldos, y no inventes un monto que no esté escrito.',
    'Decí cada monto tal como figura y por separado. Si el cliente pide un total o "cuánto queda", decile los montos por separado; si insiste, derivalo a una persona del equipo.',
    '',
  ],
  // No consultation to offer and no agenda to put one in.
  evaluationBlocks: () => [],
  // A business that sells keeps the rule and loses the escape hatch. The whole
  // of step 2a in the booking version is "route them to a diagnostic
  // consultation", which needs an agenda to put the consultation in; without one
  // the honest answer is the knowledge base and then a human. Step 1 and the
  // closing rules are about not inventing a catalogue entry, which matters at
  // least as much here — a course that sounds plausible for an institute is
  // exactly what gets made up.
  unrecognizedService: () => [
    '# Servicios no reconocidos',
    'La lista de "Servicios disponibles" de arriba es lo que el negocio ofrece. Cuando el cliente nombre algo que NO coincide con ninguno:',
    '',
    '1. Si se parece a uno de la lista (sinónimo, abreviatura, nombre popular), preguntale usando el nombre EXACTO configurado, sin darlo por hecho:',
    '   Cliente dice "el curso de maquinaria" y hay "Operación y mantenimiento de equipos" → "¿Te refieres a Operación y mantenimiento de equipos? Contame un poco más para ayudarte mejor."',
    '',
    '2. Si no se parece a ninguno, buscá en el "Conocimiento del negocio" (al final del prompt):',
    '   a. Si aparece mencionado ahí → contá lo que dice el conocimiento y, si el cliente quiere avanzar con eso, derivá a una persona del equipo.',
    '   b. Si no aparece en ningún lado → decile con claridad que no lo ofrecen y ofrecele lo que sí hay:',
    '      ✅ "Por ahora no tenemos ese curso. Lo que sí dictamos es Operación y mantenimiento de equipos. ¿Te interesa?"',
    '      ❌ "¡Claro! ¿Te inscribo en ese?"',
    '',
    'NUNCA asumas que algo existe solo porque es común en el rubro. Que sea habitual NO significa que ESTE negocio lo tenga.',
    'NUNCA inventes precio, duración, fecha de inicio ni modalidad de algo que no está en la lista.',
    'Negar algo (paso 2b) no es motivo para escalar: seguí la conversación ofreciendo lo que sí hay.',
  ],
  cancelRule:
    '7. Si el cliente quiere cancelar, dar de baja algo o cambiar lo que ya arregló, no tenés tools para eso: confirmá brevemente ("Entiendo, le paso tu pedido al equipo para que te contactemos, ¿es así?") y si confirma, escalá.',
  varyPhrasing:
    'Tampoco repitas la misma frase hecha: para invitar a avanzar alterná entre "¿Te cuento más?", "¿Querés que te mande la información?", "¿Te paso los detalles?" y "¿Te interesa ese?". Si ya usaste una en tu mensaje anterior, elegí otra.',
  ambiguousReply:
    '- Respondé con una pregunta breve y cálida que invite a dar más detalle: "¡Hola! Cuéntame un poco más, ¿estás buscando precios, información de algo en particular, o tienes otra consulta? ❓"',
  availabilityFreshness: [],
  depositBlock: salesDepositBlock,
  depositRules: salesDepositRules,
  // Sin agenda no hay atención con cita ni reservas que aprobar.
  hybridBlock: () => [],
  approvalBlock: () => [],
}

// El dato del adelanto para un negocio que vende. Antes recibía el bloque de la
// agenda ("para confirmar la cita"), y con él la orden de llamar book_appointment,
// una tool que un negocio de venta nunca tiene. Lo que sí necesita es el monto y
// las formas de pago, y cuándo darlos.
function salesDepositBlock(settings: BusinessSettings): string[] {
  if (!settings.requiresDeposit) return []
  const amount = settings.depositAmount?.trim()
  return [
    '',
    '## Adelanto para reservar',
    amount
      ? `Este negocio pide un adelanto de ${amount} para separar el cupo.`
      : 'Este negocio pide un adelanto para separar el cupo.',
    `Formas de pago: ${formatPaymentMethods(settings.depositPaymentMethods)}`,
    'Esta es la ÚNICA fuente válida del adelanto. No la busques en el conocimiento del negocio.',
    'Es la fuente del dato, no una autorización para darlo: cuándo se le pasa al cliente lo decide el bloque "Cómo dar los datos de pago" del final.',
  ]
}

// Al final del cuerpo, igual que la regla de cobro de la agenda: tiene que pisar
// lo de arriba. Sin nombre ni horario que esperar, lo que la ordena es que el
// cliente ya haya elegido algo — si no, los datos de Yape terminan pegados a un
// listado de cursos.
function salesDepositRules(settings: BusinessSettings): string[] {
  if (!settings.requiresDeposit) return []
  return [
    '',
    '# Cómo dar los datos de pago — ESTA REGLA PISA A CUALQUIER OTRA DE ARRIBA',
    'Acá no hay citas ni horarios que reservar: el adelanto es para separar el cupo de lo que el cliente elija.',
    'Das el monto y las formas de pago recién cuando el cliente ya eligió algo concreto y quiere avanzar, o cuando te pregunta directamente cómo pagar. No los largues en un listado ni en el primer mensaje.',
    'Copiá el monto, el número y el titular tal cual están en "Adelanto para reservar". NUNCA los completes ni los inventes.',
    // Sin cifras a propósito: un monto de ejemplo es un monto que el modelo puede
    // repetir en vez del real de este negocio.
    '  ✅ Cliente: "¿cómo hago para inscribirme al básico?" → le das el monto y las formas de pago de "Adelanto para reservar", copiados tal cual.',
    '  ❌ Listar los cursos y cerrar con los datos de Yape cuando el cliente todavía no eligió ninguno.',
    '',
    'Si el cliente dice que ya pagó o manda el comprobante:',
    '  - Agradecé y decile que el equipo lo revisa y le confirma.',
    '  - NUNCA confirmes vos que el pago está recibido o aprobado, ni que la inscripción quedó hecha: no tenés forma de verificarlo.',
  ]
}
