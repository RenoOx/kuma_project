# Kuma — Contexto para Claude Code

## Qué es este repo

Kuma es un asistente de WhatsApp multi-tenant por Vamvu Labs, para negocios 
de servicios con citas (peluquerías, dentales, vets, barberías). Cada 
`business_id` tiene su knowledge base, su número de WhatsApp, sus clientes 
y citas. Un solo deploy atiende N negocios.

## Identidad del producto

- Nombre: Kuma (熊, "oso" en japonés)
- Empresa: Vamvu Labs
- Tono del bot al usuario final: cálido pero profesional, breve, sin emojis 
  excesivos, tutea en español de Perú neutro
- Tono del producto al dueño del negocio: utilitario, métricas claras, 
  sin paja

## Stack

- Runtime: Node.js 20+
- Lang: TypeScript estricto (`strict: true` en tsconfig)
- API: Hono
- DB: PostgreSQL 16 + Drizzle ORM (no Prisma)
- WhatsApp: Baileys (sesión persistida en DB)
- LLM: `@anthropic-ai/sdk`, Claude Haiku 4.5 default
- Jobs: BullMQ + Redis
- Validación: Zod
- Logs: Pino estructurado JSON
- Tests: Vitest
- Format/lint: Biome (no Prettier, no ESLint separado)
- Package manager: npm

## Comandos

```bash
npm run dev              # dev server con tsx watch
npm test                 # vitest run
npm run test:watch       # vitest watch
npm run db:generate      # drizzle-kit generate
npm run db:migrate       # drizzle-kit migrate
npm run db:studio        # drizzle-kit studio
npm run lint             # biome check --write
npm run typecheck        # tsc --noEmit
npm run check            # lint + typecheck + test (ejecutar antes de commit)
```

**Antes de cualquier commit a main: `npm run check` debe pasar.**

## Estructura
src/
app.ts              # Hono app + middleware setup
config/             # env (zod-validated), logger, db client, redis client
modules/
whatsapp/         # Baileys integration, webhook handlers, message parsing
llm/              # Claude client, prompt builders, tool definitions
business/         # tenant management, knowledge base CRUD
customer/         # customer records, long-term memory
appointment/      # Google Calendar integration, slot logic
conversation/     # conversation state, short-term memory window
db/
schema/           # Drizzle schemas (one file per table)
migrations/
workers/            # BullMQ workers for async jobs
shared/             # utils, types, errors
tests/
unit/
integration/
src/
app.ts              # Hono app + middleware setup
config/             # env (zod-validated), logger, db client, redis client
modules/
whatsapp/         # Baileys integration, webhook handlers, message parsing
llm/              # Claude client, prompt builders, tool definitions
business/         # tenant management, knowledge base CRUD
customer/         # customer records, long-term memory
appointment/      # Google Calendar integration, slot logic
conversation/     # conversation state, short-term memory window
db/
schema/           # Drizzle schemas (one file per table)
migrations/
workers/            # BullMQ workers for async jobs
shared/             # utils, types, errors
tests/
unit/
integration/

Detalle por módulo: ver `docs/architecture.md`. NO lo cargues completo al 
inicio — léelo solo cuando trabajes en ese módulo.

## Schema de DB (multi-tenant desde día uno)

Tablas core (cada una con `business_id` excepto `businesses`):

- `businesses` — tenants
- `knowledge_base` — info estática del negocio
- `customers` — clientes finales del negocio (key: `business_id + phone`)
- `conversations` — sesiones de chat (status: open, closed, escalated)
- `messages` — historial completo
- `appointments` — citas agendadas
- `events` — log auditable de acciones (tool calls, escalations, errores)

Schema detallado: `docs/db-schema.md`.

## Reglas de código no-negociables

1. **TypeScript estricto.** Nada de `any`. Si necesitas escape, usa 
   `unknown` + type guard.
2. **Validación de entrada con Zod** en todo endpoint y toda función pública 
   que recibe input externo.
3. **Multi-tenant:** todo `business_id` viaja explícito en queries. NUNCA 
   query a tabla con tenant sin filtro por `business_id`. Esto es bug de 
   seguridad, no estilo.
4. **Logs estructurados con Pino.** Cero `console.log` en código que no sea 
   script local descartable.
5. **Errores:** clase base `AppError` con `code`, `userMessage` (seguro 
   para mostrar), `logContext` (para Pino).
6. **Tests obligatorios** para: tool definitions del LLM, lógica de 
   agendamiento, parsing de mensajes WhatsApp, filtros multi-tenant.
7. **Async/await** siempre. Nada de `.then()` encadenado.
8. **Funciones puras** donde se pueda. Side effects aislados en módulos 
   `infra/` o adapters específicos.
9. **Secrets:** solo vía `env`. Nunca hardcoded. Nunca logueados.
10. **Comentarios en código: inglés.** Commit messages: inglés, imperativo 
    presente (`add appointment slot validator`, no `added` ni `adding`).

## Autonomía esperada

Modo autónomo táctico. Decide y ejecuta sin pedir permiso para:
- Nombres de variables, archivos, funciones, tipos
- Estructura de carpetas dentro de un módulo existente
- Refactors de menos de 50 líneas que no cambian API pública
- Tests adicionales que cubran edge cases obvios
- Migraciones aditivas (nuevas columnas opcionales, nuevas tablas)

Pregunta ANTES de:
- Agregar dependencia nueva (justifica por qué la stack actual no alcanza)
- Cambiar schema destructivo (drop column, rename, change type)
- Borrar archivos o funciones existentes
- Saltar tests para "ir más rápido"
- Tocar lógica de seguridad o multi-tenancy

## Workflow por tarea

1. **Explora.** Lee los archivos relevantes, corre tests existentes, mira 
   el schema. Usa bash si necesitas info del filesystem.
2. **Planea.** Lista pasos en respuesta antes de tocar código. Si el cambio 
   toca más de 3 archivos, espera mi OK al plan.
3. **Implementa incrementalmente.** Un commit por unidad lógica, no megacommits.
4. **Verifica.** Corre `npm run check` antes de decir que terminaste.
5. **Reporta.** Resume qué hiciste, qué archivos tocaste, qué falta. Si 
   rompiste algo no esperado, dilo. No silencies errores.

## Definition of Done por tarea

Una tarea está hecha cuando:
- [ ] Código compila sin warnings
- [ ] Tests pasan (existentes + nuevos si la tarea agrega comportamiento)
- [ ] Lint limpio (`npm run lint`)
- [ ] No hay `console.log`, `TODO` sin issue link, ni código comentado
- [ ] El commit message describe el cambio en imperativo presente en inglés
- [ ] Si tocó multi-tenancy: hay test que verifica aislamiento por `business_id`

## Lo que NO está en V1 (no me dejes agregarlo)

- Pagos, links de pago, carritos
- Audio, imágenes, videos, llamadas en WhatsApp
- Recordatorios automáticos previos a la cita (eso es V1.5)
- Múltiples sucursales por negocio
- Integraciones con CRM, POS, ERP
- Panel admin web (eso es V1.5, después del primer cliente pagando)
- Soporte multi-idioma (solo español de Perú en V1)
- App móvil

Si yo te pido alguno de estos: respóndeme "esto está fuera del V1 según 
CLAUDE.md. ¿Confirmas que cambia el scope del DoD, o lo dejamos para V1.5?"

## Cuando te equivoques

Si cometes un error que se va a repetir (asumir librería que no existe, 
ignorar una regla de arriba, romper convención del repo): cuando te lo 
señale, sugiéreme actualizar ESTE archivo con la regla nueva. Así no 
vuelve a pasar la próxima sesión.

## Referencias (no cargar al inicio)

- Arquitectura detallada: `docs/architecture.md`
- DB schema completo: `docs/db-schema.md`
- Diseño de prompts del bot: `docs/prompts.md`
- Configuración del cliente actual: `docs/clients/<business_id>.md`
- Runbook de incidentes: `docs/runbook.md`

Léelos solo cuando trabajes en su área. No los cargues todos al iniciar 
sesión — quema budget de contexto.