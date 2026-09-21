import { nanoid } from 'nanoid'
import { logger } from '@/config/logger.js'
import { queryClient } from '@/db/client.js'
import * as businessRepo from '@/modules/business/business.repo.js'
import { normalizeServices } from '@/modules/panel/settings.merge.js'

// Gives every already-configured service the stable id that photo uploads are
// keyed on.
//
// Without this, a business configured before ids existed has services the panel
// cannot attach a photo to: the S3 key is built from the id, so the upload button
// stays disabled until something mints one. New saves mint them on their own — this
// is only for the catalogues already in the database.
//
// Idempotent: normalizeServices keeps every id it finds and only fills the gaps,
// so a second run reports zero changes. Written in TypeScript rather than SQL
// because nanoid is a JS function and a per-element jsonb_set would be both
// longer and easier to get wrong.
//
// Usage:
//   npx dotenv -e .env -- tsx scripts/backfill-service-ids.ts [--dry-run]

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  const businesses = await businessRepo.findAll()

  let changed = 0
  let untouched = 0
  let skipped = 0

  for (const business of businesses) {
    const settings = business.settings
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
      skipped += 1
      continue
    }

    const current = (settings as { services?: unknown }).services
    if (!Array.isArray(current) || current.length === 0) {
      skipped += 1
      continue
    }

    // Reuses the same reconciliation the panel writes through, so the ids this
    // mints are indistinguishable from the ones a normal save would produce.
    const normalized = normalizeServices(settings, current, nanoid)
    const missingBefore = current.filter(
      (service) =>
        typeof service !== 'object' ||
        service === null ||
        typeof (service as { id?: unknown }).id !== 'string',
    ).length

    if (missingBefore === 0) {
      untouched += 1
      continue
    }

    logger.info(
      { businessId: business.id, name: business.name, services: normalized.length, missingBefore },
      dryRun ? 'would mint service ids' : 'minting service ids',
    )

    if (!dryRun) {
      await businessRepo.update(business.id, {
        settings: { ...settings, services: normalized } as unknown as Record<string, unknown>,
      })
    }
    changed += 1
  }

  logger.info(
    { businesses: businesses.length, changed, untouched, skipped, dryRun },
    'service id backfill finished',
  )
}

main()
  .catch((err) => {
    logger.fatal({ err }, 'service id backfill failed')
    process.exit(1)
  })
  .finally(() => {
    queryClient.end().catch(() => undefined)
  })
