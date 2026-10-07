import {
  newSessionId,
  type SimulatorTurn,
  sendMessage,
} from '@/modules/simulator/simulator.service.js'

// Prueba fija de Tecmin: chats con mensajes ya escritos, de punta a punta, por
// el simulador (capas 4-5: nunca envía nada por WhatsApp). Solo contra dev: el
// comando pasa por guard-db-env. Antes de cada cambio en el archivo de Tecmin,
// para que un arreglo no rompa otro caso.
//
// Uso: npm run qa:tecmin [-- --runs 3]
// Antes, para que dev sea igual a prod:
//   npm run business:clone:dev -- 33doLX_tC9vrVnaJVfLvZ

const TECMIN = '33doLX_tC9vrVnaJVfLvZ'

interface Case {
  name: string
  messages: string[]
  /** Devuelve null si pasó, o qué falló. */
  check: (turns: SimulatorTurn[]) => string | null
}

/** La opción que eligió elegir_opcion en ese turno, o null. */
function chosen(turn: SimulatorTurn | undefined): string | null {
  const call = turn?.tools.find((t) => t.name === 'elegir_opcion' && !t.error)
  if (!call) return null
  try {
    return (JSON.parse(call.result) as { option?: string }).option ?? null
  } catch {
    return null
  }
}

/** El texto de todos los mensajes fijos que le llegaron al cliente en ese turno. */
function fixedTexts(turn: SimulatorTurn | undefined): string {
  return (turn?.fixedMessages ?? []).map((m) => m.text).join('\n')
}

function expectOption(turn: SimulatorTurn | undefined, key: string, from: string): string | null {
  if (turn?.stateBefore !== from)
    return `se esperaba estar en ${from}, estaba en ${turn?.stateBefore}`
  const got = chosen(turn)
  if (got !== key) return `se esperaba la opción ${key}, salió ${got ?? 'ninguna'}`
  if (turn.stateAfter !== 'mostrar_beneficios') return `no pasó a beneficios (${turn.stateAfter})`
  return null
}

/** El pedido de pago o de DNI: lo manda el código, así que se revisa por su texto. */
function expectPayment(
  turn: SimulatorTurn | undefined,
  mustInclude: string,
  mustNotInclude?: string,
): string | null {
  if (turn?.stateAfter !== 'solicitar_pago')
    return `no llegó a solicitar_pago (${turn?.stateAfter})`
  const text = fixedTexts(turn)
  if (!text.includes(mustInclude)) return `el pago no dice "${mustInclude}": "${text.slice(0, 80)}"`
  if (mustNotInclude && text.includes(mustNotInclude))
    return `el pago dice "${mustNotInclude}" (de otra opción)`
  return null
}

/** Sin la IA: el turno no gastó tokens (la letra la resolvió el código). */
function withoutModel(turn: SimulatorTurn | undefined, what: string): string | null {
  return turn?.tokens.input !== 0 ? `${what} pasó por la IA (${turn?.tokens.input} tokens)` : null
}

const DNI = 'foto de tu DNI'

const CASES: Case[] = [
  {
    name: 'retro + minicargador → certificación A → DNI',
    messages: ['Hola', 'Tengo experiencia', 'retroexcavadora y minicargador', 'sí'],
    check: (t) => expectOption(t[2], 'A', 'asesoria_perfil') ?? expectPayment(t[3], DNI),
  },
  {
    name: '"B" → certificación B sin la IA → DNI',
    messages: ['Hola', 'Tengo experiencia', 'B', 'sí'],
    check: (t) =>
      expectOption(t[2], 'B', 'asesoria_perfil') ??
      withoutModel(t[2], '"B"') ??
      expectPayment(t[3], DNI),
  },
  {
    name: '3 máquinas → certificación B',
    messages: ['Hola', 'Tengo experiencia', 'excavadora, cargador y retroexcavadora'],
    check: (t) => expectOption(t[2], 'B', 'asesoria_perfil'),
  },
  {
    name: '"¿certificado de experiencia?" → es la certificación → A',
    messages: ['Hola', 'Tengo experiencia', '¿dan certificado de experiencia?', 'A'],
    check: (t) => {
      const reply = (t[2]?.reply ?? '').toLowerCase()
      if (reply.includes('conseguir trabajo')) return 'respondió lo del trabajo'
      if (!reply.includes('experiencia'))
        return `no respondió que es por experiencia: "${t[2]?.reply}"`
      return expectOption(t[3], 'A', 'asesoria_perfil')
    },
  },
  {
    name: 'sin experiencia → "el básico" → curso A → pago del Básico',
    messages: ['Hola', 'No tengo exp', 'el básico', 'sí'],
    check: (t) =>
      expectOption(t[2], 'A', 'listado_servicios') ?? expectPayment(t[3], 'descuento de S/ 100'),
  },
  {
    name: 'sin experiencia → "C" es un CURSO, no una certificación',
    messages: ['Hola', 'No tengo exp', 'C'],
    check: (t) => expectOption(t[2], 'C', 'listado_servicios'),
  },
  {
    name: 'pide cursos en el primer mensaje → cursos directo',
    messages: ['Hola buenas noches información de los cursos de maquinaria pesada'],
    check: (t) =>
      t[0]?.stateAfter !== 'listado_servicios'
        ? `no fue a cursos (${t[0]?.stateAfter})`
        : (t[0]?.attachments.length ?? 0) < 3
          ? `llegaron ${t[0]?.attachments.length} fichas, no 3`
          : null,
  },
  {
    name: 'corrige con una letra: A → "B" (sin la IA)',
    messages: ['Hola', 'Tengo experiencia', 'A', 'B'],
    check: (t) =>
      expectOption(t[2], 'A', 'asesoria_perfil') ??
      expectOption(t[3], 'B', 'mostrar_beneficios') ??
      withoutModel(t[3], '"B"') ??
      (fixedTexts(t[3]).includes('3 a 4') ? null : 'la oferta nueva no dice "3 a 4"'),
  },
  {
    name: 'corrige con palabras: A → "mejor la de 3 a 4" → DNI',
    messages: ['Hola', 'Tengo experiencia', 'A', 'mejor la de 3 a 4', 'sí'],
    check: (t) => expectOption(t[3], 'B', 'mostrar_beneficios') ?? expectPayment(t[4], DNI),
  },
  {
    name: 'curso A → "sí" → pago del Básico',
    messages: ['Hola', 'No tengo exp', 'A', 'sí'],
    check: (t) => expectPayment(t[3], 'descuento de S/ 100', 'descuento de S/ 800'),
  },
  {
    name: 'curso C → "sí" → pago de Operación Múltiple, nunca el del Básico',
    messages: ['Hola', 'No tengo exp', 'C', 'sí'],
    check: (t) => expectPayment(t[3], 'descuento de S/ 800', 'descuento de S/ 100'),
  },
  {
    name: 'la oferta dice qué opción es',
    messages: ['Hola', 'Tengo experiencia', 'B'],
    check: (t) =>
      fixedTexts(t[2]).includes('3 a 4 maquinarias')
        ? null
        : `la oferta no nombra la opción: "${fixedTexts(t[2]).slice(0, 60)}"`,
  },
]

function runsArg(): number {
  const i = process.argv.indexOf('--runs')
  const n = i >= 0 ? Number(process.argv[i + 1]) : 3
  return Number.isInteger(n) && n > 0 && n <= 10 ? n : 3
}

async function main(): Promise<void> {
  const runs = runsArg()
  let failed = 0
  for (const c of CASES) {
    const results: string[] = []
    for (let run = 0; run < runs; run++) {
      const session = newSessionId()
      const turns: SimulatorTurn[] = []
      let error: string | null = null
      for (const message of c.messages) {
        const r = await sendMessage(TECMIN, session, message)
        if (!r.ok) {
          error = `error ${r.error.code} en "${message}": ${String(r.error.message).slice(0, 120)}`
          break
        }
        turns.push(r.data)
      }
      const problem = error ?? c.check(turns)
      results.push(problem ? `✗ ${problem}` : '✓')
      if (problem) failed++
    }
    const ok = results.filter((r) => r === '✓').length
    process.stdout.write(`${ok === runs ? '✅' : '❌'} ${ok}/${runs}  ${c.name}\n`)
    for (const r of results) if (r !== '✓') process.stdout.write(`      ${r}\n`)
  }
  process.stdout.write(failed === 0 ? '\nTodo en verde.\n' : `\n${failed} corridas fallaron.\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`)
  process.exit(1)
})
