# Emma — Spec v2: Multimedia Multi-tipo + StateMachine

> Spec complementario. El anterior (S3 + Panel) ya se ejecutó. Este cubre lo que faltó.
> Léelo COMPLETO antes de escribir cualquier línea de código.

---

## Contexto

Emma ya tiene (o está en proceso de tener) integración S3 básica y panel de configuración con 3 secciones (IDENTIDAD, MENSAJES, FLUJO). Este spec agrega:

1. Soporte de multimedia multi-tipo (imagen, PDF, audio, video) — no solo imágenes
2. Modelo de datos correcto para media de servicios
3. Definición de nodos de la StateMachine con OBJETIVO, PASOS, INSTANCIAS, EJEMPLO
4. Panel actualizado para subir/ver múltiples tipos de archivo

---

## PASO 0 — Antes de escribir código

1. Explorar qué se implementó del spec anterior — qué endpoints existen, qué cambios en DB se hicieron, cómo quedó el módulo S3
2. Revisar el schema actual de DB (especialmente la tabla de servicios y cualquier tabla de media creada)
3. Revisar cómo el bot envía mensajes actualmente con Baileys — qué tipos de mensaje soporta
4. Revisar el panel — qué componentes de upload se crearon
5. SOLO ENTONCES escribir código, extendiendo lo que ya existe

---

## 1. Multimedia multi-tipo — Envío desde S3

### El problema

El spec anterior solo contempló imágenes. El diagrama de flujo dice: **"ENVIAR IMÁGENES / PDF / AUDIO, DESDE S3"**. Emma necesita enviar distintos tipos de archivo cuando lista servicios.

### Tipos soportados

| Tipo | Extensiones | Uso en Emma | Tamaño máx |
|------|------------|-------------|------------|
| image | jpg, jpeg, png, webp | Fotos de servicios, resultados, instalaciones | 5MB |
| pdf | pdf | Catálogos, lista de precios, brochures, preparación para tratamientos | 10MB |
| audio | mp3, wav, ogg | Instrucciones de voz, mensajes pregrabados | 5MB |
| video | mp4 | Demos de servicios, testimonios (futuro) | 16MB |

### Envío por Baileys — cada tipo tiene su método

```javascript
// IMAGEN — con caption
await sock.sendMessage(jid, {
  image: { url: presignedUrl },  // o buffer
  caption: "Servicio: Limpieza dental\nPrecio: S/.80"
})

// PDF / DOCUMENTO — con nombre de archivo
await sock.sendMessage(jid, {
  document: { url: presignedUrl },  // o buffer
  mimetype: 'application/pdf',
  fileName: 'catalogo-servicios.pdf'
})

// AUDIO — como nota de voz o audio
await sock.sendMessage(jid, {
  audio: { url: presignedUrl },  // o buffer
  mimetype: 'audio/mpeg',
  ptt: false  // true = nota de voz, false = audio normal
})

// VIDEO — con caption opcional
await sock.sendMessage(jid, {
  video: { url: presignedUrl },  // o buffer
  caption: "Conoce nuestro consultorio"
})
```

IMPORTANTE: Verificar en el código actual de Baileys cómo se descargan/envían medios. Puede que se necesite descargar el archivo de S3 como buffer antes de enviar, ya que las presigned URLs pueden no funcionar directamente con Baileys en todos los casos. Probar primero con presigned URL, si no funciona, usar buffer.

### Estructura en S3

```
emma-media-{env}/
├── {business_id}/
│   ├── services/
│   │   ├── {service_id}/
│   │   │   ├── img_1.jpg
│   │   │   ├── img_2.png
│   │   │   ├── catalogo.pdf
│   │   │   ├── instrucciones.mp3
│   │   │   └── demo.mp4
│   │   └── ...
│   ├── payments/
│   │   └── (ya implementado en spec anterior)
│   └── general/
│       └── (futuro)
```

Nota: si el spec anterior usó `{service_id}_1.jpg` como nombre plano, migrar a subcarpeta `{service_id}/` para soportar múltiples archivos de distintos tipos.

---

## 2. Modelo de datos para media de servicios

### El problema

El spec anterior sugirió `media_keys` como array de strings en la tabla de servicios. Eso no soporta tipos distintos ni metadatos. Necesitamos una tabla dedicada.

### Tabla: `service_media`

```
service_media
├── id              (uuid, PK)
├── service_id      (uuid, FK → services)
├── business_id     (uuid, FK → businesses)
├── s3_key          (text, NOT NULL)    — ruta completa en S3
├── type            (enum: 'image' | 'pdf' | 'audio' | 'video')
├── filename        (text)              — nombre original del archivo
├── mimetype        (text)              — 'image/jpeg', 'application/pdf', etc.
├── size_bytes      (integer)           — tamaño del archivo
├── display_order   (integer, default 0) — orden de presentación
├── created_at      (timestamp)
└── updated_at      (timestamp)
```

Implementar con Drizzle. Si el spec anterior ya creó un campo `media_keys` en la tabla de servicios, migrarlo a esta tabla y eliminar el campo viejo.

### Endpoints necesarios (agregar o modificar los existentes)

1. **POST /.../{service_id}/media** — subir archivo de cualquier tipo
   - Validar: tipo de archivo permitido + tamaño máximo según tipo
   - Guardar en S3 en la subcarpeta del servicio
   - Crear registro en `service_media`
   - Retornar el registro creado

2. **GET /.../{service_id}/media** — listar todos los archivos de un servicio
   - Retornar registros de `service_media` con presigned URLs
   - Ordenados por `display_order`

3. **DELETE /.../{service_id}/media/{media_id}** — eliminar un archivo
   - Eliminar de S3
   - Eliminar registro de DB

4. **PATCH /.../{service_id}/media/reorder** — cambiar orden (opcional, si hay tiempo)
   - Recibe array de `{ media_id, display_order }`

---

## 3. StateMachine — Definición de nodos

### El problema

El flujo conversacional de Emma funciona como una máquina de estados. Cada nodo debe tener definido: OBJETIVO, PASOS, INSTANCIAS ADICIONALES (edge cases), EJEMPLO DE RESPUESTA. Esto es lo que se inyecta al LLM para que Emma sepa cómo comportarse en cada estado.

### Nodos del flujo principal

```
NODO: inicio_saludo
├── OBJETIVO: Dar la bienvenida e identificar la intención del cliente
├── PASOS:
│   1. Saludar usando el nombre del asistente y negocio (desde config IDENTIDAD)
│   2. Preguntar en qué puede ayudar
├── INSTANCIAS ADICIONALES:
│   - Cliente que regresa (ya ha conversado antes) → reconocer si es posible
│   - Cliente que llega enojado o con queja → tono empático, ofrecer derivación
│   - Cliente que manda solo "hola" sin más → responder y preguntar
├── EJEMPLO: "¡Hola! Soy Emma, asistente de Clínica Dental Sonrisa. ¿En qué puedo ayudarte hoy?"
│
▼
NODO: pregunta_asesoria
├── OBJETIVO: Entender qué busca el cliente ANTES de enviarle todo el catálogo
├── PASOS:
│   1. Escuchar/leer lo que el cliente pide
│   2. Clasificar: ¿busca servicio específico, quiere info general, o quiere agendar directo?
│   3. Si es claro → ir a listado filtrado. Si es vago → hacer pregunta de clarificación
├── INSTANCIAS ADICIONALES:
│   - Cliente que dice "quiero una cita" directo → saltar listado, ir a captura de datos
│   - Cliente que pregunta precios sin especificar servicio → pedir que elija primero
│   - Cliente que pregunta algo fuera del scope → responder si puede, derivar si no
├── EJEMPLO: "¡Claro! ¿Buscas algo en particular o te cuento sobre nuestros servicios?"
│
▼
NODO: listado_servicios
├── OBJETIVO: Mostrar servicios relevantes con su multimedia asociada
├── PASOS:
│   1. Filtrar servicios según lo que pidió el cliente
│   2. Enviar info de cada servicio: nombre, descripción, precio (si está configurado mostrarlo)
│   3. Si el servicio tiene media en DB → enviar según tipo (imagen con caption, PDF como documento, audio como audio)
│   4. Preguntar si quiere agendar o saber más de alguno
├── INSTANCIAS ADICIONALES:
│   - Servicio sin multimedia → enviar solo texto
│   - Cliente que pide servicio que no existe → ofrecer los más cercanos
│   - Múltiples servicios → enviar uno por uno, no todo junto (evitar spam)
├── EJEMPLO: "[Envía imagen del servicio] Limpieza dental - S/.80. Incluye evaluación y aplicación de flúor. ¿Te gustaría agendar?"
│
▼
NODO: decision_pago
├── OBJETIVO: Determinar si se necesita pago adelantado para continuar
├── PASOS:
│   1. Verificar configuración del negocio (toggle "requiere pago para agendar")
│   2. Si requiere pago → ir a métodos de pago
│   3. Si no requiere → ir directo a captura de datos
├── INSTANCIAS ADICIONALES:
│   - (este nodo es automático, no genera mensaje al cliente si no requiere pago)
├── EJEMPLO: (sin mensaje si no requiere pago)
│
▼
NODO: metodos_pago
├── OBJETIVO: Presentar opciones de pago y esperar comprobante
├── PASOS:
│   1. Listar métodos configurados (Yape, Plin, Transferencia, etc.) con los datos de cada uno
│   2. Indicar monto a pagar
│   3. Pedir que envíen foto del comprobante
│   4. Esperar imagen
├── INSTANCIAS ADICIONALES:
│   - Cliente no tiene el método disponible → ofrecer alternativas
│   - Cliente pregunta si puede pagar presencial → responder según config
│   - Cliente envía imagen que no es comprobante → pedir que reenvíe el correcto
├── EJEMPLO: "Puedes pagar S/.50 de anticipo por:\n- Yape: 987654321\n- Plin: 987654321\n\nEnvíame la foto del comprobante cuando lo hagas."
│
▼
NODO: verificacion_pago
├── OBJETIVO: Recibir comprobante, guardarlo, y esperar confirmación del dueño
├── PASOS:
│   1. Recibir imagen del cliente
│   2. Guardar en S3 → {business_id}/payments/{conversation_id}_{timestamp}.ext
│   3. Guardar referencia en DB
│   4. Notificar al dueño (panel + WhatsApp)
│   5. Enviar mensaje configurable al cliente: "Tu pago está siendo verificado"
│   6. Esperar confirmación del dueño
├── INSTANCIAS ADICIONALES:
│   - Dueño confirma → continuar flujo (pago correcto → captura datos o despedida)
│   - Dueño rechaza → mensaje al cliente + volver a métodos de pago
│   - Timeout (dueño no responde) → mensaje al cliente de que están verificando, será contactado
├── EJEMPLO: "¡Recibí tu comprobante! Estoy verificando el pago, te confirmo en breve."
│
▼
NODO: captura_datos
├── OBJETIVO: Recoger la información necesaria del cliente
├── PASOS:
│   1. Pedir cada campo configurado en FLUJO (nombre, correo, teléfono, dirección, fecha/hora, campos custom)
│   2. Validar formato donde aplique (email, teléfono, fecha válida)
│   3. Pedir campos uno a uno, no todos de golpe
├── INSTANCIAS ADICIONALES:
│   - Cliente da varios datos en un solo mensaje → parsear y extraer lo que se pueda
│   - Dato con formato inválido → pedir de nuevo amablemente
│   - Cliente quiere fecha que no está disponible → ofrecer alternativas (si hay agenda integrada)
├── EJEMPLO: "¡Perfecto! ¿A qué nombre agendo la cita?"
│
▼
NODO: correccion_datos
├── OBJETIVO: Permitir corregir datos sin recapturar todo
├── PASOS:
│   1. Preguntar QUÉ dato quiere cambiar (no pedir todos de nuevo)
│   2. Recibir el dato corregido
│   3. Volver a confirmación
├── INSTANCIAS ADICIONALES:
│   - Cliente quiere cambiar múltiples datos → uno a la vez
├── EJEMPLO: "¿Qué dato deseas cambiar? (nombre, fecha, hora, etc.)"
│
▼
NODO: confirmacion
├── OBJETIVO: Verificar que toda la información es correcta antes de confirmar
├── PASOS:
│   1. Mostrar resumen completo: servicio, fecha, hora, datos del cliente, monto pagado (si aplica)
│   2. Preguntar si todo está correcto
│   3. Si sí → despedida
│   4. Si no → ir a corrección de datos
├── INSTANCIAS ADICIONALES:
│   - Cliente confirma con variaciones ("sí", "ok", "dale", "perfecto") → reconocer como afirmativo
│   - Cliente dice que no sin especificar qué cambiar → preguntar qué dato corregir
├── EJEMPLO: "Tu cita queda así:\n📋 Servicio: Limpieza dental\n📅 Fecha: Jueves 25 de septiembre\n🕐 Hora: 3:00 PM\n👤 Nombre: Juan Pérez\n\n¿Todo correcto?"
│
▼
NODO: despedida
├── OBJETIVO: Cerrar la conversación exitosamente
├── PASOS:
│   1. Confirmar la cita/compra
│   2. Despedirse usando el mensaje configurado
│   3. Marcar conversación como completada en DB
├── INSTANCIAS ADICIONALES:
│   - Cliente hace otra pregunta después de la despedida → reactivar flujo
│   - Cliente no responde → no enviar más mensajes
├── EJEMPLO: "¡Listo! Tu cita en Clínica Dental Sonrisa quedó confirmada para el jueves 25 a las 3:00 PM. ¡Te esperamos! 😊"
```

### Nodos transversales (se activan desde cualquier punto)

```
NODO: derivacion_humano
├── OBJETIVO: Transferir la conversación a una persona real
├── TRIGGERS:
│   1. Cliente lo pide explícitamente ("quiero hablar con alguien", "persona real", "humano")
│   2. Emma no puede resolver después de X intentos (configurable, default 3)
│   3. Algo sale mal y no se puede concretar el servicio correctamente
├── PASOS:
│   1. Enviar mensaje configurable de derivación
│   2. Notificar al dueño (panel + WhatsApp) con contexto de la conversación
│   3. Marcar conversación como "derivada" en DB
│   4. Emma deja de responder en esa conversación hasta que el humano la cierre
├── EJEMPLO: "Voy a comunicarte con un asesor para que te ayude directamente. Un momento por favor."

NODO: fuera_de_horario
├── OBJETIVO: Atender fuera de horario sin perder al prospecto
├── TRIGGERS:
│   1. Mensaje entrante cuando el horario configurado está OFF
├── PASOS:
│   1. Responder con mensaje configurable de fuera de horario
│   2. Seguir conversando y capturando datos/intención (según config de comportamiento)
│   3. NO agendar citas ni procesar pagos
│   4. Notificar al dueño de la conversación pendiente
├── EJEMPLO: "Hola! Estamos fuera de nuestro horario de atención, pero cuéntame qué necesitas y te contactamos mañana a primera hora."
```

### Cómo se usa en el código

Estos nodos definen el **system prompt** que se le pasa al LLM. El bot debe:

1. Mantener el estado actual de la conversación en DB (qué nodo está activo)
2. Al recibir un mensaje, cargar el nodo actual con su definición
3. Construir el system prompt con: IDENTIDAD + MENSAJES relevantes + definición del NODO actual
4. El LLM responde dentro de las reglas del nodo
5. Según la respuesta del cliente, el bot decide si transicionar a otro nodo

Revisar cómo funciona actualmente la state machine en el código y adaptar estas definiciones al formato existente. NO reescribir la state machine desde cero — extender lo que hay.

---

## 4. Panel — Soporte multi-tipo en uploads

### Cambios necesarios

**Componente de upload de media en servicios:**

- Aceptar: `image/*, .pdf, application/pdf, audio/*, video/mp4`
- Mostrar preview según tipo:
  - Imagen → thumbnail
  - PDF → ícono de PDF + nombre del archivo
  - Audio → ícono de audio + nombre + player básico (opcional)
  - Video → ícono de video + nombre (no preview inline, es pesado)
- Validar tamaño máximo según tipo antes de subir
- Mostrar el `type` de cada archivo en la lista

**Listado de media por servicio:**

- Mostrar todos los archivos con: preview/ícono + nombre + tipo + botón eliminar
- Permitir reordenar (drag & drop es lujo — con flechas arriba/abajo basta por ahora)

---

## 5. Actualizaciones a S3

### Formatos aceptados (actualizado)

```
Imágenes: jpg, jpeg, png, webp
Documentos: pdf
Audio: mp3, wav, ogg
Video: mp4
```

### Validación de MIME types

```
image/jpeg, image/png, image/webp
application/pdf
audio/mpeg, audio/wav, audio/ogg
video/mp4
```

### Tamaños máximos

```
image: 5MB
pdf: 10MB
audio: 5MB
video: 16MB
```

---

## Orden de implementación

1. **Migrar modelo de datos** — crear tabla `service_media`, migrar datos si el spec anterior creó un campo simple en servicios
2. **Actualizar módulo S3** — soportar nuevos tipos, validar MIME types y tamaños por tipo
3. **Actualizar/crear endpoints** — CRUD de `service_media` con soporte multi-tipo
4. **Actualizar panel** — upload multi-tipo + preview por tipo + listado con íconos
5. **Actualizar bot** — envío multi-tipo por Baileys (image, document, audio, video según el type del media)
6. **Implementar definiciones de nodos de StateMachine** — adaptar al formato existente del código, conectar con el system prompt del LLM

---

## Lo que NO hacer

- No reescribir la state machine desde cero — extender lo que existe
- No romper lo que ya funciona del spec anterior
- No implementar recordatorios (es semana 2)
- No construir player de video en el panel — solo ícono + nombre
- No hacer drag & drop para reordenar — flechas simples o incluso solo el campo `display_order` editable
- No inventar patrones nuevos — seguir los que ya existen en el código
- No tocar el entorno prod hasta validar en dev