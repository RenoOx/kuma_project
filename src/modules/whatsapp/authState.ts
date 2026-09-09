import { readdir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { logger } from '@/config/logger.js'

// Cheap integrity check over what useMultiFileAuthState left on disk.
//
// The failure this exists to catch: the Railway volume is not mounted where
// SESSIONS_DIR points, or its contents were lost. Baileys handles that silently
// and helpfully — no credentials means it just generates a fresh QR — so the
// first sign is an operator scanning a code for a number that was already
// linked. That scan spends the number's linking budget, and a few of them in an
// hour is how a number gets rate-limited.
//
// So a MISSING auth state and a BROKEN one are treated as different things.
// Missing is a business that has never been linked, which is normal. Broken is
// evidence something went wrong with storage, and the safe answer there is to
// stop and make a human look, never to quietly offer a QR.

const log = logger.child({ component: 'whatsapp.auth-state' })

const CREDS_FILE = 'creds.json'
// The fields Baileys needs to resume a session. A creds.json missing any of
// these cannot restore anything, whatever else it contains.
const REQUIRED_FIELDS = ['noiseKey', 'signedIdentityKey', 'registrationId'] as const

export type AuthStateStatus = 'absent' | 'valid' | 'corrupt'

export interface AuthStateReport {
  status: AuthStateStatus
  /** The linked account, when the credentials name one. */
  registeredAs: string | null
  /** Why it was judged corrupt. Null otherwise. */
  reason: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reads and validates the stored credentials for one business. */
export async function inspectAuthState(sessionDir: string): Promise<AuthStateReport> {
  let raw: string
  try {
    raw = await readFile(`${sessionDir}/${CREDS_FILE}`, 'utf8')
  } catch {
    // Includes the directory not existing at all: both mean "never linked".
    return { status: 'absent', registeredAs: null, reason: null }
  }

  // An empty file is what a crash mid-write leaves behind, and it is corrupt
  // rather than absent — something WAS there.
  if (raw.trim() === '') {
    return { status: 'corrupt', registeredAs: null, reason: 'creds.json is empty' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return {
      status: 'corrupt',
      registeredAs: null,
      reason: `creds.json is not valid JSON: ${err instanceof Error ? err.message : 'parse failed'}`,
    }
  }

  if (!isRecord(parsed)) {
    return { status: 'corrupt', registeredAs: null, reason: 'creds.json is not an object' }
  }

  const missing = REQUIRED_FIELDS.filter((field) => parsed[field] === undefined)
  if (missing.length > 0) {
    return {
      status: 'corrupt',
      registeredAs: null,
      reason: `creds.json is missing required fields: ${missing.join(', ')}`,
    }
  }

  const me = parsed.me
  const registeredAs = isRecord(me) && typeof me.id === 'string' ? me.id : null
  return { status: 'valid', registeredAs, reason: null }
}

/**
 * One line at startup answering "is the volume actually mounted where we think".
 *
 * Resolved to an absolute path on purpose: SESSIONS_DIR defaults to a relative
 * "./sessions", which silently means something different depending on the
 * process's working directory — and on Railway that difference is the whole bug.
 */
export async function logSessionsDirDiagnostics(sessionsDir: string): Promise<void> {
  const absolutePath = isAbsolute(sessionsDir) ? sessionsDir : resolve(process.cwd(), sessionsDir)

  try {
    const info = await stat(absolutePath)
    if (!info.isDirectory()) {
      log.error({ sessionsDir, absolutePath }, 'SESSIONS_DIR exists but is not a directory')
      return
    }
    const entries = await readdir(absolutePath)
    log.info(
      {
        sessionsDir,
        absolutePath,
        wasRelative: !isAbsolute(sessionsDir),
        businessDirs: entries.length,
      },
      'sessions directory resolved — confirm this is the mounted volume path',
    )
  } catch (err) {
    // Not fatal: mkdir in makeWhatsappClient creates it on first use. But if
    // this is production and the path was supposed to be a mounted volume, an
    // absent directory means every linked session was just lost.
    log.warn(
      { err, sessionsDir, absolutePath },
      'sessions directory does not exist yet — it will be created on first link. If this is production, check that the volume is mounted here',
    )
  }
}
