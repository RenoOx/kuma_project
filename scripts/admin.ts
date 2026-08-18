/**
 * Admin CLI for Kuma.
 *
 * Usage: npm run admin -- <resource> <command> [args]
 *
 * business list
 * business get <id>
 * business create --name=X --whatsapp=+51X [--owner=+51X] [--owner-name=X] [--timezone=X]
 * business update <id> [--name=X] [--whatsapp=+51X] [--owner=+51X] [--owner-name=X]
 * business settings <id>
 * business set-settings <id> <settings.json>   ← full replacement, not merge
 *
 * kb list <businessId>
 * kb add <businessId> --category=X --content=X [--title=X] [--send-mode=X] ...
 * kb update <businessId> <id> [--category=X] [--content=X] ...
 * kb delete <businessId> <id>
 */
import { readFileSync } from 'node:fs'
import { db, queryClient } from '@/db/client.js'
import { businesses } from '@/db/schema/index.js'
import type { KbAttachmentType, KbCategory, KbSendMode } from '@/db/schema/index.js'
import * as businessRepo from '@/modules/business/business.repo.js'
import * as businessService from '@/modules/business/business.service.js'
import { businessSettingsSchema } from '@/modules/business/business.settings.js'
import type { KnowledgeBasePatch } from '@/modules/knowledgeBase/knowledgeBase.repo.js'
import * as knowledgeBaseService from '@/modules/knowledgeBase/knowledgeBase.service.js'
import {
  KB_ATTACHMENT_TYPES,
  KB_CATEGORIES,
  KB_SEND_MODES,
} from '@/modules/knowledgeBase/knowledgeBase.types.js'
import { normalizePhone } from '@/shared/phone.js'
import { asc } from 'drizzle-orm'

// ── Arg parser ────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=')
      if (eqIdx === -1) {
        flags[arg.slice(2)] = 'true'
      } else {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1)
      }
    } else {
      positional.push(arg)
    }
  }
  return { positional, flags }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function die(msg: string, code = 1): never {
  console.error(`\nError: ${msg}\n`)
  process.exit(code)
}

function ok(msg: string): void {
  console.log(`\n✓ ${msg}`)
}

function printJson(label: string, obj: unknown): void {
  console.log(`\n${label}:`)
  console.log(JSON.stringify(obj, null, 2))
}

// ── Business commands ─────────────────────────────────────────────────────────

async function businessList(): Promise<void> {
  const rows = await db
    .select({
      id: businesses.id,
      name: businesses.name,
      whatsappNumber: businesses.whatsappNumber,
      ownerName: businesses.ownerName,
      ownerWhatsappNumber: businesses.ownerWhatsappNumber,
      timezone: businesses.timezone,
      createdAt: businesses.createdAt,
    })
    .from(businesses)
    .orderBy(asc(businesses.createdAt))

  if (rows.length === 0) {
    console.log('\n(no businesses found)')
    return
  }
  console.log()
  console.table(rows)
}

async function businessGet(id: string): Promise<void> {
  const result = await businessService.getById(id)
  if (!result.ok) die(`business not found: ${id}`)
  printJson('Business', result.data)
}

async function businessCreate(flags: Record<string, string>): Promise<void> {
  if (!flags.name) die('--name is required', 2)
  if (!flags.whatsapp) die('--whatsapp is required', 2)

  const result = await businessService.register({
    name: flags.name,
    whatsappNumber: flags.whatsapp,
    ownerWhatsappNumber: normalizePhone(flags.owner),
    ownerName: flags['owner-name'] ?? null,
    timezone: flags.timezone,
  })
  if (!result.ok) die(`create failed: ${result.error.message}`)

  ok(`business created: ${result.data.id}`)
  printJson('Business', result.data)
}

async function businessUpdate(id: string, flags: Record<string, string>): Promise<void> {
  type Patch = Parameters<typeof businessRepo.update>[1]
  const patch: Patch = {}

  if (flags.name !== undefined) patch.name = flags.name
  if (flags.whatsapp !== undefined) patch.whatsappNumber = flags.whatsapp
  if (flags.owner !== undefined) patch.ownerWhatsappNumber = normalizePhone(flags.owner)
  if (flags['owner-name'] !== undefined) patch.ownerName = flags['owner-name'] || null

  if (Object.keys(patch).length === 0) {
    die('nothing to update — pass at least one of: --name --whatsapp --owner --owner-name', 2)
  }

  const updated = await businessRepo.update(id, patch)
  ok(`business updated`)
  printJson('Business', updated)
}

async function businessSettings(id: string): Promise<void> {
  const result = await businessService.getSettings(id)
  if (!result.ok) {
    if (result.error.code === 'not_configured') {
      console.log('\n(no settings configured yet — use "business set-settings" to configure)')
      return
    }
    die(`failed: ${result.error.message}`)
  }
  printJson('Settings', result.data)
}

async function businessSetSettings(id: string, file: string): Promise<void> {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf-8'))
  } catch (err) {
    die(`cannot read/parse "${file}": ${(err as Error).message}`)
  }

  const parsed = businessSettingsSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n')
    die(`invalid settings JSON:\n${issues}`)
  }

  // Full replacement (not merge) — write directly to the settings column.
  await businessRepo.update(id, { settings: parsed.data as Record<string, unknown> })
  ok('settings saved')
  printJson('Settings', parsed.data)
}

// ── KB commands ───────────────────────────────────────────────────────────────

// Every KB command takes the businessId, including update and delete: an entry
// id alone must never be enough to touch a row (rule 3 in CLAUDE.md).

function parseCategory(value: string | undefined): KbCategory {
  const category = KB_CATEGORIES.find((c) => c === value)
  if (!category) {
    die(`--category must be one of: ${KB_CATEGORIES.join(', ')}`, 2)
  }
  return category
}

function parseSendMode(value: string): KbSendMode {
  const mode = KB_SEND_MODES.find((m) => m === value)
  if (!mode) die(`--send-mode must be one of: ${KB_SEND_MODES.join(', ')}`, 2)
  return mode
}

function parseAttachmentType(value: string): KbAttachmentType {
  const type = KB_ATTACHMENT_TYPES.find((t) => t === value)
  if (!type) die(`--attachment-type must be one of: ${KB_ATTACHMENT_TYPES.join(', ')}`, 2)
  return type
}

async function kbList(businessId: string): Promise<void> {
  const result = await knowledgeBaseService.getByBusiness(businessId)
  if (!result.ok) die(`failed to load knowledge base: ${result.error.message}`)

  if (result.data.length === 0) {
    console.log('\n(no knowledge base entries for this business)')
    return
  }

  console.log()
  for (const row of result.data) {
    const flags = [
      row.active ? null : 'INACTIVE',
      row.sendMode,
      row.attachmentType !== 'none' ? `${row.attachmentType}=${row.attachmentUrl ?? '?'}` : null,
      row.triggerKeywords?.length ? `keywords=${row.triggerKeywords.join('|')}` : null,
    ]
      .filter((f) => f !== null)
      .join('  ')
    console.log(`[${row.id}]  ${row.category}  ${flags}`)
    console.log(`  ${row.title}`)
    console.log(`  ${row.content.replace(/\n/g, '\n  ')}`)
    console.log()
  }
}

async function kbAdd(businessId: string, flags: Record<string, string>): Promise<void> {
  if (!flags.content) die('--content is required', 2)
  const category = parseCategory(flags.category)

  const result = await knowledgeBaseService.create({
    businessId,
    category,
    content: flags.content,
    title: flags.title ?? null,
    ...(flags['attachment-type']
      ? { attachmentType: parseAttachmentType(flags['attachment-type']) }
      : {}),
    ...(flags['attachment-url'] ? { attachmentUrl: flags['attachment-url'] } : {}),
    ...(flags['send-mode'] ? { sendMode: parseSendMode(flags['send-mode']) } : {}),
    ...(flags.keywords ? { triggerKeywords: flags.keywords.split(',').map((k) => k.trim()) } : {}),
    ...(flags.active ? { active: flags.active !== 'false' } : {}),
  })

  if (!result.ok) die(`failed to create KB entry: ${result.error.message}`)
  ok(`KB entry created: ${result.data.id}`)
}

async function kbUpdate(
  businessId: string,
  id: string,
  flags: Record<string, string>,
): Promise<void> {
  const patch: KnowledgeBasePatch = {}
  if (flags.category) patch.category = parseCategory(flags.category)
  if (flags.content) patch.content = flags.content
  if (flags.title) patch.title = flags.title
  if (flags['attachment-type']) patch.attachmentType = parseAttachmentType(flags['attachment-type'])
  if (flags['attachment-url']) patch.attachmentUrl = flags['attachment-url']
  if (flags['send-mode']) patch.sendMode = parseSendMode(flags['send-mode'])
  if (flags.keywords) patch.triggerKeywords = flags.keywords.split(',').map((k) => k.trim())
  if (flags.active) patch.active = flags.active !== 'false'

  if (Object.keys(patch).length === 0) {
    die('nothing to update — pass at least one of --category --content --title --send-mode ...', 2)
  }

  const result = await knowledgeBaseService.update(businessId, id, patch)
  if (!result.ok) die(`failed to update KB entry ${id}: ${result.error.message}`)
  ok(`KB entry updated: ${id}`)
}

async function kbDelete(businessId: string, id: string): Promise<void> {
  const result = await knowledgeBaseService.remove(businessId, id)
  if (!result.ok) die(`failed to delete KB entry ${id}: ${result.error.message}`)
  ok(`KB entry deleted: ${id}`)
}

// ── Help ──────────────────────────────────────────────────────────────────────

function usage(): never {
  console.error(`
Usage: npm run admin -- <resource> <command> [options]

BUSINESS
  business list
  business get <id>
  business create --name=X --whatsapp=+51X [--owner=+51X] [--owner-name=X] [--timezone=X]
  business update <id>  [--name=X] [--whatsapp=+51X] [--owner=+51X] [--owner-name=X]
  business settings <id>
  business set-settings <id> <settings.json>

KNOWLEDGE BASE
  kb list <businessId>
  kb add <businessId> --category=X --content=X [options]
  kb update <businessId> <id> [options]
  kb delete <businessId> <id>

  Options for add / update:
    --title=X            short label (defaults to the first 50 chars of content)
    --category=X         one of: ${KB_CATEGORIES.join(' | ')}
    --content=X          the text Emma reads
    --send-mode=X        one of: ${KB_SEND_MODES.join(' | ')}
    --keywords=a,b,c     trigger words (only with --send-mode=trigger_based)
    --attachment-type=X  one of: ${KB_ATTACHMENT_TYPES.join(' | ')}
    --attachment-url=X   URL of the attachment
    --active=false       hide from the prompt without deleting

EXAMPLES
  npm run admin -- business create --name="Mi Barbería" --whatsapp="+51900000001" --owner="+51999000001" --owner-name="Juan"
  npm run admin -- business set-settings abc123 ./settings.json
  npm run admin -- kb add abc123 --category="ubicacion" --content="Estamos en Av. Larco 123, Miraflores"
  npm run admin -- kb add abc123 --category="servicios" --title="Portafolio" --content="Mirá nuestros trabajos" --attachment-type=link --attachment-url="https://instagram.com/x"
  npm run admin -- kb update abc123 entry456 --content="Nuevo texto..."
  npm run admin -- kb delete abc123 entry456
  `.trim())
  process.exit(2)
}

// ── Router ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2))
  const [resource, command, ...rest] = positional

  if (!resource || !command) usage()

  if (resource === 'business') {
    switch (command) {
      case 'list':
        return businessList()
      case 'get': {
        const id = rest[0] ?? die('id required', 2)
        return businessGet(id)
      }
      case 'create':
        return businessCreate(flags)
      case 'update': {
        const id = rest[0] ?? die('id required', 2)
        return businessUpdate(id, flags)
      }
      case 'settings': {
        const id = rest[0] ?? die('id required', 2)
        return businessSettings(id)
      }
      case 'set-settings': {
        const id = rest[0] ?? die('id required', 2)
        const file = rest[1] ?? flags.file ?? die('settings.json path required', 2)
        return businessSetSettings(id, file)
      }
      default:
        die(`unknown business command: ${command}`)
    }
  }

  if (resource === 'kb') {
    switch (command) {
      case 'list': {
        const businessId = rest[0] ?? die('businessId required', 2)
        return kbList(businessId)
      }
      case 'add': {
        const businessId = rest[0] ?? die('businessId required', 2)
        return kbAdd(businessId, flags)
      }
      case 'update': {
        const businessId = rest[0] ?? die('businessId required', 2)
        const id = rest[1] ?? die('id required', 2)
        return kbUpdate(businessId, id, flags)
      }
      case 'delete': {
        const businessId = rest[0] ?? die('businessId required', 2)
        const id = rest[1] ?? die('id required', 2)
        return kbDelete(businessId, id)
      }
      default:
        die(`unknown kb command: ${command}`)
    }
  }

  usage()
}

main()
  .catch((err: unknown) => {
    console.error('\nFatal:', (err as Error).message ?? err)
    process.exit(1)
  })
  .finally(() => {
    queryClient.end().catch(() => undefined)
  })
