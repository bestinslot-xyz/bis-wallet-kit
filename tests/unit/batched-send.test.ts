import type { BatchedSendLayout } from '../../src/core/mint.ts'
import { Buffer } from 'node:buffer'
import { Buff } from '@cmdcode/buff-utils'
import { Script } from '@cmdcode/tapscript'
import { describe, expect, it } from 'vitest'
import { buildTransactionMultiOutput, getInscribeAllToOpReturnFee } from '../../src/core/mint.ts'
import { wallet } from '../../src/node.ts'
import { InscriptionDetails } from '../../src/types/inscription.ts'
import { WalletInfo } from '../../src/types/wallet.ts'

const WIF = 'cN9spWsvaxA8taS7DFMxnk1yJD2gaF2PX1npuTpy3vuZFJdwavaw'

const opReturnWallet = new WalletInfo(
  true,
  Buffer.from(Script.encode(['OP_RETURN', Buff.str('BRC20PROG')], false)),
  null,
  null,
  null
)

async function payer() {
  const w = await wallet.connectLocalWallet(WIF, 'testnet', 'p2tr', 'unisat')
  return new WalletInfo(false, null, w.address, null, w.pubkey)
}

// Three 331-sat inscription inputs sent interleaved: a 1-sat OP_RETURN each, 330 back between them.
async function interleavedSend(feeRate: number, fundingInput: boolean) {
  const payerWallet = await payer()
  const inscriptions = [0, 1, 2].map(i => ({
    utxo: `${'aa'.repeat(32)}:${i}`,
    value: 331,
    script_type: 'witness_v1_taproot' as const,
    wallet: payerWallet,
  }))
  const cardinals = [
    { utxo: `${'cc'.repeat(32)}:0`, value: 20000, script_type: 'witness_v1_taproot' as const },
  ]
  const wallets = [opReturnWallet, payerWallet, opReturnWallet, payerWallet, opReturnWallet]
  return buildTransactionMultiOutput(
    cardinals,
    inscriptions,
    payerWallet,
    wallets,
    [1, 330, 1, 330, 1],
    payerWallet,
    feeRate,
    fundingInput
  )
}

describe('getInscribeAllToOpReturnFee', () => {
  const transfer = (amt: string) =>
    new InscriptionDetails(
      Buff.str('text/plain'),
      null,
      null,
      null,
      null,
      Buff.str(`{"p":"brc-20","op":"transfer","tick":"ordi","amt":"${amt}"}`)
    )
  const cardinals = [
    { utxo: `${'cc'.repeat(32)}:0`, value: 50000, script_type: 'witness_v1_taproot' as const },
  ]
  const feeOf = async (layout: BatchedSendLayout, feeRate: number) => {
    await payer()
    return getInscribeAllToOpReturnFee(
      [transfer('1'), transfer('2'), transfer('3')],
      [],
      opReturnWallet,
      feeRate,
      layout,
      cardinals
    )
  }

  it('prices interleaved below single at a low fee rate', async () => {
    const single = await feeOf('single', 0.5)
    const interleaved = await feeOf('interleaved', 0.5)
    expect(interleaved.sendLayout).toBe('interleaved')
    // single burns two postages (660 sats) more; interleaved's four extra outputs cost back ~65.
    expect(single.totalFee - interleaved.totalFee).toBeGreaterThan(550)
  })

  it('auto resolves to the cheaper layout', async () => {
    const auto = await feeOf('auto', 0.5)
    const interleaved = await feeOf('interleaved', 0.5)
    expect(auto.sendLayout).toBe('interleaved')
    expect(auto.totalFee).toBe(interleaved.totalFee)
  })

  it('prices whole sats at a fractional fee rate', async () => {
    const { totalFee } = await feeOf('auto', 0.37)
    expect(Number.isInteger(totalFee)).toBe(true)
  })
})

describe('buildTransactionMultiOutput', () => {
  it('pays the fee from the surplus of the forced inputs when it covers it', async () => {
    const { tx, tx_fee: txFee } = await interleavedSend(1, false)
    expect(tx.ins).toHaveLength(3)
    expect(tx.outs.map(o => o.value)).toEqual([1, 330, 1, 330, 1])
    expect(txFee).toBe(330)
  })

  it('adds a payer input with fundingInput, so the surplus returns as change', async () => {
    const { tx, tx_fee: txFee } = await interleavedSend(0.5, true)
    expect(tx.ins).toHaveLength(4)
    expect(tx.outs).toHaveLength(6)
    expect(tx.outs[5]!.value).toBe(20000 + 330 - txFee)
    expect(txFee).toBe(Math.ceil(tx.virtualSize() * 0.5))
  })

  it('builds whole-sat outputs and fees at a fractional fee rate', async () => {
    for (const feeRate of [0.1, 0.37, 1.5, 2.25]) {
      const { tx, tx_fee: txFee } = await interleavedSend(feeRate, true)
      for (const out of tx.outs) expect(Number.isInteger(out.value)).toBe(true)
      expect(Number.isInteger(txFee)).toBe(true)
      expect(txFee).toBeGreaterThanOrEqual(tx.virtualSize() * feeRate)
    }
  })
})
