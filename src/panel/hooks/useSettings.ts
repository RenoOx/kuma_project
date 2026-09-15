import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PanelApiError } from '../api/client.js'
import {
  getIntegrations,
  getSettings,
  updateBooking,
  updateGeneral,
  updatePayments,
  updateSchedule,
  updateServices,
  updateSpecialDays,
} from '../api/settings.js'
import type {
  BookingPatch,
  GeneralPatch,
  OperatingHours,
  PanelIntegrations,
  PanelService,
  PanelSettings,
  PaymentsPatch,
  SpecialDay,
} from '../api/types.js'
import { POLL_MS } from '../lib/constants.js'
import { useSession } from '../lib/session.js'

export function useSettings() {
  const session = useSession()
  return useQuery<PanelSettings>({
    queryKey: ['settings', session.businessId],
    queryFn: () => getSettings(session),
    // Configuration only changes when someone on this screen changes it, and
    // every mutation below invalidates the key. A timer would only fight the
    // form for control of fields the owner is mid-edit.
    staleTime: Number.POSITIVE_INFINITY,
  })
}

/**
 * The four save actions as one mutation.
 *
 * They share an invalidation because they share a consequence: the stored
 * settings moved. `me` goes with it — the header's business name and the
 * niche-driven copy both come from there, so renaming the business without
 * this leaves the old name in the header until a reload.
 */
export type SettingsSave =
  | { section: 'general'; patch: GeneralPatch }
  | { section: 'schedule'; operatingHours: OperatingHours }
  | { section: 'specialDays'; specialDays: SpecialDay[] }
  | { section: 'booking'; patch: BookingPatch }
  | { section: 'services'; services: PanelService[] }
  | { section: 'payments'; patch: PaymentsPatch }

export function useSaveSettings() {
  const session = useSession()
  const queryClient = useQueryClient()

  return useMutation<unknown, Error, SettingsSave>({
    mutationFn: (save) => {
      if (save.section === 'general') return updateGeneral(session, save.patch)
      if (save.section === 'schedule') return updateSchedule(session, save.operatingHours)
      if (save.section === 'specialDays') return updateSpecialDays(session, save.specialDays)
      if (save.section === 'services') return updateServices(session, save.services)
      if (save.section === 'payments') return updatePayments(session, save.patch)
      return updateBooking(session, save.patch)
    },
    onSuccess: (_data, save) => {
      void queryClient.invalidateQueries({ queryKey: ['settings', session.businessId] })
      if (save.section === 'general') {
        void queryClient.invalidateQueries({ queryKey: ['me', session.businessId] })
      }
      // The calendar shades working hours from the weekly schedule, so both of
      // these change what Citas draws.
      if (save.section === 'schedule' || save.section === 'specialDays') {
        void queryClient.invalidateQueries({ queryKey: ['me', session.businessId] })
      }
    },
  })
}

export function useIntegrations() {
  const session = useSession()
  return useQuery<PanelIntegrations>({
    queryKey: ['integrations', session.businessId],
    queryFn: () => getIntegrations(session),
    refetchInterval: POLL_MS.health,
  })
}

export interface SectionSave {
  save: (payload: SettingsSave) => void
  saving: boolean
  saved: boolean
  error: string | null
}

/**
 * One section's save button, with the feedback it shows afterwards.
 *
 * Wraps useSaveSettings so each card tracks its own outcome: with four forms on
 * one screen, a shared mutation would light up "Guardado" under every card
 * when the owner saved one of them.
 *
 * The error text comes from the server's `message`, which is the userMessage
 * field — the one built to be safe to show. A merged-settings rejection names
 * the fields that failed, so the owner sees which row to fix.
 */
export function useSectionSave(): SectionSave {
  const mutation = useSaveSettings()

  return {
    save: (payload) => mutation.mutate(payload),
    saving: mutation.isPending,
    saved: mutation.isSuccess,
    error: mutation.isError ? errorText(mutation.error) : null,
  }
}

function errorText(error: Error): string {
  // The server's userMessage names the fields that failed validation, which is
  // the difference between "no pudimos guardar" and knowing which row is wrong.
  if (error instanceof PanelApiError && error.userMessage) return error.userMessage
  return 'No pudimos guardar. Intentá de nuevo.'
}
