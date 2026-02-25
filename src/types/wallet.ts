import { Buffer } from 'node:buffer'
import { Address, Script } from '@cmdcode/tapscript'
import * as bitcoinjs from 'bitcoinjs-lib'
import { getBitcoinNetwork } from '../lib/bitcoin'

/**
 * Class representing wallet information for a Bitcoin address. This class is used to encapsulate the properties of a wallet, such as its address,
 * redeem script, whether it is an OP_RETURN output, the output script, and the public key. The constructor validates the properties and sets the output
 * script based on the provided address and output script. The class also includes a method to retrieve the redeem script, which can be derived from the public key if not provided.
 *
 * @class WalletInfo
 * @property {string|null|undefined} addr - The Bitcoin address associated with the wallet, or null/undefined if not specified.
 * @property {Buffer|null} redeemScript - The redeem script for the wallet, or null if not specified.
 * @property {boolean} is_op_return - A boolean indicating whether the wallet is an OP_RETURN output.
 * @property {Buffer} outputScript - The output script for the wallet, derived from the address or provided directly.
 * @property {string|null} publicKey - The public key associated with the wallet, or null if not specified.
 */
export class WalletInfo {
  addr: string | null | undefined
  redeemScript: Buffer | null
  isOpReturn: boolean
  outputScript: Buffer
  publicKey: string | null

  /**
   * Creates an instance of WalletInfo.
   *
   * @param {boolean} isOpReturn - A boolean indicating whether the wallet is an OP_RETURN output.
   * @param {Buffer|null} outputScript - The output script for the wallet, or null if it should be derived from the address.
   * @param {string|null|undefined} addr - The Bitcoin address associated with the wallet, or null/undefined if not specified.
   * @param {Buffer|null} redeemScript - The redeem script for the wallet, or null if not specified.
   * @param {string|null} publicKey - The public key associated with the wallet, or null if not specified.
   */
  constructor(
    isOpReturn: boolean,
    outputScript: Buffer | null,
    addr: string | null | undefined,
    redeemScript: Buffer | null,
    publicKey: string | null,
  ) {
    this.addr = addr
    this.redeemScript = redeemScript
    this.isOpReturn = isOpReturn
    this.publicKey = publicKey

    // Set outputScript based on conditions
    if (addr != null && outputScript == null) {
      this.outputScript = Buffer.from(Script.encode(Address.toScriptPubKey(addr), false))
    }
    else {
      if (outputScript == null) {
        throw new Error('outputScript and addr cannot be null')
      }
      this.outputScript = outputScript
    }
  }

  /**
   * Get the redeem script for the wallet. If the redeem script is already set, it returns the cached redeem script. If not, it derives the redeem script from the public key.
   *
   * @returns {Buffer} The redeem script for the wallet.
   */
  getRedeemScript(): Buffer {
    // Return the cached redeemScript if it exists
    if (this.redeemScript != null) {
      return this.redeemScript
    }

    // Derive redeemScript from publicKey
    if (this.publicKey == null) {
      throw new Error('publicKey is required to derive redeemScript')
    }

    const network = getBitcoinNetwork()

    const pubKeyBuffer = Buffer.from(this.publicKey, 'hex')
    const p2wpkh = bitcoinjs.payments.p2wpkh({
      pubkey: pubKeyBuffer,
      network,
    })

    const p2sh = bitcoinjs.payments.p2sh({
      redeem: p2wpkh,
      network,
    })

    if (!p2sh.redeem?.output) {
      throw new Error('Failed to derive redeemScript')
    }

    return p2sh.redeem.output
  }
}

/**
 * Utility function to create a WalletInfo instance for an OP_RETURN output. This function takes an output script as input and returns a WalletInfo instance with the isOpReturn property set to true.
 *
 * @param outputScript - The output script for the OP_RETURN output, provided as a Buffer.
 * @returns {WalletInfo} A WalletInfo instance representing the OP_RETURN output.
 */
export function opReturnWalletInfo(outputScript: Buffer): WalletInfo {
  return new WalletInfo(true, outputScript, null, null, null)
}

/**
 * Utility function to create a WalletInfo instance for a standard Bitcoin address. This function takes a Bitcoin address as input and returns a WalletInfo instance with the isOpReturn property set to false and the output script derived from the address.
 *
 * @param addr - The Bitcoin address for which to create the WalletInfo instance, provided as a string.
 * @returns {WalletInfo} A WalletInfo instance representing the standard Bitcoin address.
 */
export function addressWalletInfo(addr: string): WalletInfo {
  return new WalletInfo(false, null, addr, null, null)
}
