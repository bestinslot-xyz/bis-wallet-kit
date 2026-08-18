import { Buff } from '@cmdcode/buff-utils'
import { describe, expect, it } from 'vitest'
import { buildReclaimCommitTx } from '../../src/core/mint.ts'
import { wallet } from '../../src/node.ts'
import { InscriptionDetails } from '../../src/types/inscription.ts'
import { WalletInfo } from '../../src/types/wallet.ts'

const WIF = 'cN9spWsvaxA8taS7DFMxnk1yJD2gaF2PX1npuTpy3vuZFJdwavaw'

function transferInscription(tick: string, amt: string) {
  return new InscriptionDetails(
    Buff.str('text/plain'),
    null,
    null,
    null,
    null,
    Buff.str(`{"p":"brc-20","op":"transfer","tick":"${tick}","amt":"${amt}"}`),
  )
}

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

    const res = buildReclaimCommitTx(
      cardinalUtxos,
      reclaimInputs,
      payerWallet,
      inscriptionWallet,
      'deadbeef'.repeat(8),
      transferInscription('sats', '1000'),
      5,
      546,
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
  })
})
