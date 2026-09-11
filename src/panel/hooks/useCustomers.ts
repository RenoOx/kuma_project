import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { getCustomerDetail, getCustomers } from '../api/customers.js'
import type { CustomerDetail, CustomerListItem, Paged } from '../api/types.js'
import { useSession } from '../lib/session.js'

export function useCustomers(args: { search?: string; page: number }) {
  const session = useSession()

  return useQuery<Paged<CustomerListItem>>({
    queryKey: ['customers', session.businessId, args.search ?? '', args.page],
    queryFn: () =>
      getCustomers(session, { ...(args.search ? { search: args.search } : {}), page: args.page }),
    // Same reasoning as the inbox: typing in the search box should not collapse
    // the table to a spinner between keystrokes.
    placeholderData: keepPreviousData,
  })
}

/** `null` closes the detail sheet, which is when the query should not run. */
export function useCustomerDetail(customerId: string | null) {
  const session = useSession()

  return useQuery<CustomerDetail>({
    queryKey: ['customer', session.businessId, customerId],
    queryFn: () => {
      if (!customerId) throw new Error('useCustomerDetail: query ran without a customer')
      return getCustomerDetail(session, customerId)
    },
    enabled: customerId !== null,
  })
}
