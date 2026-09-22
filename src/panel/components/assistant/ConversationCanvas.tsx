import dagre from '@dagrejs/dagre'
import {
  Background,
  type Edge,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Lock, Split } from 'lucide-react'
import { useCallback, useMemo } from 'react'
import type { ConversationCatalog, ConversationFlow } from '../../api/types.js'
import { buildFlowGraph, reorderByDrop } from '../../lib/flowGraph.js'
import { Badge } from '../ui/badge.js'

/**
 * The flow as a diagram: the same draft the list edits, drawn.
 *
 * Two representations, one source of truth. This receives the draft and the same
 * change handler the list uses, so there is no second copy to keep in step and
 * no second Guardar button — `SettingsCard` still owns saving.
 *
 * **Positions are never stored.** Dagre lays the graph out from scratch on every
 * render, and a drag does not move a node: it reorders the composition. That is
 * the whole design. `'next'` is positional in the compiler, so a free 2D canvas
 * would have no way to express what the flow actually runs on — deriving the
 * order from vertical position is what lets the owner drag without inventing a
 * coordinate system the state machine cannot read.
 *
 * **Edges are drawn, never authored.** The fixed ones are derived; the owner's
 * routes are written in the route editor of each step. Letting someone draw an
 * arrow here is how you get a step nobody can leave, which is the bug this whole
 * module was built to make impossible.
 */

const NODE_WIDTH = 240
const NODE_HEIGHT = 84

export function ConversationCanvas(props: {
  draft: ConversationFlow
  catalog: ConversationCatalog
  onReorder: (nodes: string[]) => void
  onOpen: (id: string) => void
  openId: string | null
}): React.JSX.Element {
  return (
    // Required by useReactFlow inside the diagram, and scoped here rather than
    // at the app root so nothing outside this card pays for it.
    <ReactFlowProvider>
      <Diagram {...props} />
    </ReactFlowProvider>
  )
}

function Diagram({
  draft,
  catalog,
  onReorder,
  onOpen,
  openId,
}: {
  draft: ConversationFlow
  catalog: ConversationCatalog
  onReorder: (nodes: string[]) => void
  onOpen: (id: string) => void
  openId: string | null
}): React.JSX.Element {
  const { getNodes } = useReactFlow()

  const { nodes, edges } = useMemo(() => layout(draft, catalog, openId), [draft, catalog, openId])

  // Reads the live positions rather than the laid-out ones: the dragged node is
  // wherever the pointer left it, and the others are where dagre put them, which
  // together is exactly the ordering question being asked.
  const handleDragStop = useCallback(
    (_: unknown, dragged: Node) => {
      const ys = new Map(getNodes().map((node) => [node.id, node.position.y]))
      const next = reorderByDrop(draft.nodes, dragged.id, ys)
      // Reference check is enough: reorderByDrop returns the same array when the
      // drop changed nothing, which is most drags.
      if (next !== draft.nodes) onReorder(next)
      else onReorder([...draft.nodes])
    },
    [draft.nodes, getNodes, onReorder],
  )

  return (
    <div className="h-[28rem] w-full overflow-hidden rounded-lg border border-emma-border bg-emma-bg">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodeDragStop={handleDragStop}
        onNodeClick={(_, node) => onOpen(node.id)}
        // Everything that would let someone author an edge is off. The arrows
        // are a consequence of the composition, not an input to it.
        nodesConnectable={false}
        edgesFocusable={false}
        elementsSelectable
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.3}
        maxZoom={1.5}
        proOptions={{ hideAttribution: false }}
      >
        <Background bgColor="var(--color-emma-bg)" color="var(--color-emma-border)" gap={16} />
      </ReactFlow>
    </div>
  )
}

// ── Layout ───────────────────────────────────────────────────────────────────

interface StepData extends Record<string, unknown> {
  position: number
  label: string
  available: boolean
  mandatory: boolean
  branches: number
  open: boolean
}

function layout(
  draft: ConversationFlow,
  catalog: ConversationCatalog,
  openId: string | null,
): { nodes: Node<StepData>[]; edges: Edge[] } {
  const byId = new Map(catalog.nodes.map((node) => [node.id, node]))
  const graph = buildFlowGraph(draft, catalog)

  const g = new dagre.graphlib.Graph()
  // Top to bottom, because that is the direction the composition reads in and
  // the direction a conversation runs.
  g.setGraph({ rankdir: 'TB', nodesep: 40, ranksep: 56 })
  g.setDefaultEdgeLabel(() => ({}))

  for (const id of graph.order) g.setNode(id, { width: NODE_WIDTH, height: NODE_HEIGHT })
  for (const edge of graph.edges) g.setEdge(edge.from, edge.to)
  dagre.layout(g)

  const nodes: Node<StepData>[] = graph.order.map((id, index) => {
    const option = byId.get(id)
    const laid = g.node(id)
    const override = draft.overrides[id]

    return {
      id,
      type: 'step',
      // Dagre centres nodes; React Flow anchors them top-left.
      position: { x: laid.x - NODE_WIDTH / 2, y: laid.y - NODE_HEIGHT / 2 },
      data: {
        position: index,
        label: override?.label?.trim() || option?.label || id,
        available: option?.available ?? true,
        mandatory: option?.mandatory ?? false,
        branches: (override?.branches ?? []).length,
        open: id === openId,
      },
      // idle is pinned at the top by the compiler, so dragging it can only ever
      // produce a flow the server refuses.
      draggable: id !== 'idle',
    }
  })

  const edges: Edge[] = graph.edges.map((edge, index) => ({
    id: `${edge.from}-${edge.to}-${index}`,
    source: edge.from,
    target: edge.to,
    // A route the owner wrote does not look like an exit the code fires. The
    // dash is the distinction, and the label is their own condition.
    animated: edge.kind === 'branch',
    label: edge.kind === 'branch' ? edge.label : undefined,
    style: {
      stroke: 'var(--color-emma-text-muted)',
      strokeWidth: edge.kind === 'branch' ? 2 : 1.5,
      strokeDasharray: edge.kind === 'branch' ? '5 4' : undefined,
    },
    labelStyle: { fill: 'var(--color-emma-text)', fontSize: 11 },
    labelBgStyle: { fill: 'var(--color-emma-bg-secondary)' },
    labelBgPadding: [6, 3] as [number, number],
    labelBgBorderRadius: 4,
    markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--color-emma-text-muted)' },
  }))

  return { nodes, edges }
}

// ── The node ─────────────────────────────────────────────────────────────────

function StepNode({ data }: NodeProps<Node<StepData>>): React.JSX.Element {
  return (
    <div
      className={`flex w-[240px] flex-col gap-1 rounded-lg border bg-emma-bg-secondary p-3 text-left shadow-sm ${
        data.open ? 'border-emma-accent' : 'border-emma-border'
      }`}
    >
      {/* Connection points exist so edges have somewhere to land. They are not
          interactive: nodesConnectable is off on the canvas. */}
      <Handle type="target" position={Position.Top} className="!bg-emma-border !border-0" />

      <div className="flex items-center gap-2">
        <span className="text-muted-foreground w-4 shrink-0 text-xs tabular-nums">
          {data.position}
        </span>
        <span className="truncate text-sm font-medium">{data.label}</span>
        {data.mandatory && (
          <Lock size={12} className="text-muted-foreground shrink-0" aria-hidden />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1 pl-6">
        {!data.available && (
          <Badge variant="secondary" className="text-[10px]">
            Falta configurarlo
          </Badge>
        )}
        {data.branches > 0 && (
          <span className="text-muted-foreground flex items-center gap-1 text-[10px]">
            <Split size={11} aria-hidden />
            {data.branches} {data.branches === 1 ? 'ruta' : 'rutas'}
          </span>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} className="!bg-emma-border !border-0" />
    </div>
  )
}

// Declared outside the component: React Flow warns — loudly and correctly — when
// this object changes identity between renders.
const NODE_TYPES = { step: StepNode }

/** Kept for the legend the card renders beside the diagram. */
export const CANVAS_LEGEND = [
  { kind: 'fixed' as const, text: 'Línea sólida: el paso avanza solo cuando pasa algo concreto.' },
  { kind: 'branch' as const, text: 'Línea punteada: una ruta que escribiste vos.' },
  { kind: 'note' as const, text: 'Arrastrá un paso hacia arriba o abajo para cambiar el orden.' },
]
