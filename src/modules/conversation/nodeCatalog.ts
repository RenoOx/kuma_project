import type { BusinessSettings, FlowType } from '@/modules/business/business.settings.js'
import { activeServices } from '@/modules/business/business.settings.js'
import { APPOINTMENT_NODES } from './nodes/appointments.nodes.js'
import { ADVANCE_FLOW } from './nodes/building-blocks.js'
import { CORE_ENTRY_NODES, CORE_EXIT_NODES } from './nodes/core.nodes.js'
import { SALES_NODES } from './nodes/sales.nodes.js'
import type { NodeBlueprint, NodeRequirement } from './nodes/types.js'

export type {
  ConversationNode,
  ExitTarget,
  NodeBlueprint,
  NodeBranch,
  NodeRequirement,
} from './nodes/types.js'

// The closed catalogue of conversation nodes.
//
// This is the brick box. A business does not write a flow: it composes one by
// picking nodes from here, in order, and overriding their wording. Everything
// that decides BEHAVIOUR — which tools a node offers, which triggers move it,
// what it guards — lives in the blueprint and is ours. Everything that decides
// WORDING is overridable by the owner.
//
// A node can only offer tools the executor can run, and can only advance on a
// trigger something in the code emits. That is not a limitation of the design,
// it is the whole point of it: the flow that was configurable before this
// module had six declared triggers nobody emitted, and a sales business that
// answered once and then went silent forever.
//
// The nodes themselves live in nodes/, one file per flow type plus the core
// every business shares. appointments and sales never import each other, so a
// change meant for one of them cannot reach the other.

/**
 * Every trigger something in this codebase actually emits, with the emitter.
 *
 * Hand-maintained on purpose: there is no way to introspect "does any code path
 * produce this string", and the alternative — trusting the flow definition —
 * is exactly what let six triggers sit in the state machine for months routing
 * nowhere. validateFlow refuses any composition that depends on a trigger
 * missing from this set, so adding an exit without its emitter fails loudly at
 * save time instead of quietly at 2am in a customer's chat.
 */
export const EMITTED_TRIGGERS: ReadonlyMap<string, string> = new Map([
  ['customer_message', 'llm.service.ts — every inbound customer message'],
  ['asks_availability', 'toolExecutor.ts — check_availability'],
  ['appointment_booked', 'toolExecutor.ts — book_appointment / confirm_pending_appointment'],
  ['deposit_required', 'toolExecutor.ts — the deposit gate'],
  ['payment_capture_received', 'handler.ts — customer image received'],
  ['payment_received', 'handler.ts — customer image received (sales)'],
  ['payment_approved', 'paymentVerification.service.ts — owner approved'],
  ['payment_rejected', 'paymentVerification.service.ts — owner rejected'],
  ['services_listed', 'toolExecutor.ts — show_services'],
  ['data_complete', 'toolExecutor.ts — save_customer_data'],
  ['summary_confirmed', 'toolExecutor.ts — confirm_summary'],
  ['correction_requested', 'toolExecutor.ts — confirm_summary (customer said no)'],
  ['field_corrected', 'toolExecutor.ts — correct_field'],
  ['route_selected', 'toolExecutor.ts — advance_flow'],
])

/**
 * The trigger every owner-written route fires.
 *
 * One trigger for all of them, with the branch travelling as evidence rather
 * than as its own trigger name. The alternative — a trigger per route — would
 * put owner-typed strings into EMITTED_TRIGGERS, which is the registry of what
 * the CODE can fire, and would turn a hand-maintained safety net into a list
 * anyone can append to.
 */
export const ROUTE_TRIGGER = 'route_selected'

/** The tool a step gets automatically once the owner gives it a route. */
export const ROUTE_TOOL = ADVANCE_FLOW

// Universal exit. Added by the compiler to every node, so no blueprint declares
// it and no owner can remove it.
export const IDLE_TRIGGER = 'inactive_24h'

/** Node ids each flow type may compose, known to the compiler as literals. */
export type CoreNodeId =
  | (typeof CORE_ENTRY_NODES)[number]['id']
  | (typeof CORE_EXIT_NODES)[number]['id']
export type AppointmentNodeId = (typeof APPOINTMENT_NODES)[number]['id']
export type SalesNodeId = (typeof SALES_NODES)[number]['id']
export type NodeIdFor<F extends FlowType> =
  | CoreNodeId
  | (F extends 'appointments' ? AppointmentNodeId : SalesNodeId)

/**
 * The bricks, in the order the panel lists them.
 *
 * `idle`, `greeting` and `confirmed` are mandatory: a conversation has to start
 * somewhere and end somewhere, and a flow whose first node can be removed is a
 * flow that can be saved with no entry point.
 */
export const NODE_CATALOG: ReadonlyArray<NodeBlueprint> = [
  ...CORE_ENTRY_NODES,
  ...APPOINTMENT_NODES,
  ...SALES_NODES,
  ...CORE_EXIT_NODES,
]

export const NODE_BY_ID: ReadonlyMap<string, NodeBlueprint> = new Map(
  NODE_CATALOG.map((n) => [n.id, n]),
)

const FLOW_NODES: Record<FlowType, ReadonlyArray<NodeBlueprint>> = {
  appointments: APPOINTMENT_NODES,
  sales: SALES_NODES,
}

/** What a business of this flow type may compose: the core plus its own nodes, in panel order. */
export function nodesForFlow(flowType: FlowType): ReadonlyArray<NodeBlueprint> {
  return [...CORE_ENTRY_NODES, ...FLOW_NODES[flowType], ...CORE_EXIT_NODES]
}

/** Whether the business config a node depends on is actually there. */
export function requirementMet(req: NodeRequirement, settings: BusinessSettings | null): boolean {
  if (!settings) return false
  switch (req) {
    case 'deposit_configured':
      return settings.requiresDeposit
    case 'services_configured':
      return activeServices(settings).length > 0
    case 'collect_fields_configured':
      return settings.collectDataFields.length > 0
  }
}
