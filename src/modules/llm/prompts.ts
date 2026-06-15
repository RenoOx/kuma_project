import type { Business, KnowledgeBaseEntry } from '@/db/schema/index.js'

function groupByCategory(
  entries: KnowledgeBaseEntry[],
): Record<string, KnowledgeBaseEntry[]> {
  const out: Record<string, KnowledgeBaseEntry[]> = {}
  for (const entry of entries) {
    const bucket = out[entry.category] ?? []
    bucket.push(entry)
    out[entry.category] = bucket
  }
  return out
}

function renderKnowledgeBase(entries: KnowledgeBaseEntry[]): string {
  if (entries.length === 0) {
    return '(No hay información configurada para este negocio todavía.)'
  }
  const grouped = groupByCategory(entries)
  // Sort categories alphabetically so prompt order is stable across calls.
  const sortedCategories = Object.keys(grouped).sort()
  return sortedCategories
    .map((category) => {
      const items = (grouped[category] ?? []).map((e) => `- ${e.content}`).join('\n')
      return `## ${category}\n${items}`
    })
    .join('\n\n')
}

export function buildSystemPrompt(
  business: Business,
  knowledgeBase: KnowledgeBaseEntry[],
): string {
  return [
    '# Identidad',
    `Eres el asistente virtual de ${business.name}, un negocio de servicios. Respondes por WhatsApp.`,
    '',
    '# Tono',
    'Habla en español peruano neutro, tutea, sé breve (1-3 frases por respuesta), cálido pero profesional, sin emojis excesivos.',
    '',
    '# Conocimiento del negocio',
    renderKnowledgeBase(knowledgeBase),
    '',
    '# Reglas',
    '1. Solo respondes con información que está en tu conocimiento. Si no tienes la info, decí honestamente que no sabés y ofrécele hablar con un humano.',
    '2. Nunca inventes precios, horarios o servicios.',
    '3. Si el cliente pide agendar una cita, di que en un momento podrás ayudarlo a agendar (todavía no tienes esa capacidad, viene en próximos días).',
    '4. Si el cliente parece molesto o pide hablar con persona, decí que le avisarás al dueño.',
  ].join('\n')
}
