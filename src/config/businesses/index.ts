import type { BusinessConfig } from './define.js'
// Every business whose conversation is managed from the repo, one line each.
//
// Listed by hand rather than discovered from the folder: an import here is what
// makes the typecheck and businesses.test.ts cover the file, and a file that is
// missing from this list is visible at a glance instead of silently not loading.
//
// To add one: copy _plantilla.ts, fill it from `npm run business:show:dev -- <id>`
// so it starts identical to what runs today, and import it below.
import institutoTecmin from './instituto-tecmin.js'
import institutoTestia from './instituto-testia.js'

export const BUSINESS_CONFIGS: ReadonlyArray<BusinessConfig> = [institutoTestia, institutoTecmin]

// Versiones en prueba (cada una con su bloque `test`): WhatsApp nunca las corre,
// solo la pestaña "Pruebas" del panel cuando alguien la elige. Un negocio puede
// tener varias; para publicar una, reemplaza al archivo de arriba.
export const TEST_CONFIGS: ReadonlyArray<BusinessConfig> = []
