# Plan de ejecución — Emma_spec_v2 (nodos + multimedia multi-tipo)

> Plan, no spec. Responde: qué archivos toco, cómo queda el panel, cómo queda el
> system prompt, y qué necesito de vos antes de arrancar.
> Escrito el 2026-09-21, después de auditar `prompts.ts` y comparar `Emma_spec_v2.md`
> contra el código en la rama `dev`.

---

## El diagnóstico en una línea

La finalidad es que el corazón sea la máquina de estados, pero **hoy el corazón es
el prompt**: `StateConfig.promptAddition` es un wstring plano que aporta una oración
por estado, mientras `prompts.ts` (1513 líneas) lleva el flujo completo y lo manda
idéntico en todos los estados.

Medido, no estimado:

- **6 de 14 triggers declarados no los emite nadie**: `asks_info`, `picks_time`,
  `inactive_24h`, `shows_interest`, `accepts_offer`, `data_complete`.
- `appointments` pierde `informing` y `choose_time` pero funciona.
- **`sales` está muerto entero**: la única salida de `greeting` es `asks_info`, sin
  emisor. Un negocio de ventas queda atascado en `greeting` para siempre, con solo
  `send_service_image` y `escalate_to_human`.
- Las reglas del adelanto están escritas **tres veces** y el árbol de disponibilidad
  **dos**. No es descuido: es que el estado no tiene dónde guardarlas.

Los nodos de cuatro campos de `Emma_spec_v2` son ese lugar. Por eso este plan y la
auditoría del prompt son el mismo trabajo.

---

## Paso 0 — Mitigar el bug de "Vende"

El selector Función → "Vende" escribe `flowType: 'sales'`, o sea manda el negocio al
flujo muerto. Además contradice el test de
`src/modules/panel/settings.merge.test.ts:189`, que afirma que `flowType` "no es del
dueño cambiarlo" (sigue pasando solo porque no cubre el schema nuevo).

**Archivos:** `src/panel/components/assistant/IdentitySettings.tsx`

**Cambio:** "Vende" queda visible pero deshabilitado con el badge Próximamente,
igual que los otros cinco campos. Se habilita en el Paso 2.

~10 líneas. Es lo único urgente de todo el plan.

---

## Paso 1 — Nodos con cuatro campos

### Qué cambia en el tipo

```ts
// hoy — src/modules/conversation/stateMachine.ts
export interface StateConfig {
  tools: string[]
  promptAddition: string          // ← una oración
  transitions: Record<string, string>
  entryGuard?: EntryGuard
}

// después
export interface ConversationNode {
  objective: string               // OBJETIVO
  steps: string[]                 // PASOS
  edgeCases: string[]             // INSTANCIAS ADICIONALES
  example: string                 // EJEMPLO DE RESPUESTA
}

export interface StateConfig {
  tools: string[]
  node: ConversationNode          // reemplaza promptAddition
  transitions: Record<string, string>
  entryGuard?: EntryGuard
}
```

### Los 8 nodos que son estados de verdad

De los 11 de `Emma_spec_v2`, **tres no son nodos de conversación** y no deben
volverse estados:

| Nodo spec_v2 | Por qué no es estado | Dónde vive hoy (y está bien) |
|---|---|---|
| `decision_pago` | No habla — el spec mismo dice "no genera mensaje". Es un `if` | gate en `toolExecutor.ts` |
| `derivacion_humano` | Transversal: se activa desde cualquier punto | tool + `conversation.status='escalated'` |
| `fuera_de_horario` | Transversal | `outOfHoursBlock` en `prompts.ts` |

Como estados, los dos transversales obligarían a declarar 9 aristas de ida y 9 de
vuelta que no dicen nada.

Mapeo de los 8 que sí:

| Nodo spec_v2 | Estado | Estado |
|---|---|---|
| `inicio_saludo` | `greeting` | existe |
| `pregunta_asesoria` | `informing` | existe, inalcanzable |
| `listado_servicios` | — | **nuevo** (hoy vive en el prompt) |
| `metodos_pago` | `await_payment` | existe |
| `verificacion_pago` | `await_payment_verification` | existe |
| `captura_datos` | `collect_data` | existe solo en sales, inalcanzable |
| `correccion_datos` | — | **nuevo** |
| `confirmacion` | — | **nuevo** |
| `despedida` | `confirmed` | existe |

**Archivos:**

| Archivo | Cambio |
|---|---|
| `src/modules/conversation/stateMachine.ts` | `StateConfig`, `ConversationNode`, los 8 nodos en los dos flujos |
| `src/modules/llm/prompts.ts` | `renderNodeBlock(node)` nuevo |
| `src/modules/llm/llm.service.ts` | pasa `stateConfig.node` en vez del string (líneas 254-259) |

Sin tocar transiciones en este paso.

---

## Paso 2 — Emisores de trigger (acá revive `sales`)

El cuello real. Los estados son data y son fáciles; lo que falta es que alguien
emita los triggers. Hoy los que funcionan nacen de efectos de tools
(`check_availability → asks_availability`) o de eventos del código.

**Recomendación: el trigger nace de una tool**, no de un clasificador aparte. Es el
patrón que ya usa el repo, no agrega una segunda llamada al LLM por mensaje, y tiene
la propiedad que el canvas necesita: un nodo solo puede avanzar si su tool existe.

Tools nuevas y qué trigger emite cada una:

| Tool | Trigger | Nodo que desbloquea |
|---|---|---|
| `show_services` | `asks_info` | `informing` / `listado_servicios` |
| `save_customer_data` | `data_complete` | `captura_datos` → `confirmacion` |
| `confirm_summary` | (confirma o va a corrección) | `confirmacion` |
| `correct_field` | — | `correccion_datos` |

`shows_interest` y `accepts_offer` los emite `show_services` según el argumento, o
tools propias del flujo sales — a definir cuando toque, no antes.

**Archivos:**

| Archivo | Cambio |
|---|---|
| `src/modules/llm/tools.ts` | definiciones nuevas + `KUMA_TOOL_NAMES` |
| `src/modules/llm/toolExecutor.ts` | branches nuevos, cada uno devolviendo su `trigger` |
| `src/modules/conversation/stateMachine.ts` | `tools` por estado y transiciones |
| `src/modules/customer/customer.service.ts` | persistir los datos de `save_customer_data` |

**Ojo:** `save_customer_data` resuelve además un pendiente que CLAUDE.md ya lista —
"el nombre del cliente solo se persiste al agendar".

---

## Paso 3 — Mover la prosa de flujo global a los nodos

Acá se cobra el ahorro de tokens y muere la duplicación de la auditoría.

### Cómo queda el system prompt

**Hoy — dos capas, y el nodo suelto al final:**

```
┌─ cuerpo estático (~3.7k tok, cacheable, IGUAL en todos los estados) ─┐
│ # Identidad · # Tono · # Formato · # Memoria · # Razonamiento fechas │
│ # Flujo de reserva PASO 1-5          ← 35 líneas, en TODOS los estados
│ # Nombre del paciente · # Confirmación de citas pendientes           │
│ # Fluidez conversacional             ← duplica el árbol de disponibilidad
│ # Ubicación · Config operativa · # Precios                           │
│ # Cómo presentar el catálogo         ← es el nodo listado_servicios
│ # Reglas generales · # Prohibido repetirte · # Mensajes ambiguos      │
│ # Servicios no reconocidos · Voz de nicho · Tono configurado          │
│ Disponibilidad por modo              ← es el nodo show_availability
│ Aprobación · Adelanto (×3 lugares)   ← la triple duplicación
│ Instrucciones del dueño · # Conocimiento del negocio                 │
└──────────────────────────────────────────────────────────────────────┘
[cola variable: fecha/hora · cita pendiente · fuera de horario · saludo · CTA]
[# Paso actual de la conversación: UNA oración]
```

**Después — tres capas por estabilidad:**

```
┌─ 1. DEL NEGOCIO (cacheable, cambia cuando el dueño guarda) ──────────┐
│ Jerarquía de reglas (nueva, resuelve los 4 bloques que hoy dicen      │
│   ser la autoridad final) · Identidad · Voz · Formato · Servicios     │
│   Horarios · Adelanto (UNA vez) · Reglas generales · KB               │
└──────────────────────────────────────────────────────────────────────┘
[ 2. DEL TURNO: fecha/hora · cita pendiente · fuera de horario · CTA ]
[ 3. DEL NODO: OBJETIVO · PASOS · INSTANCIAS · EJEMPLO ]
```

**El nodo queda último, no antes de la cola.** Moverlo antes ganaría caché entre dos
mensajes del mismo nodo, pero pierde la posición final, que es donde una instrucción
pesa más. Para 200-400 tokens el canje no conviene.

La ganancia no está en reordenar: está en que **un negocio en `await_payment` deja de
recibir las 35 líneas del árbol de disponibilidad**.

### Lo que sale del cuerpo estático y a dónde va

| Bloque hoy | Destino |
|---|---|
| `# Flujo de reserva PASO 1-5` | PASOS de `show_availability`, `captura_datos`, `metodos_pago` |
| `# Cómo presentar el catálogo` | PASOS de `listado_servicios` |
| `APPOINTMENTS_ONLY_AVAILABILITY_BLOCK` | PASOS de `show_availability` |
| `# Fluidez conversacional` | se recorta a la regla 4, que sí es aporte propio |
| `clinicalBlocks` → `# Pagos y comprobantes` | se borra; queda solo `depositOrderBlock` |
| `PASO 4` del flujo de reserva | puntero de una línea |
| `VARY_PHRASING_BLOCK` + `# Prohibido repetirte` + regla de `# Memoria` | un solo `# No te repitas` |

**Archivo:** `src/modules/llm/prompts.ts` (el grande de este paso).

### Un hueco de comportamiento que esto arregla

`clinicalBlocks` es **la única** de las tres copias que explica cuándo llamar
`request_image`, y solo la reciben `dental` y `salud`. **Una barbería con adelanto
nunca recibe esa instrucción**, aunque sí recibe las otras dos. Eso no es tokens
repetidos: es un bug por nicho.

---

## Paso 4 — Cómo queda el panel

El canvas no hace falta para dar valor. Cuatro escalones:

### Escalón 1 — hecho (Fase 3)

Tab **Asistente** con tres cards: Identidad · Mensajes · Flujo. El dueño configura
*parámetros* del flujo, no el flujo.

### Escalón 2 — este plan: card "Conversación"

```
┌─ Asistente ─────────────────────────────────────────────────┐
│ ▸ Identidad          (ya existe)                            │
│ ▸ Mensajes           (ya existe)                            │
│ ▸ Flujo              (ya existe)                            │
│ ▾ Conversación       ← NUEVO                                │
│                                                              │
│   Los pasos que sigue Emma, en orden. Podés ajustar el       │
│   ejemplo y los casos especiales de cada uno.                │
│                                                              │
│   ┌──────────────────────────────────────────────────────┐   │
│   │ 1 · Saludo inicial                          [▾]      │   │
│   │     Objetivo: dar la bienvenida e identificar la      │   │
│   │               intención del cliente        (fijo)     │   │
│   │     Pasos:    1. Saludar con el nombre del asistente  │   │
│   │               2. Preguntar en qué puede ayudar (fijo) │   │
│   │     Casos especiales:        [ textarea editable ]    │   │
│   │     Ejemplo de respuesta:    [ textarea editable ]    │   │
│   └──────────────────────────────────────────────────────┘   │
│   ┌──────────────────────────────────────────────────────┐   │
│   │ 2 · Asesoría                                [▸]      │   │
│   ├──────────────────────────────────────────────────────┤   │
│   │ 3 · Listado de servicios                    [▸]      │   │
│   │ 4 · Métodos de pago          (si pedís adelanto)     │   │
│   │ 5 · Verificación de pago     (si pedís adelanto)     │   │
│   │ 6 · Captura de datos                        [▸]      │   │
│   │ 7 · Confirmación                            [▸]      │   │
│   │ 8 · Despedida                               [▸]      │   │
│   └──────────────────────────────────────────────────────┘   │
│                                                              │
│   Transversales (desde cualquier paso, no se reordenan):     │
│   · Derivación a humano    · Fuera de horario                │
│                                                              │
│                                    [ Guardar cambios ]       │
└──────────────────────────────────────────────────────────────┘
```

**Editable:** el EJEMPLO y las INSTANCIAS ADICIONALES de cada nodo — texto, igual
que la card Mensajes, y es lo que más mueve el comportamiento del modelo.
**No editable:** OBJETIVO, PASOS y transiciones. Ese es el motor.

Los nodos de pago aparecen atenuados cuando `requiresDeposit` está en off: el dueño
ve por qué Emma no los usa, en vez de que desaparezcan sin explicación.

**Archivos:**

| Archivo | Cambio |
|---|---|
| `src/modules/business/business.settings.ts` | `nodes: Record<string, {edgeCases?, example?}>` — solo los overrides del dueño, no el nodo entero |
| `src/modules/panel/settings.merge.ts` | `nodesPatchSchema` vía `patchable()` |
| `src/modules/panel/settings.service.ts` | `updateNodes` |
| `src/modules/panel/settings.routes.ts` | `PATCH /settings/nodes` |
| `src/panel/api/types.ts` · `api/settings.ts` · `hooks/useSettings.ts` | tipos, cliente, sección nueva |
| `src/panel/components/assistant/ConversationSettings.tsx` | **nuevo** |
| `src/panel/pages/AssistantPage.tsx` | montar la card |

El nodo base vive en el código; el jsonb guarda **solo** lo que el dueño sobrescribió.
Así un cambio nuestro en los PASOS llega a todos sin pisar lo que el dueño escribió.

### Escalón 3 — constructor sin canvas

Un flujo pasa a ser un **array ordenado de nodos** elegidos de un catálogo cerrado,
más sus textos. Agregar `correccion_datos` o sacar `listado_servicios` de una lista,
sin dibujar aristas. Ya es un constructor de casuísticas y cubre la mayor parte de
lo que buscás.

### Escalón 4 — canvas

Recién cuando las transiciones sean data editable.

**Advertencia, y no es teórica: el modo de falla del canvas ya lo estamos viviendo.**
`sales` está atascado porque una arista declarada no tiene emisor. Si el dueño dibuja
aristas va a reproducir ese bug exacto, y llega como "Emma no responde" — el síntoma
más caro posible. Recomiendo **canvas de lectura para el dueño, de edición para
Vamvu**, con el test de alcanzabilidad haciendo imposible guardar un nodo sin salida.

---

## Paso 5 — Multimedia multi-tipo

### El choque: `Emma_spec_v2` asume un modelo de datos que no existe

El spec define `service_media` con `service_id uuid FK → services`. **No hay tabla
`services`**: viven en el jsonb `businesses.settings`, y en la Fase 2 les puse un
`id` de nanoid justamente porque no había a qué apuntar. Ese FK no se puede crear
como está escrito. Tres salidas, y necesito que elijas:

| Opción | Qué implica | Costo |
|---|---|---|
| **A** | `service_media` con FK solo a `businesses` + `service_id text` que matchea el nanoid, sin FK. Integridad a nivel de app | Bajo, aditivo. Riesgo: media huérfana si el dueño borra un servicio |
| **B** | Promover servicios a tabla real | Correcto a largo plazo. Toca `prompts.ts` (`renderServices`), `settings.merge.ts` (`normalizeServices`), panel de Servicios, schema Zod. Migración de datos, no aditiva |
| **C** | Quedarse con `imageKey` y solo sumar tipos | Mínimo, pero no cubre el spec: un archivo por servicio |

### Archivos (si A o B)

| Archivo | Cambio |
|---|---|
| `src/db/schema/serviceMedia.ts` | **nuevo** + migración `0019` |
| `src/modules/media/media.validate.ts` | pdf/mp3/wav/ogg/mp4 + tamaño por tipo (5/10/5/16 MB) |
| `src/modules/media/media.keys.ts` | subcarpeta `{service_id}/` en vez de `{service_id}_1.ext` |
| `src/modules/media/media.service.ts` | `MediaTarget` con el tipo |
| `src/modules/whatsapp/baileys.client.ts` | **`sendDocument` / `sendAudio` / `sendVideo`** — hoy solo existe `sendImage` |
| `src/modules/whatsapp/outbound.ts` | `sendMediaToCustomer` por tipo |
| `src/modules/llm/toolExecutor.ts` | `send_service_image` → `send_service_media` |
| `src/panel/components/services/ServicePhotoField.tsx` | → `ServiceMediaField.tsx`, preview por tipo |

**Permiso necesario:** CLAUDE.md marca Baileys y `sendQueue` como **NO TOCAR** sin
pedirlo explícitamente. Los métodos nuevos caen ahí.

---

## Lo que necesito de vos antes de arrancar

1. **Modelo de datos de media** — A, B o C del Paso 5.
2. **Scope.** `Emma_spec_v2` pide audio y video, y el canvas es tu punto de llegada.
   Las dos cosas están hoy en la lista **"Fuera de scope"** de CLAUDE.md
   ("Audio, videos, llamadas en WhatsApp" y "Canvas visual para diseño de flujos").
   Si esta es la dirección, actualizo esas dos líneas en el mismo commit que las
   habilite.
3. **Permiso para tocar `baileys.client.ts`** (Paso 5), que está marcado NO TOCAR.
4. **Quién edita el canvas** — dueño o solo Vamvu.
5. **El bug de "Vende"** — lo deshabilito ya (Paso 0) o lo dejo vivo hasta el Paso 2.
6. **OK para escribir tests.** CLAUDE.md pide proponerlos primero. Los que propongo
   están abajo.

---

## Tests propuestos (requieren OK explícito)

El más importante primero:

- **Alcanzabilidad** (`stateMachine.test.ts`, nuevo) — para cada flujo, recorrer
  desde `idle` y afirmar que **todo estado es alcanzable** y que **todo trigger
  declarado tiene un emisor en el código**. Esto convierte el bug de `sales` en un
  test rojo, y es la red sin la cual el canvas no debería existir.
- **Frontera de caché** (`prompts.test.ts`) — dos builds del mismo negocio con
  historiales distintos → capa 1 byte-idéntica. Hoy el contrato existe solo como
  comentario.
- **`decideCallToAction`** — cinco ramas, cero tests hoy. Los 10 casos actuales de
  `prompts.test.ts` son todos sobre saludos.
- **`isFarewell`** — "gracias" sí; "gracias, ¿y cuánto cuesta?" no.
- **`normalizeServices`** — un patch de `schedule` no altera ids ni `imageKey`.

---

## Orden y por qué

```
0. Deshabilitar "Vende"              ~10 líneas    urgente
1. Nodos de 4 campos                 ┐
2. Emisores de trigger               ├─ un solo arco, no partir
3. Mover prosa global a los nodos    ┘
4. Card "Conversación" en el panel
5. Multimedia multi-tipo             (después de decidir A/B/C)
6. Escalón 3, y canvas al final
```

**Los pasos 1-3 son un solo arco.** Si se parten, el prompt queda diciendo las cosas
dos veces —una en el cuerpo global y otra en el nodo— que es peor que ahora.

---

## Verificación

Casi todo se verifica sin WhatsApp, porque los nodos y el prompt son funciones puras:

1. **Alcanzabilidad** — el test de arriba. Es el que hoy falta y el que más vale.
2. **Diff de prompts antes/después** para las 10 combinaciones (5 nichos × con/sin
   adelanto), confirmando que al mover prosa a los nodos **no se perdió una regla**.
3. **Tokens por capa**, para cuantificar el ahorro del Paso 3 en vez de estimarlo.
4. `npm run check`.
5. **WhatsApp en dev**: un negocio `sales` completando el flujo de punta a punta
   (hoy imposible), y un `appointments` con adelanto sin regresión — incluido el caso
   "cliente pregunta a qué número deposita antes de dar el nombre", que tiene que
   pedir el nombre y no el Yape.
6. **Prod recién después**, y con el backfill de ids corrido primero.

---

## Pendiente heredado que este plan NO cubre

- `npm run db:migrate:dev` y `npm run backfill:service-ids` de la Fase 2 **siguen sin
  correr**. Sin la migración, `payment_verifications.proof_key` no existe.
- Los 5 campos en "Próximamente": `messages.paymentApproved`, `reminder24h`,
  `reminder2h`, `escalationAttempts`, `cancellationKeyword`.
