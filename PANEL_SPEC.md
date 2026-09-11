# Panel Emma V1 — Documento Definitivo para Claude Code

> Leer COMPLETO antes de escribir una sola línea de código.
> Este documento es la fuente de verdad. No asumir nada que no esté aquí.
> Fecha: 9 septiembre 2026

---

# REGLAS INQUEBRANTABLES

| Regla | Detalle |
|---|---|
| **NO TOCAR** | Prohibido modificar Baileys, manejo de sesiones, cola de envíos (`sendQueue.ts`), lógica anti-ban, `presence.ts`, `healthMonitor.ts`, `sendTelemetry.ts`, `authState.ts`, `sessionPolicy.ts`. Todo eso fue auditado y está cerrado. |
| **Stack Backend** | TypeScript, Node.js, Drizzle ORM, PostgreSQL. Validaciones con Zod. Respuestas HTTP estructuradas (200, 400, 401, 404). |
| **Stack Frontend** | React + TypeScript + TailwindCSS + Shadcn UI (componentes) + React Query / TanStack Query (polling y caché). |
| **Errores** | Early returns. Cero anidamiento profundo. Cero `any`. Envolver llamadas externas en try/catch. |
| **Envío de mensajes** | Todo mensaje saliente DEBE pasar por `enqueueSend` del `sendQueue.ts` existente. NUNCA llamar `sock.sendMessage` directamente. |
| **Ramas** | Trabajar en `dev`. No mergear a `main` sin review. |

---

# SETUP DEL FRONTEND (hacer PRIMERO)

El panel es una SPA (Single Page Application) dentro del mismo proyecto. Servida desde el mismo servidor de Railway.

## Estructura de carpetas

```
src/
├── panel/                          # TODO el frontend vive acá
│   ├── index.html                  # Entry point
│   ├── main.tsx                    # React mount
│   ├── App.tsx                     # Router principal
│   ├── api/                        # Funciones de fetch al backend
│   │   ├── client.ts               # Base fetch con token auth
│   │   ├── conversations.ts        # getConversations, getMessages, sendReply, returnToEmma
│   │   ├── appointments.ts         # getAppointments, approve, reject, complete
│   │   ├── customers.ts            # getCustomers, getCustomerDetail
│   │   ├── stats.ts                # getStats, getActivity, getQualificationBreakdown
│   │   └── health.ts               # getConnectionHealth
│   ├── components/
│   │   ├── layout/
│   │   │   ├── Sidebar.tsx         # Navegación: Inbox, Dashboard, Citas, Pacientes
│   │   │   ├── Header.tsx          # Nombre del negocio + indicador de conexión Emma
│   │   │   └── PageLayout.tsx
│   │   ├── inbox/
│   │   │   ├── ConversationList.tsx # Lista izquierda con filtros
│   │   │   ├── ConversationItem.tsx # Un item de la lista
│   │   │   ├── ChatView.tsx        # Panel derecho: historial + respuesta
│   │   │   ├── MessageBubble.tsx   # Burbuja individual (paciente/Emma/humano)
│   │   │   ├── ReplyInput.tsx      # Campo de respuesta del dueño
│   │   │   └── QualificationBadge.tsx # Badge de color por estado
│   │   ├── dashboard/
│   │   │   ├── StatsCards.tsx       # Cards de métricas
│   │   │   ├── QualificationBar.tsx # Desglose por estados
│   │   │   └── ActivityChart.tsx    # Gráfico 30 días
│   │   ├── appointments/
│   │   │   ├── AppointmentCalendar.tsx  # FullCalendar con eventos coloreados por estado
│   │   │   ├── AppointmentDetail.tsx    # Modal/sidebar con detalle + acciones
│   │   │   └── AppointmentActions.tsx   # Botones aprobar/rechazar/completar/cancelar
│   │   └── customers/
│   │       ├── CustomerList.tsx
│   │       └── CustomerDetail.tsx
│   ├── hooks/
│   │   ├── useConversations.ts     # React Query hook con polling
│   │   ├── useMessages.ts
│   │   ├── useStats.ts
│   │   ├── useAppointments.ts
│   │   ├── useCustomers.ts
│   │   └── useHealth.ts
│   ├── lib/
│   │   ├── constants.ts            # Colores, estados, labels
│   │   └── utils.ts                # Formateo de fechas, truncar texto
│   └── styles/
│       └── globals.css             # Tailwind imports + variables de paleta
```

## Librerías a instalar

```bash
# Frontend build
npm install react react-dom react-router-dom
npm install -D @types/react @types/react-dom

# UI
npm install tailwindcss @tailwindcss/forms
npm install class-variance-authority clsx tailwind-merge
# Shadcn UI: seguir setup de https://ui.shadcn.com/docs/installation
# Componentes a agregar: Button, Badge, Input, Card, Tabs, ScrollArea, Separator, Avatar, DropdownMenu

# Data fetching
npm install @tanstack/react-query

# Gráficos (para dashboard)
npm install recharts

# Calendario visual de citas
npm install @fullcalendar/react @fullcalendar/daygrid @fullcalendar/timegrid @fullcalendar/interaction @fullcalendar/list

# Build tool
npm install -D vite @vitejs/plugin-react
```

## Paleta Emma

```css
:root {
  --emma-bg: #0A0F0D;
  --emma-bg-secondary: #141A17;
  --emma-accent: #059669;
  --emma-accent-hover: #047857;
  --emma-cream: #F0E6DA;
  --emma-text: #E5E7EB;
  --emma-text-muted: #9CA3AF;
  --emma-border: #1F2937;

  /* Qualification colors */
  --q-new: #3B82F6;        /* blue */
  --q-qualified: #10B981;   /* green */
  --q-needs-info: #F59E0B;  /* yellow */
  --q-appointment: #047857; /* dark green */
  --q-waiting: #6B7280;     /* gray */
  --q-lost: #EF4444;        /* red */
  --q-human: #8B5CF6;       /* purple */
}
```

## Tipografía

```css
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

body {
  font-family: 'Inter', sans-serif;
}
```

## Vite config

```typescript
// vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  root: 'src/panel',
  build: {
    outDir: '../../dist/panel',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',  // proxy al backend en dev
    },
  },
})
```

## Servir el panel desde Express/Fastify

En el servidor existente, agregar una ruta que sirva los archivos estáticos del build del panel:

```typescript
// En el server principal, DESPUÉS de las rutas de API:
app.use('/panel', express.static('dist/panel'))
app.get('/panel/*', (req, res) => res.sendFile('dist/panel/index.html'))
```

---

# MIGRACIONES DE BASE DE DATOS

Antes de empezar a codear, revisar el schema existente de Drizzle. Los campos a agregar:

```sql
-- conversations: calificación y handoff
ALTER TABLE "conversations" ADD COLUMN "qualification" text DEFAULT 'new';
ALTER TABLE "conversations" ADD COLUMN "human_takeover_at" timestamp with time zone;

-- businesses: token de acceso al panel
ALTER TABLE "businesses" ADD COLUMN "panel_token" varchar(64);

-- messages: distinguir quién envió (Emma, humano, paciente)
ALTER TABLE "messages" ADD COLUMN "sender_type" text DEFAULT 'bot';
-- Valores: 'bot' (Emma), 'human' (dueño desde panel), 'customer' (paciente)
```

IMPORTANTE: Revisar si alguno de estos campos ya existe o si hay campos similares que se puedan reutilizar antes de crear nuevos. Verificar los nombres exactos de las tablas y columnas en el schema de Drizzle.

Generar la migración con Drizzle Kit después de actualizar el schema.

---

# HISTORIAS DE USUARIO

## US-01: Autenticación B2B sin fricción

**URL:** `/panel/:businessId?token=xxx`

- AC1: Middleware valida `?token=` contra `businesses.panel_token` para el `businessId` dado
- AC2: Sin token o token inválido → HTTP 401 `{ error: 'unauthorized' }`
- AC3: Stateless total. Sin JWT, sin cookies, sin sesiones
- AC4: Generar `panel_token` automáticamente (32 chars random) al crear un negocio si no tiene uno
- AC5: HTTPS obligatorio (Railway ya lo da)

**Middleware:**
```typescript
// src/api/middleware/panelAuth.ts
async function panelAuth(req, res, next) {
  const { businessId } = req.params
  const token = req.query.token
  if (!token) return res.status(401).json({ error: 'unauthorized' })
  const business = await businessRepo.findById(businessId)
  if (!business || business.panelToken !== token) return res.status(401).json({ error: 'unauthorized' })
  req.business = business
  next()
}
```

---

## US-02: Calificación Híbrida por Piggybacking

Emma califica el interés del paciente SIN hacer una llamada LLM extra.

- AC1: Modificar el system prompt de Emma para que retorne JSON estructurado: `{ respuesta_whatsapp: string, estado_interes: "qualified" | "browsing" | "disengaged" }`
- AC2: Parsear con Zod. Si el parseo falla, usar la respuesta raw como texto y defaultear a `null` (no cambiar estado)
- AC3: Mapeo de estados:
  - `"qualified"` → `conversations.qualification = 'qualified'`
  - `"browsing"` → no cambiar (se queda en 'new')
  - `"disengaged"` → `conversations.qualification = 'lost'`
- AC4: Actualizar el campo `qualification` en la BD después de cada respuesta de Emma
- AC5: Las reglas fijas tienen prioridad sobre el LLM:
  - Se creó appointment → `'appointment'` (siempre, aunque LLM diga otra cosa)
  - Emma escaló a humano → `'needs_info'`
  - Humano respondió desde panel → `'human_takeover'`

**IMPORTANTE:** No crear una llamada LLM nueva. Modificar el prompt existente para que el output incluya el campo extra. El costo adicional es ~5 tokens por respuesta (~$0.00001).

**Ejemplo de prompt modificado (agregar al final del system prompt existente):**
```
FORMATO DE RESPUESTA OBLIGATORIO:
Responde SIEMPRE en formato JSON con exactamente estos campos:
{
  "respuesta_whatsapp": "tu respuesta al paciente aquí",
  "estado_interes": "qualified" | "browsing" | "disengaged"
}

Reglas para estado_interes:
- "qualified": El paciente preguntó precios, disponibilidad, horarios, o mostró interés concreto.
- "browsing": Pregunta general sin compromiso claro.
- "disengaged": Indicó que no le interesa, es caro, o buscará en otro lado.
```

**Schema Zod:**
```typescript
const emmaResponseSchema = z.object({
  respuesta_whatsapp: z.string(),
  estado_interes: z.enum(['qualified', 'browsing', 'disengaged']),
})
```

---

## US-03: Inbox con Polling Optimizado

Vista principal del panel. Dos columnas: lista de conversaciones + chat abierto.

- AC1: React Query hace fetch cada 5s a `GET /api/panel/:businessId/updates` que retorna solo `{ hasUpdates: boolean, lastUpdate: timestamp }`
- AC2: Si `hasUpdates: true`, fetch completo a `GET /api/panel/:businessId/conversations`
- AC3: Lista de conversaciones muestra: avatar/iniciales, nombre o teléfono, preview último mensaje, timestamp relativo, badge de qualification
- AC4: Filtros por tabs: Todos | Nuevos | Calificados | Necesita info | Citas | Esperando | Perdidos | Humano
- AC5: Búsqueda por nombre o teléfono
- AC6: Ordenar por más reciente (default)
- AC7: Click en conversación → abre chat en columna derecha
- AC8: Chat muestra burbujas: paciente (izq), Emma (der, con label "Emma"), humano (der, con label nombre del dueño)
- AC9: Badges de Shadcn UI con colores de la paleta de qualification
- AC10: Mobile responsive: en pantalla chica, lista completa → click → chat completo con botón "atrás"

**Endpoints:**
```
GET /api/panel/:businessId/updates
  → { hasUpdates: boolean, lastUpdate: string }

GET /api/panel/:businessId/conversations?qualification=&search=&sort=recent&page=1&limit=20
  → { data: Conversation[], total: number, page: number }

GET /api/panel/:businessId/conversations/:conversationId/messages?page=1&limit=50
  → { data: Message[], total: number, page: number }
```

---

## US-04: Human Takeover

El dueño toma el control de una conversación desde el panel.

- AC1: Campo de texto en la parte inferior del chat. Placeholder: "Responder como [nombre del dueño]..."
- AC2: Al enviar: POST al backend → backend envía por WhatsApp vía `enqueueSend` con prioridad `'reply'`
- AC3: El mensaje se guarda en `messages` con `sender_type: 'human'`
- AC4: La conversación cambia a `qualification: 'human_takeover'` y `human_takeover_at: now()`
- AC5: En el handler de mensajes entrantes de Emma: al inicio, ANTES del debounce, verificar si la conversación está en `human_takeover`. Si sí → guardar el mensaje en BD (para que aparezca en el panel) pero NO procesar con LLM. Early return.
- AC6: Mientras esté en `human_takeover`, los mensajes del paciente siguen apareciendo en el panel en tiempo real (polling los trae)

**Endpoint:**
```
POST /api/panel/:businessId/conversations/:conversationId/reply
Body: { text: string }
→ { success: boolean, messageId: string }
```

---

## US-05: Auto-retorno por timeout

Si el dueño toma una conversación y se olvida, Emma retoma automáticamente.

- AC1: Worker (extender el existente o usar el de US-10) revisa cada 15 min
- AC2: Si `human_takeover_at` tiene más de 30 minutos → resetear `human_takeover_at` a null y `qualification` a `'new'`
- AC3: El siguiente mensaje del paciente se procesa normalmente por Emma
- AC4: Log de cada auto-retorno

---

## US-06: UI Optimista

El dueño siente que su mensaje se envía instantáneamente.

- AC1: Al enviar desde el panel, React Query hace `onMutate`: agrega el mensaje al chat local inmediatamente con estado "enviando" (burbuja gris con ícono de reloj)
- AC2: Cuando el backend confirma (HTTP 200), el mensaje cambia a "enviado" (burbuja normal)
- AC3: Si falla (HTTP error), el mensaje se marca como "error" (burbuja roja) con opción de reintentar
- AC4: Usar `useMutation` de TanStack Query con `onMutate` / `onSuccess` / `onError`

---

## US-07: Gestión de citas con calendario visual

Usar **FullCalendar** (@fullcalendar/react) — MIT, gratis, estándar de la industria.

### Layout: dos modos de vista

**Modo calendario (default):**
- FullCalendar con vistas: semana (default) + día + mes + lista
- Cada cita es un evento en el calendario con color según estado:
  - 🟡 Pendiente (amarillo) — necesita aprobación
  - 🟢 Confirmada (verde)
  - ✅ Completada (gris)
  - 🔴 Cancelada/Rechazada (rojo)
- Click en un evento → abre modal/sidebar con detalle de la cita + botones de acción

**Configuración de FullCalendar:**
```typescript
import FullCalendar from '@fullcalendar/react'
import dayGridPlugin from '@fullcalendar/daygrid'
import timeGridPlugin from '@fullcalendar/timegrid'
import interactionPlugin from '@fullcalendar/interaction'
import listPlugin from '@fullcalendar/list'

<FullCalendar
  plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin, listPlugin]}
  initialView="timeGridWeek"
  headerToolbar={{
    left: 'prev,next today',
    center: 'title',
    right: 'timeGridDay,timeGridWeek,dayGridMonth,listWeek'
  }}
  events={appointments.map(apt => ({
    id: apt.id,
    title: `${apt.customerName} - ${apt.service}`,
    start: apt.datetime,
    end: addMinutes(apt.datetime, apt.durationMinutes || 30),
    backgroundColor: statusColors[apt.status],
    borderColor: statusColors[apt.status],
    extendedProps: { appointment: apt }
  }))}
  eventClick={(info) => openAppointmentDetail(info.event.extendedProps.appointment)}
  slotMinTime="07:00:00"
  slotMaxTime="21:00:00"
  locale="es"
  height="auto"
  nowIndicator={true}
  businessHours={{
    daysOfWeek: [1, 2, 3, 4, 5, 6],  // lunes a sábado
    startTime: '08:00',
    endTime: '18:00',
  }}
/>
```

### Modal/Sidebar de detalle de cita

Al hacer click en un evento del calendario, se abre un panel lateral (o modal) con:
- Nombre del paciente + teléfono (link a su perfil en la vista de pacientes)
- Servicio solicitado
- Fecha y hora
- Estado actual con badge
- Notas (si hay)
- Botones de acción según el estado:
  - Si pendiente: "Aprobar" + "Rechazar"
  - Si confirmada: "Completar" + "Cancelar"
  - Si completada/cancelada: solo lectura

### Acciones

- AC1: Botón "Aprobar" → PATCH al backend → actualiza BD → envía confirmación al paciente por WhatsApp (`enqueueSend`, prioridad `'reply'`) → texto de confirmación con detalles de la cita
- AC2: Botón "Rechazar" con campo opcional de motivo → misma mecánica → envía mensaje de rechazo educado al paciente
- AC3: Botón "Completar" → solo actualiza estado en BD, no envía WhatsApp
- AC4: Botón "Cancelar" → actualiza BD → envía mensaje al paciente
- AC5: NO se envía WhatsApp al dueño cuando actúa desde el panel
- AC6: Badge con contador de citas pendientes en la navegación del panel
- AC7: Las citas se refrescan con polling cada 10 segundos (React Query)

### Horarios del negocio

FullCalendar tiene `businessHours` para sombrear las horas fuera del horario de atención. Cargar desde `business.settings.schedule` si existe, o usar un default de lunes a sábado 8am-6pm.

**Endpoints:**
```
GET /api/panel/:businessId/appointments?from=&to=
  → Array de citas para el rango de fecha (el calendario pide por semana/mes)
PATCH /api/panel/:businessId/appointments/:id/approve
PATCH /api/panel/:businessId/appointments/:id/reject   Body: { reason?: string }
PATCH /api/panel/:businessId/appointments/:id/complete
PATCH /api/panel/:businessId/appointments/:id/cancel    Body: { reason?: string }
```

---

## US-08: Dashboard de métricas

- AC1: Cards principales con número grande + comparación vs período anterior:
  - Conversaciones del período (hoy / esta semana / este mes) — toggle
  - Citas agendadas del período
  - Tiempo promedio de respuesta de Emma (en segundos)
  - Tasa de conversión: conversaciones → citas (porcentaje)
- AC2: Barra de desglose por calificación: mini-cards con cantidad por estado. Click → filtra el inbox a ese estado
- AC3: Gráfico de línea (Recharts): conversaciones por día, últimos 30 días
- AC4: Comparación: "+12% vs semana pasada" (o rojo si bajó)

**Endpoints:**
```
GET /api/panel/:businessId/stats?period=today|week|month
  → { conversations: number, appointments: number, avgResponseTime: number, conversionRate: number, prevConversations: number, prevAppointments: number }

GET /api/panel/:businessId/stats/qualification-breakdown
  → { new: number, qualified: number, needs_info: number, appointment: number, waiting: number, lost: number, human_takeover: number }

GET /api/panel/:businessId/activity?days=30
  → { data: Array<{ date: string, conversations: number }> }
```

---

## US-09: Lista de pacientes/contactos

- AC1: Lista paginada: nombre, teléfono, última interacción (fecha relativa), total conversaciones, total citas
- AC2: Búsqueda por nombre o teléfono
- AC3: Ordenar por última interacción (más reciente primero)
- AC4: Click → detalle: info del contacto + historial de citas + historial de conversaciones (links al inbox)
- AC5: Badge "Número inactivo" si `whatsapp_unreachable_at` no es null
- AC6: Label de nicho dinámico: "Pacientes" para dental/salud, "Clientes" para el resto (basado en `business.settings.niche`)

**Endpoints:**
```
GET /api/panel/:businessId/customers?search=&page=1&limit=20
GET /api/panel/:businessId/customers/:customerId
  → { customer: Customer, appointments: Appointment[], conversations: ConversationSummary[] }
```

---

## US-10: Worker de transición automática de estados

- AC1: Worker cada 15 minutos (extender el intervalo existente de workers o crear uno nuevo)
- AC2: Conversaciones en `new` o `qualified` donde el último mensaje de Emma tiene +2 horas sin respuesta del paciente → `waiting`
- AC3: Conversaciones en `waiting` donde el último mensaje tiene +24 horas → `lost`
- AC4: Conversaciones en `human_takeover` NO transicionan (el humano tiene el control)
- AC5: Conversaciones en `appointment` NO transicionan a `lost`
- AC6: Log de cada transición
- AC7: Guard de re-entrada (mismo patrón que sendReminders.ts)

---

## US-11: Devolver a Emma manualmente

- AC1: Botón "Devolver a Emma" visible en header del chat cuando `qualification === 'human_takeover'`
- AC2: Click → POST al backend → `human_takeover_at = null`, `qualification = 'new'`
- AC3: El siguiente mensaje del paciente es procesado por Emma con LLM
- AC4: Confirmación visual: badge cambia de 👤 morado a 🔵 azul
- AC5: Convive con US-05: si el dueño no devuelve manualmente, el auto-retorno de 30 min lo hace

**Endpoint:**
```
POST /api/panel/:businessId/conversations/:conversationId/return-to-emma
→ { success: boolean }
```

---

# INDICADOR DE CONEXIÓN (siempre visible)

En el header del panel, mini indicador:
- 🟢 "Emma conectada" si el negocio está en estado `connected`
- 🔴 "Emma desconectada hace X minutos" si no está conectado

Usa el endpoint de health que ya existe. React Query con polling cada 30 segundos.

```
GET /api/panel/:businessId/health
→ { connected: boolean, lastEventAt: string, downSince?: string }
```

---

# FLUJO COMPLETO: EMMA ↔ HUMANO ↔ PANEL

```
Estado normal:
  Paciente escribe → Emma responde + califica (US-02) → Panel muestra en tiempo real

Takeover:
  Dueño ve conversación en panel → Escribe respuesta (US-04)
  → qualification = 'human_takeover'
  → Emma deja de responder en esa conversación
  → Paciente sigue escribiendo → Mensajes llegan al panel (no a Emma)
  → Dueño responde desde panel

Devolver a Emma:
  Opción A: Dueño toca "Devolver a Emma" (US-11) → Emma retoma
  Opción B: Pasan 30 min sin que el dueño responda (US-05) → Emma retoma automáticamente

Citas:
  Paciente agenda → Emma notifica en panel (no por WA) → Dueño aprueba/rechaza desde panel (US-07)
  → Se envía confirmación/rechazo al paciente por WA
```

---

# POLLING vs WEBSOCKETS

V1 usa **polling con React Query.** No WebSockets.

- Inbox: fetch cada 5 segundos (con el patrón de US-03: check ligero primero, fetch completo solo si hay cambios)
- Dashboard: fetch cada 30 segundos
- Citas: fetch cada 10 segundos
- Health: fetch cada 30 segundos

Esto es suficiente para 1-3 clientes. WebSockets es V2 cuando el volumen lo requiera.

---

# MULTI-NICHO

El panel se adapta al nicho del negocio basándose en `business.settings.niche`:

| Elemento | Dental / Salud | Estética / Spa | Genérico |
|---|---|---|---|
| Label de navegación — contactos | "Contactos" | "Contactos" | "Contactos" |
| Label de navegación — citas | "Agenda" | "Agenda" | "Agenda" |
| Palabra para una persona (dentro del texto) | "paciente" | "cliente" | "cliente" |
| Mensaje de bienvenida del dashboard | "Resumen de atención" | "Resumen del centro" | "Resumen del negocio" |

La **navegación** dice lo mismo en todos los nichos: "Agenda" y "Contactos". Los
labels siguen viviendo en `NicheCopy` (no en constantes globales) para que un
nicho pueda volver a divergir cambiando una línea, pero hoy los cinco comparten
valor. Lo que sí varía de verdad es el vocabulario **dentro** de las pantallas:
una clínica habla de "paciente" y una barbería de "cliente".

El header no lleva ícono de nicho: lleva el `<Logo />` de Emma en el sidebar y
el nombre del negocio en el header. El campo `icon` fue eliminado de `NicheCopy`.

Implementar como un objeto de configuración en `constants.ts` indexado por niche. NO crear componentes separados por nicho.

---

# LO QUE NO ENTRA EN V1

- Login con usuario/contraseña / roles / multi-usuario
- Responder con imágenes/archivos/audios desde el panel
- WebSockets / real-time verdadero
- Drag & drop de citas en el calendario (V2)
- Campañas / broadcasts / mensajes masivos
- Configuración de flujos de Emma desde el panel
- Notificaciones push / desktop notifications
- Notas internas en conversaciones
- Exportar datos / reportes PDF
- Langfuse / Helicone / Sentry / observabilidad avanzada
- Entorno de staging separado
- Anti-troll (límite de mensajes por sesión)
- Autoridad transaccional con function calling para citas

---

# ORDEN DE IMPLEMENTACIÓN

| Fase | Días | Qué |
|---|---|---|
| **0** | Medio día | Setup: instalar dependencias frontend, configurar Vite, Tailwind, Shadcn, React Query. Migración de BD. Middleware de auth. Verificar que compila y sirve una página vacía. |
| **1** | 2 días | Backend: todos los endpoints del panel. Lógica de calificación (modificar prompt + parseo Zod). Handler de human_takeover (early return). Worker de transiciones. |
| **2** | 2 días | Frontend: Inbox completo (ConversationList + ChatView + ReplyInput + QualificationBadge). Polling con React Query. UI optimista. |
| **3** | 1 día | Frontend: Dashboard + Citas + Pacientes. Navegación. Indicador de conexión. |
| **4** | Medio día | Responsive, pulido visual, testing manual, deploy a Railway. |
---

# PARA VERIFICAR ANTES DE EMPEZAR

1. ¿Los nombres de las tablas en Drizzle son `conversations`, `messages`, `appointments`, `customers`, `businesses`? Verificar el schema real.
2. ¿Las conversaciones ya tienen un campo `status` que se pueda extender en vez de crear `qualification`?
3. ¿Los messages ya tienen un campo que distinga dirección (inbound/outbound)? Si sí, `sender_type` complementa, no duplica.
4. ¿Existe ya algún endpoint de API que sirva como referencia de estilo/patrón para los nuevos?
5. ¿El servidor es Express o Fastify? Afecta el middleware y cómo se sirven archivos estáticos.
6. ¿Vite ya está configurado o es completamente nuevo?