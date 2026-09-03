import type { ChatCompletionTool } from 'openai/resources/chat/completions.js'

export const kumaTools: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'check_availability',
      description:
        'Consulta los horarios disponibles para agendar una cita en una fecha específica. Usar cuando el cliente pregunte por disponibilidad o quiera saber cuándo puede venir.',
      parameters: {
        type: 'object',
        properties: {
          date_iso: {
            type: 'string',
            description: 'Fecha en formato ISO (YYYY-MM-DD), ej: 2026-06-16',
          },
          service: {
            type: 'string',
            description: 'Nombre del servicio que quiere el cliente, ej: corte, barba',
          },
        },
        required: ['date_iso', 'service'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'book_appointment',
      description:
        'Agenda una cita en un horario específico. Solo usar cuando el cliente confirmó fecha, hora y servicio exactos, y ya dio su nombre completo.',
      parameters: {
        type: 'object',
        properties: {
          datetime_iso: {
            type: 'string',
            description:
              'Fecha y hora en formato ISO con offset de Lima (UTC-05:00), ej: 2026-06-16T10:00:00-05:00',
          },
          service: {
            type: 'string',
            description: 'Nombre del servicio. Ej: corte, barba, lavado.',
          },
          customer_name: {
            type: 'string',
            description:
              'Nombre completo del paciente/cliente tal como lo dio en la conversación. Preguntalo antes de llamar esta herramienta: NO uses el nombre de WhatsApp ni lo inventes.',
          },
        },
        required: ['datetime_iso', 'service', 'customer_name'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'confirm_pending_appointment',
      description:
        'Confirma la cita pendiente del cliente. Usar SOLO cuando el cliente acepta un horario que el dueño/encargado le propuso ("sí", "dale", "perfecto", "me parece bien"). Busca sola la cita pendiente. NO la uses para agendar una cita nueva: para eso está book_appointment.',
      parameters: {
        type: 'object',
        properties: {
          customer_name: {
            type: 'string',
            description:
              'Nombre completo del paciente/cliente tal como lo dio en la conversación. Mandalo si lo tenés: un horario propuesto por el encargado suele no tener nombre en ficha. Si no lo pediste todavía, omití este campo. NO uses el nombre de WhatsApp ni lo inventes.',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'request_image',
      description:
        'Avisa al sistema que vas a pedirle una foto al cliente, para que esa foto llegue al encargado. Llamala ANTES de pedirle la imagen. Usar cuando: el cliente dice que ya pagó o que va a mandar el comprobante/voucher/captura (purpose "payment"), o cuando necesitás una foto de referencia para cotizar (purpose "reference"). NO la llames para fotos que no pediste ni para cualquier otra imagen.',
      parameters: {
        type: 'object',
        properties: {
          purpose: {
            type: 'string',
            enum: ['payment', 'reference'],
            description:
              '"payment" para comprobantes de pago, "reference" para fotos de referencia o del caso.',
          },
        },
        required: ['purpose'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'escalate_to_human',
      description:
        'Marca la conversación para que un humano la atienda. Usar cuando: el cliente pide hablar con una persona, el cliente está molesto o frustrado, el cliente menciona una queja sobre un servicio anterior, el cliente pregunta por pagos o reembolsos o descuentos especiales, o el cliente repite la misma pregunta sin haber recibido una respuesta útil.',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description:
              'Breve razón de la escalación, ej: cliente molesto, pidió hablar con humano, consulta fuera de mi capacidad',
          },
        },
        required: ['reason'],
        additionalProperties: false,
      },
    },
  },
]

export const KUMA_TOOL_NAMES = [
  'check_availability', //revisar horarios
  'book_appointment', // reserrvar
  'confirm_pending_appointment', //confirmar cita pendeinte
  'request_image', // pedir imagen
  'escalate_to_human', //escalar a humano
] as const
export type KumaToolName = (typeof KUMA_TOOL_NAMES)[number]
