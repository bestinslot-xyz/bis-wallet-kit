import type {
  Brc20RpcProvider,
  ChainBalance,
  ChainProvider,
  MempoolAcceptResult,
  OrdinalUtxo,
  Utxo,
} from '../../src/core/chain-providers.ts'
import { Buffer } from 'node:buffer'
import * as bitcoin from 'bitcoinjs-lib'

/**
 * A chain held in memory: confirmed outputs per address, raw transactions by txid, and a
 * record of every mempool test and broadcast. It reports confirmed data only, as a provider
 * without mempool access would.
 */
export class InMemoryChainProvider implements ChainProvider {
  readonly txs = new Map<string, string>()
  readonly cardinal = new Map<string, Utxo[]>()
  readonly ordinal = new Map<string, OrdinalUtxo[]>()
  readonly mempoolTests: string[][] = []
  readonly broadcasts: string[][] = []
  private nonce = 0

  constructor(private readonly network: bitcoin.Network) {}

  /** Adds a confirmed transaction paying `value` sats to `address` and returns its output. */
  fund(address: string, value: number): Utxo {
    const tx = this.payTo(address, value)
    const utxo = { txid: tx.getId(), vout: 0, value }
    this.cardinal.set(address, [...(this.cardinal.get(address) ?? []), utxo])
    return utxo
  }

  /** Adds a confirmed output to `address` carrying one inscription at offset 0. */
  inscribed(address: string, value: number): OrdinalUtxo {
    const tx = this.payTo(address, value)
    const txid = tx.getId()
    const utxo = {
      txid,
      vout: 0,
      value,
      inscription_ids: [`${txid}i0`],
      satpoints: [`${txid}:0:0`],
    }
    this.ordinal.set(address, [...(this.ordinal.get(address) ?? []), utxo])
    return utxo
  }

  async cardinalUtxos(address: string): Promise<Utxo[]> {
    return structuredClone(this.cardinal.get(address) ?? [])
  }

  async ordinalUtxos(address: string): Promise<OrdinalUtxo[]> {
    return structuredClone(this.ordinal.get(address) ?? [])
  }

  async balance(address: string): Promise<ChainBalance> {
    const all = [...(this.cardinal.get(address) ?? []), ...(this.ordinal.get(address) ?? [])]
    return { confirmed: all.reduce((sum, u) => sum + u.value, 0), mempool: 0 }
  }

  async txHex(txid: string): Promise<string> {
    const hex = this.txs.get(txid)
    if (!hex) throw new Error(`unknown transaction ${txid}`)
    return hex
  }

  /** Accepts a transaction when each input spends a known transaction or an earlier one in the list. */
  async testMempoolAccept(txHexes: string[]): Promise<MempoolAcceptResult[]> {
    this.mempoolTests.push(txHexes)
    const known = new Set(this.txs.keys())
    return txHexes.map(hex => {
      const tx = bitcoin.Transaction.fromHex(hex)
      const missing = tx.ins.some(i => !known.has(Buffer.from(i.hash).reverse().toString('hex')))
      known.add(tx.getId())
      return missing ? { allowed: false, 'reject-reason': 'missing-inputs' } : { allowed: true }
    })
  }

  async broadcast(txHexes: string[]): Promise<string[]> {
    this.broadcasts.push(txHexes)
    return txHexes.map(hex => bitcoin.Transaction.fromHex(hex).getId())
  }

  private payTo(address: string, value: number): bitcoin.Transaction {
    const tx = new bitcoin.Transaction()
    tx.addInput(Buffer.alloc(32, ++this.nonce), 0)
    tx.addOutput(bitcoin.address.toOutputScript(address, this.network), value)
    this.txs.set(tx.getId(), tx.toHex())
    return tx
  }
}

/** A BRC2.0 RPC that answers every request from a handler and records it. */
export class InMemoryBrc20RpcProvider implements Brc20RpcProvider {
  readonly requests: { method: string; params: unknown[] }[] = []

  constructor(private readonly handler: (method: string, params: unknown[]) => unknown) {}

  async request(method: string, params: unknown[]): Promise<unknown> {
    this.requests.push({ method, params })
    return this.handler(method, params)
  }
}
