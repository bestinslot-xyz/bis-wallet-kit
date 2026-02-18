import type { BISSession, BISWallet, BISWalletProvider } from '../main'
import * as leather from '../provider/leather'
import * as local from '../provider/local'
import * as me from '../provider/me'
import * as okx from '../provider/okx'
import * as orange from '../provider/orange'
import * as unisat from '../provider/unisat'
import * as xverse from '../provider/xverse'
import { verify_signature, verify_signature_local } from './helpers'
import { getWalletInfo, saveWalletInfo } from './store'

export interface SignResponse {
  txid: string
  signed_tx_hex: string
}

export const providers = {
  leather,
  me,
  okx,
  orange,
  unisat,
  xverse,
  local,
} as const

type ProviderKey = keyof typeof providers

// const allowedProviders = Object.keys(providers)

export async function getWallets(provider: BISWalletProvider): Promise<BISSession> {
  // Get wallets
  const wallets = await providers[provider as ProviderKey]?.getWallets().catch((err: any) => {
    console.error('Failed to get wallets.', err)

    throw new Error(err?.message || 'Failed to get wallets.')
  })

  if (!wallets)
    throw new Error('Failed to get wallets.')

  const resp: BISSession = {
    provider,
    wallets,
    signature: null,
  }

  // Save local storage
  saveWalletInfo(resp)

  return resp
}

function getWallet(walletType: 'payment' | 'ordinals' | 'all'): BISWallet | undefined {
  const walletInfo = getWalletInfo()

  if (!walletInfo) {
    console.error('Wallet not found.')

    return undefined
  }

  const wallets = walletInfo.wallets
  const provider = walletInfo.provider

  const singleWalletProviders = ['okx', 'unisat', 'local']

  if (singleWalletProviders.includes(provider)) {
    walletType = 'all'
  }

  const wallet = wallets.find(wallet => wallet.purpose === walletType)

  if (!wallet) {
    console.error(`${walletType} wallet not found. Provider: ${walletInfo.provider}`)

    return undefined
  }

  return wallet
}

export function getOrdinalsWallet(): BISWallet | undefined {
  return getWallet('ordinals')
}

export function getPaymentWallet(): BISWallet | undefined {
  return getWallet('payment')
}

export type SignFunction = (unsigned_psbt_hex: string, payment_addr: string, ord_addr: string, ord_addr_idxes: number[], use_tweak_signer_idxes?: number[], no_sign_idxes?: number[]) => Promise<SignResponse>
export function getSignFn(provider: BISWalletProvider): SignFunction {
  if (!providers[provider as ProviderKey]) {
    throw new Error('Unknown provider')
  }

  return providers[provider as ProviderKey].sign
}

export async function signMessage(message: string, walletType: 'payment' | 'ordinals'): Promise<string> {
  const provider = getWalletInfo()?.provider
  let signature: string | undefined

  const wallet = getWallet(walletType)

  if (!wallet) {
    console.error('Wallet not found.')
    throw new Error('Wallet not found.')
  }

  if (provider === 'unisat') {
    signature = await unisat.signMessage(message)
  }
  else if (provider === 'xverse') {
    signature = await xverse.signMessage(message, wallet.address)
  }
  else if (provider === 'leather') {
    signature = await leather.signMessage(message, walletType)
  }
  else if (provider === 'me') {
    signature = await me.signMessage(message, wallet.address)
  }
  else if (provider === 'okx') {
    signature = await okx.signMessage(message)
  }
  else if (provider === 'local') {
    signature = await local.signMessage(message)
  }
  else {
    throw new Error('Provider not found')
  }

  if (!verify_signature(message, signature, wallet.address)) {
    console.error('Signature verification failed.')
    throw new Error('Signature verification failed.')
  }

  return signature
}

export async function signMessageLocalVerify(message: string, walletType: 'payment' | 'ordinals'): Promise<string> {
  const provider = getWalletInfo()?.provider
  let signature: string | undefined

  const wallet = getWallet(walletType)

  if (!wallet) {
    console.error('Wallet not found.')
    throw new Error('Wallet not found.')
  }

  if (provider === 'unisat') {
    signature = await unisat.signMessage(message)
  }
  else if (provider === 'xverse') {
    signature = await xverse.signMessage(message, wallet.address)
  }
  else if (provider === 'leather') {
    signature = await leather.signMessage(message, walletType)
  }
  else if (provider === 'me') {
    signature = await me.signMessage(message, wallet.address)
  }
  else if (provider === 'okx') {
    signature = await okx.signMessage(message)
  }
  else if (provider === 'local') {
    signature = await local.signMessage(message)
  }
  else {
    throw new Error('Provider not found')
  }

  if (!verify_signature_local(message, signature, wallet.address)) {
    console.error('Signature verification failed.')
    throw new Error('Signature verification failed.')
  }

  return signature
}

export async function signMessageLocalVerifyDeterministic(message: string): Promise<string> {
  const provider = getWalletInfo()?.provider
  let signature_res: { signature: string, address: string } | undefined

  if (provider === 'unisat') {
    signature_res = await unisat.signMessageDeterministic(message)
  }
  else if (provider === 'xverse') {
    signature_res = await xverse.signMessageDeterministic(message)
  }
  else if (provider === 'leather') {
    signature_res = await leather.signMessageDeterministic(message)
  }
  else if (provider === 'me') {
    signature_res = await me.signMessageDeterministic(message)
  }
  else if (provider === 'okx') {
    signature_res = await okx.signMessageDeterministic(message)
  }
  else if (provider === 'local') {
    signature_res = await local.signMessageDeterministic(message)
  }
  else {
    throw new Error('Provider not found')
  }

  if (!signature_res) {
    console.error('Signature result not found.')
    throw new Error('Signature result not found.')
  }

  if (!verify_signature_local(message, signature_res.signature, signature_res.address)) {
    console.error('Signature verification failed.')
    throw new Error('Signature verification failed.')
  }

  return signature_res.signature
}

export async function sendBTC(amountSats: string, toAddress: string): Promise<string> {
  const provider = getWalletInfo()?.provider
  let txid: string | undefined

  if (provider === 'unisat') {
    txid = await unisat.sendBTC(amountSats, toAddress)
  }
  else if (provider === 'xverse') {
    txid = await xverse.sendBTC(amountSats, toAddress)
  }
  else if (provider === 'leather') {
    txid = await leather.sendBTC(amountSats, toAddress)
  }
  else if (provider === 'me') {
    txid = await me.sendBTC(amountSats, toAddress)
  }
  else if (provider === 'okx') {
    txid = await okx.sendBTC(amountSats, toAddress)
  }
  else if (provider === 'local') {
    txid = await local.sendBTC(amountSats, toAddress)
  }
  else {
    throw new Error('Provider not found')
  }

  if (!txid) {
    console.error('Send BTC result not found.')
    throw new Error('Send BTC error.')
  }

  return txid
}

export async function signPSBT(
  psbtBase64: string,
  broadcast: boolean,
  inputsToSign: any[],
  message: string,
) {
  const walletInfo = getWalletInfo()

  if (!walletInfo || !walletInfo.wallets)
    throw new Error('Wallets not found')

  if (walletInfo.provider === 'unisat') {
    await unisat.signPSBT(psbtBase64, broadcast, inputsToSign)
  }
  else if (walletInfo.provider === 'xverse') {
    await xverse.signPSBT(psbtBase64, broadcast, inputsToSign, message)
  }
  else if (walletInfo.provider === 'leather') {
    await leather.signPSBT(psbtBase64, broadcast, inputsToSign)
  }
  else if (walletInfo.provider === 'me') {
    await me.signPSBT(psbtBase64, broadcast, inputsToSign, message)
  }
  else if (walletInfo.provider === 'okx') {
    await okx.signPSBT(psbtBase64, broadcast, inputsToSign)
  }
  else if (walletInfo.provider === 'local') {
    await local.signPSBT(psbtBase64, broadcast, inputsToSign)
  }
  else {
    throw new Error('Provider not found')
  }
}
