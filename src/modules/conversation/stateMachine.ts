import { logger } from '@/config/logger.js'
import type { FlowType } from '@/modules/business/business.settings.js'

// The conversation flow is owned by the code, not by the model. This module is
// the single declarative source for it: which states exist per flow, which
// tools the LLM may reach for in each one, what extra instruction the state
// adds to the system prompt, and where each trigger leads.
//
// Pure data plus two lookups — no I/O, no DB, no knowledge of the handler or of
// the LLM client. Nothing imports it yet; it is the definition layer that tool
// filtering and prompt building will read once they are wired up.

// A trigger is whatever moved the conversation: an intent the LLM detected
// ('asks_availability'), something the code observed ('payment_received') or
// elapsed time ('inactive_24h'). Kept as plain strings so a new trigger is a
// data change here, not a type change across the codebase.
export interface StateConfig {
  // Tool names the LLM may call while in this state. Anything else it tries is
  // ignored by the executor. Order is not significant.
  tools: string[]
  // Appended to the variable tail of the system prompt. Tells the model what
  // this step is for; it does NOT decide the flow — the code does.
  // An empty string means the state adds no instruction: whoever injects this
  // has to skip it rather than push a blank line into the prompt.
  promptAddition: string
  // trigger → next state. A trigger absent from this map means "stay put".
  transitions: Record<string, string>
}

export type FlowDefinition = Record<string, StateConfig>

// Every flow starts here, and it is the recovery target when a conversation
// carries a state its flow does not define.
export const INITIAL_STATE = 'idle'

// Available in every state on purpose. A customer can get angry or ask for a
// person at any point, and gating that behind a state is the one restriction
// that would make the service worse rather than safer.
const ESCALATE = 'escalate_to_human'

// Booking flow: clinics, barbershops, aesthetics. Ends on a scheduled slot.
//
// 'confirmed' is deliberately not terminal — a customer who already booked
// comes back with questions, and without an exit that thread would be stuck.
export const appointmentsFlow: FlowDefinition = {
  idle: {
    tools: [ESCALATE],
    promptAddition: '',
    transitions: {
      customer_message: 'greeting',
    },
  },
  greeting: {
    tools: [ESCALATE],
    promptAddition: 'Saluda al paciente con calidez. Detecta si quiere información o una cita.',
    transitions: {
      asks_info: 'informing',
      asks_availability: 'show_availability',
    },
  },
  informing: {
    // Availability opens up here: before this there is neither a service nor a
    // date to look one up with.
    tools: ['check_availability', ESCALATE],
    promptAddition:
      'Responde sobre servicios, precios y horarios usando la base de conocimiento. No intentes agendar todavía.',
    transitions: {
      asks_availability: 'show_availability',
      inactive_24h: 'idle',
    },
  },
  show_availability: {
    tools: ['check_availability', ESCALATE],
    promptAddition:
      'Muestra los horarios disponibles. Pregunta qué día y servicio prefiere si no lo dijo.',
    transitions: {
      picks_time: 'choose_time',
      asks_info: 'informing',
      inactive_24h: 'idle',
    },
  },
  choose_time: {
    // confirm_pending_appointment belongs here: it covers the case where the
    // owner proposed a time outside Emma and the customer is accepting it,
    // which is exactly what this state is waiting on.
    //
    // The deposit gate in toolExecutor stays the authority on whether a
    // book_appointment call actually goes through — this list is a separate
    // layer, not a replacement for it.
    tools: [
      'check_availability',
      'book_appointment',
      'confirm_pending_appointment',
      'request_image',
      ESCALATE,
    ],
    promptAddition: 'El paciente está eligiendo horario. Pide su nombre si no lo tiene.',
    transitions: {
      deposit_required: 'await_payment',
      appointment_booked: 'confirmed',
      asks_availability: 'show_availability',
      inactive_24h: 'idle',
    },
  },
  await_payment: {
    tools: ['request_image', 'book_appointment', ESCALATE],
    promptAddition: 'Pide el comprobante de pago. No hables de horarios ni servicios.',
    transitions: {
      payment_received: 'confirmed',
      inactive_24h: 'idle',
    },
  },
  confirmed: {
    tools: ['confirm_pending_appointment', ESCALATE],
    promptAddition: 'La cita está confirmada. Da un resumen y despídete cálidamente.',
    transitions: {
      asks_info: 'informing',
      inactive_24h: 'idle',
    },
  },
}

// Sales flow: courses, certifications, campaign selling. Ends on a paid
// enrollment with the customer's data collected.
//
// No check_availability and no book_appointment anywhere: there is no slot to
// reserve. Several states carry only ESCALATE because the tools this flow needs
// have not been built yet — see the comments below. No name in this file refers
// to a tool the executor cannot run.
export const salesFlow: FlowDefinition = {
  idle: {
    tools: [ESCALATE],
    promptAddition: '',
    transitions: {
      customer_message: 'greeting',
    },
  },
  greeting: {
    tools: [ESCALATE],
    promptAddition: 'Saluda y detecta por qué producto o curso pregunta.',
    transitions: {
      asks_info: 'informing',
    },
  },
  informing: {
    // NOTE: the instruction mentions sending images, and Emma has no way to
    // send one — mediaForwarder runs customer → owner, never the reverse.
    // Harmless while nothing injects this into the prompt.
    tools: [ESCALATE],
    promptAddition:
      'Informa sobre cursos usando la base de conocimiento. Envía imágenes si están disponibles.',
    transitions: {
      shows_interest: 'send_offer',
      inactive_24h: 'idle',
    },
  },
  send_offer: {
    // No sales-specific tool exists yet: the offer is rendered by the prompt
    // from business settings, not by a tool call.
    tools: [ESCALATE],
    promptAddition: 'Envía los datos de pago: cuentas, montos, métodos.',
    transitions: {
      accepts_offer: 'await_payment',
      asks_info: 'informing',
      inactive_24h: 'idle',
    },
  },
  await_payment: {
    // request_image is the one existing tool that fits this flow as it stands.
    tools: ['request_image', ESCALATE],
    promptAddition: 'Espera el comprobante de pago del cliente.',
    transitions: {
      payment_received: 'collect_data',
      inactive_24h: 'idle',
    },
  },
  collect_data: {
    // Needs a save_customer_data tool (not built). The fields to ask for come
    // from business.settings.collectDataFields.
    tools: [ESCALATE],
    promptAddition: 'Recolecta los datos del cliente uno por uno según los campos configurados.',
    transitions: {
      data_complete: 'confirmed',
      inactive_24h: 'idle',
    },
  },
  confirmed: {
    tools: [ESCALATE],
    promptAddition: 'Inscripción confirmada. Da resumen y despedida.',
    transitions: {
      asks_info: 'informing',
      inactive_24h: 'idle',
    },
  },
}

// Written as a ternary rather than a Record<FlowType, FlowDefinition> so that
// adding a third flowType to the enum breaks the build here, instead of
// silently returning undefined at runtime.
export function getFlowDefinition(flowType: FlowType): FlowDefinition {
  return flowType === 'sales' ? salesFlow : appointmentsFlow
}

// Always returns a config, never undefined: callers filter tools and build
// prompts with it, and there is no sensible "no state" branch for them.
//
// A state can legitimately be missing from a flow — the owner flips flowType
// from appointments to sales while a conversation sits in 'show_availability',
// which salesFlow does not define. Rather than leave that thread dead, we log
// it and treat it as the initial state, so the next message restarts it in the
// new flow.
export function getStateConfig(flowType: FlowType, currentState: string): StateConfig {
  const flow = getFlowDefinition(flowType)
  const config = flow[currentState]
  if (config) return config

  logger.warn(
    { component: 'stateMachine', flowType, currentState },
    'unknown state for flow, falling back to initial state',
  )
  // Safe: both flows define INITIAL_STATE literally above. The assertion is
  // only here because noUncheckedIndexedAccess types every index access as
  // possibly undefined.
  return flow[INITIAL_STATE] as StateConfig
}
