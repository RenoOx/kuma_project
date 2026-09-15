import { Pencil, Plus, TriangleAlert, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { KbCategory, KnowledgeEntry, KnowledgeInput } from '../../api/types.js'
import { useKnowledgeMutation } from '../../hooks/useKnowledge.js'
import {
  KB_CATEGORIES,
  KB_CATEGORY_LABELS,
  KB_SEND_MODE_LABELS,
  MAX_KB_ENTRIES_PER_CATEGORY,
} from '../../lib/constants.js'
import { cn, truncate } from '../../lib/utils.js'
import { Badge } from '../ui/badge.js'
import { Button } from '../ui/button.js'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card.js'
import { KbEntryForm } from './KbEntryForm.js'

/**
 * The knowledge base: what Emma knows beyond the operational configuration.
 *
 * Unlike the settings cards, this one writes straight through on every action —
 * these are table rows with real ids, not an array that has to be replaced
 * whole, so there is nothing to batch behind a save button.
 */
export function KnowledgeList({ entries }: { entries: KnowledgeEntry[] }): React.JSX.Element {
  const [editing, setEditing] = useState<{ entry: KnowledgeEntry | null } | null>(null)
  const { mutate, saving, error } = useKnowledgeMutation(() => setEditing(null))

  const submit = (input: KnowledgeInput): void => {
    if (editing?.entry) mutate({ action: 'update', id: editing.entry.id, input })
    else mutate({ action: 'create', input })
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Información para Emma</CardTitle>
          <CardDescription>
            Políticas, preguntas frecuentes y promos. Los servicios, precios y horarios se
            configuran arriba — no hace falta repetirlos acá.
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-5">
          {entries.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Todavía no cargaste información. Emma responde solo con la configuración del negocio.
            </p>
          ) : (
            KB_CATEGORIES.map((category) => (
              <CategoryGroup
                key={category}
                category={category}
                entries={entries.filter((e) => e.category === category)}
                onEdit={(entry) => setEditing({ entry })}
                onDelete={(id) => mutate({ action: 'delete', id })}
              />
            ))
          )}

          {error && <p className="text-destructive text-sm">{error}</p>}

          <div>
            <Button variant="outline" size="sm" onClick={() => setEditing({ entry: null })}>
              <Plus size={14} aria-hidden />
              Agregar información
            </Button>
          </div>
        </CardContent>
      </Card>

      {editing !== null && (
        <KbEntryForm
          // Remounted per entry so the form state starts from the right row.
          key={editing.entry?.id ?? 'new'}
          open
          entry={editing.entry}
          onClose={() => setEditing(null)}
          onSubmit={submit}
          saving={saving}
          error={error}
        />
      )}
    </>
  )
}

function CategoryGroup({
  category,
  entries,
  onEdit,
  onDelete,
}: {
  category: KbCategory
  entries: KnowledgeEntry[]
  onEdit: (entry: KnowledgeEntry) => void
  onDelete: (id: string) => void
}): React.JSX.Element | null {
  if (entries.length === 0) return null

  // Emma loads the oldest N active entries of a category and nothing past that,
  // so the newest ones simply never reach her. There is no ordering lever left
  // to work around it — the only fix is fewer entries, which is why this says so
  // where the owner is adding them.
  const activeCount = entries.filter((e) => e.active).length
  const overflow = activeCount - MAX_KB_ENTRIES_PER_CATEGORY

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{KB_CATEGORY_LABELS[category]}</h3>

      {overflow > 0 && (
        <div className="bg-q-needs-info/10 flex items-start gap-2 rounded-md p-2.5">
          <TriangleAlert className="text-q-needs-info mt-0.5 shrink-0" size={14} aria-hidden />
          <p className="text-xs">
            Esta categoría tiene {activeCount} entradas activas y Emma solo carga las{' '}
            {MAX_KB_ENTRIES_PER_CATEGORY} más antiguas.{' '}
            {overflow === 1 ? 'La más nueva no le llega' : `Las ${overflow} más nuevas no le llegan`}
            . Desactivá las que ya no apliquen o juntá varias en una sola.
          </p>
        </div>
      )}

      <div className="flex flex-col divide-y divide-border">
        {entries.map((entry) => (
          <EntryRow key={entry.id} entry={entry} onEdit={onEdit} onDelete={onDelete} />
        ))}
      </div>
    </div>
  )
}

function EntryRow({
  entry,
  onEdit,
  onDelete,
}: {
  entry: KnowledgeEntry
  onEdit: (entry: KnowledgeEntry) => void
  onDelete: (id: string) => void
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-3 py-3">
      <div className={cn('min-w-0 flex-1', !entry.active && 'opacity-50')}>
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-medium">{entry.title}</p>
          <Badge variant="secondary" className="text-[10px]">
            {KB_SEND_MODE_LABELS[entry.sendMode]}
          </Badge>
          {!entry.active && (
            <Badge variant="secondary" className="bg-q-lost/15 text-q-lost text-[10px]">
              Desactivada
            </Badge>
          )}
        </div>
        <p className="text-muted-foreground mt-0.5 text-xs">{truncate(entry.content, 140)}</p>
      </div>

      <div className="flex shrink-0 items-center">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onEdit(entry)}
          aria-label={`Editar ${entry.title}`}
        >
          <Pencil size={16} aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onDelete(entry.id)}
          aria-label={`Eliminar ${entry.title}`}
        >
          <Trash2 size={16} aria-hidden />
        </Button>
      </div>
    </div>
  )
}
