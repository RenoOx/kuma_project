import type { BusinessSettings, FlowType } from '@/modules/business/business.settings.js'
import type { ImageHandling, NodeIdFor } from '@/modules/conversation/nodeCatalog.js'
import type { FlowComposition, NodeOverride } from '@/modules/conversation/stateMachine.js'
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
}

export interface BusinessConfig {
  businessId: string
  name: string
  flowType: FlowType
  composition: FlowComposition
  settings: BusinessSettingsOverlay
  fixedMessages: Record<string, FixedMessage>
  restartAfterHours?: number
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
  }
  return Object.keys(override).length > 0 ? override : null
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
    },
    fixedMessages: { ...(input.fixedMessages ?? {}) } as Record<string, FixedMessage>,
    ...(input.restartAfterHours !== undefined
      ? { restartAfterHours: input.restartAfterHours }
      : {}),
  }
}
