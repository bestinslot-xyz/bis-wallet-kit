import type { BISNetwork } from '../types/common'
import { PROVIDERS } from './providers'
import { getWalletInfo } from './store'

// Plain (framework-agnostic) network state so the core can run outside the
// browser without pulling in Vue. The reactive `useNetwork()` composable lives
// in the browser-only `src/adapters/vue/use-network.ts` adapter, which syncs to this store.
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

/**
 * Base URLs of the backend services the kit talks to on one network. Each is
 * joined with a route path (`<base>/<route>`), so a trailing slash is optional.
 */
export interface Endpoints {
  /** Indexer reads: UTXOs, balances, raw transactions, BIP-322 verification. */
  indexer: string
  /** Bitcoin transaction submission: `testmempoolaccept` and `sendrawtransactions`. */
  tx: string
  /** Swap sequencer display reads: tokens, pairs table, volume, klines, TVL, activity feeds, token decimals. */
  sequencerRead: string
  /** Swap sequencer writes and the fresh reads taken right before signing (status, fees, nonce, balances, reserves, deposit, swap, withdraw, ...). */
  sequencer: string
  /** BRC2.0 JSON-RPC endpoint used for `eth_call`. */
  rpc: string
}

/** Per-network endpoint overrides accepted by {@link setEndpoints}. */
export type EndpointsConfig = { [N in BISNetwork]?: Partial<Endpoints> }

const DEFAULT_ENDPOINTS: Record<BISNetwork, Partial<Endpoints>> = {
  mainnet: {
    indexer: 'https://ts-proxy.bestinslot.xyz/v3/mainnet',
    tx: 'https://ts-proxy.bestinslot.xyz/v3/mainnet',
    sequencerRead: 'https://sa-proxy.bestinslot.xyz',
    sequencer: 'https://sa-proxy.bestinslot.xyz',
    rpc: 'https://rpc.brc20.build',
  },
  signet: {
    indexer: 'https://ts-proxy.bestinslot.xyz/v3/signet',
    tx: 'https://ts-proxy.bestinslot.xyz/v3/signet',
    sequencerRead: 'https://sas-proxy.bestinslot.xyz',
    sequencer: 'https://sas-proxy.bestinslot.xyz',
    rpc: 'https://rpc-signet.brc20.build',
  },
  // Testnet has no swap sequencer or BRC2.0 RPC unless one is configured.
  testnet: {
    indexer: 'https://ts-proxy.bestinslot.xyz/v3/testnet',
    tx: 'https://ts-proxy.bestinslot.xyz/v3/testnet',
  },
}

const ENDPOINT_KEYS: readonly (keyof Endpoints)[] = [
  'indexer',
  'tx',
  'sequencerRead',
  'sequencer',
  'rpc',
]

let endpointOverrides: EndpointsConfig = {}

/**
 * Overrides the backend base URLs per network. Each network's entry is merged
 * over the built-in defaults, so only the keys you pass change. Every call
 * replaces the previous overrides; `setEndpoints({})` restores the defaults.
 *
 * A base URL whose path starts with `/v1` is checked against its server's
 * `/v1/info` before the first request to that origin, and requests fail if the
 * server reports a different network than the one selected.
 *
 * @param config Per-network partial endpoint maps, e.g. `{ signet: { rpc: 'https://my-rpc.example' } }`.
 * @throws {Error} If a key is unknown or a value is not an absolute http(s) URL.
 */
export function setEndpoints(config: EndpointsConfig) {
  const next: EndpointsConfig = {}
  for (const [network, endpoints] of Object.entries(config ?? {})) {
    if (!(network in DEFAULT_ENDPOINTS)) {
      throw new Error(`setEndpoints: unknown network '${network}'`)
    }
    const entry: Partial<Endpoints> = {}
    for (const [key, value] of Object.entries(endpoints ?? {})) {
      if (!ENDPOINT_KEYS.includes(key as keyof Endpoints)) {
        throw new Error(`setEndpoints: unknown endpoint '${key}' for ${network}`)
      }
      if (value === undefined) {
        continue
      }
      let url: URL
      try {
        url = new URL(value)
      } catch {
        throw new Error(`setEndpoints: ${network}.${key} is not a valid URL: ${value}`)
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new Error(`setEndpoints: ${network}.${key} must be an http(s) URL: ${value}`)
      }
      entry[key as keyof Endpoints] = value
    }
    next[network as BISNetwork] = entry
  }
  endpointOverrides = next
}

/**
 * Returns the effective base URLs for a network: the defaults with any
 * {@link setEndpoints} overrides applied. Testnet has no `sequencerRead`,
 * `sequencer` or `rpc` unless configured.
 *
 * @param network The network to read. Defaults to the selected network.
 * @returns The endpoint map for that network.
 */
export function getEndpoints(network: BISNetwork = currentNetwork): Partial<Endpoints> {
  return { ...DEFAULT_ENDPOINTS[network], ...endpointOverrides[network] }
}

function handleNetworkChange() {
  const provider = getWalletInfo()?.provider

  if (provider === 'unisat') {
    PROVIDERS.unisat?.checkNetwork?.()
  }
}
