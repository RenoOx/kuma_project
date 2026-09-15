import { Check, TriangleAlert } from 'lucide-react'
import { Button } from '../ui/button.js'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card.js'
import { Label } from '../ui/label.js'

/**
 * The frame every config section renders inside: title, body, one save button.
 *
 * Saving is explicit rather than on-change. These fields decide what Emma tells
 * customers — an autosave that fired halfway through retyping an opening hour
 * would put a half-typed schedule in front of the next person who writes in.
 */
export function SettingsCard({
  title,
  description,
  children,
  onSave,
  saving,
  saved,
  error,
  dirty,
}: {
  title: string
  description?: string
  children: React.ReactNode
  onSave: () => void
  saving: boolean
  saved: boolean
  error: string | null
  dirty: boolean
}): React.JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">{children}</CardContent>
      <div className="flex flex-wrap items-center gap-3 px-4">
        <Button onClick={onSave} disabled={saving || !dirty} size="sm">
          {saving ? 'Guardando…' : 'Guardar cambios'}
        </Button>
        {/* Only one of these shows at a time: an error replaces the tick rather
            than sitting beside it, so the row never reads as both. */}
        {error ? (
          <span className="text-destructive flex items-center gap-1.5 text-sm">
            <TriangleAlert size={14} aria-hidden />
            {error}
          </span>
        ) : (
          saved &&
          !dirty && (
            <span className="text-q-qualified flex items-center gap-1.5 text-sm">
              <Check size={14} aria-hidden />
              Guardado
            </span>
          )
        )}
      </div>
    </Card>
  )
}

/** A labelled form row. Stacks on a phone, two columns from `md` up. */
export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string
  hint?: string
  htmlFor?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="grid gap-1.5 md:grid-cols-[13rem_1fr] md:items-center md:gap-4">
      <div className="flex flex-col gap-0.5">
        <Label htmlFor={htmlFor}>{label}</Label>
        {hint && <span className="text-muted-foreground text-xs">{hint}</span>}
      </div>
      {children}
    </div>
  )
}
