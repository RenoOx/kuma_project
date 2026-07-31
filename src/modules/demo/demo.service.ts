import { db } from '@/db/client.js'
import * as businessRepo from '@/modules/business/business.repo.js'
import * as knowledgeBaseRepo from '@/modules/knowledgeBase/knowledgeBase.repo.js'
import { AppError, ValidationError } from '@/shared/errors.js'
import { err, ok, type Result } from '@/shared/result.js'
import { DEMO_PROFILES, DEMO_PROFILE_KEYS } from './demoProfiles.js'

export async function applyDemoProfile(
  businessId: string,
  keyword: string,
): Promise<Result<string>> {
  const profile = DEMO_PROFILES[keyword]
  if (!profile) {
    return err(
      new ValidationError({
        message: `unknown demo profile key: ${keyword}`,
        userMessage: `Perfil "${keyword}" no existe. Opciones válidas: ${DEMO_PROFILE_KEYS.join(', ')}.`,
        logContext: { businessId, keyword },
      }),
    )
  }

  try {
    await db.transaction(async (tx) => {
      await businessRepo.update(
        businessId,
        { name: profile.name, settings: profile.settings as unknown },
        tx,
      )
      await knowledgeBaseRepo.deleteByBusiness(businessId, tx)
      await knowledgeBaseRepo.bulkInsert(
        profile.kbEntries.map((e) => ({ ...e, businessId })),
        tx,
      )
    })
    return ok(profile.name)
  } catch (cause) {
    return err(
      new AppError({
        code: 'demo_profile_apply_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage: 'No se pudo aplicar el perfil de demo.',
        logContext: { businessId, keyword },
        cause,
      }),
    )
  }
}
