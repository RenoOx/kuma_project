---
name: panel-design-system
description: Convenciones de UI para la SPA React del panel del dueño en src/panel/. Úsala antes de crear páginas, componentes, hooks o clientes de API del panel — incluye los componentes Radix ya existentes, el patrón real de páginas/hooks/API, los tokens de color, dónde enganchar rutas en el Sidebar y cómo se maneja el token de sesión. Regla central: reutilizar lo que ya existe y no refactorizar lo que ya funciona.
---

# Skill: Panel Design System

> Antes de aplicar esta skill, LEE los archivos reales del proyecto:
> - `src/panel/styles/globals.css` — paleta, variables CSS, tokens
> - `src/panel/lib/constants.ts` — vocabulario compartido (días, nichos, estados)
> - `src/panel/lib/utils.ts` — helpers (`cn`, formatters de fecha y teléfono)
> - `src/panel/components/ui/` — componentes Radix ya existentes
>
> USA lo que ya existe. NO inventes nuevas variables ni tokens sin verificar
> que no existen ya. Esta skill es una guía, no un override.
>
> `PANEL_SPEC.md` prevalece sobre esta skill y sobre CLAUDE.md en todo lo que
> toque al panel.

## Build

La SPA es un build separado del servidor: Vite con `root: src/panel` y
`base: '/panel/'`, sale a `dist/panel` y la sirve `panelStatic.ts`.

`src/panel` está **excluido del tsconfig raíz** y tiene el suyo. `npm run
typecheck` corre los dos: `tsc --noEmit && tsc --noEmit -p src/panel/tsconfig.json`.
Un error de tipos en el panel no aparece si solo corrés el primero.

## Componentes UI existentes (Radix-based)

En `src/panel/components/ui/`:

```
avatar, badge, button, card, dialog, dropdown-menu, input, label,
scroll-area, select, separator, sheet, skeleton, switch, table, tabs, textarea
```

Para componentes nuevos, seguir el mismo patrón:

1. Primitiva desde el paquete `radix-ui` (paquete único, no `@radix-ui/react-*`):
   `import { Switch as SwitchPrimitive } from 'radix-ui'`
2. Tailwind CSS 4 para estilos
3. `cn()` de `lib/utils.js` para merge de clases
4. `class-variance-authority` solo si hay variantes reales (mirá `button.tsx`)
5. `data-slot="nombre"` en el elemento raíz, como los existentes
6. Tipar con `React.ComponentProps<typeof XPrimitive.Root>`, sin `forwardRef`

Antes de agregar una dependencia, verificá que la primitiva ya venga en
`radix-ui`:

```bash
node -e "console.log(Object.keys(require('radix-ui')).join(', '))"
```

Los que podrías necesitar y todavía no existen: `popover` (color picker de
tags), `tooltip`, `toast`.

### Imports con extensión `.js`

El panel usa `moduleResolution: NodeNext`: **todo import relativo lleva `.js`**,
incluso apuntando a un `.tsx`.

```tsx
import { cn } from '../../lib/utils.js'        // correcto
import { Button } from '../ui/button.js'        // correcto
import { Button } from '../ui/button'           // NO compila
```

## Tokens de color

Definidos en `globals.css` como `--color-*` de Tailwind 4, usables como clases
(`bg-emma-bg`, `text-q-lost`, `border-emma-border`):

```
emma-bg, emma-bg-secondary, emma-elevated, emma-border,
emma-text, emma-text-muted, emma-cream,
emma-accent, emma-accent-hover,
emma-sidebar, emma-sidebar-text,
emma-bubble-bot, emma-bubble-human
```

Más los semánticos de shadcn: `background`, `foreground`, `card`,
`card-foreground`, `muted`, `muted-foreground`, `border`, `input`, `accent`,
`destructive`, `primary`, `secondary`, `ring`.

Colores de calificación, uno por estado: `q-new`, `q-qualified`, `q-needs-info`,
`q-appointment`, `q-waiting`, `q-lost`, `q-human`. Se usan tinteados:
`bg-q-qualified/15 text-q-qualified`. El mapa completo de label + clases está en
`QUALIFICATION_META` (`lib/constants.ts`) — no lo dupliques.

## Layout existente

- `components/layout/PageLayout.tsx` — shell: Header + Sidebar + `<main>`
- `components/layout/Header.tsx`, `Sidebar.tsx`, `Logo.tsx`

**`PageLayout` ya lo aplica `App.tsx` alrededor de todas las rutas.** Una página
nueva NO se envuelve en `PageLayout` — devuelve su contenido directo. El gutter
(`p-3`) también lo pone el shell; no lo repitas en la página.

NO reescribir el layout. Solo agregar la ruta y el item de navegación.

## Rutas y navegación

Las rutas viven bajo `/:businessId/*`. Para agregar una pantalla:

1. `App.tsx`: `lazy()` + `<Route path="/loquesea" element={<X />} />`.
   Solo `InboxPage` va en el primer chunk; el resto es lazy.
2. `Sidebar.tsx`: una entrada más en el array `NAV`, con su icono de `lucide-react`.

Rutas actuales: `/` (Inbox), `/dashboard`, `/citas`, `/contactos`,
`/configuracion`. En español, sin prefijo.

Para navegar usá `PanelLink` de `lib/session.js`, no `<Link>` de react-router:
`PanelLink` reinyecta el `businessId` y el `token` en la URL.

## Patrón de páginas

Mirá `CustomersPage.tsx` o `ConfigPage.tsx` como referencia:

```tsx
export function ServicesPage(): React.JSX.Element {
  const { data, isLoading, isError } = useServices()

  if (isLoading) return <ServicesSkeleton />
  if (isError || !data) return <Notice title="No pudimos cargar…" body="…" />

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-6">
        <ServiceList services={data} />
      </div>
    </div>
  )
}
```

Anotá el retorno como `React.JSX.Element` — es lo que hace el resto del panel.

Estado que el usuario esperaría poder compartir o volver a abrir (qué contacto
está seleccionado, qué filtro) va en la URL con `useSearchParams`, no en
`useState`. Ver `CustomersPage`.

## Patrón de hooks

Mirá `hooks/useAppointments.ts`, `useSettings.ts`. Tanstack React Query, y el
hook **no recibe `businessId`**: lo saca de `useSession()`.

```tsx
export function useServices() {
  const session = useSession()
  return useQuery<ServicesResponse>({
    queryKey: ['services', session.businessId],
    queryFn: () => getServices(session),
    refetchInterval: POLL_MS.dashboard,  // omitir si no debe refrescar solo
  })
}
```

El `businessId` va **siempre** en la `queryKey`: sin él, dos negocios abiertos
en el mismo browser comparten caché.

Cadencias de polling en `POLL_MS` (`lib/constants.ts`). Datos que solo cambian
cuando alguien los edita en esa misma pantalla van con
`staleTime: Number.POSITIVE_INFINITY` y se invalidan desde la mutación — un
timer solo pelearía con el formulario que el dueño está tipeando.

Las mutaciones invalidan lo que cambió de verdad:

```tsx
onSuccess: () => {
  void queryClient.invalidateQueries({ queryKey: ['services', session.businessId] })
}
```

## Patrón de API

**No hay un `client.get/post/patch/delete`.** `api/client.ts` exporta dos
funciones y todas las llamadas pasan por ellas:

```tsx
apiGet<T>(session, path, params?)              // GET
apiSend<T>(session, 'POST' | 'PATCH', path, body?)
```

`apiSend` soporta **solo POST y PATCH**. No hay PUT ni DELETE: si necesitás
borrar algo, o extendés `apiSend` (cambio chico y compatible) o modelás la
operación como PATCH — por ejemplo mandando la lista completa sin el elemento,
que es lo que hace `special-days`.

El path es relativo a `/api/panel/:businessId`; el token lo agrega `buildUrl`.

```tsx
// src/panel/api/services.ts
import { apiGet, apiSend, type PanelSession } from './client.js'
import type { Service } from './types.js'

export function getServices(session: PanelSession): Promise<Service[]> {
  return apiGet<Service[]>(session, '/services')
}

export function updateService(
  session: PanelSession,
  id: string,
  patch: Partial<Service>,
): Promise<Service> {
  return apiSend<Service>(session, 'PATCH', `/services/${id}`, patch)
}
```

Los tipos del wire van en `api/types.ts`, **escritos a mano**. No se importan
del backend a propósito: los dos builds usan tsconfigs distintos y ese import
arrastraría el servidor al bundle del browser. El costo es que un cambio en el
backend hay que espejarlo ahí.

Los errores llegan como `PanelApiError` con `status`, `code` y `userMessage`
(el texto seguro que mandó el servidor). Para feedback al dueño, preferí
`userMessage` cuando exista: suele nombrar el campo que falló.

## Formularios

Guardado explícito con botón, no autosave: estos campos deciden lo que Emma le
dice a los clientes, y un autosave a mitad de tipeo publica un valor a medio
escribir. Mirá `components/config/SettingsCard.tsx` — da el marco (título,
cuerpo, botón, estado guardado/error) y `Field` da la fila etiquetada.

El botón se deshabilita si no hay cambios (`dirty`), comparando el borrador
local contra los datos del server.

## Responsive

El panel se usa desde el celular. El patrón del Sidebar es un solo elemento que
cambia de eje (`flex-row` abajo en móvil, `md:flex-col` como rail en desktop),
no dos componentes. Las filas de formulario stackean en móvil y pasan a dos
columnas desde `md`.

## Paleta de tags (para el sistema de etiquetas, bloque C)

Todavía no existe en el código. Cuando se implemente, 10 colores predefinidos,
tonos que funcionen sobre fondo oscuro:

```typescript
export const TAG_COLORS = [
  { name: 'emerald', hex: '#10B981' },
  { name: 'blue', hex: '#3B82F6' },
  { name: 'violet', hex: '#8B5CF6' },
  { name: 'rose', hex: '#F43F5E' },
  { name: 'amber', hex: '#F59E0B' },
  { name: 'cyan', hex: '#06B6D4' },
  { name: 'pink', hex: '#EC4899' },
  { name: 'indigo', hex: '#6366F1' },
  { name: 'orange', hex: '#F97316' },
  { name: 'teal', hex: '#14B8A6' },
] as const
```

Van en `lib/constants.ts`, que es donde vive todo lo que mapea un valor de la BD
a algo que lee una persona.

## Regla general

Si ya existe un componente, hook, o patrón que hace algo similar → reutilízalo.
Si necesitas algo nuevo → sigue el patrón de los existentes.
NO refactorizar lo que ya funciona como parte de la migración.
