import type {
  Brc20RpcProvider,
  ChainBalance,
  ChainProvider,
  MempoolAcceptResult,
  OrdinalUtxo,
  Utxo,
} from './chain-providers'
import type { AllBalanceDetails, APIOrdinalUtxoInfo, APIUtxoInfo } from './helpers'
import { Buffer } from 'node:buffer'
import * as bitcoinjs from 'bitcoinjs-lib'
import { BackendError } from './backend-error'
import { fetchWithErrors, getEndpointUrl, getPublicRpcUrl } from './helpers'
import { assertHttpUrl } from './store-network'

/** Endpoint base URLs for a {@link BisChainProvider}. A key left out reads `setEndpoints`. */
export interface BisChainProviderOptions {
  /** Base URL for UTXO, balance and raw transaction reads. */
  indexer?: string
  /** Base URL for mempool acceptance tests and broadcasts. */
  tx?: string
}

/** Endpoint base URL for a {@link BisBrc20RpcProvider}. Left out, it reads `setEndpoints`. */
export interface BisBrc20RpcProviderOptions {
  /** The BRC2.0 JSON-RPC URL. */
  rpc?: string
}

/**
 * The default {@link ChainProvider}: reads chain data from the Best in Slot API.
 *
 * Without constructor options it uses the `indexer` and `tx` endpoints of the selected network,
 * as set with `setEndpoints`. Returned outputs keep every field the API sends.
 */
export class BisChainProvider implements ChainProvider {
  private readonly indexer?: string
  private readonly tx?: string

  /**
   * @param options Endpoint base URLs that take the place of the `setEndpoints` values.
   * @throws {Error} If a URL is not an absolute http(s) URL.
   */
  constructor(options: BisChainProviderOptions = {}) {
    if (options.indexer !== undefined) assertHttpUrl('BisChainProvider: indexer', options.indexer)
    if (options.tx !== undefined) assertHttpUrl('BisChainProvider: tx', options.tx)
    this.indexer = options.indexer
    this.tx = options.tx
  }

  async cardinalUtxos(address: string): Promise<Utxo[]> {
    const url = await getEndpointUrl('indexer', `cardinal_utxos/${address}`, this.indexer)
    const json = await fetchWithErrors<{ data: APIUtxoInfo[] }>(url, { method: 'GET' })
    return json.data
  }

  async ordinalUtxos(address: string): Promise<OrdinalUtxo[]> {
    const url = await getEndpointUrl('indexer', `ordinal_utxos/${address}`, this.indexer)
    const json = await fetchWithErrors<{ data: APIOrdinalUtxoInfo[] }>(url, { method: 'GET' })
    return json.data
  }

  async balance(address: string): Promise<ChainBalance> {
    const url = await getEndpointUrl('indexer', `all_balance_details/${address}`, this.indexer)
    const json = await fetchWithErrors<AllBalanceDetails>(url, { method: 'GET' })
    return { confirmed: json.confirmed_balance, mempool: json.mempool_balance }
  }

  async txHex(txid: string): Promise<string> {
    const url = await getEndpointUrl('indexer', `gettxhex/${txid}`, this.indexer)
    return fetchWithErrors<string>(url, { method: 'GET' })
  }

  async testMempoolAccept(txHexes: string[]): Promise<MempoolAcceptResult[]> {
    const url = await getEndpointUrl('tx', 'testmempoolaccept', this.tx)
    return postTxHexes(url, txHexes)
  }

  async broadcast(txHexes: string[]): Promise<string[]> {
    const url = await getEndpointUrl('tx', 'sendrawtransactions', this.tx)
    await postTxHexes(url, txHexes)
    return txHexes.map(txidOfHex)
  }
}

/**
 * The default {@link Brc20RpcProvider}: sends JSON-RPC requests over HTTP.
 *
 * Without constructor options it uses the `rpc` endpoint of the selected network, as set with
 * `setEndpoints`.
 */
export class BisBrc20RpcProvider implements Brc20RpcProvider {
  private readonly rpc?: string

  /**
   * @param options The JSON-RPC URL that takes the place of the `setEndpoints` value.
   * @throws {Error} If the URL is not an absolute http(s) URL.
   */
  constructor(options: BisBrc20RpcProviderOptions = {}) {
    if (options.rpc !== undefined) assertHttpUrl('BisBrc20RpcProvider: rpc', options.rpc)
    this.rpc = options.rpc
  }

  async request(method: string, params: unknown[]): Promise<unknown> {
    const url = await getPublicRpcUrl(this.rpc)
    const response = await fetchWithErrors<{ result: unknown }>(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Math.random().toString(16).slice(2),
        method,
        params,
      }),
    })
    return response.result
  }
}

/**
 * Posts `{ txhexes }` and returns the parsed JSON body whatever its status.
 *
 * @throws {BackendError} When the request does not complete or the body is not JSON.
 */
async function postTxHexes(url: string, txHexes: string[]): Promise<any> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ txhexes: txHexes }),
    })
    return await response.json()
  } catch (error) {
    throw new BackendError(
      error instanceof Error ? error.message : String(error),
      undefined,
      undefined,
      url
    )
  }
}

/**
 * The txid of a raw transaction. Bytes that do not parse as a transaction hash as they are.
 */
function txidOfHex(txHex: string): string {
  try {
    return bitcoinjs.Transaction.fromHex(txHex).getId()
  } catch {
    return Buffer.from(bitcoinjs.crypto.hash256(Buffer.from(txHex, 'hex')))
      .reverse()
      .toString('hex')
  }
}
