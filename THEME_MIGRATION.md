# Instrucción: Migración de paleta — Dark → Crema pastel (Propuesta A)

## Objetivo

Migrar TODO el frontend del panel de Emma de un tema oscuro (fondo negro, texto crema) a un tema claro de crema pastel (fondo crema, texto oscuro cálido). El sidebar se mantiene oscuro. El acento verde Emma no cambia.

## La propuesta visual aprobada

```
FONDO PÁGINA:     #FAF7F2  (crema pastel cálido)
CARDS/BLOQUES:    #FFFFFF  (blanco puro)
ELEVATED/HOVER:   #F0EBE3  (crema un tono más oscuro, para hovers y muted bg)
SIDEBAR:          #0a0f0d  (negro — SE MANTIENE OSCURO, no cambiar)
SIDEBAR TEXTO:    #f0e6da  (crema — SE MANTIENE, no cambiar)
TEXTO PRINCIPAL:  #2D2A26  (marrón oscuro cálido, NO negro puro)
TEXTO SECUNDARIO: #8C8478  (gris cálido)
BORDES:           #E8E2D9  (crema borde sutil)
ACENTO:           #059669  (verde Emma — NO CAMBIA)
ACENTO HOVER:     #047857  (verde oscuro — NO CAMBIA)
```

## Paso 1: Actualizar globals.css

Reemplazar SOLO las secciones `@theme` y `:root`. NO tocar el resto del archivo (FullCalendar overrides, scrollbar, etc.).

### @theme — reemplazar estos valores:

```css
@theme {
  --color-emma-bg: #FAF7F2;              /* ANTES: #0a0f0d */
  --color-emma-bg-secondary: #FFFFFF;    /* ANTES: #141a17 */
  --color-emma-sidebar: #0a0f0d;         /* SIN CAMBIO */
  --color-emma-elevated: #F0EBE3;        /* ANTES: #1c2521 */
  --color-emma-accent: #059669;          /* SIN CAMBIO */
  --color-emma-accent-hover: #047857;    /* SIN CAMBIO */
  --color-emma-cream: #FAF7F2;           /* ANTES: #f0e6da */
  --color-emma-text: #2D2A26;            /* ANTES: #f0e6da */
  --color-emma-text-muted: #8C8478;      /* ANTES: #9ca3af */
  --color-emma-sidebar-text: #f0e6da;    /* SIN CAMBIO */
  --color-emma-border: #E8E2D9;          /* ANTES: #1f2937 */
  --color-emma-bubble-bot: #059669;      /* SIN CAMBIO */
  --color-emma-bubble-human: #2D2A26;    /* ANTES: #f0e6da */
}
```

### :root — los mappings semánticos se recalculan solos porque apuntan a los tokens de arriba. Verificar que no haya hardcoded hex que override los tokens.

### html — cambiar color-scheme:

```css
/* ANTES */
html { color-scheme: dark; }

/* DESPUÉS */
html { color-scheme: light; }
```

### body — verificar que usa los tokens, no hex directo.

## Paso 2: Buscar y reemplazar hex hardcodeados

Buscar en TODOS los archivos de `src/panel/` estos colores hardcodeados y reemplazarlos con el token Tailwind equivalente:

```
BUSCAR                  → REEMPLAZAR CON (Tailwind class o token)
────────────────────────────────────────────────────────────────
#0a0f0d (en bg)         → Solo si es fondo de página, cambiar a bg-emma-bg
                          Si es sidebar, DEJAR COMO ESTÁ
#141a17                 → bg-emma-bg-secondary (o bg-card)
#1c2521                 → bg-emma-elevated (o bg-muted)
#f0e6da (en text)       → text-emma-text (o text-foreground)
#f0e6da (en bg)         → bg-emma-cream → ahora es bg-emma-bg
#9ca3af                 → text-emma-text-muted (o text-muted-foreground)
#1f2937 (en border)     → border-emma-border (o border-border)
```

IMPORTANTE: No hacer find-and-replace ciego. Revisar cada ocurrencia porque:
- `#0a0f0d` en el SIDEBAR debe mantenerse oscuro
- `#f0e6da` en el SIDEBAR TEXT debe mantenerse crema
- Solo cambiar los hex que están en el contenido principal, no en el sidebar

## Paso 3: Componentes que necesitan atención especial

### Sidebar (src/panel/components/layout/Sidebar.tsx)
- MANTENER el fondo oscuro (#0a0f0d o bg-emma-sidebar)
- MANTENER el texto crema (#f0e6da o text-emma-sidebar-text)
- MANTENER los iconos en colores claros
- El item activo sigue usando el verde accent
- NO tocar este componente salvo para verificar que usa tokens

### Header (src/panel/components/layout/Header.tsx)
- Cambiar fondo a crema (#FAF7F2) o bg-emma-bg
- Texto a oscuro (#2D2A26) o text-emma-text
- Verificar que el border inferior use el nuevo border color

### Chat bubbles (src/panel/components/inbox/MessageBubble.tsx)
- Bubble de Emma/bot: verde (#059669) con texto blanco — SIN CAMBIO
- Bubble del cliente: debe ser un gris claro suave (#F0EBE3) con texto oscuro
  NO usar el fondo crema de la página — necesita contraste
- Bubble del humano/dueño: un tono diferenciado — puede ser blanco (#FFF) con borde
- Fondo del área de chat: puede ser ligeramente más oscuro que la página (#F5F0E8) para crear profundidad

### QualificationBadge (src/panel/components/inbox/QualificationBadge.tsx)
- Los colores de qualification (--color-q-*) se mantienen
- Verificar contraste: los badges con fondo de color deben tener texto legible sobre fondo claro
- Si los badges usan bg con opacity, verificar que se ven bien sobre fondo crema

### StatsCards (src/panel/components/dashboard/StatsCards.tsx)
- Fondo de card: blanco (#FFF)
- Borde: #E8E2D9
- Label: #8C8478 (gris cálido muted)
- Valor: #2D2A26 (oscuro) o #059669 (verde para métricas destacadas)

### ActivityChart (src/panel/components/dashboard/ActivityChart.tsx)
- Recharts: verificar que los colores de las series se ven sobre fondo blanco
- Los chart tokens (--chart-1 a --chart-5) se mantienen, deberían funcionar

### ConversationList (src/panel/components/inbox/ConversationList.tsx)
- Cada item: fondo blanco o transparent, hover con #F0EBE3
- Item seleccionado: fondo #F0EBE3 o un verde muy sutil (rgba(5, 150, 105, 0.08))
- Preview de texto: #8C8478

### FullCalendar (globals.css — sección .emma-calendar)
Actualizar estos overrides:
```css
.emma-calendar {
  --fc-border-color: #E8E2D9;                    /* ANTES: var(--color-emma-border) — verificar */
  --fc-page-bg-color: #FFFFFF;                    /* ANTES: var(--color-emma-bg-secondary) */
  --fc-neutral-bg-color: #FAF7F2;                /* ANTES: var(--color-emma-bg) */
  --fc-neutral-text-color: #8C8478;              /* ANTES: var(--color-emma-text-muted) */
  --fc-today-bg-color: rgb(5 150 105 / 0.08);    /* Más sutil sobre fondo claro */
  --fc-non-business-color: rgb(0 0 0 / 0.03);    /* ANTES: rgba oscuro — ahora sutil sobre claro */
  --fc-now-indicator-color: var(--color-q-lost);  /* SIN CAMBIO */
  --fc-list-event-hover-bg-color: #F0EBE3;       /* ANTES: var(--color-emma-elevated) */
  --fc-highlight-color: rgb(5 150 105 / 0.08);   /* Más sutil sobre fondo claro */
}

.emma-calendar .fc-button {
  background-color: #FFFFFF;                      /* ANTES: var(--color-emma-bg) negro */
  border-color: #E8E2D9;                          /* ANTES: var(--color-emma-border) */
  color: #2D2A26;                                 /* ANTES: var(--color-emma-text) crema */
}

.emma-calendar .fc-button:hover:not(:disabled) {
  background-color: #F0EBE3;                      /* ANTES: var(--color-emma-elevated) */
}

.emma-calendar .fc-toolbar-title {
  color: #2D2A26;                                 /* ANTES: var(--color-emma-text) */
}
```

Si los FC overrides ya usan tokens (`var(--color-emma-*)`), los tokens nuevos se aplican automáticamente y no necesitas tocar esta sección.

### Skeleton loaders (src/panel/components/ui/skeleton.tsx)
- Verificar que el color del skeleton sea #F0EBE3 → #FAF7F2 (pulsing entre elevated y bg)
- Sobre fondo blanco de card, el skeleton debe ser #F5F0EA o similar

### Inputs y forms
- Background del input: #FFFFFF (blanco)
- Border: #E8E2D9
- Focus ring: #059669 (verde accent) — sin cambio
- Placeholder text: #8C8478
- Texto del input: #2D2A26

### Botones
- Primary: bg #059669, texto blanco — SIN CAMBIO
- Secondary/ghost: bg transparent o #F0EBE3, texto #2D2A26, border #E8E2D9
- Destructive: bg #EF4444, texto blanco — SIN CAMBIO

## Paso 4: Verificación visual

Después de aplicar todos los cambios:

1. Levantar `npm run dev:panel`
2. Navegar cada página: Dashboard, Inbox, Chat abierto, Appointments, Customers
3. Verificar en cada una:
   - ¿El sidebar sigue oscuro con texto crema? ✓
   - ¿El fondo de página es crema, no blanco ni negro? ✓
   - ¿Las cards son blancas con borde sutil? ✓
   - ¿El texto principal es marrón oscuro, legible? ✓
   - ¿El texto muted es gris cálido, no gris frío? ✓
   - ¿Los botones verdes se ven bien sobre fondo claro? ✓
   - ¿Los badges de qualification tienen buen contraste? ✓
   - ¿El chat tiene profundidad (fondo ligeramente diferente)? ✓
   - ¿FullCalendar se ve bien con colores claros? ✓
   - ¿Los hovers son sutiles y no desaparecen? ✓

## Regla general

Cuando tengas duda entre un gris frío y un gris cálido, SIEMPRE elige el cálido. La paleta de Emma es deliberadamente cálida — nada de `#6B7280` (gris azulado). Usa `#8C8478` (gris cálido) para muted, `#E8E2D9` (crema borde) para borders, `#F0EBE3` (crema hover) para elevated. La calidez es lo que hace que el panel se sienta premium y no genérico.