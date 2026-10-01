import { openai } from '@/modules/llm/openai.client.js'
import { type Attachment, type LeadProfile, STYLE_GUIDE } from './profiles.js'

// El lead simulado: gpt-4o-mini haciendo de persona real que escribió por un
// anuncio. Lee la conversación como la ve en su teléfono (textos, "[foto]",
// pies de foto) y decide su próximo turno según su perfil. La semilla del
// perfil + el número de corrida hacen que una regresión pueda repetir el mismo
// lead (OpenAI la respeta "en lo posible", no garantiza determinismo).

export type TranscriptEntry =
  | { from: 'lead'; text: string }
  | { from: 'lead'; attachment: Attachment }
  | { from: 'emma'; text: string }
  | { from: 'emma'; photo: string | null }
  | { from: 'system'; note: string }

export interface LeadTurn {
  messages: string[]
  attachment: Attachment | 'none'
  end: 'continue' | 'done' | 'abandon'
  note: string
}

const MODEL = 'gpt-4o-mini'

function render(transcript: TranscriptEntry[]): string {
  return transcript
    .map((e) => {
      if (e.from === 'system') return `(${e.note})`
      if (e.from === 'lead') return 'text' in e ? `TÚ: ${e.text}` : `TÚ: [mandaste ${e.attachment}]`
      if ('text' in e) return `ASESORA: ${e.text}`
      return `ASESORA: [foto${e.photo ? `: ${e.photo}` : ''}]`
    })
    .join('\n')
}

function systemPrompt(profile: LeadProfile, turn: number, maxTurns: number): string {
  const allowed = profile.attachments.length > 0 ? profile.attachments.join(', ') : 'ninguno'
  return [
    'Eres una persona real en Perú escribiendo por WhatsApp a un instituto de maquinaria pesada en Huancayo, después de ver un anuncio en Facebook.',
    'NO eres un asistente ni una IA: nunca lo digas, nunca ayudes a la asesora, nunca escribas como un chatbot. Escribe como escribe la gente de verdad en WhatsApp.',
    '',
    `TU PERFIL: ${profile.persona}`,
    '',
    `CÓMO ESCRIBES: ${STYLE_GUIDE[profile.style]}`,
    '',
    'REGLAS:',
    '- Responde solo a lo que la asesora te dijo y a lo que tu perfil quiere. No inventes datos del instituto.',
    `- Adjuntos que puedes mandar: ${allowed}. Mándalos SOLO cuando tu perfil lo indique. "dni_doble" = frente y reverso del DNI.`,
    '- Si mandas un adjunto, "messages" puede quedar vacío o llevar un texto corto.',
    '- end = "done" cuando ya lograste lo que querías o ya mandaste lo que te pidieron y no tienes nada más que decir; "abandon" si te aburres, te molestas o no te sirve; si no, "continue".',
    '- Si la asesora te acaba de pedir algo que tu perfil dice que mandas (captura, DNI), NO termines: mándalo en este turno.',
    '- Si end es "done" o "abandon", "messages" puede llevar tu despedida (o quedar vacío).',
    '- Si la asesora no te respondió, puedes insistir una vez o irte.',
    `- Este es tu turno ${turn} de ${maxTurns} como máximo.`,
    '- "note": en 5 a 10 palabras, qué intentas en este turno (para el registro; la asesora no lo ve).',
  ].join('\n')
}

const RESPONSE_FORMAT = {
  type: 'json_schema' as const,
  json_schema: {
    name: 'lead_turn',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['messages', 'attachment', 'end', 'note'],
      properties: {
        messages: { type: 'array', items: { type: 'string' } },
        attachment: {
          type: 'string',
          enum: ['none', 'captura', 'dni', 'dni_doble', 'audio', 'sticker', 'pdf_voucher'],
        },
        end: { type: 'string', enum: ['continue', 'done', 'abandon'] },
        note: { type: 'string' },
      },
    },
  },
}

export async function nextLeadTurn(params: {
  profile: LeadProfile
  transcript: TranscriptEntry[]
  turn: number
  maxTurns: number
  seed: number
}): Promise<LeadTurn> {
  const { profile, transcript, turn, maxTurns, seed } = params
  const completion = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0.9,
    seed,
    max_tokens: 400,
    response_format: RESPONSE_FORMAT,
    messages: [
      { role: 'system', content: systemPrompt(profile, turn, maxTurns) },
      {
        role: 'user',
        content: `La conversación hasta ahora:\n\n${render(transcript)}\n\nEscribe tu próximo turno.`,
      },
    ],
  })
  const raw = completion.choices[0]?.message.content ?? '{}'
  const parsed = JSON.parse(raw) as Partial<LeadTurn>
  const attachment = parsed.attachment ?? 'none'
  return {
    messages: (parsed.messages ?? []).map((m) => m.trim()).filter((m) => m !== ''),
    // Un adjunto fuera de su perfil no se manda: el perfil manda sobre el modelo.
    attachment:
      attachment !== 'none' && !profile.attachments.includes(attachment) ? 'none' : attachment,
    end: parsed.end ?? 'continue',
    note: parsed.note ?? '',
  }
}
