import type { BISWallet } from '../types/common'
import type { BISProvider, SignPsbtRequest, SignResponse } from './api'
import { Buffer } from 'node:buffer'
import * as bitcoinjs from 'bitcoinjs-lib'
import { getNetwork } from '../core/bis'
import { base64ToHex, finalizePsbtInputs, hexToBase64 } from '../core/helpers'
import { getPaymentWallet } from '../core/providers'

async function getWallets(): Promise<BISWallet[]> {
  if (!window.okxwallet) throw new Error('OKX extension not found.')

  const network = getNetwork()
  let data

  if (network === 'mainnet') data = await window.okxwallet.bitcoin.connect()
  else if (network === 'testnet') data = await window.okxwallet.bitcoinTestnet.connect()
  else if (network === 'signet') data = await window.okxwallet.bitcoinSignet.connect()
  else throw new Error('Unsupported network for OKX.')

  if (!data) throw new Error('Error fetching wallet data.')

  return [
    {
      address: data.address,
      pubkey: data.publicKey,
      purpose: 'all',
    },
  ]
}

// The OKX namespace for the current network. OKX exposes `getAccounts` and the
// `accountChanged` event on its mainnet namespace; callers feature-check before use.
function okxNamespace(): any {
  const network = getNetwork()
  if (network === 'mainnet') return window.okxwallet?.bitcoin
  if (network === 'testnet') return window.okxwallet?.bitcoinTestnet
  if (network === 'signet') return window.okxwallet?.bitcoinSignet
  return undefined
}

async function getAccounts(): Promise<string[]> {
  const okx = okxNamespace()
  if (typeof okx?.getAccounts !== 'function') return []

  return (await okx.getAccounts()) ?? []
}

function onAccountsChanged(handler: (accounts: string[]) => void): () => void {
  const okx = okxNamespace()
  if (typeof okx?.on !== 'function') return () => {}

  const listener = (info: { address?: string } | null) =>
    handler(info?.address ? [info.address] : [])
  okx.on('accountChanged', listener)
  return () => okx.removeListener?.('accountChanged', listener)
}

async function signMessage(message: string): Promise<string> {
  if (!window.okxwallet) throw new Error('OKX extension not found.')

  const network = getNetwork()
  let signedMessage

  if (network === 'mainnet')
    signedMessage = await window.okxwallet.bitcoin.signMessage(message, 'bip322-simple')
  else if (network === 'testnet')
    signedMessage = await window.okxwallet.bitcoinTestnet.signMessage(message, 'bip322-simple')
  else if (network === 'signet')
    signedMessage = await window.okxwallet.bitcoinSignet.signMessage(message, 'bip322-simple')
  else throw new Error('Unsupported network for OKX.')

  return Buffer.from(signedMessage, 'base64').toString('hex')
}

async function signMessageDeterministic(
  message: string
): Promise<{ signature: string; address: string }> {
  if (!window.okxwallet) throw new Error('OKX extension not found.')

  const wallet = getPaymentWallet()
  if (!wallet) throw new Error('No payment wallet found.')
  const address = wallet.address

  const network = getNetwork()
  let signedMessage

  if (network === 'mainnet')
    signedMessage = await window.okxwallet.bitcoin.signMessage(message, 'ecdsa')
  else if (network === 'testnet')
    signedMessage = await window.okxwallet.bitcoinTestnet.signMessage(message, 'ecdsa')
  else if (network === 'signet')
    signedMessage = await window.okxwallet.bitcoinSignet.signMessage(message, 'ecdsa')
  else throw new Error('Unsupported network for OKX.')

  return {
    signature: Buffer.from(signedMessage, 'base64').toString('hex'),
    address,
  }
}

async function sendBTC(amountSats: number, toAddress: string): Promise<string> {
  if (!window.okxwallet) throw new Error('OKX extension not found.')

  const network = getNetwork()
  let txId

  if (network === 'mainnet') {
    txId = await window.okxwallet.bitcoin.sendBitcoin(toAddress, amountSats)
  } else if (network === 'testnet') {
    txId = await window.okxwallet.bitcoinTestnet.sendBitcoin(toAddress, amountSats)
  } else if (network === 'signet') {
    txId = await window.okxwallet.bitcoinSignet.sendBitcoin(toAddress, amountSats)
  } else {
    throw new Error('Unsupported network for OKX.')
  }

  return txId
}

async function signPSBT(psbtBase64: string, broadcast: boolean, inputsToSign: any[]) {
  const psbt = base64ToHex(psbtBase64)

  let options = null
  if (inputsToSign.length !== 0) {
    const toSignInputs = []
    for (const input of inputsToSign) {
      for (let i = 0; i < input.signingIndexes.length; i++) {
        toSignInputs.push({
          address: input.address,
          index: input.signingIndexes[i],
          // disableTweakSigner: i == 0 ? true : false // TODO: remove this hack!!
        })
      }
    }
    options = {
      autoFinalized: true,
      toSignInputs,
    }
  }

  if (getNetwork() === 'mainnet') {
    let signedPsbtHex = null
    if (options) {
      signedPsbtHex = await window.okxwallet.bitcoin.signPsbt(psbt, options)
    } else {
      signedPsbtHex = await window.okxwallet.bitcoin.signPsbt(psbt)
    }
    if (broadcast) {
      await window.okxwallet.bitcoin.pushPsbt(signedPsbtHex)
    }
    return signedPsbtHex
  } else if (getNetwork() === 'testnet') {
    if (broadcast) {
      throw new Error('Cannot broadcast on testnet with okx')
    }
    let signedPsbtHex = null
    if (options) {
      signedPsbtHex = await window.okxwallet.bitcoinTestnet.signPsbt(psbt, options)
    } else {
      signedPsbtHex = await window.okxwallet.bitcoinTestnet.signPsbt(psbt)
    }
    return signedPsbtHex
  } else if (getNetwork() === 'signet') {
    if (broadcast) {
      throw new Error('Cannot broadcast on signet with okx')
    }
    let signedPsbtHex = null
    if (options) {
      signedPsbtHex = await window.okxwallet.bitcoinSignet.signPsbt(psbt, options)
    } else {
      signedPsbtHex = await window.okxwallet.bitcoinSignet.signPsbt(psbt)
    }
    return signedPsbtHex
  } else {
    throw new Error('Unsupported network for OKX.')
  }
}

/** The `signPSBT` inputs to sign for a `sign` request; empty to let OKX pick them. */
function inputsToSignOf(request: SignPsbtRequest): any[] {
  const { unsignedPsbtHex, paymentAddr, ordAddr, ordAddrIdxes, noSignIdxes } = request
  if (!paymentAddr) return []
  const psbt = bitcoinjs.Psbt.fromHex(unsignedPsbtHex)
  const insToSign = []
  for (let i = 0; i < psbt.inputCount; i++) {
    if (noSignIdxes && noSignIdxes.includes(i)) continue
    if (ordAddrIdxes.includes(i)) continue
    insToSign.push(i)
  }
  return [
    { address: paymentAddr, signingIndexes: insToSign },
    { address: ordAddr, signingIndexes: ordAddrIdxes },
  ]
}

function signedResponse(signedPsbtHex: string, noSignIdxes?: number[]): SignResponse {
  const signedPsbt = bitcoinjs.Psbt.fromHex(signedPsbtHex)
  finalizePsbtInputs(signedPsbt, noSignIdxes)
  const signedTx = signedPsbt.extractTransaction()
  return { txId: signedTx.getId(), signedTxHex: signedTx.toHex() }
}

async function sign(
  unsignedPsbtHex: string,
  paymentAddr: string,
  ordAddr: string,
  ordAddrIdxes: number[],
  _useTweakSignerIdxes?: number[], // not used in OKX
  noSignIdxes?: number[]
): Promise<SignResponse> {
  const inputsToSign = inputsToSignOf({
    unsignedPsbtHex,
    paymentAddr,
    ordAddr,
    ordAddrIdxes,
    noSignIdxes,
  })
  const signed = await signPSBT(hexToBase64(unsignedPsbtHex), false, inputsToSign)
  return signedResponse(signed, noSignIdxes)
}

/** The OKX provider object for the current network, or undefined when there is none. */
function networkProvider(): any {
  const network = getNetwork()
  if (network === 'mainnet') return window.okxwallet?.bitcoin
  if (network === 'testnet') return window.okxwallet?.bitcoinTestnet
  if (network === 'signet') return window.okxwallet?.bitcoinSignet
  return undefined
}

async function signMany(requests: SignPsbtRequest[]): Promise<SignResponse[]> {
  const provider = networkProvider()
  if (typeof provider?.signPsbts !== 'function')
    throw new Error('OKX cannot sign several PSBTs at once.')
  const signed: string[] = await provider.signPsbts(
    requests.map(r => r.unsignedPsbtHex),
    requests.map(r => {
      const toSignInputs = inputsToSignOf(r).flatMap(input =>
        input.signingIndexes.map((index: number) => ({ address: input.address, index }))
      )
      return toSignInputs.length > 0
        ? { autoFinalized: true, toSignInputs }
        : { autoFinalized: true }
    })
  )
  if (signed.length !== requests.length) throw new Error('OKX returned the wrong PSBT count.')
  return signed.map((hex, i) => signedResponse(hex, requests[i]!.noSignIdxes))
}

function getSignMany() {
  return typeof window !== 'undefined' && typeof networkProvider()?.signPsbts === 'function'
    ? signMany
    : null
}

export const OKX: BISProvider = {
  getWallets,
  getAccounts,
  onAccountsChanged,
  signMessage,
  signMessageDeterministic,
  sendBTC,
  signPSBT,
  sign,
  getSignMany,
}
