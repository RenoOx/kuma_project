import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { PageLayout } from './components/layout/PageLayout.js'
import { useUnauthorized } from './lib/authGate.js'
import { PanelNotice, PanelSessionProvider } from './lib/session.js'
import { InboxPage } from './pages/InboxPage.js'

// The inbox is what the owner opens and leaves open, so it ships in the first
// chunk. The other three each drag a heavy dependency behind them — FullCalendar
// for Citas, Recharts for Dashboard — and loading those on a phone to render a
// conversation list is most of a megabyte spent on screens nobody opened.
const DashboardPage = lazy(async () => ({
  default: (await import('./pages/DashboardPage.js')).DashboardPage,
}))
const AppointmentsPage = lazy(async () => ({
  default: (await import('./pages/AppointmentsPage.js')).AppointmentsPage,
}))
const CustomersPage = lazy(async () => ({
  default: (await import('./pages/CustomersPage.js')).CustomersPage,
}))
const ConfigPage = lazy(async () => ({
  default: (await import('./pages/ConfigPage.js')).ConfigPage,
}))
const ServicesPage = lazy(async () => ({
  default: (await import('./pages/ServicesPage.js')).ServicesPage,
}))
const AssistantPage = lazy(async () => ({
  default: (await import('./pages/AssistantPage.js')).AssistantPage,
}))

/**
 * The panel's routes, all nested under /:businessId.
 *
 * The business id is a path segment and the token is a query param, which is
 * why every route sits inside PanelSessionProvider: it reads both from the URL
 * once and refuses to render anything if either is missing.
 */
export function App(): React.JSX.Element {
  return (
    <Routes>
      <Route
        path="/:businessId/*"
        element={<PanelSessionProvider>{() => <PanelShell />}</PanelSessionProvider>}
      />
      {/* No business id at all — nothing to authenticate against. */}
      <Route path="*" element={<NoBusiness />} />
    </Routes>
  )
}

function PanelShell(): React.JSX.Element {
  // The URL parsed fine but the server rejected the token — a link that was
  // revoked, rotated, or copied from another business. Replacing the whole
  // panel says that once, instead of every screen failing on its own.
  if (useUnauthorized()) {
    return (
      <PanelNotice
        title="El link dejó de funcionar"
        body="Tu token de acceso ya no es válido. Puede que lo hayan renovado — pedile a Vamvu Labs el link actualizado."
      />
    )
  }

  return (
    <PageLayout>
      <Suspense fallback={<RouteLoading />}>
        <Routes>
          <Route path="/" element={<InboxPage />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/citas" element={<AppointmentsPage />} />
          <Route path="/contactos" element={<CustomersPage />} />
          <Route path="/servicios" element={<ServicesPage />} />
          <Route path="/asistente" element={<AssistantPage />} />
          <Route path="/configuracion" element={<ConfigPage />} />
          <Route path="*" element={<Navigate to="." replace />} />
        </Routes>
      </Suspense>
    </PageLayout>
  )
}

function RouteLoading(): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <p className="text-sm text-muted-foreground">Cargando…</p>
    </div>
  )
}

function NoBusiness(): React.JSX.Element {
  return (
    <PanelNotice
      title="Panel Emma"
      body="Abrí el panel con el link que te dio Vamvu Labs. Incluye tu negocio y tu token de acceso."
    />
  )
}
