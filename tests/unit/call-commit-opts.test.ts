import type { CommitOpts } from '../../src/types/common.ts'
import { Buffer } from 'node:buffer'
import * as bitcoin from 'bitcoinjs-lib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { brc20, wallet } from '../../src/node.ts'
import { InMemoryChainProvider } from './in-memory-providers.ts'

// Fixed testnet key (see local-wallet.test.ts). Never use for real funds.
const WIF = 'cN9spWsvaxA8taS7DFMxnk1yJD2gaF2PX1npuTpy3vuZFJdwavaw'
const P2TR = 'tb1p9fjtrm3nwhemkjek0wxtswz2glmneu33w9lcylrvd7alttk0psmqds9pcj'
const OTHER = 'tb1ql3e9pgs3mmwuwrh95fecme0s0qtn28804khrk8'
const NET = bitcoin.networks.testnet
const CONTRACT = `0x${'11'.repeat(20)}`
const CALLDATA = 'a9059cbb'

let chain: InMemoryChainProvider

function outpoints(tx: bitcoin.Transaction): string[] {
  return tx.ins.map(i => `${Buffer.from(i.hash).reverse().toString('hex')}:${i.index}`)
}

/** The commit's fee, from the values of the outputs it spends. */
function commitFee(tx: bitcoin.Transaction): number {
  const spent = tx.ins.reduce((sum, i) => {
    const txid = Buffer.from(i.hash).reverse().toString('hex')
    return sum + bitcoin.Transaction.fromHex(chain.txs.get(txid)!).outs[i.index]!.value
  }, 0)
  return spent - tx.outs.reduce((sum, o) => sum + o.value, 0)
}

/** A funded output of the payer that the chain provider no longer lists, as when an unconfirmed transaction spends it. */
function unlistedOutput(value: number) {
  const before = chain.cardinal.get(P2TR) ?? []
  const utxo = chain.fund(P2TR, value)
  chain.cardinal.set(P2TR, before)
  return { outpoint: `${utxo.txid}:${utxo.vout}`, value }
}

async function call(walletType: 'ordinals' | 'payment', commitOpts?: CommitOpts) {
  const res = await brc20.callSmartContract(
    CONTRACT,
    CALLDATA,
    0,
    2,
    null,
    true,
    undefined,
    walletType,
    commitOpts
  )
  return bitcoin.Transaction.fromHex(res.signedCommitTxHex)
}

/** The commit's spent outpoints, output values and fee; the commit output's script varies with each call's secret. */
function shape(tx: bitcoin.Transaction) {
  return { ins: outpoints(tx), values: tx.outs.map(o => o.value), fee: commitFee(tx) }
}

describe.each(['ordinals', 'payment'] as const)('contract call commit options (%s)', walletType => {
  beforeEach(async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        throw new Error(`unexpected HTTP request: ${String(url)}`)
      })
    )
    await wallet.connectLocalWallet(WIF, 'testnet', 'p2tr', 'unisat')
    chain = new InMemoryChainProvider(NET)
    wallet.setProviders({ testnet: { chain } })
  })

  afterEach(() => {
    wallet.setProviders({})
    vi.unstubAllGlobals()
  })

  it('builds the same commit without options, with empty options and with a floor below the fee', async () => {
    chain.fund(P2TR, 20_000)
    chain.fund(P2TR, 50_000)

    const plain = shape(await call(walletType))

    expect(plain.ins).toHaveLength(1)
    expect(shape(await call(walletType, {}))).toEqual(plain)
    expect(shape(await call(walletType, { inputs: [], minCommitFee: plain.fee - 1 }))).toEqual(
      plain
    )
    expect(shape(await call(walletType, { minCommitFee: plain.fee }))).toEqual(plain)
  })

  it('spends the given inputs in the commit', async () => {
    chain.fund(P2TR, 50_000)
    const forced = unlistedOutput(20_000)

    const tx = await call(walletType, { inputs: [forced] })

    expect(outpoints(tx)).toEqual([forced.outpoint])
  })

  it('adds funding when the given inputs fall short', async () => {
    const funding = chain.fund(P2TR, 50_000)
    const forced = unlistedOutput(400)

    const tx = await call(walletType, { inputs: [forced] })

    expect(outpoints(tx)).toEqual([forced.outpoint, `${funding.txid}:${funding.vout}`])
  })

  it('raises the commit fee to the floor out of the change', async () => {
    chain.fund(P2TR, 50_000)
    const plain = shape(await call(walletType))

    const raised = shape(await call(walletType, { minCommitFee: plain.fee + 1_000 }))

    expect(raised.fee).toBe(plain.fee + 1_000)
    expect(raised.ins).toEqual(plain.ins)
    expect(raised.values).toEqual([plain.values[0], plain.values[1]! - 1_000])
  })

  it('raises the fee with given inputs too', async () => {
    chain.fund(P2TR, 50_000)
    const forced = unlistedOutput(20_000)

    const tx = await call(walletType, { inputs: [forced], minCommitFee: 5_000 })

    expect(outpoints(tx)).toEqual([forced.outpoint])
    expect(commitFee(tx)).toBe(5_000)
  })

  it('throws when the funds cannot pay the floor', async () => {
    chain.fund(P2TR, 3_000)

    await expect(call(walletType, { minCommitFee: 10_000 })).rejects.toThrow('Not enough funds')
    expect(chain.mempoolTests).toEqual([])
  })

  it('throws when the given inputs and the listed outputs cannot fund the commit', async () => {
    const forced = unlistedOutput(400)

    await expect(call(walletType, { inputs: [forced] })).rejects.toThrow('Not enough funds')
  })

  it('rejects malformed, duplicate, mismatched and foreign inputs', async () => {
    chain.fund(P2TR, 50_000)
    const forced = unlistedOutput(20_000)
    const foreign = chain.fund(OTHER, 20_000)

    await expect(call(walletType, { inputs: [{ outpoint: 'nope', value: 1 }] })).rejects.toThrow(
      'txid:vout'
    )
    await expect(call(walletType, { inputs: [forced, forced] })).rejects.toThrow('listed twice')
    await expect(call(walletType, { inputs: [{ ...forced, value: 19_999 }] })).rejects.toThrow(
      'holds 20000 sats'
    )
    await expect(
      call(walletType, { inputs: [{ outpoint: `${forced.outpoint.split(':')[0]}:1`, value: 1 }] })
    ).rejects.toThrow('does not exist')
    await expect(
      call(walletType, { inputs: [{ outpoint: `${foreign.txid}:0`, value: 20_000 }] })
    ).rejects.toThrow('not an output of the payer address')
    await expect(call(walletType, { minCommitFee: -1 })).rejects.toThrow('minCommitFee')
    expect(chain.mempoolTests).toEqual([])
  })

  it('rejects an input the chain provider lists with inscriptions', async () => {
    chain.fund(P2TR, 50_000)
    const inscribed = chain.fund(P2TR, 10_000)
    const listed = chain.cardinal.get(P2TR)!
    const entry = listed.find(u => u.txid === inscribed.txid)!
    entry.inscription_ids = [`${'cd'.repeat(32)}i0`]
    entry.satpoints = [`${inscribed.txid}:0:0`]

    await expect(
      call(walletType, { inputs: [{ outpoint: `${inscribed.txid}:0`, value: 10_000 }] })
    ).rejects.toThrow('carries an inscription')
  })
})
