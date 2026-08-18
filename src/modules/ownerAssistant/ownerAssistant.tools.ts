import type { ChatCompletionTool } from 'openai/resources/chat/completions.js'

export const ownerTools: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_daily_summary',
      description:
        'Devuelve el resumen del día: mensajes nuevos, citas agendadas, citas para hoy, escalaciones pendientes. Usar cuando el dueño pregunta "¿cómo va?", "resumen", "qué pasó hoy", etc.',
      parameters: {
        type: 'object',
        properties: {
          date_iso: {
            type: 'string',
            description:
              'Fecha en formato YYYY-MM-DD. Si se omite, se usa el día actual del negocio.',
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
      name: 'get_appointments',
      description:
        'Lista citas agendadas en el rango (incluyendo cliente, servicio, fecha y hora). Usar cuando el dueño pregunta "¿qué tengo mañana?", "agenda de la semana", etc.',
      parameters: {
        type: 'object',
        properties: {
          date_from: {
            type: 'string',
            description: 'Fecha de inicio inclusive en formato YYYY-MM-DD.',
          },
          date_to: {
            type: 'string',
            description: 'Fecha de fin inclusive en formato YYYY-MM-DD.',
          },
        },
        required: ['date_from', 'date_to'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pause_bot',
      description:
        'Pausa al bot para que no responda a clientes. Usar SOLO después de que el dueño confirme expresamente. Hasta until_iso o hasta que se llame resume_bot.',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Motivo breve de la pausa, opcional.',
          },
          until_iso: {
            type: 'string',
            description:
              'Instante hasta el cual la pausa está vigente, ISO 8601 con offset. Si se omite, la pausa es indefinida.',
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
      name: 'resume_bot',
      description: 'Reanuda al bot tras una pausa.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_daily_report_now',
      description:
        'Genera y envía al dueño un reporte estructurado del día actual ahora mismo. Usar cuando el dueño pida cosas como "mandame el reporte", "reporte del día completo", "qué pasó hoy detallado", "forzá el reporte ya". Se DIFERENCIA de get_daily_summary: este envía un mensaje push estructurado al dueño, get_daily_summary solo devuelve métricas para que las incluyas en una respuesta conversacional.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_pending_appointments',
      description:
        'Lista las solicitudes de cita que están esperando la aprobación del dueño (status pendiente). Usar cuando el dueño pregunta "¿qué solicitudes tengo?", "¿hay pendientes?", o ANTES de confirmar/rechazar cuando no está claro a cuál cita se refiere.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'confirm_appointment',
      description:
        'Aprueba una solicitud pendiente: la cita pasa a agendada y el paciente recibe la confirmación por WhatsApp. Usar cuando el dueño dice "confírmala", "acéptala", "dale", refiriéndose a una solicitud concreta.',
      parameters: {
        type: 'object',
        properties: {
          appointment_id: {
            type: 'string',
            description: 'Id de la cita, tal como lo devuelve list_pending_appointments.',
          },
        },
        required: ['appointment_id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reject_appointment',
      description:
        'Rechaza una solicitud pendiente: la cita queda cancelada y el paciente recibe el aviso. Usar SOLO después de que el dueño confirme expresamente que quiere rechazarla.',
      parameters: {
        type: 'object',
        properties: {
          appointment_id: {
            type: 'string',
            description: 'Id de la cita, tal como lo devuelve list_pending_appointments.',
          },
          reason: {
            type: 'string',
            description:
              'Motivo breve que se le comunica al paciente, opcional. Ej: "ese horario se nos ocupó".',
          },
        },
        required: ['appointment_id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reschedule_appointment',
      description:
        'Propone otro horario para una cita: cancela la original y crea una nueva solicitud pendiente en el horario sugerido, avisando al paciente. Usar cuando el dueño dice "ofrécele las 3pm", "mejor el jueves", "proponle otro horario".',
      parameters: {
        type: 'object',
        properties: {
          appointment_id: {
            type: 'string',
            description: 'Id de la cita a mover.',
          },
          suggested_datetime: {
            type: 'string',
            description:
              'Nuevo horario propuesto en ISO 8601 con offset del negocio, ej: 2026-08-19T15:00:00-05:00',
          },
          message: {
            type: 'string',
            description: 'Nota breve del dueño para el paciente, opcional.',
          },
        },
        required: ['appointment_id', 'suggested_datetime'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_appointment',
      description:
        'Cancela una cita en cualquier estado (no solo pendientes) y avisa al paciente. Usar SOLO después de que el dueño confirme expresamente que quiere cancelarla.',
      parameters: {
        type: 'object',
        properties: {
          appointment_id: {
            type: 'string',
            description: 'Id de la cita a cancelar.',
          },
          reason: {
            type: 'string',
            description: 'Motivo breve que se le comunica al paciente, opcional.',
          },
        },
        required: ['appointment_id'],
        additionalProperties: false,
      },
    },
  },
]

// V1.5 (NO IMPLEMENTAR HOY): tools planeadas para expandir el asistente
// - add_knowledge_base_entry(category, content)
// - update_knowledge_base_entry(id, content)
// - send_message_to_customer(customer_id, message)
// - broadcast_to_customers(filter, message)
// Cuando se implementen, agregar al array ownerTools y al
// toolExecutor.ts del owner.
