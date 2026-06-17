import type { BISWallet } from '../types/common'
import type { BISProvider, SignResponse } from './api'
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
  if (!window.unisat)
    throw new Error('UniSat not found.')

  // Check network
  const nw = await window.unisat.getNetwork() // testnet | livenet
  const bisNetwork = getNetwork()

  // Switch network
  if (nw !== 'livenet' && bisNetwork === 'mainnet')
    await window.unisat.switchNetwork('livenet')
  else if (nw === 'livenet' && (bisNetwork === 'testnet' || bisNetwork === 'signet'))
    await window.unisat.switchNetwork('testnet')
}

async function getWallets(): Promise<BISWallet[]> {
  // Check extension and network
  await checkNetwork()

  const accounts = await window.unisat?.requestAccounts()
  const pubkey = await window.unisat?.getPublicKey()

  if (!accounts)
    throw new Error('Failed to get wallets.')

  const wallets = accounts.map((account) => {
    return {
      address: account,
      pubkey,
      purpose: 'all',
    } as BISWallet
  })

  return wallets
}

async function signMessage(message: string): Promise<string> {
  // Check extension and network
  await checkNetwork()

  try {
    const response = await window.unisat!.signMessage(message, 'bip322-simple')

    return Buffer.from(response, 'base64').toString('hex')
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
  // Check extension and network
  await checkNetwork()

  const wallet = getPaymentWallet()
  if (!wallet)
    throw new Error('No payment wallet found.')
  const address = wallet.address

  try {
    const response = await window.unisat!.signMessage(message, 'ecdsa')

    return {
      signature: Buffer.from(response, 'base64').toString('hex'),
      address,
    }
  }
  catch (e) {
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
  }
  catch (e) {
    // Log
    console.error('Failed to send BTC', e)

    throw new Error('Failed to send BTC.')
  }
}

async function signPSBT(psbtBase64: string, broadcast: boolean, inputsToSign: any[]) {
  // Check extension and network
  await checkNetwork()

  //
  if (!window.unisat)
    throw new Error('UniSat not found.')

  // convert psbtBase64 to hex
  const psbt = base64ToHex(psbtBase64)
  let signedPsbt = null
  if (inputsToSign.length === 0) {
    signedPsbt = await window.unisat.signPsbt(psbt) // hex result
  }
  else {
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
    const options = {
      autoFinalized: true,
      toSignInputs,
    }
    signedPsbt = await window.unisat.signPsbt(psbt, options) // hex result
  }

  if (broadcast) {
    signedPsbt = await window.unisat.pushPsbt(signedPsbt)
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

export const UNISAT: BISProvider = {
  checkNetwork,
  getWallets,
  signMessage,
  signMessageDeterministic,
  sendBTC,
  signPSBT,
  sign,
}
