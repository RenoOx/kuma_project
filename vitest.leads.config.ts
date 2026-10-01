import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Configuración SOLO del test masivo de leads (qa/leads). Aparte de
// vitest.config.ts a propósito: ese corre en `npm test` y `npm run check`, y
// este llama a OpenAI con plata y escribe en la base de dev. Se corre con
// `npm run qa:simulate`, nunca solo.

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(here, './src'),
    },
  },
  test: {
    environment: 'node',
    include: ['qa/leads/run.leads.ts'],
    env: {
      NODE_ENV: 'test',
    },
    fileParallelism: false,
    // Una corrida completa son cientos de turnos.
    testTimeout: 6 * 60 * 60 * 1000,
    hookTimeout: 60_000,
  },
})
