import type { SignResponse } from '../core/providers'
import type { BISWallet } from '../main'
import { Buffer } from 'node:buffer'
import { getNetwork } from '../core/bis'
import { base64ToHex, hexToBase64 } from '../core/helpers'
import { bitcoinjs } from '../lib/bitcoin'

// @ts-expect-error not in use
// eslint-disable-next-line unused-imports/no-unused-vars
function isInstalled() {
  return typeof window.LeatherProvider !== 'undefined'
}

export async function getWallets(): Promise<BISWallet[]> {
  // Check if Leather is available
  if (!window.LeatherProvider)
    throw new Error('Leather extension not found.')

  const response = await window.LeatherProvider.request('getAddresses')

  if (!response)
    throw new Error('Failed to get wallets.')

  const wallets = (response.result.addresses as Array<{ address: string, publicKey: string, type: string }>)
    .map((address: { address: string, publicKey: string, type: string }): BISWallet => {
      return {
        address: address.address,
        pubkey: address.publicKey || null,
        purpose: (address.type === 'p2wpkh') ? 'payment' : (address.type === 'p2tr') ? 'ordinals' : 'stx',
      } as BISWallet
    })

  return wallets
}

export async function signMessage(message: string, wallet_type: 'ordinals' | 'payment'): Promise<string> {
  // Check if Leather is available
  if (!window.LeatherProvider)
    throw new Error('Leather extension not found.')

  try {
    // Request signature
    const response = await window.LeatherProvider.request('signMessage', {
      message,
      paymentType: wallet_type === 'ordinals' ? 'p2tr' : 'p2wpkh',
      network: getNetwork(),
    })

    return Buffer.from(response.result.signature, 'base64').toString('hex')
  }
  catch (error: any) {
    throw new Error(`Failed to sign message: ${error.message}`)
  }
}
export async function signMessageDeterministic(message: string): Promise<{ signature: string, address: string }> {
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

// returns txid
export async function sendBTC(amountSats: string, toAddress: string): Promise<string> {
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

export async function signPSBT(
  psbtBase64: string,
  broadcast: boolean,
  inputsToSign: any[],
) {
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

  return ((response.result as unknown) as { hex: string })?.hex ?? ''
}

export async function sign(
  unsigned_psbt_hex: string,
  payment_addr: string,
  ord_addr: string,
  ord_addr_idxes: number[],
  _use_tweak_signer_idxes?: number[], // not used in Leather
  no_sign_idxes?: number[],
): Promise<SignResponse> {
  const psbt = bitcoinjs.Psbt.fromHex(unsigned_psbt_hex)
  const inscriptionToSign = []
  for (let i = 0; i < psbt.inputCount; i++) {
    if (no_sign_idxes && no_sign_idxes.includes(i))
      continue
    if (ord_addr_idxes.includes(i))
      continue
    inscriptionToSign.push(i)
  }
  const signed = await signPSBT(hexToBase64(unsigned_psbt_hex), false, [
    {
      address: payment_addr,
      signingIndexes: inscriptionToSign,
      sigHash: bitcoinjs.Transaction.SIGHASH_DEFAULT,
    },
    {
      address: ord_addr,
      signingIndexes: ord_addr_idxes,
      sigHash: bitcoinjs.Transaction.SIGHASH_DEFAULT,
    },
  ])

  const signedPsbt = bitcoinjs.Psbt.fromHex(signed)
  try {
    for (let i = 0; i < signedPsbt.inputCount; i++) {
      if (no_sign_idxes && no_sign_idxes.includes(i))
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
    txid: signedTx.getId(),
    signed_tx_hex: signedTxHex,
  }
}
