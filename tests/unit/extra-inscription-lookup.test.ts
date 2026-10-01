import type { APIOrdinalUtxoInfo, APIUtxoInfo } from '../../src/core/helpers.ts'
import { Buffer } from 'node:buffer'
import * as bitcoinjs from 'bitcoinjs-lib'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  clearExtraUtxos,
  fetchCardinalUtxos,
  getCardinalUtxos,
  getOrdinalUtxos,
  saveExtraUtxos,
} from '../../src/core/helpers.ts'
import { getInscriptionDetails } from '../../src/core/mint.ts'
import { wallet } from '../../src/node.ts'
import { WalletInfo } from '../../src/types/wallet.ts'

// A dry run registers its simulated commit/reveal txs as extra UTXOs. These tests stub
// the backend at the fetch boundary and record which endpoints each lookup reaches.

const WIF = 'cN9spWsvaxA8taS7DFMxnk1yJD2gaF2PX1npuTpy3vuZFJdwavaw'
const FUNDING_UTXO = `${'aa'.repeat(32)}:1`
const OTHER_CARDINAL_UTXO = `${'cc'.repeat(32)}:0`

let addr: string
let script: Buffer

function cardinalUtxo(utxo: string, value: number): APIUtxoInfo {
  const [txid, vout] = utxo.split(':')
  return {
    address: addr,
    amounts: null,
    block_height: 900000,
    inscription_ids: null,
    rune_ids: null,
    satpoints: null,
    script: script.toString('hex'),
    script_type: 'witness_v1_taproot',
    txfee: null,
    txid: txid!,
    utxo,
    value,
    vout: Number(vout),
    vsize: null,
  }
}

// A commit spending FUNDING_UTXO into a commit output plus change to `addr`, and a
// reveal spending the commit output into a 546-sat inscription output to `addr`.
function simulatedMint() {
  const commit = new bitcoinjs.Transaction()
  const [fundTxid, fundVout] = FUNDING_UTXO.split(':')
  commit.addInput(Buffer.from(fundTxid!, 'hex').reverse(), Number(fundVout))
  commit.addOutput(Buffer.concat([Buffer.from('5120', 'hex'), Buffer.alloc(32, 7)]), 1000)
  commit.addOutput(script, 50000)

  const reveal = new bitcoinjs.Transaction()
  reveal.addInput(commit.getHash(), 0)
  reveal.addOutput(script, 546)

  const revealTxid = reveal.getId()
  return {
    txHexes: [commit.toHex(), reveal.toHex()],
    commitTxid: commit.getId(),
    inscriptionId: `${revealTxid}i0`,
    satpoint: `${revealTxid}:0:0`,
    revealTxid,
  }
}

function stubBackend(routes: { ordinal?: APIOrdinalUtxoInfo[]; cardinal?: APIUtxoInfo[] }) {
  const calls: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
    const url = typeof input === 'string' ? input : input.toString()
    calls.push(url)
    let data: unknown
    if (url.includes('/ordinal_utxos/') && routes.ordinal) data = routes.ordinal
    else if (url.includes('/cardinal_utxos/') && routes.cardinal) data = routes.cardinal
    else throw new Error(`unexpected network call in offline test: ${url}`)
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  return calls
}

beforeAll(async () => {
  const w = await wallet.connectLocalWallet(WIF, 'testnet', 'p2tr', 'unisat')
  addr = w.address
  script = new WalletInfo(false, null, w.address, null, w.pubkey).outputScript
})

afterEach(() => {
  clearExtraUtxos()
  vi.restoreAllMocks()
})

describe('getInscriptionDetails', () => {
  it('resolves an inscription from the saved extras without fetching ordinal_utxos', async () => {
    const mint = simulatedMint()
    saveExtraUtxos(mint.txHexes, [mint.inscriptionId, mint.satpoint])
    const calls = stubBackend({})

    const details = await getInscriptionDetails(mint.inscriptionId, addr)

    expect(calls).toEqual([])
    expect(details).toEqual({
      satpoint: mint.satpoint,
      value: 546,
      script_type: 'witness_v1_taproot',
      block_height: null,
      utxo: `${mint.revealTxid}:0`,
    })
  })

  it('returns the same details as a search of the merged ordinal_utxos list', async () => {
    const mint = simulatedMint()
    saveExtraUtxos(mint.txHexes, [mint.inscriptionId, mint.satpoint])
    stubBackend({ ordinal: [] })

    const merged = await getOrdinalUtxos(addr)
    const fromMerged = await getInscriptionDetails(mint.inscriptionId, addr, merged)
    vi.restoreAllMocks()
    stubBackend({})

    expect(fromMerged).not.toBeNull()
    expect(await getInscriptionDetails(mint.inscriptionId, addr)).toEqual(fromMerged)
  })

  it('falls back to ordinal_utxos for an inscription the extras do not create', async () => {
    const mint = simulatedMint()
    saveExtraUtxos(mint.txHexes, [mint.inscriptionId, mint.satpoint])
    const realTxid = 'dd'.repeat(32)
    const realInscription: APIOrdinalUtxoInfo = {
      ...cardinalUtxo(`${realTxid}:0`, 330),
      inscription_ids: [`${realTxid}i0`],
      satpoints: [`${realTxid}:0:0`],
    }
    const calls = stubBackend({ ordinal: [realInscription] })

    const details = await getInscriptionDetails(`${realTxid}i0`, addr)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain(`/ordinal_utxos/${addr}`)
    expect(details).toEqual({
      satpoint: `${realTxid}:0:0`,
      value: 330,
      script_type: 'witness_v1_taproot',
      block_height: 900000,
      utxo: `${realTxid}:0`,
    })
  })

  it('looks up the network when no extras are saved', async () => {
    const calls = stubBackend({ ordinal: [] })

    expect(await getInscriptionDetails(`${'ee'.repeat(32)}i0`, addr)).toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('treats an extra inscription output spent by another extra tx as gone', async () => {
    const mint = simulatedMint()
    const spend = new bitcoinjs.Transaction()
    spend.addInput(Buffer.from(mint.revealTxid, 'hex').reverse(), 0)
    spend.addOutput(Buffer.from('6a', 'hex'), 0)
    saveExtraUtxos([...mint.txHexes, spend.toHex()], [mint.inscriptionId, mint.satpoint])
    const calls = stubBackend({ ordinal: [] })

    expect(await getInscriptionDetails(mint.inscriptionId, addr)).toBeNull()
    expect(calls).toHaveLength(1)
  })
})

describe('getCardinalUtxos with a fetched response', () => {
  it('applies the saved extras to the response without a new fetch', async () => {
    const backend = [cardinalUtxo(FUNDING_UTXO, 60000), cardinalUtxo(OTHER_CARDINAL_UTXO, 8000)]
    const calls = stubBackend({ cardinal: backend })
    const fetched = await fetchCardinalUtxos(addr)
    expect(calls).toHaveLength(1)

    const mint = simulatedMint()
    saveExtraUtxos(mint.txHexes, [mint.inscriptionId, mint.satpoint])

    const reused = await getCardinalUtxos(addr, fetched)
    expect(calls).toHaveLength(1)
    expect(reused).toEqual(await getCardinalUtxos(addr))
    expect(reused.map(u => u.utxo)).toEqual([OTHER_CARDINAL_UTXO, `${mint.commitTxid}:1`])
  })

  it('gives each call its own copy, so coin selection cannot reorder or drain the response', async () => {
    const backend = [cardinalUtxo(FUNDING_UTXO, 60000), cardinalUtxo(OTHER_CARDINAL_UTXO, 8000)]
    stubBackend({ cardinal: backend })
    const fetched = await fetchCardinalUtxos(addr)

    const first = await getCardinalUtxos(addr, fetched)
    first.sort((a, b) => a.value - b.value)
    first.pop()!.value = 1

    expect(await getCardinalUtxos(addr, fetched)).toEqual(backend)
  })
})
