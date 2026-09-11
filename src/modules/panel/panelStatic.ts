import { existsSync } from 'node:fs'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { logger } from '@/config/logger.js'

// Serves the Vite build of the panel SPA. Mounted AFTER every API route so a
// path like /api/panel/... never reaches the static handler.
//
// Not express.static: this server is Hono, and @hono/node-server ships its own
// static middleware. Paths here are relative to the process cwd, which on
// Railway is the repo root.
export const panelStaticRoutes = new Hono()

const PANEL_DIST = './dist/panel'

// A deploy that skipped `npm run build:panel` would otherwise answer every
// panel URL with a blank 404 and no clue why. One line at boot is cheaper than
// debugging that from a screenshot.
if (!existsSync(PANEL_DIST)) {
  logger.warn(
    { dir: PANEL_DIST },
    'panel build not found — /panel will 404 until `npm run build:panel` runs',
  )
}

// Hashed assets under /panel/assets/*, plus anything else Vite emitted.
panelStaticRoutes.use(
  '/panel/*',
  serveStatic({
    root: PANEL_DIST,
    rewriteRequestPath: (path) => path.replace(/^\/panel/, ''),
  }),
)

// SPA fallback. The panel's real URL is /panel/:businessId?token=…, which is a
// client-side route with no file behind it, so every non-asset path under
// /panel has to return index.html and let React Router read the URL.
panelStaticRoutes.get('/panel', (c) => c.redirect('/panel/'))
panelStaticRoutes.get(
  '/panel/*',
  serveStatic({
    root: PANEL_DIST,
    path: 'index.html',
  }),
)
