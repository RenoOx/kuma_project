import { ChevronDown, ChevronRight, ChevronUp, List, Lock, Network, Plus, X } from 'lucide-react'
import { lazy, Suspense, useState } from 'react'
import type {
  ConversationBranch,
  ConversationCatalog,
  ConversationFlow,
  ConversationNodeOption,
  ConversationNodeOverride,
} from '../../api/types.js'
import { useIsDesktop } from '../../hooks/useMediaQuery.js'
import { useSectionSave, useSettings } from '../../hooks/useSettings.js'
import { SettingsCard } from '../config/SettingsCard.js'
import { MediaField } from '../media/MediaField.js'
import { Badge } from '../ui/badge.js'
import { Button } from '../ui/button.js'
import { Input } from '../ui/input.js'
import { Label } from '../ui/label.js'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select.js'
import { Textarea } from '../ui/textarea.js'

// Pulled only when the owner asks for the diagram. @xyflow/react and dagre are
// the two heaviest things in this panel and most sessions never open them, so
// they stay out of the /asistente chunk entirely.
const ConversationCanvas = lazy(async () => ({
  default: (await import('./ConversationCanvas.js')).ConversationCanvas,
}))

/**
 * The steps Emma follows, in order, and what the owner may rewrite about each.
 *
 * Two views of one draft: a list and a diagram. Neither of them lets the owner
 * draw an arrow — the fixed edges are derived by the compiler on the server, and
 * the conditional ones are written as CONDITIONS in each step's route editor.
 * Letting someone draw the arrows directly is how you get a step nobody can
 * leave, the exact bug that kept the selling flow answering once and then going
 * quiet, and it reaches the owner as "Emma no responde".
 *
 * Objective and steps are shown but not editable: that is the motor. An owner
 * who could rewrite show_availability's steps could delete "SIEMPRE consultá la
 * disponibilidad real", and Emma would start inventing hours. What they get
 * instead is a note of their own that is ADDED to the steps — which covers what
 * they actually want without putting the mechanics at risk.
 */
export function ConversationSettings({
  catalog,
}: {
  catalog: ConversationCatalog
}): React.JSX.Element {
  const [open, setOpen] = useState<string | null>(null)
  const [view, setView] = useState<'list' | 'diagram'>('list')
  const { save, saving, saved, error } = useSectionSave()
  // The categories the owner actually created in Servicios. Shown on the step
  // that lists them so a rule gets written against names that exist: the first
  // attempt at this said "Basicos" and "tecnicos" while the catalogue held
  // "Curso Básico" and "Curso Avanzado", and Emma had nothing to match.
  const settings = useSettings()
  const categories = [
    ...new Set(
      (settings.data?.settings?.services ?? [])
        .filter((service) => service.active)
        .map((service) => service.category?.trim())
        .filter((category): category is string => !!category),
    ),
  ]
  // A 360px canvas is a worse list. The toggle is not offered below md, and the
  // view falls back rather than rendering a diagram nobody can use.
  const isDesktop = useIsDesktop()
  const showDiagram = view === 'diagram' && isDesktop

  // The served composition can change under the card: saving the deposit toggle
  // on the Flujo card above invalidates this catalogue, and with no stored
  // composition the derived preset gains or loses the two payment steps. Synced
  // on CONTENT rather than on identity — every refetch returns a fresh object,
  // so a reference check would discard the owner's edits on any invalidation.
  const servedKey = JSON.stringify(catalog.current)
  const [syncedKey, setSyncedKey] = useState(servedKey)
  const [draft, setDraft] = useState<ConversationFlow>(catalog.current)
  if (syncedKey !== servedKey) {
    setSyncedKey(servedKey)
    setDraft(catalog.current)
  }

  const byId = new Map(catalog.nodes.map((n) => [n.id, n]))
  const dirty = JSON.stringify(draft) !== servedKey

  // A step is named by whatever the owner renamed it to, everywhere it appears —
  // including as the destination of somebody else's route.
  const labelOf = (id: string): string =>
    draft.overrides[id]?.label?.trim() || byId.get(id)?.label || id

  // `idle` is real but has nothing to say to a customer, so the list starts at
  // the first step that speaks. Showing a step whose sample reply is empty would
  // read as a bug in the card, not as a design decision.
  const visible = draft.nodes.filter((id) => id !== 'idle')
  const missing = catalog.nodes.filter((n) => !draft.nodes.includes(n.id) && n.id !== 'idle')

  function move(id: string, delta: number): void {
    const nodes = [...draft.nodes]
    const from = nodes.indexOf(id)
    const to = from + delta
    // idle stays pinned at 0 and nothing may pass it: a flow whose first step is
    // not idle is refused by the server, and letting the arrow produce one would
    // turn a valid click into an error message.
    if (to < 1 || to >= nodes.length) return
    const moved = nodes[from]
    const displaced = nodes[to]
    if (!moved || !displaced) return
    nodes[from] = displaced
    nodes[to] = moved
    setDraft({ ...draft, nodes })
  }

  function remove(id: string): void {
    setDraft({ ...draft, nodes: draft.nodes.filter((n) => n !== id) })
  }

  function add(id: string): void {
    setDraft({ ...draft, nodes: [...draft.nodes, id] })
  }

  // The diagram's drag lands here: it reorders the composition and nothing else,
  // because there are no positions to store.
  function reorder(nodes: string[]): void {
    setDraft({ ...draft, nodes })
  }

  function setOverride(id: string, patch: ConversationNodeOverride): void {
    setDraft({
      ...draft,
      overrides: { ...draft.overrides, [id]: { ...draft.overrides[id], ...patch } },
    })
  }

  return (
    <SettingsCard
      title="Conversación"
      description="Los pasos que sigue Emma, en orden. De cada uno podés cambiarle el nombre, sumarle indicaciones tuyas y ajustar los casos especiales y el ejemplo."
      onSave={() => save({ section: 'conversation', conversationFlow: draft })}
      saving={saving}
      saved={saved}
      error={error}
      dirty={dirty}
    >
      {isDesktop && (
        <div className="flex items-center gap-1 self-start rounded-md border border-emma-border p-0.5">
          <ViewTab active={view === 'list'} onClick={() => setView('list')} icon={List}>
            Lista
          </ViewTab>
          <ViewTab active={view === 'diagram'} onClick={() => setView('diagram')} icon={Network}>
            Diagrama
          </ViewTab>
        </div>
      )}

      {showDiagram && (
        <div className="flex flex-col gap-2">
          <Suspense
            fallback={
              <div className="text-muted-foreground flex h-[28rem] items-center justify-center rounded-lg border border-emma-border text-sm">
                Cargando el diagrama…
              </div>
            }
          >
            <ConversationCanvas
              draft={draft}
              catalog={catalog}
              onReorder={reorder}
              onOpen={(id) => setOpen(open === id ? null : id)}
              openId={open}
            />
          </Suspense>
          <p className="text-muted-foreground text-xs">
            Arrastrá un paso hacia arriba o abajo para cambiar el orden. La línea punteada es una
            ruta tuya; la sólida, un paso que avanza solo cuando pasa algo concreto. Tocá un paso
            para editarlo abajo.
          </p>
        </div>
      )}

      <div className="flex flex-col gap-2">
        {visible.map((id, index) => {
          const node = byId.get(id)
          if (!node) return null
          return (
            <NodeRow
              key={id}
              node={node}
              position={index + 1}
              // In the diagram only the step the owner tapped stays expanded, so
              // the list below acts as its inspector instead of a second copy.
              expanded={open === id}
              collapsed={showDiagram && open !== id}
              onToggle={() => setOpen(open === id ? null : id)}
              onUp={() => move(id, -1)}
              onDown={() => move(id, 1)}
              onRemove={() => remove(id)}
              override={draft.overrides[id] ?? {}}
              onOverride={(patch) => setOverride(id, patch)}
              // Only where they mean something: on the step that shows the
              // catalogue. Everywhere else they would be one more thing to read.
              categories={id === 'listado_servicios' ? categories : []}
              // Every other step of the flow, so a route has somewhere to go.
              // Built from the draft rather than from the catalogue: a route to
              // a step the owner has not added is one the compiler would drop.
              targets={visible
                .filter((other) => other !== id)
                .map((other) => ({ id: other, label: labelOf(other) }))}
            />
          )
        })}
      </div>

      {missing.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-emma-border pt-3">
          <p className="text-muted-foreground text-xs">Pasos que no estás usando</p>
          <div className="flex flex-wrap gap-2">
            {missing.map((node) => (
              <Button
                key={node.id}
                size="sm"
                variant="outline"
                disabled={!node.available}
                onClick={() => add(node.id)}
                // The reason a step cannot be added belongs on the step, not in a
                // rejection after the fact: the owner sees WHY Emma is not using
                // it instead of the option quietly not being there.
                title={node.available ? node.hint : `${node.hint} — falta configurarlo`}
              >
                <Plus size={13} aria-hidden />
                {node.label}
                {!node.available && (
                  <Lock size={12} className="text-muted-foreground" aria-hidden />
                )}
              </Button>
            ))}
          </div>
        </div>
      )}

      <p className="text-muted-foreground border-t border-emma-border pt-3 text-xs">
        Derivación a un humano y fuera de horario funcionan desde cualquier paso y no se ordenan
        acá.
      </p>
    </SettingsCard>
  )
}

function NodeRow({
  node,
  position,
  expanded,
  onToggle,
  onUp,
  onDown,
  onRemove,
  override,
  onOverride,
  targets,
  categories,
  collapsed = false,
}: {
  node: ConversationNodeOption
  position: number
  expanded: boolean
  /** Hidden entirely while the diagram is showing and this is not the open step. */
  collapsed?: boolean
  onToggle: () => void
  onUp: () => void
  onDown: () => void
  onRemove: () => void
  override: ConversationNodeOverride
  onOverride: (patch: ConversationNodeOverride) => void
  targets: Array<{ id: string; label: string }>
  /** Categories from Servicios, shown as a reference on the listing step. */
  categories: string[]
}): React.JSX.Element | null {
  // One textarea, one line per case. The owner writes a list the way they think
  // of it; the array is an implementation detail of the wire format.
  const edgeText = (override.edgeCases ?? node.defaultEdgeCases).join('\n')
  const exampleText = override.example ?? node.defaultExample
  // Renaming is cosmetic: the id is what the flow runs on, so a step the owner
  // called "Cierre de matrícula" is still `confirmed` to the compiler.
  const title = override.label?.trim() || node.label

  // Not rendered at all rather than hidden with CSS: the row owns a MediaField,
  // and mounting eleven of those behind the diagram would fire eleven requests
  // for files nobody is looking at.
  if (collapsed) return null

  return (
    <div className="rounded-lg border border-emma-border bg-emma-bg-secondary">
      <div className="flex items-center gap-2 p-3">
        <span className="text-muted-foreground w-5 shrink-0 text-sm tabular-nums">{position}</span>
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={expanded}
        >
          {expanded ? (
            <ChevronDown size={15} className="shrink-0" aria-hidden />
          ) : (
            <ChevronRight size={15} className="shrink-0" aria-hidden />
          )}
          <span className="truncate text-sm font-medium">{title}</span>
          {!node.available && (
            <Badge variant="secondary" className="shrink-0 text-[10px]">
              Falta configurarlo
            </Badge>
          )}
        </button>
        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton label={`Subir ${title}`} onClick={onUp}>
            <ChevronUp size={14} aria-hidden />
          </IconButton>
          <IconButton label={`Bajar ${title}`} onClick={onDown}>
            <ChevronDown size={14} aria-hidden />
          </IconButton>
          {node.mandatory ? (
            // Shown rather than hidden: "this one cannot be removed" is an
            // answer, an absent button is a question.
            <span className="p-1.5" title="Este paso no se puede quitar">
              <Lock size={14} className="text-muted-foreground" aria-hidden />
            </span>
          ) : (
            <IconButton label={`Quitar ${title}`} onClick={onRemove}>
              <X size={14} aria-hidden />
            </IconButton>
          )}
        </div>
      </div>

      {expanded && (
        <div className="flex flex-col gap-3 border-t border-emma-border p-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor={`label-${node.id}`} className="text-xs">
              Nombre del paso
            </Label>
            <span className="text-muted-foreground text-xs">
              Solo cambia como lo ves acá. Emma sigue corriendo el mismo paso.
            </span>
            <Input
              id={`label-${node.id}`}
              value={override.label ?? node.label}
              maxLength={64}
              onChange={(e) => onOverride({ label: e.target.value })}
            />
          </div>

          <div>
            <p className="text-muted-foreground text-xs font-medium">Objetivo</p>
            <p className="mt-0.5 text-sm">{node.objective}</p>
          </div>

          <div>
            <p className="text-muted-foreground text-xs font-medium">Pasos</p>
            <ol className="mt-0.5 flex list-decimal flex-col gap-0.5 pl-4 text-sm">
              {node.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor={`extra-${node.id}`} className="text-xs">
              Tus indicaciones para este paso
            </Label>
            <span className="text-muted-foreground text-xs">
              Se suman a los pasos de arriba, no los reemplazan. Acá va lo propio de tu negocio.
            </span>
            {categories.length > 0 && (
              <p className="text-muted-foreground text-xs">
                Categorías en tu catálogo:{' '}
                {categories.map((category, index) => (
                  <span key={category}>
                    {index > 0 && ', '}
                    <span className="text-emma-text font-medium">{category}</span>
                  </span>
                ))}
                . Escribilas igual acá para que Emma las reconozca.
              </p>
            )}
            <Textarea
              id={`extra-${node.id}`}
              value={override.extraInstructions ?? ''}
              rows={3}
              maxLength={1500}
              placeholder="Ej: si el alumno pregunta por convalidación, pedile primero el certificado previo."
              onChange={(e) => onOverride({ extraInstructions: e.target.value })}
            />
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor={`edge-${node.id}`} className="text-xs">
              Casos especiales
            </Label>
            <span className="text-muted-foreground text-xs">Uno por línea.</span>
            <Textarea
              id={`edge-${node.id}`}
              value={edgeText}
              rows={4}
              onChange={(e) =>
                onOverride({
                  edgeCases: e.target.value
                    .split('\n')
                    .map((line) => line.trim())
                    .filter((line) => line !== ''),
                })
              }
            />
          </div>

          <BranchEditor
            nodeId={node.id}
            branches={override.branches ?? []}
            targets={targets}
            onChange={(branches) => onOverride({ branches })}
          />

          {/* Last, and with its own persistence: everything above is a draft
              until Guardar, while a file is written the moment it is picked.
              Emma sends these on REACHING this step, without the customer having
              to ask — that is what separates them from a service's material. */}
          <MediaField
            owner={{ kind: 'node', id: node.id }}
            label="Material de este paso"
            unsavedHint="Guardá la conversación primero y volvé para subirle archivos."
          />

          <div className="flex flex-col gap-1">
            <Label htmlFor={`example-${node.id}`} className="text-xs">
              Ejemplo de respuesta
            </Label>
            <span className="text-muted-foreground text-xs">
              Emma lo usa como referencia de tono, no lo copia literal.
            </span>
            <Textarea
              id={`example-${node.id}`}
              value={exampleText}
              rows={3}
              maxLength={1000}
              onChange={(e) => onOverride({ example: e.target.value })}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="text-muted-foreground hover:bg-emma-elevated hover:text-emma-text rounded p-1.5"
    >
      {children}
    </button>
  )
}

const MAX_BRANCHES = 4

/**
 * The routes out of one step.
 *
 * This is the only place in the panel where the owner draws an edge, and it is
 * safe to expose because the arrow is still not theirs to point anywhere: the
 * destination comes from a list of steps that exist, the compiler drops a route
 * whose target was removed, and validateFlow still refuses a flow with a step
 * nobody can leave. What they author is the CONDITION — Emma reads it and
 * decides. The id is generated and never shown: it exists so the model has
 * something exact to answer with.
 */
function BranchEditor({
  nodeId,
  branches,
  targets,
  onChange,
}: {
  nodeId: string
  branches: ConversationBranch[]
  targets: Array<{ id: string; label: string }>
  onChange: (branches: ConversationBranch[]) => void
}): React.JSX.Element | null {
  // Nowhere to route to means no routes: a step alone in the flow would get an
  // "Agregar ruta" button that could only ever produce an invalid one.
  if (targets.length === 0) return null

  const update = (index: number, patch: Partial<ConversationBranch>): void => {
    onChange(branches.map((branch, i) => (i === index ? { ...branch, ...patch } : branch)))
  }

  const add = (): void => {
    const first = targets[0]
    if (!first) return
    // Sequential rather than derived from the condition: the id has to survive
    // the owner rewording the condition, and a slug would change under them and
    // silently orphan nothing while looking like it should.
    const used = new Set(branches.map((branch) => branch.id))
    let n = branches.length + 1
    while (used.has(`ruta-${n}`)) n += 1
    onChange([...branches, { id: `ruta-${n}`, when: '', to: first.id }])
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <Label className="text-xs">Rutas</Label>
        <span className="text-muted-foreground text-xs">
          Cuando se cumple la condición, Emma salta a ese paso. Si no se cumple ninguna, sigue
          conversando acá.
        </span>
      </div>

      {branches.map((branch, index) => (
        <div
          key={branch.id}
          className="flex flex-col gap-2 rounded-md border border-emma-border bg-emma-elevated p-2"
        >
          <Input
            aria-label={`Condición de la ruta ${index + 1} de ${nodeId}`}
            value={branch.when}
            maxLength={300}
            placeholder="Ej: el cliente dice que ya eligió el curso"
            onChange={(e) => update(index, { when: e.target.value })}
          />
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground shrink-0 text-xs">Ir a</span>
            <Select value={branch.to} onValueChange={(to) => update(index, { to })}>
              <SelectTrigger className="h-8 flex-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {targets.map((target) => (
                  <SelectItem key={target.id} value={target.id}>
                    {target.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <IconButton
              label={`Quitar la ruta ${index + 1}`}
              onClick={() => onChange(branches.filter((_, i) => i !== index))}
            >
              <X size={14} aria-hidden />
            </IconButton>
          </div>
        </div>
      ))}

      {branches.length < MAX_BRANCHES && (
        <Button type="button" size="sm" variant="outline" className="self-start" onClick={add}>
          <Plus size={13} aria-hidden />
          Agregar ruta
        </Button>
      )}
    </div>
  )
}

function ViewTab({
  active,
  onClick,
  icon: Icon,
  children,
}: {
  active: boolean
  onClick: () => void
  icon: typeof List
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs ${
        active
          ? 'bg-emma-elevated text-emma-text font-medium'
          : 'text-muted-foreground hover:text-emma-text'
      }`}
    >
      <Icon size={13} aria-hidden />
      {children}
    </button>
  )
}
