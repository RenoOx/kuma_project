// The shape of a node, shared by the catalogue and every file that declares
// nodes. Lives apart from nodeCatalog.ts so the node files can import it without
// importing the catalogue that imports them.

// The fields every node carries. Rendered into the system prompt as the LAST
// block, where an instruction weighs most.
export interface ConversationNode {
  objective: string
  steps: string[]
  edgeCases: string[]
  example: string
  /**
   * The owner's own note for this step. Never set by a blueprint — it exists
   * only to carry what they wrote, appended AFTER the steps rather than
   * replacing them.
   *
   * The distinction is the whole reason this field exists instead of making
   * `steps` editable: the steps are the motor. An owner who could rewrite
   * show_availability's steps could delete "SIEMPRE consultá la disponibilidad
   * real del día pedido", and Emma would start inventing hours.
   */
  extraInstructions?: string
}

// Config a node cannot work without. Checked by validateFlow BEFORE a
// composition is stored, so "the owner saved a flow that cannot run" stops
// being a thing that reaches a customer.
export type NodeRequirement =
  | 'deposit_configured'
  | 'services_configured'
  | 'collect_fields_configured'

// Where an exit leads. 'next' is resolved by the compiler to whatever node the
// owner put after this one — that is the linear part, and it is why the owner
// never writes an edge. Anything else is a fixed jump declared here; the
// compiler drops it when its target is not in the composition.
export type ExitTarget = 'next' | { node: string }

/** A route the OWNER wrote, as opposed to the fixed exits a blueprint declares. */
export interface NodeBranch {
  /**
   * What the model names when it takes this route. Stable and short: it goes in
   * the prompt and comes back in a tool call, so it has to survive being
   * retyped by a language model.
   */
  id: string
  /** The owner's words for when this route applies. Rendered into the prompt. */
  when: string
  /** Id of the step this leads to. Dropped by the compiler if it is not in the flow. */
  to: string
}

export interface NodeBlueprint {
  id: string
  /** Shown in the panel's Conversación card. */
  label: string
  /** Why this node is not always offered, in the owner's words. */
  hint: string
  node: ConversationNode
  /** Tool names the LLM may reach for here. Must exist in KUMA_TOOL_NAMES. */
  tools: string[]
  /** trigger → where it leads. */
  exits: Record<string, ExitTarget>
  /** Refuses entry unless the trigger carries evidence that satisfies it. */
  entryGuard?: 'booking_intent'
  requires?: NodeRequirement[]
  /** Cannot be removed from a composition, and cannot be reordered. */
  mandatory?: boolean
}
