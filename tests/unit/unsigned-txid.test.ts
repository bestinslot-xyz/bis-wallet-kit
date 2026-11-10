import { Buffer } from 'node:buffer'
import * as bitcoinjs from 'bitcoinjs-lib'
import { ECPairFactory } from 'ecpair'
import * as tinysecp from 'tiny-secp256k1'
import { describe, expect, it } from 'vitest'
import { unsignedTxOnceSigned } from '../../src/core/mint.ts'

const network = bitcoinjs.networks.testnet
const key = ECPairFactory(tinysecp).makeRandom({ network })
const pubkey = Buffer.from(key.publicKey)
const signer = {
  publicKey: pubkey,
  sign: (hash: Buffer) => Buffer.from(key.sign(hash)),
}

// A previous tx paying 10k sats to `output`, and a PSBT spending it to a P2WPKH output.
function spend(output: Buffer, extra: Partial<bitcoinjs.PsbtInputUpdate> = {}) {
  const prev = new bitcoinjs.Transaction()
  prev.addInput(Buffer.alloc(32, 1), 0)
  prev.addOutput(output, 10000)
  const psbt = new bitcoinjs.Psbt({ network })
  psbt.addInput({ hash: prev.getId(), index: 0, nonWitnessUtxo: prev.toBuffer(), ...extra })
  psbt.addOutput({ script: bitcoinjs.payments.p2wpkh({ pubkey, network }).output!, value: 9000 })
  return psbt
}

function signedTxid(psbt: bitcoinjs.Psbt): string {
  psbt.signAllInputs(signer)
  psbt.finalizeAllInputs()
  return psbt.extractTransaction().getId()
}

describe('unsignedTxOnceSigned', () => {
  it('gives a P2WPKH spend the txid it has once signed', () => {
    const psbt = spend(bitcoinjs.payments.p2wpkh({ pubkey, network }).output!)
    const unsigned = unsignedTxOnceSigned(psbt)
    expect(unsigned?.getId()).toBe(signedTxid(psbt))
  })

  it('fills in the redeem script push of a P2SH-P2WPKH spend', () => {
    const redeem = bitcoinjs.payments.p2wpkh({ pubkey, network })
    const p2sh = bitcoinjs.payments.p2sh({ redeem, network })
    const psbt = spend(p2sh.output!, { redeemScript: redeem.output! })
    const unsigned = unsignedTxOnceSigned(psbt)
    expect(unsigned?.getId()).toBe(signedTxid(psbt))
  })

  it('gives a P2TR key-path spend the txid it has once signed', () => {
    bitcoinjs.initEccLib(tinysecp)
    const internalPubkey = pubkey.subarray(1, 33)
    const p2tr = bitcoinjs.payments.p2tr({ internalPubkey, network })
    const psbt = new bitcoinjs.Psbt({ network })
    psbt.addInput({
      hash: Buffer.alloc(32, 2),
      index: 0,
      witnessUtxo: { script: p2tr.output!, value: 10000 },
      tapInternalKey: internalPubkey,
    })
    psbt.addOutput({ script: p2tr.output!, value: 9000 })
    const unsigned = unsignedTxOnceSigned(psbt)
    const tweaked = key.tweak(bitcoinjs.crypto.taggedHash('TapTweak', internalPubkey))
    psbt.signAllInputs({
      publicKey: Buffer.from(tweaked.publicKey),
      signSchnorr: (hash: Buffer) => Buffer.from(tweaked.signSchnorr(hash)),
    } as bitcoinjs.Signer)
    psbt.finalizeAllInputs()
    expect(unsigned?.getId()).toBe(psbt.extractTransaction().getId())
  })

  it('cannot tell the txid of a legacy P2PKH spend before signing', () => {
    const psbt = spend(bitcoinjs.payments.p2pkh({ pubkey, network }).output!)
    expect(unsignedTxOnceSigned(psbt)).toBeNull()
  })
})
