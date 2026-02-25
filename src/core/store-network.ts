import type { BISNetwork } from '../types/common'
import { ref, watch } from 'vue'
import { PROVIDERS } from './providers'
import { getWalletInfo } from './store'

// Define network as a ref to allow reactivity
// and to be used in Vue components
const NETWORK = ref<BISNetwork>('mainnet')

// React to network changes
watch(NETWORK, onNetworkChange)

/**
 * Returns the currently selected network. The getNetwork function simply returns the current value of the NETWORK ref, which holds the selected network (e.g., 'mainnet', 'testnet', etc.). This function can be used to retrieve the current network selection in a reactive way, allowing components to update automatically when the network changes.
 *
 * @returns The currently selected network as a string, which can be 'mainnet', 'testnet', or any other supported network defined in the application.
 */
export function getNetwork(): BISNetwork {
  return NETWORK.value
}

/**
 * Sets the current network to the specified value. The setNetwork function takes a new network value as an argument and updates the NETWORK ref with this new value. This will trigger any reactive components that depend on the NETWORK ref to update accordingly, allowing the application to respond to changes in the selected network.
 *
 * @param newNetwork The new network to be set, which should be a string representing the desired network (e.g., 'mainnet', 'testnet', etc.). This value will replace the current value of the NETWORK ref, and any components that use getNetwork will react to this change.
 */
export function setNetwork(newNetwork: BISNetwork) {
  NETWORK.value = newNetwork
}

/**
 * Provides a reactive reference to the current network. The useNetwork function returns the NETWORK ref itself, allowing components to access and react to changes in the selected network directly. By returning the ref, components can use it in their templates or scripts to automatically update when the network changes, providing a seamless user experience when switching between different networks.
 * @returns A reactive reference to the current network, which can be used in Vue components to access and react to changes in the selected network. This allows components to automatically update when the network changes, ensuring that the application remains responsive to user interactions related to network selection.
 */
export function useNetwork() {
  return NETWORK
}

function onNetworkChange() {
  const provider = getWalletInfo()?.provider

  if (provider === 'unisat') {
    PROVIDERS.unisat!.checkNetwork?.()
  }
}
