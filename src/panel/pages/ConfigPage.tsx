import { TriangleAlert } from 'lucide-react'
import { BookingSettings } from '../components/config/BookingSettings.js'
import { GeneralSettings } from '../components/config/GeneralSettings.js'
import { IntegrationsPanel } from '../components/config/IntegrationsPanel.js'
import { ScheduleSettings } from '../components/config/ScheduleSettings.js'
import { SpecialDays } from '../components/config/SpecialDays.js'
import { Skeleton } from '../components/ui/skeleton.js'
import { useMe } from '../hooks/useMeta.js'
import { useSettings } from '../hooks/useSettings.js'

/**
 * Configuration (migration BLOQUE B).
 *
 * One scrolling column of cards rather than tabs: every section here is short,
 * and the owner opening this screen is usually checking one value against
 * another — hours against special days, booking mode against reminders. Tabs
 * would hide half of that behind a click.
 *
 * Each card saves on its own. A failure in one leaves the others untouched,
 * which is the whole reason the API takes four section PATCHes instead of one
 * document PUT.
 */
export function ConfigPage(): React.JSX.Element {
  const { data, isLoading, isError } = useSettings()
  const me = useMe()
  // Hours and special days stay for everyone: they decide when Emma answers, not
  // when somebody is seen. What goes is the booking machinery — slot length,
  // minimum notice, reminders, booking mode — which a business with nothing to
  // book can only misconfigure.
  const books = me.data?.booksAppointments ?? true

  if (isLoading) return <ConfigSkeleton />

  if (isError || !data) {
    return (
      <Notice
        title="No pudimos cargar la configuración"
        body="Recargá la página. Si sigue igual, escribinos a Vamvu Labs."
      />
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-6">
        <GeneralSettings data={data} />

        {/* The schedule, special days and booking cards all read from parsed
            settings. A business whose stored settings do not validate has no
            values to put in those forms, and inventing them would show a work
            week nobody configured — so it gets told what is missing instead. */}
        {data.settings ? (
          <>
            <ScheduleSettings hours={data.settings.operatingHours} />
            <SpecialDays days={data.settings.specialDays ?? []} />
            {books && <BookingSettings settings={data.settings} />}
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

        <IntegrationsPanel showCalendar={books} />
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

function ConfigSkeleton(): React.JSX.Element {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <Skeleton className="h-64 w-full rounded-xl" />
      <Skeleton className="h-72 w-full rounded-xl" />
      <Skeleton className="h-40 w-full rounded-xl" />
    </div>
  )
}
