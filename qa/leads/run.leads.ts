import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WAMessage } from '@whiskeysockets/baileys'
import { describe, expect, it, vi } from 'vitest'

// El corredor del test masivo de leads. Mete cada mensaje del lead simulado por
// handleIncomingMessage —el MISMO punto de entrada que usa server.ts con
// Baileys— y registra qué salió, en qué paso quedó la conversación y cuánto
// costó. Corre como archivo de vitest solo para poder reemplazar módulos
// (vi.mock); `npm test` no lo toma (vitest.leads.config.ts).
//
// Reemplazos (todos declarados en el reporte como diferencias con prod):
// 1. El cliente de WhatsApp: uno falso que anota (fakeWhatsapp.ts).
// 2. La descarga de la foto del cliente (Baileys): un buffer con su id.
// 3. La descarga de las fotos del panel (S3): un buffer con su key — en dev no
//    existen, viven en el bucket de prod.
// 4. Solo en modo "functional": las pausas anti-ban y la cola de envío pasan
//    directo. Con los topes reales (200 mensajes por hora por número) 141
//    conversaciones tardarían más de un día. En modo "load" quedan reales.

vi.mock('@whiskeysockets/baileys', async (importOriginal) => {
  const real = await importOriginal<typeof import('@whiskeysockets/baileys')>()
  return {
    ...real,
    downloadMediaMessage: async (msg: { key: { id?: string | null } }) =>
      Buffer.from(`qa-customer-photo:${msg.key.id ?? ''}`),
  }
})

vi.mock('@/modules/media/media.service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/media/media.service.js')>()
  return {
    ...real,
    downloadMedia: async (_businessId: string, key: string) => ({
      ok: true as const,
      data: Buffer.from(`qa-media:${key}`),
    }),
  }
})

vi.mock('@/shared/humanDelay.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/shared/humanDelay.js')>()
  if (process.env.QA_MODE === 'load') return real
  return { ...real, humanDelay: async () => {}, typingDelayMs: () => 0 }
})

vi.mock('@/modules/whatsapp/sendQueue.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/whatsapp/sendQueue.js')>()
  if (process.env.QA_MODE === 'load') return real
  return {
    ...real,
    enqueueSend: (_businessId: string, _priority: string, run: () => Promise<void>) => run(),
  }
})

import { queryClient } from '@/db/client.js'
import { openai } from '@/modules/llm/openai.client.js'
import * as clientRegistry from '@/modules/whatsapp/clientRegistry.js'
import { handleIncomingMessage } from '@/modules/whatsapp/handler.js'
import { isSandboxNumber } from '@/shared/phone.js'
import { Budget, BudgetExceededError, callContext, STOP_AT_USD, type Usage } from './budget.js'
import { createFakeWhatsappClient, type OutboundRecord } from './fakeWhatsapp.js'
import { audioMessage, imageMessage, pdfMessage, stickerMessage, textMessage } from './inbound.js'
import { AD_TEXT, type LeadProfile, PROFILES } from './profiles.js'
import { REGRESSION_PROFILES } from './profiles.regression.js'
import { type LeadTurn, nextLeadTurn, type TranscriptEntry } from './simulator.js'

const BUSINESS_ID = '33doLX_tC9vrVnaJVfLvZ'
const LLM_FALLBACK = 'Mmm, algo no salió bien'
const OWNER_UNANSWERED = 'Emma no pudo responder'
// Lo que puede tardar en llegar un aviso al dueño que sale "fire-and-forget"
// (la escalada) después de que el handler ya terminó el turno.
const OWNER_GRACE_MS = 2_000

const env = {
  runId: process.env.QA_RUN_ID ?? `local-${Date.now()}`,
  outDir: process.env.QA_OUT_DIR ?? join('qa', 'leads', 'out', 'local'),
  ledger: process.env.QA_LEDGER ?? join('qa', 'leads', 'out', 'ledger.json'),
  stage: process.env.QA_STAGE ?? 'simulate',
  mode: process.env.QA_MODE === 'load' ? 'load' : 'functional',
  profiles: process.env.QA_PROFILES ?? 'G01',
  runs: Number(process.env.QA_RUNS ?? '1'),
  concurrency: Number(process.env.QA_CONCURRENCY ?? '5'),
  maxTurns: Number(process.env.QA_MAX_TURNS ?? '15'),
  git: process.env.QA_GIT ?? 'desconocido',
}

// ── Base de datos (solo dev: se verifica al empezar) ──────────────────────────

// La base de dev (Railway) a veces corta las conexiones un momento: el
// 2026-10-01 un ECONNRESET en una lectura del arnés tiró abajo la corrida
// entera. Las lecturas del arnés se reintentan; lo de Emma no se toca.
async function withDbRetry<T>(read: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await read()
    } catch (err) {
      if (i >= attempts) throw err
      progress(
        `  ⚠ base de dev: ${err instanceof Error ? err.message : String(err)} — reintento ${i}`,
      )
      await new Promise<void>((resolve) => setTimeout(resolve, 2_000 * i))
    }
  }
}

interface ConversationSnapshot {
  id: string
  state: string
  status: string
  emmaEnabled: boolean
  tags: string[]
}

function conversationOf(phone: string): Promise<ConversationSnapshot | null> {
  return withDbRetry(() => readConversation(phone))
}

async function readConversation(phone: string): Promise<ConversationSnapshot | null> {
  const [row] = await queryClient<
    { id: string; state: string; status: string; emma_enabled: boolean }[]
  >`
    select c.id, c.state, c.status, c.emma_enabled
    from conversations c
    join customers cu on cu.id = c.customer_id and cu.business_id = c.business_id
    where c.business_id = ${BUSINESS_ID} and cu.phone = ${phone} and c.type = 'customer'
    order by c.created_at desc
    limit 1`
  if (!row) return null
  const tags = await queryClient<{ name: string }[]>`
    select t.name from conversation_tags ct
    join tags t on t.id = ct.tag_id and t.business_id = ${BUSINESS_ID}
    where ct.conversation_id = ${row.id}`
  return {
    id: row.id,
    state: row.state,
    status: row.status,
    emmaEnabled: row.emma_enabled,
    tags: tags.map((t) => t.name),
  }
}

/** Marca de tiempo de la última fila, en reloj de la base (no del proceso). */
function lastMessageMark(conversationId: string | null): Promise<string | null> {
  return withDbRetry(() => readLastMessageMark(conversationId))
}

async function readLastMessageMark(conversationId: string | null): Promise<string | null> {
  if (!conversationId) return null
  const [row] = await queryClient<{ mark: string | null }[]>`
    select max(created_at)::text as mark from messages
    where conversation_id = ${conversationId} and business_id = ${BUSINESS_ID}`
  return row?.mark ?? null
}

interface ToolCallRecord {
  name: string
  args: string
}

async function toolActivitySince(
  conversationId: string,
  mark: string | null,
): Promise<{ calls: ToolCallRecord[]; results: string[] }> {
  const rows = await queryClient<{ role: string; content: string; tool_calls: unknown }[]>`
    select role, content, tool_calls from messages
    where conversation_id = ${conversationId} and business_id = ${BUSINESS_ID}
      ${mark ? queryClient`and created_at > ${mark}::timestamptz` : queryClient``}
    order by created_at asc`
  const calls: ToolCallRecord[] = []
  const results: string[] = []
  for (const row of rows) {
    if (row.role === 'tool') results.push(row.content.slice(0, 400))
    if (row.role === 'assistant' && Array.isArray(row.tool_calls)) {
      for (const call of row.tool_calls as { function?: { name?: string; arguments?: string } }[]) {
        calls.push({ name: call.function?.name ?? '?', args: call.function?.arguments ?? '' })
      }
    }
  }
  return { calls, results }
}

/** Simula que pasaron `hours` horas: corre hacia atrás las fechas de la conversación. */
async function shiftBack(conversationId: string, hours: number): Promise<void> {
  await queryClient`
    update messages set created_at = created_at - make_interval(hours => ${hours})
    where conversation_id = ${conversationId} and business_id = ${BUSINESS_ID}`
  await queryClient`
    update conversations
    set last_message_at = last_message_at - make_interval(hours => ${hours}),
        updated_at = updated_at - make_interval(hours => ${hours})
    where id = ${conversationId} and business_id = ${BUSINESS_ID}`
}

// ── Registro ──────────────────────────────────────────────────────────────────

interface TurnRecord {
  runId: string
  convKey: string
  profileId: string
  run: number
  turn: number
  startedAt: string
  durationMs: number
  lead: { messages: string[]; attachment: string; end: string; note: string }
  stateBefore: string
  stateAfter: string
  status: string
  emmaEnabled: boolean
  tags: string[]
  emma: OutboundRecord[]
  owner: OutboundRecord[]
  tools: ToolCallRecord[]
  toolResults: string[]
  fallback: boolean
  gapHours?: number
  error?: string
  usd: { emma: number; lead: number }
}

interface ConversationSummary {
  convKey: string
  profileId: string
  category: string
  run: number
  phone: string
  turns: number
  endReason: string
  finalState: string
  status: string
  emmaEnabled: boolean
  tags: string[]
  usage: Record<'emma' | 'lead', Usage>
}

function appendJsonl(file: string, value: unknown): void {
  appendFileSync(file, `${JSON.stringify(value)}\n`)
}

function progress(line: string): void {
  process.stderr.write(`${line}\n`)
}

// ── El corredor ───────────────────────────────────────────────────────────────

// `all` = los 47 originales; `regresion` = los de profiles.regression.ts; o una
// lista de ids y `cat:X`, buscando en los dos.
function selectProfiles(spec: string): LeadProfile[] {
  if (spec === 'all') return PROFILES
  if (spec === 'regresion') return REGRESSION_PROFILES
  const every = [...PROFILES, ...REGRESSION_PROFILES]
  const wanted = spec.split(',').map((s) => s.trim().toUpperCase())
  const selected = every.filter(
    (p) => wanted.includes(p.id) || wanted.includes(`CAT:${p.category}`),
  )
  const unknown = wanted.filter((w) => !w.startsWith('CAT:') && !every.some((p) => p.id === w))
  if (unknown.length > 0) throw new Error(`Perfiles desconocidos: ${unknown.join(', ')}`)
  return selected
}

async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await work(item)
  })
  await Promise.all(workers)
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe('simulación de leads — Instituto Tecmin', () => {
  it('corre los perfiles seleccionados por el handler real', async () => {
    // 1. Solo contra dev, y solo contra la copia de prueba.
    const [marker] = await queryClient<{ label: string }[]>`select label from _env_marker limit 1`
    if (!marker?.label.includes('DEV')) throw new Error(`No es la base de dev: "${marker?.label}"`)
    const [business] = await queryClient<
      { whatsapp_number: string; owner_whatsapp_number: string | null; settings: unknown }[]
    >`select whatsapp_number, owner_whatsapp_number, settings from businesses where id = ${BUSINESS_ID}`
    if (!business) throw new Error('No está la copia de Tecmin en dev: npm run business:clone:dev')
    if (!isSandboxNumber(business.whatsapp_number)) {
      throw new Error(`El bot de la copia no es de prueba (+999…): ${business.whatsapp_number}`)
    }
    if (!business.owner_whatsapp_number) throw new Error('La copia no tiene número de dueño')
    const ownerJid = `${business.owner_whatsapp_number.replace('+', '')}@s.whatsapp.net`

    // Qué foto es cada key del panel, para el registro legible.
    const mediaRows = await queryClient<
      { s3_key: string; owner_kind: string; service_id: string; filename: string | null }[]
    >`select s3_key, owner_kind, service_id, filename from service_media where business_id = ${BUSINESS_ID}`
    const mediaName = new Map(
      mediaRows.map((m) => [
        `s3:${m.s3_key}`,
        `${m.owner_kind}:${m.service_id}/${m.filename ?? ''}`,
      ]),
    )

    mkdirSync(env.outDir, { recursive: true })
    const turnsFile = join(env.outDir, 'turns.jsonl')
    const budget = new Budget(env.ledger, env.stage)
    if (budget.totalUsd >= STOP_AT_USD) throw new BudgetExceededError(budget.totalUsd)

    // 2. Todo gasto de OpenAI (Emma y el lead) pasa por el contador.
    const realCreate = openai.chat.completions.create.bind(openai.chat.completions)
    vi.spyOn(openai.chat.completions, 'create').mockImplementation(((
      body: Parameters<typeof realCreate>[0],
      options?: Parameters<typeof realCreate>[1],
    ) => {
      const ctx = callContext.getStore()
      budget.assertCanSpend()
      return (async () => {
        let res: Awaited<ReturnType<typeof realCreate>> & {
          usage?: {
            prompt_tokens?: number
            completion_tokens?: number
            prompt_tokens_details?: { cached_tokens?: number }
          }
        }
        try {
          res = await realCreate(body, options)
        } catch (err) {
          // llm.service loguea solo "llm_generate_failed", sin el motivo: acá
          // queda el error real de OpenAI (429 límite de la cuenta, 400, red…).
          const e = err as { status?: number; code?: string; message?: string }
          appendJsonl(join(env.outDir, 'openai-errors.jsonl'), {
            at: new Date().toISOString(),
            caller: ctx?.caller ?? 'emma',
            convKey: ctx?.convKey ?? null,
            status: e.status ?? null,
            code: e.code ?? null,
            message: (e.message ?? String(err)).slice(0, 300),
          })
          throw err
        }
        budget.record(ctx?.caller ?? 'emma', ctx?.convKey ?? 'sin-conversacion', {
          prompt_tokens: res.usage?.prompt_tokens ?? 0,
          completion_tokens: res.usage?.completion_tokens ?? 0,
          cached: res.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        })
        return res
      })()
    }) as unknown as typeof openai.chat.completions.create)

    // 3. El WhatsApp falso: cada envío va a la conversación de su destinatario.
    const byJid = new Map<string, OutboundRecord[]>()
    const ownerInbox: OutboundRecord[] = []
    const client = createFakeWhatsappClient({
      latencyMs: env.mode === 'load' ? [200, 800] : [0, 0],
      onSend: (record) => {
        if (record.jid === ownerJid) ownerInbox.push(record)
        else byJid.set(record.jid, [...(byJid.get(record.jid) ?? []), record])
      },
    })
    clientRegistry.registerClient(BUSINESS_ID, client)
    // El id de cada foto del lead → su conversación, para atribuir los reenvíos.
    const photoOwner = new Map<string, string>()

    const profiles = selectProfiles(env.profiles)
    const jobs = profiles.flatMap((profile) =>
      Array.from({ length: env.runs }, (_, i) => ({ profile, run: i + 1 })),
    )
    const summaries: ConversationSummary[] = []
    const startedAt = new Date().toISOString()
    progress(
      `▶ ${jobs.length} conversaciones (${profiles.length} perfiles × ${env.runs}) · modo ${env.mode} · gastado antes: $${budget.totalUsd.toFixed(4)}`,
    )

    await pool(jobs, env.concurrency, async ({ profile, run }) => {
      if (budget.exceeded) return
      const convKey = `${profile.id}#${run}`
      const digits = `9998${String(budget.allocatePhone()).padStart(8, '0')}`
      const phone = `+${digits}`
      const jid = `${digits}@s.whatsapp.net`
      const transcript: TranscriptEntry[] = []
      let endReason = 'tope_de_turnos'
      let afterCloseLeft: number | null = null
      let escalatedTurns = 0
      let silentTurns = 0
      let turn = 0

      for (turn = 1; turn <= env.maxTurns; turn++) {
        if (budget.exceeded) {
          endReason = 'presupuesto'
          break
        }
        const turnStart = Date.now()
        const before = await conversationOf(phone)
        let gapHours: number | undefined
        if (profile.gap && profile.gap.beforeTurn === turn && before) {
          await shiftBack(before.id, profile.gap.hours)
          gapHours = profile.gap.hours
          transcript.push({ from: 'system', note: `pasaron ${profile.gap.hours} horas` })
        }

        // El turno del lead: el primero es fijo (anuncio o el suyo), el resto lo escribe el simulador.
        let leadTurn: LeadTurn
        try {
          leadTurn =
            turn === 1
              ? {
                  messages: [profile.first === 'AD' ? AD_TEXT : profile.first],
                  attachment: 'none',
                  end: 'continue',
                  note: 'primer mensaje',
                }
              : await callContext.run({ caller: 'lead', convKey }, async () => {
                  const ask = (seed: number) =>
                    nextLeadTurn({ profile, transcript, turn, maxTurns: env.maxTurns, seed })
                  const first = await ask(profile.seed * 10 + run)
                  // El simulador a veces devuelve un turno vacío sin despedirse
                  // (5 conversaciones cortadas en la regresión del 2026-10-01):
                  // se le pide otra vez, con otra semilla, antes de cortar.
                  const empty =
                    first.end === 'continue' &&
                    first.messages.length === 0 &&
                    first.attachment === 'none'
                  return empty ? ask(profile.seed * 10 + run + 1000) : first
                })
        } catch (err) {
          endReason = err instanceof BudgetExceededError ? 'presupuesto' : 'error_simulador'
          progress(`✗ ${convKey} t${turn}: ${err instanceof Error ? err.message : String(err)}`)
          break
        }
        // Un turno sin nada que mandar no es un turno: si el lead se despidió,
        // termina; si el simulador devolvió vacío (pasó en la corrida del
        // 2026-09-30), también termina, con su propio motivo. Antes se contaba
        // como turno sin respuesta de Emma, que es un fallo que Emma no tuvo.
        if (leadTurn.messages.length === 0 && leadTurn.attachment === 'none') {
          endReason =
            leadTurn.end === 'done'
              ? 'lead_termino'
              : leadTurn.end === 'abandon'
                ? 'lead_abandono'
                : 'lead_vacio'
          break
        }

        // Entrada por el handler real, con el ritmo de una persona escribiendo.
        const mark = await lastMessageMark(before?.id ?? null)
        const emmaSeen = byJid.get(jid)?.length ?? 0
        const ownerSeen = ownerInbox.length
        const pending: Promise<void>[] = []
        const deliver = (raw: WAMessage) => {
          pending.push(
            callContext.run({ caller: 'emma', convKey }, () =>
              handleIncomingMessage(raw, BUSINESS_ID, client.sendMessage),
            ),
          )
        }
        let error: string | undefined
        try {
          for (const [i, text] of leadTurn.messages.entries()) {
            if (i > 0) await sleep(400 + Math.random() * 600)
            deliver(textMessage(jid, text, profile.pushName))
            transcript.push({ from: 'lead', text })
          }
          const att = leadTurn.attachment
          if (att !== 'none') {
            if (leadTurn.messages.length > 0) await sleep(800)
            const photos: WAMessage[] =
              att === 'captura'
                ? [imageMessage(jid, 'captura', undefined, profile.pushName)]
                : att === 'dni'
                  ? [imageMessage(jid, 'dni', undefined, profile.pushName)]
                  : att === 'dni_doble'
                    ? [
                        imageMessage(jid, 'dni', undefined, profile.pushName),
                        imageMessage(jid, 'dni-reverso', undefined, profile.pushName),
                      ]
                    : []
            for (const [i, photo] of photos.entries()) {
              if (i > 0) await sleep(1_000)
              if (photo.key.id) photoOwner.set(photo.key.id, convKey)
              deliver(photo)
            }
            if (att === 'audio') deliver(audioMessage(jid, profile.pushName))
            if (att === 'sticker') deliver(stickerMessage(jid, profile.pushName))
            if (att === 'pdf_voucher') deliver(pdfMessage(jid, undefined, profile.pushName))
            transcript.push({ from: 'lead', attachment: att })
          }
          await Promise.all(pending)
          await sleep(OWNER_GRACE_MS)
        } catch (err) {
          error = err instanceof Error ? err.message : String(err)
        }

        // Qué salió en este turno.
        const emma = (byJid.get(jid) ?? []).slice(emmaSeen)
        const owner = ownerInbox.slice(ownerSeen).filter((r) => {
          const photoId = r.media?.startsWith('cliente:') ? r.media.slice('cliente:'.length) : null
          if (photoId) return photoOwner.get(photoId) === convKey
          return `${r.text ?? ''}${r.caption ?? ''}`.includes(phone)
        })
        for (const r of emma) {
          if (r.kind === 'text') transcript.push({ from: 'emma', text: r.text ?? '' })
          else transcript.push({ from: 'emma', photo: r.caption ?? null })
        }

        const after = await conversationOf(phone)
        const activity = after
          ? await withDbRetry(() => toolActivitySince(after.id, mark))
          : { calls: [], results: [] }
        const usage = budget.conversationUsage(convKey)
        const record: TurnRecord = {
          runId: env.runId,
          convKey,
          profileId: profile.id,
          run,
          turn,
          startedAt: new Date(turnStart).toISOString(),
          durationMs: Date.now() - turnStart,
          lead: {
            messages: leadTurn.messages,
            attachment: leadTurn.attachment,
            end: leadTurn.end,
            note: leadTurn.note,
          },
          stateBefore: before?.state ?? 'nuevo',
          stateAfter: after?.state ?? 'nuevo',
          status: after?.status ?? '—',
          emmaEnabled: after?.emmaEnabled ?? true,
          tags: after?.tags ?? [],
          emma: emma.map((r) => (r.media ? { ...r, media: mediaName.get(r.media) ?? r.media } : r)),
          owner,
          tools: activity.calls,
          toolResults: activity.results,
          // Desde 2026-09-30 un fallo ya no le llega al cliente: le llega al dueño.
          fallback:
            emma.some((r) => r.text?.startsWith(LLM_FALLBACK)) ||
            owner.some((r) => r.text?.includes(OWNER_UNANSWERED)),
          ...(gapHours ? { gapHours } : {}),
          ...(error ? { error } : {}),
          usd: { emma: usage.emma.usd, lead: usage.lead.usd },
        }
        appendJsonl(turnsFile, record)
        progress(
          `  ${convKey.padEnd(6)} t${String(turn).padStart(2)} ${record.stateBefore} → ${record.stateAfter}  ·  ${emma.length} msj${owner.length > 0 ? ` · dueño ${owner.length}` : ''}  ·  total $${budget.totalUsd.toFixed(4)}`,
        )

        // ¿Termina acá?
        // La pausa de Emma va primero: si el lead además se despidió en el mismo
        // turno, lo que cerró la conversación fue la foto, no la despedida.
        silentTurns = emma.length === 0 ? silentTurns + 1 : 0
        if (after && !after.emmaEnabled) {
          afterCloseLeft = afterCloseLeft === null ? (profile.afterClose ?? 0) : afterCloseLeft - 1
          if (afterCloseLeft <= 0) {
            endReason = 'cierre_emma_pausada'
            break
          }
        } else if (after?.status === 'escalated') {
          escalatedTurns++
          if (escalatedTurns >= 2) {
            endReason = 'escalada'
            break
          }
        } else if (silentTurns >= 2) {
          endReason = 'sin_respuesta'
          break
        }
        if (leadTurn.end !== 'continue') {
          endReason = leadTurn.end === 'done' ? 'lead_termino' : 'lead_abandono'
          break
        }
      }

      const final = await conversationOf(phone)
      summaries.push({
        convKey,
        profileId: profile.id,
        category: profile.category,
        run,
        phone,
        turns: Math.min(turn, env.maxTurns),
        endReason,
        finalState: final?.state ?? 'nuevo',
        status: final?.status ?? '—',
        emmaEnabled: final?.emmaEnabled ?? true,
        tags: final?.tags ?? [],
        usage: budget.conversationUsage(convKey),
      })
      progress(`■ ${convKey} terminó: ${endReason} (${final?.state ?? '—'})`)
    })

    // 4. Resumen de la corrida.
    const tecminFile = readFileSync(join('src', 'config', 'businesses', 'instituto-tecmin.ts'))
    const totals = budget.stageTotals()
    const runInfo = {
      runId: env.runId,
      stage: env.stage,
      mode: env.mode,
      startedAt,
      endedAt: new Date().toISOString(),
      git: env.git,
      tecminFileSha: createHash('sha256').update(tecminFile).digest('hex').slice(0, 16),
      settingsSha: createHash('sha256')
        .update(JSON.stringify(business.settings))
        .digest('hex')
        .slice(0, 16),
      profiles: profiles.map((p) => p.id),
      runs: env.runs,
      conversations: summaries.length,
      cost: {
        emmaUsd: totals.emma.usd,
        leadUsd: totals.lead.usd,
        thisRunUsd: totals.emma.usd + totals.lead.usd,
        ledgerTotalUsd: budget.totalUsd,
        emmaCalls: totals.emma.calls,
        leadCalls: totals.lead.calls,
        tokens: totals,
      },
      budgetStopped: budget.exceeded,
    }
    writeFileSync(join(env.outDir, 'conversations.json'), JSON.stringify(summaries, null, 2))
    writeFileSync(join(env.outDir, 'run.json'), JSON.stringify(runInfo, null, 2))
    progress(
      `✔ ${summaries.length} conversaciones · esta corrida $${runInfo.cost.thisRunUsd.toFixed(4)} (Emma $${totals.emma.usd.toFixed(4)}, lead $${totals.lead.usd.toFixed(4)}) · acumulado $${budget.totalUsd.toFixed(4)} de $2.00`,
    )
    expect(summaries.length).toBeGreaterThan(0)
  })
})
