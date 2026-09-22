import type { ConversationCatalog, ConversationFlow, ConversationNodeOption } from '../api/types.js'

/**
 * Turns the owner's draft into the graph the diagram draws.
 *
 * This file MIRRORS `resolveExit` and `compileFlow` in
 * `src/modules/conversation/stateMachine.ts`, and that duplication is deliberate
 * and bounded. The alternative was to have the server send an already-resolved
 * graph, which cannot work here: the diagram has to redraw while the owner drags
 * a step around, before anything is saved, so a graph that only changes on PATCH
 * would show them the flow they used to have.
 *
 * It is the same trade `api/types.ts` already makes — the two builds use
 * different tsconfigs, so sharing the real code would drag the server into the
 * browser bundle.
 *
 * **This decides nothing.** It draws a picture. `validateFlow` on the server is
 * still the only thing that says whether a composition may be stored, and it
 * runs against the merged settings after the panel has had its say. If this file
 * ever disagrees with the compiler, the picture is wrong and the flow is right.
 */

/** Steps are laid out top to bottom; an edge is one arrow between two of them. */
export interface FlowEdge {
  from: string
  to: string
  /** A fixed exit declared by the step, or a route the owner wrote. */
  kind: 'fixed' | 'branch'
  /** The trigger name for a fixed exit, or the owner's condition for a route. */
  label: string
}

export interface FlowGraph {
  /** Node ids in composition order, `idle` first. */
  order: string[]
  edges: FlowEdge[]
}

/**
 * The universal timeout edge, injected by the compiler into every step but
 * `idle`. Left out of the picture on purpose: drawing it would add an arrow from
 * every node back to the start and turn a readable flow into a hairball. The
 * card says so in words instead.
 */
const HIDDEN_TRIGGER = 'inactive_24h'

/**
 * Mirrors `resolveExit`: `'next'` is the following step in the composition,
 * a fixed jump survives only if its target is part of it.
 */
function resolveExits(
  node: ConversationNodeOption,
  index: number,
  order: string[],
  present: ReadonlySet<string>,
): FlowEdge[] {
  const edges: FlowEdge[] = []

  for (const [trigger, target] of Object.entries(node.exits)) {
    if (trigger === HIDDEN_TRIGGER) continue

    const to = target === 'next' ? order[index + 1] : present.has(target.node) ? target.node : null
    if (!to) continue

    edges.push({ from: node.id, to, kind: 'fixed', label: trigger })
  }

  return edges
}

/**
 * The graph for a draft that has not been saved yet.
 *
 * Unknown node ids are skipped rather than thrown on, the same way the compiler
 * does: a draft is a thing being edited, and half-built is its normal state.
 */
export function buildFlowGraph(draft: ConversationFlow, catalog: ConversationCatalog): FlowGraph {
  const byId = new Map(catalog.nodes.map((node) => [node.id, node]))
  const order = draft.nodes.filter((id) => byId.has(id))
  const present = new Set(order)

  const edges: FlowEdge[] = []

  order.forEach((id, index) => {
    const node = byId.get(id)
    if (!node) return

    edges.push(...resolveExits(node, index, order, present))

    // The owner's routes, filtered exactly as compileFlow filters them: a route
    // to a step that is not in the flow, back to itself, or with no condition
    // written yet is one Emma will never take, so it is not drawn either.
    for (const branch of draft.overrides[id]?.branches ?? []) {
      if (!present.has(branch.to) || branch.to === id || branch.when.trim() === '') continue
      edges.push({ from: id, to: branch.to, kind: 'branch', label: branch.when })
    }
  })

  return { order, edges }
}

/**
 * Where a step dragged to `y` belongs in the order.
 *
 * The diagram has no coordinates of its own to store — dagre lays it out fresh
 * every time — so a drag has to mean something in the only dimension the
 * compiler understands: position in the list. Vertical movement reorders;
 * horizontal movement means nothing and is ignored, because there is nothing for
 * it to mean.
 *
 * `idle` stays pinned at 0 and nothing may pass it: a flow whose first step is
 * not idle is refused by the server, and letting a drag produce one would turn a
 * valid gesture into an error message.
 */
export function reorderByDrop(order: string[], id: string, targets: Map<string, number>): string[] {
  const from = order.indexOf(id)
  if (from < 1) return order

  const dropped = targets.get(id)
  if (dropped === undefined) return order

  // Count how many other steps now sit above the dragged one. That count IS its
  // new index, which is what makes this work without knowing row heights.
  let to = 0
  for (const [other, y] of targets) {
    if (other === id) continue
    if (y < dropped) to++
  }

  // Never past idle, never past the end.
  to = Math.min(Math.max(to, 1), order.length - 1)
  if (to === from) return order

  const next = order.filter((other) => other !== id)
  next.splice(to, 0, id)
  return next
}
