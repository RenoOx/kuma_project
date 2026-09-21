import { TriangleAlert } from 'lucide-react'
import { FlowSettings } from '../components/assistant/FlowSettings.js'
import { IdentitySettings } from '../components/assistant/IdentitySettings.js'
import { MessagesSettings } from '../components/assistant/MessagesSettings.js'
import { Skeleton } from '../components/ui/skeleton.js'
import { useSettings } from '../hooks/useSettings.js'

/**
 * The Asistente tab: Identidad, Mensajes, Flujo.
 *
 * Three cards with three save buttons, and three section PATCHes behind them. One
 * combined save would arrive from whichever card the owner touched with the other
 * two sections absent, and an absent key is only safe to read as "unchanged"
 * because each request is scoped to one card.
 *
 * Identidad renders even when the stored settings do not validate: the assistant's
 * name and tone do not depend on hours or services, and a business still being set
 * up is exactly when its owner wants to name their bot. The other two need parsed
 * values to fill their forms.
 */
export function AssistantPage(): React.JSX.Element {
  const { data, isLoading, isError } = useSettings()

  if (isLoading) return <AssistantSkeleton />

  if (isError || !data) {
    return (
      <Notice
        title="No pudimos cargar la configuración de Emma"
        body="Recargá la página. Si sigue igual, escribinos a Vamvu Labs."
      />
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-6">
        <IdentitySettings data={data} />

        {data.settings ? (
          <>
            <MessagesSettings data={data} />
            <FlowSettings data={data} />
          </>
        ) : (
          <Notice
            title="Falta terminar la configuración"
            body={
              data.invalidFields.length > 0
                ? `Estos datos todavía no están cargados: ${data.invalidFields.join(', ')}. Escribinos a Vamvu Labs para completarlos.`
                : 'Escribinos a Vamvu Labs para terminar de configurar tu negocio.'
            }
          />
        )}
      </div>
    </div>
  )
}

function Notice({ title, body }: { title: string; body: string }): React.JSX.Element {
  return (
    <div className="bg-card flex items-start gap-3 rounded-xl border border-border p-4">
      <TriangleAlert className="text-q-needs-info mt-0.5 shrink-0" size={18} aria-hidden />
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-muted-foreground mt-1 text-sm">{body}</p>
      </div>
    </div>
  )
}

function AssistantSkeleton(): React.JSX.Element {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <Skeleton className="h-96 w-full rounded-xl" />
      <Skeleton className="h-72 w-full rounded-xl" />
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  )
}
