import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './App.js'
import { isUnauthorized, markUnauthorized } from './lib/authGate.js'
import './styles/globals.css'

// Every rejected query and mutation passes through here on its way to the
// component that asked for it, which makes this the one place that can notice a
// revoked token no matter which screen was polling when it happened.
const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: markUnauthorized }),
  mutationCache: new MutationCache({ onError: markUnauthorized }),
  defaultOptions: {
    queries: {
      // The panel polls on its own schedule (see POLL_MS), so refetching on
      // every window focus on top of that is duplicated load for no new data.
      refetchOnWindowFocus: false,
      // A 401 means the link is wrong; retrying it three times just delays the
      // error screen the owner needs to see. Matched on the error's status
      // rather than its message, so a customer named "401" cannot trip it.
      retry: (failureCount, error) => (isUnauthorized(error) ? false : failureCount < 2),
    },
  },
})

const root = document.getElementById('root')
if (!root) throw new Error('missing #root element')

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename="/panel">
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
