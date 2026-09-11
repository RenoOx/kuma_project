// Shared vocabulary between the panel's screens. Anything that maps a database
// value to something a human reads lives here, so a new qualification state or
// a new niche is one edit rather than a grep across components.

export const QUALIFICATIONS = [
  'new',
  'qualified',
  'needs_info',
  'appointment',
  'waiting',
  'lost',
  'human_takeover',
] as const

export type Qualification = (typeof QUALIFICATIONS)[number]

// What the owner may pick by hand in the chat header. Mirrors
// MANUALLY_SETTABLE_QUALIFICATIONS on the server, which is the authority: a
// value missing there is a 400, not a silent no-op.
//
// 'appointment' and 'human_takeover' are absent on purpose. Both are records of
// something that happened — a booking was filed, a person answered — and
// asserting them by hand would put a conversion in the dashboard that no
// appointment backs.
export const MANUAL_QUALIFICATIONS = [
  'new',
  'qualified',
  'needs_info',
  'waiting',
  'lost',
] as const satisfies readonly Qualification[]

export type ManualQualification = (typeof MANUAL_QUALIFICATIONS)[number]

interface QualificationMeta {
  label: string
  /** Tailwind classes for the badge. Tinted background, solid text. */
  className: string
  /** Solid fill, for the dot in the label menu where there is no pill to tint. */
  dotClassName: string
}

export const QUALIFICATION_META: Record<Qualification, QualificationMeta> = {
  new: { label: 'Nuevo', className: 'bg-q-new/15 text-q-new', dotClassName: 'bg-q-new' },
  qualified: {
    label: 'Calificado',
    className: 'bg-q-qualified/15 text-q-qualified',
    dotClassName: 'bg-q-qualified',
  },
  needs_info: {
    label: 'Necesita info',
    className: 'bg-q-needs-info/15 text-q-needs-info',
    dotClassName: 'bg-q-needs-info',
  },
  appointment: {
    label: 'Cita',
    className: 'bg-q-appointment/20 text-q-qualified',
    dotClassName: 'bg-q-appointment',
  },
  waiting: {
    label: 'Esperando',
    className: 'bg-q-waiting/15 text-q-waiting',
    dotClassName: 'bg-q-waiting',
  },
  lost: { label: 'Perdido', className: 'bg-q-lost/15 text-q-lost', dotClassName: 'bg-q-lost' },
  human_takeover: {
    label: 'Humano',
    className: 'bg-q-human/15 text-q-human',
    dotClassName: 'bg-q-human',
  },
}

// Mirrors appointmentStatuses in the Drizzle schema. 'pending' is what a
// business on bookingMode 'requires_approval' produces and is the only status
// with actions waiting on a human.
export const APPOINTMENT_STATUSES = [
  'pending',
  'scheduled',
  'confirmed',
  'cancelled',
  'completed',
] as const

export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number]

interface AppointmentMeta {
  label: string
  /** Solid hex for the calendar event, which FullCalendar styles inline. */
  color: string
  /** Tailwind classes for the badge, mirroring the hex above. */
  className: string
}

export const APPOINTMENT_META: Record<AppointmentStatus, AppointmentMeta> = {
  pending: {
    label: 'Pendiente',
    color: '#f59e0b',
    className: 'bg-q-needs-info/15 text-q-needs-info',
  },
  scheduled: { label: 'Agendada', color: '#3b82f6', className: 'bg-q-new/15 text-q-new' },
  confirmed: {
    label: 'Confirmada',
    color: '#10b981',
    className: 'bg-q-qualified/15 text-q-qualified',
  },
  completed: { label: 'Completada', color: '#6b7280', className: 'bg-q-waiting/15 text-q-waiting' },
  cancelled: { label: 'Cancelada', color: '#ef4444', className: 'bg-q-lost/15 text-q-lost' },
}

// Monday-first, which is how a work week reads in Peru. FullCalendar counts
// days from Sunday, so anything handed to it converts on the way out.
export const DAY_KEYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const

export const DAY_LABELS: Record<(typeof DAY_KEYS)[number], string> = {
  monday: 'Lunes',
  tuesday: 'Martes',
  wednesday: 'Miércoles',
  thursday: 'Jueves',
  friday: 'Viernes',
  saturday: 'Sábado',
  sunday: 'Domingo',
}

// Niche-driven copy. One config object indexed by niche rather than a component
// per niche — the layout is identical, only the words change.
export const NICHES = ['dental', 'barberia', 'estetica', 'salud', 'general'] as const
export type Niche = (typeof NICHES)[number]

export interface NicheCopy {
  /** Navigation label. Same for every niche today, kept per-niche so it can diverge again. */
  contactsLabel: string
  /** The word for one of them, which DOES change: a clinic has pacientes, a barber clientes. */
  contactSingular: string
  appointmentsLabel: string
  dashboardTitle: string
}

// Navigation reads the same in every niche — "Agenda" and "Contactos" — while
// the words inside the screens still follow the business. A dentist sees
// Contactos in the nav and "paciente" in a sentence.
const CLIENT_COPY: NicheCopy = {
  contactsLabel: 'Contactos',
  contactSingular: 'cliente',
  appointmentsLabel: 'Agenda',
  dashboardTitle: 'Resumen del negocio',
}

export const NICHE_COPY: Record<Niche, NicheCopy> = {
  dental: {
    ...CLIENT_COPY,
    contactSingular: 'paciente',
    dashboardTitle: 'Resumen de atención',
  },
  salud: {
    ...CLIENT_COPY,
    contactSingular: 'paciente',
    dashboardTitle: 'Resumen de atención',
  },
  estetica: {
    ...CLIENT_COPY,
    dashboardTitle: 'Resumen del centro',
  },
  barberia: CLIENT_COPY,
  general: CLIENT_COPY,
}

export function nicheCopy(niche: string | null | undefined): NicheCopy {
  if (niche && (NICHES as readonly string[]).includes(niche)) {
    return NICHE_COPY[niche as Niche]
  }
  return NICHE_COPY.general
}

// Polling cadences, per PANEL_SPEC. V1 is polling only — no WebSockets.
export const POLL_MS = {
  inbox: 5_000,
  appointments: 10_000,
  dashboard: 30_000,
  health: 30_000,
} as const
