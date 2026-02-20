import type { SignResponse } from '../core/providers'
import type { BISWallet } from '../main'
import { Buffer } from 'node:buffer'
import { getNetwork } from '../core/bis'
import { base64ToHex, hexToBase64 } from '../core/helpers'
import { getPaymentWallet } from '../core/providers'
import { bitcoinjs } from '../lib/bitcoin'

// @ts-expect-error not in use
// eslint-disable-next-line unused-imports/no-unused-vars
function isInstalled() {
  return typeof window.unisat !== 'undefined'
}

/**
 *
 */
export async function checkNetwork() {
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

/**
 *
 */
export async function getWallets(): Promise<BISWallet[]> {
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

/**
 *
 * @param message
 */
export async function signMessage(message: string): Promise<string> {
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
/**
 *
 * @param message
 */
export async function signMessageDeterministic(
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

// returns txid
/**
 *
 * @param amountSats
 * @param toAddress
 */
export async function sendBTC(amountSats: string, toAddress: string): Promise<string> {
  // Check extension and network
  await checkNetwork()

  try {
    const response = await window.unisat!.sendBitcoin(toAddress, Number.parseInt(amountSats))

    return response
  }
  catch (e) {
    // Log
    console.error('Failed to sign message', e)

    throw new Error('Failed to sign message.')
  }
}

/**
 *
 * @param psbtBase64
 * @param broadcast
 * @param inputsToSign
 */
export async function signPSBT(psbtBase64: string, broadcast: boolean, inputsToSign: any[]) {
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

/**
 *
 * @param unsigned_psbt_hex
 * @param payment_addr
 * @param ord_addr
 * @param ord_addr_idxes
 * @param use_tweak_signer_idxes
 * @param no_sign_idxes
 */
export async function sign(
  unsigned_psbt_hex: string,
  payment_addr: string,
  ord_addr: string,
  ord_addr_idxes: number[],
  use_tweak_signer_idxes?: number[],
  no_sign_idxes?: number[],
): Promise<SignResponse> {
  let signed = null
  if (!payment_addr) {
    signed = await signPSBT(hexToBase64(unsigned_psbt_hex), false, [])
  }
  else {
    const psbt = bitcoinjs.Psbt.fromHex(unsigned_psbt_hex)
    const ins_to_sign = []
    const use_tweak_signer_payment = []
    const use_tweak_signer_ord = []
    for (let i = 0; i < psbt.inputCount; i++) {
      if (no_sign_idxes && no_sign_idxes.includes(i))
        continue
      if (ord_addr_idxes.includes(i)) {
        if (use_tweak_signer_idxes && use_tweak_signer_idxes.includes(i)) {
          use_tweak_signer_ord.push(true)
        }
        else if (use_tweak_signer_idxes) {
          use_tweak_signer_ord.push(false)
        }
        continue
      }
      ins_to_sign.push(i)
      if (use_tweak_signer_idxes && use_tweak_signer_idxes.includes(i)) {
        use_tweak_signer_payment.push(true)
      }
      else if (use_tweak_signer_idxes) {
        use_tweak_signer_payment.push(false)
      }
    }
    signed = await signPSBT(hexToBase64(unsigned_psbt_hex), false, [
      {
        address: payment_addr,
        signingIndexes: ins_to_sign,
        useTweakedSigner: use_tweak_signer_payment,
      },
      {
        address: ord_addr,
        signingIndexes: ord_addr_idxes,
        useTweakedSigner: use_tweak_signer_ord,
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
