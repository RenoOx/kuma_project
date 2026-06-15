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
    // Tests share a single Postgres DB; serialize them to avoid races
    // on TRUNCATE/seed between concurrent test files.
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
})
