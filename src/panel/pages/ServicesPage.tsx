import { TriangleAlert } from 'lucide-react'
import { KnowledgeList } from '../components/services/KnowledgeList.js'
import { PaymentMethods } from '../components/services/PaymentMethods.js'
import { ServiceList } from '../components/services/ServiceList.js'
import { Skeleton } from '../components/ui/skeleton.js'
import { useKnowledge } from '../hooks/useKnowledge.js'
import { useSettings } from '../hooks/useSettings.js'

/**
 * Services, payments and knowledge base (migration BLOQUE A).
 *
 * Three cards in one column, same shape as ConfigPage: the owner opening this
 * screen is usually checking one against another — a price against what a
 * promo promises, a deposit against the payment methods that collect it.
 *
 * The first two cards each save on their own section PATCH. The knowledge base
 * writes straight through: those are table rows with ids, not an array that has
 * to be replaced whole.
 */
export function ServicesPage(): React.JSX.Element {
  const settings = useSettings()
  const knowledge = useKnowledge()

  if (settings.isLoading || knowledge.isLoading) return <ServicesSkeleton />

  if (settings.isError || !settings.data) {
    return (
      <Notice
        title="No pudimos cargar tus servicios"
        body="Recargá la página. Si sigue igual, escribinos a Vamvu Labs."
      />
    )
  }

  const config = settings.data.settings

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-6">
        {config ? (
          <>
            <ServiceList
              services={config.services}
              // 'vende' is the panel's name for a business with no agenda. The
              // server derives it from flowType + appointmentMode and sends it
              // already resolved, so the mapping lives in exactly one place.
              schedulesAppointments={settings.data.assistantFunction !== 'vende'}
            />
            <PaymentMethods settings={config} />
          </>
        ) : (
          <Notice
            title="Falta terminar la configuración"
            body={
              settings.data.invalidFields.length > 0
                ? `Estos datos todavía no están cargados: ${settings.data.invalidFields.join(', ')}. Escribinos a Vamvu Labs para completarlos.`
                : 'Escribinos a Vamvu Labs para terminar de configurar tu negocio.'
            }
          />
        )}

        {/* The knowledge base does not depend on settings parsing: a business
            whose configuration is incomplete can still have policies loaded,
            and hiding them would look like they were lost. */}
        <KnowledgeList entries={knowledge.data ?? []} readOnly />
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

function ServicesSkeleton(): React.JSX.Element {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <Skeleton className="h-64 w-full rounded-xl" />
      <Skeleton className="h-56 w-full rounded-xl" />
      <Skeleton className="h-72 w-full rounded-xl" />
    </div>
  )
}
