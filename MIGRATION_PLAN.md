# MIGRATION_PLAN.md — Migración Admin → Panel del Cliente

> Este documento define la migración de funcionalidades del admin al panel
> del cliente. Es el roadmap para Claude Code. CLAUDE.md y PANEL_SPEC.md
> prevalecen para convenciones de código y arquitectura.

## Estado actual del panel

### Ya implementado
- DashboardPage: StatsCards, ActivityChart, QualificationBar
- InboxPage: ConversationList, ConversationItem, ChatView, MessageBubble, ReplyInput, QualificationBadge
- AppointmentsPage: AppointmentCalendar, AppointmentDetail, AppointmentActions
- CustomersPage: CustomerList, CustomerDetail
- Layout: Header, Sidebar, PageLayout, Logo
- 14 componentes UI Radix (button, card, dialog, input, tabs, etc.)
- 11 hooks custom (conversations, appointments, customers, stats, messages, meta, reply, panelSync, dragScroll, mediaQuery)
- Auth por token + session context
- API client con endpoints para appointments, conversations, customers, meta, stats

### Falta implementar

#### BLOQUE A: ServicesPage (nuevo) — ~2 días
Migrar desde admin: CRUD servicios, métodos de pago, knowledge base.

```
src/panel/
├── pages/ServicesPage.tsx
├── components/services/
│   ├── ServiceList.tsx          # Lista CRUD con toggle activar/desactivar
│   ├── ServiceForm.tsx          # Modal crear/editar (nombre, duración, precio mín/máx, requiere evaluación)
│   ├── PaymentMethods.tsx       # CRUD métodos pago (Yape/Plin/Transfer/Efectivo) + adelanto
│   └── KnowledgeBase.tsx        # Tabs: Políticas, FAQs, Promociones (CRUD cada una)
├── api/services.ts              # GET/POST/PATCH/DELETE /api/panel/:bid/services
├── api/payments.ts              # GET/POST/PATCH/DELETE /api/panel/:bid/payment-methods
├── api/knowledge.ts             # GET/POST/PATCH/DELETE /api/panel/:bid/knowledge
├── hooks/useServices.ts
├── hooks/usePaymentMethods.ts
└── hooks/useKnowledge.ts
```

Backend:
```
src/modules/panel/
├── services.routes.ts           # Hono routes para CRUD servicios
├── services.service.ts          # Lógica de negocio
├── payments.routes.ts
├── payments.service.ts
├── knowledge.routes.ts
└── knowledge.service.ts
```

Criterios de aceptación:
- [ ] CRUD completo de servicios con validación Zod
- [ ] Toggle activar/desactivar sin eliminar
- [ ] Servicios desactivados NO aparecen en prompts de Emma
- [ ] "Requiere evaluación" → Emma NO da precio, dice que requiere evaluación
- [ ] CRUD métodos de pago funcional
- [ ] Toggle adelanto + monto
- [ ] Knowledge base: CRUD políticas, FAQs, promos
- [ ] Emma usa las FAQs y políticas configuradas

#### BLOQUE B: ConfigPage (nuevo) — ~2 días
Migrar desde admin: datos del negocio, tipo, modo atención, horarios, integraciones.

```
src/panel/
├── pages/ConfigPage.tsx
├── components/config/
│   ├── GeneralSettings.tsx      # Nombre, tipo negocio, modo atención, timezone, dueño, dirección, maps
│   ├── ScheduleSettings.tsx     # Horario semanal + breaks
│   ├── SpecialDays.tsx          # CRUD días especiales/feriados
│   ├── BookingSettings.tsx      # Modo reserva, anticipación mín, reenvío imágenes, recordatorios
│   ├── IntegrationWhatsApp.tsx  # Estado conexión, QR, número conectado
│   └── IntegrationCalendar.tsx  # Google Calendar: estado + connect/disconnect
├── api/settings.ts
├── api/schedule.ts
├── hooks/useSettings.ts
└── hooks/useSchedule.ts
```

Backend (gran parte ya existe en admin — migrar/exponer a panel routes):
```
src/modules/panel/
├── settings.routes.ts
├── settings.service.ts
├── schedule.routes.ts
└── schedule.service.ts
```

Criterios de aceptación:
- [ ] Todos los campos del admin migrados al panel
- [ ] Dropdown tipo de negocio: SOLO 10 tipos (Salud + Estética)
- [ ] Modo atención: "solo cita previa" / "presencial + citas opcionales"
- [ ] Horario semanal editable con breaks
- [ ] CRUD días especiales con override de horario
- [ ] Config recordatorios: toggles 24h y 2h
- [ ] Estado WhatsApp visible + QR funcional
- [ ] Google Calendar: connect/disconnect
- [ ] Zona de peligro: desconectar WA con confirmación
- [ ] Emma respeta horarios, días especiales, modo atención, recordatorios

#### BLOQUE C: Features nuevas en Inbox — ~1.5 días
Agregar tags, toggles Emma, y reorganizar contactos.

```
src/panel/
├── components/inbox/
│   ├── TagManager.tsx           # CRUD etiquetas (nombre + color, máx 10)
│   ├── TagBadge.tsx             # Badge visual de etiqueta
│   ├── EmmaToggle.tsx           # Toggle Emma on/off (per-chat y global)
│   └── ContactsTab.tsx          # Tab dentro de Inbox con lista de contactos
├── api/tags.ts
└── hooks/useTags.ts
```

DB: nuevas tablas
```sql
-- tags
CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- conversation_tags (many-to-many)
CREATE TABLE conversation_tags (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  tag_id TEXT NOT NULL REFERENCES tags(id),
  UNIQUE(conversation_id, tag_id)
);
```

Modificaciones a tablas existentes:
```sql
ALTER TABLE conversations ADD COLUMN emma_enabled BOOLEAN DEFAULT true;
ALTER TABLE businesses ADD COLUMN emma_global_enabled BOOLEAN DEFAULT true;
```

Criterios de aceptación:
- [ ] CRUD etiquetas: nombre libre + color de paleta (máx 10 por negocio)
- [ ] Asignar/quitar etiquetas a conversaciones
- [ ] Filtrar conversaciones por etiqueta
- [ ] Toggle Emma per-chat: desactivar Emma en un chat específico
- [ ] Toggle Emma global: desactivar Emma en todo el negocio
- [ ] handler.ts respeta `emma_enabled` y `emma_global_enabled`
- [ ] Contactos como tab dentro de InboxPage (reutilizar CustomerList)

#### BLOQUE D: Crear cita manual + mejoras Agenda — ~1 día

```
src/panel/
├── components/appointments/
│   ├── CreateAppointmentModal.tsx  # Form: contacto, servicio, fecha, hora, notas
│   └── AppointmentFilters.tsx      # Filtros por estado en calendario
```

Criterios de aceptación:
- [ ] Botón "+" en AppointmentsPage abre modal
- [ ] Seleccionar contacto existente o crear nuevo
- [ ] Seleccionar servicio de la lista activa
- [ ] Validar conflictos de horario
- [ ] Cita creada aparece en calendario inmediatamente
- [ ] Aprobar/rechazar citas pendientes (si modo = requiere aprobación)

#### BLOQUE E: Limpieza y deuda técnica — ~1 día

- [ ] Eliminar tipos de negocio no soportados del enum/schema
- [ ] Actualizar prompts.ts: solo 10 tipos, todo dinámico
- [ ] Limpiar rutas admin ya migradas
- [ ] Verificar máquina de estados respeta todas las configs nuevas
- [ ] Verificar que el nombre del cliente se persiste y se usa en toda la conversación
- [ ] `npm run check` pasa limpio

## Orden de ejecución recomendado

```
1. BLOQUE B (Config)       — base para todo: horarios, tipo negocio, settings
2. BLOQUE A (Servicios)    — CRUD core + knowledge base
3. BLOQUE C (Inbox tags)   — features nuevas sobre lo que ya funciona
4. BLOQUE D (Citas manual) — mejora sobre appointments existente
5. BLOQUE E (Limpieza)     — al final, cuando todo funciona
```

Razón: Config primero porque define el tipo de negocio y los horarios que afectan todo lo demás. Servicios segundo porque es lo que Emma necesita para responder. Tags y citas manuales son mejoras incrementales. Limpieza al final.

## Sidebar actualizado

```
📊 Inicio          → DashboardPage (ya existe)
💬 Conversaciones   → InboxPage (ya existe + tags + emma toggle + contactos tab)
📅 Agenda           → AppointmentsPage (ya existe + crear manual)
🛠 Servicios        → ServicesPage (NUEVO)
⚙️ Configuración    → ConfigPage (NUEVO)
```

## Estimación total: 7-8 días de desarrollo enfocado