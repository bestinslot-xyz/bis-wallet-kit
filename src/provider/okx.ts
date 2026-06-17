import type { BISWallet } from '../types/common'
import type { BISProvider, SignResponse } from './api'
import { Buffer } from 'node:buffer'
import * as bitcoinjs from 'bitcoinjs-lib'
import { getNetwork } from '../core/bis'
import { base64ToHex, finalizePsbtInputs, hexToBase64 } from '../core/helpers'
import { getPaymentWallet } from '../core/providers'

async function getWallets(): Promise<BISWallet[]> {
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

async function signMessage(message: string): Promise<string> {
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

async function signMessageDeterministic(
  message: string,
): Promise<{ signature: string, address: string }> {
  if (!window.okxwallet)
    throw new Error('OKX extension not found.')

  const wallet = getPaymentWallet()
  if (!wallet)
    throw new Error('No payment wallet found.')
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

async function sendBTC(amountSats: string, toAddress: string): Promise<string> {
  if (!window.okxwallet)
    throw new Error('OKX extension not found.')

  const network = getNetwork()
  let txId

  if (network === 'mainnet') {
    txId = await window.okxwallet.bitcoin.sendBitcoin(toAddress, Number.parseInt(amountSats))
  }
  else if (network === 'testnet') {
    txId = await window.okxwallet.bitcoinTestnet.sendBitcoin(toAddress, Number.parseInt(amountSats))
  }
  else if (network === 'signet') {
    txId = await window.okxwallet.bitcoinSignet.sendBitcoin(toAddress, Number.parseInt(amountSats))
  }
  else {
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
    }
    else {
      signedPsbtHex = await window.okxwallet.bitcoin.signPsbt(psbt)
    }
    if (broadcast) {
      await window.okxwallet.bitcoin.pushPsbt(signedPsbtHex)
    }
    return signedPsbtHex
  }
  else if (getNetwork() === 'testnet') {
    if (broadcast) {
      throw new Error('Cannot broadcast on testnet with okx')
    }
    let signedPsbtHex = null
    if (options) {
      signedPsbtHex = await window.okxwallet.bitcoinTestnet.signPsbt(psbt, options)
    }
    else {
      signedPsbtHex = await window.okxwallet.bitcoinTestnet.signPsbt(psbt)
    }
    return signedPsbtHex
  }
  else if (getNetwork() === 'signet') {
    if (broadcast) {
      throw new Error('Cannot broadcast on signet with okx')
    }
    let signedPsbtHex = null
    if (options) {
      signedPsbtHex = await window.okxwallet.bitcoinSignet.signPsbt(psbt, options)
    }
    else {
      signedPsbtHex = await window.okxwallet.bitcoinSignet.signPsbt(psbt)
    }
    return signedPsbtHex
  }
  else {
    throw new Error('Unsupported network for OKX.')
  }
}

async function sign(
  unsignedPsbtHex: string,
  paymentAddr: string,
  ordAddr: string,
  ordAddrIdxes: number[],
  _useTweakSignerIdxes?: number[], // not used in OKX
  noSignIdxes?: number[],
): Promise<SignResponse> {
  let signed = null
  if (!paymentAddr) {
    signed = await signPSBT(hexToBase64(unsignedPsbtHex), false, [])
  }
  else {
    const psbt = bitcoinjs.Psbt.fromHex(unsignedPsbtHex)
    const insToSign = []
    for (let i = 0; i < psbt.inputCount; i++) {
      if (noSignIdxes && noSignIdxes.includes(i))
        continue
      if (ordAddrIdxes.includes(i))
        continue
      insToSign.push(i)
    }
    signed = await signPSBT(hexToBase64(unsignedPsbtHex), false, [
      {
        address: paymentAddr,
        signingIndexes: insToSign,
      },
      {
        address: ordAddr,
        signingIndexes: ordAddrIdxes,
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

export const OKX: BISProvider = {
  getWallets,
  signMessage,
  signMessageDeterministic,
  sendBTC,
  signPSBT,
  sign,
}
