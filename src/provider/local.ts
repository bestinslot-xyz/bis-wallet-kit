import type { Network, Signer } from 'bitcoinjs-lib'
import type { ECPairInterface } from 'ecpair'
import type { BISNetwork, BISWallet } from '../types/common'
import type { BISProvider, SignResponse } from './api'
import { Buffer } from 'node:buffer'
import { Signer as BIP322Signer } from 'bip322-js'
import * as bitcoinjs from 'bitcoinjs-lib'
import * as bitcoinMessage from 'bitcoinjs-message'
import { ECPairFactory } from 'ecpair'
import * as tinysecp from 'tiny-secp256k1'
import { broadcastTxes, hexToBase64 } from '../core/helpers'
import { memoryStorage } from '../core/storage'
import { saveWalletInfo } from '../core/store'
import { getNetwork, setNetwork } from '../core/store-network'
import { getBitcoinNetwork } from '../lib/bitcoin'

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
): Promise<void> {
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

  const session = {
    provider: 'local' as const,
    wallets: [
      {
        address: walletInfo.address,
        pubkey: Buffer.from(walletInfo.keyPair.publicKey).toString('hex'),
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
  try {
    for (let i = 0; i < signedPsbt.inputCount; i++) {
      if (noSignIdxes && noSignIdxes.includes(i))
        continue
      signedPsbt.finalizeInput(i)
    }
  }
  catch (e) {
    console.error('Cannot finalize inputs')
    console.error(e)
  }

  const signedTx = signedPsbt.extractTransaction()
  const signedTxHex = signedTx.toHex()

  return {
    txId: signedTx.getId(),
    signedTxHex,
  }
}

/**
 * Sends Bitcoin (BTC) from the locally stored wallet to a specified address. The sendBTC function is currently not supported in this local provider implementation, and it throws an error indicating that sending BTC is not supported. This function is intended to allow users to send BTC directly from their locally stored wallet to another address, but due to the limitations of the local provider, this functionality is not available at this time. If there is a need for sending BTC in the future, this function can be implemented with the necessary logic to create and broadcast a transaction using the locally stored wallet information.
 *
 * @param _amountSats The amount of Bitcoin to be sent, specified in satoshis as a string. This parameter represents the quantity of BTC that the user intends to send from their locally stored wallet to the specified address. The amount should be provided in satoshis, which is the smallest unit of Bitcoin, where 1 BTC is equal to 100 million satoshis.
 * @param _toAddress The destination address to which the Bitcoin should be sent. This is the address of the recipient who will receive the BTC from the sender's locally stored wallet. The address should be a valid Bitcoin address that can receive funds on the appropriate network (mainnet, testnet, etc.) based on the wallet's network settings.
 *
 * @throws An error indicating that sending BTC is not supported in the local provider implementation. This is a placeholder function that can be implemented in the future if there is a need for sending BTC directly from the locally stored wallet, but currently it does not provide any functionality for creating or broadcasting transactions.
 */
function sendBTC(_amountSats: string, _toAddress: string): Promise<string> {
  throw new Error('Send BTC not supported.')
}

export const LOCAL: BISProvider = {
  getWallets,
  signMessage,
  signMessageDeterministic,
  sendBTC,
  signPSBT,
  sign,
}
