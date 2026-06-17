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
]

// V1.5 (NO IMPLEMENTAR HOY): tools planeadas para expandir el asistente
// - add_knowledge_base_entry(category, content)
// - update_knowledge_base_entry(id, content)
// - cancel_appointment(appointment_id)
// - reschedule_appointment(appointment_id, new_datetime_iso)
// - send_message_to_customer(customer_id, message)
// - broadcast_to_customers(filter, message)
// Cuando se implementen, agregar al array ownerTools y al
// toolExecutor.ts del owner.
