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
  TanStack Query + FullCalendar + `@xyflow/react` y `@dagrejs/dagre` (el
  diagrama de la conversación, ambos MIT y cargados en diferido)

## Qué NO viaja en un PR

Mergear despliega **código**. Nada más. Dos cosas que el repo no lleva y que hay
que mover a mano, en este orden:

1. **Las variables de entorno.** `.env` está en `.gitignore` y git no lo trackea;
   Railway tiene las suyas por entorno. Un merge no las toca.
2. **Las migraciones.** `railway.json` no declara comando de release ni de
   pre-deploy, y `npm start` no migra al arrancar. **Una migración nunca corre
   sola.**

### El orden importa

Primero la migración, después el deploy. Al revés, el código llega buscando
tablas que no existen.

```
1. npm run db:migrate:prod        # el guard verifica que sea prod antes de tocar
2. variables nuevas en Railway
3. merge → Railway rebuildea y arranca con SUS variables
```

Hay una red por si se invierte: la lectura de `service_media` en `llm.service`
está envuelta en try/catch, así que código desplegado antes de su migración
responde sin los marcadores `[con material]` en vez de tirar abajo la respuesta
al cliente. Es una red, no un permiso — el orden sigue siendo ese.

## Las dos bases, y el guard

Hay **dos**, y cada una se identifica a sí misma con una tabla `_env_marker`:

```
DATABASE_URL       acela.proxy.rlwy.net    🟢 DEV — kuma-postgres-dev — safe to break
PROD_DATABASE_URL  thomas.proxy.rlwy.net   🔴 PRODUCTION — kuma-postgres-prod
```

**`db:migrate:dev` no verificaba nada.** El sufijo `:dev` era solo un nombre: el
script leía `DATABASE_URL` y migraba donde esa variable apuntara. El 2026-09-21
apuntaba a producción, y lo único que evitó que una migración aterrizara ahí fue
que alguien miró primero.

Desde entonces los cuatro scripts que abren una base —`db:migrate:dev`,
`db:migrate:prod`, `db:studio:dev`, `db:studio:prod`— pasan por
`scripts/guard-db-env.mjs`, que lee `_env_marker` y aborta si no coincide con lo
esperado. Studio también, porque es una GUI con permiso de escritura: es el
camino más corto que existe para editar una fila de prod creyendo que es dev. **Falla cerrado**: una
base sin marcador, inalcanzable o con una etiqueta ambigua también aborta —
asumir "seguro es dev" es exactamente lo que causó el problema.

Si agregás una base nueva, creale el marcador o ningún script va a querer tocarla:

```sql
create table _env_marker (label text);
insert into _env_marker values ('🟢 DEV — mi-base — safe to break');
```

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

- **Prompt en tres capas, por estabilidad**:
  1. **Del negocio** (cacheable, cambia cuando el dueño guarda): identidad, voz,
     formato, servicios, horarios, precios, reglas de evaluación previa, adelanto
     (UNA vez), reglas generales, KB. SIEMPRE primero, para el caché de OpenAI
  2. **Del turno**: fecha/hora, cita pendiente, fuera de horario, CTA
  3. **Del nodo** (`renderNodeBlock`): OBJETIVO · PASOS · CASOS ESPECIALES ·
     EJEMPLO. Va último, que es donde una instrucción pesa más

  La prosa de flujo bajó a los nodos: un negocio en `await_payment` dejó de
  recibir las 35 líneas del árbol de disponibilidad. Medido: −22% por mensaje.

  **Lo que NO baja a un nodo**: las reglas de precio y de evaluación previa.
  Cuelgan de `requiresEvaluation`, un flag por servicio, y tienen que estar
  presentes en TODOS los estados — si se atan a `listado_servicios`, un cliente
  que abre con "¿cuánto cuesta X?" se queda sin la consulta de diagnóstico

  **La capa 1 se ramifica por `schedulesAppointments(settings)`**, vía la
  variable `books` de `buildStaticBody`. Un negocio de venta no recibe la
  mecánica de reserva (razonamiento de fechas, el orden servicio→horario→nombre,
  el nombre obligatorio, confirmación de citas pendientes, frescura de
  disponibilidad), ni los bloques de evaluación previa, ni las invitaciones de
  agenda: son instrucciones para tools que `llm.service` nunca le ofrece, y el
  modelo las intentaba igual. Medido: 229 → 178 líneas. El prompt de un negocio
  de agenda **no cambió** al hacerlo, y eso se verifica con el diff de 5 nichos ×
  con/sin adelanto.

  **Lo que se ramifica pero no desaparece**: `unrecognizedServiceBlock` y "no
  repreguntes" tienen versión de venta. El catálogo cerrado importa MÁS ahí — un
  curso que suena plausible para un instituto es exactamente lo que se inventa.

  **Los corchetes son marcas internas.** `[con material]` se le escapó a un
  cliente el 2026-09-21, copiado tal cual de la línea del catálogo. La regla que
  lo prohíbe es la 3 de `# Reglas generales`, incondicional a propósito: ese
  negocio no tenía adelanto ni bloque clínico, así que cualquier lugar gateado se
  la habría perdido
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
| `src/modules/llm/prompts.ts` | System prompt (negocio + turno); `renderNodeBlock` |
| `src/modules/business/business.settings.ts` | Config por negocio (Zod) |
| `src/modules/conversation/nodeCatalog.ts` | El catálogo de nodos + `EMITTED_TRIGGERS` |
| `src/modules/conversation/stateMachine.ts` | Compilador, validador y presets |
| `src/modules/panel/settings.merge.ts` | Patch schemas + merge del panel |

## Máquina de estados

Cada conversación tiene un campo `state` que controla en qué paso está.
El flujo NO lo decide el LLM — lo controla el código.

- **Estado**: dónde está la conversación (`conversations.state`, `varchar(50)`,
  default `idle`). No hay enum en la BD: los ids de nodo son libres
- **Trigger**: qué pasó. De una tool (`ToolResult.trigger`), del código (imagen
  recibida) o del tiempo (24h sin respuesta)
- **Transición**: estado actual + trigger → estado nuevo
- **Tools por estado**: en cada estado el LLM solo ve las tools permitidas.
  `llm.service.ts` filtra el array antes de llamar a OpenAI, así que una tool
  no permitida no se rechaza: no se ofrece

### El flujo se COMPONE, no se escribe

Los dos flujos hardcodeados murieron. Hoy hay tres piezas:

1. **Catálogo** (`src/modules/conversation/nodeCatalog.ts`) — 11 nodos cerrados.
   Cada uno declara `objective`, `steps`, `edgeCases`, `example`, sus `tools`,
   sus `exits` y qué config necesita (`requires`). También vive ahí
   `EMITTED_TRIGGERS`: el registro a mano de qué trigger emite qué archivo.
2. **Composición** — `settings.conversationFlow` (jsonb): qué nodos, en qué
   orden, y los overrides del dueño. Ausente en casi todos los negocios; ahí
   `presetFor(settings)` la deriva de `flowType` + `requiresDeposit`.
3. **Compilador y validador** (`stateMachine.ts`) — `compileFlow` deriva las
   transiciones del orden (`'next'`) más los saltos fijos del blueprint;
   `validateFlow` rechaza una composición que no pueda correr.

**El dueño compone, no inventa.** Nunca dibuja una arista: la deriva el
compilador. Un nodo solo puede ofrecer tools que existen y solo avanza si algo
en el código emite su trigger — esa es la razón por la que `sales` estuvo muerto
meses, con 6 triggers declarados que no emitía nadie.

`validateFlow` es la promesa entera: **un flujo guardado es un flujo que corre.**
Rechaza triggers sin emisor, nodos inalcanzables, nodos sin salida, `requires`
insatisfechos, ids desconocidos o repetidos, e `idle` fuera del primer lugar.

### Presets

```
Agenda sin adelanto  idle→greeting→informing→listado_servicios→show_availability→confirmed
Agenda con adelanto  ...→show_availability→await_payment→await_payment_verification→confirmed
Solo informativo     idle→greeting→informing→listado_servicios
```

**`flowType: 'sales'` recibe hoy el preset informativo**, y "Vende" **sí** se
puede elegir en el panel: saluda, asesora y muestra el catálogo con su material.
Eso corre y es lo que un instituto necesita para informar.

Le falta el final: un trigger que lleve de `listado_servicios` a `collect_data`.
Los tres nodos del cierre —`collect_data`, `confirmacion`, `correccion_datos`—
ya están completos, con sus tools y sus emisores reales en `toolExecutor.ts`; lo
único que no existe es la salida que entra en ellos. **No necesita el
`FrozenBooking` que trababa este ladrillo**: "el cliente eligió el curso X" no
tiene horario, así que no hay `scheduledAtISO` que inventar. Cobrar adentro sí
sigue trabado, porque `await_payment` lleva `entryGuard: 'booking_intent'`.

El único que aplica transiciones sigue siendo `conversationService.applyTrigger`,
que ahora recibe el flujo compilado (`FlowDefinition`) en vez de `flowType`.

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

**El rechazo tiene que viajar con `evidence`.** `await_payment` lleva
`entryGuard: 'booking_intent'`, así que `applyConversationTrigger` pasa
`{ bookingIntent: true }` al emitir `payment_rejected` — la fila rechazada
conserva el servicio, horario y nombre congelados, que es justo lo que el guard
pide. Sin eso la transición se bloquea y el cliente queda clavado en
`await_payment_verification`, cuya única tool es escalar y cuyo prompt le
prohíbe a Emma pedir otra captura. Fue un bug real en producción.

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
- `services[].description`: texto ≤600, opcional. De qué se trata el servicio, en
  palabras del dueño. **Es lo único que Emma tiene para responder "contame más"**:
  sin esto un servicio es nombre, precio y duración, y lo mejor que podía hacer
  era repetir el precio que ya había dado. Vivía en la categoría `servicios` de
  la KB, que está retirada y **filtrada de todas las lecturas que alimentan el
  prompt** — o sea que lo escrito ahí ya no le llega. Va en el ítem, no de vuelta
  al KB: precio y horario tienen forma estructurada y esto no compite con ellos

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
- `service_media` — los archivos de un servicio (imagen, PDF, audio, video).
  `service_id` es TEXT y **sin FK**: los servicios no son filas, viven en el
  jsonb `businesses.settings` con un nanoid. La integridad la sostiene
  `purgeOrphans` en `media/serviceMedia.service`
- `google_credentials`, `events`, `whatsapp_session_guard`

## Multimedia de servicios

Un servicio puede llevar **N archivos**: imagen (5MB), PDF (10MB), audio (5MB)
o video (16MB). Reemplazó a `settings.services[].imageKey`, que era un solo
archivo sin tipo, sin nombre y sin orden.

**El formato se detecta por magic bytes**, nunca por extensión ni content-type:
los dos los pone quien sube. El techo se juzga DESPUÉS del formato, porque
depende de él — 7MB está bien como PDF y no como foto.

Lo que se guarda es la **key**, nunca una URL: el bucket es privado y los links
se firman por una hora a pedido.

### Los dos buckets

```
dev   emma-media-dev    us-east-2
prod  emma-media-prod   us-east-2
```

**Uno por entorno, y no es cosmético.** Las keys arrancan con el `businessId` y
no llevan el entorno, así que si los dos compartieran bucket bastaría con
restaurar un dump de prod en dev para que los ids coincidieran — y ahí el
barrido de huérfanos, corriendo en dev, borraría archivos de clientes reales.
Buckets separados hacen eso imposible sin tocar una línea de código.

El nombre sale de `AWS_S3_BUCKET_NAME`. Se valida su forma en `requireMediaConfig`
antes de cualquier upload: S3 **no admite guiones bajos** ni mayúsculas, y un
nombre inválido fallaría cada subida sin decir por qué.

**Si la región no coincide con la del bucket**, AWS responde `301
PermanentRedirect` y hasta el 2026-09-21 eso llegaba como "No pudimos procesar
el archivo" — un mensaje de error transitorio para un problema de configuración.
Ahora `diagnose()` en `media.service.ts` nombra la causa en el log. Para
averiguar la región real de un bucket:

```bash
curl -sI https://<bucket>.s3.amazonaws.com | grep x-amz-bucket-region
```

### La regla que evita residuos

Dos almacenes tienen que coincidir y solo uno tiene transacciones. **El lado
frágil va adentro de la transacción:**

- **Crear**: primero el objeto, después la fila. Si la fila falla, se borra el
  objeto.
- **Borrar**: la fila se borra dentro de una transacción y el objeto se tira
  ADENTRO de ella. Si S3 se niega, la transacción hace rollback y la fila
  sobrevive. El dueño ve un error y reintenta.
- **Servicio eliminado**: `purgeOrphans` corre en cada guardado de la lista de
  servicios. La lista se reemplaza entera, así que nadie anuncia "este se
  borró" — comparar lo guardado contra lo que la lista todavía nombra es la
  única forma de enterarse.

El id de la fila ES el nombre del objeto en S3, así que fila y objeto se
apuntan por construcción.

### Envío

`send_service_media` → `ToolAttachment[]` → `sendMediaToCustomer` despacha por
tipo a `sendImage` / `sendDocument` / `sendAudio` / `sendVideo`. Todos pasan por
`enqueueSend` y `humanDelay`, y todos sobre **Buffer**, no URL firmada.

**Mandar el material NO es opcional.** Si el cliente pide el detalle de un
servicio marcado `[con material]`, la tool va en ese mismo turno. Era "usar
cuando ayude a mostrarlo" y el resultado era una lotería. **La excepción es
listar**: catálogo → nombre y precio; detalle de UNO → texto y material.

**Tope de 2 adjuntos por turno** (`MAX_ATTACHMENTS_PER_TURN` en
`llm/attachmentQueue.ts`). No es cosmético: cada adjunto es un mensaje saliente y
un número rate-limiteado tumba al negocio entero, no solo las fotos — ya pasó el
2026-07-01. El `display_order` del dueño decide cuáles entran.

Vivía en `toolExecutor`, aplicado sobre la lista de UN servicio, lo cual acota un
servicio y no un turno: el modelo puede llamar la tool una vez por servicio, así
que tres servicios con dos archivos daban seis envíos bajo una constante que
prometía dos. Ahora se aplica en `queueAttachments`, que es el único lugar donde
el turno entero es visible.

**Ventana de repetición: 2 envíos por servicio cada 15 minutos**
(`whatsapp/sentServiceImages.ts`), deslizante y por conversación. Era 1 envío con
memoria de 6 horas, que en un chat de minutos no es "no repitas" sino "nunca
más": un cliente preguntó por el mismo curso 71 minutos después de recibir su
foto y no recibió nada. Cuando la ventana bloquea, Emma **lo dice** — antes se
callaba, y "ya te la mandé" era indistinguible de "esto no tiene foto".

El mapa es en memoria: con dos instancias cada una lleva la suya, misma deuda que
`clientRegistry`.

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
`/asistente` · `/configuracion`. Todas bajo `/:businessId/*`. Para navegar se usa `PanelLink`
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

Hay tres del lado del dueño y una de Vamvu, y no se pisan:

- **Panel del cliente** — lo usa el dueño, repartido en tres pantallas por lo
  que va a buscar:
  * `/asistente` — quién es Emma y cómo conversa: Identidad, Mensajes, Flujo y
    **Conversación** (los nodos). Cuatro cards, cuatro PATCH: `identity`,
    `messages`, `flow`, `conversation`
  * `/servicios` — el catálogo y su dinero: servicios, precios, evaluación
    previa, fotos, formas de pago y adelanto, base de conocimiento
  * `/configuracion` — el negocio: datos, horarios, días especiales, reservas y
    avisos, integraciones

  Escribe por sección, mergeando sobre lo guardado (`settings.merge.ts`). Son 10
  PATCH en total (`settings.routes.ts`), más `GET /settings/conversation/catalog`,
  que le sirve al panel el catálogo de nodos. El catálogo se sirve y NO se
  duplica en el SPA: es el contrato entre lo que el dueño compone y lo que Emma
  corre.
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
- Llamadas en WhatsApp
- Responder con audio grabado por Emma (sí envía audio cargado por el dueño)
- Múltiples sucursales por negocio
- Integraciones con CRM, POS, ERP
- Multi-idioma (solo español de Perú)
- App móvil / notificaciones push
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

- **Editar una cita desde el panel** (reprogramar, drag & drop).
  `rescheduleAppointment` existe en el service pero no está expuesto.
- **`checkAvailability` no está expuesto al panel**: el modal de cita manual
  avisa de los choques al enviar, pero no sugiere horarios libres.
- **Contraste del texto muted** (ver Tema visual).
- `clientRegistry` es un Map en memoria: multi-instancia lo rompe.
- **Los tests del motor de flujos no existen todavía.** Ramas condicionales,
  `advance_flow`, los overrides nuevos y las keys de multimedia por nodo se
  verificaron con scripts descartables, no con vitest. Falta la red automática,
  y sobre todo el snapshot de regresión de los presets de agenda — hoy lo único
  que protege a la clínica y a la barbería es correr esa comparación a mano.
- **Nodos custom**: el dueño compone desde un catálogo cerrado de 11. Crear un
  paso propio desde cero no existe.
- **Borrador y Publicar**: guardar el flujo es publicarlo. No hay versionado de
  la composición ni forma de preparar un cambio sin que salga en vivo.
- **Prod está tres migraciones atrás**: `0020` (`owner_kind` en `service_media`),
  `0019` (`service_media`) y `0017` (`tags`) siguen sin aplicarse ahí. Dev está
  al día hasta la 19; **la 0020 tampoco corrió en dev todavía**.
- `npm run backfill:service-ids` no corrió en ninguna de las dos.
- **Multimedia sin probar contra WhatsApp real.** El envío de PDF, audio y video
  compila y tiene tests de validación, pero ningún archivo salió todavía por
  Baileys.
- **Deuda de formato ajena**: `biome check` marca ~20 archivos sin formatear que
  nadie tocó (`media/*`, `panel/*`, `config/*`). `npm run lint` los arregla, pero
  deja un diff grande y ajeno a lo que estés haciendo.

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
