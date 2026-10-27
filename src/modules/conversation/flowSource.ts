import type { BusinessConfig } from '@/config/businesses/define.js'
import { BUSINESS_CONFIGS, TEST_CONFIGS } from '@/config/businesses/index.js'
import { logger } from '@/config/logger.js'
import type { BusinessSettings } from '@/modules/business/business.settings.js'
import { simulationScope } from '@/modules/simulator/simulationScope.js'
import {
  compileFlow,
  type FlowComposition,
  type FlowDefinition,
  presetFor,
  validateFlow,
} from './stateMachine.js'

// Where a business's conversation comes from. The one place that answers it, so
// Emma, the panel and business:show can never disagree about which flow runs.
//
//   1. A file in src/config/businesses/ for this businessId — while its flowType
//      matches the database and it validates against the current config.
//   2. What the owner saved from the panel, while it validates.
//   3. The preset for the business's flow type.
//
// A file that is skipped is an error, not a preference: someone put it in the
// repo to be obeyed. Falling through keeps the business answering instead of
// taking it down, and the log says why.

export type FlowSource = 'file' | 'stored' | 'preset'

export interface ResolvedComposition {
  composition: FlowComposition
  source: FlowSource
  /** Why a file for this business exists but is not the one running. */
  fileSkipped?: string
  /** Why the flow saved from the panel exists but is not the one running. */
  storedSkipped?: string
}

const CONFIG_BY_ID: ReadonlyMap<string, BusinessConfig> = new Map(
  BUSINESS_CONFIGS.map((config) => [config.businessId, config]),
)

/** Una versión en prueba, como la lista la pestaña "Pruebas". */
export interface TestVersionSummary {
  id: string
  label: string
}

/** Las versiones en prueba de este negocio (`TEST_CONFIGS`), en el orden del índice. */
export function testVersionsFor(
  businessId: string,
  tests: ReadonlyArray<BusinessConfig> = TEST_CONFIGS,
): TestVersionSummary[] {
  return tests.flatMap((config) =>
    config.businessId === businessId && config.test
      ? [{ id: config.test.id, label: config.test.label }]
      : [],
  )
}

/** La versión en prueba `versionId` de ESTE negocio; otro negocio nunca la encuentra. */
export function findTestVersion(
  businessId: string,
  versionId: string,
  tests: ReadonlyArray<BusinessConfig> = TEST_CONFIGS,
): BusinessConfig | undefined {
  return tests.find((config) => config.businessId === businessId && config.test?.id === versionId)
}

/**
 * El archivo que corre para este negocio en este momento: la versión en prueba
 * si el código corre dentro de un turno del simulador que la eligió (y es de
 * este negocio), la de siempre en cualquier otro caso. Una versión que ya no
 * existe (se publicó o se borró con la pestaña abierta) cae a la de siempre.
 */
function configFor(
  businessId: string,
  configs: ReadonlyMap<string, BusinessConfig>,
  tests: ReadonlyArray<BusinessConfig>,
): BusinessConfig | undefined {
  const scope = simulationScope()
  if (scope?.businessId === businessId && scope.versionId) {
    const test = findTestVersion(businessId, scope.versionId, tests)
    if (test) return test
    logger.warn(
      { component: 'flowSource', businessId, versionId: scope.versionId },
      'test version not found, running the live file',
    )
  }
  return configs.get(businessId)
}

/** Un mensaje fijo que admite fotos, como lo lista el panel para subirlas. */
export interface FixedMessageSlot {
  id: string
  when?: string
  /** El nombre de la versión en prueba que lo trae; ausente si es de la de siempre. */
  version?: string
}

/**
 * Los mensajes fijos con `images: true` de este negocio: los de la versión de
 * siempre y los de sus versiones en prueba. Las fotos de una versión en prueba
 * se suben en prod ANTES de publicarla (son por negocio y por id de mensaje),
 * así que al publicar ya están. Un id repetido se lista una vez: comparte fotos.
 */
export function fixedMessagesWithImages(
  businessId: string,
  configs: ReadonlyMap<string, BusinessConfig> = CONFIG_BY_ID,
  tests: ReadonlyArray<BusinessConfig> = TEST_CONFIGS,
): FixedMessageSlot[] {
  const slots = new Map<string, FixedMessageSlot>()
  const sources = [
    configs.get(businessId),
    ...tests.filter((config) => config.businessId === businessId),
  ]
  for (const config of sources) {
    for (const [id, message] of Object.entries(config?.fixedMessages ?? {})) {
      if (!message.images || slots.has(id)) continue
      slots.set(id, {
        id,
        ...(message.when !== undefined ? { when: message.when } : {}),
        ...(config?.test ? { version: config.test.label } : {}),
      })
    }
  }
  return [...slots.values()]
}

/** The repo file for this business, applied or not. */
export function fileConfigFor(
  businessId: string,
  configs: ReadonlyMap<string, BusinessConfig> = CONFIG_BY_ID,
  tests: ReadonlyArray<BusinessConfig> = TEST_CONFIGS,
): BusinessConfig | undefined {
  return configFor(businessId, configs, tests)
}

/** Qué campos de los settings puso el archivo, para mostrarlo (business:show, panel). */
export type FileSettingsField =
  | 'greeting'
  | 'tone'
  | 'instructions'
  | 'collectData'
  | 'requiresDeposit'
  | 'handoff'
  | 'services'

export interface SettingsWithFile {
  settings: BusinessSettings
  /** Los campos que vinieron del archivo; vacío si no hay archivo o no aplica. */
  fromFile: FileSettingsField[]
}

/**
 * Los settings de la base con lo que el archivo del negocio pone encima: saludo,
 * tono, instrucciones generales, datos a pedir y, si lo apaga, el adelanto.
 *
 * Misma condición que el flujo: solo si el flowType del archivo coincide con el
 * de la base. Un archivo escrito para un instituto no le cambia el saludo a un
 * negocio que en la base es de agenda. Lo que no dice el archivo queda como está
 * en la base. Nunca se escribe en la base: se aplica en cada lectura.
 */
export function withFileSettings(
  businessId: string,
  settings: BusinessSettings,
  configs: ReadonlyMap<string, BusinessConfig> = CONFIG_BY_ID,
  tests: ReadonlyArray<BusinessConfig> = TEST_CONFIGS,
): SettingsWithFile {
  const file = configFor(businessId, configs, tests)
  if (!file || file.flowType !== settings.flowType) return { settings, fromFile: [] }

  const { greeting, tone, instructions, collectData, requiresDeposit, handoff } = file.settings
  const fromFile: FileSettingsField[] = []
  if (greeting !== undefined) fromFile.push('greeting')
  if (tone !== undefined) fromFile.push('tone')
  if (instructions !== undefined) fromFile.push('instructions')
  if (collectData !== undefined) fromFile.push('collectData')
  if (requiresDeposit !== undefined) fromFile.push('requiresDeposit')
  if (handoff !== undefined) fromFile.push('handoff')
  // Solo una versión en prueba trae su lista: dentro de la prueba, esos servicios
  // son los activos aunque en la base estén apagados (se crean inactivos para
  // que WhatsApp no los vea), y el resto no existe.
  const testServices = file.test?.services
  if (testServices) fromFile.push('services')
  if (fromFile.length === 0) return { settings, fromFile }

  return {
    settings: {
      ...settings,
      ...(testServices
        ? {
            services: settings.services.map((service) => ({
              ...service,
              active: service.id !== undefined && testServices.includes(service.id),
            })),
          }
        : {}),
      ...(collectData !== undefined ? { collectDataFields: collectData } : {}),
      ...(requiresDeposit !== undefined ? { requiresDeposit } : {}),
      messages: {
        ...settings.messages,
        ...(greeting !== undefined ? { greeting } : {}),
        ...(handoff !== undefined ? { handoff } : {}),
      },
      assistant: {
        ...settings.assistant,
        ...(tone !== undefined ? { tone } : {}),
        ...(instructions !== undefined ? { customInstructions: instructions } : {}),
      },
    },
    fromFile,
  }
}

export function compositionFor(
  businessId: string,
  settings: BusinessSettings | null,
  configs: ReadonlyMap<string, BusinessConfig> = CONFIG_BY_ID,
  tests: ReadonlyArray<BusinessConfig> = TEST_CONFIGS,
): ResolvedComposition {
  let fileSkipped: string | undefined
  const file = configFor(businessId, configs, tests)
  if (file) {
    const flowType = settings?.flowType ?? 'appointments'
    if (file.flowType !== flowType) {
      fileSkipped = `el archivo dice flowType "${file.flowType}" y la base "${flowType}"`
    } else {
      const checked = validateFlow(file.composition, settings)
      if (checked.ok) return { composition: file.composition, source: 'file' }
      fileSkipped = checked.error.message
    }
  }

  const stored = settings?.conversationFlow
  if (stored) {
    const checked = validateFlow(stored, settings)
    if (checked.ok) {
      return { composition: stored, source: 'stored', ...(fileSkipped ? { fileSkipped } : {}) }
    }
    return {
      composition: presetFor(settings),
      source: 'preset',
      ...(fileSkipped ? { fileSkipped } : {}),
      storedSkipped: checked.error.message,
    }
  }

  return {
    composition: presetFor(settings),
    source: 'preset',
    ...(fileSkipped ? { fileSkipped } : {}),
  }
}

/** The compiled flow a business runs this turn. Logs any source it had to skip. */
export function resolveBusinessFlow(
  businessId: string,
  settings: BusinessSettings | null,
): FlowDefinition {
  const resolved = compositionFor(businessId, settings)
  if (resolved.fileSkipped) {
    logger.error(
      {
        component: 'flowSource',
        businessId,
        reason: resolved.fileSkipped,
        running: resolved.source,
      },
      'business config file not applied',
    )
  }
  if (resolved.storedSkipped) {
    logger.warn(
      { component: 'flowSource', businessId, reason: resolved.storedSkipped },
      'stored conversation flow does not validate, falling back to preset',
    )
  }
  return compileFlow(resolved.composition, settings?.flowType ?? 'appointments')
}
