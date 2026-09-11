import { Buffer } from 'node:buffer'
import * as bitcoin from 'bitcoinjs-lib'
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest'
import { wallet } from '../../src/node.ts'

// Fixed testnet key (see local-wallet.test.ts). Never use for real funds.
const WIF = 'cN9spWsvaxA8taS7DFMxnk1yJD2gaF2PX1npuTpy3vuZFJdwavaw'
const PAYER = 'tb1ql3e9pgs3mmwuwrh95fecme0s0qtn28804khrk8'
// A distinct address to receive the send (this key's taproot address — a
// different output script than the p2wpkh payer).
const RECIPIENT = 'tb1p9fjtrm3nwhemkjek0wxtswz2glmneu33w9lcylrvd7alttk0psmqds9pcj'

const net = bitcoin.networks.testnet
const payerScript = bitcoin.address.toOutputScript(PAYER, net)
const recipientScript = bitcoin.address.toOutputScript(RECIPIENT, net)

// A previous tx whose vout 0 pays the payer's p2wpkh script, so the real
// buildPsbtFromTx can attach a valid witnessUtxo for signing.
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

// Backend responses the real helpers will fetch, driven per-test.
let utxos: ReturnType<typeof fakeCardinalUtxo>[]
let prevHexByTxid: Record<string, string>
let mempoolResult: unknown
const broadcastBodies: string[][] = []
let fetchMock: ReturnType<typeof vi.fn>

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => data }
}

describe('local sendBTC', () => {
  beforeEach(async () => {
    utxos = []
    prevHexByTxid = {}
    mempoolResult = [{ allowed: true }]
    broadcastBodies.length = 0

    fetchMock = vi.fn(async (url: string | URL, opts?: any) => {
      const u = String(url)
      if (u.includes('/cardinal_utxos/'))
        return jsonResponse({ data: utxos })
      if (u.includes('/gettxhex/'))
        return jsonResponse(prevHexByTxid[u.split('/gettxhex/')[1]!] ?? '')
      if (u.includes('/testmempoolaccept'))
        return jsonResponse(mempoolResult)
      if (u.includes('/sendrawtransactions')) {
        broadcastBodies.push(JSON.parse(opts.body).txhexes)
        return jsonResponse({ result: 'ok' })
      }
      return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) }
    })
    vi.stubGlobal('fetch', fetchMock)

    await wallet.connectLocalWallet(WIF, 'testnet', 'p2wpkh', 'unisat')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('builds, signs and broadcasts a send with change back to the payer', async () => {
    const txid = 'aa'.repeat(32)
    utxos = [fakeCardinalUtxo(txid, 100000)]
    prevHexByTxid[txid] = prevTxHex(100000)

    const returnedTxid = await wallet.sendBTC(50000, RECIPIENT, 1)

    assert.ok(returnedTxid && typeof returnedTxid === 'string')
    assert.equal(broadcastBodies.length, 1)

    const sent = bitcoin.Transaction.fromHex(broadcastBodies[0]![0]!)
    const toRecipient = sent.outs.find(o => o.script.equals(recipientScript))
    const change = sent.outs.find(o => o.script.equals(payerScript))

    assert.equal(toRecipient?.value, 50000)
    assert.ok(change && change.value > 0, 'expected a change output back to the payer')
    assert.equal(returnedTxid, sent.getId())
  })

  it('throws the mempool reject reason and does not broadcast', async () => {
    const txid = 'bb'.repeat(32)
    utxos = [fakeCardinalUtxo(txid, 100000)]
    prevHexByTxid[txid] = prevTxHex(100000)
    mempoolResult = [{ 'allowed': false, 'reject-reason': 'min relay fee not met' }]

    await expect(wallet.sendBTC(50000, RECIPIENT, 1)).rejects.toThrow(/min relay fee not met/)
    assert.equal(broadcastBodies.length, 0)
  })

  it('throws when there are not enough funds and does not broadcast', async () => {
    const txid = 'cc'.repeat(32)
    utxos = [fakeCardinalUtxo(txid, 1000)]
    prevHexByTxid[txid] = prevTxHex(1000)

    await expect(wallet.sendBTC(50000, RECIPIENT, 1)).rejects.toThrow(/Not enough funds/)
    assert.equal(broadcastBodies.length, 0)
  })

  it('requires a positive feeRate for the local wallet', async () => {
    await expect(wallet.sendBTC(50000, RECIPIENT)).rejects.toThrow(/feeRate/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a non-positive amount before any network call', async () => {
    await expect(wallet.sendBTC(0, RECIPIENT, 1)).rejects.toThrow(/positive integer/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
