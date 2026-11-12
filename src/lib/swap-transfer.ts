import { Buffer } from 'node:buffer'
import * as ethers from 'ethers'

/**
 * The fields of a transfer between swap wallets that both signatures cover.
 */
export interface TransferOrderFields {
  /** The recipient's BTC (ordinals) address, as their swap wallet is registered with the backend. */
  toBtcAddress: string
  tokenAddress: string
  amt: bigint
  btcFee: bigint
}

const strip0x = (hex: string): string =>
  hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex

/** keccak256 of a 256-byte BLS pubkey, the key the swap contract holds balances under; 0x-prefixed. */
export function swapPubkeyHash(pubkey: string): string {
  return ethers.keccak256(Buffer.from(strip0x(pubkey), 'hex'))
}

/**
 * The text the ordinals wallet signs (BIP-322) for a transfer order. It names the recipient by BTC
 * address, which is what the user typed; the backend resolves it to the recipient's swap wallet.
 */
export function transferOrderSignatureText(order: TransferOrderFields): string {
  return `Transfer Order:
Recipient Address: ${order.toBtcAddress}
Token Address: ${order.tokenAddress.toLowerCase()}
Amount: ${order.amt}
Token 1 Fee Bps: 0
Token 2 Fee Bps: 0
BTC Fee: ${order.btcFee}

By signing this message, you authorize the creation of a transfer order with the above parameters.`
}

export interface TransferBLSMessageFields {
  /** block.chainid of the BRC2.0 EVM the swap contract runs on. */
  chainId: bigint
  contractAddress: string
  fromPubkey: string
  nonce: bigint
  tokenAddress: string
  toPubkey: string
  amt: bigint
  btcFee: bigint
}

/**
 * The message the swap key signs for a transfer, as the contract's `transferMessage` packs it:
 * "BIS_SWAP_TRANSFER", chain id (32 bytes), contract (20), sender pubkey hash (32), pk nonce (4),
 * selector 0x08 (1), token (20), recipient pubkey hash (32), amount (32), fee (32). The chain id and
 * contract bind the signature to one deployment.
 */
export function transferBLSMessage(f: TransferBLSMessageFields): Buffer {
  let msg = Buffer.from('BIS_SWAP_TRANSFER', 'utf8').toString('hex')
  msg += f.chainId.toString(16).padStart(64, '0')
  msg += strip0x(f.contractAddress).toLowerCase().padStart(40, '0')
  msg += strip0x(swapPubkeyHash(f.fromPubkey))
  msg += f.nonce.toString(16).padStart(8, '0')
  msg += '08' // transfer
  msg += strip0x(f.tokenAddress).toLowerCase().padStart(40, '0')
  msg += strip0x(swapPubkeyHash(f.toPubkey))
  msg += f.amt.toString(16).padStart(64, '0')
  msg += f.btcFee.toString(16).padStart(64, '0')
  return Buffer.from(msg, 'hex')
}
