import { Buffer } from 'node:buffer'
import { bls12_381 } from '@noble/curves/bls12-381.js'
import { getSwapWalletFromDB } from './bis_swap'

/** Hash-to-curve domain tag shared by every swap-wallet BLS signature. */
const BLS_DST = 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_'

export interface SignBlsMessageOptions {
  /**
   * Return the negated signature, the form a contract verifies a single signature in.
   * Leave it off for signatures a sequencer aggregates (the swap-op form).
   */
  negate?: boolean
}

function hexBytes(value: string, what: string): Buffer {
  const hex = value.startsWith('0x') ? value.slice(2) : value
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
    throw new Error(`${what} must be a hex string`)
  }
  return Buffer.from(hex, 'hex')
}

/**
 * Signs `msgHex` with a BLS private key, using the swap-op DST, and returns the G1
 * signature as 0x-prefixed `x || y` (64 bytes each, big-endian).
 *
 * @param privKeyHex The 32-byte BLS private key, hex with or without 0x.
 * @param msgHex The message bytes, hex with or without 0x.
 * @param options `negate` returns the negated signature.
 */
export function signBlsMessageWithKey(
  privKeyHex: string,
  msgHex: string,
  options: SignBlsMessageOptions = {}
): string {
  const key = hexBytes(privKeyHex, 'BLS private key')
  const msg = hexBytes(msgHex, 'message')
  const point = bls12_381.G1.hashToCurve(msg, { DST: BLS_DST })
  let sig = bls12_381.shortSignatures.sign(point, key)
  if (options.negate) sig = sig.negate()
  return `0x${sig.x.toString(16).padStart(128, '0')}${sig.y.toString(16).padStart(128, '0')}`
}

/**
 * Signs `msgHex` with the connected wallet's stored swap BLS key. The message is not
 * filtered: whoever can call this can already read the key through `ensureSwapWallet`.
 *
 * @param msgHex The message bytes, hex with or without 0x.
 * @param options `negate` returns the negated signature.
 * @returns The G1 signature as 0x-prefixed `x || y`.
 * @throws {Error} When no swap wallet is stored for the connected wallet.
 */
export async function signBlsMessage(
  msgHex: string,
  options: SignBlsMessageOptions = {}
): Promise<string> {
  const swapWallet = await getSwapWalletFromDB()
  if (!swapWallet?.swapPrivkey) {
    throw new Error('Smart wallet not found. Please generate a smart wallet first.')
  }
  return signBlsMessageWithKey(swapWallet.swapPrivkey, msgHex, options)
}
