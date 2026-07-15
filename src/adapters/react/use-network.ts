import type { BISNetwork } from '../../types/common'
import { useCallback, useSyncExternalStore } from 'react'
import { getNetwork, setNetwork, subscribeToNetwork } from '../../core/store-network'

/**
 * React adapter: subscribes to the framework-agnostic network store. Returns the
 * current network and a setter, mirroring the Vue `useNetwork()` composable.
 *
 * @returns A `[network, setNetwork]` tuple.
 */
export function useNetwork(): [BISNetwork, (network: BISNetwork) => void] {
  const network = useSyncExternalStore(subscribeToNetwork, getNetwork, getNetwork)
  const set = useCallback((next: BISNetwork) => setNetwork(next), [])
  return [network, set]
}
