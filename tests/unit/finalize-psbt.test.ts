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

// A taproot (v1 witness) output script — OP_1 followed by a 32-byte x-only key —
// standing in for a wallet's taproot payment/ordinals input.
const TAPROOT_SCRIPT = Buffer.concat([Buffer.from([0x51, 0x20]), Buffer.alloc(32, 1)])

// A PSBT whose single input the wallet already finalized (finalScriptWitness set,
// no partial sig left) — exactly what unisat/okx return with autoFinalized:true, and
// what the kit sets directly for pre-signed script-path inputs. Re-finalizing such an
// input makes bitcoinjs throw "No tapleaf script signature provided".
function psbtWithWalletFinalizedTaprootInput(): bitcoinjs.Psbt {
  const psbt = new bitcoinjs.Psbt({ network: bitcoinjs.networks.testnet })
  psbt.addInput({
    hash: Buffer.alloc(32),
    index: 0,
    witnessUtxo: { script: TAPROOT_SCRIPT, value: 1000 },
  })
  // Serialized witness stack: 1 item, 64-byte schnorr signature.
  const finalScriptWitness = Buffer.concat([Buffer.from([0x01, 0x40]), Buffer.alloc(64)])
  psbt.updateInput(0, { finalScriptWitness })
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

  it('leaves inputs the wallet already finalized untouched', () => {
    // Regression: unisat/okx sign with autoFinalized:true, so their inputs come
    // back already finalized. Re-finalizing them threw "No tapleaf script
    // signature provided" and broke every deposit on those wallets.
    const psbt = psbtWithWalletFinalizedTaprootInput()
    assert.doesNotThrow(() => finalizePsbtInputs(psbt))
    assert.ok(psbt.data.inputs[0]!.finalScriptWitness, 'witness must be preserved')
  })
})
