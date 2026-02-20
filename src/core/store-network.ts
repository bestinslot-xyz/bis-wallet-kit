import type { BISNetwork } from '../main'
import { ref, watch } from 'vue'
import { providers } from './providers'
import { getWalletInfo } from './store'

// Define network as a ref to allow reactivity
// and to be used in Vue components
const network = ref<BISNetwork>('mainnet')

// React to network changes
watch(network, onNetworkChange)

/**
 *
 */
export function getNetwork(): BISNetwork {
  return network.value
}

/**
 *
 * @param newNetwork
 */
export function setNetwork(newNetwork: BISNetwork) {
  network.value = newNetwork
}

// Expose as a ref for reactivity in Vue components
/**
 *
 */
export function useNetwork() {
  return network
}

function onNetworkChange() {
  const provider = getWalletInfo()?.provider

  if (provider === 'unisat') {
    providers.unisat.checkNetwork()
  }
}
