import { Buffer } from 'node:buffer'
import { bls12_381 } from '@noble/curves/bls12-381.js'
import { describe, expect, it } from 'vitest'
import { signBlsMessageWithKey } from '../../src/core/bls-sign'

const DST = 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_'
const PRIV = `0x${'11'.repeat(32)}`
const MSG = `0x${Buffer.from('BISDEX-FARM-V1').toString('hex')}02abcdef`

function point(sigHex: string) {
  const hex = sigHex.slice(2)
  return bls12_381.G1.Point.fromAffine({
    x: BigInt(`0x${hex.slice(0, 128)}`),
    y: BigInt(`0x${hex.slice(128)}`),
  })
}

describe('signBlsMessageWithKey', () => {
  const pub = bls12_381.shortSignatures.getPublicKey(Buffer.from(PRIV.slice(2), 'hex'))
  const hashed = bls12_381.G1.hashToCurve(Buffer.from(MSG.slice(2), 'hex'), { DST })

  it('returns a 128-byte signature that verifies against the public key', () => {
    const sig = signBlsMessageWithKey(PRIV, MSG)
    expect(sig).toMatch(/^0x[0-9a-f]{256}$/)
    expect(bls12_381.shortSignatures.verify(point(sig), hashed, pub)).toBe(true)
  })

  it('negate returns the negation of the plain signature', () => {
    const plain = point(signBlsMessageWithKey(PRIV, MSG))
    const negated = point(signBlsMessageWithKey(PRIV, MSG, { negate: true }))
    expect(negated.equals(plain.negate())).toBe(true)
  })

  it('accepts hex with or without 0x and is deterministic', () => {
    expect(signBlsMessageWithKey(PRIV.slice(2), MSG.slice(2))).toBe(
      signBlsMessageWithKey(PRIV, MSG)
    )
  })

  it('rejects a message that is not hex', () => {
    expect(() => signBlsMessageWithKey(PRIV, 'not hex')).toThrow('message must be a hex string')
    expect(() => signBlsMessageWithKey(PRIV, '0xabc')).toThrow('message must be a hex string')
  })
})
