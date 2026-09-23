import type { BusinessConfig } from '@/config/businesses/define.js'
import { BUSINESS_CONFIGS } from '@/config/businesses/index.js'
import { logger } from '@/config/logger.js'
import type { BusinessSettings } from '@/modules/business/business.settings.js'
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

/** The repo file for this business, applied or not. */
export function fileConfigFor(
  businessId: string,
  configs: ReadonlyMap<string, BusinessConfig> = CONFIG_BY_ID,
): BusinessConfig | undefined {
  return configs.get(businessId)
}

export function compositionFor(
  businessId: string,
  settings: BusinessSettings | null,
  configs: ReadonlyMap<string, BusinessConfig> = CONFIG_BY_ID,
): ResolvedComposition {
  let fileSkipped: string | undefined
  const file = configs.get(businessId)
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
  return compileFlow(resolved.composition)
}
