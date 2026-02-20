import type { SignResponse } from '../core/providers'
import type { BISWallet } from '../main'
import { Buffer } from 'node:buffer'
import { getNetwork } from '../core/bis'
import { createUnsecuredToken, hexToBase64 } from '../core/helpers'
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

/**
 *
 */
export async function getWallets(): Promise<BISWallet[]> {
  if (!window.OrangeBitcoinProvider)
    throw new Error('Orange extension not found.')

  const request = createUnsecuredToken({
    purposes: ['ordinals', 'payment'],
    message: '[Best in Slot] wants to know your addresses!',
    network: {
      type: getNetworkType(),
    },
  })

  const data = await window.OrangeBitcoinProvider.connect(request)

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

/**
 *
 * @param message
 * @param address
 */
export async function signMessage(message: string, address: string): Promise<string> {
  if (!window.OrangeBitcoinProvider)
    throw new Error('Orange extension not found.')

  const request = createUnsecuredToken({
    address,
    message,
    network: {
      type: getNetworkType(),
    },
  })

  const response = await window.OrangeBitcoinProvider.signMessage(request).catch((e: any) => {
    console.error('Failed to sign message.', e)

    throw new Error('Failed to sign message.')
  })

  return Buffer.from(response, 'base64').toString('hex')
}

/**
 *
 * @param psbtBase64
 * @param broadcast
 * @param inputsToSign
 * @param message
 */
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

  const response = await window.OrangeBitcoinProvider?.signTransaction(request)

  return response
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
  _use_tweak_signer_idxes?: number[], // not used in Orange
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

  const signed = await signPSBT(
    hexToBase64(unsigned_psbt_hex),
    false,
    [
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
    ],
    'sign this pls',
  )

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
