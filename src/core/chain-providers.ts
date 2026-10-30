import type { BISNetwork } from '../types/common'
import { BisBrc20RpcProvider, BisChainProvider } from './bis-providers'
import { getEndpoints, getNetwork } from './store-network'

/**
 * An unspent output that carries no inscriptions and no runes.
 */
export interface Utxo {
  /** The id of the transaction that created the output. */
  txid: string
  /** The output's index in that transaction. */
  vout: number
  /** The output's value in sats. */
  value: number
}

/**
 * An unspent output that carries one or more inscriptions.
 */
export interface OrdinalUtxo extends Utxo {
  /** The ids of the inscriptions on the output. */
  inscription_ids: string[]
  /** The satpoint (`txid:vout:offset`) of each entry of `inscription_ids`, in the same order. */
  satpoints: string[]
  /** The height of the block that confirmed the output, or `null` while it is unconfirmed. */
  block_height?: number | null
}

/**
 * The mempool acceptance verdict for one transaction, in the shape of Bitcoin Core's
 * `testmempoolaccept` entries.
 */
export interface MempoolAcceptResult {
  /** Whether the transaction would enter the mempool. */
  allowed: boolean
  /** Why the transaction would be rejected, when `allowed` is false. */
  'reject-reason'?: string
}

/**
 * The balance of an address in sats, over every output of the address, inscribed and runic ones
 * included. The spendable total is `confirmed + mempool`.
 */
export interface ChainBalance {
  /** The sum of the address's confirmed outputs that no mempool transaction spends. */
  confirmed: number
  /** The sum of the address's unspent outputs that unconfirmed transactions create. */
  mempool: number
}

/**
 * The Bitcoin chain data wallet-kit reads and the transaction submission it performs.
 *
 * wallet-kit applies its own pending transactions on top of what a provider returns: outputs a
 * pending transaction spends are dropped, and outputs it creates for the address are added. A
 * provider therefore only reports what the chain (and optionally the mempool) holds.
 *
 * Every method throws when it cannot answer.
 */
export interface ChainProvider {
  /**
   * Lists the address's unspent outputs that carry no inscriptions and no runes. A provider
   * that cannot tell whether an output carries an inscription or a rune throws instead of
   * returning it. A provider without mempool data returns the confirmed outputs, minus those
   * that mempool transactions spend.
   */
  cardinalUtxos: (address: string) => Promise<Utxo[]>
  /** Lists the address's unspent outputs that carry inscriptions. */
  ordinalUtxos: (address: string) => Promise<OrdinalUtxo[]>
  /** Returns the address's balance. A provider without mempool data reports `mempool: 0`. */
  balance: (address: string) => Promise<ChainBalance>
  /** Returns the raw transaction with the given id, hex encoded. */
  txHex: (txid: string) => Promise<string>
  /**
   * Tests whether the transactions, in order, would enter the mempool. Later transactions may
   * spend outputs of earlier ones. Returns one result per transaction, in the same order.
   */
  testMempoolAccept: (txHexes: string[]) => Promise<MempoolAcceptResult[]>
  /** Broadcasts the transactions, in order, and returns their txids. */
  broadcast: (txHexes: string[]) => Promise<string[]>
}

/**
 * A BRC2.0 JSON-RPC endpoint. wallet-kit uses it for `eth_call` reads.
 */
export interface Brc20RpcProvider {
  /**
   * Sends one JSON-RPC request and returns its `result`. Throws when the request fails or the
   * response carries an `error`.
   */
  request: (method: string, params: unknown[]) => Promise<unknown>
}

/** The providers for one network. A key left out uses the default provider. */
export interface NetworkProviders {
  chain?: ChainProvider
  brc20Rpc?: Brc20RpcProvider
}

/** Per-network provider overrides accepted by {@link setProviders}. */
export type ProvidersConfig = { [N in BISNetwork]?: NetworkProviders }

const NETWORKS: readonly BISNetwork[] = ['mainnet', 'testnet', 'signet']
const CHAIN_METHODS = [
  'cardinalUtxos',
  'ordinalUtxos',
  'balance',
  'txHex',
  'testMempoolAccept',
  'broadcast',
] as const

let providerOverrides: ProvidersConfig = {}
let defaultChain: ChainProvider | null = null
let defaultBrc20Rpc: Brc20RpcProvider | null = null

/**
 * Sets the chain data and BRC2.0 RPC providers per network. A network or key left out uses the
 * defaults, {@link BisChainProvider} and {@link BisBrc20RpcProvider}, which read the endpoints
 * set with `setEndpoints`. Every call replaces the previous overrides; `setProviders({})`
 * restores the defaults.
 *
 * @param config Per-network providers, e.g. `{ signet: { chain: myChainProvider } }`.
 * @throws {Error} If a network or key is unknown, or a provider lacks one of its methods.
 */
export function setProviders(config: ProvidersConfig) {
  const next: ProvidersConfig = {}
  for (const [network, providers] of Object.entries(config ?? {})) {
    if (!NETWORKS.includes(network as BISNetwork)) {
      throw new Error(`setProviders: unknown network '${network}'`)
    }
    const entry: NetworkProviders = {}
    for (const [key, provider] of Object.entries(providers ?? {})) {
      if (provider === undefined) {
        continue
      }
      if (key === 'chain') {
        for (const method of CHAIN_METHODS) {
          if (typeof (provider as any)?.[method] !== 'function') {
            throw new TypeError(`setProviders: ${network}.chain has no ${method}() method`)
          }
        }
        entry.chain = provider as ChainProvider
      } else if (key === 'brc20Rpc') {
        if (typeof (provider as any)?.request !== 'function') {
          throw new TypeError(`setProviders: ${network}.brc20Rpc has no request() method`)
        }
        entry.brc20Rpc = provider as Brc20RpcProvider
      } else {
        throw new Error(`setProviders: unknown provider '${key}' for ${network}`)
      }
    }
    next[network as BISNetwork] = entry
  }
  providerOverrides = next
}

/**
 * Returns the providers in effect for a network: the overrides set with {@link setProviders},
 * and the default providers for the keys left out.
 *
 * @param network The network to read. Defaults to the selected network.
 * @returns The chain data and BRC2.0 RPC providers for that network.
 */
export function getProviders(network: BISNetwork = getNetwork()): Required<NetworkProviders> {
  return {
    chain: getChainProvider(network),
    brc20Rpc: getBrc20RpcProvider(network),
  }
}

/**
 * Returns the chain data provider for a network.
 *
 * @param network The network to read. Defaults to the selected network.
 * @returns The provider set with {@link setProviders}, or the default {@link BisChainProvider}.
 */
export function getChainProvider(network: BISNetwork = getNetwork()): ChainProvider {
  const override = providerOverrides[network]?.chain
  if (override) return override
  defaultChain ??= new BisChainProvider()
  return defaultChain
}

/**
 * Returns the BRC2.0 RPC provider for a network.
 *
 * @param network The network to read. Defaults to the selected network.
 * @returns The provider set with {@link setProviders}, or the default {@link BisBrc20RpcProvider}.
 */
export function getBrc20RpcProvider(network: BISNetwork = getNetwork()): Brc20RpcProvider {
  const override = providerOverrides[network]?.brc20Rpc
  if (override) return override
  defaultBrc20Rpc ??= new BisBrc20RpcProvider()
  return defaultBrc20Rpc
}

/**
 * Whether a network has a BRC2.0 RPC: a provider set with {@link setProviders}, or an `rpc`
 * endpoint for the default provider.
 *
 * @param network The network to read. Defaults to the selected network.
 * @returns Whether BRC2.0 RPC requests on that network have somewhere to go.
 */
export function hasBrc20Rpc(network: BISNetwork = getNetwork()): boolean {
  return Boolean(providerOverrides[network]?.brc20Rpc) || Boolean(getEndpoints(network).rpc)
}
