import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PanelApiError } from '../api/client.js'
import { deleteServiceImage, getServiceImage, uploadServiceImage } from '../api/settings.js'
import type { ServiceImage } from '../api/types.js'
import { useSession } from '../lib/session.js'

export interface ServiceImageControls {
  /** Presigned and short-lived. Null while loading, or when the service has no photo. */
  url: string | null
  hasImage: boolean
  loading: boolean
  /** An upload or a delete is in flight. */
  busy: boolean
  error: string | null
  upload: (file: File) => void
  remove: () => void
}

/**
 * One service's photo: the signed URL to show, and the two writes that change it.
 *
 * The URL is fetched per service rather than alongside the settings, because
 * signing is per object: batching it into GET /settings would cost a signature for
 * every service on every page load and hand out URLs that expire before the owner
 * opens the card holding them.
 *
 * Both mutations invalidate `settings` as well as their own key — the stored
 * imageKey is what the catalogue reads to decide whether to show a "con foto"
 * badge, and what the bot reads to decide whether Emma can send it.
 */
export function useServiceImage(serviceId: string | undefined): ServiceImageControls {
  const session = useSession()
  const queryClient = useQueryClient()

  const key = ['serviceImage', session.businessId, serviceId]

  const query = useQuery<ServiceImage>({
    queryKey: key,
    queryFn: () => {
      // Unreachable while `enabled` is false; thrown rather than asserted so a
      // future caller that drops the guard fails loudly instead of sending
      // `/services/undefined/image`.
      if (serviceId === undefined) throw new Error('serviceId is required')
      return getServiceImage(session, serviceId)
    },
    enabled: serviceId !== undefined,
    // The URL is signed for an hour. Re-signing on every dialog open would be a
    // request per glance at a photo that has not changed.
    staleTime: 30 * 60 * 1000,
  })

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: key })
    void queryClient.invalidateQueries({ queryKey: ['settings', session.businessId] })
  }

  const uploadMutation = useMutation<ServiceImage, Error, File>({
    mutationFn: (file) => {
      if (serviceId === undefined) throw new Error('serviceId is required')
      return uploadServiceImage(session, serviceId, file)
    },
    onSuccess: invalidate,
  })

  const removeMutation = useMutation<ServiceImage, Error, void>({
    mutationFn: () => {
      if (serviceId === undefined) throw new Error('serviceId is required')
      return deleteServiceImage(session, serviceId)
    },
    onSuccess: invalidate,
  })

  const failure = uploadMutation.error ?? removeMutation.error ?? null

  return {
    url: query.data?.url ?? null,
    hasImage: query.data?.imageKey !== null && query.data?.imageKey !== undefined,
    loading: query.isLoading,
    busy: uploadMutation.isPending || removeMutation.isPending,
    error: failure ? errorText(failure) : null,
    upload: (file) => uploadMutation.mutate(file),
    remove: () => removeMutation.mutate(),
  }
}

// The server distinguishes too-large from unsupported with 413 and 415, and its
// userMessage already says which in Spanish — so it is shown as-is rather than
// flattened into one generic line the owner cannot act on.
function errorText(error: Error): string {
  if (error instanceof PanelApiError && error.userMessage) return error.userMessage
  return 'No pudimos subir la foto. Intentá de nuevo.'
}
