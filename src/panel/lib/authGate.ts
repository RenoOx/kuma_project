import { useSyncExternalStore } from 'react'
import { PanelApiError } from '../api/client.js'

/**
 * One bit of global state: has the panel's token stopped being accepted?
 *
 * A token can be revoked or rotated while the owner has the panel open, and
 * every poll then starts answering 401. Handled per screen, that shows up as
 * four unrelated "no pudimos cargar" messages and no explanation. This is the
 * one place that answer is recorded, so the shell can replace the whole panel
 * with a screen that actually says the link stopped working.
 *
 * Deliberately outside React Query's cache: it is not data, it is the reason
 * there will be no data. Once set it never clears — the URL has to change,
 * which means a reload.
 */
let unauthorized = false
const listeners = new Set<() => void>()

export function isUnauthorized(error: unknown): boolean {
  return error instanceof PanelApiError && error.status === 401
}

export function markUnauthorized(error: unknown): void {
  if (unauthorized || !isUnauthorized(error)) return
  unauthorized = true
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useUnauthorized(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => unauthorized,
    // Server snapshot: this build has no SSR, but the third argument is what
    // keeps useSyncExternalStore from warning under StrictMode's double render.
    () => false,
  )
}
