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
  priceVsDepositExample: [
    '  ❌ "El curso cuesta S/ 20" cuando S/ 20 es el adelanto de matrícula y la lista dice *S/ 450*.',
    '  ✅ "El curso cuesta *S/ 450*. Para separar tu cupo se pide un adelanto de S/ 20."',
  ],
  leadingPriceRules: [],
  priceRulesClosing: [],
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
}
