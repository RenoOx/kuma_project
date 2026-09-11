import { apiGet, type PanelSession } from './client.js'
import type { CustomerDetail, CustomerListItem, Paged } from './types.js'

export interface CustomerQuery {
  search?: string
  page: number
  limit?: number
}

export function getCustomers(
  session: PanelSession,
  query: CustomerQuery,
): Promise<Paged<CustomerListItem>> {
  return apiGet<Paged<CustomerListItem>>(session, '/customers', {
    ...(query.search ? { search: query.search } : {}),
    page: String(query.page),
    ...(query.limit ? { limit: String(query.limit) } : {}),
  })
}

export function getCustomerDetail(
  session: PanelSession,
  customerId: string,
): Promise<CustomerDetail> {
  return apiGet<CustomerDetail>(session, `/customers/${customerId}`)
}
