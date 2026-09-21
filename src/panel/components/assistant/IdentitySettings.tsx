import { useState } from 'react'
import type {
  AssistantFunction,
  AssistantGender,
  AssistantSettings,
  AssistantTone,
  PanelSettings,
} from '../../api/types.js'
import { useSectionSave } from '../../hooks/useSettings.js'
import { Field, SettingsCard } from '../config/SettingsCard.js'
import { Input } from '../ui/input.js'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select.js'
import { Textarea } from '../ui/textarea.js'

const GENDER_LABELS: Record<AssistantGender, string> = {
  femenino: 'Femenino',
  masculino: 'Masculino',
  neutro: 'Neutro',
}

const TONE_LABELS: Record<AssistantTone, string> = {
  formal: 'Formal (trata de usted)',
  amigable: 'Amigable (cercano y relajado)',
  profesional_cercano: 'Profesional cercano',
}

const FUNCTION_LABELS: Record<AssistantFunction, string> = {
  agenda: 'Agenda citas',
  vende: 'Vende',
  ambas: 'Ambas',
}

const FUNCTION_HINTS: Record<AssistantFunction, string> = {
  agenda: 'Solo con cita previa: Emma informa y reserva horarios.',
  vende: 'Sin agenda: Emma informa, cobra y toma los datos del cliente.',
  ambas: 'Atiende por orden de llegada y también reserva horarios.',
}

const FALLBACK_ASSISTANT: AssistantSettings = {
  name: 'Emma',
  gender: 'femenino',
  tone: 'profesional_cercano',
}

/**
 * Who Emma is for this business.
 *
 * Everything here is injected into the system prompt, and all of it is constant
 * between messages — so it lands in the cacheable half of that prompt and only
 * invalidates when this card is saved.
 *
 * The business's own name, address and timezone are NOT here: they are facts about
 * the business rather than about the assistant, the panel header and the calendar
 * read them, and they already have a form in Configuración. Two fields for one
 * fact is how they end up disagreeing.
 */
export function IdentitySettings({ data }: { data: PanelSettings }): React.JSX.Element {
  const { save, saving, saved, error } = useSectionSave()

  const stored = data.settings?.assistant ?? FALLBACK_ASSISTANT
  const storedFunction: AssistantFunction = data.assistantFunction ?? 'agenda'

  const [name, setName] = useState(stored.name)
  const [gender, setGender] = useState<AssistantGender>(stored.gender)
  const [tone, setTone] = useState<AssistantTone>(stored.tone)
  const [fn, setFn] = useState<AssistantFunction>(storedFunction)
  const [description, setDescription] = useState(stored.businessDescription ?? '')
  const [contact, setContact] = useState(stored.contactInfo ?? '')
  const [instructions, setInstructions] = useState(stored.customInstructions ?? '')

  const dirty =
    name !== stored.name ||
    gender !== stored.gender ||
    tone !== stored.tone ||
    fn !== storedFunction ||
    description !== (stored.businessDescription ?? '') ||
    contact !== (stored.contactInfo ?? '') ||
    instructions !== (stored.customInstructions ?? '')

  const onSave = (): void => {
    // The whole object every time: the server replaces `assistant` rather than
    // merging it field by field, so a partial would reset what it did not carry.
    // Empty strings are dropped so a cleared field means "no tengo esto" instead
    // of an empty line in the prompt.
    const trimmedDescription = description.trim()
    const trimmedContact = contact.trim()
    const trimmedInstructions = instructions.trim()

    save({
      section: 'identity',
      patch: {
        assistantFunction: fn,
        assistant: {
          name: name.trim(),
          gender,
          tone,
          ...(trimmedDescription ? { businessDescription: trimmedDescription } : {}),
          ...(trimmedContact ? { contactInfo: trimmedContact } : {}),
          ...(trimmedInstructions ? { customInstructions: trimmedInstructions } : {}),
        },
      },
    })
  }

  return (
    <SettingsCard
      title="Identidad"
      description="Quién es tu asistente y para qué está. El nombre y la dirección del negocio se editan en Configuración."
      onSave={onSave}
      saving={saving}
      saved={saved}
      error={error}
      dirty={dirty && name.trim().length > 0}
    >
      <Field
        label="Nombre del asistente"
        hint="Con este nombre se presenta a tus clientes."
        htmlFor="asst-name"
      >
        <Input
          id="asst-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={40}
          placeholder="Emma"
        />
      </Field>

      <Field label="Género" hint="Define cómo habla de sí misma." htmlFor="asst-gender">
        <Select value={gender} onValueChange={(v) => setGender(v as AssistantGender)}>
          <SelectTrigger id="asst-gender">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(GENDER_LABELS) as AssistantGender[]).map((value) => (
              <SelectItem key={value} value={value}>
                {GENDER_LABELS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field
        label="Tono"
        hint="Manda sobre el tono que trae el tipo de negocio."
        htmlFor="asst-tone"
      >
        <Select value={tone} onValueChange={(v) => setTone(v as AssistantTone)}>
          <SelectTrigger id="asst-tone">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(TONE_LABELS) as AssistantTone[]).map((value) => (
              <SelectItem key={value} value={value}>
                {TONE_LABELS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="Función" hint={FUNCTION_HINTS[fn]} htmlFor="asst-function">
        <Select value={fn} onValueChange={(v) => setFn(v as AssistantFunction)}>
          <SelectTrigger id="asst-function">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(FUNCTION_LABELS) as AssistantFunction[]).map((value) => (
              <SelectItem key={value} value={value}>
                {FUNCTION_LABELS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field
        label="Descripción del negocio"
        hint="Una o dos oraciones sobre qué hacen."
        htmlFor="asst-desc"
      >
        <Textarea
          id="asst-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={600}
          rows={3}
          placeholder="Clínica dental especializada en ortodoncia y estética dental."
        />
      </Field>

      <Field
        label="Datos de contacto"
        hint="Los comparte si se los piden. La dirección y el link de Maps ya salen de Configuración."
        htmlFor="asst-contact"
      >
        <Textarea
          id="asst-contact"
          value={contact}
          onChange={(e) => setContact(e.target.value)}
          maxLength={600}
          rows={3}
          placeholder="Segundo número: 999 888 777 · Instagram: @minegocio"
        />
      </Field>

      <Field
        label="Instrucciones adicionales"
        hint="Reglas tuyas. Ganan sobre el resto, salvo inventar precios u horarios o confirmar algo sin confirmar."
        htmlFor="asst-instructions"
      >
        <Textarea
          id="asst-instructions"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          maxLength={2000}
          rows={4}
          placeholder="No dar precios por WhatsApp, solo agendar la evaluación. Mencionar siempre la promo del mes."
        />
      </Field>
    </SettingsCard>
  )
}
