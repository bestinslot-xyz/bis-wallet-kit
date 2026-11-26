import type { MempoolAcceptResult } from '../../src/core/chain-providers.ts'
import type { CommitOpts } from '../../src/types/common.ts'
import { Buffer } from 'node:buffer'
import * as bitcoin from 'bitcoinjs-lib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { brc20, wallet } from '../../src/node.ts'
import { InMemoryChainProvider } from './in-memory-providers.ts'

// Fixed testnet key (see local-wallet.test.ts). Never use for real funds.
const WIF = 'cN9spWsvaxA8taS7DFMxnk1yJD2gaF2PX1npuTpy3vuZFJdwavaw'
const P2TR = 'tb1p9fjtrm3nwhemkjek0wxtswz2glmneu33w9lcylrvd7alttk0psmqds9pcj'
const P2WPKH = 'tb1ql3e9pgs3mmwuwrh95fecme0s0qtn28804khrk8'
const NET = bitcoin.networks.testnet
const CONTRACT = `0x${'11'.repeat(20)}`
const CALLDATA = 'a9059cbb'

let chain: InMemoryChainProvider
let payer: string

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
  const before = chain.cardinal.get(payer) ?? []
  const utxo = chain.fund(payer, value)
  chain.cardinal.set(payer, before)
  return { outpoint: `${utxo.txid}:${utxo.vout}`, value }
}

/** Funds the payer with an output the provider lists at the given confirmation height. */
function fundAt(value: number, blockHeight: number | null) {
  const utxo = chain.fund(payer, value)
  chain.cardinal.get(payer)!.find(u => u.txid === utxo.txid)!.block_height = blockHeight
  return `${utxo.txid}:${utxo.vout}`
}

async function callTxes(walletType: 'ordinals' | 'payment', commitOpts?: CommitOpts, feeRate = 2) {
  const res = await brc20.callSmartContract(
    CONTRACT,
    CALLDATA,
    0,
    feeRate,
    null,
    true,
    undefined,
    walletType,
    commitOpts
  )
  return {
    commitHex: res.signedCommitTxHex,
    revealHex: res.signedRevealTxHex,
    sendHex: res.signedSendToOpReturnTxHex,
    commit: bitcoin.Transaction.fromHex(res.signedCommitTxHex),
    send: bitcoin.Transaction.fromHex(res.signedSendToOpReturnTxHex),
  }
}

async function call(walletType: 'ordinals' | 'payment', commitOpts?: CommitOpts) {
  return (await callTxes(walletType, commitOpts)).commit
}

/** The commit's spent outpoints, output values and fee; the commit output's script varies with each call's secret. */
function shape(tx: bitcoin.Transaction) {
  return { ins: outpoints(tx), values: tx.outs.map(o => o.value), fee: commitFee(tx) }
}

const rows = (['ordinals', 'payment'] as const).flatMap(walletType => [
  { walletType, addressType: 'p2tr' as const, address: P2TR, foreign: P2WPKH },
  { walletType, addressType: 'p2wpkh' as const, address: P2WPKH, foreign: P2TR },
])

describe.each(rows)(
  'contract call commit options ($walletType, $addressType)',
  ({ walletType, addressType, address, foreign }) => {
    beforeEach(async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: unknown) => {
          throw new Error(`unexpected HTTP request: ${String(url)}`)
        })
      )
      await wallet.connectLocalWallet(WIF, 'testnet', addressType, 'unisat')
      chain = new InMemoryChainProvider(NET)
      payer = address
      wallet.setProviders({ testnet: { chain } })
    })

    afterEach(() => {
      wallet.setProviders({})
      vi.unstubAllGlobals()
    })

    it('builds the same commit without options, with empty options and with a floor below the fee', async () => {
      chain.fund(payer, 20_000)
      chain.fund(payer, 50_000)

      const plain = shape(await call(walletType))

      expect(plain.ins).toHaveLength(1)
      expect(shape(await call(walletType, {}))).toEqual(plain)
      expect(shape(await call(walletType, { inputs: [], minCommitFee: plain.fee - 1 }))).toEqual(
        plain
      )
      expect(shape(await call(walletType, { minCommitFee: plain.fee }))).toEqual(plain)
    })

    it('spends the given inputs in the commit', async () => {
      chain.fund(payer, 50_000)
      const forced = unlistedOutput(20_000)

      const tx = await call(walletType, { inputs: [forced] })

      expect(outpoints(tx)).toEqual([forced.outpoint])
    })

    it('adds funding when the given inputs fall short', async () => {
      const funding = chain.fund(payer, 50_000)
      const forced = unlistedOutput(400)

      const tx = await call(walletType, { inputs: [forced] })

      expect(outpoints(tx)).toEqual([forced.outpoint, `${funding.txid}:${funding.vout}`])
    })

    it('raises the commit fee to the floor out of the change', async () => {
      chain.fund(payer, 50_000)
      const plain = shape(await call(walletType))

      const raised = shape(await call(walletType, { minCommitFee: plain.fee + 1_000 }))

      expect(raised.fee).toBe(plain.fee + 1_000)
      expect(raised.ins).toEqual(plain.ins)
      expect(raised.values).toEqual([plain.values[0], plain.values[1]! - 1_000])
    })

    it('raises the fee with given inputs too', async () => {
      chain.fund(payer, 50_000)
      const forced = unlistedOutput(20_000)

      const tx = await call(walletType, { inputs: [forced], minCommitFee: 5_000 })

      expect(outpoints(tx)).toEqual([forced.outpoint])
      expect(commitFee(tx)).toBe(5_000)
    })

    it('throws when the funds cannot pay the floor', async () => {
      chain.fund(payer, 3_000)

      await expect(call(walletType, { minCommitFee: 10_000 })).rejects.toThrow('Not enough funds')
      expect(chain.mempoolTests).toEqual([])
    })

    it('throws when the given inputs and the listed outputs cannot fund the commit', async () => {
      const forced = unlistedOutput(400)

      await expect(call(walletType, { inputs: [forced] })).rejects.toThrow('Not enough funds')
    })

    it('rejects malformed, duplicate, mismatched and foreign inputs', async () => {
      chain.fund(payer, 50_000)
      const forced = unlistedOutput(20_000)
      const other = chain.fund(foreign, 20_000)

      await expect(call(walletType, { inputs: [{ outpoint: 'nope', value: 1 }] })).rejects.toThrow(
        'txid:vout'
      )
      await expect(call(walletType, { inputs: [forced, forced] })).rejects.toThrow('listed twice')
      await expect(call(walletType, { inputs: [{ ...forced, value: 19_999 }] })).rejects.toThrow(
        'holds 20000 sats'
      )
      await expect(
        call(walletType, {
          inputs: [{ outpoint: `${forced.outpoint.split(':')[0]}:1`, value: 1 }],
        })
      ).rejects.toThrow('does not exist')
      await expect(
        call(walletType, { inputs: [{ outpoint: `${other.txid}:0`, value: 20_000 }] })
      ).rejects.toThrow('not an output of the payer address')
      await expect(call(walletType, { minCommitFee: -1 })).rejects.toThrow('minCommitFee')
      expect(chain.mempoolTests).toEqual([])
    })

    it('rejects an input the chain provider lists with inscriptions', async () => {
      chain.fund(payer, 50_000)
      const inscribed = chain.fund(payer, 10_000)
      const entry = chain.cardinal.get(payer)!.find(u => u.txid === inscribed.txid)!
      entry.inscription_ids = [`${'cd'.repeat(32)}i0`]
      entry.satpoints = [`${inscribed.txid}:0:0`]

      await expect(
        call(walletType, { inputs: [{ outpoint: `${inscribed.txid}:0`, value: 10_000 }] })
      ).rejects.toThrow('carries an inscription')
    })

    it('tests the package together without given inputs', async () => {
      chain.fund(payer, 50_000)

      const res = await callTxes(walletType)

      expect(chain.mempoolTests).toEqual([
        [res.commitHex, res.revealHex],
        [res.commitHex, res.revealHex, res.sendHex],
      ])
    })

    it('tests a replacing commit alone, which a mempool conflict would fail in a multi-transaction test', async () => {
      chain.fund(payer, 50_000)
      const forced = unlistedOutput(20_000)
      // The earlier commit still spends `forced` in the mempool: a multi-transaction test that
      // includes the replacement conflicts with it, as Bitcoin Core's testmempoolaccept refuses.
      const accept = chain.testMempoolAccept.bind(chain)
      chain.testMempoolAccept = async (txHexes: string[]): Promise<MempoolAcceptResult[]> => {
        const conflicts = txHexes.some(hex =>
          outpoints(bitcoin.Transaction.fromHex(hex)).includes(forced.outpoint)
        )
        if (txHexes.length > 1 && conflicts) {
          return txHexes.map(() => ({ allowed: false, 'reject-reason': 'conflict-in-package' }))
        }
        return accept(txHexes)
      }

      const res = await callTxes(walletType, { inputs: [forced], minCommitFee: 5_000 })

      expect(chain.mempoolTests).toEqual([[res.commitHex]])
    })

    // Coin selection prefers the smallest output above 10000 sats that covers the shortfall, so
    // without the filter both the commit and the send would take the unconfirmed 20000. At 10
    // sat/vB the send's fee exceeds the postage, so the send needs funding too.
    it('funds a replacement from confirmed provider outputs only', async () => {
      const unconfirmed = fundAt(20_000, null)
      const confirmed = fundAt(60_000, 1)
      const forced = unlistedOutput(400)

      const res = await callTxes(walletType, { inputs: [forced] }, 10)

      expect(outpoints(res.commit)).toEqual([forced.outpoint, confirmed])
      expect(outpoints(res.send)).not.toContain(unconfirmed)
      expect(outpoints(res.send)).toContain(`${res.commit.getId()}:1`)
    })

    it('funds a plain call from unconfirmed provider outputs', async () => {
      const unconfirmed = fundAt(20_000, null)
      fundAt(60_000, 1)

      const res = await callTxes(walletType, undefined, 10)

      expect(outpoints(res.commit)).toEqual([unconfirmed])
      expect(outpoints(res.send)).toContain(`${res.commit.getId()}:1`)
    })
  }
)
