import { logger } from '@/config/logger.js'
import type { FlowType } from '@/modules/business/business.settings.js'

// The conversation flow is owned by the code, not by the model. This module is
// the single declarative source for it: which states exist per flow, which
// tools the LLM may reach for in each one, what extra instruction the state
// adds to the system prompt, and where each trigger leads.
//
// Pure data plus two lookups — no I/O, no DB, no knowledge of the handler or of
// the LLM client. llm.service reads it to filter the tools it offers the model
// and to append the state's instruction to the system prompt; applying the
// transitions is the handler's job.

// A trigger is whatever moved the conversation: an intent the LLM detected
// ('asks_availability'), something the code observed ('payment_received') or
// elapsed time ('inactive_24h'). Kept as plain strings so a new trigger is a
// data change here, not a type change across the codebase.
// What a state can demand of whatever is trying to enter it.
//
// 'booking_intent' means: a service, a slot and a name were frozen for this
// conversation and the emitter can prove it. Only the deposit gate can, because
// freezing them is what it does (toolExecutor's book_appointment branch) — and
// that is precisely the precondition await_payment exists on.
export type EntryGuard = 'booking_intent'

// Proof an emitter hands along with its trigger. A missing field reads as
// false: a caller that knows nothing satisfies no guard, which is the point of
// having one.
export interface TransitionEvidence {
  bookingIntent?: boolean
}

// Written as a switch over the closed union so that adding a guard breaks the
// build here rather than silently refusing every transition into its state —
// same reasoning as getFlowDefinition's ternary below.
function satisfiesGuard(guard: EntryGuard, evidence: TransitionEvidence | undefined): boolean {
  switch (guard) {
    case 'booking_intent':
      return evidence?.bookingIntent === true
  }
}

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
  // Refuses entry unless the trigger arrives with evidence that satisfies this.
  // Absent — the common case — means anything routing here gets in.
  entryGuard?: EntryGuard
}

export type FlowDefinition = Record<string, StateConfig>

// Every flow starts here, and it is the recovery target when a conversation
// carries a state its flow does not define.
export const INITIAL_STATE = 'idle'

// Available in every state on purpose. A customer can get angry or ask for a
// person at any point, and gating that behind a state is the one restriction
// that would make the service worse rather than safer.
const ESCALATE = 'escalate_to_human'

// Near-universal for a related reason. The owner can propose a slot outside
// Emma, and the customer comes back to accept it days later — from idle, from
// informing, from wherever the thread happens to sit. Offering this only in
// choose_time left those customers with the intent understood and no way to act
// on it, because no trigger routes them back there either.
//
// Calling it with nothing pending is a handled case, not a misfire: the
// executor answers 'no_pending_appointment' and tells the model to carry on
// without claiming it confirmed anything.
//
// await_payment is the one exclusion — see the comment there.
const PENDING_CONFIRM = 'confirm_pending_appointment'

// Booking flow: clinics, barbershops, aesthetics. Ends on a scheduled slot.
//
// 'confirmed' is deliberately not terminal — a customer who already booked
// comes back with questions, and without an exit that thread would be stuck.
export const appointmentsFlow: FlowDefinition = {
  idle: {
    tools: [PENDING_CONFIRM, ESCALATE],
    promptAddition: '',
    transitions: {
      customer_message: 'greeting',
    },
  },
  greeting: {
    // check_availability lives here because otherwise the state has no way out:
    // asks_availability is its only exit and nothing but that tool produces it.
    // It also matches how threads actually open — "hola, ¿tienen cita mañana?"
    // is one message, not two.
    tools: ['check_availability', PENDING_CONFIRM, ESCALATE],
    promptAddition: 'Saluda al paciente con calidez. Detecta si quiere información o una cita.',
    transitions: {
      asks_info: 'informing',
      asks_availability: 'show_availability',
      // Wherever PENDING_CONFIRM is offered, the state needs somewhere to land
      // when it succeeds — otherwise the appointment is confirmed in the
      // database and the conversation stays parked.
      appointment_booked: 'confirmed',
    },
  },
  informing: {
    // UNREACHABLE TODAY. The only way in is asks_info, an intent no tool
    // reports, and nothing infers intents from the customer's text yet. Kept
    // whole rather than deleted: the config is right and the state comes back
    // to life the day a trigger source for intents exists.
    tools: ['check_availability', PENDING_CONFIRM, ESCALATE],
    promptAddition:
      'Responde sobre servicios, precios y horarios usando la base de conocimiento. No intentes agendar todavía.',
    transitions: {
      asks_availability: 'show_availability',
      appointment_booked: 'confirmed',
      inactive_24h: 'idle',
    },
  },
  show_availability: {
    // Carries the booking tools as well, because picks_time — the only route to
    // choose_time — is an intent nothing reports. Without them a customer who
    // has just been shown the times has no way to take one.
    tools: ['check_availability', 'book_appointment', PENDING_CONFIRM, 'request_image', ESCALATE],
    promptAddition:
      'Muestra los horarios disponibles. Pregunta qué día y servicio prefiere si no lo dijo.',
    transitions: {
      picks_time: 'choose_time',
      asks_info: 'informing',
      // Same outcomes choose_time has, for the same reason its tools are here.
      deposit_required: 'await_payment',
      appointment_booked: 'confirmed',
      inactive_24h: 'idle',
    },
  },
  choose_time: {
    // UNREACHABLE TODAY, same reason as informing: picks_time is an intent no
    // tool reports. show_availability carries this state's tools and outcomes in
    // the meantime, so nothing is lost while it waits.
    //
    // The customer here has a service and a time in hand, so booking,
    // re-checking and asking for the deposit capture are all live at once.
    //
    // The deposit gate in toolExecutor stays the authority on whether a
    // book_appointment call actually goes through — this list is a separate
    // layer, not a replacement for it.
    tools: ['check_availability', 'book_appointment', PENDING_CONFIRM, 'request_image', ESCALATE],
    promptAddition: 'El paciente está eligiendo horario. Pide su nombre si no lo tiene.',
    transitions: {
      deposit_required: 'await_payment',
      appointment_booked: 'confirmed',
      asks_availability: 'show_availability',
      inactive_24h: 'idle',
    },
  },
  await_payment: {
    // The one state that withholds PENDING_CONFIRM. That tool does not pass the
    // deposit gate — the gate lives in the book_appointment branch of
    // toolExecutor — so offering it here would let a customer confirm an
    // owner-proposed appointment without ever sending the capture, which is the
    // exact thing this state exists to wait for. book_appointment stays: it is
    // the one path that closes a booking AND goes through the gate.
    tools: ['request_image', 'book_appointment', ESCALATE],
    // Nothing enters here without a frozen booking intent behind it. The state
    // means "we are waiting on the capture that pays for a specific slot", and
    // a customer parked here without one is unrecoverable: the prompt forbids
    // talking about times, images never reach the model, and the capture that
    // does arrive has no intent to attach to — so the owner gets a photo and
    // nothing to approve.
    //
    // Today the only emitter of deposit_required is the deposit gate, which
    // freezes service + slot + name before it refuses (toolExecutor). This
    // guard is what keeps that true for the next emitter as well.
    entryGuard: 'booking_intent',
    promptAddition: 'Pide el comprobante de pago. No hables de horarios ni servicios.',
    transitions: {
      // The capture lands and the booking is NOT filed — it waits for the owner
      // to look at the money. This used to be `payment_received: 'confirmed'`,
      // which treated a photo as proof of payment: Emma cannot see the image,
      // so all it ever proved was that something had been sent.
      payment_capture_received: 'await_payment_verification',
      // book_appointment is offered above, so its success needs somewhere to
      // land — same rule as greeting. It fires whenever the gate is open: the
      // customer already has recent payment evidence, or the owner turned
      // requiresDeposit off while the thread sat here.
      appointment_booked: 'confirmed',
      // Rescue exit, for a capture that reaches the handler with no booking
      // intent to attach to — no live expectation and no verification row for
      // this conversation either. Without a way back the thread is stranded in
      // a state whose own prompt forbids talking about times.
      // check_availability deliberately stays out of this state's tools: the
      // way back opens when the flow asks for availability again, not by this
      // state going looking for it.
      asks_availability: 'show_availability',
      inactive_24h: 'idle',
    },
  },
  await_payment_verification: {
    // Only ESCALATE, and the exclusions are the point of the state.
    //
    // book_appointment is out because nothing the customer says should be able
    // to close a booking whose payment a person has not looked at yet. The
    // deposit gate refuses it here too, so this is the second of two locks on
    // the same door — the state never offers the tool, and the executor would
    // turn it down anyway. PENDING_CONFIRM is out for the reason it is out of
    // await_payment: it does not pass that gate at all. request_image is out
    // because the capture already arrived; asking for another one is how a
    // customer ends up sending the same screenshot three times.
    //
    // The way out is not the customer's to take: only the owner's approve /
    // reject moves this state.
    tools: [ESCALATE],
    promptAddition:
      'El paciente ya envió su comprobante y el pago está en verificación. NO confirmes la cita, NO hables de horarios y NO le pidas otra captura. Si pregunta, decile que su comprobante se está verificando y que le confirmás en un momento.',
    transitions: {
      payment_approved: 'confirmed',
      payment_rejected: 'await_payment',
      inactive_24h: 'idle',
    },
  },
  confirmed: {
    tools: [PENDING_CONFIRM, ESCALATE],
    promptAddition: 'La cita está confirmada. Da un resumen y despídete cálidamente.',
    transitions: {
      // The one exit that actually fires today. Nothing closes a conversation
      // (conversation.service's close has no callers) and getOrCreateOpen reuses
      // the customer's open thread, so without this a patient who booked once
      // stays here for good: no check_availability, and a prompt that only says
      // goodbye. A barbershop's customers all come back — that is the common
      // case, not an edge one. The two below still have no producer.
      customer_message: 'greeting',
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
// Where a trigger leads from here. A trigger the state does not list means
// "stay put" — that is the documented default, not an error, and most triggers
// most of the time hit it.
//
// Pure lookup by design: persisting the answer is conversation.service's job,
// and it is the only place allowed to write conversation.state.
export function getNextState(
  flowType: FlowType,
  currentState: string,
  trigger: string,
  evidence?: TransitionEvidence,
): string {
  const nextState = getStateConfig(flowType, currentState).transitions[trigger] ?? currentState
  if (nextState === currentState) return currentState

  // A refused transition stays put, which is the same answer as "this state
  // defines no transition for that trigger" — so callers need no new branch and
  // no new error path for it.
  const guard = getStateConfig(flowType, nextState).entryGuard
  if (guard && !satisfiesGuard(guard, evidence)) {
    logger.warn(
      { component: 'stateMachine', flowType, currentState, trigger, nextState, guard },
      'entry guard blocked transition',
    )
    return currentState
  }

  return nextState
}

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
