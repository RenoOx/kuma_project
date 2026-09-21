import { logger } from '@/config/logger.js'
import type { BusinessSettings } from '@/modules/business/business.settings.js'
import { AppError } from '@/shared/errors.js'
import { err, ok, type Result } from '@/shared/result.js'
import {
  type ConversationNode,
  EMITTED_TRIGGERS,
  type ExitTarget,
  IDLE_TRIGGER,
  NODE_BY_ID,
  type NodeBlueprint,
  requirementMet,
} from './nodeCatalog.js'

// The conversation flow is owned by the code, not by the model — and now it is
// COMPOSED rather than written. A business picks nodes from nodeCatalog, in
// order; this module turns that list into the flow definition the rest of the
// app already knew how to read, and refuses to compile one that cannot run.
//
// Pure data plus lookups: no I/O, no DB, no knowledge of the handler or of the
// LLM client. llm.service reads it to filter the tools it offers the model and
// to render the node block into the system prompt; applying the transitions is
// conversation.service's job.

// What a node can demand of whatever is trying to enter it.
//
// 'booking_intent' means: a service, a slot and a name were frozen for this
// conversation and the emitter can prove it. Only the deposit gate can, because
// freezing them is what it does — and that is precisely the precondition
// await_payment exists on.
export type EntryGuard = 'booking_intent'

// Proof an emitter hands along with its trigger. A missing field reads as
// false: a caller that knows nothing satisfies no guard, which is the point of
// having one.
export interface TransitionEvidence {
  bookingIntent?: boolean
}

// Written as a switch over the closed union so that adding a guard breaks the
// build here rather than silently refusing every transition into its node.
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
  // The four-field block rendered into the system prompt. Replaces the single
  // promptAddition sentence each state used to carry: that sentence was all a
  // state could say, which is why every rule about the flow had to live in the
  // global prompt body and be sent in every state.
  node: ConversationNode
  // trigger → next state. A trigger absent from this map means "stay put".
  transitions: Record<string, string>
  // Refuses entry unless the trigger arrives with evidence that satisfies this.
  entryGuard?: EntryGuard
}

export type FlowDefinition = Record<string, StateConfig>

// Every flow starts here, and it is the recovery target when a conversation
// carries a state its flow does not define.
export const INITIAL_STATE = 'idle'

/** What the owner composed: which nodes, in what order, and their wording. */
export interface FlowComposition {
  nodes: string[]
  overrides: Record<string, { edgeCases?: string[]; example?: string }>
}

// ── Presets ──────────────────────────────────────────────────────────────────
//
// A business type is a composition, not a branch. Adding "informational only"
// used to mean a new flowType, a new literal flow and a new ternary; here it is
// four node ids.

const PRESET_APPOINTMENTS = [
  'idle',
  'greeting',
  'informing',
  'listado_servicios',
  'show_availability',
  'confirmed',
]

const PRESET_APPOINTMENTS_DEPOSIT = [
  'idle',
  'greeting',
  'informing',
  'listado_servicios',
  'show_availability',
  'await_payment',
  'await_payment_verification',
  'confirmed',
]

// The selling flow is NOT composable yet, and saying so here is the point.
//
// It needs one more brick — the tool that records "the customer accepted and
// wants to pay" — and that tool cannot be written without a frozen intent that
// has no slot in it: today's FrozenBooking demands a scheduledAtISO, and making
// one up would show the owner an appointment time that was never agreed.
//
// Until that lands, a selling business gets the informational flow. That is a
// flow that WORKS: it greets, advises and lists services. The alternative is
// what shipped before this module — a flow whose only exit nothing emitted, so
// the business answered once and went silent forever.

/** Nothing to book and nothing to charge: the business only answers questions. */
const PRESET_INFO_ONLY = ['idle', 'greeting', 'informing', 'listado_servicios']

/**
 * The composition a business gets when it has not customised one.
 *
 * Derived from settings rather than stored, so a business that turns the
 * deposit on gets the two payment nodes without anyone migrating a row — and
 * one that turns it off stops carrying nodes it cannot satisfy.
 */
export function presetFor(settings: BusinessSettings | null): FlowComposition {
  const nodes = ((): string[] => {
    if (!settings) return PRESET_INFO_ONLY
    if (settings.flowType === 'sales') return PRESET_INFO_ONLY
    return settings.requiresDeposit ? PRESET_APPOINTMENTS_DEPOSIT : PRESET_APPOINTMENTS
  })()

  // A preset must satisfy its own requirements, or the business would be handed
  // a flow that validateFlow would refuse. Dropping the nodes whose config is
  // missing is what makes "unconfigured business" a shorter flow rather than a
  // broken one.
  return {
    nodes: nodes.filter((id) => {
      const bp = NODE_BY_ID.get(id)
      return bp ? (bp.requires ?? []).every((r) => requirementMet(r, settings)) : false
    }),
    overrides: {},
  }
}

// ── Compiler ─────────────────────────────────────────────────────────────────

function resolveExit(
  target: ExitTarget,
  index: number,
  nodes: string[],
  present: ReadonlySet<string>,
): string | null {
  if (target === 'next') {
    const next = nodes[index + 1]
    return next ?? null
  }
  // A jump to a node the owner did not include is dropped, not an error: that
  // is exactly how "no deposit" turns into "no payment nodes" without every
  // blueprint needing to know which composition it landed in.
  return present.has(target.node) ? target.node : null
}

/**
 * Turns a composition into the flow definition the app reads.
 *
 * Total by construction: an unknown node id is skipped and an unresolvable exit
 * is dropped, so a composition that somehow got past validateFlow still yields
 * a flow that runs rather than a crash in the middle of a conversation.
 */
export function compileFlow(composition: FlowComposition): FlowDefinition {
  const nodes = composition.nodes.filter((id) => NODE_BY_ID.has(id))
  const present = new Set(nodes)
  const flow: FlowDefinition = {}

  nodes.forEach((id, index) => {
    const bp = NODE_BY_ID.get(id) as NodeBlueprint
    const transitions: Record<string, string> = {}

    for (const [trigger, target] of Object.entries(bp.exits)) {
      const resolved = resolveExit(target, index, nodes, present)
      if (resolved) transitions[trigger] = resolved
    }

    // Universal, and deliberately not declarable in a blueprint: every node but
    // idle can time out, and an owner must not be able to compose that away.
    if (id !== INITIAL_STATE && present.has(INITIAL_STATE)) {
      transitions[IDLE_TRIGGER] = INITIAL_STATE
    }

    const override = composition.overrides[id]
    flow[id] = {
      tools: bp.tools,
      node: {
        // Objective and steps are the motor and are never the owner's: what
        // moves is the wording that steers the model, not the contract the code
        // relies on.
        objective: bp.node.objective,
        steps: bp.node.steps,
        edgeCases: override?.edgeCases ?? bp.node.edgeCases,
        example: override?.example ?? bp.node.example,
      },
      transitions,
      ...(bp.entryGuard ? { entryGuard: bp.entryGuard } : {}),
    }
  })

  return flow
}

// ── Validator ────────────────────────────────────────────────────────────────

// Mirrors KUMA_TOOL_NAMES. Declared here rather than imported from the llm
// module so that conversation stays free of a dependency on it — the import
// would be the only edge between the two, and it would point the wrong way.
const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set([
  'check_availability',
  'book_appointment',
  'confirm_pending_appointment',
  'send_service_media',
  'request_image',
  'escalate_to_human',
  'show_services',
  'save_customer_data',
  'confirm_summary',
  'correct_field',
])

export interface FlowProblem {
  node: string
  reason: string
}

/**
 * Refuses a composition that cannot run, BEFORE it is stored.
 *
 * This is the whole promise of a configurable flow: a saved flow is a flow that
 * works. Without it, composing is just a faster way to reproduce the bug this
 * module was built to kill — a sales business whose only exit from greeting was
 * a trigger nothing emitted, which answered once and then went silent.
 */
export function validateFlow(
  composition: FlowComposition,
  settings: BusinessSettings | null,
): Result<FlowComposition> {
  const problems: FlowProblem[] = []
  const { nodes } = composition

  const seen = new Set<string>()
  for (const id of nodes) {
    if (!NODE_BY_ID.has(id)) problems.push({ node: id, reason: 'no existe en el catálogo' })
    if (seen.has(id)) problems.push({ node: id, reason: 'está repetido' })
    seen.add(id)
  }

  // Entry and exit are not negotiable: a flow with no idle has nowhere for a
  // conversation to start, and one with no greeting has nothing to say first.
  if (nodes[0] !== INITIAL_STATE) {
    problems.push({ node: INITIAL_STATE, reason: 'tiene que ser el primer paso' })
  }
  if (!seen.has('greeting')) {
    problems.push({ node: 'greeting', reason: 'es obligatorio y falta' })
  }

  for (const id of nodes) {
    const bp = NODE_BY_ID.get(id)
    if (!bp) continue
    for (const req of bp.requires ?? []) {
      if (!requirementMet(req, settings)) {
        problems.push({ node: id, reason: `necesita configuración que falta (${req})` })
      }
    }
    for (const tool of bp.tools) {
      if (!KNOWN_TOOL_NAMES.has(tool)) {
        problems.push({ node: id, reason: `usa una herramienta inexistente (${tool})` })
      }
    }
  }

  const flow = compileFlow(composition)
  const ids = Object.keys(flow)

  // Every exit a node keeps has to be one something in the code can actually
  // fire. An exit whose trigger has no emitter is a dead end that looks alive.
  for (const id of ids) {
    const config = flow[id] as StateConfig
    const live = Object.keys(config.transitions).filter(
      (t) => EMITTED_TRIGGERS.has(t) || t === IDLE_TRIGGER,
    )
    for (const trigger of Object.keys(config.transitions)) {
      if (!EMITTED_TRIGGERS.has(trigger) && trigger !== IDLE_TRIGGER) {
        problems.push({ node: id, reason: `nadie emite el trigger "${trigger}"` })
      }
    }
    // inactive_24h alone is not a way forward — it only sends the thread back to
    // idle. The last node is allowed to be a dead end; every other one is not.
    const forward = live.filter((t) => t !== IDLE_TRIGGER)
    if (forward.length === 0 && id !== nodes[nodes.length - 1]) {
      problems.push({ node: id, reason: 'no tiene salida: la conversación se quedaría ahí' })
    }
  }

  // Reachability from idle. This is the check that would have caught sales.
  const reached = new Set<string>([INITIAL_STATE])
  const queue = [INITIAL_STATE]
  while (queue.length > 0) {
    const current = queue.shift() as string
    const config = flow[current]
    if (!config) continue
    for (const target of Object.values(config.transitions)) {
      if (!reached.has(target)) {
        reached.add(target)
        queue.push(target)
      }
    }
  }
  for (const id of ids) {
    if (!reached.has(id)) {
      problems.push({ node: id, reason: 'es inalcanzable: ningún paso lleva hasta él' })
    }
  }

  if (problems.length > 0) {
    return err(
      new AppError({
        code: 'invalid_conversation_flow',
        message: `invalid flow composition: ${problems
          .map((p) => `${p.node} ${p.reason}`)
          .join('; ')}`,
        userMessage: `No pudimos guardar el flujo: ${problems
          .map((p) => `"${NODE_BY_ID.get(p.node)?.label ?? p.node}" ${p.reason}`)
          .join('; ')}.`,
        logContext: { problems },
      }),
    )
  }

  return ok(composition)
}

// ── Reads ────────────────────────────────────────────────────────────────────

const EMPTY_NODE: ConversationNode = { objective: '', steps: [], edgeCases: [], example: '' }

/**
 * The flow a business is actually running.
 *
 * Falls back to the preset when the owner has not composed one, and ALSO when
 * what they composed no longer validates — a flow that stopped being runnable
 * because the deposit was switched off must not take the conversation down with
 * it. The fallback is logged, because it means the panel is showing the owner
 * something different from what Emma is doing.
 */
export function resolveFlow(settings: BusinessSettings | null): FlowDefinition {
  const stored = settings?.conversationFlow
  if (!stored) return compileFlow(presetFor(settings))

  const checked = validateFlow(stored, settings)
  if (!checked.ok) {
    logger.warn(
      { component: 'stateMachine', code: checked.error.code, ...checked.error.logContext },
      'stored conversation flow does not validate, falling back to preset',
    )
    return compileFlow(presetFor(settings))
  }
  return compileFlow(stored)
}

/**
 * Where a trigger leads from here. A trigger the state does not list means
 * "stay put" — the documented default, not an error.
 *
 * Pure lookup by design: persisting the answer is conversation.service's job,
 * and it is the only place allowed to write conversation.state.
 */
export function getNextState(
  flow: FlowDefinition,
  currentState: string,
  trigger: string,
  evidence?: TransitionEvidence,
): string {
  const nextState = getStateConfig(flow, currentState).transitions[trigger] ?? currentState
  if (nextState === currentState) return currentState

  // A refused transition stays put, which is the same answer as "this state
  // defines no transition for that trigger" — so callers need no new branch and
  // no new error path for it.
  const guard = getStateConfig(flow, nextState).entryGuard
  if (guard && !satisfiesGuard(guard, evidence)) {
    logger.warn(
      { component: 'stateMachine', currentState, trigger, nextState, guard },
      'entry guard blocked transition',
    )
    return currentState
  }

  return nextState
}

/**
 * Always returns a config, never undefined: callers filter tools and build
 * prompts with it, and there is no sensible "no state" branch for them.
 *
 * A state can legitimately be missing — the owner removes a node while a
 * conversation sits in it. Rather than leave that thread dead, we log it and
 * treat it as the initial state, so the next message restarts it in the flow
 * that now exists.
 */
export function getStateConfig(flow: FlowDefinition, currentState: string): StateConfig {
  const config = flow[currentState]
  if (config) return config

  logger.warn(
    { component: 'stateMachine', currentState },
    'unknown state for flow, falling back to initial state',
  )
  const initial = flow[INITIAL_STATE]
  if (initial) return initial

  // A composition without idle cannot get past validateFlow, so this is the
  // shape of "somebody hand-edited the jsonb": answer with a node that offers
  // nothing rather than throw inside a conversation.
  return { tools: [], node: EMPTY_NODE, transitions: {} }
}
