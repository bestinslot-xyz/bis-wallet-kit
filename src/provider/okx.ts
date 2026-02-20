import type { SignResponse } from '../core/providers'
import type { BISWallet } from '../main'
import { Buffer } from 'node:buffer'
import * as bitcoinjs from 'bitcoinjs-lib'
import { getNetwork } from '../core/bis'
import { base64ToHex, hexToBase64 } from '../core/helpers'
import { getPaymentWallet } from '../core/providers'

/**
 * PROVIDER: OKX
 * NOTE: use window.okxwallet.bitcoin for mainnet, window.okxwallet.bitcoinTestnet for testnet, and window.okxwallet.bitcoinSignet for signet
 *
 * @returns An array of BISWallet objects representing the wallets available in the OKX extension. Each object contains the wallet's address, public key, and purpose (either 'ordinals', 'payment', or 'all').
 */
export async function getWallets(): Promise<BISWallet[]> {
  if (!window.okxwallet)
    throw new Error('OKX extension not found.')

  const network = getNetwork()
  let data

  if (network === 'mainnet')
    data = await window.okxwallet.bitcoin.connect()
  else if (network === 'testnet')
    data = await window.okxwallet.bitcoinTestnet.connect()
  else if (network === 'signet')
    data = await window.okxwallet.bitcoinSignet.connect()
  else throw new Error('Unsupported network for OKX.')

  if (!data)
    throw new Error('Error fetching wallet data.')

  return [
    {
      address: data.address,
      pubkey: data.publicKey,
      purpose: 'all',
    },
  ]
}

/**
 * Signs a message using the OKX wallet. This function uses the 'bip322-simple' signing scheme, which produces a non-deterministic signature. This is suitable for general message signing purposes, but if you need a deterministic signature (e.g. for signing a PSBT for minting an ordinal), you should use the signMessageDeterministic function instead.
 *
 * @param message - The message to be signed.
 * @returns A promise that resolves to the hexadecimal string of the signature.
 */
export async function signMessage(message: string): Promise<string> {
  if (!window.okxwallet)
    throw new Error('OKX extension not found.')

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
/**
 * Signs a message using the ECDSA scheme, which produces a deterministic signature. This is useful for cases where you want the same message to always produce the same signature, such as when signing a PSBT for minting an ordinal, where the signature needs to be verified locally before broadcasting.
 *
 * @param message - The message to be signed.
 * @returns A promise that resolves to an object containing the hexadecimal string of the signature and the address that was used to sign the message.
 * @throws An error if the OKX extension is not found, if no payment wallet is found, if the payment wallet does not have an address, or if the network is unsupported.
 */
export async function signMessageDeterministic(
  message: string,
): Promise<{ signature: string, address: string }> {
  if (!window.okxwallet)
    throw new Error('OKX extension not found.')

  const wallet = getPaymentWallet()
  if (!wallet)
    throw new Error('No payment wallet found.')
  const address = wallet.address

  const network = getNetwork()
  let signed_message

  if (network === 'mainnet')
    signed_message = await window.okxwallet.bitcoin.signMessage(message, 'ecdsa')
  else if (network === 'testnet')
    signed_message = await window.okxwallet.bitcoinTestnet.signMessage(message, 'ecdsa')
  else if (network === 'signet')
    signed_message = await window.okxwallet.bitcoinSignet.signMessage(message, 'ecdsa')
  else throw new Error('Unsupported network for OKX.')

  return {
    signature: Buffer.from(signed_message, 'base64').toString('hex'),
    address,
  }
}

// returns txid
/**
 *
 * @param amountSats
 * @param toAddress
 */
export async function sendBTC(amountSats: string, toAddress: string): Promise<string> {
  if (!window.okxwallet)
    throw new Error('OKX extension not found.')

  const network = getNetwork()
  let tx_id

  if (network === 'mainnet') {
    tx_id = await window.okxwallet.bitcoin.sendBitcoin(toAddress, Number.parseInt(amountSats))
  }
  else if (network === 'testnet') {
    tx_id = await window.okxwallet.bitcoinTestnet.sendBitcoin(
      toAddress,
      Number.parseInt(amountSats),
    )
  }
  else if (network === 'signet') {
    tx_id = await window.okxwallet.bitcoinSignet.sendBitcoin(toAddress, Number.parseInt(amountSats))
  }
  else {
    throw new Error('Unsupported network for OKX.')
  }

  return tx_id
}

/**
 *
 * @param psbtBase64
 * @param broadcast
 * @param inputsToSign
 */
export async function signPSBT(psbtBase64: string, broadcast: boolean, inputsToSign: any[]) {
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
    let signed_psbt_hex = null
    if (options) {
      signed_psbt_hex = await window.okxwallet.bitcoin.signPsbt(psbt, options)
    }
    else {
      signed_psbt_hex = await window.okxwallet.bitcoin.signPsbt(psbt)
    }
    if (broadcast) {
      await window.okxwallet.bitcoin.pushPsbt(signed_psbt_hex)
    }
    return signed_psbt_hex
  }
  else if (getNetwork() === 'testnet') {
    if (broadcast) {
      throw new Error('Cannot broadcast on testnet with okx')
    }
    let signed_psbt_hex = null
    if (options) {
      signed_psbt_hex = await window.okxwallet.bitcoinTestnet.signPsbt(psbt, options)
    }
    else {
      signed_psbt_hex = await window.okxwallet.bitcoinTestnet.signPsbt(psbt)
    }
    return signed_psbt_hex
  }
  else if (getNetwork() === 'signet') {
    if (broadcast) {
      throw new Error('Cannot broadcast on signet with okx')
    }
    let signed_psbt_hex = null
    if (options) {
      signed_psbt_hex = await window.okxwallet.bitcoinSignet.signPsbt(psbt, options)
    }
    else {
      signed_psbt_hex = await window.okxwallet.bitcoinSignet.signPsbt(psbt)
    }
    return signed_psbt_hex
  }
  else {
    throw new Error('Unsupported network for OKX.')
  }
}

/**
 *
 * @param unsigned_psbt_hex
 * @param payment_addr
 * @param ord_addr
 * @param ord_addr_idxes
 * @param _use_tweak_signer_idxes
 * @param no_sign_idxes
 */
export async function sign(
  unsigned_psbt_hex: string,
  payment_addr: string,
  ord_addr: string,
  ord_addr_idxes: number[],
  _use_tweak_signer_idxes?: number[], // not used in OKX
  no_sign_idxes?: number[],
): Promise<SignResponse> {
  let signed = null
  if (!payment_addr) {
    signed = await signPSBT(hexToBase64(unsigned_psbt_hex), false, [])
  }
  else {
    const psbt = bitcoinjs.Psbt.fromHex(unsigned_psbt_hex)
    const ins_to_sign = []
    for (let i = 0; i < psbt.inputCount; i++) {
      if (no_sign_idxes && no_sign_idxes.includes(i))
        continue
      if (ord_addr_idxes.includes(i))
        continue
      ins_to_sign.push(i)
    }
    signed = await signPSBT(hexToBase64(unsigned_psbt_hex), false, [
      {
        address: payment_addr,
        signingIndexes: ins_to_sign,
      },
      {
        address: ord_addr,
        signingIndexes: ord_addr_idxes,
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
