import type { BISProvider, SignFunction } from '../provider/api'
import type { BISSession, BISWallet, BISWalletProvider, BISWalletPurpose } from '../types/common'
import { verifySignature, verifySignatureLocal } from './helpers'
import { getWalletInfo, saveWalletInfo } from './store'

/**
 * Registry of wallet providers, populated per build via `registerProvider`. The
 * browser build registers the extension wallets; the server build registers only
 * the local wallet. Keeping this empty by default means the core no longer
 * statically imports every provider (so each flavour only bundles what it needs).
 */
export const PROVIDERS: Partial<Record<BISWalletProvider, BISProvider>> = {}

/**
 * Registers a wallet provider implementation under its key. Build entries call
 * this at startup to populate the registry for their environment.
 *
 * @param name The provider key (e.g. 'unisat', 'local').
 * @param provider The provider implementation.
 */
export function registerProvider(name: BISWalletProvider, provider: BISProvider) {
  PROVIDERS[name] = provider
}

function requireProvider(provider: BISWalletProvider | undefined): BISProvider {
  if (!provider || !PROVIDERS[provider]) {
    throw new Error('Provider not found')
  }
  return PROVIDERS[provider]!
}

/**
 * Gets the list of wallets from the specified provider. The function checks if the provider is supported and then calls the corresponding getWallets function from the provider module to retrieve the list of wallets. If the provider is not supported or if there is an error while fetching the wallets, it throws an error with an appropriate message.
 *
 * @param provider The wallet provider for which to fetch the wallets. This should be one of the registered providers.
 *
 * @returns A promise that resolves to a BISSession object containing the provider, the list of wallets, and a null signature. The function also saves the wallet information to local storage for later use.
 * @throws An error if the provider is not supported or if there is an error while fetching the wallets, with a message indicating the reason for the failure.
 */
export async function getWallets(provider: BISWalletProvider): Promise<BISSession> {
  // Get wallets
  const wallets = await PROVIDERS[provider]?.getWallets().catch((err: any) => {
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

function getWallet(walletType: BISWalletPurpose): BISWallet | undefined {
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

/**
 * Returns the currently connected ordinals wallet, or undefined if no ordinals wallet is connected. The function retrieves the wallet information from local storage and checks for a wallet with the purpose of 'ordinals'. If such a wallet is found, it is returned; otherwise, the function returns undefined.
 *
 * @returns The currently connected ordinals wallet, or undefined if no ordinals wallet is connected.
 */
export function getOrdinalsWallet(): BISWallet | undefined {
  return getWallet('ordinals')
}

/**
 * Returns the currently connected payment wallet, or undefined if no payment wallet is connected. The function retrieves the wallet information from local storage and checks for a wallet with the purpose of 'payment'. If such a wallet is found, it is returned; otherwise, the function returns undefined.
 *
 * @returns The currently connected payment wallet, or undefined if no payment wallet is connected.
 */
export function getPaymentWallet(): BISWallet | undefined {
  return getWallet('payment')
}

/**
 * Returns the sign function for the specified wallet provider from the registry.
 *
 * @param provider The wallet provider for which to get the sign function.
 * @returns The provider's sign function.
 * @throws An error if the provider is not registered.
 */
export function getSignFn(provider: BISWalletProvider): SignFunction {
  const impl = PROVIDERS[provider]
  if (!impl) {
    throw new Error('Unknown provider')
  }

  return impl.sign
}

/**
 * Signs a message using the currently connected wallet provider, then verifies it
 * against the backend. Returns the signature, or throws if signing or verification fails.
 *
 * @param message The message to sign.
 * @param walletType The wallet purpose to sign with ('payment' | 'ordinals' | 'all').
 * @returns The signature as a hex string.
 */
export async function signMessage(message: string, walletType: BISWalletPurpose): Promise<string> {
  const wallet = getWallet(walletType)
  if (!wallet) {
    console.error('Wallet not found.')
    throw new Error('Wallet not found.')
  }

  const provider = requireProvider(getWalletInfo()?.provider)
  const signature = await provider.signMessage(message, walletType, wallet.address)

  if (!verifySignature(message, signature, wallet.address)) {
    console.error('Signature verification failed.')
    throw new Error('Signature verification failed.')
  }

  return signature
}

/**
 * Signs a message using the currently connected wallet provider, then verifies it
 * locally (offline). Returns the signature, or throws if signing or verification fails.
 *
 * @param message The message to sign.
 * @param walletType The wallet purpose to sign with ('payment' | 'ordinals' | 'all').
 * @returns The signature as a hex string.
 */
export async function signMessageLocalVerify(
  message: string,
  walletType: BISWalletPurpose,
): Promise<string> {
  const wallet = getWallet(walletType)
  if (!wallet) {
    console.error('Wallet not found.')
    throw new Error('Wallet not found.')
  }

  const provider = requireProvider(getWalletInfo()?.provider)
  const signature = await provider.signMessage(message, walletType, wallet.address)

  if (!verifySignatureLocal(message, signature, wallet.address)) {
    console.error('Signature verification failed.')
    throw new Error('Signature verification failed.')
  }

  return signature
}

/**
 * Signs a message deterministically using the currently connected wallet provider,
 * then verifies it locally. Returns the signature, or throws on failure.
 *
 * @param message The message to sign.
 * @returns The signature as a hex string.
 */
export async function signMessageLocalVerifyDeterministic(message: string): Promise<string> {
  const provider = requireProvider(getWalletInfo()?.provider)
  const signatureRes = await provider.signMessageDeterministic(message)

  if (!signatureRes) {
    console.error('Signature result not found.')
    throw new Error('Signature result not found.')
  }

  if (!verifySignatureLocal(message, signatureRes.signature, signatureRes.address)) {
    console.error('Signature verification failed.')
    throw new Error('Signature verification failed.')
  }

  return signatureRes.signature
}

/**
 * Sends Bitcoin using the currently connected wallet provider.
 *
 * @param amountSats The amount to send, in satoshis.
 * @param toAddress The destination address.
 * @returns The transaction ID of the sent transaction.
 */
export async function sendBTC(amountSats: string, toAddress: string): Promise<string> {
  const provider = requireProvider(getWalletInfo()?.provider)
  const txid = await provider.sendBTC(amountSats, toAddress)

  if (!txid) {
    console.error('Send BTC result not found.')
    throw new Error('Send BTC error.')
  }

  return txid
}

/**
 * Signs a PSBT using the currently connected wallet provider.
 *
 * @param psbtBase64 The PSBT to sign, base64-encoded.
 * @param broadcast Whether to broadcast the signed transaction.
 * @param inputsToSign The inputs to sign.
 * @param message Optional message passed to providers that support it (ignored by others).
 */
export async function signPSBT(
  psbtBase64: string,
  broadcast: boolean,
  inputsToSign: any[],
  message: string,
) {
  const walletInfo = getWalletInfo()

  if (!walletInfo || !walletInfo.wallets)
    throw new Error('Wallets not found')

  const provider = requireProvider(walletInfo.provider)
  await provider.signPSBT(psbtBase64, broadcast, inputsToSign, message)
}
