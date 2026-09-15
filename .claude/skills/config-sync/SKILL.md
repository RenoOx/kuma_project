---
name: config-sync
description: Verifica que cada configuración del panel del cliente se refleje en el comportamiento de Emma. Úsala al agregar o migrar cualquier campo de configuración (horarios, días especiales, servicios, métodos de pago, adelanto, modo de reserva, FAQs, políticas, promos, recordatorios, toggles de Emma) desde el admin al panel, o al tocar business.settings, prompts.ts, llm.service.ts, stateMachine.ts o handler.ts. Incluye el mapa config→comportamiento, los test cases de sincronización y dónde vive realmente cada dato.
---

# Skill: Config ↔ Emma Sync

> Cada configuración en el panel del cliente DEBE reflejarse en el
> comportamiento de Emma. Este skill documenta la relación y los
> test cases para verificarla.

> **Verificá contra el código antes de confiar en este archivo.** La fuente de
> verdad es `src/modules/business/business.settings.ts`. Si este documento y el
> schema Zod se contradicen, gana el schema — y corregí este archivo.

## Principio

`business.settings` (jsonb en la tabla `businesses`, validado por
`businessSettingsSchema`) es la fuente de verdad de la configuración operativa.
El panel escribe en settings vía API → Emma lee settings en runtime vía
`llm.service.ts` cuando construye el system prompt.

Si agregas un campo al panel que no se refleja en Emma: es un bug.
Si Emma lee un campo que el panel no expone: es deuda técnica.

**No hay defaults.** Un negocio sin settings válidos hace que las tools que
requieren config devuelvan `NotConfiguredError`. Es feature: el bot no inventa
información operativa. No "arregles" esto agregando defaults.

## Dónde vive cada cosa (esto se malentiende seguido)

NO existen tablas `services`, `payment_methods`, `tags` ni columnas
`emma_enabled` / `emma_global_enabled`. Verificá `src/db/schema/` antes de
escribir una query contra cualquiera de ellas.

| Dato | Dónde vive realmente |
|---|---|
| Servicios | `settings.services[]` — array jsonb. **Sin campo `active`**: un servicio se quita borrándolo del array |
| Precios | `settings.services[].priceMin` / `priceMax` / `requiresEvaluation` |
| Métodos de pago | `settings.depositPaymentMethods[]` — enum cerrado: `yape`, `plin`, `transferencia`, `efectivo` |
| Monto del adelanto | `settings.depositAmount` — **texto libre** ("S/ 20", "el 50%"), no número |
| Horarios | `settings.operatingHours` — 7 días, cada uno `{open, close, break?}` o `null` |
| Días especiales | `settings.specialDays[]` — `{date, hours, label?}`, `hours: null` = cerrado |
| Políticas / FAQs / Promos | tabla `knowledge_base` (esta sí es tabla real) |
| Estado de pausa del bot | `settings.botPaused` |

## Campos de settings y su efecto en Emma

| Campo | Valores | Efecto en Emma |
|---|---|---|
| `niche` | `dental`, `barberia`, `estetica`, `salud`, `general` (**5, no 10**) | Vocabulario: paciente vs cliente. Copy del panel vía `nicheCopy()` |
| `appointmentMode` | `appointments_only` \| `hybrid` | **Este es el "modo de atención".** Hybrid = por orden de llegada + citas opcionales |
| `flowType` | `appointments` \| `sales` | Qué máquina de estados corre. **No es el modo de atención** — es otra cosa |
| `bookingMode` | `direct` \| `requires_approval` | Si Emma cierra la cita o la deja `pending` esperando al dueño |
| `requiresDeposit` | boolean | Activa el gate del `toolExecutor`: sin adelanto aprobado no hay cita |
| `depositAmount` | string libre | Emma indica el monto tal cual está escrito |
| `depositPaymentMethods` | array | Emma solo menciona los configurados (`formatPaymentMethods`) |
| `forwardImages` | boolean | Reenvía fotos del cliente al dueño. **Leer con `shouldForwardImages()`**, que lo hace OR con `requiresDeposit` |
| `operatingHours` | objeto | Emma solo ofrece slots dentro de la grilla |
| `operatingHours[day].break` | `{start, end}` | Emma no ofrece slots en el break. Un solo break por día |
| `specialDays` | array | Override del horario semanal para esa fecha (`resolveDayHours`) |
| `slotDurationMinutes` | int | Duración del slot cuando el servicio no tiene una propia |
| `minBookingNoticeMinutes` | int 0-1440, opcional | Anticipación mínima. Default 30 vía `getMinBookingNoticeMinutes()` |
| `services[].requiresEvaluation` | boolean | Emma NO da precio cerrado, dice que requiere evaluación (`formatServicePrice`) |
| `postBooking.reminders` | boolean | Recordatorios 24 h y 2 h. **Un solo toggle, no dos** |
| `botPaused` | objeto \| null | Clientes reciben mensaje canned, el dueño nunca se ve afectado |

### Leer siempre por el helper, nunca el campo crudo

`business.settings.ts` exporta helpers que encapsulan reglas que no son obvias.
Leer el campo directo se saltea la regla:

| En vez de | Usá |
|---|---|
| `settings.forwardImages` | `shouldForwardImages(settings)` — OR con `requiresDeposit` |
| `settings.minBookingNoticeMinutes` | `getMinBookingNoticeMinutes(settings)` — default 30 |
| `service.durationMinutes` | `resolveServiceDurationMinutes(service, settings)` — fallback al slot |
| `settings.operatingHours[day]` | `resolveDayHours(settings, dateISO, dayKey)` — aplica specialDays |
| `settings.botPaused.paused` | `isBotPausedNow(settings)` — maneja el auto-resume por `until` |
| `settings.postBooking.reminders` | `remindersExplicitlyDisabled(rawSettings)` — ver abajo |

### El caso de los recordatorios: opt-out explícito

`postBookingSchema` defaultea `reminders` a `false`. Un negocio configurado
antes de que el campo existiera parsea como `false` **sin haber elegido nunca**.
Gatear el worker sobre el valor parseado apagaría recordatorios que hoy salen en
producción.

Por eso `remindersExplicitlyDisabled` lee el **jsonb crudo** y solo un `false`
realmente almacenado desactiva. Ausente = nunca respondió = sigue como está.

Cuidado con este patrón cada vez que agregues un boolean con default a
`postBooking`: el default no distingue "dijo que no" de "nunca le preguntamos".

## Knowledge base

Tabla real: `knowledge_base`. Categorías **activas**: `politicas`,
`informacion_general`, `promociones` (`KB_CATEGORIES` en
`knowledgeBase.types.ts`).

`ubicacion`, `servicios`, `precios` y `contacto` están **retiradas**: duplicaban
datos que ya viven en settings o en columnas de `businesses`, y una KB que los
repite es una segunda fuente de verdad con la que Emma se contradice. Siguen en
el enum de Postgres solo porque hay filas viejas que las referencian; nada
escribe ahí. No las revivas.

Columnas que importan además de `category`: `active`, `sendMode`
(`always` / `on_request` / `trigger_based`), `triggerKeywords`,
`attachmentType` / `attachmentUrl`.

## Archivos a verificar para cada sync

Cuando agregues una config nueva al panel:
1. `src/modules/business/business.settings.ts` — ¿el campo está en el schema Zod?
2. `src/modules/llm/prompts.ts` — ¿el system prompt inyecta ese campo?
3. `src/modules/llm/llm.service.ts` — ¿se carga el dato al construir contexto?
4. `src/modules/conversation/stateMachine.ts` — ¿algún estado depende de ese campo?
5. `src/modules/whatsapp/handler.ts` — ¿hay gates que dependen de ese campo?
6. `src/modules/llm/toolExecutor.ts` — ¿hay un gate de tool que lo lea?
7. `src/workers/` — ¿hay un worker que deba respetarlo? (el caso de `reminders`)

Chequeo rápido de que un campo está realmente cableado:

```bash
grep -rn "nombreDelCampo" src/modules/llm src/modules/appointment src/workers src/modules/whatsapp
```

Si no aparece en ningún lado, buscá el helper que lo envuelve antes de concluir
que está muerto — varios campos se leen solo a través de las funciones de la
tabla de arriba.

## API del panel para configuración

`src/modules/panel/settings.routes.ts`, todo detrás de `panelAuth`:

```
GET   /api/panel/:businessId/settings
PATCH /api/panel/:businessId/settings/general       name, ownerName, address, googleMapsUrl, timezone, niche, appointmentMode
PATCH /api/panel/:businessId/settings/schedule      operatingHours
PATCH /api/panel/:businessId/settings/special-days  specialDays (reemplazo total)
PATCH /api/panel/:businessId/settings/booking       bookingMode, slotDurationMinutes, minBookingNoticeMinutes, forwardImages, postBooking
GET   /api/panel/:businessId/integrations           solo lectura
```

**PATCH por sección, nunca PUT del documento completo.** Un PUT desde un form
que no cargó `services` los borra por omisión. Cada PATCH mergea su sección
sobre lo guardado y revalida el objeto entero — ver `mergeSettingsSection` en
`settings.merge.ts`, que es la mitad pura del módulo (sin dependencia de la DB,
por eso es la que se testea).

El tenant sale siempre de `panelBusiness(c).id`. Ningún schema de patch acepta
`businessId`: un id en el body se descarta en el parse.

Lo que el panel **no** puede escribir: `services`, `requiresDeposit`,
`depositAmount`, `depositPaymentMethods`, `flowType`, `botPaused`. Están fuera
de todos los patch schemas a propósito.

## Test cases de sincronización

Después de migrar cada sección del admin al panel, verificar:

```
HORARIOS:
1. Configurar cierre domingo → preguntar a Emma "¿atienden domingo?" → "estamos cerrados los domingos"
2. Configurar break 1-2pm → pedir cita a la 1:30pm → Emma no ofrece ese slot
3. Configurar cierre 6pm → pedir cita 7pm → Emma dice "nuestro horario es hasta las 6pm"

DÍAS ESPECIALES:
4. Agregar feriado 28 julio cerrado → pedir cita 28 julio → Emma dice "cerrados por feriado"
5. Agregar sábado especial 9am-1pm → pedir cita sábado 3pm → Emma no ofrece

SERVICIOS:
6. Quitar servicio X del array → preguntar "¿qué servicios tienen?" → X no aparece
7. Marcar servicio como requiresEvaluation → preguntar precio → "necesita evaluación previa"
8. Cambiar priceMin de un servicio → preguntar precio → Emma da el nuevo

PAGOS:
9. Solo Yape configurado → Emma solo menciona Yape
10. requiresDeposit activo → cliente agenda → Emma pide captura antes de confirmar
11. requiresDeposit desactivado → cliente agenda → Emma confirma directo

MODO DE ATENCIÓN:
12. appointments_only → Emma siempre intenta agendar
13. hybrid → Emma ofrece también el orden de llegada

ANTICIPACIÓN:
14. minBookingNoticeMinutes 120 → pedir cita para dentro de 1 h → Emma no la ofrece

RECORDATORIOS:
15. Apagar el toggle → cita a 24 h → el worker loguea "reminders off", no envía
16. Prender el toggle → cita a 24 h → llega el recordatorio

NOMBRE DEL CLIENTE:
17. Cliente dice "soy Juan" → Emma responde usando "Juan"
18. Juan escribe al día siguiente → Emma lo reconoce por teléfono
19. En todo el flujo de agendamiento → Emma usa el nombre guardado
```

## Pendiente (no implementado todavía)

Esto NO existe en el código. Es del roadmap de `MIGRATION_PLAN.md`, bloque C:

- Tablas `tags` y `conversation_tags`
- `conversations.emma_enabled` y `businesses.emma_global_enabled`
- Toggle de Emma por chat y global, con su gate en `handler.ts`

La expansión de `niche` de 5 a 10 valores es del bloque E: es un cambio de enum
con datos vivos en producción, necesita mapeo (`barberia` → `barberia_premium`)
y toca `prompts.ts`.
