import type { Ref } from 'vue'
import type { BISNetwork } from '../types/common'
import { onScopeDispose, ref, watch } from 'vue'
import { getNetwork, setNetwork, subscribeToNetwork } from './store-network'

/**
 * Browser/Vue-only adapter: a reactive ref two-way synced to the framework-agnostic
 * network store in `./store-network`. Reading reflects the current network; writing
 * (e.g. via `v-model`) updates the shared store and every other consumer.
 *
 * Not part of the server build — it imports Vue.
 *
 * @returns A reactive ref to the current network.
 */
export function useNetwork(): Ref<BISNetwork> {
  const network = ref<BISNetwork>(getNetwork())

  // Store -> ref (external setNetwork updates the component). Tie the
  // unsubscribe to the effect scope so the listener is removed on unmount.
  const unsubscribe = subscribeToNetwork((next) => {
    if (network.value !== next) {
      network.value = next
    }
  })
  onScopeDispose(unsubscribe, true)

  // Ref -> store (v-model writes propagate to the shared store).
  watch(network, (next) => {
    if (next !== getNetwork()) {
      setNetwork(next)
    }
  })

  return network
}
