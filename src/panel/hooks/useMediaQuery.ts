import { useSyncExternalStore } from 'react'

/**
 * Subscribes to a CSS media query from JavaScript.
 *
 * For layout, a Tailwind breakpoint is always the better answer. This exists
 * for the cases where a component's *behaviour* changes with width — the
 * calendar picks a different initial view on a phone, which is a prop, not a
 * class.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    () => window.matchMedia(query).matches,
    () => false,
  )
}

/** Tailwind's `md` breakpoint, so JS and CSS agree on where a phone ends. */
export function useIsDesktop(): boolean {
  return useMediaQuery('(min-width: 768px)')
}
