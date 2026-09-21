# Emma — Spec de Implementación para Claude Code

> Léelo COMPLETO antes de escribir cualquier línea de código.

---

## Qué es Emma

Asistente de IA por WhatsApp para negocios de servicios. Responde consultas, lista servicios con multimedia, agenda citas, procesa pagos, notifica al dueño, y deriva a humano cuando es necesario.

## Lo que sabes del stack

- **DB:** PostgreSQL + Drizzle
- **Frontend/Panel:** React + TypeScript
- **WhatsApp:** Baileys (Node.js)
- **Hosting:** Railway (2 entornos: dev y prod)
- **LLM:** GPT-4o-mini
- **Backend:** NO asumas el framework. Explora el repo y descúbrelo.

## Entornos

- **dev** — donde se codea. No tocar datos de producción.
- **prod** — donde se prueba con uso real. Los cambios se despliegan aquí después de validar en dev.

Asegúrate de que cualquier configuración (env vars, buckets, etc.) respete esta separación.

---

## PASO 0 — Antes de escribir código

1. Explorar el repo completo: estructura de carpetas, framework del backend, cómo están organizados los módulos
2. Revisar el schema de DB actual (tablas de servicios, negocios, conversaciones, pagos)
3. Revisar cómo el bot envía y recibe mensajes (estructura de Baileys en el código)
4. Revisar cómo el panel consume la API
5. Identificar patrones existentes (cómo se crean endpoints, cómo se manejan archivos, etc.)
6. SOLO ENTONCES escribir código, siguiendo los patrones que ya existen

---

## Finalidad de Emma: Asistente que vende y agenda

Emma es un asistente híbrido: maneja ventas Y agendamiento en un solo flujo. No es uno u otro — coexisten.

### Sistema de configuración (configurable por negocio desde panel/systemPrompt)

1. **Identidad:** Nombre, Género, Tono, Función (Vende / Agenda / Ambas), Datos del negocio
2. **Mensajes:** Inicio (Saludo), Derivación con humanos, Final (Despedida), Errores, Horario de atención
3. **Flujo (StateMachine):** Cada nodo tiene: OBJETIVO, PASOS, INSTANCIAS ADICIONALES, EJEMPLO DE RESPUESTA

---

## Flujo principal: Citas y Ventas

```
[Inicio / Saludo]
    │
    ▼
[Pregunta / Asesoría]
    │  Preguntar qué busca ANTES de enviarle todo
    │
    ▼
[Listado / Recomendaciones de Servicios, Productos, etc.]
    │  → Si el servicio tiene imagen en S3, enviarla junto con la descripción
    │  → Si no tiene imagen, solo texto (comportamiento actual)
    │
    ▼
[¿Requiere pago o algo para concretar la venta/agenda?]
    │
    ├── SÍ ──────────────────────────────────────────────┐
    │                                                     ▼
    │                              [Presentar métodos de pago y esperar]
    │                                                     │
    │                                                     ▼
    │                              [Esperar el pago (foto, validación)]
    │                              Se activa flujo con el dueño para verificar
    │                                                     │
    │                                                     ▼
    │                                              [¿Pago correcto?]
    │                                               /           \
    │                                             NO             SÍ
    │                                              │              │
    │                              (vuelve a presentar            │
    │                               métodos de pago)              │
    │                                                             │
    ├── NO ───────────────────────────────────────────────────────┤
    │                                                             │
    ▼                                                             ▼
[Capturar datos adicionales]                                     │
    │  Nombre, Correo, Dirección,                                │
    │  Fechas y hora (cita), etc.                                │
    │                                                             │
    ▼                                                             │
[¿Capturar datos a corregir?] ◄──────────────────────────────────┘
    │
    ▼
[Confirmación]
    │
    ▼
[¿Todo correcto?]
    │       │
    NO      SÍ
    │       │
    │       ▼
    │   [Despedida]
    │
    └── (vuelve a "¿Capturar datos a corregir?" — NO recaptura todo,
         pregunta qué dato quiere cambiar)
```

---

## Flujo de verificación de pago (aislado, se activa desde el flujo principal)

```
[Cliente envía comprobante de pago por WhatsApp]
    │
    ▼
[Guardar imagen en S3]
    │  Ruta: {business_id}/payments/{conversation_id}_{timestamp}.ext
    │
    ▼
[Enviar al panel + notificar al dueño]
    │  El dueño ve el comprobante en el panel
    │  Se envía mensaje configurable al cliente: "Tu pago está siendo verificado"
    │
    ▼
[Esperar confirmación del dueño]
    │
    ▼
[¿Pago correcto?]
    ├── SÍ → continúa flujo principal (captura de datos o despedida)
    └── NO → vuelve a presentar métodos de pago
```

---

## Flujo de multimedia — Emma envía imágenes de servicios

```
[Dueño sube imágenes desde el panel]
    │
    ▼
[Imágenes se guardan en S3]
    │  Ruta: {business_id}/services/{service_id}_{index}.ext
    │
    ▼
[Cuando Emma lista servicios en WhatsApp]
    │
    ▼
[Si el servicio tiene imagen → enviar imagen + caption con info del servicio]
[Si no tiene imagen → enviar solo texto como ahora]
```

---

## Flujo de recordatorios (NO implementar esta semana — es semana 2)

```
[Se agenda una cita]
    │
    ▼
[Se crean 2 recordatorios automáticos: 24h antes y 2h antes]
    │  Configurables desde el panel
    │
    ▼
[Enviar recordatorio al cliente por WhatsApp]
    │
    ▼
[Si el cliente responde con palabra clave → cancelar o reprogramar]
    │  Palabra clave configurable
    │  Si cancela → notificar al dueño
    │  Si reprograma → reactivar flujo de captura de datos (fecha/hora)
```

---

## Derivación a humano

Se activa en CUALQUIER punto del flujo. Triggers:

1. **El cliente lo pide explícitamente** ("quiero hablar con alguien", "necesito ayuda de una persona")
2. **Emma detecta que algo está mal** — no puede resolver después de X intentos, o el tema está fuera de su scope
3. **Atrevimiento:** si algo sale mal, cuando no se puede concretar o algún servicio correctamente

Acción: enviar mensaje configurable ("Te conecto con un asesor humano") + notificar al dueño via panel/WhatsApp.

---

## Fuera de horario

- Toggle configurable desde el panel (on/off + horarios)
- Cuando está fuera de horario, Emma NO se desconecta — sigue la conversación y captura todo (datos, consultas, intención)
- Diferencia: no puede agendar citas ni procesar pagos en ese momento
- Mensaje configurable tipo: "Estamos fuera de horario, pero ya tengo tu info. Te contactaremos mañana a primera hora"

---

## Panel de configuración — Reestructuración del tab "Asistente"

### PASO 0 del panel

Antes de tocar el panel:
1. Explorar TODA la UI del panel actual — qué tabs existen, qué formularios hay, qué campos de configuración se guardan
2. Revisar qué campos del modelo de negocio/asistente existen en la DB
3. Identificar qué de lo actual corresponde a IDENTIDAD, MENSAJES o FLUJO
4. Mapear: qué ya existe (mantener/mover), qué falta (crear), qué sobra (eliminar)
5. Reportar el inventario antes de hacer cambios

### Estructura target: Tab "Asistente" con 3 secciones

El panel debe tener un tab llamado **"Asistente"** (o reestructurar el existente si ya hay configuración dispersa). Dentro de ese tab, 3 secciones claras:

---

### Sección 1: IDENTIDAD — Quién es Emma para este negocio

Define la personalidad y contexto del asistente. Estos campos se inyectan en el system prompt del LLM.

| Campo | Tipo | Descripción | Ejemplo |
|-------|------|-------------|---------|
| Nombre del asistente | text | Cómo se presenta | "Emma", "Ana", "Carlos" |
| Género | select | Femenino / Masculino / Neutro | Afecta pronombres y tono |
| Tono | select | Formal / Amigable / Profesional-cercano | Cómo habla |
| Función | select | Vende / Agenda / Ambas | Define qué flujos activa |
| Nombre del negocio | text | Para contexto en conversación | "Clínica Dental Sonrisa" |
| Descripción del negocio | textarea | Qué hace el negocio, en 1-2 oraciones | "Clínica dental especializada en ortodoncia y estética dental" |
| Datos de contacto | textarea | Dirección, teléfono, redes | Se comparte cuando el cliente pregunta |
| Instrucciones adicionales | textarea | Reglas custom del dueño | "No dar precios por WhatsApp, solo agendar cita", "Siempre mencionar la promoción del mes" |

---

### Sección 2: MENSAJES — Qué dice Emma en momentos clave

Mensajes predefinidos y configurables que Emma usa en puntos específicos del flujo. NO es el texto completo de cada respuesta (eso lo genera el LLM), sino templates/guías para momentos clave.

| Campo | Tipo | Descripción | Ejemplo default |
|-------|------|-------------|-----------------|
| Saludo inicial | textarea | Primer mensaje cuando alguien escribe | "¡Hola! Soy Emma, asistente de {nombre_negocio}. ¿En qué puedo ayudarte?" |
| Despedida | textarea | Mensaje al cerrar conversación exitosa | "¡Gracias por comunicarte con {nombre_negocio}! Tu cita quedó confirmada. ¡Te esperamos!" |
| Derivación a humano | textarea | Cuando Emma transfiere a una persona | "Voy a comunicarte con un asesor para que te ayude directamente. Un momento por favor." |
| Fuera de horario | textarea | Cuando escriben fuera del horario configurado | "Estamos fuera de nuestro horario de atención, pero ya tengo tu información. Te contactaremos mañana a primera hora." |
| Error / No entendió | textarea | Cuando Emma no comprende la intención | "Disculpa, no estoy segura de haber entendido. ¿Podrías reformular tu pregunta?" |
| Pago recibido — en verificación | textarea | Cuando recibe comprobante de pago | "¡Recibí tu comprobante! Estoy verificando el pago, te confirmo en breve." |
| Pago confirmado | textarea | Cuando el dueño confirma el pago | "¡Tu pago ha sido verificado correctamente! Continuemos." |
| Pago rechazado | textarea | Cuando el dueño rechaza el pago | "Hubo un inconveniente con tu pago. ¿Podrías intentar nuevamente?" |
| Recordatorio de cita (24h) | textarea | Recordatorio 24 horas antes | "Hola {nombre_cliente}, te recordamos que mañana tienes cita en {nombre_negocio} a las {hora}." |
| Recordatorio de cita (2h) | textarea | Recordatorio 2 horas antes | "¡Nos vemos pronto! Tu cita en {nombre_negocio} es en 2 horas ({hora})." |

Variables disponibles en templates: `{nombre_negocio}`, `{nombre_cliente}`, `{hora}`, `{fecha}`, `{servicio}`.

---

### Sección 3: FLUJO — Configuración del comportamiento conversacional

Controles que afectan CÓMO Emma maneja la conversación. Esta sección NO es para que el dueño escriba el flujo — el flujo está hardcodeado en la state machine. Aquí se configuran los parámetros del flujo.

| Campo | Tipo | Descripción | Default |
|-------|------|-------------|---------|
| Requiere pago para agendar | toggle | ¿El cliente debe pagar antes de confirmar cita? | OFF |
| Métodos de pago | multi-select + text | Qué métodos ofrece (Yape, Plin, Transferencia, etc.) + datos de cada uno | — |
| Datos a capturar | checkboxes | Qué datos pide Emma: Nombre, Correo, Teléfono, Dirección, Fecha/hora, Otros (custom) | Nombre + Teléfono |
| Campos custom | repeater | Datos adicionales que el dueño quiera capturar | "Tipo de tratamiento", "¿Es primera vez?" |
| Horario de atención | time ranges | Días y horarios en que Emma opera "en horario" | L-V 9:00-18:00, S 9:00-13:00 |
| Comportamiento fuera de horario | select | Qué hace Emma fuera de horario: "Sigue conversando + captura datos" / "Solo saludo + captura datos" | Sigue conversando |
| Derivación a humano — intentos | number | Después de cuántos intentos fallidos Emma ofrece derivar | 3 |
| Recordatorios activos | toggle | ¿Enviar recordatorios de cita? | ON |
| Palabra clave cancelación | text | Qué escribe el cliente para cancelar/reprogramar desde un recordatorio | "cancelar" |

---

### Reglas de implementación del panel

1. **Descubrir antes de crear.** Muchos de estos campos probablemente YA existen en algún lugar del panel (quizá con otro nombre o en otro tab). NO crear duplicados. Moverlos a la nueva estructura.
2. **Cada campo se guarda en DB por negocio.** Un negocio = una configuración. Revisar la tabla de negocios o configuración existente.
3. **Los campos de IDENTIDAD y MENSAJES se inyectan en el system prompt** que se le pasa al LLM. Revisar cómo se construye el prompt actual y adaptar.
4. **Los campos de FLUJO controlan la state machine.** Revisar cómo la state machine lee su configuración y conectar.
5. **Defaults.** Todos los campos deben tener un valor default sensato para que un negocio nuevo funcione sin configurar todo. Los defaults están en la columna "Default" o "Ejemplo default" de las tablas arriba.
6. **Los recordatorios (sección FLUJO) son semana 2.** Mostrar los campos en el panel pero deshabilitados con un label "Próximamente" o similar.

---

## Implementación S3 — Lo que hacer ESTA SEMANA

### Estructura del bucket

```
emma-media-{env}/
├── {business_id}/
│   ├── services/
│   │   ├── {service_id}_1.jpg
│   │   └── ...
│   ├── payments/
│   │   ├── {conversation_id}_{timestamp}.jpg
│   │   └── ...
│   └── general/
│       └── (futuro: logos, otros assets del negocio)
```

### Convenciones
- Bucket por entorno: `emma-media-dev`, `emma-media-prod` (ya creados por el founder)
- Prefijo por negocio (`business_id`) para aislar datos entre clientes
- Formatos aceptados: jpg, jpeg, png, webp, pdf
- Tamaño máximo por archivo: 5MB
- URLs: presigned URLs con expiración (1 hora). NUNCA públicas
- Nombres de archivo: slugificados, sin espacios ni caracteres especiales

### Variables de entorno (ya configuradas en Railway por el founder)

```
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_S3_BUCKET_NAME=emma-media-{env}
AWS_S3_REGION=
```

### Módulo S3 (crear donde corresponda según la estructura existente del proyecto)

Funciones necesarias:
1. **upload_file(file_buffer, s3_path, content_type)** — sube archivo, retorna la key
2. **get_presigned_url(key, expiration=3600)** — genera URL temporal
3. **delete_file(key)** — elimina archivo

### Endpoints necesarios (seguir el patrón de rutas que ya existe en el proyecto)

1. **Subir imagen de servicio** (desde panel)
   - Recibe archivo + business_id + service_id
   - Guarda en S3 en la ruta correcta
   - Guarda la key S3 en la DB asociada al servicio

2. **Obtener imagen de servicio** (para panel y bot)
   - Recibe business_id + service_id
   - Retorna presigned URL(s)

3. **Guardar comprobante de pago** (desde el bot cuando el cliente envía foto)
   - Recibe buffer de imagen + business_id + conversation_id
   - Guarda en S3
   - Asocia a la conversación en DB

4. **Ver comprobante de pago** (desde panel)
   - Recibe business_id + payment/conversation id
   - Retorna presigned URL

### Cambios en DB (usar Drizzle, revisar schema actual PRIMERO)

- En la tabla de servicios: agregar campo para almacenar key(s) de S3 de las imágenes
- En la tabla de conversaciones/pagos: agregar campo para key de comprobante de pago (nullable)

### Bot (Baileys)

**Enviar imagen al listar servicios:**
- Al listar un servicio, verificar si tiene media_key en DB
- Si sí: obtener presigned URL → enviar con sendMessage tipo image + caption
- Si no: enviar solo texto como ahora

**Recibir comprobante de pago:**
- Detectar cuando llega imagen durante el flujo de pago
- Descargar el media con downloadMediaMessage
- Enviar al endpoint de guardar comprobante
- Confirmar al cliente que se recibió

### Panel (React) — MÍNIMO VIABLE

1. **En edición de servicio:** Input file para subir imagen + preview de imagen actual. No galería, no drag & drop, no cropper.
2. **En vista de conversaciones/pagos:** Thumbnail del comprobante si existe. Solo visualizar.

---

## Orden de implementación

### Fase 1: Descubrimiento (ANTES de codear)
1. Explorar repo: estructura, framework backend, patrones
2. Inventariar panel actual: qué tabs, qué campos de config existen, dónde se guardan
3. Inventariar DB: schema actual, qué campos de configuración ya existen por negocio
4. Reportar: qué existe, qué falta, qué se mueve, qué se elimina — comparado con las 3 secciones (IDENTIDAD, MENSAJES, FLUJO)

### Fase 2: S3 + Multimedia
5. Módulo S3 en backend (upload, get URL, delete)
6. Cambios en DB para multimedia (migraciones con Drizzle)
7. Endpoints de servicios (subir/ver imágenes)
8. Panel: upload de imagen en servicios + preview
9. Bot: enviar imagen al listar servicios
10. Endpoints de pagos (guardar/ver comprobante)
11. Bot: recibir comprobante de pago
12. Panel: mostrar comprobante

### Fase 3: Reestructuración del panel — Tab "Asistente"
13. Migrar campos existentes a la nueva estructura (IDENTIDAD / MENSAJES / FLUJO)
14. Crear campos faltantes con defaults
15. Conectar campos de IDENTIDAD y MENSAJES al system prompt del LLM
16. Conectar campos de FLUJO a la state machine
17. Eliminar configuración huérfana que ya no tiene sentido
18. Campos de recordatorios: visibles pero deshabilitados ("Próximamente")

---

## Lo que NO hacer

- No asumir el framework del backend — descubrirlo explorando el repo
- No hacer el bucket público
- No guardar archivos en el servidor/Railway (es efímero, se pierde en cada deploy)
- No usar URLs de S3 directas — siempre presigned
- No construir features de panel más allá del MVP (upload + view)
- No implementar recordatorios (es semana 2)
- No implementar derivación a humano (documentado arriba para referencia futura)
- No cambiar la arquitectura existente de Emma — agregar módulo S3, no refactorizar
- No inventar patrones nuevos — seguir los que ya existen en el código
- No tocar el entorno prod hasta que todo funcione en dev