import type { Network, Signer } from 'bitcoinjs-lib'
import type { ECPairInterface } from 'ecpair'
import type { BISNetwork, BISWallet, BISWalletPurpose } from '../types/common'
import type { BISProvider, SignResponse } from './api'
import { Buffer } from 'node:buffer'
import { Signer as BIP322Signer } from 'bip322-js'
import * as bitcoinjs from 'bitcoinjs-lib'
import * as bitcoinMessage from 'bitcoinjs-message'
import { ECPairFactory } from 'ecpair'
import * as tinysecp from 'tiny-secp256k1'
import {
  broadcastTxes,
  finalizePsbtInputs,
  getCardinalUtxos,
  hexToBase64,
  validateTxes,
} from '../core/helpers'
import { buildPsbtFromTx, buildTransaction } from '../core/mint'
import { memoryStorage } from '../core/storage'
import { clearWalletInfo, saveWalletInfo } from '../core/store'
import { getNetwork, setNetwork } from '../core/store-network'
import { getBitcoinNetwork } from '../lib/bitcoin'
import { WalletInfo } from '../types/wallet'

// @ts-expect-error not in use
// eslint-disable-next-line unused-imports/no-unused-vars
function isInstalled() {
  return true
}

export type LocalWalletSource = 'unisat' | 'okx'
export type LocalWalletType = 'p2wpkh' | 'p2tr'

const LOCAL_WALLET_STORAGE = memoryStorage()

const PRIV_KEY = 'local_priv_key'
const NETWORK_KEY = 'local_network'
const WALLET_TYPE_KEY = 'local_wallet_type'
const SOURCE_KEY = 'local_source'

async function checkNetwork() {
  if (typeof window !== 'undefined') {
    throw new TypeError('Local provider is only available in Node.js environment.')
  }

  const bisNetwork = getNetwork()
  const walletNetwork = await getWalletNetwork()

  if (bisNetwork !== walletNetwork) {
    LOCAL_WALLET_STORAGE.remove(PRIV_KEY)
    LOCAL_WALLET_STORAGE.remove(NETWORK_KEY)
    throw new Error('Network mismatch. Please load the correct wallet.')
  }
}

/**
 * Saves the wallet information to memory. The saveWallet function takes the private key, network, wallet type, and source wallet as parameters and stores this information in the local wallet storage. It also updates the wallet's network setting and saves the wallet information using the saveWalletInfo function. This function is crucial for allowing users to store their wallet information locally and retrieve it later for signing messages or sending transactions. It includes error handling to ensure that only valid wallet types and sources are accepted, and it throws an error if there is an issue with saving the wallet information.
 *
 * @param privKeyWIF The private key of the wallet as a string in WIF format. This is the key that will be used for signing messages and transactions, and it should be kept secure and not shared with others.
 * @param network The network associated with the wallet, such as 'mainnet' or 'testnet'. This information is important for ensuring that the wallet is used on the correct blockchain network and for deriving the correct addresses and transaction formats.
 * @param walletType The type of wallet being saved, which can be either 'p2wpkh' (Pay-to-Witness-Public-Key-Hash) or 'p2tr' (Pay-to-Taproot). This determines the address format and signing method used by the wallet.
 * @param sourceWallet The source of the wallet, which can be either 'unisat' or 'okx'. This information can be used to identify where the wallet information originated from and may be useful for debugging or analytics purposes.
 *
 * @returns A promise that resolves when the wallet information has been successfully saved to memory. If there is an error during the saving process, such as an invalid wallet type or source, the function will throw an error with a descriptive message.
 */
export async function saveWallet(
  privKeyWIF: string,
  network: BISNetwork,
  walletType: LocalWalletType = 'p2wpkh',
  sourceWallet: LocalWalletSource = 'unisat',
): Promise<BISWallet> {
  if (walletType !== 'p2wpkh' && walletType !== 'p2tr') {
    throw new Error('Invalid wallet type. Supported types are p2wpkh and p2tr.')
  }

  if (sourceWallet !== 'unisat' && sourceWallet !== 'okx') {
    throw new Error('Invalid wallet source. Supported sources are unisat and okx.')
  }

  setNetwork(network)
  LOCAL_WALLET_STORAGE.set(PRIV_KEY, privKeyWIF)
  LOCAL_WALLET_STORAGE.set(NETWORK_KEY, network)
  LOCAL_WALLET_STORAGE.set(WALLET_TYPE_KEY, walletType)
  LOCAL_WALLET_STORAGE.set(SOURCE_KEY, sourceWallet)

  const walletInfo = await getWalletInfo()
  if (!walletInfo) {
    throw new Error('Failed to save wallet.')
  }

  const wallet = {
    address: walletInfo.address,
    pubkey: Buffer.from(walletInfo.keyPair.publicKey).toString('hex'),
    purpose: 'all' as BISWalletPurpose,
  }

  const session = {
    provider: 'local' as const,
    wallets: [wallet],
    signature: null,
  }

  saveWalletInfo(session)
  return wallet
}

/**
 * Generates a brand-new single-key Bitcoin wallet and connects it, returning
 * the private key alongside the derived address. This is the counterpart to
 * {@link saveWallet}: instead of importing an existing WIF, it produces a fresh
 * random key (via secp256k1) for the given network and wallet type, then loads
 * it through the same path so the returned address is guaranteed to re-import
 * to the same key. It is intended for headless agents that need to create a
 * fundable address on the fly.
 *
 * The wallet is a single (non-HD) key — there is no mnemonic or derivation
 * path. The returned WIF is the ONLY secret; the caller is solely responsible
 * for storing it. This function does not persist the key anywhere beyond the
 * in-memory session used by the current process.
 *
 * @param network The network the wallet is for, e.g. 'mainnet' or 'testnet'. This determines the WIF version and address format.
 * @param walletType The address type to derive, either 'p2wpkh' (default) or 'p2tr'.
 * @param sourceWallet The source label recorded for the session, either 'unisat' (default) or 'okx'.
 *
 * @returns A promise resolving to the connected wallet ({ address, pubkey, purpose }) plus the generated `wif` private key. Throws if the wallet type or source is invalid.
 */
export async function createWallet(
  network: BISNetwork,
  walletType: LocalWalletType = 'p2wpkh',
  sourceWallet: LocalWalletSource = 'unisat',
): Promise<BISWallet & { wif: string }> {
  if (walletType !== 'p2wpkh' && walletType !== 'p2tr') {
    throw new Error('Invalid wallet type. Supported types are p2wpkh and p2tr.')
  }

  if (sourceWallet !== 'unisat' && sourceWallet !== 'okx') {
    throw new Error('Invalid wallet source. Supported sources are unisat and okx.')
  }

  setNetwork(network)
  const keyPair = ECPairFactory(tinysecp).makeRandom({ network: getBitcoinNetwork() })
  const wif = keyPair.toWIF()
  const wallet = await saveWallet(wif, network, walletType, sourceWallet)
  return { ...wallet, wif }
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

async function getWalletInfo(): Promise<LocalWalletInfo | null> {
  const privkey = LOCAL_WALLET_STORAGE.get(PRIV_KEY)
  if (!privkey) {
    return null
  }
  const walletType = (LOCAL_WALLET_STORAGE.get(WALLET_TYPE_KEY) as LocalWalletType) || 'p2wpkh'
  const keyPair = ECPairFactory(tinysecp).fromWIF(privkey, getBitcoinNetwork())
  const xOnly = tinysecp.xOnlyPointFromPoint(keyPair.publicKey)
  const tweakedKeyPair = keyPair.tweak(bitcoinjs.crypto.taggedHash('TapTweak', Buffer.from(xOnly)))
  let address = null
  try {
    if (walletType === 'p2wpkh') {
      address = bitcoinjs.payments.p2wpkh({
        pubkey: Buffer.from(keyPair.publicKey),
        network: getBitcoinNetwork(),
      }).address
    }
    else if (walletType === 'p2tr') {
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
  const network = LOCAL_WALLET_STORAGE.get(NETWORK_KEY) as string
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
    walletType: LOCAL_WALLET_STORAGE.get(WALLET_TYPE_KEY) as LocalWalletType,
  }
}

async function getWalletNetwork(): Promise<string> {
  const network = LOCAL_WALLET_STORAGE.get(NETWORK_KEY)
  if (network)
    return network as string
  return 'mainnet'
}

async function getWallets(): Promise<BISWallet[]> {
  await checkNetwork()

  const walletInfo = await getWalletInfo()
  if (!walletInfo)
    throw new Error('No private key found.')

  const wallets = [
    {
      address: walletInfo.address,
      pubkey: walletInfo.keyPair.publicKey.toString(),
      purpose: 'all',
    } as BISWallet,
  ]

  return wallets
}

async function signMessage(message: string): Promise<string> {
  await checkNetwork()

  try {
    const walletInfo = await getWalletInfo()
    if (!walletInfo)
      throw new Error('No private key found.')

    if (walletInfo.walletType === 'p2wpkh' || walletInfo.walletType === 'p2tr') {
      const signature = Buffer.from(
        BIP322Signer.sign(walletInfo.keyPair.toWIF(), walletInfo.address, message),
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

async function signMessageDeterministic(
  message: string,
): Promise<{ signature: string, address: string }> {
  await checkNetwork()

  const walletInfo = await getWalletInfo()
  if (!walletInfo)
    throw new Error('No payment wallet found.')
  const address = walletInfo.address

  try {
    if (walletInfo.walletType === 'p2wpkh' || walletInfo.walletType === 'p2tr') {
      const response = bitcoinMessage
        .sign(message, Buffer.from(walletInfo.keyPair.privateKey!), walletInfo.keyPair.compressed)
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

async function signPSBT(psbtBase64: string, broadcast: boolean, inputsToSign: any[]) {
  await checkNetwork()

  const walletInfo = await getWalletInfo()
  if (!walletInfo)
    throw new Error('No private key found.')

  // convert psbtBase64 to hex
  const psbt = bitcoinjs.Psbt.fromBase64(psbtBase64)
  let signedPsbt = null
  if (inputsToSign.length === 0) {
    if (walletInfo.walletType === 'p2wpkh') {
      signedPsbt = psbt.signAllInputs(walletInfo.signer)
    }
    else if (walletInfo.walletType === 'p2tr') {
      signedPsbt = psbt.signAllInputs(walletInfo.tweakedSigner!)
    }
    else {
      throw new Error('Unsupported wallet type.')
    }
  }
  else {
    for (const input of inputsToSign) {
      for (let i = 0; i < input.signingIndexes.length; i++) {
        if (input.useTweakedSigner && walletInfo.walletType === 'p2tr') {
          if (!walletInfo.tweakedSigner) {
            throw new Error('Tweaked signer not found for taproot wallet.')
          }
          psbt.signInput(input.signingIndexes[i], walletInfo.tweakedSigner!)
        }
        else {
          psbt.signInput(input.signingIndexes[i], walletInfo.signer)
        }
      }
    }
  }

  signedPsbt = psbt.toHex()

  if (broadcast) {
    broadcastTxes([psbt.toHex()])
  }
  return signedPsbt
}

async function sign(
  unsignedPsbtHex: string,
  paymentAddr: string,
  ordAddr: string,
  ordAddrIdxes: number[],
  useTweakSignerIdxes?: number[],
  noSignIdxes?: number[],
): Promise<SignResponse> {
  let signed = null

  if (!paymentAddr) {
    signed = await signPSBT(hexToBase64(unsignedPsbtHex), false, [])
  }
  else {
    const psbt = bitcoinjs.Psbt.fromHex(unsignedPsbtHex)
    const insToSign = []
    const useTweakSignerPayment = []
    const useTweakSignerOrd = []
    for (let i = 0; i < psbt.inputCount; i++) {
      if (noSignIdxes && noSignIdxes.includes(i))
        continue
      if (ordAddrIdxes.includes(i)) {
        if (useTweakSignerIdxes && useTweakSignerIdxes.includes(i)) {
          useTweakSignerOrd.push(true)
        }
        else if (useTweakSignerIdxes) {
          useTweakSignerOrd.push(false)
        }
        continue
      }
      insToSign.push(i)
      if (useTweakSignerIdxes && useTweakSignerIdxes.includes(i)) {
        useTweakSignerPayment.push(true)
      }
      else if (useTweakSignerIdxes) {
        useTweakSignerPayment.push(false)
      }
    }
    signed = await signPSBT(hexToBase64(unsignedPsbtHex), false, [
      {
        address: paymentAddr,
        signingIndexes: insToSign,
        useTweakedSigner: useTweakSignerPayment,
      },
      {
        address: ordAddr,
        signingIndexes: ordAddrIdxes,
        useTweakedSigner: useTweakSignerOrd,
      },
    ])
  }

  const signedPsbt = bitcoinjs.Psbt.fromHex(signed)
  finalizePsbtInputs(signedPsbt, noSignIdxes)

  const signedTx = signedPsbt.extractTransaction()
  const signedTxHex = signedTx.toHex()

  return {
    txId: signedTx.getId(),
    signedTxHex,
  }
}

/**
 * Sends Bitcoin (BTC) from the locally stored wallet to a specified address. Unlike the
 * extension providers — which delegate to the wallet extension's own send flow — the local
 * provider builds, signs, and broadcasts the transaction in-process. It funds the send from
 * the wallet's cardinal (non-inscribed) UTXOs, selecting inputs and computing change back to
 * the wallet, then validates the transaction against the mempool before broadcasting.
 *
 * @param amountSats The amount of Bitcoin to send, in satoshis. Must be a positive integer.
 * @param toAddress The destination address. Must be valid for the wallet's current network.
 * @param feeRate The fee rate in satoshis per virtual byte (sat/vB). Required for the local provider (there is no fee estimator); throws if missing or not positive.
 *
 * @returns A promise resolving to the broadcasted transaction's id.
 * @throws If amountSats is not a positive integer, feeRate is missing/non-positive, there are not enough funds, or the transaction is rejected by the mempool.
 */
async function sendBTC(amountSats: number, toAddress: string, feeRate?: number): Promise<string> {
  if (!Number.isInteger(amountSats) || amountSats <= 0) {
    throw new Error('amountSats must be a positive integer (satoshis).')
  }

  if (feeRate == null || !Number.isFinite(feeRate) || feeRate <= 0) {
    throw new Error('feeRate (sat/vB) must be a positive number for the local wallet.')
  }

  await checkNetwork()

  const walletInfo = await getWalletInfo()
  if (!walletInfo) {
    throw new Error('No private key found.')
  }

  const payerAddress = walletInfo.address
  const payerPubkey = Buffer.from(walletInfo.keyPair.publicKey).toString('hex')
  const payerWallet = new WalletInfo(false, null, payerAddress, null, payerPubkey)
  const recipientWallet = new WalletInfo(false, null, toAddress, null, null)

  const cardinalUtxos = await getCardinalUtxos(payerAddress)

  const unsignedTxResp = buildTransaction(
    cardinalUtxos,
    [],
    payerWallet,
    [],
    recipientWallet,
    payerWallet,
    feeRate,
    amountSats,
    null,
    null,
  )

  const unsignedPsbt = await buildPsbtFromTx(unsignedTxResp.tx, cardinalUtxos, payerWallet, [])
  const signed = await sign(unsignedPsbt.toHex(), payerAddress, payerAddress, [])

  const isValid = await validateTxes([signed.signedTxHex])
  if (isValid == null) {
    throw new Error('Send BTC validation failed (testmempoolaccept request failed).')
  }
  for (const entry of isValid) {
    if (!entry.allowed) {
      throw new Error(entry['reject-reason'])
    }
  }

  const broadcastResult = await broadcastTxes([signed.signedTxHex])
  if (broadcastResult == null) {
    throw new Error('Failed to broadcast transaction.')
  }

  return signed.txId
}

/**
 * Locks the local (WIF) wallet by evicting all in-memory key material and
 * clearing the connected session. After calling this, no private key remains
 * resident in the process: `getSession()` returns `null`, and any subsequent
 * sign/send call will fail with "No private key found." until a wallet is
 * reconnected via {@link saveWallet} (`connectLocalWallet`) or {@link createWallet}.
 *
 * This is intended for callers (e.g. an MCP server) that want to hold a key
 * only for the duration of a single approved operation rather than keep it
 * resident for the life of the process.
 */
export function lockLocalWallet(): void {
  LOCAL_WALLET_STORAGE.remove(PRIV_KEY)
  LOCAL_WALLET_STORAGE.remove(NETWORK_KEY)
  LOCAL_WALLET_STORAGE.remove(WALLET_TYPE_KEY)
  LOCAL_WALLET_STORAGE.remove(SOURCE_KEY)
  clearWalletInfo()
}

export const LOCAL: BISProvider = {
  getWallets,
  signMessage,
  signMessageDeterministic,
  sendBTC,
  signPSBT,
  sign,
}
