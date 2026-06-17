import { Buffer } from 'node:buffer'
import * as bitcoinjs from 'bitcoinjs-lib'
import { assert, describe, it } from 'vitest'
import { finalizePsbtInputs } from '../../src/core/helpers.ts'

// A p2wpkh output script to attach as the (fake) prevout for a PSBT input.
const SCRIPT = bitcoinjs.address.toOutputScript(
  'tb1ql3e9pgs3mmwuwrh95fecme0s0qtn28804khrk8',
  bitcoinjs.networks.testnet,
)

function psbtWithUnsignedInputs(count: number): bitcoinjs.Psbt {
  const psbt = new bitcoinjs.Psbt({ network: bitcoinjs.networks.testnet })
  for (let i = 0; i < count; i++) {
    psbt.addInput({
      hash: Buffer.alloc(32),
      index: i,
      witnessUtxo: { script: SCRIPT, value: 1000 },
    })
  }
  return psbt
}

describe('finalizePsbtInputs', () => {
  it('throws (does not swallow) when an input cannot be finalized', () => {
    const psbt = psbtWithUnsignedInputs(1)
    assert.throws(() => finalizePsbtInputs(psbt), /Failed to finalize PSBT input 0/)
  })

  it('skips indexes listed in noSignIdxes', () => {
    const psbt = psbtWithUnsignedInputs(1)
    assert.doesNotThrow(() => finalizePsbtInputs(psbt, [0]))
  })

  it('reports the specific failing input index', () => {
    const psbt = psbtWithUnsignedInputs(2)
    // input 0 is skipped, so the first failure is input 1
    assert.throws(() => finalizePsbtInputs(psbt, [0]), /input 1/)
  })
})
