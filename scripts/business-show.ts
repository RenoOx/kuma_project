import { z } from 'zod'
import { queryClient } from '@/db/client.js'
import type { Business } from '@/db/schema/index.js'
import * as businessRepo from '@/modules/business/business.repo.js'
import {
  type BusinessSettings,
  businessSettingsSchema,
} from '@/modules/business/business.settings.js'
import {
  compositionFor,
  fileConfigFor,
  withFileSettings,
} from '@/modules/conversation/flowSource.js'
import { blueprintFor } from '@/modules/conversation/nodeCatalog.js'
import { compileFlow, getStateConfig } from '@/modules/conversation/stateMachine.js'
import { buildSystemPrompt, renderNodeBlock } from '@/modules/llm/prompts.js'

// Everything that decides how Emma talks for one business, read from the same
// resolver Emma uses — so what this prints is what runs, not a reconstruction.
// Read-only: it only SELECTs, always by the id it was given.
//
// Usage (through the env guard, never directly):
//   npm run business:show:dev -- <businessId>
//   npm run business:show:dev -- <businessId> --prompt <state>
//   npm run business:show:dev -- --all
//   npm run business:show:prod -- <businessId>

const businessIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)

const SOURCE_LABEL = {
  file: 'archivo en src/config/businesses/',
  stored: 'guardada desde el panel',
  preset: 'preset (derivada de la configuración)',
} as const

function out(line = ''): void {
  process.stdout.write(`${line}\n`)
}

// Igual que businessService.getSettings: con lo del archivo encima, para que lo
// que se muestra sea lo que corre.
function parseSettings(business: Business): BusinessSettings | null {
  const parsed = businessSettingsSchema.safeParse(business.settings)
  if (!parsed.success) {
    out(`⚠ settings inválidos: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`)
    return null
  }
  const { settings, fromFile } = withFileSettings(business.id, parsed.data)
  if (fromFile.length > 0) out(`Del archivo (mandan sobre la base): ${fromFile.join(', ')}`)
  return settings
}

function showSummary(business: Business): void {
  const settings = businessSettingsSchema.safeParse(business.settings)
  const data = settings.success ? settings.data : null
  const resolved = compositionFor(business.id, data)
  const flags = [
    resolved.fileSkipped ? `ARCHIVO NO APLICADO: ${resolved.fileSkipped}` : '',
    resolved.storedSkipped ? `GUARDADA INVÁLIDA: ${resolved.storedSkipped}` : '',
    settings.success ? '' : 'SETTINGS INVÁLIDOS',
  ].filter(Boolean)
  out(
    `${business.id}  ${business.name}  ·  ${data?.flowType ?? '—'}  ·  ${resolved.source}${
      flags.length > 0 ? `  ·  ${flags.join(' | ')}` : ''
    }`,
  )
}

function showBusiness(business: Business, promptState: string | null): void {
  out(`${business.name}  (${business.id})`)
  const settings = parseSettings(business)
  out(
    `flowType: ${settings?.flowType ?? '—'} · nicho: ${settings?.niche ?? '—'} · adelanto: ${
      settings?.requiresDeposit ? (settings.depositAmount ?? 'sí') : 'no'
    }`,
  )

  const resolved = compositionFor(business.id, settings)
  out(`Composición: ${SOURCE_LABEL[resolved.source]}`)
  if (fileConfigFor(business.id) && resolved.source !== 'file') {
    out(`⚠ Hay archivo para este negocio y NO se está aplicando: ${resolved.fileSkipped}`)
  }
  if (resolved.storedSkipped) {
    out(`⚠ La composición guardada no valida y corre el preset: ${resolved.storedSkipped}`)
  }
  out()

  const { nodes, overrides } = resolved.composition
  out(`  ${nodes.join(' → ')}`)

  const flowType = settings?.flowType ?? 'appointments'
  const flow = compileFlow(resolved.composition, flowType)
  const fileMessages = fileConfigFor(business.id)?.fixedMessages ?? {}
  for (const id of nodes) {
    // Como lo corre este tipo de flujo: con el ejemplo y las tools extendidas.
    const blueprint = blueprintFor(id, flowType)
    const override = overrides[id] ?? {}
    const state = flow[id]
    out()
    out(`── ${override.label ?? blueprint?.label ?? id}  [${id}] ${'─'.repeat(20)}`)
    if (!blueprint) {
      out('  (no existe en el catálogo)')
      continue
    }
    const mark = (field: 'edgeCases' | 'example'): string =>
      override[field] !== undefined ? 'override' : 'default'
    out(
      `  edgeCases: ${mark('edgeCases')} (${(override.edgeCases ?? blueprint.node.edgeCases).length})`,
    )
    out(`  example:   ${mark('example')}`)
    if (override.extraInstructions?.trim())
      out(`  extra:     "${override.extraInstructions.trim()}"`)
    for (const branch of state?.branches ?? []) {
      out(`  ruta:      ${branch.id} → ${branch.to}  (${branch.when})`)
    }
    if (state?.cta) out(`  cierre:    "${state.cta}"`)
    if (state?.onImage) {
      const what = [
        state.onImage.forward ? 'reenvía al dueño' : '',
        state.onImage.pause ? 'pausa a Emma' : '',
        state.onImage.reply ? `responde "${state.onImage.reply}"` : '',
      ].filter(Boolean)
      out(`  foto:      ${what.join(' · ')}`)
    }
    for (const id of state?.fixedMessages ?? []) {
      const known = fileMessages[id] !== undefined
      out(`  fijo:      ${id}${known ? '' : '  ⚠ no está en fixedMessages del archivo'}`)
    }
    out(`  tools:     ${(state?.tools ?? []).join(', ') || '—'}`)
  }

  if (promptState) {
    out()
    out(`════ Prompt en el estado "${promptState}" (KB vacía: se elige mensaje a mensaje) ════`)
    const config = getStateConfig(flow, promptState)
    const body = buildSystemPrompt(business, [], settings)
    const fixed = (config.fixedMessages ?? []).flatMap((id) => {
      const message = fileMessages[id]
      return message ? [{ id, when: message.when ?? '' }] : []
    })
    const node = renderNodeBlock(config.node, config.branches, fixed)
    out(node ? `${body}\n\n${node}` : body)
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  if (args.includes('--all')) {
    for (const business of await businessRepo.findAll()) showSummary(business)
    return
  }

  const promptIndex = args.indexOf('--prompt')
  const promptState = promptIndex === -1 ? null : (args[promptIndex + 1] ?? null)
  const promptValueIndex = promptIndex === -1 ? -1 : promptIndex + 1
  const id = businessIdSchema.safeParse(
    args.find((arg, i) => !arg.startsWith('--') && i !== promptValueIndex),
  )
  if (!id.success) {
    out('Uso: npm run business:show:dev -- <businessId> [--prompt <estado>] | --all')
    process.exitCode = 1
    return
  }

  const business = await businessRepo.findById(id.data)
  if (!business) {
    out(`No existe un negocio con id ${id.data}.`)
    process.exitCode = 1
    return
  }
  showBusiness(business, promptState)
}

async function run(): Promise<void> {
  try {
    await main()
  } finally {
    await queryClient.end()
  }
}

void run()
