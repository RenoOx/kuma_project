import { useState } from 'react'
import type { ConfigurableMessages, PanelSettings } from '../../api/types.js'
import { useSectionSave } from '../../hooks/useSettings.js'
import { Field, SettingsCard } from '../config/SettingsCard.js'
import { Badge } from '../ui/badge.js'
import { Textarea } from '../ui/textarea.js'

type MessageKey = keyof ConfigurableMessages

interface MessageField {
  key: MessageKey
  label: string
  hint: string
  placeholder: string
  /** Stored and editable, but nothing reads it yet. Labelled so, not hidden. */
  soon?: boolean
}

// `hint` says whether the owner's exact words reach the customer or whether Emma
// rewrites them, because that is the difference they will notice first. The
// literal ones leave without the model seeing them; the guides steer a reply Emma
// still composes.
const FIELDS: MessageField[] = [
  {
    key: 'greeting',
    label: 'Saludo inicial',
    hint: 'Se envía tal cual al primer mensaje. Vacío = Emma usa sus saludos de siempre.',
    placeholder: '¡Hola! Soy Emma, asistente de {nombre_negocio}. ¿En qué puedo ayudarte?',
  },
  {
    key: 'farewell',
    label: 'Despedida',
    hint: 'Guía: Emma la adapta al cierre de la conversación.',
    placeholder: '¡Gracias por escribirnos a {nombre_negocio}! Te esperamos.',
  },
  {
    key: 'handoff',
    label: 'Derivación a humano',
    hint: 'Se envía tal cual cuando la conversación pasa a una persona.',
    placeholder: 'Te comunico con un asesor para que te ayude directamente. Un momento por favor.',
  },
  {
    key: 'outOfHours',
    label: 'Fuera de horario',
    hint: 'Guía, y solo si activás el horario de atención en la sección Flujo.',
    placeholder:
      'Estamos fuera de horario, pero ya tengo tu información. Te contactamos mañana a primera hora.',
  },
  {
    key: 'fallback',
    label: 'No entendí',
    hint: 'Guía: Emma la reformula según lo que el cliente escribió.',
    placeholder: 'Disculpá, no estoy segura de haber entendido. ¿Me lo contás de nuevo?',
  },
  {
    key: 'paymentReceived',
    label: 'Comprobante recibido',
    hint: 'Se envía tal cual cuando llega la captura y queda en verificación.',
    placeholder: '¡Recibí tu comprobante! Estoy verificando el pago, te confirmo en breve.',
  },
  {
    key: 'paymentRejected',
    label: 'Pago rechazado',
    hint: 'Se envía tal cual cuando rechazás un comprobante.',
    placeholder: 'Hubo un inconveniente con tu pago. ¿Me lo reenviás?',
  },
  {
    key: 'paymentApproved',
    label: 'Pago aprobado',
    hint: 'La confirmación actual lleva la fecha y hora reales de la cita, así que todavía manda esa.',
    placeholder: '¡Tu pago quedó verificado! Continuemos.',
    soon: true,
  },
  {
    key: 'reminder24h',
    label: 'Recordatorio 24h antes',
    hint: 'Los recordatorios siguen usando el texto actual de Emma.',
    placeholder:
      'Hola {nombre_cliente}, te recordamos que mañana tenés cita en {nombre_negocio} a las {hora}.',
    soon: true,
  },
  {
    key: 'reminder2h',
    label: 'Recordatorio 2h antes',
    hint: 'Los recordatorios siguen usando el texto actual de Emma.',
    placeholder: '¡Nos vemos pronto! Tu cita en {nombre_negocio} es en 2 horas ({hora}).',
    soon: true,
  },
]

function toDraft(messages: ConfigurableMessages | undefined): Record<MessageKey, string> {
  const out = {} as Record<MessageKey, string>
  for (const field of FIELDS) out[field.key] = messages?.[field.key] ?? ''
  return out
}

/**
 * The owner's wording for the moments Emma has a line for.
 *
 * Every field is optional and an empty one means "use what Emma already says" —
 * never "answer with nothing". That is what makes this safe to ship to businesses
 * that never open it: until a textarea has text in it, nothing about their bot
 * changes.
 */
export function MessagesSettings({ data }: { data: PanelSettings }): React.JSX.Element {
  const { save, saving, saved, error } = useSectionSave()

  const stored = data.settings?.messages
  const [draft, setDraft] = useState<Record<MessageKey, string>>(() => toDraft(stored))

  const dirty = FIELDS.some((field) => draft[field.key] !== (stored?.[field.key] ?? ''))

  const onSave = (): void => {
    // Emptied fields are omitted rather than sent as '': the server reads an
    // absent key as "fall back to the built-in wording", which is exactly what
    // clearing a textarea is asking for.
    const messages: ConfigurableMessages = {}
    for (const field of FIELDS) {
      const value = draft[field.key].trim()
      if (value) messages[field.key] = value
    }
    save({ section: 'messages', patch: { messages } })
  }

  return (
    <SettingsCard
      title="Mensajes"
      description="Qué dice Emma en los momentos clave. Dejá uno vacío y usa su texto de siempre."
      onSave={onSave}
      saving={saving}
      saved={saved}
      error={error}
      dirty={dirty}
      readOnly
    >
      <p className="text-muted-foreground text-xs">
        Podés usar <code>{'{nombre_negocio}'}</code>, <code>{'{nombre_cliente}'}</code>,{' '}
        <code>{'{hora}'}</code>, <code>{'{fecha}'}</code> y <code>{'{servicio}'}</code>. Si en ese
        momento no hay dato para una, se quita sola — escribí el mensaje de modo que igual se lea
        bien.
      </p>

      {FIELDS.map((field) => (
        <Field key={field.key} label={field.label} hint={field.hint} htmlFor={`msg-${field.key}`}>
          <div className="flex flex-col gap-1.5">
            {field.soon && (
              <Badge variant="secondary" className="w-fit text-[10px]">
                Próximamente
              </Badge>
            )}
            <Textarea
              id={`msg-${field.key}`}
              value={draft[field.key]}
              onChange={(e) => setDraft({ ...draft, [field.key]: e.target.value })}
              maxLength={600}
              rows={2}
              placeholder={field.placeholder}
            />
          </div>
        </Field>
      ))}
    </SettingsCard>
  )
}
