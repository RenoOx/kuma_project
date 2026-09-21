import { ChevronDown, ChevronRight, ChevronUp, Lock, Plus, X } from 'lucide-react'
import { useState } from 'react'
import type {
  ConversationCatalog,
  ConversationFlow,
  ConversationNodeOption,
} from '../../api/types.js'
import { useSectionSave } from '../../hooks/useSettings.js'
import { SettingsCard } from '../config/SettingsCard.js'
import { Badge } from '../ui/badge.js'
import { Button } from '../ui/button.js'
import { Label } from '../ui/label.js'
import { Textarea } from '../ui/textarea.js'

/**
 * The steps Emma follows, in order, and the two things about each one the owner
 * may rewrite.
 *
 * A list and not a canvas on purpose. The owner picks steps and orders them; the
 * arrows between them are derived by the compiler on the server. Letting them
 * draw the arrows is how you get a step nobody can leave — the exact bug that
 * kept the selling flow answering once and then going quiet, and it reaches the
 * owner as "Emma no responde", the most expensive symptom there is.
 *
 * Objective and steps are shown but not editable: that is the motor. What moves
 * is the wording that steers the model — the edge cases and the sample reply —
 * which is also what moves its behaviour most per word changed.
 */
export function ConversationSettings({
  catalog,
}: {
  catalog: ConversationCatalog
}): React.JSX.Element {
  const [open, setOpen] = useState<string | null>(null)
  const { save, saving, saved, error } = useSectionSave()

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

  function setOverride(id: string, patch: { edgeCases?: string[]; example?: string }): void {
    setDraft({
      ...draft,
      overrides: { ...draft.overrides, [id]: { ...draft.overrides[id], ...patch } },
    })
  }

  return (
    <SettingsCard
      title="Conversación"
      description="Los pasos que sigue Emma, en orden. Podés ajustar el ejemplo y los casos especiales de cada uno."
      onSave={() => save({ section: 'conversation', conversationFlow: draft })}
      saving={saving}
      saved={saved}
      error={error}
      dirty={dirty}
    >
      <div className="flex flex-col gap-2">
        {visible.map((id, index) => {
          const node = byId.get(id)
          if (!node) return null
          return (
            <NodeRow
              key={id}
              node={node}
              position={index + 1}
              expanded={open === id}
              onToggle={() => setOpen(open === id ? null : id)}
              onUp={() => move(id, -1)}
              onDown={() => move(id, 1)}
              onRemove={() => remove(id)}
              override={draft.overrides[id] ?? {}}
              onOverride={(patch) => setOverride(id, patch)}
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
}: {
  node: ConversationNodeOption
  position: number
  expanded: boolean
  onToggle: () => void
  onUp: () => void
  onDown: () => void
  onRemove: () => void
  override: { edgeCases?: string[]; example?: string }
  onOverride: (patch: { edgeCases?: string[]; example?: string }) => void
}): React.JSX.Element {
  // One textarea, one line per case. The owner writes a list the way they think
  // of it; the array is an implementation detail of the wire format.
  const edgeText = (override.edgeCases ?? node.defaultEdgeCases).join('\n')
  const exampleText = override.example ?? node.defaultExample

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
          <span className="truncate text-sm font-medium">{node.label}</span>
          {!node.available && (
            <Badge variant="secondary" className="shrink-0 text-[10px]">
              Falta configurarlo
            </Badge>
          )}
        </button>
        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton label={`Subir ${node.label}`} onClick={onUp}>
            <ChevronUp size={14} aria-hidden />
          </IconButton>
          <IconButton label={`Bajar ${node.label}`} onClick={onDown}>
            <ChevronDown size={14} aria-hidden />
          </IconButton>
          {node.mandatory ? (
            // Shown rather than hidden: "this one cannot be removed" is an
            // answer, an absent button is a question.
            <span className="p-1.5" title="Este paso no se puede quitar">
              <Lock size={14} className="text-muted-foreground" aria-hidden />
            </span>
          ) : (
            <IconButton label={`Quitar ${node.label}`} onClick={onRemove}>
              <X size={14} aria-hidden />
            </IconButton>
          )}
        </div>
      </div>

      {expanded && (
        <div className="flex flex-col gap-3 border-t border-emma-border p-3">
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
