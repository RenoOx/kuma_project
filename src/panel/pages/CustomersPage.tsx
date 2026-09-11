import { useSearchParams } from 'react-router-dom'
import { CustomerDetail } from '../components/customers/CustomerDetail.js'
import { CustomerList } from '../components/customers/CustomerList.js'
import { useMe } from '../hooks/useMeta.js'
import { nicheCopy } from '../lib/constants.js'

/**
 * Contacts (US-09).
 *
 * Which contact is open lives in the URL rather than in state, because an
 * appointment's detail sheet links straight here with ?customer=… — the owner
 * goes from a booking to that person's history in one click, and the link works
 * from anywhere in the panel.
 */
export function CustomersPage(): React.JSX.Element {
  const { data: me } = useMe()
  const copy = nicheCopy(me?.niche)
  const [params, setParams] = useSearchParams()
  const selected = params.get('customer')

  const setSelected = (customerId: string | null): void => {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (customerId) next.set('customer', customerId)
      else next.delete('customer')
      return next
    })
  }

  return (
    <>
      <CustomerList contactsLabel={copy.contactsLabel} onSelect={setSelected} />
      <CustomerDetail customerId={selected} onClose={() => setSelected(null)} />
    </>
  )
}
