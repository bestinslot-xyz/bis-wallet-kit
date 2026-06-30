import type { BISNetwork, BISSession } from '../../types/common'
import { useCallback, useState, useSyncExternalStore } from 'react'
import { getSession } from '../../core/bis'
import {
  getNetwork,
  setNetwork as storeSetNetwork,
  subscribeToNetwork,
} from '../../core/store-network'

/**
 * React adapter: convenience hook bundling the connected session and the
 * reactive network. `session` is read on mount and refreshable via `refresh()`
 * (call it after your own connect flow resolves).
 *
 * @returns The current session (or null), the reactive network, a network
 * setter, and a `refresh` to re-read the stored session.
 */
export function useWallet(): {
  session: BISSession | null
  network: BISNetwork
  setNetwork: (network: BISNetwork) => void
  refresh: () => void
} {
  const network = useSyncExternalStore(subscribeToNetwork, getNetwork, getNetwork)
  const [session, setSession] = useState<BISSession | null>(() => getSession() ?? null)
  const refresh = useCallback(() => setSession(getSession() ?? null), [])
  const setNetwork = useCallback((next: BISNetwork) => storeSetNetwork(next), [])
  return { session, network, setNetwork, refresh }
}
