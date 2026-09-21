// Shared vocabulary between the panel's screens. Anything that maps a database
// value to something a human reads lives here, so a new qualification state or
// a new niche is one edit rather than a grep across components.

// Labels the owner invents for their own conversations. Replaced the fixed
// `qualification` enum: a set of seven values shipped from here was never going
// to describe somebody else's business.
//
// The palette is closed on purpose — the panel renders on a near-black ground,
// and a brand colour picked freely can land on a pill nobody can read. These ten
// are checked against that background. Mirrors TAG_COLORS on the server, which
// is the authority: a value missing there is a 400.
export const TAG_COLORS = [
  'emerald',
  'blue',
  'violet',
  'rose',
  'amber',
  'cyan',
  'pink',
  'indigo',
  'orange',
  'teal',
] as const

export type TagColor = (typeof TAG_COLORS)[number]

interface TagColorMeta {
  /** Tinted background + solid text, the same recipe the old badges used. */
  className: string
  /** Solid fill, for the dot in a menu where there is no pill to tint. */
  dotClassName: string
}

export const TAG_COLOR_META: Record<TagColor, TagColorMeta> = {
  emerald: { className: 'bg-emerald-500/15 text-emerald-400', dotClassName: 'bg-emerald-500' },
  blue: { className: 'bg-blue-500/15 text-blue-400', dotClassName: 'bg-blue-500' },
  violet: { className: 'bg-violet-500/15 text-violet-400', dotClassName: 'bg-violet-500' },
  rose: { className: 'bg-rose-500/15 text-rose-400', dotClassName: 'bg-rose-500' },
  amber: { className: 'bg-amber-500/15 text-amber-400', dotClassName: 'bg-amber-500' },
  cyan: { className: 'bg-cyan-500/15 text-cyan-400', dotClassName: 'bg-cyan-500' },
  pink: { className: 'bg-pink-500/15 text-pink-400', dotClassName: 'bg-pink-500' },
  indigo: { className: 'bg-indigo-500/15 text-indigo-400', dotClassName: 'bg-indigo-500' },
  orange: { className: 'bg-orange-500/15 text-orange-400', dotClassName: 'bg-orange-500' },
  teal: { className: 'bg-teal-500/15 text-teal-400', dotClassName: 'bg-teal-500' },
}

/** Mirrors MAX_TAGS_PER_BUSINESS on the server. */
export const MAX_TAGS = 10

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

// Polling cadences. V1 is polling only — no WebSockets.
export const POLL_MS = {
  inbox: 5_000,
  appointments: 10_000,
  dashboard: 30_000,
  health: 30_000,
} as const

// ── Services, payments and knowledge base ────────────────────────────────────

// Mirrors DEPOSIT_METHOD_LABELS on the server. The set is closed: these four are
// what Peruvian businesses actually collect with.
export const DEPOSIT_METHODS = ['yape', 'plin', 'transferencia', 'efectivo'] as const

export const DEPOSIT_METHOD_LABELS: Record<(typeof DEPOSIT_METHODS)[number], string> = {
  yape: 'Yape',
  plin: 'Plin',
  transferencia: 'Transferencia',
  efectivo: 'Efectivo',
}

// Only the three active categories. The four retired ones (ubicacion, servicios,
// precios, contacto) duplicated business settings and nothing writes them any
// more — see KB_CATEGORIES on the server.
export const KB_CATEGORIES = ['politicas', 'informacion_general', 'promociones'] as const

export const KB_CATEGORY_LABELS: Record<(typeof KB_CATEGORIES)[number], string> = {
  politicas: 'Políticas',
  informacion_general: 'Preguntas frecuentes',
  promociones: 'Promociones',
}

export const KB_SEND_MODE_LABELS: Record<'always' | 'on_request' | 'trigger_based', string> = {
  always: 'Siempre',
  on_request: 'Bajo pedido',
  trigger_based: 'Por palabras clave',
}

export const KB_ATTACHMENT_TYPE_LABELS: Record<
  'none' | 'link' | 'image' | 'pdf' | 'video',
  string
> = {
  none: 'Sin adjunto',
  link: 'Enlace',
  image: 'Imagen',
  pdf: 'PDF',
  video: 'Video',
}

// Emma loads at most this many entries from one category, oldest first. Past it,
// the newest entries never reach her — the list warns when a category crosses
// the line. Mirrors MAX_ENTRIES_PER_QUERY in knowledgeBaseSearch.service.ts.
export const MAX_KB_ENTRIES_PER_CATEGORY = 5
