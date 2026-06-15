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
        'Agenda una cita en un horario específico. Solo usar cuando el cliente confirmó fecha, hora y servicio exactos.',
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
        },
        required: ['datetime_iso', 'service'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'escalate_to_human',
      description:
        'Marca la conversación para que un humano la atienda. Usar cuando el cliente está molesto, pide hablar con persona, o pide algo que no podés resolver con tus herramientas.',
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

export const KUMA_TOOL_NAMES = ['check_availability', 'book_appointment', 'escalate_to_human'] as const
export type KumaToolName = (typeof KUMA_TOOL_NAMES)[number]
