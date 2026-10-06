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

/** Los mensajes fijos que pidió la IA en ese turno (send_fixed_message). */
function fixedSent(turn: SimulatorTurn | undefined): string[] {
  return (turn?.tools ?? [])
    .filter((t) => t.name === 'send_fixed_message' && !t.error)
    .map((t) => String((t.args as { message?: unknown }).message))
}

function expectOption(turn: SimulatorTurn | undefined, key: string, from: string): string | null {
  if (turn?.stateBefore !== from)
    return `se esperaba estar en ${from}, estaba en ${turn?.stateBefore}`
  const got = chosen(turn)
  if (got !== key) return `se esperaba la opción ${key}, salió ${got ?? 'ninguna'}`
  if (turn.stateAfter !== 'mostrar_beneficios') return `no pasó a beneficios (${turn.stateAfter})`
  return null
}

function expectPayment(turn: SimulatorTurn | undefined, message: string): string | null {
  if (turn?.stateAfter !== 'solicitar_pago')
    return `no llegó a solicitar_pago (${turn?.stateAfter})`
  if (!fixedSent(turn).includes(message))
    return `no salió ${message} (${fixedSent(turn).join(', ') || 'nada'})`
  return null
}

const CASES: Case[] = [
  {
    name: 'retro + minicargador → certificación A → DNI',
    messages: ['Hola', 'Tengo experiencia', 'retroexcavadora y minicargador', 'sí'],
    check: (t) =>
      expectOption(t[2], 'A', 'asesoria_perfil') ?? expectPayment(t[3], 'pagoCertificacion'),
  },
  {
    name: '"B" → certificación B sin la IA → DNI',
    messages: ['Hola', 'Tengo experiencia', 'B', 'sí'],
    check: (t) =>
      expectOption(t[2], 'B', 'asesoria_perfil') ??
      (t[2]?.tokens.input !== 0 ? `"B" pasó por la IA (${t[2]?.tokens.input} tokens)` : null) ??
      expectPayment(t[3], 'pagoCertificacion'),
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
    name: 'sin experiencia → "el básico" → curso A → pago',
    messages: ['Hola', 'No tengo exp', 'el básico', 'sí'],
    check: (t) => expectOption(t[2], 'A', 'listado_servicios') ?? expectPayment(t[3], 'pagoBasico'),
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
          error = `error ${r.error.code} en "${message}"`
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
