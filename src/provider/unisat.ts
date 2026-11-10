import type { BISWallet } from '../types/common'
import type { BISProvider, SignPsbtRequest, SignResponse } from './api'
import { Buffer } from 'node:buffer'
import * as bitcoinjs from 'bitcoinjs-lib'
import { getNetwork } from '../core/bis'
import { base64ToHex, finalizePsbtInputs, hexToBase64 } from '../core/helpers'
import { getPaymentWallet } from '../core/providers'

// @ts-expect-error not in use
// eslint-disable-next-line unused-imports/no-unused-vars
function isInstalled() {
  return typeof window.unisat !== 'undefined'
}

async function checkNetwork() {
  // Check UniSat extension
  if (!window.unisat) throw new Error('UniSat not found.')

  // Check network
  const nw = await window.unisat.getNetwork() // testnet | livenet
  const bisNetwork = getNetwork()

  // Switch network
  if (nw !== 'livenet' && bisNetwork === 'mainnet') await window.unisat.switchNetwork('livenet')
  else if (nw === 'livenet' && (bisNetwork === 'testnet' || bisNetwork === 'signet'))
    await window.unisat.switchNetwork('testnet')
}

async function getWallets(): Promise<BISWallet[]> {
  // Check extension and network
  await checkNetwork()

  const accounts = await window.unisat?.requestAccounts()
  const pubkey = await window.unisat?.getPublicKey()

  if (!accounts) throw new Error('Failed to get wallets.')

  const wallets = accounts.map(account => {
    return {
      address: account,
      pubkey,
      purpose: 'all',
    } as BISWallet
  })

  return wallets
}

async function getAccounts(): Promise<string[]> {
  if (typeof window.unisat?.getAccounts !== 'function') return []

  return (await window.unisat.getAccounts()) ?? []
}

function onAccountsChanged(handler: (accounts: string[]) => void): () => void {
  const unisat = window.unisat
  if (!unisat?.on) return () => {}

  const listener = (accounts: string[]) => handler(accounts ?? [])
  unisat.on('accountsChanged', listener)
  return () => unisat.removeListener?.('accountsChanged', listener)
}

async function signMessage(message: string): Promise<string> {
  // Check extension and network
  await checkNetwork()

  try {
    const response = await window.unisat!.signMessage(message, 'bip322-simple')

    return Buffer.from(response, 'base64').toString('hex')
  } catch (e) {
    // Log
    console.error('Failed to sign message', e)

    throw new Error('Failed to sign message.')
  }
}

async function signMessageDeterministic(
  message: string
): Promise<{ signature: string; address: string }> {
  // Check extension and network
  await checkNetwork()

  const wallet = getPaymentWallet()
  if (!wallet) throw new Error('No payment wallet found.')
  const address = wallet.address

  try {
    const response = await window.unisat!.signMessage(message, 'ecdsa')

    return {
      signature: Buffer.from(response, 'base64').toString('hex'),
      address,
    }
  } catch (e) {
    // Log
    console.error('Failed to sign message', e)

    throw new Error('Failed to sign message.')
  }
}

async function sendBTC(amountSats: number, toAddress: string): Promise<string> {
  // Check extension and network
  await checkNetwork()

  try {
    const response = await window.unisat!.sendBitcoin(toAddress, amountSats)

    return response
  } catch (e) {
    // Log
    console.error('Failed to send BTC', e)

    throw new Error('Failed to send BTC.')
  }
}

async function signPSBT(psbtBase64: string, broadcast: boolean, inputsToSign: any[]) {
  // Check extension and network
  await checkNetwork()

  //
  if (!window.unisat) throw new Error('UniSat not found.')

  // convert psbtBase64 to hex
  const psbt = base64ToHex(psbtBase64)
  let signedPsbt = null
  if (inputsToSign.length === 0) {
    signedPsbt = await window.unisat.signPsbt(psbt) // hex result
  } else {
    signedPsbt = await window.unisat.signPsbt(psbt, signOptions(inputsToSign)) // hex result
  }

  if (broadcast) {
    signedPsbt = await window.unisat.pushPsbt(signedPsbt)
  }
  return signedPsbt
}

/** UniSat's `signPsbt` options for `signPSBT`-style inputs to sign. */
function signOptions(inputsToSign: any[]) {
  const toSignInputs = []
  for (const input of inputsToSign) {
    for (let i = 0; i < input.signingIndexes.length; i++) {
      toSignInputs.push({
        address: input.address,
        index: input.signingIndexes[i],
        useTweakedSigner: input.useTweakedSigner ? input.useTweakedSigner[i] : undefined,
      })
    }
  }
  return { autoFinalized: true, toSignInputs }
}

/** The `signPSBT` inputs to sign for a `sign` request; empty to let UniSat pick them. */
function inputsToSignOf(request: SignPsbtRequest): any[] {
  const { unsignedPsbtHex, paymentAddr, ordAddr, ordAddrIdxes, useTweakSignerIdxes, noSignIdxes } =
    request
  if (!paymentAddr) return []
  const psbt = bitcoinjs.Psbt.fromHex(unsignedPsbtHex)
  const insToSign = []
  const useTweakSignerPayment = []
  const useTweakSignerOrd = []
  for (let i = 0; i < psbt.inputCount; i++) {
    if (noSignIdxes && noSignIdxes.includes(i)) continue
    if (ordAddrIdxes.includes(i)) {
      if (useTweakSignerIdxes && useTweakSignerIdxes.includes(i)) {
        useTweakSignerOrd.push(true)
      } else if (useTweakSignerIdxes) {
        useTweakSignerOrd.push(false)
      }
      continue
    }
    insToSign.push(i)
    if (useTweakSignerIdxes && useTweakSignerIdxes.includes(i)) {
      useTweakSignerPayment.push(true)
    } else if (useTweakSignerIdxes) {
      useTweakSignerPayment.push(false)
    }
  }
  return [
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
  useTweakSignerIdxes?: number[],
  noSignIdxes?: number[]
): Promise<SignResponse> {
  const inputsToSign = inputsToSignOf({
    unsignedPsbtHex,
    paymentAddr,
    ordAddr,
    ordAddrIdxes,
    useTweakSignerIdxes,
    noSignIdxes,
  })
  const signed = await signPSBT(hexToBase64(unsignedPsbtHex), false, inputsToSign)
  return signedResponse(signed, noSignIdxes)
}

async function signMany(requests: SignPsbtRequest[]): Promise<SignResponse[]> {
  await checkNetwork()
  if (!window.unisat?.signPsbts) throw new Error('UniSat cannot sign several PSBTs at once.')
  const signed = await window.unisat.signPsbts(
    requests.map(r => r.unsignedPsbtHex),
    requests.map(r => signOptions(inputsToSignOf(r)))
  )
  if (signed.length !== requests.length) throw new Error('UniSat returned the wrong PSBT count.')
  return signed.map((hex, i) => signedResponse(hex, requests[i]!.noSignIdxes))
}

function getSignMany() {
  return typeof window !== 'undefined' && typeof window.unisat?.signPsbts === 'function'
    ? signMany
    : null
}

export const UNISAT: BISProvider = {
  checkNetwork,
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
