# Emma / Kuma — Diagnóstico técnico del estado actual

> Generado el 2026-08-17 leyendo el código en `d:\kuma_project` (branch `main`, commit `f27469c`).
> Todo lo afirmado abajo está citado con archivo y línea. Donde el código no permite
> concluir algo, está marcado explícitamente como **[no verificable en código]**.

---

## 1. Arquitectura general

Monolito Node.js de un solo proceso. Un deploy atiende N negocios (multi-tenant por
`business_id`). No hay microservicios, ni colas, ni workers separados: todo corre en el
mismo proceso que sirve HTTP.

### Puntos de entrada

| Entrada | Archivo | Qué hace |
|---|---|---|
| HTTP (Hono) | `src/app.ts` | health, páginas QR/pairing, monta 3 routers |
| Boot + sockets WA | `src/server.ts` | levanta el server, bootea un cliente Baileys por negocio, agenda 2 workers con `setInterval` |
| WhatsApp entrante | `src/modules/whatsapp/handler.ts` | pipeline completo de un mensaje |
| Llamadas WA entrantes | `src/modules/whatsapp/callHandler.ts` | rechaza la llamada + responde por texto |

### Routers HTTP montados (`src/app.ts:25`, `:388`, `:389`)

1. `googleAuthRoutes` — OAuth de Google Calendar (`src/modules/google/auth.routes.ts`)
2. `dashboardRoutes` — panel web HTML server-rendered (`src/modules/admin/dashboard.routes.ts`, 2379 líneas)
3. `adminRoutes` — API JSON admin (`src/modules/admin/admin.routes.ts`)
4. Además, inline en `app.ts`: `/health`, `/admin/whatsapp/qr`, `/admin/whatsapp/pair`

### Módulos y responsabilidades

| Módulo | Rol |
|---|---|
| `modules/whatsapp/` | Baileys client, handler de mensajes, handler de llamadas, clasificación de payloads, registry de sockets en memoria, notificador al dueño, **session guard anti-ban** (política + servicio + repo) |
| `modules/llm/` | Cliente OpenAI, `generateReply` (loop de tools), builder del system prompt del cliente, definiciones de tools, ejecutor de tools |
| `modules/ownerAssistant/` | Flujo paralelo para el dueño: prompt propio, tools propias, ejecutor propio, reporte diario, helpers de timezone |
| `modules/business/` | CRUD de negocios + **`business.settings.ts`** (schema Zod de toda la config operativa) |
| `modules/knowledgeBase/` | CRUD de KB + detector de categorías por keywords + servicio de búsqueda selectiva |
| `modules/appointment/` | Slots, disponibilidad, booking, escalación (¡también vive acá!) |
| `modules/customer/`, `modules/conversation/`, `modules/message/`, `modules/events/` | Persistencia de clientes, hilos, mensajes y log auditable |
| `modules/google/` | OAuth client, credenciales por negocio con refresh, creación/cancelación de eventos |
| `modules/admin/` | Panel HTML + API JSON + repo de métricas del dashboard |
| `modules/demo/` | Perfiles demo (barbería / consultorio dental / spa) aplicables por comando `#demo` |
| `workers/` | `sendReminders` (recordatorios 24h/2h), `cleanupOwnerThread` (borra mensajes >48h del hilo del dueño) |
| `shared/` | `AppError` + subclases, tipo `Result<T>`, `humanDelay` anti-ban |

### Patrón de capas (consistente en todo el repo)

```
routes/handler → service (devuelve Result<T, AppError>) → repo (recibe exec: Executor = db)
```

- Nunca se lanzan excepciones hacia arriba: todo servicio devuelve `Result` (`src/shared/result.ts`).
- Las transacciones se abren en el service y se pasan como `tx` al repo
  (ej. `src/modules/message/message.service.ts:20`, `src/modules/demo/demo.service.ts:28`).
- Excepción a la regla: `SessionGuardError` **sí** se lanza como excepción, y los callers
  la capturan (`src/app.ts:248`, `src/modules/admin/admin.routes.ts:375`).

### Flujo de dependencias notable

`admin.routes.ts` y `dashboard.routes.ts` hacen `await import('@/server.js')` en runtime
para llamar `restartWhatsappFor` (`src/modules/admin/admin.routes.ts:221`,
`src/modules/admin/dashboard.routes.ts:1744`) — import diferido para evitar ciclo
`server → app → routes → server`.

---

## 2. Stack confirmado

Fuente: `package.json`, `tsconfig.json`, `drizzle.config.ts`, `railway.json`, `vitest.config.ts`, `biome.json`.

### Runtime y lenguaje
- **Node.js ≥ 20** (`package.json:8`), ESM (`"type": "module"`)
- **TypeScript 6.0.3**, `strict: true` + `noUncheckedIndexedAccess`, `noUnusedLocals`,
  `noImplicitReturns` (`tsconfig.json`). `npm run typecheck` pasa limpio (verificado).
- Se ejecuta con **tsx**, sin paso de build: `"start": "tsx src/server.ts"` (`package.json:12`).
  En producción corre TypeScript transpilado on-the-fly, no JS compilado.

### Dependencias reales
| Área | Librería | Versión |
|---|---|---|
| HTTP | `hono` + `@hono/node-server` | 4.12.24 / 2.0.4 |
| DB | `drizzle-orm` + `postgres` (postgres-js) | 0.45.2 / 3.4.9 |
| Migraciones | `drizzle-kit` | 0.31.10 (está en `dependencies`, no en dev) |
| WhatsApp | `@whiskeysockets/baileys` | **7.0.0-rc13** (release candidate) |
| LLM | `openai` | 6.42.0 |
| Google | `googleapis` | 173.0.0 |
| Validación | `zod` | 4.4.3 |
| Logs | `pino` + `pino-pretty` | 10.3.1 / 13.1.3 |
| IDs | `nanoid` | 5.1.11 |
| QR | `qrcode` + `qrcode-terminal` | 1.5.4 / 0.12.0 |
| Tests | `vitest` | 4.1.8 |
| Lint/format | `@biomejs/biome` | 2.4.16 |

### ⚠️ Divergencias entre CLAUDE.md y el código real
- **BullMQ y Redis NO están instalados.** No aparecen en `package.json`. `REDIS_URL` existe
  en el schema de env (`src/config/env.ts:13`) pero **no se usa en ningún lado** (grep confirmado:
  solo aparece en la lista de redacción de Pino). Los jobs corren con `setInterval`
  (`src/server.ts:300`, `:315`).
- **El LLM es OpenAI `gpt-4o-mini`, no Claude.** Hardcodeado en dos lugares:
  `src/modules/llm/llm.service.ts:22` y `src/modules/ownerAssistant/ownerAssistant.service.ts:18`.
  No hay ninguna ruta a `gpt-4o` "para casos complejos" como dice CLAUDE.md.
  (El logger todavía redacta `ANTHROPIC_API_KEY` en `src/config/logger.ts:21` — residuo.)
- **`docs/` no existe.** CLAUDE.md referencia `docs/architecture.md`, `docs/db-schema.md`,
  `docs/prompts.md`, `docs/runbook.md`, `docs/clients/<id>.md`. Ninguno existe en el repo.

### Hosting
- **Railway**, builder NIXPACKS, healthcheck en `/health`, restart ON_FAILURE máx 10
  (`railway.json`). Sin Dockerfile.
- URL de producción: `kumaapi-production.up.railway.app` **[dato externo al repo]**.
- **No hay configuración de volumen persistente en `railway.json`.** Las credenciales de
  Baileys se guardan en el filesystem (`SESSIONS_DIR`, default `./sessions`) vía
  `useMultiFileAuthState` (`src/modules/whatsapp/baileys.client.ts:76`). Si Railway no tiene
  un volumen montado en esa ruta, **cada redeploy pierde la sesión y obliga a re-escanear QR**
  — que es exactamente el camino al rate-limit de WhatsApp. **[Verificar en la consola de Railway;
  no es determinable desde el repo.]**

### Variables de entorno (`src/config/env.ts`)
| Var | Requerida | Default | Uso |
|---|---|---|---|
| `NODE_ENV` | no | `development` | |
| `PORT` | no | `3000` | |
| `DATABASE_URL` | **sí** | — | Postgres principal |
| `TEST_DATABASE_URL` | no | — | usada cuando `NODE_ENV=test` |
| `PROD_DATABASE_URL` | no | — | solo para scripts `db:*:prod` |
| `REDIS_URL` | no | — | **declarada pero sin uso** |
| `OPENAI_API_KEY` | **sí** | — | |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | no | — | si faltan, Google falla en runtime con error claro |
| `GOOGLE_REDIRECT_URI` | no | `http://localhost:3000/auth/google/callback` | |
| `SESSIONS_DIR` | no | `./sessions` | credenciales Baileys |
| `ADMIN_SECRET` | no (min 8) | — | si falta, todos los endpoints admin devuelven **501** |
| `KB_SEARCH_MODE` | no | `category` | `semantic` no implementado, cae a `category` |
| `DEMO_ADMIN_PHONE` | no | — | teléfono E.164 habilitado para el comando `#demo` |

---

## 3. Base de datos

PostgreSQL, 9 tablas, 10 migraciones aplicadas (`src/db/migrations/`, journal en
`meta/_journal.json`). Todos los IDs son `text` con `nanoid()` generado en app, no en DB.
Todos los timestamps son `timestamptz`.

### `businesses` — tenants (`src/db/schema/businesses.ts`)
| Columna | Tipo | Notas |
|---|---|---|
| `id` | text PK | nanoid |
| `name` | text NOT NULL | |
| `whatsapp_number` | text NOT NULL **UNIQUE** | número del bot |
| `timezone` | text NOT NULL | default `America/Lima` |
| `system_prompt` | text NULL | **columna muerta: nunca se lee ni se escribe** (grep confirmado) |
| `settings` | jsonb NOT NULL | default `{}`; toda la config operativa |
| `owner_whatsapp_number` | text NULL | routing owner vs customer; indexado |
| `owner_name` | text NULL | usado en el prompt del dueño |
| `address` | text NULL | dirección estructurada, para "¿dónde están?" |
| `google_maps_url` | text NULL | |

### `customers` (`src/db/schema/customers.ts`)
PK `id`; **UNIQUE `(business_id, phone)`**; `name` nullable (viene de `pushName` de WA);
`metadata` jsonb (declarada, **nunca escrita** — el "long-term memory" de CLAUDE.md no existe);
`last_seen_at`.

### `conversations` (`src/db/schema/conversations.ts`)
- `customer_id` **nullable** (los hilos del dueño no tienen cliente).
- `type`: `'customer' | 'owner_thread'` (default `customer`).
- `status`: `'open' | 'closed' | 'escalated'`.
- `last_message_at`, actualizado en cada `messageService.append` dentro de la misma transacción.

### `messages` (`src/db/schema/messages.ts`)
- `role`: `'user' | 'assistant' | 'tool' | 'system'`.
- `tool_calls` jsonb — guarda **la forma cruda de OpenAI**, se reinyecta tal cual al historial.
- `tool_call_id` text.
- FK a `conversations` (cascade) **y** a `businesses` (cascade) — `business_id` denormalizado
  a propósito para poder filtrar por tenant sin join.

### `appointments` (`src/db/schema/appointments.ts`)
- `service` text (string libre, **no FK a un catálogo** — el catálogo vive en `businesses.settings`).
- `scheduled_at` timestamptz, `duration_minutes` int default 30.
- `status`: `'scheduled' | 'confirmed' | 'cancelled' | 'completed'`.
- `google_event_id` nullable (best-effort).
- `reminder_24h_sent_at`, `reminder_2h_sent_at` — anclas de idempotencia del worker.
- Índice compuesto `(business_id, scheduled_at)`.

### `events` — log auditable (`src/db/schema/events.ts`)
`type` text libre + `payload` jsonb. Tipos que el código realmente escribe:
- `escalation` (`appointment.service.ts:613`)
- `paused_blocked_message` (`handler.ts:535`)
- `unsupported_media` (`handler.ts:203`)
- `missed_call` (`callHandler.ts:94`)

### `knowledge_base` (`src/db/schema/knowledgeBase.ts`)
- `category` — enum PG: `ubicacion | servicios | precios | politicas | contacto | informacion_general`
- `attachment_type` — enum: `none | link | image | pdf | video`; `attachment_url` text
- `send_mode` — enum: `always | on_request | trigger_based`; `trigger_keywords` text[]
- `active` boolean
- `embedding` jsonb — **placeholder de RAG, nunca escrito ni leído**. No hay pgvector.
- La migración `0009` eliminó la columna `priority`.

### `google_credentials` (`src/db/schema/googleCredentials.ts`)
Una fila por negocio (**UNIQUE en `business_id`**). Guarda `access_token`, `refresh_token`,
`token_expires_at`, `calendar_id` (default `'primary'`), `connected_email`.
⚠️ **Los tokens se guardan en texto plano, sin cifrar.**

### `whatsapp_session_guard` (`src/db/schema/whatsappSessionGuard.ts`)
Estado anti-ban **keyed por número de teléfono, no por negocio** (UNIQUE en `whatsapp_number`).
`business_id` es informativo y nullable con `ON DELETE set null` a propósito: borrar un negocio
no debe limpiar el cooldown del número. Campos: `last_pairing_code_at`, `last_restart_at`,
`attempt_count`, `attempt_window_started_at`, `blocked_until`, `halt_reason`.

### Relaciones
```
businesses 1─┬─N customers ──1─N conversations ──1─N messages
             ├─N appointments (también FK a customers)
             ├─N conversations
             ├─N messages
             ├─N events (FK opcional a conversations, ON DELETE set null)
             ├─N knowledge_base
             ├─1 google_credentials (UNIQUE)
             └─0..1 whatsapp_session_guard (ON DELETE set null)
```
Todo `ON DELETE cascade` desde `businesses` salvo `whatsapp_session_guard` y
`events.conversation_id`.

### Aislamiento multi-tenant
Verificado repo por repo: **todo lookup individual recibe `businessId` y filtra por él**,
incluso cuando el `id` ya sería único (`knowledgeBase.repo.ts:findById/update/remove`,
`appointment.repo.ts:findById/update`). Las rutas admin planas `/admin/kb/:kbId` fueron
eliminadas por esto mismo (comentario en `admin.routes.ts:280`).

**Única excepción deliberada:** `appointmentRepo.findDueForReminder`
(`src/modules/appointment/appointment.repo.ts:151`) es cross-tenant — el worker barre todos
los negocios y el envío se limita por el registry de clientes.

Hay test de aislamiento: `tests/integration/multi-tenant.test.ts` (5 casos).

---

## 4. Flujo de WhatsApp

### Configuración de Baileys (`src/modules/whatsapp/baileys.client.ts:88-111`)
```ts
makeWASocket({
  auth: state,                       // useMultiFileAuthState(sessionDir)
  version,                           // fetchLatestBaileysVersion() en cada boot
  browser: Browsers.macOS('Desktop'),
  syncFullHistory: false,
  fireInitQueries: false,            // evita cuelgues en cuentas nuevas
  markOnlineOnConnect: false,        // no filtra "last seen"
  defaultQueryTimeoutMs: 180_000,
  emitOwnEvents: false,
})
```
Un socket por negocio, en `${SESSIONS_DIR}/${businessId}`. Logger de Baileys en `info`.

### Boot (`src/server.ts:234`)
1. `businessRepo.findAll()`
2. Por cada negocio, consulta el session guard. Si `blocked` → **no bootea** ese negocio.
   Si el guard es **ilegible** (tabla caída) → **bootea igual** (fail-open deliberado,
   comentario en `server.ts:249-255`), porque bootear con credenciales existentes no es un
   intento de pairing.
3. `startWhatsappFor` cierra el socket previo antes de crear uno nuevo (`server.ts:81`) —
   nunca apilar sockets con el mismo número.

### Manejo de desconexiones (`src/modules/whatsapp/sessionPolicy.ts` + `server.ts:129`)
`classifyDisconnect(statusCode)` devuelve 3 categorías:
- **`halt`** (`loggedOut`, `forbidden`, `connectionReplaced`, `multideviceMismatch`) → para en seco,
  persiste el halt, **no reintenta** (reintentar extiende el rate-limit de WA).
- **`restart_required`** (515) → reconecta en 1s, no gasta presupuesto (es parte normal del pairing).
- **`transient`** → backoff exponencial 5s→10s→20s→40s→80s→160s, máx **6 intentos**, después se rinde.
- Caso aparte: si el estado es `qr_pending`, el cierre es un QR que expiró, no un fallo →
  hasta **20 ciclos** con 2s de espera, sin castigo al número.

### Circuit breaker anti-ban (`sessionPolicy.ts:78-115` + `sessionGuard.service.ts`)
- Ventana rodante de **1 hora**, máximo **5 intentos** (pairing code o restart) → bloqueo de **6 horas**.
- Cooldowns por acción: pairing code **90s**, restart **60s**.
- `recordHalt` distingue "el dueño desvinculó desde el teléfono" de "WA nos está castigando"
  usando el contador de intentos: bloquea solo si hubo **más de 1** intento previo
  (`sessionGuard.service.ts:344`).
- Escape hatch: `POST /admin/businesses/:id/session/force-unblock` exige body literal
  `{"confirm":"I understand this can get the number banned"}` (`admin.routes.ts:57`).

### Pipeline de un mensaje entrante (`src/modules/whatsapp/handler.ts`)

`handleIncomingMessage` (síncrono hasta el lock):
1. Descarta `fromMe`, sin `remoteJid`, grupos (`@g.us`) y `status@broadcast` (`:697-709`)
2. **Deduplicación** por `businessId:messageId`, TTL 60s, Map en memoria (`:715`) — Baileys
   re-entrega mensajes en reconexión, y sin esto el cliente recibía respuestas duplicadas
3. **Extracción de teléfono** (`:270`): soporta `@s.whatsapp.net` y, tras la migración LID de
   WhatsApp, `@lid` — busca el teléfono real en `senderPn` / `remoteJidAlt` / `participant`,
   y si no hay ninguno usa los dígitos del LID como "teléfono sintético" estable
4. **Clasificación** (`messageKind.ts:86`): desenvuelve wrappers (`ephemeralMessage`,
   `viewOnceMessage*`, `documentWithCaptionMessage`, hasta 4 niveles) y devuelve
   `text` / `unsupported(formato)` / `ignorable(protocol|empty|unknown)`.
   ⚠️ Media **con caption** se reporta como `unsupported`, no se lee el caption.
5. **Lock por remitente** `businessId:phone` (`:150`) — serializa mensajes rápidos del mismo
   número para que dos llamadas al LLM no se intercalen

`processMessage` (async):
1. Carga el negocio
2. **Comando `#demo <perfil>`** si el teléfono coincide con `DEMO_ADMIN_PHONE` (`:341`) → aplica
   perfil y corta
3. **Ruteo owner vs customer**: si `phone === business.ownerWhatsappNumber` → `ownerAssistantService.handle`,
   hilo `owner_thread`, sin `humanDelay` (`:360-442`)
4. Flujo cliente: `getOrCreate` customer → `getOrCreateOpen` conversation → persiste el mensaje `user`
5. **Bot pausado** → respuesta canned + escala la conversación + evento `paused_blocked_message`
   + push al dueño (fire-and-forget) (`:506-567`)
6. **Formato no soportado** → aviso con cooldown de **10 min** por conversación; si es **imagen**,
   respuesta específica ("recibí tu foto") + push al dueño sin cooldown (`:570-602`)
7. **Conversación escalada** → el bot se calla; manda "ya avisé al encargado" máx **1 vez por hora**
   (`:608-632`). No llama al LLM.
8. **Flujo normal** → `llmService.generateReply`

### Salida (`sendWithPresence`, `handler.ts:67`)
Anti-ban en 3 capas:
1. `humanDelay()` — 1.5s a 3s aleatorio (`src/shared/humanDelay.ts`)
2. `sendPresenceUpdate('composing')` + 1.5s de espera + envío + `'paused'`
3. Fallos de presencia se tragan en silencio (nunca perder el mensaje por el "escribiendo…")

`sanitizeForWhatsApp` (`handler.ts:98`) convierte Markdown residual del modelo:
`**bold**`→`*bold*`, quita `## headings`, `- item`→`· item`.

Para destinatarios `@lid`, el envío hace `presenceSubscribe` → 800ms → `assertSessions`
antes del `sendMessage` (`baileys.client.ts:200-214`) — patrón necesario para evitar error 463.

### Llamadas entrantes (`callHandler.ts`)
Rechaza la llamada primero (para que el cliente no espere), dedupe por `callId` (TTL 5 min),
registra evento `missed_call`, y si no es el dueño ni el bot está pausado, envía un follow-up
por texto con `sendWithPresence`.

---

## 5. Integración LLM

### Modelo y parámetros
| | Flujo cliente (`llm.service.ts`) | Flujo dueño (`ownerAssistant.service.ts`) |
|---|---|---|
| Modelo | `gpt-4o-mini` (:22) | `gpt-4o-mini` (:18) |
| Temperature | 0.4 | 0.3 |
| max_tokens | 600 (subido desde 300 porque los catálogos se cortaban) | 400 |
| Historial | últimos **20** mensajes | últimos **10** |
| Iteraciones de tools | máx **5** | máx **5** |
| Timeout | 30s vía `AbortSignal.timeout` | 30s |

### Loop de generación (`llm.service.ts:69`)
1. Carga negocio
2. Carga settings — **`NotConfiguredError` NO es fatal**: pasa `null` al prompt builder, que
   inyecta el bloque "negocio sin configuración" (`:86-94`)
3. Valida que la conversación sea de tipo `customer` (defensivo, `:111`)
4. **Búsqueda selectiva de KB** (no manda la tabla entera)
5. Historial reciente (el mensaje del usuario ya fue persistido por el handler)
6. Arma `[system, ...historial]`, entra al loop de hasta 5 iteraciones
7. Persiste cada turno: `assistant` con `tool_calls` crudos, `tool` con el resultado
8. Si agota las 5 iteraciones → auto-escala + mensaje canned (`:355-388`)

### Contexto que recibe el modelo
1. System prompt completo (ver abajo)
2. Historial de hasta 20 mensajes convertido al formato OpenAI (`convertHistoryToChatMessages`,
   `:35`) — los mensajes `system` guardados se saltan, los `tool` sin `toolCallId` se descartan

### Construcción del system prompt (`src/modules/llm/prompts.ts:545`)

**Diseño clave: el prompt está partido en cuerpo estático + cola variable, a propósito, por costo**
(comentario en `:354-361`). El prompt caching de OpenAI solo reutiliza prefijos byte-idénticos,
y tener el saludo aleatorio arriba hacía incacheable ~88% del prompt en cada mensaje.

**Cuerpo estático** (`buildStaticBody`, `:363`), en orden:
1. Identidad — `Eres el asistente de {business.name}`
2. Tono — español peruano, tuteo, 1-3 frases, uso restringido de emojis
3. **Formato WhatsApp** — regla crítica: un asterisco, no dos; `·` no `-`; sin headings Markdown
4. Memoria de contexto de la conversación
5. Razonamiento de fechas — declarar la fecha calculada antes de llamar tools; confirmar
   fecha+hora+servicio antes de `book_appointment`
6. **Conocimiento del negocio** — entradas de KB agrupadas por categoría
7. **Ubicación** — `renderLocationBlock(address, googleMapsUrl)` (`:240`); si faltan ambos,
   instruye explícitamente "no inventes una dirección"
8. **Configuración operativa** — servicios con precio y duración, horarios por día con descansos,
   días especiales futuros, duración de slot. Si no hay settings → `NOT_CONFIGURED_BLOCK` (`:347`)
9. **Precios — 5 casos de respuesta** según cómo `formatServicePrice` renderizó el precio
   (evaluación / desde+evaluación / fijo / rango / desde abierto)
10. Cómo presentar el catálogo (agrupar por categoría, máx 8 por mensaje)
11. Reglas generales (no inventar, no escalar por no saber, escalar llamando la tool en el
    mismo turno, cancelaciones → escalar)
12. Prohibido repetirse
13. Mensajes ambiguos ("Info", un emoji suelto)
14. Servicios no reconocidos
15. **Bloque de disponibilidad — uno de dos, mutuamente excluyentes**:
    `APPOINTMENTS_ONLY_AVAILABILITY_BLOCK` (`:322`) o `HYBRID_AVAILABILITY_BLOCK` (`:331`)

**Cola variable** (`buildVariableTail`, `:502`):
- Fecha, día de semana y **hora actual** en el timezone del negocio
- **Saludo** elegido al azar entre 5 variantes (`GREETING_VARIANTS`, `:82`)
- **Cierre**: instrucción obligatoria de incluir o NO incluir un call-to-action

### Call-to-action decidido en código, no por el modelo (`prompts.ts:129-217`)
Esta es una decisión de diseño explícita: pedirle al modelo que juzgue "¿ya invité hace poco?"
nunca funcionó. `decideCallToAction(history, mode)`:
- Sin turnos de assistant → `welcome`, siempre invita
- Si hubo tráfico de tools en los últimos 4 mensajes → `booking_flow`, **no invita**
- Si pasaron ≥2 turnos silenciosos desde la última invitación → `stalled`, invita
- Si no → `just_answered`, no invita
Las variantes difieren según el modo (`CTA_VARIANTS` vs `HYBRID_CTA_VARIANTS`).

### Búsqueda de knowledge base (`knowledgeBaseSearch.service.ts:32`)
1. `detectCategories(message)` — matching por keywords con normalización de acentos y
   word-boundary (`categoryDetector.ts:157`), scoring por cantidad de keywords, orden descendente
2. En paralelo: entradas activas de esas categorías (**cap de 5**, más viejas primero) +
   todas las `always` / `trigger_based`
3. Filtra: las `on_request` solo entran si su categoría matcheó; las `trigger_based` solo si
   sus keywords pegan en el mensaje
4. Si el detector no matchea nada → fallback a las 5 activas más viejas
5. Dedup por id, orden final por `createdAt`

`searchBySimilarity` (`:78`) existe pero **falla ruidosamente a propósito** — no hay embeddings
ni pgvector. Si `KB_SEARCH_MODE=semantic`, `llm.service.ts:131` loguea un warn y usa igual la
búsqueda por categoría.

### Tools del cliente (`src/modules/llm/tools.ts`)
| Tool | Args | Ejecutor |
|---|---|---|
| `check_availability` | `date_iso`, `service` | `toolExecutor.ts:74` |
| `book_appointment` | `datetime_iso` (con offset), `service` | `:124` |
| `escalate_to_human` | `reason` | `:187` |

El `toolExecutor` (`src/modules/llm/toolExecutor.ts`) traduce errores de dominio a
**instrucciones en español para el modelo**, no a mensajes al cliente:
- `NotConfiguredError` en `check_availability` → "decile con honestidad que no tenés el dato, **NO escales**"
- `NotConfiguredError` en `book_appointment` → "llamá `escalate_to_human`"
- `ValidationError` de servicio desconocido → instrucción larga de no inventar y preguntar con el nombre exacto
- `slot_too_soon` → instrucción con los minutos de anticipación configurados inline
- **`MAX_SLOTS_OFFERED = 2`** (`:66`): aunque haya 20 slots libres, solo cruzan 2 al modelo,
  más un campo `moreSlots` con el conteo restante. La regla de presentación vive acá, no en el dominio.

### Tools del dueño (`src/modules/ownerAssistant/ownerAssistant.tools.ts`)
`get_daily_summary`, `get_appointments`, `pause_bot`, `resume_bot`, **`send_daily_report_now`**
(esta quinta no está documentada en CLAUDE.md). Al final del archivo hay una lista comentada de
tools planeadas para V1.5 (`:100-108`): agregar/editar KB, cancelar/reprogramar cita,
mandar mensaje a cliente, broadcast.

El prompt del dueño (`ownerAssistant.prompts.ts`) es corto: tono telegráfico, lista explícita
de lo que **puede** y lo que **no puede** hacer, regla de pedir confirmación antes de pausar,
y una regla fina sobre memoria de 48h (solo aplicar "ya se limpió" a preguntas del pasado,
nunca a "cómo me llamo").

---

## 6. Sistema de configuración por negocio

### Dónde vive la configuración

| Qué | Dónde | Cómo se edita |
|---|---|---|
| Nombre, número WA, timezone, dueño, dirección, Maps | columnas de `businesses` | panel `/configure`, API PATCH, CLI |
| Horarios, servicios, precios, slot, modo, días especiales, pausa | `businesses.settings` (jsonb) | panel `/configure`, API PUT, CLI, comando `#demo` |
| Info libre (políticas, contacto, promos, "quiénes somos") | tabla `knowledge_base` | panel `/kb`, API, CLI |
| Google Calendar | tabla `google_credentials` | OAuth en `/auth/google/connect?businessId=X` |
| Mensajes canned, saludos, textos de recordatorio, tono | **hardcodeados en código** | requiere deploy |

### Schema de settings (`src/modules/business/business.settings.ts:120`)
```ts
{
  operatingHours: { monday..sunday: { open: "HH:mm", close: "HH:mm",
                                      break?: { start, end } } | null },
  slotDurationMinutes: number,              // entero positivo, requerido
  services: [{ name, durationMinutes|null, priceMin|null, priceMax|null,
               requiresEvaluation: boolean, referenceUrl?: string }],  // mín. 1
  appointmentMode: 'appointments_only' | 'hybrid',   // default appointments_only
  botPaused?: { paused, pausedAt, until?, reason? } | null,
  minBookingNoticeMinutes?: number,         // 0-1440, default 30
  specialDays?: [{ date: "YYYY-MM-DD", hours: DayHours|null, label? }],
}
```
Validaciones cruzadas: `open < close`, break dentro del horario, `priceMax >= priceMin`,
`priceMin` requerido salvo `requiresEvaluation`.

**No hay defaults.** Un negocio sin settings devuelve `NotConfiguredError` y las tools se
degradan con honestidad (esto es feature, documentado en CLAUDE.md y respetado en el código).

### Modelo de precios — 3 formas, 5 renderizados (`formatServicePrice`, `:169`)
| Config | Renderizado | Comportamiento de Emma |
|---|---|---|
| `requiresEvaluation`, sin `priceMin` | `requiere evaluación previa` | no da precio, pide foto o cita de evaluación |
| `requiresEvaluation` + `priceMin` | `desde S/ X (requiere evaluación previa)` | usa "desde" como piso, pide foto igual |
| `priceMin === priceMax` | `S/ X` | precio cerrado |
| `priceMin < priceMax` | `S/ X a S/ Y` | da los dos extremos |
| `priceMax === null` | `desde S/ X` | abierto hacia arriba |

### Alta de un negocio nuevo — flujo real
1. `POST /admin/businesses` (header `X-Admin-Secret`) o panel `/admin/dashboard/new` o
   `npm run admin -- business create --name=X --whatsapp=+51X`
   - Invariante validado en 3 lugares: `ownerWhatsappNumber !== whatsappNumber` — si son iguales
     los mensajes del dueño llegan como `fromMe` y nunca alcanzan al owner assistant
     (`admin.routes.ts:46`, `:193`, `dashboard.routes.ts:1673`)
2. Configurar horarios/servicios/precios en `/admin/dashboard/:id/configure`
3. Cargar entradas de KB en `/admin/dashboard/:id/kb`
4. Vincular WhatsApp: botón **Conectar** → `POST /admin/dashboard/:id/connect` → escanear QR
   en `/admin/whatsapp/qr`
5. (Opcional) Conectar Google Calendar

### Lo que **está hardcodeado** y debería ser configurable
Todos estos son constantes en código; cambiarlos requiere deploy:
- `LLM_FALLBACK_REPLY`, `PAUSED_REPLY`, `OWNER_FALLBACK_REPLY`, `ESCALATED_REPLY` (`handler.ts:22-30`)
- Las 5 variantes de saludo y las 6 de CTA (`prompts.ts:82`, `:98`, `:108`)
- Textos de formato no soportado y de llamada rechazada (`messageKind.ts:137`, `:156`, `:166`)
- Textos de recordatorio 24h/2h (`workers/reminderTexts.ts`)
- **Todo el system prompt** — ~130 líneas de reglas de negocio, tono y formato en `prompts.ts`
- Moneda: **`S/` está hardcodeada** en `formatServicePrice` y repetida en los ejemplos del prompt
- Idioma: español peruano, hardcodeado en prompt y en todos los canned
- Modelo, temperature, max_tokens, límites de historial e iteraciones
- Cooldowns (10 min media, 60 min escalación), `MAX_SLOTS_OFFERED = 2`, `CTA_QUIET_TURNS = 2`
- Ventanas y frecuencia de los workers (15 min, 48h de retención)

---

## 7. Funcionalidades operativas

### ✅ Funciona (implementado y con camino completo)

**Cara al cliente**
- Responder preguntas usando KB + config operativa, con reglas fuertes anti-invención
- Consultar disponibilidad real (`check_availability`) — respeta horarios, descansos, días
  especiales, slots ocupados y anticipación mínima
- Agendar cita (`book_appointment`) — valida día abierto, descanso, anticipación, idempotencia
  de 30s, conflicto de slot; persiste local y espeja a Google (best-effort)
- Escalar a humano (`escalate_to_human`) — marca la conversación + evento + **push al dueño**
- Recordatorios automáticos 24h y 2h antes, con idempotencia por columna
- Rechazar llamadas y responder por texto
- Acusar recibo de audios/imágenes/documentos con cooldown; las **fotos** además se notifican al dueño
- Modo híbrido (walk-in + cita opcional) con flujo conversacional distinto
- Anti-ban: delay humano + indicador "escribiendo…" + dedup + lock por remitente

**Cara al dueño (WhatsApp)**
- Resumen del día, listado de agenda por rango, pausar/reanudar el bot, forzar el reporte diario
- Memoria rodante de 48h con limpieza automática cada hora
- Notificaciones proactivas: escalación, mensaje durante pausa, foto recibida

**Admin**
- Panel HTML: lista de negocios con stats, detalle, configuración completa, CRUD de KB,
  vista de citas por día con cancelación (sincroniza la cancelación a Google), conectar/
  desconectar WA, desconectar Google, limpiar guard
- API JSON admin equivalente + CLI (`npm run admin`)
- Comando `#demo <barberia|consultorio|spa>` desde el teléfono admin

### ⚠️ A medias / con límites conocidos

| Función | Límite real |
|---|---|
| **Cancelar / reprogramar cita** | El bot **no tiene tool**. El prompt le ordena escalar al dueño (`prompts.ts:474`). Solo se cancela desde el panel admin. |
| **Detección de conflictos de slot** | Comparación por **instante exacto** (`appointment.service.ts:234`, con el comentario admitiéndolo). Un servicio de 90 min ocupa un solo punto en la grilla: los slots que atraviesa siguen figurando como libres. **Riesgo real de doble booking.** |
| **Google Calendar como fuente de verdad** | `checkAvailability` **solo mira `appointments` locales**. Si el dueño agenda algo directo en su Google Calendar, Emma no lo ve y puede ofrecer ese horario. |
| **Adjuntos de KB** | `attachmentUrl` se renderiza como texto dentro del prompt (`prompts.ts:20`). **Nunca se envía media por WhatsApp** — el bot solo manda texto. |
| **Media entrante** | No hay transcripción de audio ni visión. Se acusa recibo y, para fotos, se avisa al dueño. |
| **Salir del estado escalado** | **No existe.** Ni tool, ni botón en el panel, ni endpoint. Una conversación escalada queda muda hasta que pasan 24h sin mensajes y `getOrCreateOpen` abre un hilo nuevo (`conversation.service.ts:781`). |
| **Búsqueda semántica de KB** | No implementada. La columna `embedding` está vacía. El cap de 5 entradas por categoría descarta las más nuevas en silencio (el panel avisa al operador, el bot no). |
| **Reporte diario automático** | No hay cron. El dueño lo pide con `send_daily_report_now`. |
| **`businesses.system_prompt`** | Columna existente, nunca leída. No se puede personalizar el prompt por negocio. |
| **`customers.metadata`** | Columna existente, nunca escrita. No hay memoria de largo plazo del cliente. |

### ❌ No existe
Pagos, envío de media, multi-sucursal, multi-idioma, CRM/POS, app móvil, broadcast,
mensajes proactivos a clientes fuera de recordatorios.

---

## 8. Nichos / templates

### Perfiles hoy en código (`src/modules/demo/demoProfiles.ts`)

| Key | Negocio | Slot | Servicios | Horarios |
|---|---|---|---|---|
| `barberia` | Imperio Barber Studio | 15 min | 14 (corte, barba, tinte, cejas…) | L-S 09:30-21:30, dom cerrado |
| `consultorio` | **Dental Smile** | 30 min | 6 (consulta, limpieza, blanqueamiento, extracción, curación, radiografía) | L-V 08:00-17:00 con break 13-14, sáb 08:00-13:00; `minBookingNoticeMinutes: 60` |
| `spa` | Bella Vida Salón & Spa | 30 min | 10 (uñas, pestañas, cejas, facial) | L-S 09:00-20:00, dom 09:00-15:00 |

**Ya existe un template dental funcional.** Se activa mandando `#demo consultorio` desde
`DEMO_ADMIN_PHONE`, lo que reemplaza nombre + settings + toda la KB del negocio en una transacción
(`demo.service.ts:28`).

### Cliente productivo
Imperio Barber Studio (barbería) **[dato externo al repo]**. El código no tiene nada específico
de barbería: la única "personalidad de nicho" viene de los datos (settings + KB).

### Qué falta realmente para dental

Poco a nivel de motor — mucho a nivel de dominio clínico:

**Ya sirve tal cual:**
- Servicios con duración variable, breaks de almuerzo, anticipación mínima de 60 min
- Precios por rango y `requiresEvaluation` (encaja perfecto con "depende de la evaluación")
- Escalación, recordatorios, agenda del dueño

**Hay que agregar:**
1. **Corregir el solapamiento de slots** — crítico en dental, donde los servicios van de 15 a 90 min.
   Con la comparación por instante exacto, una limpieza de 60 min no bloquea el slot de +30 min.
2. **Keywords del detector de categorías** (`categoryDetector.ts:12`): el vocabulario es de
   peluquería (`corte`, `tinte`, `promocion`). Faltan `dolor`, `muela`, `diente`, `caries`,
   `ortodoncia`, `brackets`, `implante`, `urgencia`, `emergencia`, `seguro`, `cobertura`, `radiografía`.
3. **Categoría de KB nueva o reuso**: seguros/coberturas no encaja limpio en las 6 categorías
   actuales. Agregarla es un `ALTER TYPE` del enum PG + labels — el resto se propaga solo
   (`knowledgeBase.types.ts` es la única fuente de verdad).
4. **Manejo de urgencias**: hoy no hay noción de triaje. Un "me duele mucho la muela" debería
   escalar o priorizar; hoy entra por el flujo normal.
5. **Tono**: el prompt dice "cálido, tuteo, emojis moderados". Para dental probablemente convenga
   un registro más clínico. Hoy eso significa editar `prompts.ts` — no hay override por negocio
   (ver `businesses.system_prompt`, columna muerta).
6. **Disclaimer médico**: no hay ninguna regla que impida a Emma opinar sobre síntomas.
   El prompt le prohíbe inventar precios y horarios, no le prohíbe dar consejo clínico.
7. **Primera consulta vs control**: sin concepto de historial de paciente
   (`customers.metadata` sin usar).

---

## 9. Deuda técnica y gaps

Ordenado por severidad.

### 🔴 Crítico

1. **Doble booking por solape de servicios largos** — `appointment.service.ts:231-234`.
   `takenInstants` es un `Set` de instantes exactos. Un servicio de 90 min con grilla de 30
   deja 2 slots atravesados marcados como libres. El propio comentario del código lo reconoce
   como deuda del "Día 7".

2. **Disponibilidad ciega al Google Calendar real** — `checkAvailability` no consulta
   `freebusy` de Google. Si el dueño bloquea tiempo en su calendario, Emma sigue ofreciéndolo.
   El espejo es unidireccional (app → Google), nunca al revés.

3. **Persistencia de la sesión de WhatsApp en filesystem** — `useMultiFileAuthState`
   (`baileys.client.ts:76`) sobre `SESSIONS_DIR`, y `railway.json` no declara volumen. En un
   filesystem efímero, cada redeploy exige re-pairing, que es precisamente lo que dispara el
   rate-limit de WhatsApp que el session guard existe para evitar. **Verificar el volumen en Railway.**

4. **`ADMIN_SECRET` viaja en la query string** en todo el panel (`?secret=...`, ej.
   `dashboard.routes.ts:49`). Queda en logs de acceso, historial del navegador y referers.
   El API JSON sí usa header (`X-Admin-Secret`), el panel HTML no.

5. **Sin estado multi-instancia** — `clientRegistry` es un `Map` en memoria del proceso
   (`clientRegistry.ts:6`, con el comentario admitiéndolo). Igual que los Maps de dedup,
   cooldowns de aviso y locks de remitente. Escalar a 2 réplicas rompe: sockets duplicados
   por número (= ban), recordatorios duplicados, dedup inefectivo.

6. **Tokens de Google en texto plano** — `google_credentials.access_token` / `refresh_token`
   sin cifrar. Un dump de la DB entrega los calendarios de todos los clientes.

### 🟠 Alto

7. **Conversación escalada sin salida** — no hay forma de devolver una conversación a `open`.
   Ni UI, ni endpoint, ni tool. El bot queda mudo para ese cliente hasta que pasen 24h
   (`conversation.service.ts:781`).

8. **Precios duplicados en dos fuentes** — `settings.services[].priceMin/priceMax` **y**
   entradas de KB categoría `precios`. Los perfiles demo ponen todos los servicios como
   `requiresEvaluation: true` con precio `null` y los precios reales solo en la KB
   (`demoProfiles.ts:23-31`). Si divergen, el prompt le da al modelo dos verdades contradictorias.

9. **El comando `#demo` es destructivo** — borra toda la KB del negocio y pisa nombre y settings
   (`demo.service.ts:28-44`). Solo lo protege la comparación con `DEMO_ADMIN_PHONE`. No hay
   confirmación, ni backup, ni restricción a negocios marcados como demo. Un `#demo spa` mandado
   al negocio equivocado destruye la configuración productiva.

10. **Ventanas de recordatorio: doc ≠ código.** CLAUDE.md dice `[now+23h, now+25h)` y
    `[now+1.5h, now+2.5h)`. El código usa `[now+23h, now+24h]` y `[now+1.5h, now+2h]`
    (`sendReminders.ts:80-89`). Con poll cada 15 min la ventana de 1h y de 0.5h alcanza, pero
    la documentación es incorrecta.

11. **Recordatorios sin reintento** — si no hay cliente WA registrado en ese instante, el
    recordatorio se cuenta como error y **nunca se reintenta**; en el próximo ciclo la cita ya
    puede haber salido de la ventana. Se pierde silenciosamente (`sendReminders.ts:108`).

12. **CSRF ausente en el OAuth de Google** — `state = businessId` literal, sin nonce
    (`auth.routes.ts:57`, con el trade-off documentado en el comentario).

13. **CSRF ausente en el panel** — todas las mutaciones son `POST` de formulario autenticadas
    solo por el secret en la URL. Sin token anti-CSRF, sin SameSite (no hay cookies).

### 🟡 Medio

14. **Sin build step en producción** — `npm start` corre `tsx src/server.ts`. Se transpila en
    cada arranque; errores de tipo no bloquean el deploy (no hay CI que corra `npm run check`;
    tampoco hay `.github/workflows`).

15. **Baileys en release candidate** (`7.0.0-rc13`) en producción.

16. **Cobertura de tests desigual** — 125 casos en 15 archivos, pero **sin tests** para:
    `handler.ts` (768 líneas, el corazón del sistema), `toolExecutor.ts`, `messageKind.ts`,
    `callHandler.ts`, `sessionPolicy.ts`, `sessionGuard.service.ts`, `dashboard.routes.ts`,
    `demo.service.ts`. Las áreas mejor cubiertas son `appointment` (26), `business.settings` (15)
    y `knowledgeBaseSearch` (10).

17. **`dashboard.routes.ts` con 2379 líneas** — HTML, CSS, parsing de formularios, lógica de
    negocio y llamadas al registry de WhatsApp en un solo archivo.

18. **Columnas muertas**: `businesses.system_prompt`, `customers.metadata`,
    `knowledge_base.embedding`. Las tres declaradas, ninguna usada.

19. **`REDIS_URL` declarada sin uso**; `logger.ts:21` todavía redacta `ANTHROPIC_API_KEY`
    aunque el proyecto usa OpenAI.

20. **Sin `docs/`** — CLAUDE.md referencia 5 documentos que no existen (`architecture.md`,
    `db-schema.md`, `prompts.md`, `runbook.md`, `clients/`). El `README.md` son 34 bytes de
    basura UTF-16.

21. **Sin `.env.example`** — está en `.gitignore` (línea 10), así que un dev nuevo no tiene
    plantilla de configuración.

22. **`drizzle-kit`, `tsx` y `typescript` en `dependencies`**, no en `devDependencies`.
    Correcto dado que producción corre con tsx, pero infla la imagen.

23. **Media con caption se descarta** — `messageKind.ts:86` clasifica como `unsupported` toda
    imagen, incluso si el caption trae texto útil ("¿cuánto cuesta esto?").

24. **Sin rate-limit propio por cliente** — nada impide que un número mande 200 mensajes y
    dispare 200 llamadas al LLM. El lock por remitente serializa, no limita.

25. **Sin métricas ni alertas** — hay logs estructurados y la tabla `events`, pero ningún
    endpoint de métricas, dashboard de errores ni alerta cuando un negocio queda desconectado.

### 🟢 Menor
- El detector de categorías es determinista por keywords: no reconoce sinónimos ni errores de
  tipeo fuera de la lista.
- Cap de 5 entradas de KB por categoría descarta silenciosamente las más nuevas
  (`knowledgeBaseSearch.service.ts:9`).
- Historial del cliente fijo en 20 mensajes, sin resumen: las conversaciones largas pierden
  el principio.
- `cleanupOwnerThread.ts` usa `sql.raw` con interpolación de constante — seguro hoy, frágil como patrón.
- Mensajes de commit inconsistentes (`aaaa`, `asa`, `fix`, `fix`, `fix`) contra la convención
  de CLAUDE.md.

---

## 10. Estructura de archivos

```
d:\kuma_project\
├── CLAUDE.md                       Instrucciones del proyecto ⚠️ desactualizado (ver §2)
├── package.json                    Scripts, deps. Sin build step.
├── tsconfig.json                   TS estricto, paths @/* → src/*
├── drizzle.config.ts               Apunta a src/db/schema/index.ts, out src/db/migrations
├── railway.json                    NIXPACKS, npm start, healthcheck /health
├── biome.json                      Lint + format
├── vitest.config.ts                fileParallelism: false (DB compartida)
├── .env                            No versionado
├── README.md                       34 bytes, basura
│
├── scripts/                        Todos ejecutables con tsx
│   ├── admin.ts                    CLI: business/kb create, update, settings (384 líneas)
│   ├── create-test-business.ts     Seed rápido
│   ├── run-with-db.mjs             Wrapper para apuntar drizzle-kit a otra DB
│   ├── verify-prod-columns.ts      Chequeo de drift de schema en prod
│   └── smoke-*.ts                  9 smoke tests manuales (db, llm, tools, google,
│                                   owner, notifications, reminders, settings, conversation)
│
├── sessions/                       Credenciales Baileys por businessId (gitignored)
│
├── src/
│   ├── app.ts                      Hono app: /health, /admin/whatsapp/qr, /pair, monta routers
│   ├── server.ts                   Boot: sockets WA por negocio, política de reconexión,
│   │                               2 workers con setInterval, shutdown. Exporta restartWhatsappFor.
│   │
│   ├── config/
│   │   ├── env.ts                  Schema Zod de env; process.exit(1) si es inválido
│   │   └── logger.ts               Pino con redacción de secretos
│   │
│   ├── db/
│   │   ├── client.ts               postgres-js + drizzle; tipos Db, Tx, Executor
│   │   ├── migrate.ts              Runner de migraciones
│   │   ├── migrations/             10 migraciones SQL + snapshots
│   │   └── schema/                 9 tablas, una por archivo + index.ts que re-exporta
│   │
│   ├── modules/
│   │   ├── admin/
│   │   │   ├── admin.routes.ts     API JSON, auth por header X-Admin-Secret (436 líneas)
│   │   │   ├── dashboard.routes.ts Panel HTML completo (2379 líneas) ⚠️ monolito
│   │   │   └── dashboard.repo.ts   Queries agregadas de métricas
│   │   ├── appointment/
│   │   │   ├── appointment.service.ts  checkAvailability, bookAppointment, escalate (655)
│   │   │   ├── appointment.repo.ts     incluye findDueForReminder cross-tenant
│   │   │   └── appointment.test.ts     26 casos — el módulo mejor cubierto
│   │   ├── business/
│   │   │   ├── business.settings.ts    ⭐ Schema Zod de TODA la config operativa
│   │   │   ├── business.service.ts     getSettings, updateSettings (merge shallow), isBotPaused
│   │   │   └── business.repo.ts
│   │   ├── conversation/           getOrCreateOpen (reusa escaladas <24h), findOrCreateOwnerThread
│   │   ├── customer/               getOrCreate por (businessId, phone)
│   │   ├── demo/
│   │   │   ├── demoProfiles.ts     ⭐ 3 templates de nicho: barberia, consultorio, spa
│   │   │   └── demo.service.ts     Aplica perfil en una transacción (destructivo)
│   │   ├── events/                 Log auditable
│   │   ├── google/                 OAuth client, credenciales con refresh, calendar service, rutas
│   │   ├── knowledgeBase/
│   │   │   ├── categoryDetector.ts      ⭐ Keywords → categorías (vocabulario de peluquería)
│   │   │   ├── knowledgeBaseSearch.ts   Búsqueda selectiva; searchBySimilarity NO implementada
│   │   │   ├── knowledgeBase.types.ts   Fuente única de enums y labels
│   │   │   └── knowledgeBase.repo/service.ts
│   │   ├── llm/
│   │   │   ├── prompts.ts          ⭐ System prompt del cliente (562 líneas) + decideCallToAction
│   │   │   ├── llm.service.ts      Loop de tools, máx 5 iteraciones, auto-escala
│   │   │   ├── tools.ts            3 definiciones de tools OpenAI
│   │   │   ├── toolExecutor.ts     Errores de dominio → instrucciones en español al modelo
│   │   │   └── openai.client.ts
│   │   ├── message/                append transaccional (mensaje + last_message_at)
│   │   ├── ownerAssistant/
│   │   │   ├── ownerAssistant.prompts.ts    Prompt del dueño (37 líneas)
│   │   │   ├── ownerAssistant.tools.ts      5 tools + lista comentada de V1.5
│   │   │   ├── ownerAssistant.toolExecutor.ts
│   │   │   ├── ownerAssistant.service.ts    Loop propio, historial de 10
│   │   │   ├── dailyReport.ts               Texto del reporte diario
│   │   │   └── timezone.ts                  dayRangeInTimezone, shiftDateISO
│   │   └── whatsapp/
│   │       ├── baileys.client.ts   ⭐ Config del socket, close() vs logout()
│   │       ├── handler.ts          ⭐ Pipeline completo (768 líneas) — SIN TESTS
│   │       ├── callHandler.ts      Rechazo de llamada + follow-up
│   │       ├── messageKind.ts      Clasificación pura de payloads + textos canned
│   │       ├── sessionPolicy.ts    ⭐ Política anti-ban pura (clasificación, backoff, breaker)
│   │       ├── sessionGuard.service/repo.ts  Estado anti-ban persistido por número
│   │       ├── clientRegistry.ts   Map en memoria businessId → socket ⚠️ single-instance
│   │       └── ownerNotifier.ts    Push proactivo al dueño
│   │
│   ├── shared/
│   │   ├── errors.ts               AppError + NotFound/Validation/Conflict/NotConfigured/
│   │   │                           NotConnected/SessionGuard
│   │   ├── result.ts               Result<T, AppError>
│   │   └── humanDelay.ts           1.5-3s aleatorio, anti-ban
│   │
│   └── workers/
│       ├── sendReminders.ts        Cada 15 min; ventanas 24h y 2h
│       ├── reminderTexts.ts        Formateo es-PE de fecha/hora
│       └── cleanupOwnerThread.ts   Cada hora; borra mensajes >48h de owner_thread
│
└── tests/
    ├── helpers/db.ts               Truncate + seed
    └── integration/multi-tenant.test.ts   5 casos de aislamiento por business_id
```

### Archivos a leer primero para entender el sistema
1. `src/modules/whatsapp/handler.ts` — todo el flujo de un mensaje
2. `src/modules/llm/prompts.ts` — todo el comportamiento conversacional
3. `src/modules/business/business.settings.ts` — el modelo de configuración
4. `src/modules/appointment/appointment.service.ts` — la lógica de agenda
5. `src/modules/whatsapp/sessionPolicy.ts` — por qué el sistema no banea números

---

## Verificaciones ejecutadas
- `npm run typecheck` (`tsc --noEmit`) → **pasa sin errores**
- `grep console.log` en `src/` → **0 resultados**
- 5 TODOs en el código, todos referidos a la migración a BullMQ y a RAG
- No se corrieron los tests (`npm test` requiere `TEST_DATABASE_URL` activo)
