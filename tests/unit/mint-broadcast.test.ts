import { Buffer } from 'node:buffer'
import * as bitcoin from 'bitcoinjs-lib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mintAll } from '../../src/core/mint.ts'
import { getSignFn } from '../../src/core/providers.ts'
import { getWalletInfo } from '../../src/core/store.ts'
import { mint, wallet } from '../../src/node.ts'
import { textInscription } from '../../src/types/inscription.ts'

// Fixed testnet key (see local-wallet.test.ts). Never use for real funds.
const WIF = 'cN9spWsvaxA8taS7DFMxnk1yJD2gaF2PX1npuTpy3vuZFJdwavaw'
const PAYER = 'tb1ql3e9pgs3mmwuwrh95fecme0s0qtn28804khrk8'
const payerScript = bitcoin.address.toOutputScript(PAYER, bitcoin.networks.testnet)

function prevTxHex(value: number) {
  const tx = new bitcoin.Transaction()
  tx.addInput(Buffer.alloc(32, 9), 0)
  tx.addOutput(payerScript, value)
  return tx.toHex()
}

function fakeCardinalUtxo(txid: string, value: number) {
  return {
    utxo: `${txid}:0`,
    txid,
    vout: 0,
    value,
    script_type: 'witness_v0_keyhash',
    script: payerScript.toString('hex'),
    address: PAYER,
    amounts: null,
    block_height: 1,
    inscription_ids: null,
    rune_ids: null,
    satpoints: null,
    txfee: null,
    vsize: null,
  }
}

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => data }
}

const broadcastBodies: string[][] = []
let broadcastFails = false

/** Stubs fetch with one 200k-sat payer UTXO and a broadcast endpoint. */
async function installChainMocks() {
  const txid = 'aa'.repeat(32)
  const utxos = [fakeCardinalUtxo(txid, 200000)]
  const prevHexByTxid: Record<string, string> = { [txid]: prevTxHex(200000) }
  broadcastBodies.length = 0
  broadcastFails = false

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, opts?: any) => {
      const u = String(url)
      if (u.includes('/cardinal_utxos/')) return jsonResponse({ data: utxos })
      if (u.includes('/gettxhex/'))
        return jsonResponse(prevHexByTxid[u.split('/gettxhex/')[1]!] ?? '')
      if (u.includes('/testmempoolaccept')) {
        const n = JSON.parse(opts.body).txhexes?.length ?? 1
        return jsonResponse(Array.from({ length: n }, () => ({ allowed: true })))
      }
      if (u.includes('/sendrawtransactions')) {
        const txhexes: string[] = JSON.parse(opts.body).txhexes
        broadcastBodies.push(txhexes)
        if (broadcastFails) return jsonResponse({ error: 'rejected' })
        return jsonResponse(txhexes.map(hex => bitcoin.Transaction.fromHex(hex).getId()))
      }
      return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) }
    })
  )

  await wallet.connectLocalWallet(WIF, 'signet', 'p2wpkh', 'unisat')
}

describe('mint broadcasts', () => {
  beforeEach(installChainMocks)

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('inscribe throws when the broadcast request fails', async () => {
    broadcastFails = true
    await expect(mint.inscribe(textInscription('hi'), 2, null, false)).rejects.toThrow(
      'Broadcast request failed'
    )
    expect(broadcastBodies.length).toBe(1)
  })

  it('inscribe returns the txids when the broadcast succeeds', async () => {
    const res = await mint.inscribe(textInscription('hi'), 2, null, false)
    expect(broadcastBodies.length).toBe(1)
    expect(broadcastBodies[0]!.map(h => bitcoin.Transaction.fromHex(h).getId())).toEqual([
      res.commitTxId,
      res.revealTxId,
    ])
  })

  it('mintAll throws when the broadcast request fails', async () => {
    broadcastFails = true
    const signFn = getSignFn(getWalletInfo()!.provider)
    await expect(
      mintAll(textInscription('hi'), 2, null, null, null, false, signFn)
    ).rejects.toThrow('Broadcast request failed')
    expect(broadcastBodies.length).toBe(1)
  })
})
