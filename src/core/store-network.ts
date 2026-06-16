import type { BISNetwork } from '../types/common'
import { PROVIDERS } from './providers'
import { getWalletInfo } from './store'

// Plain (framework-agnostic) network state so the core can run outside the
// browser without pulling in Vue. The reactive `useNetwork()` composable lives
// in the browser-only `./use-network` adapter, which syncs to this store.
let currentNetwork: BISNetwork = 'mainnet'
const listeners = new Set<(network: BISNetwork) => void>()

/**
 * Returns the currently selected network (e.g. 'mainnet', 'testnet', 'signet').
 *
 * @returns The currently selected network.
 */
export function getNetwork(): BISNetwork {
  return currentNetwork
}

/**
 * Sets the current network and notifies subscribers. No-op if unchanged.
 *
 * @param newNetwork The network to switch to.
 */
export function setNetwork(newNetwork: BISNetwork) {
  if (newNetwork === currentNetwork) {
    return
  }
  currentNetwork = newNetwork
  handleNetworkChange()
  for (const listener of listeners) {
    listener(newNetwork)
  }
}

/**
 * Subscribes to network changes.
 *
 * @param listener Called with the new network whenever it changes.
 * @returns An unsubscribe function that removes the listener.
 */
export function subscribeToNetwork(listener: (network: BISNetwork) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function handleNetworkChange() {
  const provider = getWalletInfo()?.provider

  if (provider === 'unisat') {
    PROVIDERS.unisat!.checkNetwork?.()
  }
}
