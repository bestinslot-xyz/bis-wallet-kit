import type { BISWallet, BISWalletPurpose } from '../types/common'
import type { BISProvider, SignManyFunction, SignPsbtRequest, SignResponse } from './api'
import { Buffer } from 'node:buffer'
// Pure JS: this module is in the browser bundle, where tiny-secp256k1's WASM needs a top-level await.
import * as ecc from '@bitcoinerlab/secp256k1'
import * as bitcoinjs from 'bitcoinjs-lib'
import * as varuint from 'varuint-bitcoin'
import { broadcastTxes, finalizePsbtInputs, getCardinalUtxos, validateTxes } from '../core/helpers'
import { buildPsbtFromTx, buildTransaction } from '../core/mint'
import { getOrdinalsWallet, getPaymentWallet } from '../core/providers'
import { getBitcoinNetwork } from '../lib/bitcoin'
import { WalletInfo } from '../types/wallet'

/** A Bitcoin account a wallet exposes, with the use it is meant for. */
export interface BitcoinWalletAccount {
  address: string
  /** Hex public key, or null when the wallet does not report a usable one. */
  publicKey: string | null
  purpose: 'payment' | 'ordinals'
}

/** One PSBT to sign, with the input indexes each of the wallet's addresses signs. */
export interface BitcoinSignPsbtInput {
  psbt: Uint8Array
  inputs: { address: string; signingIndexes: number[] }[]
}

/**
 * The calls a Bitcoin wallet offers, whatever API the wallet is reached through (the Wallet
 * Standard or an injected provider). `signPsbts` returns the signed PSBTs in request order, unbroadcast.
 */
export interface BitcoinWalletBackend {
  connect: () => Promise<BitcoinWalletAccount[]>
  /** The addresses of the connected account, without prompting; empty when unknown. */
  accounts: () => string[]
  /** Subscribes to account switches; returns an unsubscribe function. */
  onAccountsChanged: (handler: (addresses: string[]) => void) => () => void
  /** Signs `message` with `address`'s key and returns the signature bytes (BIP-322 or legacy). */
  signMessage: (address: string, message: Uint8Array) => Promise<Uint8Array>
  signPsbts: (requests: BitcoinSignPsbtInput[]) => Promise<Uint8Array[]>
  /** Whether `signPsbts` hands every PSBT to the wallet in one request. */
  signsManyAtOnce: boolean
}

const PUBKEY_MESSAGE = '[Best in Slot] wants to know your public key.'

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

/** The address a P2WPKH or P2PKH output for `pubkey` pays, matching `address`'s type. */
function addressForPubkey(pubkey: Buffer, address: string): string | undefined {
  const network = getBitcoinNetwork()
  if (address.toLowerCase().startsWith(network.bech32)) {
    return bitcoinjs.payments.p2wpkh({ pubkey, network }).address
  }
  return bitcoinjs.payments.p2pkh({ pubkey, network }).address
}

/** The hash a legacy ("Bitcoin Signed Message") signature over `message` signs. */
function legacyMessageHash(message: string): Buffer {
  const prefix = Buffer.from(getBitcoinNetwork().messagePrefix, 'utf8')
  const body = Buffer.from(message, 'utf8')
  const length = Buffer.alloc(varuint.encodingLength(body.length))
  varuint.encode(body.length, length)
  return bitcoinjs.crypto.hash256(Buffer.concat([prefix, length, body]))
}

/**
 * The public key behind `address`, read from a signature over `message`: a BIP-322 simple
 * signature's witness carries it, and a legacy 65-byte signature lets it be recovered. Null when
 * neither yields a key that pays `address`.
 */
export function publicKeyFromSignature(
  message: string,
  signature: Uint8Array,
  address: string
): string | null {
  const candidates: Buffer[] = []
  const sig = Buffer.from(signature)
  if (sig.length === 65) {
    const header = sig[0]! - 27
    const recovery = header & 3
    const compressed = header >= 4
    const key = ecc.recover(
      legacyMessageHash(message),
      sig.subarray(1),
      recovery as 0 | 1 | 2 | 3,
      compressed
    )
    if (key) candidates.push(Buffer.from(key))
  } else {
    // A serialized witness stack: an item count, then each item with its length.
    let offset = 0
    const count = sig[offset++] ?? 0
    for (let i = 0; i < count && offset < sig.length; i++) {
      const length = sig[offset++] ?? 0
      candidates.push(sig.subarray(offset, offset + length))
      offset += length
    }
  }
  const match = candidates.find(
    key => key.length === 33 && addressForPubkey(key, address) === address
  )
  return match ? match.toString('hex') : null
}

/** The `signPSBT`-style inputs to sign for a `sign` request: payment inputs, then ordinals ones. */
function inputsOf(request: SignPsbtRequest): BitcoinSignPsbtInput['inputs'] {
  const { unsignedPsbtHex, paymentAddr, ordAddr, ordAddrIdxes, noSignIdxes } = request
  const psbt = bitcoinjs.Psbt.fromHex(unsignedPsbtHex)
  const paymentIdxes: number[] = []
  for (let i = 0; i < psbt.inputCount; i++) {
    if (noSignIdxes?.includes(i) || ordAddrIdxes.includes(i)) continue
    paymentIdxes.push(i)
  }
  if (paymentAddr === ordAddr) {
    return [{ address: paymentAddr, signingIndexes: [...paymentIdxes, ...ordAddrIdxes] }]
  }
  return [
    { address: paymentAddr, signingIndexes: paymentIdxes },
    { address: ordAddr, signingIndexes: ordAddrIdxes },
  ].filter(input => input.signingIndexes.length > 0)
}

function signedResponse(signedPsbt: Uint8Array, noSignIdxes?: number[]): SignResponse {
  const psbt = bitcoinjs.Psbt.fromBuffer(Buffer.from(signedPsbt))
  finalizePsbtInputs(psbt, noSignIdxes)
  const tx = psbt.extractTransaction()
  return { txId: tx.getId(), signedTxHex: tx.toHex() }
}

/**
 * Builds a `BISProvider` for a Bitcoin wallet reached through `getBackend`, which returns null
 * while the wallet is not installed. A wallet that gives only a payment account is used as a
 * single-address wallet (`purpose: 'all'`), and an account without a usable public key gets one
 * from a one-time message signature at connect.
 */
export function createBitcoinWalletProvider(
  walletName: string,
  getBackend: () => BitcoinWalletBackend | null
): BISProvider {
  const requireBackend = (): BitcoinWalletBackend => {
    const backend = getBackend()
    if (!backend) throw new Error(`${walletName} is not installed.`)
    return backend
  }

  const signMessageHex = async (address: string, message: string): Promise<string> => {
    try {
      const signature = await requireBackend().signMessage(
        address,
        new TextEncoder().encode(message)
      )
      return bytesToHex(signature)
    } catch (e) {
      console.error('Failed to sign message', e)
      throw new Error('Failed to sign message.')
    }
  }

  const getWallets = async (): Promise<BISWallet[]> => {
    const backend = requireBackend()
    const accounts = await backend.connect()
    const payment = accounts.find(a => a.purpose === 'payment')
    if (!payment) throw new Error(`${walletName} returned no payment address.`)
    const ordinals = accounts.find(a => a.purpose === 'ordinals')

    const withPubkey = async (account: BitcoinWalletAccount): Promise<string> => {
      if (account.publicKey) return account.publicKey
      const signature = await backend.signMessage(
        account.address,
        new TextEncoder().encode(PUBKEY_MESSAGE)
      )
      const pubkey = publicKeyFromSignature(PUBKEY_MESSAGE, signature, account.address)
      if (!pubkey) throw new Error(`Could not read the public key of ${account.address}.`)
      return pubkey
    }

    if (!ordinals || ordinals.address === payment.address) {
      return [{ address: payment.address, pubkey: await withPubkey(payment), purpose: 'all' }]
    }
    return [
      { address: payment.address, pubkey: await withPubkey(payment), purpose: 'payment' },
      { address: ordinals.address, pubkey: await withPubkey(ordinals), purpose: 'ordinals' },
    ]
  }

  const signMessage = async (
    message: string,
    walletType: BISWalletPurpose,
    walletAddress: string
  ): Promise<string> => {
    const address =
      walletAddress ||
      (walletType === 'ordinals' ? getOrdinalsWallet() : getPaymentWallet())?.address
    if (!address) throw new Error('No wallet address to sign with.')
    return signMessageHex(address, message)
  }

  const signMessageDeterministic = async (
    message: string
  ): Promise<{ signature: string; address: string }> => {
    const address = getPaymentWallet()?.address
    if (!address) throw new Error('No payment wallet found.')
    return { signature: await signMessageHex(address, message), address }
  }

  const signPSBT = async (
    psbtBase64: string,
    broadcast: boolean,
    inputsToSign: any[]
  ): Promise<string> => {
    const [signed] = await requireBackend().signPsbts([
      {
        psbt: Buffer.from(psbtBase64, 'base64'),
        inputs: inputsToSign.map(input => ({
          address: input.address,
          signingIndexes: input.signingIndexes,
        })),
      },
    ])
    if (!signed) throw new Error(`${walletName} returned no signed PSBT.`)
    if (!broadcast) return bytesToHex(signed)
    const { txId, signedTxHex } = signedResponse(signed)
    if ((await broadcastTxes([signedTxHex])) == null) throw new Error('Failed to broadcast.')
    return txId
  }

  const signMany: SignManyFunction = async requests => {
    const signed = await requireBackend().signPsbts(
      requests.map(r => ({
        psbt: Buffer.from(r.unsignedPsbtHex, 'hex'),
        inputs: inputsOf(r),
      }))
    )
    if (signed.length !== requests.length)
      throw new Error(`${walletName} returned the wrong PSBT count.`)
    return signed.map((psbt, i) => signedResponse(psbt, requests[i]!.noSignIdxes))
  }

  const sign = async (
    unsignedPsbtHex: string,
    paymentAddr: string,
    ordAddr: string,
    ordAddrIdxes: number[],
    useTweakSignerIdxes?: number[],
    noSignIdxes?: number[]
  ): Promise<SignResponse> => {
    const [signed] = await signMany([
      { unsignedPsbtHex, paymentAddr, ordAddr, ordAddrIdxes, useTweakSignerIdxes, noSignIdxes },
    ])
    return signed!
  }

  const sendBTC = async (amountSats: number, toAddress: string, feeRate?: number) => {
    if (!Number.isInteger(amountSats) || amountSats <= 0)
      throw new Error('amountSats must be a positive integer (satoshis).')
    if (feeRate == null || !Number.isFinite(feeRate) || feeRate <= 0)
      throw new Error(`feeRate (sat/vB) must be a positive number for ${walletName}.`)
    const payment = getPaymentWallet()
    if (!payment) throw new Error('No payment wallet found.')

    const payerWallet = new WalletInfo(false, null, payment.address, null, payment.pubkey)
    const recipientWallet = new WalletInfo(false, null, toAddress, null, null)
    const cardinalUtxos = await getCardinalUtxos(payment.address)
    const unsigned = buildTransaction(
      cardinalUtxos,
      [],
      payerWallet,
      [],
      recipientWallet,
      payerWallet,
      feeRate,
      amountSats,
      null,
      null
    )
    const unsignedPsbt = await buildPsbtFromTx(unsigned.tx, cardinalUtxos, payerWallet, [])
    const signed = await sign(unsignedPsbt.toHex(), payment.address, payment.address, [])

    const isValid = await validateTxes([signed.signedTxHex])
    if (isValid == null) throw new Error('Send BTC validation failed (testmempoolaccept failed).')
    for (const entry of isValid) {
      if (!entry.allowed) throw new Error(entry['reject-reason'])
    }
    if ((await broadcastTxes([signed.signedTxHex])) == null)
      throw new Error('Failed to broadcast transaction.')
    return signed.txId
  }

  return {
    getWallets,
    getAccounts: async () => getBackend()?.accounts() ?? [],
    onAccountsChanged: handler => getBackend()?.onAccountsChanged(handler) ?? (() => {}),
    signMessage,
    signMessageDeterministic,
    sendBTC,
    signPSBT,
    sign,
    getSignMany: () => (getBackend()?.signsManyAtOnce ? signMany : null),
  }
}
