import type { BISWallet } from '../api/wallet'
import type { BISWalletPurpose } from '../types/common'
import type { BISProvider, SignPsbtRequest, SignResponse } from './api'
import { Buffer } from 'node:buffer'
import * as bitcoinjs from 'bitcoinjs-lib'
import { getNetwork, getPaymentWallet } from '../core/bis'
import { createUnsecuredToken, finalizePsbtInputs, hexToBase64 } from '../core/helpers'

/*
 * PROVIDER: Xverse
 * NOTE: use window.XverseProviders.BitcoinProvider instead of window.BitcoinProvider
 */

// @ts-expect-error not in use
// eslint-disable-next-line unused-imports/no-unused-vars
function isInstalled() {
  return typeof window.XverseProviders?.BitcoinProvider !== 'undefined'
}

function getNetworkType() {
  const bisNetwork = getNetwork()

  if (bisNetwork === 'mainnet') return 'Mainnet'
  else if (bisNetwork === 'testnet') return 'Testnet4'
  else if (bisNetwork === 'signet') return 'Signet'

  throw new Error('Unknown BTC network type.')
}

async function getWallets(): Promise<BISWallet[]> {
  if (!window.XverseProviders?.BitcoinProvider) throw new Error('Xverse extension not found.')

  const request = createUnsecuredToken({
    purposes: ['ordinals', 'payment'],
    message: '[Best in Slot] wants to know your addresses!',
    network: {
      type: getNetworkType(),
    },
  })

  const data = await window.XverseProviders.BitcoinProvider?.connect(request)

  if (!data) throw new Error('Error fetching wallet data.')

  const wallets = data.addresses.map((addr: any) => {
    return {
      address: addr.address,
      pubkey: addr.publicKey,
      purpose: addr.purpose,
    } as BISWallet
  })

  return wallets
}

async function signMessage(
  message: string,
  _walletType: BISWalletPurpose,
  address: string
): Promise<string> {
  if (!window.XverseProviders?.BitcoinProvider) throw new Error('Xverse extension not found.')

  const request = createUnsecuredToken({
    address,
    message,
    protocol: 'BIP322',
    network: {
      type: getNetworkType(),
    },
  })

  const response = await window.XverseProviders.BitcoinProvider.signMessage(request).catch(
    (e: any) => {
      console.error('Failed to sign message.', e)

      throw new Error('Failed to sign message.')
    }
  )

  return Buffer.from(response, 'base64').toString('hex')
}

async function signMessageDeterministic(
  message: string
): Promise<{ signature: string; address: string }> {
  if (!window.XverseProviders?.BitcoinProvider) throw new Error('Xverse extension not found.')

  const wallet = getPaymentWallet()
  if (!wallet) throw new Error('No payment wallet found.')
  const address = wallet.address

  const request = createUnsecuredToken({
    address,
    message,
    protocol: 'ECDSA',
    network: {
      type: getNetworkType(),
    },
  })

  const response = await window.XverseProviders.BitcoinProvider.signMessage(request).catch(
    (e: any) => {
      console.error('Failed to sign message.', e)

      throw new Error('Failed to sign message.')
    }
  )

  return {
    signature: Buffer.from(response, 'base64').toString('hex'),
    address,
  }
}

async function sendBTC(amountSats: number, toAddress: string): Promise<string> {
  if (!window.XverseProviders?.BitcoinProvider) throw new Error('Xverse extension not found.')

  const response = await window.XverseProviders.BitcoinProvider.request('sendTransfer', {
    recipients: [
      {
        address: toAddress,
        amount: amountSats,
      },
    ],
  })

  return response.result.txid
}

async function signPSBT(
  psbtBase64: string,
  broadcast: boolean,
  inputsToSign: any[],
  message?: string
) {
  if (!window.XverseProviders?.BitcoinProvider) throw new Error('Xverse extension not found.')

  const request = createUnsecuredToken({
    network: {
      type: getNetworkType(),
    },
    message: message || 'Sign Transaction',
    psbtBase64,
    broadcast,
    inputsToSign,
  })

  const response = await window.XverseProviders.BitcoinProvider.signTransaction(request)

  return response
}

/** Xverse's inputs to sign for a `sign` request. */
function inputsToSignOf(request: SignPsbtRequest): any[] {
  const { unsignedPsbtHex, paymentAddr, ordAddr, ordAddrIdxes, noSignIdxes } = request
  const psbt = bitcoinjs.Psbt.fromHex(unsignedPsbtHex)
  const inscriptionsToSign = []
  for (let i = 0; i < psbt.inputCount; i++) {
    if (noSignIdxes && noSignIdxes.includes(i)) continue
    if (ordAddrIdxes.includes(i)) continue
    inscriptionsToSign.push(i)
  }
  return [
    {
      address: paymentAddr,
      signingIndexes: inscriptionsToSign,
      sigHash: bitcoinjs.Transaction.SIGHASH_DEFAULT,
    },
    {
      address: ordAddr,
      signingIndexes: ordAddrIdxes,
      sigHash: bitcoinjs.Transaction.SIGHASH_DEFAULT,
    },
  ]
}

function signedResponse(signedPsbtBase64: string, noSignIdxes?: number[]): SignResponse {
  const signedPsbt = bitcoinjs.Psbt.fromBase64(signedPsbtBase64)
  finalizePsbtInputs(signedPsbt, noSignIdxes)
  const signedTx = signedPsbt.extractTransaction()
  return { txId: signedTx.getId(), signedTxHex: signedTx.toHex() }
}

async function sign(
  unsignedPsbtHex: string,
  paymentAddr: string,
  ordAddr: string,
  ordAddrIndexes: number[],
  _useTweakedSignerIndexes?: number[], // not used in Xverse
  noSignIndexes?: number[]
): Promise<SignResponse> {
  const signed = await signPSBT(
    hexToBase64(unsignedPsbtHex),
    false,
    inputsToSignOf({
      unsignedPsbtHex,
      paymentAddr,
      ordAddr,
      ordAddrIdxes: ordAddrIndexes,
      noSignIdxes: noSignIndexes,
    }),
    'sign this pls'
  )
  return signedResponse(signed.psbtBase64, noSignIndexes)
}

async function signMany(requests: SignPsbtRequest[]): Promise<SignResponse[]> {
  const provider = window.XverseProviders?.BitcoinProvider
  if (typeof provider?.signMultipleTransactions !== 'function')
    throw new Error('Xverse cannot sign several PSBTs at once.')
  const request = createUnsecuredToken({
    network: { type: getNetworkType() },
    message: 'Sign Transactions',
    psbts: requests.map(r => ({
      psbtBase64: hexToBase64(r.unsignedPsbtHex),
      inputsToSign: inputsToSignOf(r),
    })),
  })
  const signed: { psbtBase64: string }[] = await provider.signMultipleTransactions(request)
  if (signed.length !== requests.length) throw new Error('Xverse returned the wrong PSBT count.')
  return signed.map((s, i) => signedResponse(s.psbtBase64, requests[i]!.noSignIdxes))
}

function getSignMany() {
  return typeof window !== 'undefined' &&
    typeof window.XverseProviders?.BitcoinProvider?.signMultipleTransactions === 'function'
    ? signMany
    : null
}

export const XVERSE: BISProvider = {
  getWallets,
  signMessage,
  signMessageDeterministic,
  sendBTC,
  signPSBT,
  sign,
  getSignMany,
}
