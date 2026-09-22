import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PanelApiError } from '../api/client.js'
import {
  deleteOwnerMedia,
  getOwnerMedia,
  type MediaOwner,
  reorderOwnerMedia,
  uploadOwnerMedia,
} from '../api/settings.js'
import type { ServiceMediaView } from '../api/types.js'
import { useSession } from '../lib/session.js'

export interface ServiceMediaControls {
  /** In display order. Empty while loading and when the service has no files. */
  items: ServiceMediaView[]
  loading: boolean
  /** An upload, a delete or a reorder is in flight. */
  busy: boolean
  error: string | null
  upload: (file: File) => void
  remove: (mediaId: string) => void
  move: (mediaId: string, delta: number) => void
}

/**
 * One owner's files: what to show, and the three writes that change them.
 *
 * An owner is a service of the catalogue or a step of the conversation. The two
 * behave identically from here down — same table, same limits, same order — so
 * they share one hook rather than two that would drift.
 *
 * Fetched per owner rather than alongside the settings, because signing is per
 * object: batching it into GET /settings would cost a signature for every file
 * of every service on every page load, and hand out URLs that expire before the
 * owner opens the card holding them.
 *
 * Every mutation invalidates `settings` too. A file is what makes Emma mark a
 * service "[con material]" in her prompt, so uploading the first one or deleting
 * the last one changes what the catalogue says about that service.
 */
export function useOwnerMedia(owner: MediaOwner | undefined): ServiceMediaControls {
  const session = useSession()
  const queryClient = useQueryClient()

  // The kind is part of the key, not decoration: a service and a step are both
  // nanoids and a shared key would serve one's files as the other's.
  const key = ['serviceMedia', session.businessId, owner?.kind, owner?.id]

  const query = useQuery<ServiceMediaView[]>({
    queryKey: key,
    queryFn: () => {
      // Unreachable while `enabled` is false; thrown rather than asserted so a
      // future caller that drops the guard fails loudly instead of requesting
      // `/services/undefined/media`.
      if (owner === undefined) throw new Error('media owner is required')
      return getOwnerMedia(session, owner)
    },
    enabled: owner !== undefined,
    // URLs are signed for an hour. Re-signing on every dialog open would be a
    // request per glance at files that have not changed.
    staleTime: 30 * 60 * 1000,
  })

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: key })
    void queryClient.invalidateQueries({ queryKey: ['settings', session.businessId] })
  }

  const requireOwner = (): MediaOwner => {
    if (owner === undefined) throw new Error('media owner is required')
    return owner
  }

  const uploadMutation = useMutation<ServiceMediaView, Error, File>({
    mutationFn: (file) => uploadOwnerMedia(session, requireOwner(), file),
    onSuccess: invalidate,
  })

  const removeMutation = useMutation<{ id: string }, Error, string>({
    mutationFn: (mediaId) => deleteOwnerMedia(session, requireOwner(), mediaId),
    onSuccess: invalidate,
  })

  const reorderMutation = useMutation<ServiceMediaView[], Error, string[]>({
    mutationFn: (ids) => reorderOwnerMedia(session, requireOwner(), ids),
    onSuccess: invalidate,
  })

  const items = query.data ?? []

  const move = (mediaId: string, delta: number): void => {
    const from = items.findIndex((item) => item.id === mediaId)
    const to = from + delta
    if (from === -1 || to < 0 || to >= items.length) return

    // The whole arrangement is sent, not the pair that swapped: the server
    // refuses a list that does not match what it holds, which is what stops a
    // stale tab from writing an order built on files that are already gone.
    const ids = items.map((item) => item.id)
    const moved = ids[from]
    const displaced = ids[to]
    if (!moved || !displaced) return
    ids[from] = displaced
    ids[to] = moved
    reorderMutation.mutate(ids)
  }

  const failure = uploadMutation.error ?? removeMutation.error ?? reorderMutation.error ?? null

  return {
    items,
    loading: query.isLoading,
    busy: uploadMutation.isPending || removeMutation.isPending || reorderMutation.isPending,
    error: failure ? errorText(failure) : null,
    upload: (file) => uploadMutation.mutate(file),
    remove: (mediaId) => removeMutation.mutate(mediaId),
    move,
  }
}

// The server distinguishes too-large from unsupported with 413 and 415, and its
// userMessage already names the limit for THAT type in Spanish — so it is shown
// as-is rather than flattened into one generic line the owner cannot act on.
function errorText(error: Error): string {
  if (error instanceof PanelApiError && error.userMessage) return error.userMessage
  return 'No pudimos subir el archivo. Intentá de nuevo.'
}
