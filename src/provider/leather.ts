import type { BISWallet, BISWalletPurpose } from '../types/common'
import type { BISProvider, SignResponse } from './api'
import { Buffer } from 'node:buffer'
import * as bitcoinjs from 'bitcoinjs-lib'
import { getNetwork } from '../core/bis'
import { base64ToHex, hexToBase64 } from '../core/helpers'

// @ts-expect-error not in use
// eslint-disable-next-line unused-imports/no-unused-vars
function isInstalled() {
  return typeof window.LeatherProvider !== 'undefined'
}

async function getWallets(): Promise<BISWallet[]> {
  // Check if Leather is available
  if (!window.LeatherProvider)
    throw new Error('Leather extension not found.')

  const response = await window.LeatherProvider.request('getAddresses')

  if (!response)
    throw new Error('Failed to get wallets.')

  const wallets = (
    response.result.addresses as Array<{ address: string, publicKey: string, type: string }>
  ).map((address: { address: string, publicKey: string, type: string }): BISWallet => {
    return {
      address: address.address,
      pubkey: address.publicKey || null,
      purpose: address.type === 'p2wpkh' ? 'payment' : address.type === 'p2tr' ? 'ordinals' : 'stx',
    } as BISWallet
  })

  return wallets
}

async function signMessage(message: string, walletType: BISWalletPurpose): Promise<string> {
  // Check if Leather is available
  if (!window.LeatherProvider)
    throw new Error('Leather extension not found.')

  if (!walletType)
    throw new Error('Wallet type is required for signing messages with Leather.')

  try {
    // Request signature
    const response = await window.LeatherProvider.request('signMessage', {
      message,
      paymentType: walletType === 'ordinals' ? 'p2tr' : 'p2wpkh',
      network: getNetwork(),
    })

    return Buffer.from(response.result.signature, 'base64').toString('hex')
  }
  catch (error: any) {
    throw new Error(`Failed to sign message: ${error.message}`)
  }
}
async function signMessageDeterministic(
  message: string,
): Promise<{ signature: string, address: string }> {
  // Check if Leather is available
  if (!window.LeatherProvider)
    throw new Error('Leather extension not found.')

  try {
    // Request signature
    const response = await window.LeatherProvider.request('signMessage', {
      message,
      paymentType: 'p2wpkh',
      network: getNetwork(),
    })

    return {
      signature: Buffer.from(response.result.signature, 'base64').toString('hex'),
      address: response.result.address,
    }
  }
  catch (error: any) {
    throw new Error(`Failed to sign message: ${error.message}`)
  }
}

async function sendBTC(amountSats: string, toAddress: string): Promise<string> {
  // Check if Leather is available
  if (!window.LeatherProvider)
    throw new Error('Leather extension not found.')

  try {
    const response = await window.LeatherProvider.request('sendTransfer', {
      recipients: [
        {
          address: toAddress,
          amount: amountSats,
        },
      ],
      network: getNetwork(),
    })

    return response.result.txid
  }
  catch (error: any) {
    throw new Error(`Failed to send BTC: ${error.message}`)
  }
}

async function signPSBT(psbtBase64: string, broadcast: boolean, inputsToSign: any[]) {
  // Check if Leather is available
  if (!window.LeatherProvider)
    throw new Error('Leather extension not found.')

  const inscriptionToSign = []
  for (let i = 0; i < inputsToSign.length; i++) {
    for (let j = 0; j < inputsToSign[i].signingIndexes.length; j++) {
      inscriptionToSign.push(inputsToSign[i].signingIndexes[j])
    }
  }
  const response = await window.LeatherProvider.request('signPsbt', {
    hex: base64ToHex(psbtBase64),
    network: getNetwork(),
    broadcast,
    signAtIndex: inscriptionToSign,
  })

  return (response.result as unknown as { hex: string })?.hex ?? ''
}

async function sign(
  unsignedPsbtHex: string,
  paymentAddr: string,
  ordAddr: string,
  ordAddrIdxes: number[],
  _useTweakSignerIdxes: number[] | undefined, // not used in Leather
  noSignIdxes?: number[],
): Promise<SignResponse> {
  const psbt = bitcoinjs.Psbt.fromHex(unsignedPsbtHex)
  const inscriptionToSign = []
  for (let i = 0; i < psbt.inputCount; i++) {
    if (noSignIdxes && noSignIdxes.includes(i))
      continue
    if (ordAddrIdxes.includes(i))
      continue
    inscriptionToSign.push(i)
  }
  const signed = await signPSBT(hexToBase64(unsignedPsbtHex), false, [
    {
      address: paymentAddr,
      signingIndexes: inscriptionToSign,
      sigHash: bitcoinjs.Transaction.SIGHASH_DEFAULT,
    },
    {
      address: ordAddr,
      signingIndexes: ordAddrIdxes,
      sigHash: bitcoinjs.Transaction.SIGHASH_DEFAULT,
    },
  ])

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

export const LEATHER: BISProvider = {
  getWallets,
  signMessage,
  signMessageDeterministic,
  sendBTC,
  signPSBT,
  sign,
}
