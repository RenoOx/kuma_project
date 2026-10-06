import type { BusinessSettings, FlowType } from '@/modules/business/business.settings.js'
import type { ImageHandling, NodeIdFor } from '@/modules/conversation/nodeCatalog.js'
import type {
  FlowComposition,
  NodeOverride,
  StepChoices,
} from '@/modules/conversation/stateMachine.js'
import type { EscalationGate } from '@/modules/llm/escalationGate.js'
import type { FixedMessage } from '@/modules/llm/fixedMessage.js'

// Un negocio cuya conversación se configura en el repo y no en el panel.
//
// El archivo manda sobre lo que tenga la base, pero solo mientras coincida con la
// base en el tipo de flujo y siga validando contra la configuración actual — ver
// conversation/flowSource.ts, que es el único lector. Un archivo que deja de
// coincidir se saltea entero, nunca se obedece a medias.
//
// Lo que NO está acá: los servicios (cursos, precios, descripciones, imágenes),
// los horarios y la dirección. Esos los edita el dueño desde el panel.

type AssistantTone = BusinessSettings['assistant']['tone']

/** One step of the flow, with its wording overrides next to it. */
export interface BusinessStep<F extends FlowType, M extends string> {
  node: NodeIdFor<F>
  /** What the panel calls this step. Cosmetic. */
  label?: string
  /** Replace the catalogue's special cases for this step. */
  edgeCases?: string[]
  /** Replace the catalogue's tone sample for this step. */
  example?: string
  /** Added after the catalogue's steps, never replacing them. */
  extraInstructions?: string
  /** Owner-written ways out of this step, on top of its fixed exits. */
  routes?: Array<{ id: string; when: string; to: NodeIdFor<F> }>
  /**
   * La invitación de cierre de este paso, tal cual. `false`: este paso no
   * cierra con ninguna invitación (ni la fija ni la rotativa). Ausente: la
   * rotativa de siempre.
   */
  cta?: string | false
  /** Qué hacer si el cliente manda una foto en este paso. */
  onImage?: ImageHandling
  /**
   * Los mensajes fijos que Emma puede mandar en este paso. NoInfer: los ids
   * salen de `fixedMessages`, así que nombrar uno que no existe no compila.
   */
  fixedMessages?: NoInfer<M>[]
  /**
   * Manda las fotos/fichas de este paso ANTES del texto de Emma, en vez de
   * después (el orden de siempre). Pensado para un paso que LISTA varias
   * opciones con foto y cierra con una invitación: el cliente tiene que ver
   * todo el material antes de que le pregunten cuál elige, no al revés.
   */
  mediaFirst?: boolean
  /**
   * Si en un turno de este paso sale un mensaje fijo, ESE mensaje es la
   * respuesta completa: el texto propio de Emma se descarta antes de enviarse.
   * Existe porque pedirle al modelo que no agregue nada después de un mensaje
   * fijo no funciona — casi siempre escribe una frase de cierre igual.
   */
  fixedOnly?: boolean
  /**
   * Mensajes fijos que el CÓDIGO manda solo al entrar a este paso, antes que
   * todo lo demás del turno. Sin servicio: el texto no puede llevar {precio} ni
   * {servicio}. Si se entra a mitad de turno y el turno termina en otro paso,
   * no salen (ver llm.service).
   */
  openWith?: NoInfer<M>[]
  /**
   * Categoría de servicios cuyas fichas (imagen + detalle) manda el CÓDIGO al
   * entrar a este paso, sin depender de que la IA llame show_services ni de la
   * ventana de repetición. En ese turno el texto de Emma es exactamente el `cta`.
   */
  catalogOnEnter?: string
  /**
   * Opciones que se eligen en este paso, y la elección la hace el CÓDIGO: una
   * letra o un tramo se resuelven sin la IA; si el cliente lo dice con otras
   * palabras, la IA solo pasa lo que entendió (la letra, cuántas, o la lista de
   * lo que nombró) y el código cuenta. Al elegir, sale por `route` y manda los
   * mensajes de `send` con el servicio de la opción. El mapeo letra → opción vive
   * SOLO acá: no se repite en instrucciones. Ver StepChoices en stateMachine.
   */
  choices?: {
    route: string
    /**
     * El paso donde el código manda el `onAccept` de la opción elegida (ej. el
     * pedido de pago). Así el mensaje de pago no lo elige la IA.
     */
    followUp?: NodeIdFor<F>
    options: Array<{
      key: string
      /** Id del servicio en la lista del negocio. */
      service: string
      send: NoInfer<M>[]
      /** Rango de cantidad que define la opción; `null` = sin tope. */
      count?: [number, number | null]
      /** Lo que manda el código al entrar a `followUp` si esta es la opción elegida. */
      onAccept?: NoInfer<M>[]
    }>
  }
  /**
   * En este paso el cliente puede cambiar la opción que eligió en un paso con
   * `choices` anterior ("mejor la B"): mismas opciones, misma etapa, oferta nueva.
   */
  rechoose?: boolean
}

export interface BusinessConfigInput<F extends FlowType, M extends string> {
  businessId: string
  /** For whoever reads the file. Never applied. */
  name: string
  /** Has to match the database, or the file is skipped. */
  flowType: F
  /** Lo primero que Emma dice, tal cual. */
  greeting?: string
  /** El trato con el cliente. */
  tone?: AssistantTone
  /** Instrucciones que valen en TODOS los pasos (las de un paso van en el paso). */
  instructions?: string
  /** Los datos que Emma pide en la captura, en orden. */
  collectData?: string[]
  /**
   * Apaga el adelanto para ESTE flujo, sin tocar la fila real de la base.
   * Existe porque "Formas de pago y adelanto" está bloqueado en el panel
   * (lo configura Vamvu) — así que el único lugar donde se puede decidir
   * "este flujo cobra directo" es acá, no en un PATCH que el servidor rechaza.
   * Solo apaga (`false`); no hay forma de prenderlo desde el archivo.
   */
  requiresDeposit?: false
  /** Mensajes que el código manda tal cual; la IA solo decide cuándo. */
  fixedMessages?: Record<M, FixedMessage>
  /**
   * Horas sin hablar después de las cuales un mensaje del cliente cuenta como
   * conversación nueva: vuelve al inicio del flujo (idle → greeting). Ausente:
   * nunca se reinicia por tiempo.
   */
  restartAfterHours?: number
  /**
   * Cuándo escala Emma, en palabras del negocio: reemplaza el "usar cuando…" de
   * la herramienta escalate_to_human, que es común a todos los negocios y dice
   * "pregunta por pagos" — en un negocio que cobra por chat, "¿cómo pago?" es la
   * señal de cierre, no un motivo para pasar a una persona.
   */
  escalateWhen?: string
  /**
   * Qué pasa con una foto que llega en un paso que no la pide. Ausente: se
   * guarda y nada más (silencio, la regla general). `'continue'`: tampoco se
   * reenvía, pero Emma sigue el paso sabiendo que llegó, para pedirla de nuevo
   * cuando corresponda en vez de dejar al cliente esperando.
   */
  earlyImages?: 'continue'
  /**
   * Prompt corto: sin los bloques que existen para agendas y otros rubros
   * (prompts.lean.ts). Un negocio sin esto recibe el prompt de siempre.
   */
  leanPrompt?: boolean
  /**
   * Respuestas del negocio a lo que los clientes preguntan seguido (docentes,
   * horarios, trabajo…), una por línea, para que Emma las use tal cual. Solo con
   * `leanPrompt`. Viven acá y no en `instructions` porque esas tienen el tope
   * de 2.000 caracteres del panel, y una respuesta que falta es una que el
   * modelo inventa.
   */
  answers?: string[]
  /**
   * El portero de la escalada (ver llm/escalationGate.ts): escalate_to_human
   * solo se ejecuta si el mensaje del cliente coincide con algún patrón (motivos
   * reales: pide una persona, es empresa, reclamo…) o si insiste después de que
   * Emma ya le dio la frase `insistAfter`. Los patrones son expresiones
   * regulares que se comparan contra el texto sin tildes y en minúsculas, así
   * que se escriben sin tildes. Vale para todos los pasos.
   */
  escalationGate?: { patterns: string[]; insistAfter: string }
  /**
   * `false`: Emma no le contesta al dueño. Sus mensajes al número del negocio se
   * registran y nada más; las notificaciones (fotos, escaladas, avisos) le siguen
   * llegando. Para un negocio donde el dueño reenvía los avisos y una IA que le
   * responde solo estorba. Ausente: el asistente del dueño de siempre.
   */
  ownerAssistant?: false
  /**
   * Lo que se le responde a un audio o nota de voz, tal cual, en vez de las
   * variantes de siempre. Mismo límite: una vez cada 10 minutos por chat.
   */
  audioReply?: string
  /**
   * Lo que contesta un chat escalado mientras espera a la persona, tal cual. Va
   * por encima de `messages.handoff` de la base (bloqueado en el panel).
   */
  handoff?: string
  /**
   * Las etapas del embudo de ventas del panel, en orden: cada una cuenta las
   * conversaciones que recibieron alguno de esos mensajes fijos. El panel les
   * suma adelante "Leads" y atrás "Mandó la foto" y Pagó / No pagó. Ausente: el
   * panel no muestra el embudo.
   */
  funnel?: { label: string; fixedMessages: NoInfer<M>[] }[]
  /**
   * Etiquetas del WhatsApp Business del dueño, por id de servicio. Cuando un
   * cliente sin número ni @usuario manda la foto de un paso con reenvío, Emma le
   * pone al chat la etiqueta de lo que eligió, para que el dueño lo encuentre
   * filtrando por etiqueta (2026-10-05). Ids numéricos desde 900: crear una
   * etiqueta con un id que ya existe RENOMBRA la del dueño (las de fábrica son
   * 1–5 y las suyas siguen desde 6). WhatsApp Business admite 20 en total.
   */
  whatsappLabels?: Record<string, WhatsappLabel>
  /**
   * El modelo de OpenAI con que responde Emma a los clientes de este negocio.
   * Ausente: `gpt-4o-mini`. Lista cerrada a modelos que aceptan los mismos
   * parámetros (`temperature`, `max_tokens`); la familia GPT-5 pide otros.
   */
  model?: CustomerModel
  /** The conversation, in order. */
  flow: BusinessStep<F, M>[]
}

/** Lo que el archivo pone por encima de la configuración guardada en la base. */
export interface BusinessSettingsOverlay {
  greeting?: string
  tone?: AssistantTone
  instructions?: string
  collectData?: string[]
  requiresDeposit?: false
  handoff?: string
}

/** Modelos que Emma puede usar con los clientes (ver `model`). */
export type CustomerModel = 'gpt-4o-mini' | 'gpt-4.1-mini'

/** Una etiqueta del WhatsApp Business del dueño (ver `whatsappLabels`). */
export interface WhatsappLabel {
  id: string
  name: string
}

/** Una etapa del embudo de ventas: las conversaciones que recibieron alguno de estos mensajes fijos. */
export interface FunnelStage {
  label: string
  fixedMessages: string[]
}

export interface BusinessConfig {
  businessId: string
  name: string
  flowType: FlowType
  composition: FlowComposition
  settings: BusinessSettingsOverlay
  fixedMessages: Record<string, FixedMessage>
  restartAfterHours?: number
  escalateWhen?: string
  earlyImages?: 'continue'
  leanPrompt?: boolean
  answers?: string[]
  escalationGate?: EscalationGate
  ownerAssistant?: false
  audioReply?: string
  funnel?: FunnelStage[]
  whatsappLabels?: Record<string, WhatsappLabel>
  model?: CustomerModel
}

// Ids propios desde 900: nunca chocan con las etiquetas del dueño.
const MIN_LABEL_ID = 900
const MAX_LABEL_NAME = 40

/** Rompe al importar el archivo si una etiqueta podría pisar otra o no entra. */
function checkedLabels(labels: Record<string, WhatsappLabel>): Record<string, WhatsappLabel> {
  const ids = new Set<string>()
  for (const [serviceId, label] of Object.entries(labels)) {
    if (!/^\d+$/.test(label.id) || Number(label.id) < MIN_LABEL_ID) {
      throw new Error(
        `whatsappLabels[${serviceId}]: id "${label.id}" must be a number >= ${MIN_LABEL_ID}`,
      )
    }
    if (ids.has(label.id)) throw new Error(`whatsappLabels: duplicated label id "${label.id}"`)
    ids.add(label.id)
    const name = label.name.trim()
    if (name.length === 0 || name.length > MAX_LABEL_NAME) {
      throw new Error(`whatsappLabels[${serviceId}]: name must be 1-${MAX_LABEL_NAME} characters`)
    }
  }
  return Object.fromEntries(
    Object.entries(labels).map(([serviceId, label]) => [
      serviceId,
      { id: label.id, name: label.name.trim() },
    ]),
  )
}

function overrideOf<F extends FlowType, M extends string>(
  step: BusinessStep<F, M>,
): NodeOverride | null {
  const override: NodeOverride = {
    ...(step.label !== undefined ? { label: step.label } : {}),
    ...(step.edgeCases !== undefined ? { edgeCases: step.edgeCases } : {}),
    ...(step.example !== undefined ? { example: step.example } : {}),
    ...(step.extraInstructions !== undefined ? { extraInstructions: step.extraInstructions } : {}),
    ...(step.routes !== undefined ? { branches: step.routes } : {}),
    ...(step.cta !== undefined ? { cta: step.cta } : {}),
    ...(step.onImage !== undefined ? { onImage: step.onImage } : {}),
    ...(step.fixedMessages !== undefined ? { fixedMessages: step.fixedMessages } : {}),
    ...(step.mediaFirst !== undefined ? { mediaFirst: step.mediaFirst } : {}),
    ...(step.fixedOnly !== undefined ? { fixedOnly: step.fixedOnly } : {}),
    ...(step.openWith !== undefined ? { openWith: step.openWith } : {}),
    ...(step.catalogOnEnter !== undefined ? { catalogOnEnter: step.catalogOnEnter } : {}),
    ...(step.choices !== undefined ? { choices: checkedChoices(step) } : {}),
    ...(step.rechoose ? { rechoose: true } : {}),
  }
  return Object.keys(override).length > 0 ? override : null
}

/**
 * Rompe al importar el archivo si las opciones de un paso no pueden funcionar:
 * así un error de armado sale en el typecheck/tests y no en una conversación.
 */
function checkedChoices<F extends FlowType, M extends string>(
  step: BusinessStep<F, M>,
): StepChoices {
  const choices = step.choices
  if (!choices) throw new Error('checkedChoices without choices')
  const where = `${step.node}.choices`
  if (!(step.routes ?? []).some((route) => route.id === choices.route)) {
    throw new Error(`${where}: route "${choices.route}" is not one of the step routes`)
  }
  if (choices.options.length < 2) throw new Error(`${where}: needs at least 2 options`)
  const keys = new Set<string>()
  for (const option of choices.options) {
    const key = option.key.trim().toUpperCase()
    if (!/^[A-Z]$/.test(key)) throw new Error(`${where}: key "${option.key}" must be one letter`)
    if (keys.has(key)) throw new Error(`${where}: duplicated key "${key}"`)
    keys.add(key)
    if (option.send.length === 0) throw new Error(`${where}.${key}: send is empty`)
    if (choices.followUp && (option.onAccept ?? []).length === 0) {
      throw new Error(`${where}.${key}: with followUp, every option needs onAccept`)
    }
    if (!option.service.trim()) throw new Error(`${where}.${key}: service is empty`)
  }
  // Rangos: todos o ninguno; desde 1, sin huecos ni cruces, solo el último sin tope.
  const withCount = choices.options.filter((o) => o.count)
  if (withCount.length > 0) {
    if (withCount.length !== choices.options.length) {
      throw new Error(`${where}: count must be set on every option or on none`)
    }
    const sorted = [...withCount].sort((a, b) => (a.count?.[0] ?? 0) - (b.count?.[0] ?? 0))
    let next = 1
    sorted.forEach((option, i) => {
      const [from, to] = option.count ?? [0, 0]
      const last = i === sorted.length - 1
      if (from !== next) throw new Error(`${where}: ranges must start at ${next} (got ${from})`)
      if (to === null && !last) throw new Error(`${where}: only the last range can be open`)
      if (to !== null && to < from) throw new Error(`${where}: range ${from}-${to} is reversed`)
      next = (to ?? from) + 1
    })
  }
  return {
    route: choices.route,
    ...(choices.followUp ? { followUp: choices.followUp } : {}),
    options: choices.options.map((option) => ({
      key: option.key.trim().toUpperCase(),
      serviceId: option.service,
      send: [...option.send],
      ...(option.count ? { count: option.count } : {}),
      ...(option.onAccept ? { onAccept: [...option.onAccept] } : {}),
    })),
  }
}

/**
 * Lo de `choices` que mira el flujo entero: el `followUp` es un paso del flujo,
 * y un paso `rechoose` es adonde llega alguna elección (si no, no hay qué
 * corregir).
 */
function checkChoiceSteps<F extends FlowType, M extends string>(
  flow: ReadonlyArray<BusinessStep<F, M>>,
): void {
  const nodes = new Set<string>(flow.map((step) => step.node))
  const chosenInto = new Set<string>()
  for (const step of flow) {
    if (!step.choices) continue
    const followUp = step.choices.followUp
    if (followUp && !nodes.has(followUp)) {
      throw new Error(`${step.node}.choices: followUp "${followUp}" is not a step of the flow`)
    }
    const route = (step.routes ?? []).find((r) => r.id === step.choices?.route)
    if (route) chosenInto.add(route.to)
  }
  for (const step of flow) {
    if (step.rechoose && !chosenInto.has(step.node)) {
      throw new Error(`${step.node}: rechoose, but no choices route leads here`)
    }
  }
}

/**
 * Turns the readable file into the composition the database would hold.
 *
 * `flowType` is inferred as a literal from the file, which is what narrows
 * `node` and `routes[].to` to the ids that flow type may use: an institute's
 * file that names `show_availability` does not compile.
 */
export function defineBusinessConfig<const F extends FlowType, const M extends string = never>(
  input: BusinessConfigInput<F, M>,
): BusinessConfig {
  checkChoiceSteps(input.flow)
  const overrides: Record<string, NodeOverride> = {}
  for (const step of input.flow) {
    const override = overrideOf(step)
    if (override) overrides[step.node] = override
  }
  return {
    businessId: input.businessId,
    name: input.name,
    flowType: input.flowType,
    composition: { nodes: input.flow.map((step) => step.node), overrides },
    settings: {
      ...(input.greeting !== undefined ? { greeting: input.greeting } : {}),
      ...(input.tone !== undefined ? { tone: input.tone } : {}),
      ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
      ...(input.collectData !== undefined ? { collectData: input.collectData } : {}),
      ...(input.requiresDeposit !== undefined ? { requiresDeposit: input.requiresDeposit } : {}),
      ...(input.handoff !== undefined ? { handoff: input.handoff } : {}),
    },
    fixedMessages: { ...(input.fixedMessages ?? {}) } as Record<string, FixedMessage>,
    ...(input.restartAfterHours !== undefined
      ? { restartAfterHours: input.restartAfterHours }
      : {}),
    ...(input.escalateWhen !== undefined ? { escalateWhen: input.escalateWhen } : {}),
    ...(input.earlyImages !== undefined ? { earlyImages: input.earlyImages } : {}),
    ...(input.leanPrompt !== undefined ? { leanPrompt: input.leanPrompt } : {}),
    ...(input.answers !== undefined ? { answers: [...input.answers] } : {}),
    // Compilados al cargar el archivo: una expresión inválida rompe al importar
    // (y en businesses.test), no a mitad de una conversación.
    ...(input.escalationGate !== undefined
      ? {
          escalationGate: {
            patterns: input.escalationGate.patterns.map((p) => new RegExp(p)),
            insistAfter: input.escalationGate.insistAfter,
          },
        }
      : {}),
    ...(input.ownerAssistant !== undefined ? { ownerAssistant: input.ownerAssistant } : {}),
    ...(input.audioReply !== undefined ? { audioReply: input.audioReply } : {}),
    ...(input.funnel !== undefined
      ? {
          funnel: input.funnel.map((stage) => ({
            label: stage.label,
            fixedMessages: [...stage.fixedMessages],
          })),
        }
      : {}),
    ...(input.whatsappLabels !== undefined
      ? { whatsappLabels: checkedLabels(input.whatsappLabels) }
      : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
  }
}
