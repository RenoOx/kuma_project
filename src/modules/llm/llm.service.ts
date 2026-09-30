import type {
  ChatCompletion,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions.js'
import { env } from '@/config/env.js'
import { logger } from '@/config/logger.js'
import type { Message } from '@/db/schema/index.js'
import * as appointmentService from '@/modules/appointment/appointment.service.js'
import * as businessService from '@/modules/business/business.service.js'
import type { BusinessSettings, FlowType } from '@/modules/business/business.settings.js'
import * as conversationRepo from '@/modules/conversation/conversation.repo.js'
import * as conversationService from '@/modules/conversation/conversation.service.js'
import { fileConfigFor, resolveBusinessFlow } from '@/modules/conversation/flowSource.js'
import { IDLE_TRIGGER } from '@/modules/conversation/nodeCatalog.js'
import {
  getStateConfig,
  INITIAL_STATE,
  type TransitionEvidence,
} from '@/modules/conversation/stateMachine.js'
import * as customerService from '@/modules/customer/customer.service.js'
import * as knowledgeBaseSearch from '@/modules/knowledgeBase/knowledgeBaseSearch.service.js'
import * as serviceMediaService from '@/modules/media/serviceMedia.service.js'
import * as messageService from '@/modules/message/message.service.js'
import { isIgnoredForModel } from '@/modules/whatsapp/messageKind.js'
import { canSendServiceMedia } from '@/modules/whatsapp/sentServiceImages.js'
import { AppError, NotConfiguredError, NotFoundError, ValidationError } from '@/shared/errors.js'
import { preview } from '@/shared/logRedact.js'
import { err, ok, type Result } from '@/shared/result.js'
import { MAX_ATTACHMENTS_PER_TURN, queueAttachments } from './attachmentQueue.js'
import { hoursSinceLastActivity } from './conversationRestart.js'
import {
  type FixedOutbound,
  renderStaticMessage,
  type StepFixedMessage,
  stepOwesFixedMessage,
  withoutRepeatedLines,
} from './fixedMessage.js'
import type { ExecutedToolCall, GenerateReplyParams, LLMResponse } from './llm.types.js'
import { openai } from './openai.client.js'
import { buildSystemPrompt, renderNodeBlock } from './prompts.js'
import {
  executeTool,
  MAX_SERVICE_CARDS_PER_TURN,
  serviceCardsForCategory,
  type ToolAttachment,
  type ToolContext,
  type ToolExecutionResult,
} from './toolExecutor.js'
import { kumaTools } from './tools.js'

const MODEL = 'gpt-4o-mini'
const TEMPERATURE = 0.4
// Raised from 300: a catalogue answer that lists up to 8 services with names
// and prices does not fit in 300, and the reply reached the customer cut off
// mid-item. Only the customer flow needs the extra room — ownerAssistant keeps
// its own budget.
const MAX_TOKENS = 600
const HISTORY_LIMIT = 20
const MAX_TOOL_ITERATIONS = 5
// Antes 1: dos mensajes fijos en el mismo turno solo se topaban para no
// apilar dos OFERTAS que compitan entre sí, pero un paso puede necesitar
// mandar algo informativo (beneficios) seguido del gancho de venta
// (descuento) — complementarios, no competidores. Sigue acotado, no es
// "sin límite".
const MAX_FIXED_MESSAGES_PER_TURN = 2
const OPENAI_TIMEOUT_MS = 30_000
const MAX_ITERATIONS_FALLBACK_TEXT =
  'No me quedó claro cómo ayudarte con eso. Un encargado te va a contactar para orientarte mejor.'

// Lo que recibe la IA cuando quiere salir de un paso sin haber mandado su
// mensaje fijo, o cuando cierra un paso `fixedOnly` con texto propio. Ver
// stepOwesFixedMessage en fixedMessage.ts.
const FIXED_MESSAGE_PENDING_INSTRUCTION =
  'Este paso responde con su mensaje fijo y todavía no lo mandaste. Mandalo ahora con send_fixed_message (ver MENSAJES FIJOS del paso actual) y no escribas nada propio. Recién después se avanza.'

function convertHistoryToChatMessages(history: Message[]): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = []
  for (const msg of history) {
    if (msg.role === 'system') continue
    if (msg.role === 'tool') {
      if (!msg.toolCallId) continue
      out.push({
        role: 'tool',
        tool_call_id: msg.toolCallId,
        content: msg.content,
      })
      continue
    }
    if (msg.role === 'assistant') {
      // toolCalls is stored as the raw OpenAI shape per the Día 7 decision.
      const stored = msg.toolCalls as ChatCompletionMessageToolCall[] | null | undefined
      if (stored && stored.length > 0) {
        out.push({
          role: 'assistant',
          content: msg.content === '' ? null : msg.content,
          tool_calls: stored,
        })
      } else {
        out.push({ role: 'assistant', content: msg.content })
      }
      continue
    }
    if (msg.role === 'user') {
      // Emojis sueltos y multimedia ignorada (sticker, video…) quedan guardados
      // para el Inbox, pero el modelo no los lee: si los viera, "no influyen" sería
      // mentira — un "😂" en el historial le cambiaba el tono de la respuesta.
      if (isIgnoredForModel(msg.content)) continue
      out.push({ role: 'user', content: msg.content })
    }
  }
  return out
}

export async function generateReply(params: GenerateReplyParams): Promise<Result<LLMResponse>> {
  const log = logger.child({
    component: 'llm.service',
    businessId: params.businessId,
    conversationId: params.conversationId,
  })

  // 1. Business
  const businessResult = await businessService.getById(params.businessId)
  if (!businessResult.ok) return businessResult
  const business = businessResult.data

  // 2. Settings — NotConfiguredError is NOT fatal here; we pass `null` to the
  // prompt builder, which switches in the "no configuration" guidance for the
  // model. Any OTHER error (DB / unexpected) is fatal and we propagate.
  const settingsResult = await businessService.getSettings(params.businessId)
  let settings: BusinessSettings | null
  if (settingsResult.ok) {
    settings = settingsResult.data
  } else if (settingsResult.error instanceof NotConfiguredError) {
    settings = null
  } else {
    return settingsResult
  }

  // 3. Conversation (needed for customerId in tool context)
  const conversation = await conversationRepo.findById(params.businessId, params.conversationId)
  if (!conversation) {
    return err(
      new NotFoundError({
        resource: 'conversation',
        logContext: {
          businessId: params.businessId,
          conversationId: params.conversationId,
        },
      }),
    )
  }
  // Defensive: this service is only meant for customer conversations. An
  // owner_thread reaching here is a wiring bug in the handler.
  if (conversation.type !== 'customer' || !conversation.customerId) {
    return err(
      new ValidationError({
        message: `llm.generateReply called on a non-customer conversation (type=${conversation.type})`,
        userMessage: 'Esta conversación no admite respuesta automática del bot.',
        logContext: {
          businessId: params.businessId,
          conversationId: params.conversationId,
          conversationType: conversation.type,
        },
      }),
    )
  }
  // Extraído en un const propio: dentro de forState (una función anidada,
  // más abajo) TypeScript no arrastra el angostamiento de este chequeo.
  const customerId = conversation.customerId

  // 3b. Conversation state. The flow belongs to the code, not to the model:
  // this service reads the state to decide what the model is allowed to reach
  // for, and never decides the state itself.
  //
  // `params.state` wins when the caller passes one; otherwise we use the value
  // the row already carries (loaded above, so no extra query). Settings can be
  // null for an unconfigured business — falling back to 'appointments' mirrors
  // the Zod default, so that business behaves exactly as it did before.
  const currentState = params.state ?? conversation.state
  const flowType: FlowType = settings?.flowType ?? 'appointments'
  // Compiled once per turn and threaded through: every transition of this turn
  // has to be judged against the same flow, and recompiling per trigger would
  // let a mid-turn settings change split the conversation across two flows.
  const flow = resolveBusinessFlow(params.businessId, settings)

  // Every trigger of this turn goes through here. A failed write costs the
  // transition, never the reply: we log it and carry on from where we were.
  const applyTriggerOrKeep = async (
    from: string,
    trigger: string,
    evidence?: TransitionEvidence,
  ): Promise<string> => {
    const applied = await conversationService.applyTrigger({
      businessId: params.businessId,
      conversationId: params.conversationId,
      flow,
      currentState: from,
      trigger,
      evidence,
    })
    if (applied.ok) return applied.data
    log.warn({ code: applied.error.code, trigger, from }, 'could not apply state transition')
    return from
  }

  // 5. Recent history (handler is expected to have appended the user msg
  // already; we don't re-append). Se carga antes del trigger de apertura porque
  // el reinicio por inactividad se decide mirando cuándo fue el último mensaje.
  const historyResult = await messageService.getRecentHistory(
    params.businessId,
    params.conversationId,
    HISTORY_LIMIT,
  )
  if (!historyResult.ok) return historyResult
  // Mismo motivo que kbEntries: para que forState lo use sin depender del
  // angostamiento de este chequeo.
  const history = historyResult.data

  const fileConfig = fileConfigFor(params.businessId)

  // Reinicio por inactividad (solo si el archivo del negocio lo pide): un
  // cliente que vuelve después de N horas es una conversación nueva y arranca
  // otra vez desde el saludo, aunque haya quedado a mitad del flujo. Sin esto
  // `inactive_24h` estaba declarado en todos los pasos y no lo emitía nadie.
  let turnStart = currentState
  const restartAfterHours = fileConfig?.restartAfterHours
  if (restartAfterHours !== undefined && currentState !== INITIAL_STATE) {
    const idleHours = hoursSinceLastActivity(history, new Date())
    if (idleHours !== null && idleHours >= restartAfterHours) {
      turnStart = await applyTriggerOrKeep(currentState, IDLE_TRIGGER)
      log.info(
        { from: currentState, to: turnStart, idleHours: Math.round(idleHours) },
        'conversation restarted after inactivity',
      )
    }
  }

  // The turn's opening trigger, applied BEFORE the tools are picked so a first
  // message gets the tools of the state it lands in. This is what lifts a
  // conversation off 'idle': no tool can, because 'idle' offers none that
  // produces a trigger. In every other state it matches nothing and writes
  // nothing.
  let effectiveState = await applyTriggerOrKeep(turnStart, 'customer_message')
  // Dónde quedó el turno por el mensaje del cliente, antes de cualquier tool.
  const openingState = effectiveState

  // Los mensajes fijos de este paso: el id lo da el paso compilado, el texto el
  // archivo del negocio. No depende del estado — se resuelve una vez y se
  // reusa cada vez que se recalcula el resto para un estado nuevo.
  const fileMessages = fileConfig?.fixedMessages ?? {}

  // El `openWith` de un paso: mensajes fijos que manda el código al entrar, sin
  // que la IA los pida. Uno roto (id sin declarar, marcador sin servicio) se
  // saltea con un error en el log: no le cuesta la respuesta al cliente.
  const openWithOf = async (state: string): Promise<FixedOutbound[]> => {
    const out: FixedOutbound[] = []
    for (const id of getStateConfig(flow, state).openWith ?? []) {
      const message = fileMessages[id]
      const rendered = message ? renderStaticMessage(message.text) : null
      if (!message || !rendered?.ok) {
        log.error(
          { state, message: id, reason: rendered?.ok === false ? rendered.reason : 'undeclared' },
          'openWith message skipped',
        )
        continue
      }
      const gallery = message.images
        ? await serviceMediaService.listForOwner(params.businessId, 'fixedMessage', id)
        : []
      out.push({
        text: rendered.text,
        ...(rendered.blocks ? { blocks: rendered.blocks } : {}),
        ...(gallery.length > 0 ? { images: gallery.map((row) => row.s3Key) } : {}),
      })
    }
    return out
  }

  // Se guardan en el historial ya, antes de llamar al modelo: son lo primero
  // que ve el cliente en este turno, y el modelo tiene que saber que salieron
  // para no repetirlos.
  const openingOut: FixedOutbound[] = []
  if (openingState !== turnStart) {
    for (const opening of await openWithOf(openingState)) {
      const persisted = await messageService.append({
        businessId: params.businessId,
        conversationId: params.conversationId,
        role: 'assistant',
        content: opening.text,
      })
      if (!persisted.ok) return persisted
      openingOut.push(opening)
    }
  }

  // 4. Knowledge base — selective, not the whole table. The customer message
  // routes to a category; `always` entries and matching `trigger_based` entries
  // come along regardless. See knowledgeBaseSearch.service.
  //
  // KB_SEARCH_MODE=semantic is not implemented yet: we log and fall back to the
  // category lookup rather than failing the reply over a misconfigured flag.
  if (env.KB_SEARCH_MODE === 'semantic') {
    log.warn(
      { kbSearchMode: env.KB_SEARCH_MODE },
      'KB_SEARCH_MODE=semantic is not implemented; falling back to category search',
    )
  }
  const kbResult = await knowledgeBaseSearch.searchByCategory(
    params.businessId,
    params.userMessage,
    settings?.niche ?? 'general',
  )
  if (!kbResult.ok) return kbResult
  // Extraído en un const propio: dentro de forState TypeScript no arrastra
  // el angostamiento de `if (!kbResult.ok)`.
  const kbEntries = kbResult.data.entries
  log.debug(
    { matchedCategories: kbResult.data.matchedCategories, kbEntryCount: kbEntries.length },
    'knowledge base entries selected for prompt',
  )

  // 6. Anything this customer still has open. The proposal text is already in
  // the history above, but a past assistant turn is something the model
  // describes rather than acts on — a patient answering "hola" to a proposed
  // slot got greeted as a first-timer. This is the structured signal.
  //
  // Non-fatal: failing to read it must not cost the customer their reply.
  const pendingResult = await appointmentService.getPendingContextForCustomer(
    params.businessId,
    customerId,
    business.timezone,
  )
  if (!pendingResult.ok) {
    log.warn(
      { code: pendingResult.error.code },
      'could not load the pending appointment context; replying without it',
    )
  }
  const pending = pendingResult.ok ? pendingResult.data : null

  // History drives the call-to-action decision (see decideCallToAction): the
  // model no longer judges whether it already invited recently.
  // Which services have files, by id. One query per reply rather than a field
  // on the service, because media lives in its own table now — and the prompt
  // module is pure, so it cannot go and look.
  //
  // Non-fatal, and deliberately so. This is the only query in the reply path
  // that can fail without the reply being wrong: losing it costs the
  // "[con material]" markers, so Emma describes the service in words instead of
  // offering a file. Letting it throw would cost the whole answer — the same
  // rule outbound.ts states for a photo that will not send, applied one layer
  // earlier.
  //
  // It also covers a deploy that reaches production before its migration does:
  // without this, code shipped ahead of `service_media` would take down every
  // customer reply instead of quietly sending no files.
  let servicesWithMedia: ReadonlySet<string> = new Set()
  try {
    const mediaRows = await serviceMediaService.listForBusiness(params.businessId, 'service')
    servicesWithMedia = new Set(mediaRows.map((row) => row.serviceId))
  } catch (cause) {
    log.error({ err: cause }, 'could not read service media; replying without file markers')
  }

  // Only for a business that actually collects something. A clinic with no
  // configured fields has nothing stored and would pay a query per message to
  // find that out — and this is the hot path of every inbound message, which is
  // exactly what conversation.service warns about hiding reads inside.
  //
  // Never fatal: these facts make a reply better, and a failed read must not
  // cost the customer an answer.
  let customerFacts: Record<string, string> = {}
  if ((settings?.collectDataFields.length ?? 0) > 0) {
    const found = await customerService.getById(params.businessId, customerId)
    if (found.ok) customerFacts = customerService.collectedDataOf(found.data)
    else
      log.warn({ code: found.error.code }, 'could not read customer facts; replying without them')
  }

  // Todo lo que depende del ESTADO — qué tools se ofrecen, qué mensajes fijos
  // puede mandar, el contexto que ve el executor, y el prompt del sistema
  // completo — sale de acá. Se llama al principio del turno y de nuevo cada
  // vez que el estado cambia A MITAD de turno (advance_flow dentro del loop
  // de tools): si no, el modelo sigue el resto de la vuelta con las tools y
  // el texto del paso VIEJO, aunque la conversación ya haya avanzado — así
  // "no tengo experiencia" contestaba de memoria en vez de con
  // show_services, porque esa tool ni siquiera estaba ofrecida todavía.
  //
  // El prompt del sistema nunca se persiste (se arma de cero en cada turno),
  // así que rehacerlo acá no ensucia nada. El caché de OpenAI es por
  // prefijo: la capa 1 (`business`/KB, la cara) es igual sea cual sea el
  // nodo, así que esto solo invalida el sufijo (el bloque del nodo).
  function forState(state: string) {
    const config = getStateConfig(flow, state)
    // A tool the state does not list is not refused — it is never offered, so
    // the model never considers it. Different layer from the executor's
    // gates, which judge the calls that do come through: the deposit gate
    // stays the authority over book_appointment.
    const allowedToolNames = new Set(config.tools)
    const stateTools = kumaTools.filter(
      (t) => t.type === 'function' && allowedToolNames.has(t.function.name),
    )
    // Every state defines at least one tool today, so this is never empty. The
    // guard is here because OpenAI rejects `tools: []` with a 400 — a state
    // added later without tools should degrade to a plain completion, not an
    // error.
    const toolsParam = stateTools.length > 0 ? stateTools : undefined
    const toolChoiceParam = stateTools.length > 0 ? ('auto' as const) : undefined
    const stepFixedMessages: StepFixedMessage[] = (config.fixedMessages ?? []).flatMap((id) => {
      const message = fileMessages[id]
      return message ? [{ id, ...message }] : []
    })
    const toolContext: ToolContext = {
      businessId: params.businessId,
      conversationId: params.conversationId,
      customerId,
      // Del flujo compilado una vez al principio del turno, así el executor
      // juzga advance_flow contra las mismas rutas que el prompt le mostró al
      // modelo. Resolverlas de nuevo acá podría discrepar si el dueño guardó
      // a mitad de turno.
      branches: config.branches,
      fixedMessages: stepFixedMessages,
    }
    const basePrompt = buildSystemPrompt(
      business,
      kbEntries,
      settings,
      history,
      pending,
      servicesWithMedia,
      customerFacts,
      config.cta,
    )
    // The node goes last, after the variable tail — the static body has to
    // stay first for the prompt cache, and the final position is where an
    // instruction weighs most. A node with no objective ('idle') renders to
    // nothing at all, not even the header.
    const nodeBlock = renderNodeBlock(
      config.node,
      config.branches,
      stepFixedMessages.map((m) => ({ id: m.id, when: m.when ?? '' })),
    )
    const systemPrompt = nodeBlock ? [basePrompt, '', nodeBlock].join('\n') : basePrompt
    return {
      stateConfig: config,
      toolsParam,
      toolChoiceParam,
      stepFixedMessages,
      toolContext,
      systemPrompt,
    }
  }

  let { stateConfig, toolsParam, toolChoiceParam, toolContext, systemPrompt } =
    forState(effectiveState)

  log.debug(
    { flowType, stateIn: currentState, state: effectiveState, allowedTools: stateConfig.tools },
    'conversation state resolved for this reply',
  )

  const chatMessages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...convertHistoryToChatMessages(history),
    // Ya guardados, pero el historial se leyó antes de guardarlos.
    ...openingOut.map((m): ChatCompletionMessageParam => ({ role: 'assistant', content: m.text })),
  ]

  let totalTokensInput = 0
  let totalTokensOutput = 0
  const executedTools: ExecutedToolCall[] = []
  const attachments: ToolAttachment[] = []
  // Starts at the default and only ever goes up, so a turn that listed the
  // catalogue and then sent one service's extra photo keeps the wider ceiling
  // it already committed to rather than cutting itself off mid-reply.
  let attachmentBudget = MAX_ATTACHMENTS_PER_TURN
  let escalated = false
  // Topado a MAX_FIXED_MESSAGES_PER_TURN: cada mensaje fijo es un mensaje
  // saliente (más su imagen), y apilar demasiadas ofertas en la misma
  // respuesta no las hace más claras.
  const fixedOut: FixedOutbound[] = []
  let fixedPersisted = 0
  // Para stepOwesFixedMessage: si el paso vigente se entró en este turno y
  // cuántos mensajes fijos salieron desde que se entró. Se reinician en cada
  // cambio de paso.
  let enteredThisTurn = openingState !== turnStart
  let sentInStep = 0
  // Un paso `fixedOnly` que cierra sin su mensaje fijo se devuelve UNA vez: si
  // al segundo intento tampoco lo manda, sale su texto — nunca se deja al
  // cliente sin respuesta.
  let nudged = false

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    let completion: ChatCompletion
    try {
      completion = await openai.chat.completions.create(
        {
          model: MODEL,
          messages: chatMessages,
          tools: toolsParam,
          tool_choice: toolChoiceParam,
          temperature: TEMPERATURE,
          max_tokens: MAX_TOKENS,
        },
        { signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS) },
      )
    } catch (cause) {
      const isTimeout =
        cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError')
      return err(
        new AppError({
          code: isTimeout ? 'llm_timeout' : 'llm_generate_failed',
          message: cause instanceof Error ? cause.message : 'unknown error',
          userMessage: 'Disculpa, estoy con un problema técnico.',
          logContext: {
            businessId: params.businessId,
            conversationId: params.conversationId,
            iteration,
            model: MODEL,
            timedOut: isTimeout,
          },
          cause,
        }),
      )
    }

    totalTokensInput += completion.usage?.prompt_tokens ?? 0
    totalTokensOutput += completion.usage?.completion_tokens ?? 0

    const choice = completion.choices[0]
    const choiceMessage = choice?.message
    if (!choiceMessage) {
      return err(
        new AppError({
          code: 'llm_empty_response',
          message: 'openai returned no message in choice',
          userMessage: 'Disculpa, no pude generar una respuesta.',
          logContext: {
            businessId: params.businessId,
            conversationId: params.conversationId,
            iteration,
          },
        }),
      )
    }

    const toolCalls = choiceMessage.tool_calls
    const assistantContent = choiceMessage.content ?? ''

    // Final answer: model decided not to call any tools.
    if (!toolCalls || toolCalls.length === 0) {
      // Un paso `fixedOnly` al que se entró en este turno responde con su
      // mensaje fijo. Si la IA cierra sin mandarlo, se le devuelve el turno una
      // vez; su texto no se guarda. Así "sí" en beneficios llega al mensaje de
      // pago del negocio y no a un monto inventado.
      if (
        stateConfig.fixedOnly === true &&
        stepOwesFixedMessage(stateConfig, enteredThisTurn, sentInStep) &&
        !nudged &&
        iteration < MAX_TOOL_ITERATIONS - 1
      ) {
        nudged = true
        log.info(
          { state: effectiveState, discarded: preview(assistantContent, 120) },
          'fixedOnly step: nudged to send its fixed message',
        )
        chatMessages.push({ role: 'system', content: FIXED_MESSAGE_PENDING_INSTRUCTION })
        continue
      }

      // El `openWith` de un paso al que se entró A MITAD de turno sale solo si el
      // turno termina ahí: si la conversación pasó por el listado de cursos y
      // siguió de largo a certificaciones, la intro de cursos no tiene sentido.
      const closingOut: FixedOutbound[] = []
      if (effectiveState !== openingState) {
        for (const closing of await openWithOf(effectiveState)) {
          const persisted = await messageService.append({
            businessId: params.businessId,
            conversationId: params.conversationId,
            role: 'assistant',
            content: closing.text,
          })
          if (!persisted.ok) return persisted
          closingOut.push(closing)
        }
      }
      // Vacío es un error solo si además no salió nada fijo esta vuelta: sin
      // mensajes fijos, un content vacío es una respuesta que no le dijo nada
      // al cliente. Con alguno, ese mensaje YA le dijo algo (y ya se persistió)
      // — un cierre sin texto propio es una respuesta válida, no un fallo.
      // Antes esto no existía: el modelo no tenía forma de "no decir nada", así
      // que agregaba una frase de cierre aunque se le pidiera lo contrario.
      if (
        !assistantContent &&
        fixedOut.length === 0 &&
        openingOut.length === 0 &&
        closingOut.length === 0
      ) {
        return err(
          new AppError({
            code: 'llm_empty_response',
            message: 'openai returned no content and no tool_calls',
            userMessage: 'Disculpa, no pude generar una respuesta.',
            logContext: {
              businessId: params.businessId,
              conversationId: params.conversationId,
              iteration,
            },
          }),
        )
      }

      // Solo el `openWith` del paso donde termina el turno: la presentación
      // del saludo no silencia la respuesta de un paso posterior.
      const ownOpenWithSent =
        closingOut.length > 0 ||
        (effectiveState === openingState && openingState !== turnStart && openingOut.length > 0)

      // `fixedOnly` (config del paso): si salió un mensaje fijo —el que pidió la
      // IA o el `openWith` del propio paso—, ése es la respuesta completa y el
      // texto propio del modelo se tira. Lo decide el código y no una
      // instrucción, porque pedirle al modelo que no agregue nada después de un
      // mensaje fijo no funcionó nunca: siempre escribía una frase de cierre
      // ("Esto es lo que vas a tener. ¿…?"). Con el `openWith` pasa lo mismo:
      // Tecmin, 2026-09-29, la IA escribió su propia lista de certificaciones
      // con precios encima de la del negocio. Se lee el paso vigente al cerrar
      // el turno, igual que el CTA y `mediaFirst`.
      const discardText = stateConfig.fixedOnly === true && (fixedOut.length > 0 || ownOpenWithSent)
      // `catalogOnEnter`: al entrar al paso, las fichas las manda el código —si
      // la IA no llamaba show_services no había fichas, y la IA escribía el
      // listado en texto— y el mensaje de Emma es exactamente la invitación del
      // paso. Si la IA igual pidió las fichas, la cola descarta las repetidas.
      const catalogCategory = enteredThisTurn ? stateConfig.catalogOnEnter : undefined
      const stepCta = typeof stateConfig.cta === 'string' ? stateConfig.cta : undefined
      if (catalogCategory) {
        const cards = await serviceCardsForCategory(toolContext, catalogCategory)
        if (cards.length === 0) {
          log.warn(
            { state: effectiveState, category: catalogCategory },
            'catalogOnEnter: no cards to send (category empty or without photos)',
          )
        }
        attachmentBudget = Math.max(attachmentBudget, MAX_SERVICE_CARDS_PER_TURN)
        queueAttachments(attachments, cards, attachmentBudget)
      }

      // Lo que el código ya mandó como mensaje de entrada no se repite en el
      // texto de Emma: la IA volvía a escribir la intro de cursos aunque se le
      // dijera que ya había salido. Queda limpio también en el historial.
      const finalContent =
        catalogCategory && stepCta
          ? stepCta
          : discardText
            ? ''
            : withoutRepeatedLines(
                assistantContent,
                [...openingOut, ...closingOut].map((m) => m.text),
              )
      if (discardText && assistantContent) {
        log.debug(
          { state: effectiveState, discarded: preview(assistantContent, 120) },
          'fixedOnly step: model text discarded after a fixed message',
        )
      }

      if (finalContent) {
        const persistResult = await messageService.append({
          businessId: params.businessId,
          conversationId: params.conversationId,
          role: 'assistant',
          content: finalContent,
        })
        if (!persistResult.ok) return persistResult
      }

      log.info(
        {
          iteration,
          flowType,
          stateIn: currentState,
          state: effectiveState,
          allowedTools: stateConfig.tools,
          tokensInput: totalTokensInput,
          tokensOutput: totalTokensOutput,
          toolsExecuted: executedTools.length,
        },
        'llm produced final reply',
      )

      // Last, so the turn cap in queueAttachments is spent on what the customer
      // actually asked for first. A step's material is context the owner chose;
      // a service's photo is an answer to a question just asked, and if only one
      // slot is left that is the one that should use it.
      if (effectiveState !== turnStart) {
        queueAttachments(
          attachments,
          await nodeAttachments({
            businessId: params.businessId,
            conversationId: params.conversationId,
            nodeId: effectiveState,
            log,
          }),
          attachmentBudget,
        )
      }

      return ok({
        content: finalContent,
        tokensInput: totalTokensInput,
        tokensOutput: totalTokensOutput,
        toolCallsExecuted: executedTools,
        escalated,
        maxIterationsHit: false,
        attachments,
        // En el mismo orden en que quedaron en el historial.
        fixedMessages: [...openingOut, ...fixedOut, ...closingOut],
        // Del paso vigente al CERRAR el turno: es el mismo criterio que usa el
        // CTA (stateConfig ya refleja cualquier advance_flow de esta vuelta).
        mediaFirst: stateConfig.mediaFirst ?? false,
      })
    }

    // Model wants to call tools. Persist the assistant turn (with raw OpenAI
    // tool_calls shape per Día 7 decision) and feed the same shape back to
    // the next iteration.
    const persistAssistant = await messageService.append({
      businessId: params.businessId,
      conversationId: params.conversationId,
      role: 'assistant',
      content: assistantContent,
      toolCalls: toolCalls,
    })
    if (!persistAssistant.ok) return persistAssistant

    chatMessages.push({
      role: 'assistant',
      content: assistantContent === '' ? null : assistantContent,
      tool_calls: toolCalls,
    })

    for (const call of toolCalls) {
      if (call.type !== 'function') continue

      let parsedArgs: unknown
      try {
        parsedArgs = JSON.parse(call.function.arguments)
      } catch {
        parsedArgs = {}
      }

      // Un paso con mensajes fijos no se abandona sin mandarlos: la IA encadenaba
      // rutas (perfil → beneficios → pago) en un solo turno y los beneficios
      // nunca salían. Se rechaza sin ejecutar, y la IA sigue en el mismo turno.
      const owesFixed =
        call.function.name === 'advance_flow' &&
        stepOwesFixedMessage(stateConfig, enteredThisTurn, sentInStep)
      if (owesFixed) {
        log.info({ state: effectiveState }, 'advance_flow refused: fixed message pending')
      }
      const toolResult: ToolExecutionResult = owesFixed
        ? {
            result: JSON.stringify({
              error: 'fixed_message_pending',
              instruction: FIXED_MESSAGE_PENDING_INSTRUCTION,
            }),
            error: 'fixed_message_pending',
          }
        : await executeTool(call.function.name, parsedArgs, toolContext)

      log.info(
        {
          iteration,
          tool: call.function.name,
          args: parsedArgs,
          resultPreview: preview(toolResult.result, 200),
          error: toolResult.error,
        },
        'tool executed',
      )

      executedTools.push({
        name: call.function.name,
        args: parsedArgs,
        result: toolResult.result,
        error: toolResult.error,
      })

      // Deduplicated and capped across the WHOLE turn, not per tool call — see
      // attachmentQueue, which is where both rules and the reason for them live.
      attachmentBudget = Math.max(attachmentBudget, toolResult.maxAttachments ?? 0)
      queueAttachments(attachments, toolResult.attachments ?? [], attachmentBudget)

      for (const fixed of toolResult.fixedMessages ?? []) {
        if (fixedOut.length >= MAX_FIXED_MESSAGES_PER_TURN) {
          log.warn({ tool: call.function.name }, 'fixed message beyond per-turn cap ignored')
          continue
        }
        fixedOut.push(fixed)
        sentInStep++
      }

      // Folded over the turn's own variable rather than re-read from the row:
      // when the model calls two tools in one iteration, the second has to be
      // evaluated against the state the first one left behind. Persisted at the
      // moment of the change so a later error return cannot take it down with it.
      if (toolResult.trigger) {
        // The evidence rides along with the trigger that produced it: the
        // executor is the only layer that can prove a target state's entry
        // guard, and it has already gone by the time this state is persisted.
        const stateBeforeThisCall = effectiveState
        effectiveState = await applyTriggerOrKeep(
          effectiveState,
          toolResult.trigger,
          toolResult.evidence,
        )
        if (effectiveState !== stateBeforeThisCall) {
          enteredThisTurn = true
          sentInStep = 0
          // El resto de esta vuelta tiene que ver el paso NUEVO — ver el
          // comentario de forState más arriba.
          ;({ stateConfig, toolsParam, toolChoiceParam, toolContext, systemPrompt } =
            forState(effectiveState))
          chatMessages[0] = { role: 'system', content: systemPrompt }
        }
      }

      if (call.function.name === 'escalate_to_human' && !toolResult.error) {
        escalated = true
      }

      const persistTool = await messageService.append({
        businessId: params.businessId,
        conversationId: params.conversationId,
        role: 'tool',
        content: toolResult.result,
        toolCallId: call.id,
      })
      if (!persistTool.ok) return persistTool

      chatMessages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: toolResult.result,
      })
    }

    // El mensaje fijo queda en el historial como dicho por Emma: así el próximo
    // turno sabe que la oferta ya salió y no la repite, y el dueño la ve en el
    // Inbox tal como la recibió el cliente. Recién acá, después de TODOS los
    // resultados de esta vuelta: OpenAI exige que cada resultado siga a su
    // pedido, y un mensaje en el medio rompería el historial del turno siguiente.
    for (const fixed of fixedOut.slice(fixedPersisted)) {
      const persistFixed = await messageService.append({
        businessId: params.businessId,
        conversationId: params.conversationId,
        role: 'assistant',
        content: fixed.text,
      })
      if (!persistFixed.ok) return persistFixed
    }
    fixedPersisted = fixedOut.length
  }

  // Safety net: too many iterations. Auto-escalate and return a canned reply.
  log.warn(
    {
      maxIterations: MAX_TOOL_ITERATIONS,
      flowType,
      stateIn: currentState,
      state: effectiveState,
      allowedTools: stateConfig.tools,
      toolsExecuted: executedTools.length,
    },
    'llm hit max tool iterations, auto-escalating',
  )

  if (!escalated) {
    const autoEscalate = await appointmentService.escalate({
      businessId: params.businessId,
      conversationId: params.conversationId,
      reason: 'llm max iterations exceeded',
    })
    if (autoEscalate.ok) escalated = true
  }

  const persistFallback = await messageService.append({
    businessId: params.businessId,
    conversationId: params.conversationId,
    role: 'assistant',
    content: MAX_ITERATIONS_FALLBACK_TEXT,
  })
  if (!persistFallback.ok) return persistFallback

  return ok({
    content: MAX_ITERATIONS_FALLBACK_TEXT,
    tokensInput: totalTokensInput,
    tokensOutput: totalTokensOutput,
    toolCallsExecuted: executedTools,
    escalated,
    maxIterationsHit: true,
    // Dropped on purpose: this path replaces the model's reply with the fallback
    // text and escalates, and a service photo arriving next to "te conecto con
    // alguien" would be noise at the worst moment.
    attachments: [],
    // Estos sí: ya quedaron en el historial como dichos, y no mandarlos dejaría
    // al dueño leyendo en el Inbox una oferta que el cliente nunca recibió.
    fixedMessages: [...openingOut, ...fixedOut],
    // Sin attachments en este camino, el orden no importa.
    mediaFirst: false,
  })
}

/**
 * The files the owner hung on a STEP of the flow, rather than on a service.
 *
 * Queued only when the conversation ENTERED the step on this turn. While it sits
 * in a step nothing is resent: a customer who asks three questions inside
 * `listado_servicios` would otherwise receive the same brochure three times.
 *
 * Keyed as `node:<id>` in the repeat window so it shares the per-conversation
 * budget with service media without ever colliding with a service's nanoid.
 * Both are the same promise to the customer — "you already got this" — and the
 * window is what makes it one promise instead of two.
 */
async function nodeAttachments(params: {
  businessId: string
  conversationId: string
  nodeId: string
  log: Pick<typeof logger, 'debug'>
}): Promise<ToolAttachment[]> {
  const windowKey = `node:${params.nodeId}`
  if (!canSendServiceMedia(params.conversationId, windowKey)) return []

  const rows = await serviceMediaService.listForOwner(params.businessId, 'node', params.nodeId)
  if (rows.length === 0) return []

  params.log.debug({ nodeId: params.nodeId, files: rows.length }, 'queueing media of a flow step')

  return rows.map((row) => ({
    s3Key: row.s3Key,
    // No caption: a step's material is not about one product, and a caption
    // repeating the step's name would read as a label on the customer's screen.
    caption: '',
    serviceId: windowKey,
    type: row.type as ToolAttachment['type'],
    mimetype: row.mimetype,
    filename: row.filename ?? `archivo.${row.type}`,
  }))
}
