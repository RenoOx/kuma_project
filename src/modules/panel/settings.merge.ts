import { nanoid } from 'nanoid'
import { z } from 'zod'
import type { Business } from '@/db/schema/index.js'
import type {
  AssistantFunction,
  BusinessSettings,
  Service,
} from '@/modules/business/business.settings.js'
import {
  ASSISTANT_FUNCTIONS,
  assistantFunctionFields,
  assistantFunctionOf,
  businessSettingsSchema,
} from '@/modules/business/business.settings.js'
import { NotFoundError, ValidationError } from '@/shared/errors.js'
import { err, ok, type Result } from '@/shared/result.js'

// Pure half of the settings module: the patch schemas, the merge, and the read
// projection. Split from settings.service.ts so none of it depends on the
// database client — these are the parts worth testing exhaustively, and a test
// that imports them should not open a connection to do it (CLAUDE.md rule 8).

// Every patch schema below is derived from businessSettingsSchema.shape rather
// than redeclared. The HH:mm regexes, the open-before-close refinements and the
// break-inside-hours rules are written once, in business.settings.ts, and the
// panel inherits them — a rule added there applies here without an edit.
const shape = businessSettingsSchema.shape

/**
 * A field of the settings schema, made safe to appear in a PATCH.
 *
 * `.partial()` alone is not enough: it marks a key optional but leaves its
 * `.default()`/`.prefault()` in place, so `parse({ bookingMode: 'direct' })`
 * came back carrying `postBooking` with every module switched off. The merge
 * only drops `undefined`, so saving "modo de reserva" from the panel silently
 * turned the owner's reminders off — and saving "pagos" without touching the
 * methods list wiped it to `[]`.
 *
 * Unwrapping the default makes an absent key stay absent all the way through
 * the merge, which is the whole contract of a section patch: it changes the
 * fields the owner edited and nothing else.
 */
type Unwrapped<T extends z.ZodTypeAny> =
  T extends z.ZodDefault<infer Inner> ? Inner : T extends z.ZodPrefault<infer Inner> ? Inner : T

function patchable<T extends z.ZodTypeAny>(field: T): z.ZodOptional<Unwrapped<T>> {
  let inner = field as z.ZodTypeAny
  while (inner.def.type === 'default' || inner.def.type === 'prefault') {
    inner = (inner.def as unknown as { innerType: z.ZodTypeAny }).innerType
  }
  return inner.optional() as z.ZodOptional<Unwrapped<T>>
}

/**
 * A timezone the host's ICU data actually knows.
 *
 * Checked by construction rather than against a hardcoded list: the list would
 * drift, and a timezone this process cannot format is useless to us whatever a
 * list says. Rejecting it here beats storing it and having every date in the
 * panel throw later.
 */
const timezoneSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (tz) => {
      try {
        new Intl.DateTimeFormat('es-PE', { timeZone: tz })
        return true
      } catch {
        return false
      }
    },
    { message: 'unknown IANA timezone' },
  )

// Optional free-text column. Trimmed, and an empty string means "clear it",
// which is why this lands as null rather than '' — the rest of the codebase
// checks these for null, not for emptiness.
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v.length === 0 ? null : v))
    .nullable()
    .optional()

/**
 * Identity and positioning.
 *
 * Straddles two storage locations on purpose: name/ownerName/address/maps and
 * timezone are columns on `businesses`, while niche and appointmentMode live
 * inside the settings jsonb. The owner filling in one form should not have to
 * know which half of it is a column.
 */
export const generalPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    ownerName: optionalText(120),
    address: optionalText(300),
    googleMapsUrl: z.union([z.string().trim().url().max(500), z.literal('')]).optional(),
    timezone: timezoneSchema,
    niche: patchable(shape.niche),
    appointmentMode: patchable(shape.appointmentMode),
  })
  .partial()

export const schedulePatchSchema = z.object({
  operatingHours: shape.operatingHours,
})

export const specialDaysPatchSchema = z.object({
  // Full replacement, not a merge: the UI owns the whole list and sends it back
  // entire. Merging by date would make "delete this holiday" unexpressible.
  specialDays: shape.specialDays,
})

export const bookingPatchSchema = z
  .object({
    bookingMode: patchable(shape.bookingMode),
    slotDurationMinutes: patchable(shape.slotDurationMinutes),
    minBookingNoticeMinutes: patchable(shape.minBookingNoticeMinutes),
    forwardImages: patchable(shape.forwardImages),
    postBooking: patchable(shape.postBooking),
  })
  .partial()

/**
 * The service catalogue, replaced whole.
 *
 * Same reasoning as specialDays: the UI owns the list and hands it back entire,
 * so "edit the third one" is not something a request has to express.
 *
 * Services do carry a stable `id` now — an uploaded photo needs something to
 * belong to — but the wire format did not change because of it. The ids are
 * reconciled on the way in by normalizeServices rather than addressed by the
 * request, so a form that round-trips the array unchanged keeps every id and
 * every photo without knowing either exists.
 *
 * The refine is not the same rule as the schema's own `min(1)`. That one keeps
 * a business from having no services at all; this one keeps it from having none
 * that Emma may offer — a catalogue where every row is switched off leaves her
 * with nothing to sell and no way to book.
 */
export const servicesPatchSchema = z
  .object({
    services: shape.services,
  })
  .refine((v) => v.services.some((s) => s.active), {
    message: 'at least one service must be active',
    path: ['services'],
  })

/**
 * Deposit configuration.
 *
 * Writable from the panel, unlike most of the deposit machinery: the owner is
 * the one who knows their Yape number changed. Note what switching
 * requiresDeposit on actually does — the tool executor then refuses EVERY
 * customer-side book_appointment, and shouldForwardImages starts returning true
 * whatever the forwarding toggle says. The UI says so before the switch is
 * flipped; this schema only makes it reachable.
 */
export const paymentsPatchSchema = z
  .object({
    requiresDeposit: patchable(shape.requiresDeposit),
    depositAmount: patchable(shape.depositAmount),
    depositPaymentMethods: patchable(shape.depositPaymentMethods),
  })
  .partial()

/**
 * Who Emma is for this business, plus what she is for.
 *
 * Pure jsonb, unlike the general section: the business's own name, address and
 * timezone stay columns edited in Configuración, and repeating the name here
 * would give the owner two fields for one fact and no way to tell which won.
 *
 * `assistant` is replaced whole rather than merged field by field, because every
 * field in it carries a default — a patch with only `name` would come back with
 * gender and tone reset. The card owns the object and sends it entire.
 *
 * `assistantFunction` is not stored. It is turned into flowType +
 * appointmentMode by identitySettingsPatch, which is where the single control the
 * spec asks for meets the two fields that already encode it.
 */
export const identityPatchSchema = z
  .object({
    assistant: patchable(shape.assistant),
    assistantFunction: z.enum(ASSISTANT_FUNCTIONS),
  })
  .partial()

export type IdentityPatch = z.infer<typeof identityPatchSchema>

/** Expands the identity form into the settings fields it actually writes. */
export function identitySettingsPatch(patch: IdentityPatch): Partial<BusinessSettings> {
  const out: Partial<BusinessSettings> = {}
  if (patch.assistant !== undefined) out.assistant = patch.assistant
  if (patch.assistantFunction !== undefined) {
    const fields = assistantFunctionFields(patch.assistantFunction)
    out.flowType = fields.flowType
    out.appointmentMode = fields.appointmentMode
  }
  return out
}

/**
 * The configurable message templates, replaced whole.
 *
 * Same reason as `assistant`: the card holds all ten textareas and saves them
 * together, so a partial object here would read as "clear the eight I did not
 * send". Clearing one is done by emptying its textarea, which the schema turns
 * back into undefined — that is, into "use the wording in the code".
 */
export const messagesPatchSchema = z
  .object({
    messages: patchable(shape.messages),
  })
  .partial()

export type MessagesPatch = z.infer<typeof messagesPatchSchema>

/**
 * Conversation parameters.
 *
 * Narrower than the spec's FLUJO table on purpose. Three of the rows it lists —
 * the deposit and its payment methods, and the weekly hours — already have
 * working forms in Servicios and Configuración, and moving them here would mean
 * rebuilding UI that works to satisfy a table. This section takes only what had
 * nowhere to live: the data to collect, the out-of-hours switch, and the two
 * fields stored ahead of the flows that will read them.
 */
export const flowPatchSchema = z
  .object({
    collectDataFields: patchable(shape.collectDataFields),
    outOfHoursEnabled: patchable(shape.outOfHoursEnabled),
    outOfHoursBehavior: patchable(shape.outOfHoursBehavior),
    escalationAttempts: patchable(shape.escalationAttempts),
    cancellationKeyword: patchable(shape.cancellationKeyword),
  })
  .partial()

export type FlowPatch = z.infer<typeof flowPatchSchema>

/**
 * The conversation the owner composed: which nodes, in what order, and the two
 * fields of each one they are allowed to rewrite.
 *
 * Shape only. Whether the composition can actually RUN — every node reachable,
 * every exit backed by a trigger something emits, every requirement met by this
 * business's config — is stateMachine.validateFlow's call, and the route runs it
 * against the MERGED settings before anything is written. Zod cannot answer that
 * question: it depends on the rest of the business's configuration, not on the
 * payload.
 */
export const conversationPatchSchema = z
  .object({
    conversationFlow: patchable(shape.conversationFlow),
  })
  .partial()

export type ConversationPatch = z.infer<typeof conversationPatchSchema>

/**
 * The global Emma switch.
 *
 * Writes `settings.botPaused`, which already exists and already has its gate in
 * handler.ts: a paused business answers with a canned line, escalates the
 * thread and pushes a notice to the owner. Adding a second global flag beside
 * it would have given the owner two switches for one behaviour, and no way to
 * tell which one was keeping Emma quiet.
 *
 * The panel sends intent — paused or not — and the timestamp is stamped here,
 * so a client cannot backdate a pause.
 */
export const botPatchSchema = z.object({
  paused: z.boolean(),
  reason: z.string().trim().max(200).optional(),
  until: z.string().datetime().optional(),
})

export type BotPatch = z.infer<typeof botPatchSchema>

/** Turns the panel's intent into the stored shape. `paused: false` clears it. */
export function botPausedFromPatch(patch: BotPatch, now: Date = new Date()) {
  if (!patch.paused) return null
  return {
    paused: true as const,
    pausedAt: now.toISOString(),
    ...(patch.until ? { until: patch.until } : {}),
    ...(patch.reason ? { reason: patch.reason } : {}),
  }
}

export type GeneralPatch = z.infer<typeof generalPatchSchema>
export type SchedulePatch = z.infer<typeof schedulePatchSchema>
export type SpecialDaysPatch = z.infer<typeof specialDaysPatchSchema>
export type BookingPatch = z.infer<typeof bookingPatchSchema>
export type ServicesPatch = z.infer<typeof servicesPatchSchema>
export type PaymentsPatch = z.infer<typeof paymentsPatchSchema>

/** The settings half of a general patch. The rest are columns on `businesses`. */
type SettingsPatch = Partial<BusinessSettings>

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The two fields of a stored service that identity survives on.
 *
 * A narrow projection rather than the real serviceSchema, and parsed per element:
 * a business whose stored settings do not fully validate — a service missing its
 * price, say — must still keep its ids. Validating the whole array would throw
 * all of them away over one bad row and silently re-mint everything, and a
 * re-minted id is a service whose files nothing points at any more.
 */
const storedServiceLens = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
})

type StoredService = z.infer<typeof storedServiceLens>

function storedServices(currentRaw: unknown): StoredService[] {
  if (!isPlainObject(currentRaw)) return []
  if (!Array.isArray(currentRaw.services)) return []

  const out: StoredService[] = []
  for (const entry of currentRaw.services) {
    const parsed = storedServiceLens.safeParse(entry)
    if (parsed.success) out.push(parsed.data)
  }
  return out
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase()
}

/**
 * Carries service identity across a whole-array replacement.
 *
 * The panel owns the service list and sends it back entire, which is fine for
 * names and prices and fatal for the id. Without this, every save would hand
 * back services with no `id`, mint fresh ones, and leave every uploaded file
 * hanging off an id nothing references — which the orphan sweep would then
 * delete, correctly and catastrophically.
 *
 * Matching runs in two passes so that ids win globally: renaming a service and
 * adding a new one under its old name cannot transplant the first one's identity
 * onto the second. Each stored service can be claimed once — two incoming rows
 * must never come out sharing an id, or they would share their files too.
 *
 * `idFactory` is injectable so tests can assert on ids instead of on nanoid.
 */
export function normalizeServices(
  currentRaw: unknown,
  incoming: Service[],
  idFactory: () => string = nanoid,
): Service[] {
  const byId = new Map<string, StoredService>()
  const byName = new Map<string, StoredService>()
  for (const service of storedServices(currentRaw)) {
    if (service.id) byId.set(service.id, service)
    const key = normalizeName(service.name)
    if (!byName.has(key)) byName.set(key, service)
  }

  const matches = new Map<number, StoredService>()

  const claim = (index: number, match: StoredService): void => {
    matches.set(index, match)
    if (match.id) byId.delete(match.id)
    byName.delete(normalizeName(match.name))
  }

  incoming.forEach((service, index) => {
    if (!service.id) return
    const match = byId.get(service.id)
    if (match) claim(index, match)
  })

  incoming.forEach((service, index) => {
    if (matches.has(index)) return
    const match = byName.get(normalizeName(service.name))
    if (match) claim(index, match)
  })

  return incoming.map((service, index) => {
    const match = matches.get(index)
    // The id is the only thing carried over from the stored entry. Files used
    // to be carried too, through an `imageKey` with three meaningful states,
    // because a save from the services form arrived silent about the photo and
    // silence had to mean "leave it". Media lives in its own table now, keyed by
    // this id, so the services form cannot touch it at all — and the three-state
    // dance disappears with it.
    return {
      ...service,
      id: match?.id ?? service.id ?? idFactory(),
    } satisfies Service
  })
}

/**
 * Confirms a service id belongs to this business, before a file is hung off it.
 *
 * The upload path's tenant check. The route has a serviceId from the URL and a
 * business from the token; without this, a request could name any id and the
 * file would land under a folder nothing references — an orphan created on
 * purpose rather than by accident.
 */
export function serviceExists(business: Business, serviceId: string): Result<void> {
  const parsed = businessSettingsSchema.safeParse(business.settings)
  if (!parsed.success) {
    return err(
      new ValidationError({
        code: 'invalid_settings',
        message: 'stored settings do not validate, cannot resolve a service',
        userMessage: 'La configuración del negocio está incompleta.',
        logContext: { businessId: business.id, serviceId },
      }),
    )
  }

  const found = parsed.data.services.some((candidate) => candidate.id === serviceId)
  if (!found) {
    return err(
      new NotFoundError({
        resource: 'service',
        userMessage: 'No encontramos ese servicio.',
        logContext: { businessId: business.id, serviceId },
      }),
    )
  }
  return ok(undefined)
}

/**
 * Applies one section's patch to the stored settings and revalidates the whole
 * object.
 *
 * Pure, and the core of why the panel PATCHes sections instead of PUTting the
 * document the way /admin does. Two properties matter:
 *
 *   1. Keys absent from the patch are carried over untouched. An owner saving
 *      their opening hours cannot drop `services` by omission — which a full
 *      PUT from a form that never loaded services would do.
 *   2. The MERGED object is validated, never the fragment. A patch that is
 *      individually well-formed but leaves the business inconsistent — a break
 *      that now falls outside shortened opening hours, say — is refused here
 *      rather than persisted and discovered by Emma at runtime.
 *
 * `undefined` values in the patch are dropped before merging, so an absent
 * field and an explicitly-undefined one behave the same. Clearing a value is
 * done with null, which is what the schema's nullable fields expect.
 */
export function mergeSettingsSection(
  businessId: string,
  currentRaw: unknown,
  patch: SettingsPatch,
  idFactory: () => string = nanoid,
): Result<BusinessSettings> {
  const base = isPlainObject(currentRaw) ? currentRaw : {}

  const defined = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  )
  const merged: Record<string, unknown> = { ...base, ...defined }

  // Reconciled here rather than in the service layer so no write path can skip
  // it: every section PATCH funnels through this function, and a services array
  // that arrived without ids would otherwise be persisted exactly as it came.
  if (patch.services !== undefined) {
    merged.services = normalizeServices(currentRaw, patch.services, idFactory)
  }

  const parsed = businessSettingsSchema.safeParse(merged)
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) =>
      issue.path.length === 0 ? '<root>' : issue.path.join('.'),
    )
    return err(
      new ValidationError({
        code: 'invalid_settings',
        message: `merged settings failed validation: ${fields.join(', ')}`,
        // Named fields rather than Zod's English messages: this string reaches
        // a shop owner, and "operatingHours.monday" at least points at the row
        // of the form that is wrong.
        userMessage: `La configuración quedó incompleta o inválida: ${fields.join(', ')}.`,
        logContext: { businessId, fields },
      }),
    )
  }

  return ok(parsed.data)
}

/** What the config screen reads on load: the jsonb plus the columns beside it. */
export interface PanelSettingsView {
  name: string
  ownerName: string | null
  address: string | null
  googleMapsUrl: string | null
  timezone: string
  whatsappNumber: string
  /** Null when the business has never been configured — the UI says so rather than inventing defaults. */
  settings: BusinessSettings | null
  /** Field paths that keep the stored settings from validating. Empty when `settings` is non-null. */
  invalidFields: string[]
  /**
   * Vende / Agenda / Ambas, derived from flowType + appointmentMode.
   *
   * Sent rather than computed in the browser so the mapping lives in exactly one
   * place. Null when the business has no valid settings to derive it from.
   */
  assistantFunction: AssistantFunction | null
}

export function readSettings(business: Business): PanelSettingsView {
  const parsed = businessSettingsSchema.safeParse(business.settings)

  return {
    name: business.name,
    ownerName: business.ownerName,
    address: business.address,
    googleMapsUrl: business.googleMapsUrl,
    timezone: business.timezone,
    whatsappNumber: business.whatsappNumber,
    assistantFunction: parsed.success ? assistantFunctionOf(parsed.data) : null,
    settings: parsed.success ? parsed.data : null,
    invalidFields: parsed.success
      ? []
      : parsed.error.issues.map((issue) =>
          issue.path.length === 0 ? '<root>' : issue.path.join('.'),
        ),
  }
}
