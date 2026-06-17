import type { BISWallet, BISWalletPurpose } from '../types/common'
import type { BISProvider, SignResponse } from './api'
import { Buffer } from 'node:buffer'
import * as bitcoinjs from 'bitcoinjs-lib'
import { getNetwork } from '../core/bis'
import { createUnsecuredToken, finalizePsbtInputs, hexToBase64 } from '../core/helpers'
import { getPaymentWallet } from '../core/providers'

function getNetworkType() {
  const bisNetwork = getNetwork()

  if (bisNetwork === 'mainnet')
    return 'Mainnet'
  else if (bisNetwork === 'testnet')
    return 'Testnet4'
  else if (bisNetwork === 'signet')
    return 'Signet'

  throw new Error('Unknown BTC network type.')
}

async function getWallets(): Promise<BISWallet[]> {
  if (!window.magicEden)
    throw new Error('Magic Eden extension not found.')

  const request = createUnsecuredToken({
    purposes: ['ordinals', 'payment'],
  })

  const data = await window.magicEden.bitcoin.connect(request)

  if (!data)
    throw new Error('Error fetching wallet data.')

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
  _walletType: BISWalletPurpose, // not used in Magic Eden since it determines wallet type internally based on address
  address: string,
): Promise<string> {
  if (!window.magicEden)
    throw new Error('Magic Eden extension not found.')

  const request = createUnsecuredToken({
    network: {
      type: getNetworkType(),
    },
    address,
    message,
  })

  const response = await window.magicEden.bitcoin.signMessage(request)

  return Buffer.from(response, 'base64').toString('hex')
}

async function signMessageDeterministic(
  message: string,
): Promise<{ signature: string, address: string }> {
  if (!window.magicEden)
    throw new Error('Magic Eden extension not found.')

  const wallet = getPaymentWallet()
  if (!wallet)
    throw new Error('No payment wallet found.')
  const address = wallet.address

  const request = createUnsecuredToken({
    network: {
      type: getNetworkType(),
    },
    address,
    message,
    protocol: 'ECDSA',
  })

  const response = await window.magicEden.bitcoin.signMessage(request)

  return {
    signature: Buffer.from(response, 'base64').toString('hex'),
    address,
  }
}

async function sendBTC(amountSats: number, toAddress: string): Promise<string> {
  if (!window.magicEden)
    throw new Error('Magic Eden extension not found.')

  const wallet = getPaymentWallet()
  if (!wallet)
    throw new Error('No payment wallet found.')
  const paymentAddress = wallet.address

  const request = createUnsecuredToken({
    network: {
      type: getNetworkType(),
    },
    recipients: [
      {
        address: toAddress,
        amountSats,
      },
    ],
    senderAddress: paymentAddress,
  })

  const response = await window.magicEden.bitcoin.sendBtcTransaction(request)

  return response.txid
}

async function signPSBT(
  psbtBase64: string,
  broadcast: boolean,
  inputsToSign: any[],
  message?: string,
) {
  // debug

  const request = createUnsecuredToken({
    network: {
      type: getNetworkType(),
    },
    message: message || 'Sign Transaction',
    psbtBase64,
    broadcast,
    inputsToSign,
  })

  const response = await window.magicEden.bitcoin.signTransaction(request)

  return response
}

async function sign(
  unsignedPsbtHex: string,
  paymentAddr: string,
  ordAddr: string,
  ordAddrIdxes: number[],
  _useTweakSignerIdxes?: number[], // not used in Magic Eden
  noSignIdxes?: number[],
): Promise<SignResponse> {
  const psbt = bitcoinjs.Psbt.fromHex(unsignedPsbtHex)
  const insToSign = []
  for (let i = 0; i < psbt.inputCount; i++) {
    if (noSignIdxes && noSignIdxes.includes(i))
      continue
    if (ordAddrIdxes.includes(i))
      continue
    insToSign.push(i)
  }

  const signed = await signPSBT(
    hexToBase64(unsignedPsbtHex),
    false,
    [
      {
        address: paymentAddr,
        signingIndexes: insToSign,
        sigHash: bitcoinjs.Transaction.SIGHASH_DEFAULT,
      },
      {
        address: ordAddr,
        signingIndexes: ordAddrIdxes,
        sigHash: bitcoinjs.Transaction.SIGHASH_DEFAULT,
      },
    ],
    'sign this pls',
  )

  const signedPsbt = bitcoinjs.Psbt.fromBase64(signed.psbtBase64)
  finalizePsbtInputs(signedPsbt, noSignIdxes)

  const signedTx = signedPsbt.extractTransaction()
  const signedTxHex = signedTx.toHex()

  return {
    txId: signedTx.getId(),
    signedTxHex,
  }
}

export const ME: BISProvider = {
  getWallets,
  signMessage,
  signMessageDeterministic,
  sendBTC,
  signPSBT,
  sign,
}
