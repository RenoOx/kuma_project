import { describe, expect, it } from 'vitest'
import { defineBusinessConfig } from '@/config/businesses/define.js'
import type { BusinessSettings } from '@/modules/business/business.settings.js'
import { businessSettingsSchema } from '@/modules/business/business.settings.js'
import { runSimulation } from '@/modules/simulator/simulationScope.js'
import {
  compositionFor,
  fileConfigFor,
  findTestVersion,
  fixedMessagesWithImages,
  testVersionsFor,
  withFileSettings,
} from './flowSource.js'

// Versiones en prueba (2026-10-26): un flujo nuevo se prueba en prod desde la
// pestaña "Pruebas" mientras WhatsApp sigue con el de siempre. La promesa entera
// es que la versión en prueba solo corre dentro de un turno del simulador que la
// eligió, y solo para ESE negocio.

const BIZ = 'biz-a'
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const

function settingsWith(
  services: Array<{ id: string; name: string; active: boolean }>,
): BusinessSettings {
  return businessSettingsSchema.parse({
    niche: 'general',
    bookingMode: 'direct',
    slotDurationMinutes: 30,
    operatingHours: Object.fromEntries(
      DAYS.map((d) => [d, { closed: false, open: '09:00', close: '18:00' }]),
    ),
    services: services.map((s) => ({ ...s, priceMin: 100, priceMax: 100 })),
    flowType: 'sales',
    requiresDeposit: false,
    collectDataFields: ['DNI'],
  })
}

const settings = settingsWith([
  { id: 'viejo', name: 'Curso de siempre', active: true },
  { id: 'nuevo', name: 'Título nuevo', active: false },
])

const live = defineBusinessConfig({
  businessId: BIZ,
  name: 'A',
  flowType: 'sales',
  greeting: 'Hola de siempre',
  fixedMessages: { oferta: { text: 'oferta vieja', images: true } },
  flow: [
    { node: 'idle' },
    { node: 'greeting' },
    { node: 'informing' },
    { node: 'listado_servicios' },
  ],
})

const testVersion = defineBusinessConfig({
  businessId: BIZ,
  name: 'A',
  flowType: 'sales',
  test: { id: 'nuevo-flujo', label: 'Flujo nuevo', services: ['nuevo'] },
  greeting: 'Hola nuevo',
  fixedMessages: {
    oferta: { text: 'oferta nueva', images: true },
    ofertaNueva: { text: 'la del título', images: true },
    soloTexto: { text: 'sin fotos' },
  },
  flow: [{ node: 'idle' }, { node: 'greeting' }, { node: 'listado_servicios' }],
})

const configs = new Map([[BIZ, live]])
const tests = [testVersion]

describe('test versions', () => {
  it('lists only the versions of this business', () => {
    expect(testVersionsFor(BIZ, tests)).toEqual([{ id: 'nuevo-flujo', label: 'Flujo nuevo' }])
    expect(testVersionsFor('biz-b', tests)).toEqual([])
    expect(findTestVersion('biz-b', 'nuevo-flujo', tests)).toBeUndefined()
  })

  it('runs the live file outside a simulator turn', () => {
    expect(fileConfigFor(BIZ, configs, tests)).toBe(live)
    const resolved = compositionFor(BIZ, settings, configs, tests)
    expect(resolved.source).toBe('file')
    expect(resolved.composition.nodes).toEqual([
      'idle',
      'greeting',
      'informing',
      'listado_servicios',
    ])
  })

  it('runs the chosen version inside a simulator turn of the same business', async () => {
    await runSimulation({ businessId: BIZ, versionId: 'nuevo-flujo' }, async () => {
      expect(fileConfigFor(BIZ, configs, tests)).toBe(testVersion)
      const resolved = compositionFor(BIZ, settings, configs, tests)
      expect(resolved.source).toBe('file')
      expect(resolved.composition.nodes).toEqual(['idle', 'greeting', 'listado_servicios'])
      expect(withFileSettings(BIZ, settings, configs, tests).settings.messages.greeting).toBe(
        'Hola nuevo',
      )
    })
  })

  it('keeps the live file inside a simulator turn of another business', async () => {
    await runSimulation({ businessId: 'biz-b', versionId: 'nuevo-flujo' }, async () => {
      expect(fileConfigFor(BIZ, configs, tests)).toBe(live)
    })
  })

  it('keeps the live file when the turn chose the live version or one that no longer exists', async () => {
    await runSimulation({ businessId: BIZ, versionId: null }, async () => {
      expect(fileConfigFor(BIZ, configs, tests)).toBe(live)
    })
    await runSimulation({ businessId: BIZ, versionId: 'publicada' }, async () => {
      expect(fileConfigFor(BIZ, configs, tests)).toBe(live)
    })
  })

  it('does not leak the version to work running outside the turn at the same time', async () => {
    let outside: unknown
    const whatsappTurn = new Promise<void>((resolve) => {
      setTimeout(() => {
        outside = fileConfigFor(BIZ, configs, tests)
        resolve()
      }, 5)
    })
    await runSimulation({ businessId: BIZ, versionId: 'nuevo-flujo' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    await whatsappTurn
    expect(outside).toBe(live)
  })

  it('makes the version services the only active ones, only inside the turn', async () => {
    const activeNames = () =>
      withFileSettings(BIZ, settings, configs, tests)
        .settings.services.filter((s) => s.active)
        .map((s) => s.name)

    expect(activeNames()).toEqual(['Curso de siempre'])
    await runSimulation({ businessId: BIZ, versionId: 'nuevo-flujo' }, async () => {
      expect(activeNames()).toEqual(['Título nuevo'])
      expect(withFileSettings(BIZ, settings, configs, tests).fromFile).toContain('services')
    })
  })

  it('lists the photo slots of the live file and of its test versions, once per id', () => {
    expect(fixedMessagesWithImages(BIZ, configs, tests)).toEqual([
      { id: 'oferta' },
      { id: 'ofertaNueva', version: 'Flujo nuevo' },
    ])
    expect(fixedMessagesWithImages('biz-b', configs, tests)).toEqual([])
  })

  it('refuses a test id that cannot travel in the URL', () => {
    expect(() =>
      defineBusinessConfig({
        businessId: BIZ,
        name: 'A',
        flowType: 'sales',
        test: { id: 'Flujo Nuevo', label: 'x' },
        flow: [{ node: 'idle' }, { node: 'greeting' }],
      }),
    ).toThrow()
  })
})
