// Lanza el corredor de leads (run.leads.ts) con vitest, y al final imprime las
// conversaciones legibles. Siempre por el guard de dev (ver package.json):
//
//   npm run qa:simulate -- --profiles G01,G02,A01 --runs 1
//   npm run qa:simulate -- --profiles all --runs 3 --concurrency 5
//   npm run qa:simulate -- --profiles cat:A,cat:C --runs 3
//
// Los logs del servidor (pino) van a <out>/server.log; el progreso, a la terminal.
import { execSync, spawn } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`)
  return i === -1 || argv[i + 1] === undefined ? fallback : argv[i + 1]
}

const profiles = flag('profiles', 'G01')
const runs = flag('runs', '1')
const concurrency = flag('concurrency', '5')
const mode = flag('mode', 'functional')
const stage = flag('stage', 'simulate')
const maxTurns = flag('max-turns', '15')

if (!/^[A-Za-z0-9:,]+$/.test(profiles)) {
  console.error('--profiles: lista de ids (G01,A01), cat:X, o "all"')
  process.exit(1)
}
if (!/^\d+$/.test(runs) || !/^\d+$/.test(concurrency) || !/^\d+$/.test(maxTurns)) {
  console.error('--runs, --concurrency y --max-turns son enteros')
  process.exit(1)
}
if (mode !== 'functional' && mode !== 'load') {
  console.error('--mode: functional | load')
  process.exit(1)
}

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')
const runId = `${stage}-${stamp}`
const outDir = join('qa', 'leads', 'out', runId)
mkdirSync(outDir, { recursive: true })

let git = 'desconocido'
try {
  const sha = execSync('git rev-parse --short HEAD').toString().trim()
  const dirty = execSync('git status --porcelain').toString().trim() !== ''
  git = dirty ? `${sha}+cambios-sin-commit` : sha
} catch {}

console.error(`[qa] corrida ${runId} → ${outDir}`)
const log = createWriteStream(join(outDir, 'server.log'))
const child = spawn('npx', ['vitest', 'run', '--config', 'vitest.leads.config.ts'], {
  shell: true,
  env: {
    ...process.env,
    QA_RUN_ID: runId,
    QA_OUT_DIR: outDir,
    QA_STAGE: stage,
    QA_MODE: mode,
    QA_PROFILES: profiles,
    QA_RUNS: runs,
    QA_CONCURRENCY: concurrency,
    QA_MAX_TURNS: maxTurns,
    QA_GIT: git,
  },
  stdio: ['ignore', 'pipe', 'inherit'],
})
child.stdout.pipe(log)
child.on('exit', (code) => {
  log.end()
  if (code !== 0) {
    console.error(`[qa] el corredor terminó con código ${code}. Ver ${join(outDir, 'server.log')}`)
    process.exit(code ?? 1)
  }
  const show = spawn('npx', ['tsx', 'qa/leads/transcript.ts', outDir], {
    shell: true,
    stdio: 'inherit',
  })
  show.on('exit', (c) => process.exit(c ?? 0))
})
