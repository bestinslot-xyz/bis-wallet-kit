import type { Network, Signer } from 'bitcoinjs-lib'
import type { ECPairInterface } from 'ecpair'
import type { SignResponse } from '../core/providers'
import type { BISNetwork, BISWallet } from '../main'
import { Buffer } from 'node:buffer'
import { memoryStorage } from '@@/core/storage'
import { saveWalletInfo } from '@@/core/store'
import { Signer as BIP322Signer } from 'bip322-js'
import * as bitcoinMessage from 'bitcoinjs-message'
import { ECPairFactory } from 'ecpair'
import * as tinysecp from 'tiny-secp256k1'
import { broadcast_txes, hexToBase64 } from '../core/helpers'
import { bitcoinjs, getBitcoinNetwork } from '../lib/bitcoin'
import { getNetwork, setNetwork } from '../main'

// @ts-expect-error not in use
// eslint-disable-next-line unused-imports/no-unused-vars
function isInstalled() {
  return true
}

export type LocalWalletSource = 'unisat' | 'okx'
export type LocalWalletType = 'p2wpkh' | 'p2tr'

const localWalletStorage = memoryStorage()

const PRIV_KEY = 'local_priv_key'
const NETWORK_KEY = 'local_network'
const WALLET_TYPE_KEY = 'local_wallet_type'
const SOURCE_KEY = 'local_source'

/**
 *
 */
export async function checkNetwork() {
  if (typeof window !== 'undefined') {
    throw new TypeError('Local provider is only available in Node.js environment.')
  }

  const bisNetwork = getNetwork()
  const walletNetwork = await getWalletNetwork()

  if (bisNetwork !== walletNetwork) {
    localWalletStorage.remove(PRIV_KEY)
    localWalletStorage.remove(NETWORK_KEY)
    throw new Error('Network mismatch. Please load the correct wallet.')
  }
}

// TODO: Add taproot wallet support
/**
 *
 * @param privkey
 * @param network
 * @param walletType
 * @param sourceWallet
 */
export async function saveWallet(
  privkey: string,
  network: BISNetwork,
  walletType: LocalWalletType = 'p2wpkh',
  sourceWallet: LocalWalletSource = 'unisat',
): Promise<void> {
  if (walletType !== 'p2wpkh' && walletType !== 'p2tr') {
    throw new Error('Invalid wallet type. Supported types are p2wpkh and p2tr.')
  }

  if (sourceWallet !== 'unisat' && sourceWallet !== 'okx') {
    throw new Error('Invalid wallet source. Supported sources are unisat and okx.')
  }

  setNetwork(network)
  localWalletStorage.set(PRIV_KEY, privkey)
  localWalletStorage.set(NETWORK_KEY, network)
  localWalletStorage.set(WALLET_TYPE_KEY, walletType)
  localWalletStorage.set(SOURCE_KEY, sourceWallet)

  const wallet_info = await getWalletInfo()
  if (!wallet_info) {
    throw new Error('Failed to save wallet.')
  }

  const session = {
    provider: 'local' as const,
    wallets: [
      {
        address: wallet_info.address,
        pubkey: Buffer.from(wallet_info.keyPair.publicKey).toString('hex'),
        purpose: 'all' as const,
      },
    ],
    signature: null,
  }

  saveWalletInfo(session)
}

interface LocalWalletInfo {
  xOnly: Buffer
  keyPair: ECPairInterface
  network: Network
  address: string
  signer: Signer
  tweakedSigner?: Signer
  walletType: LocalWalletType
}

/**
 *
 */
export async function getWalletInfo(): Promise<LocalWalletInfo | null> {
  const privkey = localWalletStorage.get(PRIV_KEY)
  if (!privkey) {
    return null
  }
  const wallet_type = (localWalletStorage.get(WALLET_TYPE_KEY) as LocalWalletType) || 'p2wpkh'
  const keyPair = ECPairFactory(tinysecp).fromWIF(privkey, getBitcoinNetwork())
  const xOnly = tinysecp.xOnlyPointFromPoint(keyPair.publicKey)
  const tweakedKeyPair = keyPair.tweak(bitcoinjs.crypto.taggedHash('TapTweak', Buffer.from(xOnly)))
  let address = null
  try {
    if (wallet_type === 'p2wpkh') {
      address = bitcoinjs.payments.p2wpkh({
        pubkey: Buffer.from(keyPair.publicKey),
        network: getBitcoinNetwork(),
      }).address
    }
    else if (wallet_type === 'p2tr') {
      address = bitcoinjs.payments.p2tr({
        internalPubkey: Buffer.from(xOnly),
        network: getBitcoinNetwork(),
      }).address
    }
  }
  catch (e) {
    console.error('Failed to derive address from pubkey', e)
    throw new Error('Failed to derive address from pubkey.')
  }
  if (!address) {
    throw new Error('Failed to derive address from pubkey.')
  }
  const network = localWalletStorage.get(NETWORK_KEY) as string
  return {
    xOnly: Buffer.from(xOnly),
    keyPair,
    network:
      network === 'mainnet'
        ? bitcoinjs.networks.bitcoin
        : network === 'testnet'
          ? bitcoinjs.networks.testnet
          : bitcoinjs.networks.regtest,
    address,
    signer: {
      publicKey: Buffer.from(keyPair.publicKey),
      sign: (hash: Buffer) => Buffer.from(keyPair.sign(hash)),
      signSchnorr: (hash: Buffer) => Buffer.from(keyPair.signSchnorr!(hash)),
      getPublicKey: () => Buffer.from(keyPair.publicKey),
      network,
    },
    tweakedSigner: {
      publicKey: Buffer.from(tweakedKeyPair.publicKey),
      sign: (hash: Buffer) => {
        return Buffer.from(tweakedKeyPair.signSchnorr!(hash))
      },
      signSchnorr: (hash: Buffer) => {
        return Buffer.from(tweakedKeyPair.signSchnorr!(hash))
      },
      getPublicKey: () => Buffer.from(tweakedKeyPair.publicKey),
      network,
    },
    walletType: localWalletStorage.get(WALLET_TYPE_KEY) as LocalWalletType,
  }
}

/**
 *
 */
export async function getWalletNetwork(): Promise<string> {
  const network = localWalletStorage.get(NETWORK_KEY)
  if (network)
    return network as string
  return 'mainnet'
}

/**
 *
 */
export async function getWallets(): Promise<BISWallet[]> {
  await checkNetwork()

  const wallet_info = await getWalletInfo()
  if (!wallet_info)
    throw new Error('No private key found.')

  const wallets = [
    {
      address: wallet_info.address,
      pubkey: wallet_info.keyPair.publicKey.toString(),
      purpose: 'all',
    } as BISWallet,
  ]

  return wallets
}

/**
 *
 * @param message
 */
export async function signMessage(message: string): Promise<string> {
  await checkNetwork()

  try {
    const wallet_info = await getWalletInfo()
    if (!wallet_info)
      throw new Error('No private key found.')

    if (wallet_info.walletType === 'p2wpkh' || wallet_info.walletType === 'p2tr') {
      const signature = Buffer.from(
        BIP322Signer.sign(wallet_info.keyPair.toWIF(), wallet_info.address, message),
        'base64',
      ).toString('hex')

      return signature
    }

    throw new Error('Unsupported wallet type.')
  }
  catch (e) {
    // Log
    console.error('Failed to sign message', e)

    throw new Error('Failed to sign message.')
  }
}

/**
 *
 * @param message
 */
export async function signMessageDeterministic(
  message: string,
): Promise<{ signature: string, address: string }> {
  await checkNetwork()

  const wallet_info = await getWalletInfo()
  if (!wallet_info)
    throw new Error('No payment wallet found.')
  const address = wallet_info.address

  try {
    if (wallet_info.walletType === 'p2wpkh' || wallet_info.walletType === 'p2tr') {
      const response = bitcoinMessage
        .sign(message, Buffer.from(wallet_info.keyPair.privateKey!), wallet_info.keyPair.compressed)
        .toString('base64')

      return {
        signature: Buffer.from(response, 'base64').toString('hex'),
        address,
      }
    }

    throw new Error('Unsupported wallet type.')
  }
  catch (e) {
    // Log
    console.error('Failed to sign message', e)

    throw new Error('Failed to sign message.')
  }
}

/**
 *
 * @param psbtBase64
 * @param broadcast
 * @param inputsToSign
 */
export async function signPSBT(psbtBase64: string, broadcast: boolean, inputsToSign: any[]) {
  // Check extension and network
  await checkNetwork()

  const wallet_info = await getWalletInfo()
  if (!wallet_info)
    throw new Error('No private key found.')

  // convert psbtBase64 to hex
  const psbt = bitcoinjs.Psbt.fromBase64(psbtBase64)
  let signed_psbt = null
  if (inputsToSign.length === 0) {
    if (wallet_info.walletType === 'p2wpkh') {
      signed_psbt = psbt.signAllInputs(wallet_info.signer)
    }
    else if (wallet_info.walletType === 'p2tr') {
      signed_psbt = psbt.signAllInputs(wallet_info.tweakedSigner!)
    }
    else {
      throw new Error('Unsupported wallet type.')
    }
  }
  else {
    for (const input of inputsToSign) {
      for (let i = 0; i < input.signingIndexes.length; i++) {
        if (input.useTweakedSigner && wallet_info.walletType === 'p2tr') {
          if (!wallet_info.tweakedSigner) {
            throw new Error('Tweaked signer not found for taproot wallet.')
          }
          psbt.signInput(input.signingIndexes[i], wallet_info.tweakedSigner!)
        }
        else {
          psbt.signInput(input.signingIndexes[i], wallet_info.signer)
        }
      }
    }
  }

  signed_psbt = psbt.toHex()

  if (broadcast) {
    broadcast_txes([psbt.toHex()])
  }
  return signed_psbt
}

/**
 *
 * @param unsigned_psbt_hex
 * @param payment_addr
 * @param ord_addr
 * @param ord_addr_idxes
 * @param use_tweak_signer_idxes
 * @param no_sign_idxes
 */
export async function sign(
  unsigned_psbt_hex: string,
  payment_addr: string,
  ord_addr: string,
  ord_addr_idxes: number[],
  use_tweak_signer_idxes?: number[],
  no_sign_idxes?: number[],
): Promise<SignResponse> {
  let signed = null

  if (!payment_addr) {
    signed = await signPSBT(hexToBase64(unsigned_psbt_hex), false, [])
  }
  else {
    const psbt = bitcoinjs.Psbt.fromHex(unsigned_psbt_hex)
    const ins_to_sign = []
    const use_tweak_signer_payment = []
    const use_tweak_signer_ord = []
    for (let i = 0; i < psbt.inputCount; i++) {
      if (no_sign_idxes && no_sign_idxes.includes(i))
        continue
      if (ord_addr_idxes.includes(i)) {
        if (use_tweak_signer_idxes && use_tweak_signer_idxes.includes(i)) {
          use_tweak_signer_ord.push(true)
        }
        else if (use_tweak_signer_idxes) {
          use_tweak_signer_ord.push(false)
        }
        continue
      }
      ins_to_sign.push(i)
      if (use_tweak_signer_idxes && use_tweak_signer_idxes.includes(i)) {
        use_tweak_signer_payment.push(true)
      }
      else if (use_tweak_signer_idxes) {
        use_tweak_signer_payment.push(false)
      }
    }
    signed = await signPSBT(hexToBase64(unsigned_psbt_hex), false, [
      {
        address: payment_addr,
        signingIndexes: ins_to_sign,
        useTweakedSigner: use_tweak_signer_payment,
      },
      {
        address: ord_addr,
        signingIndexes: ord_addr_idxes,
        useTweakedSigner: use_tweak_signer_ord,
      },
    ])
  }

  const signed_psbt = bitcoinjs.Psbt.fromHex(signed)
  try {
    for (let i = 0; i < signed_psbt.inputCount; i++) {
      if (no_sign_idxes && no_sign_idxes.includes(i))
        continue
      signed_psbt.finalizeInput(i)
    }
  }
  catch (e) {
    console.error('Cannot finalize inputs')
    console.error(e)
  }

  const signed_tx = signed_psbt.extractTransaction()
  const signed_tx_hex = signed_tx.toHex()

  return {
    txid: signed_tx.getId(),
    signed_tx_hex,
  }
}

/**
 *
 * @param _amountSats
 * @param _toAddress
 */
export function sendBTC(
  _amountSats: string,
  _toAddress: string,
): string | PromiseLike<string | undefined> | undefined {
  throw new Error('Send BTC not supported.')
}
