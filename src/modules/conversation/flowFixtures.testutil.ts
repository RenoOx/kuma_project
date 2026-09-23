import type { BusinessSettings } from '@/modules/business/business.settings.js'
import { businessSettingsSchema } from '@/modules/business/business.settings.js'

// One business of every shape the flow and the prompt branch on. Shared by the
// snapshot tests so that a change in either one is judged against the same set.

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const

const NICHES = ['dental', 'barberia', 'estetica', 'salud', 'general'] as const

const WITH_DEPOSIT = {
  requiresDeposit: true,
  depositAmount: 'S/ 20',
  depositPaymentMethods: [{ method: 'yape', number: '987654321', holder: 'Juan' }],
}

function settings(overrides: Record<string, unknown>): BusinessSettings {
  return businessSettingsSchema.parse({
    bookingMode: 'direct',
    slotDurationMinutes: 30,
    operatingHours: Object.fromEntries(
      DAYS.map((d) => [d, { closed: false, open: '09:00', close: '18:00' }]),
    ),
    services: [
      { name: 'Corte', priceMin: 25, priceMax: 25, active: true },
      { name: 'Alisado', requiresEvaluation: true, priceMin: 200, active: true },
      {
        name: 'Tratamiento premium',
        priceMin: 60,
        priceMax: 90,
        category: 'Tratamientos',
        description: 'Limpieza profunda e hidratación.',
        active: true,
      },
    ],
    flowType: 'appointments',
    requiresDeposit: false,
    ...overrides,
  })
}

export const FLOW_FIXTURES: ReadonlyArray<readonly [string, BusinessSettings | null]> = [
  ...NICHES.map((niche) => [`appointments/${niche}`, settings({ niche })] as const),
  ...NICHES.map(
    (niche) => [`appointments/${niche}/deposit`, settings({ niche, ...WITH_DEPOSIT })] as const,
  ),
  ['appointments/barberia/hybrid', settings({ niche: 'barberia', appointmentMode: 'hybrid' })],
  [
    'appointments/dental/requires-approval',
    settings({ niche: 'dental', bookingMode: 'requires_approval' }),
  ],
  ['sales/no-fields', settings({ niche: 'general', flowType: 'sales' })],
  [
    'sales/fields',
    settings({
      niche: 'general',
      flowType: 'sales',
      collectDataFields: ['nombre completo', 'correo', 'DNI'],
    }),
  ],
  // A known leak, pinned on purpose: the deposit blocks are gated on
  // requiresDeposit rather than on the flow type, so a selling business with a
  // deposit stored still receives booking instructions.
  [
    'sales/fields/deposit',
    settings({
      niche: 'general',
      flowType: 'sales',
      collectDataFields: ['nombre completo', 'correo', 'DNI'],
      ...WITH_DEPOSIT,
    }),
  ],
  ['unconfigured', null],
]
