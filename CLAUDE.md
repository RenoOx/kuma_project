# Kuma — Contexto para Claude Code

> Documento único. Fusiona lo que antes vivía en `PANEL_SPEC.md`,
> `MIGRATION_PLAN.md` y `THEME_MIGRATION.md`, los tres ya ejecutados y borrados.
> Describe el estado ACTUAL del repo, no el objetivo: si algo acá no coincide
> con el código, el código manda y este archivo hay que corregirlo.

## Qué es este repo

Emma es un asistente de WhatsApp multi-tenant por Vamvu Labs, para negocios
de servicios. Cada `business_id` tiene su knowledge base, su número de
WhatsApp, sus clientes y configuración. Un solo deploy atiende N negocios.

Soporta dos tipos de flujo según el negocio:
- **appointments**: clínicas dentales, centros estéticos, consultorios (agendar citas)
- **sales**: certificaciones, cursos, ventas por campañas (informar, cobrar, recolectar datos)

El tipo de flujo se define en `business.settings.flowType`.

## Identidad del producto

- Nombre: Emma
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
- WhatsApp: Baileys (sesión persistida en disco, `SESSIONS_DIR`)
- LLM: `openai`, OpenAI gpt-4o-mini default, gpt-4o solo para casos complejos
- Jobs: `setInterval` en `server.ts` (BullMQ + Redis está en el stack pero los
  workers actuales no lo usan todavía)
- Validación: Zod 4
- Logs: Pino estructurado JSON
- Tests: Vitest
- Format/lint: Biome (no Prettier, no ESLint separado)
- Package manager: npm
- Panel: React 19 + Vite + Tailwind v4 + Radix (paquete único `radix-ui`) +
  TanStack Query + FullCalendar

## Comandos

```bash
npm run dev              # dev server con tsx watch (:3000)
npm run dev:panel        # vite dev server del panel (:5173, proxy /api → :3000)
npm run build:panel      # build del panel a dist/panel
npm test                 # vitest run
npm run test:watch       # vitest watch
npm run db:generate      # drizzle-kit generate
npm run db:migrate       # tsx src/db/migrate.ts
npm run db:studio:dev    # drizzle-kit studio contra la base de dev
npm run lint             # biome check --write
npm run typecheck        # tsc --noEmit  +  tsc --noEmit -p src/panel/tsconfig.json
npm run check            # lint + typecheck + test (ejecutar antes de commit)
```

`src/panel` está **excluido del tsconfig raíz** y tiene el suyo. Un error de
tipos en el panel no aparece si solo corrés el primer `tsc`; por eso
`typecheck` corre los dos.

**Antes de cualquier commit a main: `npm run check` debe pasar.**

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
6. **Result<T>**: todas las funciones que pueden fallar retornan
   `{ ok: true, data: T } | { ok: false, error: AppError }`. NUNCA throw
   en lógica de negocio.
7. **Async/await** siempre. Nada de `.then()` encadenado.
8. **Funciones puras** donde se pueda. Side effects aislados.
9. **Secrets:** solo vía `env`. Nunca hardcoded. Nunca logueados.
10. **Comentarios en código: inglés.** Explican POR QUÉ, no qué. Commit
    messages: inglés, imperativo presente (`add appointment slot validator`).
11. **Transacciones:** los services abren `db.transaction` y pasan `tx` al
    repo. Los repos reciben `(exec: Executor = db)` como último parámetro
    opcional. Los services nunca ejecutan queries directamente sobre `db`
    o `tx`.
12. **Estado de conversación:** toda transición pasa por `stateMachine.ts` vía
    `conversationService.applyTrigger`. NUNCA cambiar `conversation.state`
    directamente en otro archivo.
13. **Envío de mensajes:** todo mensaje saliente DEBE pasar por `enqueueSend`
    (`whatsapp/sendQueue.ts`). NUNCA llamar `sock.sendMessage` directo.

### NO TOCAR

Auditado y cerrado. No modificar sin pedirlo explícitamente:
Baileys, manejo de sesiones, `sendQueue.ts`, lógica anti-ban, `presence.ts`,
`healthMonitor.ts`, `sendTelemetry.ts`, `authState.ts`, `sessionPolicy.ts`.

## Arquitectura del flujo de mensajes (6 capas)

Todo mensaje de WhatsApp pasa por estas 6 capas en orden:

1. **Filtrado** (handler.ts): deduplicación (`claimMessageId`), extracción
   de teléfono (`extractPhone`), clasificación de tipo, debounce de mensajes
   rápidos (`bufferMessage`), serialización por remitente (`withSenderLock`)
2. **Enrutamiento** (handler.ts): `samePhone()` compara con
   `business.ownerWhatsappNumber` → flujo owner o flujo customer
3. **Flujo cliente** (handler.ts): compuertas en orden: ¿Emma apagada en este
   chat? → ¿human takeover? → ¿pausado? → ¿imagen? → ¿formato no soportado? →
   ¿escalado? → LLM
4. **Cerebro** (llm.service.ts): `generateReply` carga contexto completo
   (business, settings, KB, historial, citas pendientes), resuelve el estado,
   construye system prompt, entra en loop de hasta 5 iteraciones
5. **Herramientas** (toolExecutor.ts + tools.ts): el LLM invoca tools, el
   executor valida (gates, permisos por estado) y ejecuta. Resultado vuelve
   al loop
6. **Config** (business.settings.ts): todo es config-driven. Un motor,
   templates por nicho. Validación con Zod

### Patrones clave de arquitectura

- **Prompt caching**: system prompt dividido en cuerpo estático (cacheable,
  ~3700 tokens) + cola variable (fecha, cita pendiente, CTA). El cuerpo
  estático SIEMPRE va primero para aprovechar el caché de OpenAI
- **Gate de depósito**: `toolExecutor` rechaza `book_appointment` si
  `requiresDeposit=true` y no hay evidencia de pago reciente. El rechazo
  congela el contexto de pago en la expectativa de imagen
- **Expectativa de imagen**: mecanismo de señalización LLM ↔ handler.
  `request_image` arma una expectativa; `handleCustomerImage` la consume.
  La foto NUNCA llega al LLM
- **Anti-ban**: `humanDelay` + `sendWithPresence` simulan comportamiento
  humano antes de enviar

## Archivos críticos (leer antes de cambiar)

| Archivo | Qué controla |
|---------|-------------|
| `src/modules/whatsapp/handler.ts` | Flujo principal, capas 1-3 |
| `src/modules/llm/llm.service.ts` | Cerebro, loop de tools, carga de contexto |
| `src/modules/llm/toolExecutor.ts` | Ejecución de herramientas + gates |
| `src/modules/llm/tools.ts` | Definición de herramientas del LLM |
| `src/modules/llm/prompts.ts` | System prompt (estático + variable) |
| `src/modules/business/business.settings.ts` | Config por negocio (Zod) |
| `src/modules/conversation/stateMachine.ts` | Estados y transiciones por flujo |
| `src/modules/panel/settings.merge.ts` | Patch schemas + merge del panel |

## Máquina de estados

Cada conversación tiene un campo `state` que controla en qué paso está.
El flujo NO lo decide el LLM — lo controla el código.

- **Estado**: dónde está la conversación (`conversations.state`, default `idle`)
- **Trigger**: qué pasó. Del LLM (intención), del código (imagen recibida) o
  del tiempo (24h sin respuesta)
- **Transición**: estado actual + trigger → estado nuevo
- **Tools por estado**: en cada estado el LLM solo ve las tools permitidas.
  `llm.service.ts` filtra el array antes de llamar a OpenAI, así que una tool
  no permitida no se rechaza: no se ofrece

### Flujos

- `flowType: "appointments"`: idle → greeting → informing → show_availability
  → choose_time → await_payment (si depósito) → await_payment_verification
  → confirmed
- `flowType: "sales"`: idle → greeting → informing → send_offer →
  await_payment → collect_data → confirmed

Definiciones en `src/modules/conversation/stateMachine.ts`, que es data pura.
El único que aplica transiciones es `conversationService.applyTrigger`.

### Verificación de pago (solo si `requiresDeposit`)

Cuando el negocio pide adelanto, la captura del cliente NO crea la cita:

1. La captura llega a `handleCustomerImage`: se reenvía al dueño y se abre una
   fila en `payment_verifications` con la intención congelada (servicio,
   horario, monto, nombre). El estado pasa a `await_payment_verification`.
2. El dueño responde en su hilo. `approve_payment` crea la cita y confirma;
   `reject_payment` no crea nada y le pide al cliente que reenvíe, volviendo el
   estado a `await_payment`.

Con `requiresDeposit` activo, el gate del `toolExecutor` rechaza SIEMPRE
`book_appointment` del lado del cliente: la única vía a una cita con adelanto es
la aprobación del dueño. Sin adelanto, la captura agenda directo.

## Business settings

Los horarios, servicios y configuración operativa viven en `businesses.settings`
(jsonb). Validación obligatoria con `businessSettingsSchema`
(`src/modules/business/business.settings.ts`). NO HAY DEFAULTS: si un business
no tiene settings, las tools que requieren config devuelven
`NotConfiguredError`, el LLM las recibe y maneja según el bloque "ATENCIÓN —
negocio sin configuración" del system prompt (responder con honestidad, NO
inventar, NO escalar por consultas informativas; escalar solo si el cliente
quiere agendar). Esto es feature, no bug.

Campos clave:
- `flowType`: "appointments" | "sales" — define qué flujo de estados aplica
- `niche`: dental, barberia, estetica, salud, general — define la voz y los
  ejemplos del prompt
- `appointmentMode`: appointments_only | hybrid — modo de atención
- `bookingMode`: direct | requires_approval
- `requiresDeposit`: boolean — activa el gate de depósito
- `collectDataFields`: string[] — campos a recolectar en flujo sales
- `postBooking`: switches de recordatorios y seguimientos
- `minBookingNoticeMinutes`: entero 0-1440, default 30

Helpers obligatorios — no leer los campos crudos:
- `activeServices(settings)` en vez de `settings.services`
- `resolveServiceDurationMinutes(service, settings)` en vez de
  `service.durationMinutes`
- `getMinBookingNoticeMinutes(settings)`, `resolveDayHours(...)`,
  `isBotPausedNow(...)`

Cada día puede tener un break opcional. Múltiples breaks es V1.1.

## Google Calendar

Cada business conecta SU cuenta vía `GET /auth/google/connect?businessId=X`.
Credenciales en tabla `google_credentials` (UNIQUE por `business_id`).

`bookAppointment` es **best-effort con Google**: si falla la creación del
evento, el appointment local SÍ se persiste (`google_event_id` queda null).
Tres branches: ok → patch con `googleEventId`; `NotConnectedError` → warn;
cualquier otro error → error log, sigue adelante.

Refresh: `googleCredentialsService.getValidAccessToken` renueva si expira en
menos de 2 minutos.

## Roles y routing

- Si `phone === business.ownerWhatsappNumber` → flujo `owner_assistant`
  * System prompt casual, tutea, telegráfico
  * Tools: `get_daily_summary`, `get_appointments`, `pause_bot`, `resume_bot`,
    aprobación de pagos y de citas pendientes
  * Memoria corto plazo: 48h, cleanup cada hora
  * `conversation.type='owner_thread'`, una por business, `customerId=null`

- Si `phone !== ownerWhatsappNumber` → flujo `customer`
  * System prompt vendedor cálido
  * Tools filtradas por estado (ver stateMachine.ts)
  * `conversation.type='customer'`

Con `business.settings.botPaused.paused === true`: los clientes reciben mensaje
canned + conversación escalada + evento `paused_blocked_message`. El dueño nunca
se ve afectado. Si `until_iso` ya pasó, auto-resume.

## Notificaciones proactivas

- **Cuando un cliente escala** (pide humano o bot pausado + cliente escribe).
  Fire-and-forget: la respuesta al cliente no se bloquea por el push.
- **Cuando el dueño pide el reporte** con `send_daily_report_now`. No hay cron.

Helper: `notifyOwner(businessId, text)` en `whatsapp/ownerNotifier`. Al cliente:
`notifyCustomer` (solo envía) o `messagePatient` (envía **y** deja el mensaje en
el transcript — preferí este cuando el cliente pueda responderlo).

`clientRegistry` mantiene `Map<businessId, WhatsappClient>` en memoria, poblado
en cada boot y reconnect. Multi-instancia requeriría reemplazarlo.

## Recordatorios

Cada cita `scheduled` recibe 2 recordatorios: 24h antes y 2h antes.
Worker `sendDueReminders` cada 15 min vía `setInterval` en `server.ts`.
Idempotencia con `reminder_24h_sent_at` y `reminder_2h_sent_at`.

Ventanas: 24h → `scheduled_at ∈ [now+23h, now+25h)`; 2h → `[now+1.5h, now+2.5h)`.
Formato: `sábado 20 de junio`, `11:00am`. Helpers en `workers/reminderTexts.ts`.

Si el cliente responde queriendo reprogramar, Emma escala al dueño. NO maneja
la reprogramación sola.

## Estructura

```
src/
  app.ts              # Hono app + middleware setup
  config/             # env (zod-validated), logger, db client, redis client
  modules/
    whatsapp/         # Baileys, handlers, sendQueue, anti-ban, notifiers
    llm/              # cliente, prompts, tools, executor
    business/         # tenants, settings
    customer/         # clientes finales, memoria larga
    appointment/      # citas, slots, verificación de pago
    conversation/     # estado, máquina de estados, memoria corta
    ownerAssistant/   # flujo del dueño por WhatsApp
    panel/            # backend del panel: auth, repo, service, rutas, static
    admin/            # superficie de Vamvu
    tag/              # etiquetas de conversación
    knowledgeBase/    # KB por categoría
    google/           # Google Calendar
    events/           # log auditable
    demo/             # modo demo
  db/schema/          # Drizzle, un archivo por tabla
  panel/              # SPA React (build separado con Vite)
  workers/            # jobs: recordatorios, takeover timeout, cleanup
  shared/             # result, errors, phone, name, datetime, humanDelay
```

## Schema de DB (multi-tenant desde día uno)

Tablas core (cada una con `business_id` excepto `businesses`):

- `businesses` — tenants. Incluye `panel_token` (varchar 64)
- `knowledge_base` — info estática del negocio
- `customers` — clientes finales (key: `business_id + phone`). `wa_jid` guarda
  el JID real: desde la migración LID no se puede reconstruir desde el teléfono
- `conversations` — sesiones de chat
- `messages` — historial. `sender_type` (`customer`/`bot`/`human`)
  **complementa** `role`: `role` es el vocabulario de OpenAI y es lo que se le
  replica al modelo; `sender_type` dice si ese turno de assistant lo escribió
  Emma o lo tipeó el dueño desde el panel
- `appointments` — citas. `customer_name` congela el nombre al momento de
  reservar; `customers.name` cambia y haría que una cita vieja mute de nombre
- `payment_verifications` — adelantos esperando aprobación del dueño
- `tags` + `conversation_tags` — etiquetas que el dueño inventa
- `google_credentials`, `events`, `whatsapp_session_guard`

## Panel del dueño

SPA React en `src/panel/`, servida en `/panel/:businessId?token=` desde el mismo
deploy. Build: `npm run build:panel` → `dist/panel`, servido por
`panelStatic.ts`. API en `src/modules/panel/`.

### Auth

Token por query param contra `businesses.panel_token`, comparado en tiempo
constante (`panelToken.ts`). Stateless: sin cookies, sin JWT, sin expiración.
El link ES la credencial. Se genera al registrar un negocio.

### Rutas

`/` Inbox · `/dashboard` · `/citas` · `/contactos` · `/servicios` ·
`/configuracion`. Todas bajo `/:businessId/*`. Para navegar se usa `PanelLink`
de `lib/session.js`, que reinyecta businessId y token.

### Los ejes de una conversación

No colapsar uno en otro — cada uno responde una pregunta distinta:

| Campo | Pregunta | Quién escribe |
|---|---|---|
| `type` | ¿quién está del otro lado? | `conversation.service` |
| `status` | ¿abierta, cerrada, escalada? | `conversation.service` |
| `state` | ¿en qué paso del flujo? | SOLO vía `stateMachine.ts` |
| etiquetas (`tags`) | ¿cómo lo clasifica el dueño? | el dueño, desde el panel |
| `emma_enabled` | ¿Emma responde en este chat? | el dueño, desde el panel |
| `human_takeover_at` | ¿el dueño tomó el control? | `panel.service` / worker |

**`qualification` está muerto.** La columna sigue en el schema marcada
`@deprecated` (solo para que `drizzle-kit generate` no emita un DROP), pero el
enum de siete valores que escribían el LLM y un worker ya no existe: lo
reemplazaron las etiquetas libres. No hay `classify_interest` ni
`updateQualificationIfNotPinned`.

### Human takeover

El gate vive en `handler.ts`, después de persistir el mensaje del cliente y
antes del gate de pausa. Guarda en BD, no llama al LLM, no envía nada, early
return. El dueño recupera el control manualmente o por timeout de 30 min
(worker `takeoverTimeout.ts`).

### Polling

Sin WebSockets en V1. Cadencias en `POLL_MS` (`panel/lib/constants.ts`): inbox
5s (check ligero primero, fetch completo solo si algo cambió), citas 10s,
dashboard y health 30s. Datos que solo cambian desde esa misma pantalla van con
`staleTime: Infinity` y se invalidan desde la mutación.

### Tema visual

**Crema pastel con el rail oscuro.** Migrado desde el tema dark original el
15/09/2026. Tokens en `src/panel/styles/globals.css`, bloque `@theme`:

```
--color-emma-bg:            #faf7f2   página
--color-emma-bg-secondary:  #ffffff   cards y bloques de contenido
--color-emma-elevated:      #f0ebe3   hovers, muted, burbuja del cliente
--color-emma-text:          #2d2a26   marrón oscuro cálido, no negro
--color-emma-text-muted:    #8c8478   gris cálido
--color-emma-border:        #e8e2d9
--color-emma-accent:        #059669   verde Emma (no cambió)
--color-emma-sidebar:       #0a0f0d   el rail sigue oscuro
--color-emma-sidebar-text:  #f0e6da
--color-emma-sidebar-border:#1f2937
```

Tres reglas que explican por qué está así:

1. **El rail no sigue a la página.** Es la única superficie que no es
   contenido, y dejarla oscura es lo que mantiene el ojo en la página crema.
   Por eso tiene sus propios tres tokens: usar `emma-border` sobre near-black
   dibuja una línea brillante donde debería haber una costura.
2. **Todo neutro tira a marrón, nunca a azul.** `#8c8478` y no `#6b7280`.
   Ante la duda entre un gris frío y uno cálido, siempre el cálido.
3. **Los tokens semánticos de shadcn apuntan a los de Emma** (`--primary` ES
   `--color-emma-accent`). Por eso migrar de dark a crema fue cambiar un bloque
   y nada más. No declarar colores sueltos en componentes.

`color-scheme: light` está declarado en `html` a propósito: sin eso los inputs
de fecha y hora, los selects nativos y los scrollbars se pintan oscuros.

**Deuda conocida**: `#8c8478` sobre crema da 3.46:1 de contraste, debajo del
4.5:1 que pide WCAG AA para texto normal (en el tema oscuro daba ~7:1).
`#756d61` daría 4.77:1 manteniendo la calidez. Los badges de estado con tinte
al 15% están entre 1.9:1 y 4.4:1, deuda anterior a la migración.

### Layout

```
┌────────┬──────────────┐   Desktop: el header ocupa el ancho del rail,
│ Header │              │   no todo el ancho de la ventana. El contenido
├────────┤  Contenido   │   se queda con todo lo demás.
│Sidebar │              │
└────────┴──────────────┘
```

`PageLayout` agrupa Header + Sidebar en una columna de 208px con
`contents md:flex`: en móvil el wrapper sale del flujo (`display: contents`) y
`order` pone el header arriba, el contenido al medio y el nav abajo. Un solo
DOM para las dos formas — el mismo criterio que usa el Sidebar para cambiar de
eje en vez de montar dos componentes.

El `<Logo />` vive en el Header (que en desktop ocupa el lugar que antes tenía
en el nav). El gutter de todas las pantallas (`p-3`) lo pone el shell: una
página no lo repite.

### Multi-nicho

El panel se adapta vía `nicheCopy(niche)` (`panel/lib/constants.ts`). La
navegación dice lo mismo en todos los nichos ("Agenda", "Contactos"); lo que
varía es el vocabulario dentro de las pantallas: una clínica habla de
"paciente" y una barbería de "cliente". Objeto de configuración indexado por
niche, NO componentes separados por nicho.

## Superficies de configuración

Hay dos, y no se pisan:

- **Panel del cliente** — lo usa el dueño. Es el dueño de la configuración
  operativa: horarios, días especiales, servicios, pagos y adelanto, modo de
  reserva, recordatorios, nicho, datos del negocio y base de conocimiento.
  Escribe por sección, mergeando sobre lo guardado (`settings.merge.ts`).
- **Admin** (`/admin/...`, protegido por `ADMIN_SECRET`) — lo usa Vamvu. Queda
  solo con lo que el panel no puede tocar: crear negocios, el número de
  WhatsApp del bot y el del dueño (con el rebind del socket), vinculación por
  QR, session guard, Google Calendar y desvincular WhatsApp. **No edita
  `business.settings` ni la KB.**

El QR y el desvincular NO se migran al panel: el token del panel viaja en una
URL, y un mis-click detrás de eso saca a un negocio de WhatsApp.

### Los patch schemas del panel

`settings.merge.ts` deriva cada schema de sección de `businessSettingsSchema`,
así una regla escrita una vez aplica en los dos lados. Ojo con una trampa que ya
costó un bug en producción: **`.partial()` de Zod NO desactiva los
`.default()`**, así que un patch de "modo de reserva" volvía con `postBooking`
entero en false y el merge lo escribía, apagando los recordatorios del dueño.
Por eso existe el helper `patchable()`, que desenvuelve el default antes de
hacer el campo opcional. Todo campo nuevo de un patch schema pasa por ahí.

## Autonomía esperada

Modo autónomo táctico. Decide y ejecuta sin pedir permiso para:
- Nombres de variables, archivos, funciones, tipos
- Estructura de carpetas dentro de un módulo existente
- Refactors de menos de 50 líneas que no cambian API pública
- Migraciones aditivas (nuevas columnas opcionales, nuevas tablas)

Pregunta ANTES de:
- Agregar dependencia nueva (justifica por qué la stack actual no alcanza)
- Cambiar schema destructivo (drop column, rename, change type)
- Borrar archivos o funciones existentes
- Saltar tests para "ir más rápido"
- Tocar lógica de seguridad o multi-tenancy
- Escribir cualquier test nuevo (propón primero, ejecuta solo con OK explícito)
- Ejecutar cualquier cambio que toque más de 1 archivo

## Workflow por tarea

1. **Explora.** Lee los archivos relevantes, corre tests existentes, mira
   el schema.
2. **Planea.** Lista pasos en respuesta antes de tocar código. SIEMPRE espera
   OK explícito al plan antes de implementar — sin excepción. No hay umbral
   de archivos que exima de esto.
3. **Implementa incrementalmente.** Un commit por unidad lógica.
4. **Verifica.** Corre `npm run check` antes de decir que terminaste.
5. **Reporta.** Qué hiciste, qué archivos tocaste, qué falta. Si rompiste algo
   no esperado, dilo.

### Autorización de ejecución

Cuando te doy OK a un plan, ese OK cubre TODA la ejecución de ese plan.
No pidas permiso archivo por archivo. Solo detente si:
- Descubres algo que cambia sustancialmente el plan original
- Vas a hacer una operación destructiva no contemplada
- Encuentras un error de multi-tenancy o seguridad no anticipado

### Estrategia de testing

NO corras tests después de cada tarea individual. Implementa todas las tareas
de la sesión primero y corre `npm run check` UNA SOLA VEZ al final, cuando yo
diga "corre los tests". Si una tarea rompe algo evidente en compilación,
avísame — pero no pares a testear.

**No hay base de datos de test**: solo dev y prod. Los tests que la requerían se
borraron. Lo testeable en aislamiento son funciones puras (schemas, prompts,
merges, formatters), y ahí es donde van los tests nuevos.

## Definition of Done

- [ ] Código compila sin warnings
- [ ] Tests pasan (existentes + nuevos si la tarea agrega comportamiento)
- [ ] Lint limpio (`npm run lint`)
- [ ] No hay `console.log`, `TODO` sin issue link, ni código comentado
- [ ] El commit message describe el cambio en imperativo presente en inglés
- [ ] Si tocó multi-tenancy: hay test que verifica aislamiento por `business_id`
- [ ] Si tocó estados: las transiciones están definidas en stateMachine.ts

## Fuera de scope

Si te pido alguno de estos, respondé "esto está fuera del scope actual según
CLAUDE.md. ¿Confirmás que cambia el alcance, o lo dejamos para después?" —
pero **verificá el código primero**: esta lista envejece y algo puede estar ya
implementado.

- Links de pago automáticos, pasarelas, carritos
- Audio, videos, llamadas en WhatsApp
- Múltiples sucursales por negocio
- Integraciones con CRM, POS, ERP
- Multi-idioma (solo español de Perú)
- App móvil / notificaciones push
- Canvas visual para diseño de flujos
- Multicanal (Instagram, Facebook, TikTok)
- Login con usuario/contraseña, roles, multi-usuario en el panel
- Responder con imágenes, archivos o audios desde el panel
- WebSockets / real-time verdadero
- Drag & drop de citas en el calendario
- Campañas, broadcasts, mensajes masivos
- Notas internas en conversaciones
- Exportar datos / reportes PDF
- Observabilidad avanzada (Langfuse, Sentry), staging separado

## Pendientes conocidos

Heredados de los planes ya cerrados:

- **El nombre del cliente solo se persiste al agendar.** Si alguien le dice a
  Emma cómo se llama y no reserva, `customers.name` se queda con el push name
  de WhatsApp. Arreglarlo implica tool o prompt nuevos.
- **Editar una cita desde el panel** (reprogramar, drag & drop).
  `rescheduleAppointment` existe en el service pero no está expuesto.
- **`checkAvailability` no está expuesto al panel**: el modal de cita manual
  avisa de los choques al enviar, pero no sugiere horarios libres.
- **Contraste del texto muted** (ver Tema visual).
- `clientRegistry` es un Map en memoria: multi-instancia lo rompe.

## Cuando te equivoques

Si cometes un error que se va a repetir (asumir librería que no existe, ignorar
una regla de arriba, romper convención del repo): cuando te lo señale,
sugiéreme actualizar ESTE archivo con la regla nueva. Así no vuelve a pasar la
próxima sesión.

## Skills

En `.claude/skills/`, se cargan solas cuando la tarea las toca:

- **`panel-design-system`** — convenciones de UI del panel. Antes de crear
  páginas, componentes o hooks ahí.
- **`config-sync`** — verifica que cada campo de configuración se refleje en el
  comportamiento de Emma. Al tocar `business.settings`, `prompts.ts`,
  `llm.service.ts`, `stateMachine.ts` o `handler.ts`.
