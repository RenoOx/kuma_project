import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Las conversaciones de una corrida, legibles: cada turno con lo que escribió el
// lead, el paso antes → después, lo que mandó Emma (textos y fotos), lo que le
// llegó al dueño y las herramientas que llamó. Escribe <out>/transcript.txt y lo
// imprime.
//
//   npx tsx qa/leads/transcript.ts qa/leads/out/<corrida>

interface Outbound {
  kind: string
  text?: string
  caption?: string
  media?: string
  error?: string
}

interface Turn {
  convKey: string
  turn: number
  lead: { messages: string[]; attachment: string; end: string; note: string }
  stateBefore: string
  stateAfter: string
  status: string
  emmaEnabled: boolean
  tags: string[]
  emma: Outbound[]
  owner: Outbound[]
  tools: { name: string; args: string }[]
  toolResults: string[]
  fallback: boolean
  gapHours?: number
  error?: string
  durationMs: number
}

interface Summary {
  convKey: string
  endReason: string
  finalState: string
  status: string
  emmaEnabled: boolean
  tags: string[]
  usage: { emma: { usd: number; calls: number }; lead: { usd: number } }
}

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((l, i) => (i === 0 ? l : `${prefix}${l}`))
    .join('\n')
}

function outbound(o: Outbound): string {
  const err = o.error ? `  ✗ ${o.error}` : ''
  if (o.kind === 'text') return `${indent(o.text ?? '', '             ')}${err}`
  const caption = o.caption ? `\n             pie: ${indent(o.caption, '                  ')}` : ''
  return `[${o.kind}: ${o.media ?? 'sin origen'}]${caption}${err}`
}

const outDir = process.argv[2]
if (!outDir || !existsSync(join(outDir, 'turns.jsonl'))) {
  process.stdout.write('Uso: tsx qa/leads/transcript.ts <carpeta de la corrida>\n')
  process.exit(1)
}

const turns = readFileSync(join(outDir, 'turns.jsonl'), 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => JSON.parse(l) as Turn)
const summaries: Summary[] = existsSync(join(outDir, 'conversations.json'))
  ? (JSON.parse(readFileSync(join(outDir, 'conversations.json'), 'utf8')) as Summary[])
  : []

const lines: string[] = []
const keys = [...new Set(turns.map((t) => t.convKey))].sort()
for (const key of keys) {
  const s = summaries.find((x) => x.convKey === key)
  lines.push('', `════ ${key} ════`)
  for (const t of turns.filter((x) => x.convKey === key).sort((a, b) => a.turn - b.turn)) {
    lines.push('')
    if (t.gapHours) lines.push(`   ⏱  pasaron ${t.gapHours} horas`)
    const said = [
      ...t.lead.messages,
      ...(t.lead.attachment !== 'none' ? [`[${t.lead.attachment}]`] : []),
    ]
    lines.push(`t${t.turn}  LEAD: ${said.join('  /  ') || '(nada)'}`)
    lines.push(
      `     paso: ${t.stateBefore} → ${t.stateAfter}${t.status !== 'open' ? `  · ${t.status}` : ''}${t.emmaEnabled ? '' : '  · EMMA PAUSADA'}${t.tags.length ? `  · etiquetas: ${t.tags.join(', ')}` : ''}  (${(t.durationMs / 1000).toFixed(1)} s)`,
    )
    if (t.emma.length === 0) lines.push('     EMMA: (no respondió)')
    for (const o of t.emma) lines.push(`     EMMA: ${outbound(o)}`)
    for (const o of t.owner) lines.push(`     → DUEÑO: ${outbound(o)}`)
    if (t.tools.length)
      lines.push(`     herramientas: ${t.tools.map((c) => `${c.name} ${c.args}`).join(' | ')}`)
    if (t.fallback) lines.push('     ⚠ respuesta de error ("algo no salió bien")')
    if (t.error) lines.push(`     ⚠ error del arnés: ${t.error}`)
  }
  if (s) {
    lines.push(
      '',
      `   FIN: ${s.endReason} · paso final ${s.finalState} · ${s.status}${s.emmaEnabled ? '' : ' · Emma pausada'}${s.tags.length ? ` · ${s.tags.join(', ')}` : ''} · costo Emma $${s.usage.emma.usd.toFixed(4)} (${s.usage.emma.calls} llamadas) + lead $${s.usage.lead.usd.toFixed(4)}`,
    )
  }
}

const text = lines.join('\n')
writeFileSync(join(outDir, 'transcript.txt'), text)
process.stdout.write(`${text}\n`)
