import type { SignFunction } from '../../src/provider/api.ts'
import { Buffer } from 'node:buffer'
import { Buff } from '@cmdcode/buff-utils'
import * as bitcoinjs from 'bitcoinjs-lib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { txHexByIdCache } from '../../src/core/helpers.ts'
import { assembleReclaimCommitAndReveal, buildReclaimCommitTx } from '../../src/core/mint.ts'
import { getSignFn } from '../../src/core/providers.ts'
import { wallet } from '../../src/node.ts'
import { InscriptionDetails } from '../../src/types/inscription.ts'
import { WalletInfo } from '../../src/types/wallet.ts'

const WIF = 'cN9spWsvaxA8taS7DFMxnk1yJD2gaF2PX1npuTpy3vuZFJdwavaw'
// distinct WIF for the "ordinals" side of the split-address test, so payer and
// inscription wallets are genuinely different addresses (not just aliases of the
// same key), which is what the addr-idx routing bug required to surface.
const ORD_WIF = 'cUHZRgEg7zhKQrik5YAbVC4rEJiFJZRw91ZaUKTxBWx6VzaktvLd'

function transferInscription(tick: string, amt: string) {
  return new InscriptionDetails(
    Buff.str('text/plain'),
    null,
    null,
    null,
    null,
    Buff.str(`{"p":"brc-20","op":"transfer","tick":"${tick}","amt":"${amt}"}`)
  )
}

// buildReclaimCommitTx now looks up each spent input's prevout tx over the network
// (mirrors buildCommitTx). Since these tests spend synthetic utxos that don't exist
// on any real chain, we pre-seed the helper's own prevout-hex cache instead of hitting
// the network — this keeps the suite offline (matches vitest.config.ts's "no network"
// contract) while exercising the real PSBT-building code path.
function seedFakePrevout(utxo: string, value: number, script: Buffer) {
  const [txid, voutStr] = utxo.split(':')
  const vout = Number(voutStr)
  const tx = new bitcoinjs.Transaction()
  tx.addInput(Buffer.alloc(32), 0)
  for (let i = 0; i <= vout; i++)
    tx.addOutput(i === vout ? script : Buffer.alloc(0), i === vout ? value : 0)
  txHexByIdCache[txid!] = tx.toHex()
}

// validateTxes (testmempoolaccept) has no such cache — stub the network boundary
// directly so the assemble-and-validate flow can run fully offline too.
function stubMempoolAccept() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.includes('/testmempoolaccept')) {
      return new Response(JSON.stringify([{ allowed: true }, { allowed: true }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`unexpected network call in offline test: ${url}`)
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('buildReclaimCommitTx', () => {
  it('places reclaim self-sends first and the commit output after them, cardinal-funded', async () => {
    const w = await wallet.connectLocalWallet(WIF, 'testnet', 'p2tr', 'unisat')
    const payerWallet = new WalletInfo(false, null, w.address, null, w.pubkey)
    const inscriptionWallet = new WalletInfo(false, null, w.address, null, w.pubkey)

    const reclaimInputs = [
      { utxo: `${'aa'.repeat(32)}:0`, value: 546, script_type: 'witness_v1_taproot' as const },
      { utxo: `${'bb'.repeat(32)}:0`, value: 600, script_type: 'witness_v1_taproot' as const },
    ]
    const cardinalUtxos = [
      { utxo: `${'cc'.repeat(32)}:1`, value: 100000, script_type: 'witness_v1_taproot' as const },
    ]

    seedFakePrevout(reclaimInputs[0]!.utxo, reclaimInputs[0]!.value, inscriptionWallet.outputScript)
    seedFakePrevout(reclaimInputs[1]!.utxo, reclaimInputs[1]!.value, inscriptionWallet.outputScript)
    seedFakePrevout(cardinalUtxos[0]!.utxo, cardinalUtxos[0]!.value, payerWallet.outputScript)

    const res = await buildReclaimCommitTx(
      cardinalUtxos,
      reclaimInputs,
      payerWallet,
      inscriptionWallet,
      'deadbeef'.repeat(8),
      transferInscription('sats', '1000'),
      5,
      546
    )

    // commit output is at index == number of reclaims
    expect(res.commitVout).toBe(2)

    const outs = res.unsignedCommitTx.outs
    // outputs 0..1 are self-sends preserving each inscription's value
    expect(outs[0].value).toBe(546)
    expect(outs[1].value).toBe(600)
    // output 2 is the taproot commit output (P2TR: OP_1 <32-byte key>)
    const commitSpk = Buff.raw(outs[2].script).hex
    expect(commitSpk.startsWith('5120')).toBe(true)
    expect(outs[2].value).toBe(res.commitOutputValue)
    // a change output to the payer exists after the commit output
    expect(outs.length).toBeGreaterThanOrEqual(4)

    // inputs 0..1 are exactly the reclaimed inscription utxos, in order
    const ins = res.unsignedCommitTx.ins
    expect(`${Buff.raw(ins[0].hash).hex}:${ins[0].index}`).toBe(reclaimInputs[0].utxo)
    expect(`${Buff.raw(ins[1].hash).hex}:${ins[1].index}`).toBe(reclaimInputs[1].utxo)

    // SAT-FLOW: commit output starts exactly at cumulative input == sum of reclaim values,
    // i.e. sum of the first `commitVout` output values equals sum of reclaim input values,
    // so the commit output is funded only by cardinal sats.
    const outPrefix = outs.slice(0, res.commitVout).reduce((s: number, o: any) => s + o.value, 0)
    const reclaimSum = reclaimInputs.reduce((s, r) => s + r.value, 0)
    expect(outPrefix).toBe(reclaimSum)

    // the PSBT is now filled in (Task 2), not the Task-1 stub
    expect(res.unsignedPsbtHex.length).toBeGreaterThan(0)
    expect(() => bitcoinjs.Psbt.fromHex(res.unsignedPsbtHex)).not.toThrow()
  })
})

describe('assembleReclaimCommitAndReveal', () => {
  it('produces a valid commit+reveal where the reveal spends the relocated commit vout', async () => {
    const w = await wallet.connectLocalWallet(WIF, 'testnet', 'p2tr', 'unisat')
    const payerWallet = new WalletInfo(false, null, w.address, null, w.pubkey)
    const inscriptionWallet = new WalletInfo(false, null, w.address, null, w.pubkey)
    const signFn = getSignFn('local')

    const reclaimInputs = [
      { utxo: `${'aa'.repeat(32)}:0`, value: 546, script_type: 'witness_v1_taproot' as const },
    ]
    const cardinalUtxos = [
      { utxo: `${'cc'.repeat(32)}:1`, value: 100000, script_type: 'witness_v1_taproot' as const },
    ]

    seedFakePrevout(reclaimInputs[0]!.utxo, reclaimInputs[0]!.value, inscriptionWallet.outputScript)
    seedFakePrevout(cardinalUtxos[0]!.utxo, cardinalUtxos[0]!.value, payerWallet.outputScript)
    stubMempoolAccept()

    const res = await assembleReclaimCommitAndReveal(
      cardinalUtxos,
      reclaimInputs,
      payerWallet,
      inscriptionWallet,
      transferInscription('sats', '1000'),
      5,
      546,
      signFn
    )

    expect(res.commitVout).toBe(1)
    expect(res.postage).toBe(546)
    expect(res.inscriptionId).toBe(`${res.revealTxId}i0`)

    // the reveal's single input spends the commit tx at vout == commitVout
    const reveal = bitcoinjs.Transaction.fromHex(res.signedRevealTxHex)
    expect(reveal.ins).toHaveLength(1)
    expect(reveal.ins[0]!.index).toBe(res.commitVout)
    // bitcoinjs stores the prevout hash internally byte-reversed relative to the
    // display txid, so reverse it back before comparing to commitTxId.
    expect(Buffer.from(reveal.ins[0]!.hash).reverse().toString('hex')).toBe(res.commitTxId)

    // the signed commit tx is well-formed and actually decodes
    const commit = bitcoinjs.Transaction.fromHex(res.signedCommitTxHex)
    expect(commit.getId()).toBe(res.commitTxId)
  })

  it('routes the reclaim inputs to the ordinals key when payer and inscription wallets differ', async () => {
    // payer (p2wpkh, payment key) and inscription (p2tr, ordinals key) are DISTINCT
    // wallets/keys here, unlike the single-WIF tests above — this is what exercises
    // signer key-routing (ordAddrIdxes) instead of masking it behind one shared key.
    const payer = await wallet.connectLocalWallet(WIF, 'testnet', 'p2wpkh', 'unisat')
    const payerWallet = new WalletInfo(false, null, payer.address, null, payer.pubkey)

    const ord = await wallet.connectLocalWallet(ORD_WIF, 'testnet', 'p2tr', 'unisat')
    const inscriptionWallet = new WalletInfo(false, null, ord.address, null, ord.pubkey)

    expect(payerWallet.addr).not.toBe(inscriptionWallet.addr)

    // A real split-wallet provider (unisat/xverse/okx/leather) holds a distinct key
    // per address and signs input i with the payment key unless i appears in
    // ordAddrIdxes, in which case it signs with the ordinals key (see e.g.
    // src/provider/unisat.ts / local.ts: `if (ordAddrIdxes.includes(i)) { ... ord key
    // ... } else { ... payment key ... }`). The in-repo 'local' provider only ever
    // holds ONE key though, so it can't exercise real per-index key selection here.
    // Instead we spy on the 4th arg (ordAddrIdxes) that assembleReclaimCommitAndReveal
    // hands to the signer — that's precisely the value a real provider uses to decide
    // which key to use for which input, and reverting Finding 1's fix (back to `[]`)
    // makes this assertion fail (verified manually; see PR notes).
    const captured: number[][] = []
    const spySignFn: SignFunction = async (psbtHex, paymentAddr, ordAddr, ordAddrIdxes) => {
      captured.push(ordAddrIdxes)
      // Build a syntactically-valid "signed" tx without real signatures — we only
      // care about the routing decision (ordAddrIdxes), not signature validity,
      // and downstream code (reveal building, the stubbed mempool-accept check)
      // only needs a well-formed txid/hex, not a consensus-valid witness.
      const psbt = bitcoinjs.Psbt.fromHex(psbtHex)
      const tx = new bitcoinjs.Transaction()
      tx.version = 2
      for (const inp of psbt.txInputs) tx.addInput(inp.hash, inp.index, inp.sequence)
      for (const out of psbt.txOutputs) tx.addOutput(out.script, out.value)
      for (let i = 0; i < tx.ins.length; i++) tx.setWitness(i, [Buffer.alloc(64)])
      return { signedTxHex: tx.toHex(), txId: tx.getId() }
    }

    const reclaimInputs = [
      { utxo: `${'aa'.repeat(32)}:0`, value: 546, script_type: 'witness_v1_taproot' as const },
      { utxo: `${'bb'.repeat(32)}:0`, value: 600, script_type: 'witness_v1_taproot' as const },
    ]
    const cardinalUtxos = [
      { utxo: `${'cc'.repeat(32)}:1`, value: 100000, script_type: 'witness_v0_keyhash' as const },
    ]

    seedFakePrevout(reclaimInputs[0]!.utxo, reclaimInputs[0]!.value, inscriptionWallet.outputScript)
    seedFakePrevout(reclaimInputs[1]!.utxo, reclaimInputs[1]!.value, inscriptionWallet.outputScript)
    seedFakePrevout(cardinalUtxos[0]!.utxo, cardinalUtxos[0]!.value, payerWallet.outputScript)
    stubMempoolAccept()

    const res = await assembleReclaimCommitAndReveal(
      cardinalUtxos,
      reclaimInputs,
      payerWallet,
      inscriptionWallet,
      transferInscription('sats', '1000'),
      5,
      546,
      spySignFn
    )

    // the ONLY sign() call must mark every reclaim input index as ordinals-owned,
    // routing them to the ordinals key rather than the payment key.
    expect(captured).toHaveLength(1)
    expect(captured[0]).toEqual([0, 1])

    // sanity: the resulting commit tx is still well-formed
    const commit = bitcoinjs.Transaction.fromHex(res.signedCommitTxHex)
    expect(commit.getId()).toBe(res.commitTxId)
  })
})
