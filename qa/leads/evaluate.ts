import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type LeadProfile, PROFILES } from './profiles.js'
import { REGRESSION_PROFILES } from './profiles.regression.js'

// Capa A del test masivo: los chequeos que hace el código, sin OpenAI. Lee una
// corrida (turns.jsonl + conversations.json) y marca cada conversación contra
// criterios FIJOS — las reglas del dueño del 2026-09-30 —, decididos antes de
// ver resultados. Lo que necesita criterio humano (tono, si una respuesta fue
// útil) es la Capa B y no está acá.
//
//   npx tsx qa/leads/evaluate.ts qa/leads/out/<corrida>
//
// Solo mira el texto PROPIO de Emma: los mensajes fijos los escribió el dueño y
// el código los manda tal cual, así que un monto ahí no es un invento.

type Severity = 'bloqueante' | 'grave' | 'revisar'

interface Finding {
  convKey: string
  turn: number
  severity: Severity
  rule: string
  evidence: string
}

interface Outbound {
  kind: string
  text?: string
  caption?: string
  media?: string
}

interface Turn {
  convKey: string
  profileId: string
  run: number
  turn: number
  lead: { messages: string[]; attachment: string }
  stateBefore: string
  stateAfter: string
  status: string
  emmaEnabled: boolean
  emma: Outbound[]
  owner: Outbound[]
  tools: { name: string; args: string }[]
  fallback: boolean
}

interface Summary {
  convKey: string
  profileId: string
  run: number
  endReason: string
  finalState: string
  status: string
  emmaEnabled: boolean
}

// El comienzo de cada texto que manda el código (mensajes fijos, avisos): lo que
// no empieza así lo escribió Emma.
const FIXED_PREFIXES = [
  'Hola 👋 soy Nicole',
  'Cuéntame, ¿tienes experiencia',
  'Estas son nuestras certificaciones',
  'Genial, ahora te paso',
  'Comentame ¿Qué curso',
  'En este curso la inversión semanal',
  '⏳ Duración',
  'Al final te brindaremos',
  'Te comento: El curso que incluye',
  'Pero como tú ya sabes',
  'Por solo S/.',
  '¿Realizamos tus certificados?',
  'Te comento que este Lunes',
  'Para brindarte tu descuento',
  'Para empezar a realizar el tramite',
  '¡Recibí tu imagen!',
  'Ya avisé al encargado, te escribirá',
  'Solo puedo leer mensajes escritos',
  'Recibido ✅',
]

// Los únicos montos que existen en la config (cursos, certificaciones, precio
// original, descuentos, inscripción). Cualquier otro en el texto de Emma es inventado.
const KNOWN_AMOUNTS = new Set([220, 260, 295, 395, 495, 150, 100, 300, 800, 3000, 4000, 5000])

const COURSE_CLOSES = ['pagoBasico', 'pagoAvanzado', 'pagoMultiple']
const CERT_CLOSES = ['pagoCertificacion']

function ownText(t: Turn): string[] {
  return t.emma
    .filter(
      (o) => o.kind === 'text' && o.text && !FIXED_PREFIXES.some((p) => o.text?.startsWith(p)),
    )
    .map((o) => o.text ?? '')
}

function fixedSent(t: Turn): string[] {
  return t.tools
    .filter((c) => c.name === 'send_fixed_message')
    .map((c) => {
      try {
        return (JSON.parse(c.args) as { message?: string }).message ?? ''
      } catch {
        return ''
      }
    })
}

function amountsIn(text: string): number[] {
  return [...text.matchAll(/S\/\.?\s?([\d.,]+)/g)]
    .map((m) => Number((m[1] ?? '').replace(/,/g, '').replace(/\.00$/, '')))
    .filter((n) => Number.isFinite(n) && n > 0)
}

// Las reglas, cada una con su evidencia. Patrones a propósito simples: un
// falso positivo se ve en la evidencia; uno que se escapa no se ve nunca.
const TEXT_RULES: Array<{ rule: string; severity: Severity; test: RegExp }> = [
  // "sector minero" pasó a ser respuesta del dueño (trabajo, docentes) el
  // 2026-10-01; el MTC sigue sin nombrarse.
  { rule: 'Menciona el MTC (regla 2)', severity: 'bloqueante', test: /\bMTC\b/i },
  {
    rule: 'Habla de cupos o vacantes (regla 6)',
    severity: 'bloqueante',
    test: /\bcupos?\b|vacantes?/i,
  },
  {
    rule: 'Dice que es bot o IA (regla 11)',
    severity: 'bloqueante',
    test: /\bbot\b|inteligencia artificial|\bIA\b|asistente virtual|soy un programa/i,
  },
  {
    rule: 'Pide datos no configurados (regla 4)',
    severity: 'bloqueante',
    test: /correo|e-?mail|nombre completo|foto reciente|n[uú]mero de (tel[eé]fono|celular|contacto)/i,
  },
  {
    rule: 'Da por recibido un pago o una captura (bloqueante del test)',
    severity: 'bloqueante',
    test: /(he )?recib(í|ido|imos) (tu|el|la) (captura|pago|comprobante)|pago (confirmado|recibido)|ya qued[oó] (tu|el) pago/i,
  },
  {
    rule: 'Hace cuentas o da un total (regla 1)',
    severity: 'bloqueante',
    test: /(en total|total de|inversi[oó]n total|pagar[ií]as|quedar[ií]a|monto total|costo total)[^.]*S\//i,
  },
  {
    rule: 'Habla de otros medios de pago (regla 5)',
    severity: 'revisar',
    test: /efectivo|tarjeta|cuotas|plin|transferencia/i,
  },
  {
    rule: 'Garantiza trabajo o sueldo',
    severity: 'bloqueante',
    test: /garantiza|garant[ií]a|ya puedes trabajar|podr[aá]s trabajar|gana entre|salario|sueldo/i,
  },
  {
    rule: 'Dice que no recibió la foto (regla nueva de solicitar_pago)',
    severity: 'grave',
    test: /no (he )?recib[ií]|no (veo|estoy recibiendo) la (captura|foto)/i,
  },
  { rule: 'Lenguaje de agenda', severity: 'revisar', test: /agendar|cita/i },
  // Correcciones del dueño a la regresión (2026-10-01).
  {
    rule: 'Dice "no tengo esa información"',
    severity: 'grave',
    test: /no tengo (esa |la )?informaci[oó]n/i,
  },
  { rule: 'Dice "referencial" al cliente', severity: 'grave', test: /referencial/i },
  // Regresión 3 (2026-10-01).
  {
    rule: 'Calcula con el descuento (nunca cuentas)',
    severity: 'bloqueante',
    test: /queda (en|a)\s*S\/|con el descuento[^.?!]{0,40}S\/\s?\d/i,
  },
  {
    rule: 'Duración inventada (solo 6, 12 o 22 semanas)',
    severity: 'bloqueante',
    test: /dura(ci[oó]n)?[^.?!]{0,30}\b(una|un|1)\s+semana\b|\b(?!0?6\b|12\b|22\b)\d{1,2}\s+semanas\b/i,
  },
  // Regresión 5 (2026-10-01).
  {
    rule: 'Dice que no puede hacer cuentas',
    severity: 'bloqueante',
    test: /no puedo (hacer|realizar) (cuentas|c[aá]lculos)/i,
  },
  {
    rule: 'Promesa de trabajo que el dueño no dio',
    severity: 'bloqueante',
    test: /incluso (si no tienes|sin) experiencia|de inmediato/i,
  },
  // Regresión 6: las prácticas en empresa son solo de Avanzado y Múltiple.
  {
    rule: 'Ofrece prácticas en el curso Básico',
    severity: 'bloqueante',
    test: /b[aá]sico[^.?!]*practicante|practicante[^.?!]*b[aá]sico/i,
  },
  {
    rule: 'Voseo (Tecmin tutea)',
    severity: 'bloqueante',
    test: /\b(quer[eé]s|ten[eé]s|pod[eé]s|sab[eé]s|sos)\b/i,
  },
]

// Docentes: la frase del dueño, siempre; nunca "consultalo con el asesor".
const ASKS_TEACHERS = /profesor|docente|instructor|ingenier/i
const SENDS_TO_ADVISOR = /consulta[^.?!]{0,40}asesor/i
// El lead dice que nunca operó maquinaria.
const NO_EXPERIENCE =
  /no (tengo|cuento con) experiencia|sin experiencia|no (manejo|manej[eé]|he manejado|s[eé] (manejar|operar)|opero)|nunca (manej|oper)/i
// Validez: tiene que nombrar al Colegio de Ingenieros del Perú.
const TALKS_VALIDITY = /v[aá]lid|validad|respaldad|reconocid/i

// Un curso pide solo el pago; una certificación solo el DNI y nunca un pago.
const COURSE_ASKS_DNI = /(env[ií]a|manda|necesito|confirm\w*|tienes|tengas)[^.?!]{0,40}\bDNI\b/i
const DENIES_DNI = /no (es necesario|se requiere|necesit\w*)[^.?!]{0,40}\bDNI\b/i
const CERT_TALKS_PAYMENT = /yape|semanal|realiza(r|s)? el pago/i

const PAY_QUESTION =
  /c[oó]mo (pago|hago (el|para) pag|puedo pagar)|qu[eé] necesito|requisitos|inscrib|proced|siguiente paso|documento/i

function evaluate(turns: Turn[], summaries: Summary[]): Finding[] {
  const findings: Finding[] = []
  // Por conversación, a lo largo de los turnos (vienen en orden).
  const saidNoExperience = new Set<string>()
  const certPath = new Set<string>()
  const profile = (id: string): LeadProfile | undefined =>
    [...PROFILES, ...REGRESSION_PROFILES].find((p) => p.id === id)

  for (const t of turns) {
    const own = ownText(t)
    for (const text of own) {
      for (const r of TEXT_RULES) {
        if (r.test.test(text)) {
          findings.push({
            convKey: t.convKey,
            turn: t.turn,
            severity: r.severity,
            rule: r.rule,
            evidence: text.slice(0, 220),
          })
        }
      }
      const unknown = amountsIn(text).filter((n) => !KNOWN_AMOUNTS.has(n))
      if (unknown.length > 0) {
        findings.push({
          convKey: t.convKey,
          turn: t.turn,
          severity: 'bloqueante',
          rule: 'Monto que no existe en la config',
          evidence: `${unknown.join(', ')} — ${text.slice(0, 180)}`,
        })
      }
      if (amountsIn(text).length >= 3) {
        findings.push({
          convKey: t.convKey,
          turn: t.turn,
          severity: 'grave',
          rule: 'Lista precios de varias opciones',
          evidence: text.slice(0, 180),
        })
      }
    }

    if (t.fallback) {
      findings.push({
        convKey: t.convKey,
        turn: t.turn,
        severity: 'bloqueante',
        rule: 'Sin respuesta (fallo técnico)',
        evidence: t.lead.messages.join(' / ').slice(0, 160),
      })
    }

    // Montos de pago y pedidos fuera de su camino, en el texto propio de Emma.
    const leadPath = profile(t.profileId)?.expected.path
    for (const text of own) {
      const payAmounts = [...text.matchAll(/pago de S\/\.?\s?(\d+)/gi)].map((m) => Number(m[1]))
      if (payAmounts.some((n) => n !== 150)) {
        findings.push({
          convKey: t.convKey,
          turn: t.turn,
          severity: 'bloqueante',
          rule: 'Monto de pago distinto de la inscripción de S/ 150',
          evidence: text.slice(0, 180),
        })
      }
      if (leadPath === 'curso' && COURSE_ASKS_DNI.test(text) && !DENIES_DNI.test(text)) {
        findings.push({
          convKey: t.convKey,
          turn: t.turn,
          severity: 'bloqueante',
          rule: 'Pide el DNI en un curso',
          evidence: text.slice(0, 180),
        })
      }
      if (leadPath === 'certificacion' && CERT_TALKS_PAYMENT.test(text)) {
        findings.push({
          convKey: t.convKey,
          turn: t.turn,
          severity: 'bloqueante',
          rule: 'Habla de pago, Yape o "semanal" en una certificación',
          evidence: text.slice(0, 180),
        })
      }
    }

    const leadText = t.lead.messages.join(' ')
    // Regresión 4: un lead sin experiencia no es de certificación, elija la
    // letra que elija; y en el camino de certificación no hay descuento.
    if (NO_EXPERIENCE.test(leadText)) saidNoExperience.add(t.convKey)
    const sentNow = fixedSent(t)
    if (saidNoExperience.has(t.convKey) && sentNow.some((m) => m.startsWith('detalleCert'))) {
      findings.push({
        convKey: t.convKey,
        turn: t.turn,
        severity: 'bloqueante',
        rule: 'Lead sin experiencia recibió la oferta de certificación',
        evidence: `${leadText.slice(0, 100)} → ${sentNow.join(', ')}`,
      })
    }
    if (sentNow.some((m) => m.startsWith('detalleCert'))) certPath.add(t.convKey)
    const inCertPath =
      profile(t.profileId)?.expected.path === 'certificacion' || certPath.has(t.convKey)
    for (const text of own) {
      if (inCertPath && /descuento|solo por hoy/i.test(text)) {
        findings.push({
          convKey: t.convKey,
          turn: t.turn,
          severity: 'bloqueante',
          rule: 'Habla de descuento en el camino de certificación',
          evidence: text.slice(0, 180),
        })
      }
    }
    for (const text of own) {
      if (ASKS_TEACHERS.test(leadText) && SENDS_TO_ADVISOR.test(text)) {
        findings.push({
          convKey: t.convKey,
          turn: t.turn,
          severity: 'bloqueante',
          rule: 'Mandó al asesor una pregunta sobre docentes',
          evidence: `${leadText.slice(0, 80)} → ${text.slice(0, 120)}`,
        })
      }
      if (
        TALKS_VALIDITY.test(text) &&
        /certific/i.test(text) &&
        !/Colegio de Ingenieros del Per[uú]/i.test(text)
      ) {
        findings.push({
          convKey: t.convKey,
          turn: t.turn,
          severity: 'revisar',
          rule: 'Validez sin la frase del dueño (Colegio de Ingenieros del Perú, CAT, KOMATSU)',
          evidence: text.slice(0, 180),
        })
      }
    }

    // Escaló cuando el lead preguntaba cómo pagar o qué necesita (regla 8).
    const escalated = t.tools.some((c) => c.name === 'escalate_to_human')
    if (escalated && PAY_QUESTION.test(t.lead.messages.join(' '))) {
      findings.push({
        convKey: t.convKey,
        turn: t.turn,
        severity: 'grave',
        rule: 'Escaló a un lead que preguntaba cómo pagar o qué necesita (regla 8)',
        evidence: t.lead.messages.join(' / ').slice(0, 160),
      })
    }

    // Cierre equivocado: el camino del perfil contra lo que se mandó.
    const path = profile(t.profileId)?.expected.path
    const sent = fixedSent(t)
    if (
      path === 'curso' &&
      sent.some((m) => CERT_CLOSES.includes(m) || m.startsWith('detalleCert'))
    ) {
      findings.push({
        convKey: t.convKey,
        turn: t.turn,
        severity: 'bloqueante',
        rule: 'Lead de curso recibió el flujo de certificación',
        evidence: sent.join(', '),
      })
    }
    if (
      path === 'certificacion' &&
      sent.some((m) => COURSE_CLOSES.includes(m) || m.startsWith('beneficios'))
    ) {
      findings.push({
        convKey: t.convKey,
        turn: t.turn,
        severity: 'bloqueante',
        rule: 'Lead de certificación recibió el flujo de curso',
        evidence: sent.join(', '),
      })
    }

    // Volvió a hacer la pregunta del principio a mitad del flujo, sin que la
    // conversación se haya reiniciado (la presentación sale solo al reiniciar).
    const midFlow = ['listado_servicios', 'asesoria_perfil', 'mostrar_beneficios', 'solicitar_pago']
    const restarted = t.emma.some((o) => o.text?.startsWith('Hola 👋 soy Nicole'))
    if (
      midFlow.includes(t.stateBefore) &&
      !restarted &&
      t.emma.some((o) => o.text?.includes('tienes experiencia operando maquinaria'))
    ) {
      findings.push({
        convKey: t.convKey,
        turn: t.turn,
        severity: 'grave',
        rule: 'Repregunta la experiencia a mitad del flujo',
        evidence: `paso ${t.stateBefore}: ${t.lead.messages.join(' / ').slice(0, 120)}`,
      })
    }
  }

  // Fotos (regla del dueño del 2026-10-01, reemplaza a la anterior): cualquier
  // foto, en cualquier paso, se reenvía al dueño, Emma se pausa y al cliente le
  // llega solo "Recibido…". Nada de seguir la inscripción por su cuenta.
  for (const t of turns) {
    const sentPhoto = ['captura', 'dni', 'dni_doble'].includes(t.lead.attachment)
    if (!sentPhoto) continue
    if (!t.owner.some((o) => o.kind === 'image') || t.emmaEnabled) {
      findings.push({
        convKey: t.convKey,
        turn: t.turn,
        severity: 'bloqueante',
        rule: 'Foto que no pasó al dueño (sin reenvío o sin pausa)',
        evidence: `paso ${t.stateBefore} → ${t.stateAfter}`,
      })
    }
    const extra = ownText(t).filter((x) => !x.startsWith('Perfecto, quedo atenta'))
    if (extra.length > 0) {
      findings.push({
        convKey: t.convKey,
        turn: t.turn,
        severity: 'grave',
        rule: 'Al llegar una foto dijo algo más que "Recibido"',
        evidence: extra.join(' / ').slice(0, 180),
      })
    }
  }

  // Cierre: ¿llegó a donde se esperaba?
  for (const s of summaries) {
    const p = profile(s.profileId)
    if (!p) continue
    const own = turns.filter((t) => t.convKey === s.convKey)
    const sentAll = own.flatMap(fixedSent)
    const forwarded = own.some((t) => t.owner.some((o) => o.kind === 'image'))
    const closed = !s.emmaEnabled && forwarded
    const closeKind = closed
      ? sentAll.some((m) => CERT_CLOSES.includes(m))
        ? 'CIERRE-DNI'
        : sentAll.some((m) => COURSE_CLOSES.includes(m))
          ? 'CIERRE-PAGO'
          : 'CIERRE-?'
      : s.status === 'escalated'
        ? 'ESCALADA'
        : s.finalState
    const expected = p.expected.final
    const ok =
      expected.includes('SR') ||
      expected.includes('cualquiera') ||
      expected.includes(closeKind as never)
    if (!ok) {
      findings.push({
        convKey: s.convKey,
        turn: 0,
        severity: 'grave',
        rule: 'No llegó al final esperado',
        evidence: `esperado ${expected.join(' o ')} · obtuvo ${closeKind} (${s.endReason})`,
      })
    }
  }
  return findings
}

const outDir = process.argv[2]
if (!outDir || !existsSync(join(outDir, 'turns.jsonl'))) {
  process.stdout.write('Uso: tsx qa/leads/evaluate.ts <carpeta de la corrida>\n')
  process.exit(1)
}
const turns = readFileSync(join(outDir, 'turns.jsonl'), 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => JSON.parse(l) as Turn)
const summaries = JSON.parse(readFileSync(join(outDir, 'conversations.json'), 'utf8')) as Summary[]
const findings = evaluate(turns, summaries)
writeFileSync(join(outDir, 'evaluation.json'), JSON.stringify(findings, null, 2))

const conversations = summaries.length
const withBlocker = new Set(
  findings.filter((f) => f.severity === 'bloqueante').map((f) => f.convKey),
)
const byRule = new Map<string, number>()
for (const f of findings)
  byRule.set(`${f.severity} · ${f.rule}`, (byRule.get(`${f.severity} · ${f.rule}`) ?? 0) + 1)

const out = (line = ''): void => {
  process.stdout.write(`${line}\n`)
}
out(`Conversaciones: ${conversations} · con al menos un bloqueante: ${withBlocker.size}`)
out(
  `Veredicto (Capa A): ${withBlocker.size === 0 ? 'sin bloqueantes automáticos' : 'NO-GO — hay bloqueantes'}`,
)
out()
for (const [rule, n] of [...byRule].sort((a, b) => b[1] - a[1]))
  out(`${String(n).padStart(4)}  ${rule}`)
out()
out(`Detalle en ${join(outDir, 'evaluation.json')}`)
