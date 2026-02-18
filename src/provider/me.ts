import type { SignResponse } from '../core/providers'
import type { BISWallet } from '../main'
import { Buffer } from 'node:buffer'
import { getNetwork } from '../core/bis'
import { createUnsecuredToken, hexToBase64 } from '../core/helpers'
import { getPaymentWallet } from '../core/providers'
import { bitcoinjs } from '../lib/bitcoin'

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

export async function getWallets(): Promise<BISWallet[]> {
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

export async function signMessage(message: string, address: string): Promise<string> {
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
export async function signMessageDeterministic(message: string): Promise<{ signature: string, address: string }> {
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

// returns txid
export async function sendBTC(amountSats: string, toAddress: string): Promise<string> {
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
        amountSats: Number.parseInt(amountSats),
      },
    ],
    senderAddress: paymentAddress,
  })

  const response = await window.magicEden.bitcoin.sendBtcTransaction(request)

  return response.txid
}

export async function signPSBT(
  psbtBase64: string,
  broadcast: boolean,
  inputsToSign: any[],
  message: string,
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

export async function sign(
  unsigned_psbt_hex: string,
  payment_addr: string,
  ord_addr: string,
  ord_addr_idxes: number[],
  _use_tweak_signer_idxes?: number[], // not used in Magic Eden
  no_sign_idxes?: number[],
): Promise<SignResponse> {
  const psbt = bitcoinjs.Psbt.fromHex(unsigned_psbt_hex)
  const ins_to_sign = []
  for (let i = 0; i < psbt.inputCount; i++) {
    if (no_sign_idxes && no_sign_idxes.includes(i))
      continue
    if (ord_addr_idxes.includes(i))
      continue
    ins_to_sign.push(i)
  }

  const signed = await signPSBT(hexToBase64(unsigned_psbt_hex), false, [
    {
      address: payment_addr,
      signingIndexes: ins_to_sign,
      sigHash: bitcoinjs.Transaction.SIGHASH_DEFAULT,
    },
    {
      address: ord_addr,
      signingIndexes: ord_addr_idxes,
      sigHash: bitcoinjs.Transaction.SIGHASH_DEFAULT,
    },
  ], 'sign this pls')

  const signed_psbt = bitcoinjs.Psbt.fromBase64(signed.psbtBase64)
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
