import type { FlowType } from '@/modules/business/business.settings.js'
import type { ImageHandling, NodeIdFor } from '@/modules/conversation/nodeCatalog.js'
import type { FlowComposition, NodeOverride } from '@/modules/conversation/stateMachine.js'

// A business whose conversation is managed from the repo instead of the panel.
//
// The file wins over what the database holds, but only while it still agrees
// with the database on the flow type and still validates against the business's
// current config — see conversation/flowSource.ts, which is the only reader.
// A file that stops agreeing is skipped, never obeyed half-way.

/** One step of the flow, with its wording overrides next to it. */
export interface BusinessStep<F extends FlowType> {
  node: NodeIdFor<F>
  /** What the panel calls this step. Cosmetic. */
  label?: string
  /** Replace the catalogue's special cases for this step. */
  edgeCases?: string[]
  /** Replace the catalogue's tone sample for this step. */
  example?: string
  /** Added after the catalogue's steps, never replacing them. */
  extraInstructions?: string
  /** Owner-written ways out of this step, on top of its fixed exits. */
  routes?: Array<{ id: string; when: string; to: NodeIdFor<F> }>
  /** La invitación de cierre de este paso, tal cual. */
  cta?: string
  /** Qué hacer si el cliente manda una foto en este paso. */
  onImage?: ImageHandling
}

export interface BusinessConfigInput<F extends FlowType> {
  businessId: string
  /** For whoever reads the file. Never applied. */
  name: string
  /** Has to match the database, or the file is skipped. */
  flowType: F
  /** The conversation, in order. */
  flow: BusinessStep<F>[]
}

export interface BusinessConfig {
  businessId: string
  name: string
  flowType: FlowType
  composition: FlowComposition
}

function overrideOf<F extends FlowType>(step: BusinessStep<F>): NodeOverride | null {
  const override: NodeOverride = {
    ...(step.label !== undefined ? { label: step.label } : {}),
    ...(step.edgeCases !== undefined ? { edgeCases: step.edgeCases } : {}),
    ...(step.example !== undefined ? { example: step.example } : {}),
    ...(step.extraInstructions !== undefined ? { extraInstructions: step.extraInstructions } : {}),
    ...(step.routes !== undefined ? { branches: step.routes } : {}),
    ...(step.cta !== undefined ? { cta: step.cta } : {}),
    ...(step.onImage !== undefined ? { onImage: step.onImage } : {}),
  }
  return Object.keys(override).length > 0 ? override : null
}

/**
 * Turns the readable file into the composition the database would hold.
 *
 * `flowType` is inferred as a literal from the file, which is what narrows
 * `node` and `routes[].to` to the ids that flow type may use: an institute's
 * file that names `show_availability` does not compile.
 */
export function defineBusinessConfig<const F extends FlowType>(
  input: BusinessConfigInput<F>,
): BusinessConfig {
  const overrides: Record<string, NodeOverride> = {}
  for (const step of input.flow) {
    const override = overrideOf(step)
    if (override) overrides[step.node] = override
  }
  return {
    businessId: input.businessId,
    name: input.name,
    flowType: input.flowType,
    composition: { nodes: input.flow.map((step) => step.node), overrides },
  }
}
