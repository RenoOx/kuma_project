import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))

// The panel is a separate build from the server: the server runs straight off
// tsx with no bundling, and this produces the static assets it serves from
// /panel. Keeping `root` inside src/panel is what lets index.html sit next to
// the code it loads instead of at the repo root.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: 'src/panel',
  // Assets are served from /panel/, not from the domain root, so every emitted
  // URL has to carry that prefix or the SPA 404s on its own JS.
  base: '/panel/',
  resolve: {
    alias: {
      '@panel': resolve(here, './src/panel'),
    },
  },
  build: {
    outDir: '../../dist/panel',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
})
