import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(here, './src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    env: {
      NODE_ENV: 'test',
    },
    // No test touches a database any more, so files are free to run in
    // parallel. Restore fileParallelism: false if DB-backed tests come back.
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
})
